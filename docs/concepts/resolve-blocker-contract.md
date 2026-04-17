# Resolve-Blocker API + UI Contract

Companion to `docs/concepts/epic-orchestrator-architecture.md` §7 (Blocker Taxonomy) and §10 (UI Signals). Full contract for the human-in-the-loop surface that resolves stories in `BLOCKED` state.

> **Goal:** when an orchestrator escalates a blocker (ambiguous AC, missing dependency, architectural conflict), the operator has a single, well-defined endpoint to amend, skip, or retry the story. The UI makes the blocker queue visible at a glance and drives the operator through resolution in under 60 seconds for common cases.

---

## 1. Trigger context

Blockers reach the operator via two paths:

1. **Orchestrator escalation** — per §7 of the architecture doc, a hard blocker with code `ambiguous-ac`, `missing-dependency`, or `architectural-conflict` is always escalated. `story_blocked` event emitted with `humanActionRequired: true`.
2. **Auto-recovery exhaustion** — auto-recoverable codes (`insufficient-touch-points`, `context-gap`, `environment`) escalate after their 1-retry cap.

Both paths result in the same state: `EpicStory.status = 'blocked'` with a populated `blocker` record.

---

## 2. Story model additions

Extend `functions/shared/types/epic-workflow.ts`:

```ts
export type StoryStatus =
  | 'pending'
  | 'running'
  | 'in_review'
  | 'fixing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked'; // NEW

export type BlockerCode =
  | 'ambiguous-ac'
  | 'insufficient-touch-points'
  | 'missing-dependency'
  | 'architectural-conflict'
  | 'context-gap'
  | 'environment';

export interface BlockerRecord {
  code: BlockerCode;
  severity: 'hard' | 'soft';
  description: string; // dev subagent's explanation
  affectedPath?: string; // file or module the dev flagged
  suggestedResolution: string; // dev's suggested next step
  requestedTouchPointExpansion?: string[]; // from dev-* subagent output
  attemptsBeforeBlock: number; // how many auto-recovery tries preceded
  reportedAt: string; // ISO
  reportedByAttempt: number; // which dev attempt reported it
  waveNumber: number;
  subagentId?: string; // dev subagent that flagged it
}

export interface BlockerResolutionRecord {
  resolvedAt: string; // ISO
  resolvedBy: string; // userId
  action: 'amend' | 'skip' | 'retry';
  reason: string; // free-text operator note
  amendedFields?: Array<keyof EpicStory>; // which fields changed (for audit)
}

export interface EpicStory {
  // existing fields …
  storyId: string;
  order: number;
  title: string;
  description: string;
  status: StoryStatus;
  jobId?: string;
  dependsOn?: string[];
  wave?: number;
  criteria?: AcceptanceCriterion[];

  // from touch-point inference (see touch-point-inference-design.md)
  touchPoints?: string[];
  complexity?: StoryComplexity;
  reviewRigor?: ReviewRigor;

  // NEW — blocker state
  blocker?: BlockerRecord; // present when status == 'blocked'
  resolutionHistory?: BlockerResolutionRecord[]; // append-only audit trail
}
```

No breaking changes — all additions are optional.

---

## 3. Endpoint contract

### 3.1 Route

```
POST /api/epic-workflows/:epicId/stories/:storyId/resolve-blocker
```

Follows the existing route pattern (`:epicId/stories/:storyId/...`) and the Hono.js single-file layout in `functions/api/index.ts`.

### 3.2 Auth

Standard `authMiddleware` (Bearer JWT). The authenticated `user.userId` is recorded on the resolution record.

### 3.3 Request body — Zod schema

New schema in `functions/shared/schemas/resolve-blocker-schema.ts`:

```ts
import { z } from 'zod';

const complexityEnum = z.enum(['trivial', 'standard', 'complex', 'architectural']);
const reviewRigorEnum = z.enum(['light', 'standard', 'strict']);

const acceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  needsBrowser: z.boolean(),
});

const amendFieldsSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    criteria: z.array(acceptanceCriterionSchema).min(1).optional(),
    touchPoints: z.array(z.string().min(1)).min(1).optional(),
    complexity: complexityEnum.optional(),
    reviewRigor: reviewRigorEnum.optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be amended',
  });

export const resolveBlockerSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('amend'),
    amendedStory: amendFieldsSchema,
    reason: z.string().min(1).max(1000),
  }),
  z.object({
    action: z.literal('skip'),
    reason: z.string().min(1).max(1000),
  }),
  z.object({
    action: z.literal('retry'),
    reason: z.string().min(1).max(1000),
    resumeImmediately: z.boolean().default(true),
  }),
]);
```

Three actions:

| Action  | Purpose                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amend` | Operator edits story fields (AC, touch points, complexity, etc.) and wants dev to try again with the new spec.                                     |
| `skip`  | Operator decides this story is not going to land in this epic. Mark skipped, continue epic without it.                                             |
| `retry` | Operator fixed something external (dependency installed, env var set, broken downstream unblocked) and wants a fresh run with the same story spec. |

### 3.4 Response

**200 OK**

```json
{
  "ok": true,
  "storyId": "STORY-7",
  "newStatus": "pending" | "skipped",
  "resumeJobId": "epic-dev-job-<uuid>" | null,
  "resolvedAt": "2026-04-17T14:22:11.331Z"
}
```

- `resumeJobId` is set when the action triggers a new epic-dev job (amend and retry both trigger). `null` for skip.
- `newStatus: 'pending'` means the story is requeued for the next orchestrator pass; `'skipped'` means excluded.

### 3.5 Error responses

All use the existing `AppError` / `ValidationError` envelope from `functions/shared/errors.ts`.

| Status | When                                                                               |
| ------ | ---------------------------------------------------------------------------------- |
| `400`  | Zod validation failed (missing fields, empty reason, invalid action)               |
| `404`  | Epic or story not found                                                            |
| `409`  | Story is not in `blocked` state (e.g., already resolved, or never blocked)         |
| `409`  | Epic is in a terminal state (`deployed`, `completed`) — can't amend a shipped epic |
| `429`  | Rate limit: max 1 resolution per story per 5 seconds (prevent double-click)        |

### 3.6 Idempotency

Operator could double-submit. Handle via:

- **Optimistic lock on `blocker.reportedAt`** — request body includes `expectedBlockerReportedAt` as a safety check. If the blocker has been overwritten by a newer one (e.g., dev retried and blocked again on a different code), the request fails with `409: blocker-changed`. UI re-fetches.
- Add this as an optional 4th field on every action variant of the Zod schema.

Updated schema (addition):

```ts
const commonFields = {
  expectedBlockerReportedAt: z.string().optional(), // ISO, optimistic lock
};
// merged into each discriminated-union variant
```

### 3.7 Side effects — per action

#### `amend`

1. Validate: `epic.status` is not terminal; `story.status === 'blocked'`; `expectedBlockerReportedAt` matches (if provided).
2. Merge `amendedStory` into the story record:
   ```ts
   const updatedStory = {
     ...story,
     ...amendedStory,
     status: 'pending' as const,
     blocker: undefined,
     resolutionHistory: [
       ...(story.resolutionHistory ?? []),
       {
         resolvedAt: now,
         resolvedBy: user.userId,
         action: 'amend',
         reason,
         amendedFields: Object.keys(amendedStory),
       },
     ],
   };
   ```
3. Persist via `epicRepo.updateEpicFields(epicId, { stories: [...updatedStories] })`.
4. **If touch points were amended**, clear the epic's cached codebase index for next run — re-inference is NOT triggered automatically; the orchestrator's wave-check will catch any new conflicts.
5. Enqueue a new epic-dev job with `resumeFromWaveResults` populated from the prior job's checkpoints so already-APPROVED stories skip.
6. Emit `blocker_resolved` event with `action: 'amend'`.
7. Return 200 with `resumeJobId`.

#### `skip`

1. Validate same as above.
2. Update story:
   ```ts
   const updatedStory = {
     ...story,
     status: 'skipped' as const,
     blocker: undefined,
     resolutionHistory: [...(story.resolutionHistory ?? []), record],
   };
   ```
3. Persist.
4. **Do NOT enqueue a resume job.** The existing in-flight epic-dev job (if still running) already handled this story and moved past it; skipped is terminal.
5. If the epic is in `in_progress` and this was the last blocker, transition epic status per existing logic.
6. Emit `blocker_resolved` event with `action: 'skip'`.
7. Return 200 with `resumeJobId: null`.

#### `retry`

1. Validate same.
2. Update story:
   ```ts
   const updatedStory = {
     ...story,
     status: 'pending' as const,
     blocker: undefined,
     resolutionHistory: [...(story.resolutionHistory ?? []), record],
   };
   ```
3. Persist.
4. Enqueue resume job identical to `amend` path but without field changes. `resumeImmediately: false` returns the updated story without creating a new job — operator will trigger manually.
5. Emit `blocker_resolved` event with `action: 'retry'`.
6. Return 200 with `resumeJobId` (or `null` if `resumeImmediately: false`).

### 3.8 Resume job enqueue (amend / retry)

Shared helper:

```ts
async function enqueueResumeJob(opts: {
  epicId: string;
  userId: string;
  priorJobId: string | undefined;
}): Promise<string> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const epic = await epicRepo.getEpicById(opts.epicId);

  // Read wave checkpoints from the last orchestrator run
  const priorWaveResults = opts.priorJobId
    ? await agentJobsRepo.getJobById(opts.priorJobId).then((j) => j?.waveResults ?? {})
    : {};

  await agentJobsRepo.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: opts.userId,
    workingDir: epic.workingDir,
    pipeline: buildEpicDevPipeline({
      epic,
      resumeFromWaveResults: priorWaveResults,
    }),
  });

  return jobId;
}
```

`buildEpicDevPipeline` is the Phase 4 pipeline factory — not yet implemented; this contract documents the call shape.

---

## 4. Event emissions

Via the observability spine (`emit-event.sh` or direct DDB write — this is a daemon-adjacent API route, has direct access):

```json
{
  "jobId": "<prior-or-resume-job-id>",
  "epicId": "EPIC-42",
  "waveNumber": <story.wave>,
  "storyId": "STORY-7",
  "role": "orchestrator",
  "eventType": "blocker_resolved",
  "payload": {
    "action": "amend" | "skip" | "retry",
    "resolvedBy": "<userId>",
    "reason": "…",
    "amendedFields": ["touchPoints", "criteria"],
    "resumeJobId": "…"
  },
  "ts": <ms>
}
```

This event is consumed by the Event Log UI (§5.2) and the Agentic Office (whiteboard animation — blocker card lifted off).

---

## 5. UI surface

### 5.1 Story card — blocked state

Current story card (`src/components/labs/agentic-workflow/story-card.tsx`) uses status dot + badge. Extending status vocabulary with `'blocked'`:

```tsx
// getStatusDot
case 'blocked':
  return 'bg-amber-500 animate-pulse';

// getStatusBadgeClasses
case 'blocked':
  return 'border-amber-500/40 bg-amber-500/10 text-amber-400';

// getStatusLabel
case 'blocked':
  return `🚧 BLOCKED — ${shortenBlockerCode(story.blocker?.code)}`;
```

Blocked cards render an extra action row below the title:

```
┌──────────────────────────────────────────────────────┐
│ ● STORY-7 — Add cost chart filter   🚧 BLOCKED       │
│   wave 1 · standard                                   │
│                                                        │
│   🚧 Ambiguous AC (attempt 1)                         │
│   "AC says costs aggregated daily but no timezone    │
│    specified."                                        │
│   Suggested: Specify UTC or user-local in AC.         │
│                                                        │
│   [Resolve Blocker ▸]                                 │
└──────────────────────────────────────────────────────┘
```

Clicking `[Resolve Blocker ▸]` opens the drawer (§5.3).

### 5.2 Event Log — blocker treatment

Per architecture doc §10.1. Amber 🚧 entries with expanded body. Already defined there; no change.

### 5.3 Resolve Blocker drawer

New component: `src/components/labs/agentic-workflow/resolve-blocker-drawer.tsx`.

**Drawer (right-side, ~540px wide):**

```
╔══════════════════════════════════════════════════════╗
║  Resolve Blocker — STORY-7                      [×]  ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Current blocker                                     ║
║  ──────────────────────────────────────────────────  ║
║  Code:        ambiguous-ac                           ║
║  Severity:    hard                                   ║
║  Attempts:    1 (of 2 max)                           ║
║  Reported:    2m ago, by dev subagent                ║
║                                                      ║
║  Description                                         ║
║  "AC says costs aggregated daily but no timezone     ║
║   specified. Cannot determine aggregation boundary   ║
║   without ambiguity."                                ║
║                                                      ║
║  Suggested resolution                                ║
║  "Specify UTC or user-local in AC."                  ║
║                                                      ║
║  ──────────────────────────────────────────────────  ║
║  Action                                              ║
║  ○ Amend story                                       ║
║  ● Skip this story                                   ║
║  ○ Retry without changes                             ║
║                                                      ║
║  [Action-specific fields render here — see §5.4]    ║
║                                                      ║
║  Reason (required) *                                 ║
║  ┌────────────────────────────────────────────────┐  ║
║  │                                                 │  ║
║  │                                                 │  ║
║  └────────────────────────────────────────────────┘  ║
║  Audit trail — describe what you're doing and why.   ║
║                                                      ║
║  ──────────────────────────────────────────────────  ║
║                              [Cancel]  [Apply ▸]    ║
╚══════════════════════════════════════════════════════╝
```

**Amend sub-form (radio = Amend):**

```
  Amend fields — change only what you need
  ──────────────────────────────────────────
  ☑ Acceptance criteria
    ┌──────────────────────────────────────┐
    │ AC-1: Costs aggregated daily in UTC. │
    │ AC-2: …                              │
    └──────────────────────────────────────┘
    [+ Add criterion]

  ☐ Touch points
    current: src/hooks/use-costs.ts, src/…
    [Edit]

  ☐ Complexity     [ standard ▾ ]
  ☐ Review rigor   [ standard ▾ ]
```

**Skip sub-form (radio = Skip):**

```
  Skipping means this story will not land in this
  epic. You can add it to a future epic later.
  No rebuild will be queued.
```

**Retry sub-form (radio = Retry):**

```
  Retry re-runs the story with the current spec.
  Use this after fixing something external.

  ☑ Resume immediately
  (uncheck to review first, then trigger manually)
```

### 5.4 Hook + store integration

**New hook:** `src/hooks/use-resolve-blocker.ts`

```ts
export function useResolveBlocker(epicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (args: { storyId: string; body: z.infer<typeof resolveBlockerSchema> }) => {
      const res = await apiClient.post(
        `/api/epic-workflows/${epicId}/stories/${args.storyId}/resolve-blocker`,
        args.body,
      );
      return res.data as ResolveBlockerResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] });
      queryClient.invalidateQueries({ queryKey: ['agent-jobs'] });
    },
  });
}
```

No new Zustand store — mutation + TanStack invalidation matches existing patterns in `use-agent-job.ts`, `use-projects.ts`.

### 5.5 Epic header badge

In the Labs epic detail view, show a count badge when blockers exist:

```
EPIC-42 — Cost charts redesign
in_progress · 8/10 done · 🚧 2 blocked   [View blockers]
```

`[View blockers]` filters the story list to blocked-only.

### 5.6 Agentic Office wiring

No new components here — the existing Office already watches events. When `blocker_resolved` arrives:

- Whiteboard card for the story animates off (per arch doc §10.3).
- Story desk re-activates on next `subagent_dispatch` (from the resume job).

The UI is driven entirely by the event stream; no separate WebSocket for blocker state.

---

## 6. Accessibility & UX details

- Drawer is dismissible by Escape, click-outside, and close button.
- Action radios are keyboard-navigable (arrow keys).
- Reason field is required — submit button disabled when empty.
- On `409 blocker-changed` response, drawer surfaces a banner: _"This blocker has been updated. [Reload]"_ — clicking reloads the story.
- Loading state during submit disables the form; spinner on the Apply button.
- Error toast for non-409 failures.

---

## 7. Event flow end-to-end

```
Dev subagent returns with blocker
   → orchestrator classifies (architecture doc §7)
     → hard + non-recoverable → emit story_blocked
       → DDB event lands
         → UI Event Log shows amber entry
         → UI story card flips to BLOCKED status
         → Agentic Office: dev walks to whiteboard, drops card

Operator sees amber card, clicks Resolve Blocker
   → drawer opens with blocker details
   → operator picks action, fills reason, submits
     → POST /api/epic-workflows/:id/stories/:storyId/resolve-blocker
       → validation + side effects + event emission
         → blocker_resolved event lands
           → UI Event Log shows green ✓ entry
           → Story card flips to pending (amend/retry) or skipped
           → Agentic Office: card lifts off whiteboard
     → if amend/retry: resume job spawns
       → orchestrator picks up next wave with this story re-included
```

---

## 8. Failure modes

| Failure                                                              | Behavior                                                                                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Epic no longer exists                                                | 404. Drawer closes with error toast.                                                                                                                                                   |
| Story state changed (e.g., operator in another tab just resolved it) | 409 `blocker-changed`. Drawer shows reload banner.                                                                                                                                     |
| Resume job creation failed                                           | 500. Blocker cleared in DB but `resumeJobId: null` returned — operator must manually trigger next run. Flag this in the response: `{ ok: true, warnings: ['resume-enqueue-failed'] }`. |
| User is read-only                                                    | Existing auth middleware handles this pre-route.                                                                                                                                       |
| Amended story has invalid touchPoints (glob syntax error)            | 400 with field-level Zod message.                                                                                                                                                      |
| Reason empty / too long                                              | 400 with Zod message.                                                                                                                                                                  |

---

## 9. Test surface

**Unit (Vitest):**

- `resolveBlockerSchema` — discriminated union behavior, empty amendedStory rejected, overly long reason rejected.
- `enqueueResumeJob` — `resumeFromWaveResults` correctly carried from prior job.
- State transition logic — amend → pending, skip → skipped, retry → pending.

**API integration (Vitest + mocked DDB):**

- POST amend happy path → story updated + new job created + event emitted.
- POST skip → story skipped + no job.
- POST retry with `resumeImmediately: false` → story pending + no job.
- 409 when story not blocked.
- 409 when `expectedBlockerReportedAt` mismatches.
- 409 when epic is terminal.

**E2E (Playwright smoke):**

- Seed a blocked story in sessionStorage; click Resolve Blocker; select Skip; fill reason; submit; assert card transitions to skipped.
- Seed same; select Amend; edit AC; submit; assert pending + new job in mocked API.

---

## 10. Implementation sequence

Lands in Phase 6 of the architecture doc (UI integration), after the orchestrator can produce blockers:

1. Extend `StoryStatus` union; add `BlockerRecord` and `BlockerResolutionRecord` types.
2. Extend `EpicStory` interface.
3. Add Zod schema `resolveBlockerSchema` to `functions/shared/schemas/`.
4. Add route handler in `functions/api/index.ts` near the existing story run route (~L1845).
5. Add shared `enqueueResumeJob` helper (may be reused by Phase 4).
6. Extend story card in `src/components/labs/agentic-workflow/story-card.tsx`.
7. Build `resolve-blocker-drawer.tsx`.
8. Build `use-resolve-blocker.ts` hook.
9. Epic header badge in the Labs epic detail view.
10. Unit + API integration tests.
11. Playwright smoke.

---

## 11. Open items

1. **Blocker aggregation across multiple retries.** If the same story blocks twice on different codes, current design overwrites `story.blocker`. Do we keep a history of blocker records? Proposed: yes — add `blockerHistory: BlockerRecord[]` alongside `resolutionHistory`. Low priority for v1.
2. **Notifications.** When an epic blocks overnight, operator wants to know. Email/Slack? Out of scope for v1; add a "blocker notifications" setting later.
3. **Bulk resolution.** An epic with 5 similar blockers (e.g., all ambiguous-ac from the same PRD) could benefit from bulk skip. Defer to when the pattern appears in practice.
4. **Resume vs restart.** `retry` currently triggers a resume job. Should there be an option to restart the story from scratch (discarding prior diff)? Rare enough to defer.
5. **Audit export.** `resolutionHistory` is useful for retrospectives. Exportable as CSV from an epic detail endpoint — follow-up.
