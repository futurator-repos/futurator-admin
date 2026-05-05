# Pipeline Enhancement v2 — Phases A–D Implementation Handoff

**Audience:** another agent working on an adjacent feature in Futurator-Admin.
**Scope:** read this before touching the daemon, the wave/plan reducers, the
story-pipeline builder, or the plan-dashboard UI. Follows
`docs/concepts/pipeline-enhancement-plan-v2.md`.

**All four phases shipped + deployed** (2026-04-22 → 2026-04-23).
A = resilience foundations. B = attention inbox. C = rigor + TEST agent +
Logs tab. D = polish (budget banner, epic attention dot, retry pill).
A post-phase runtime-controls split (Daemon + Claude Code panels + Restart
button) is also in scope at the bottom.

---

## Phase A — Resilience Foundations (SHIPPED)

### A.1 Graceful daemon shutdown (30s SIGTERM window)

`daemon/agent-daemon.mjs` — `shutdown()` rewrite:

- Sets `shuttingDown = true`, stops forwarder + receiver.
- SIGTERM every tracked child via `child-tracker.mjs`.
- Waits `GRACEFUL_SHUTDOWN_MS` (default 30s, env override).
- SIGKILLs stragglers, marks their jobs FAILED with
  `errorMessage="Daemon <signal> — step did not exit within Nms graceful window"`,
  emits one `daemon-shutdown-timeout` attention item per survivor.

**New module:** `daemon/pipelines/lib/child-tracker.mjs`

- `registerChild(jobId, proc)` / `unregisterChild(jobId, proc)`
- `signalAllChildren(signal)` / `waitForAllChildrenToExit(ms)` / `killAllChildren()`
- Every spawn site in the daemon MUST register + unregister. Currently wired:
  - `agent-daemon.mjs:runAgent` (Claude spawn)
  - `agent-daemon.mjs:executeShellStep` (bash)
  - `epic-dev-pipeline.mjs` (orchestrator Claude)
  - `party-turn.mjs` (party mode Claude)

**If you add a new spawn site:** import from `child-tracker.mjs` and call
`registerChild` immediately after `spawn()` and `unregisterChild` in both
`on('close')` and `on('error')` handlers. Forgetting this orphans the child
on daemon restart.

### A.2 Generic shell path guard

`daemon/pipelines/lib/shell-guard.mjs` — refuses spawns that escape allowed
roots. Two layers:

1. **cwd guard** — cwd must resolve under `DEFAULT_ALLOWED_ROOTS`
   (`/home/ubuntu/projects`, `/tmp`, `$HOME`, `os.tmpdir()`, plus macOS
   equivalents).
2. **traversal-tool guard** — for `grep|find|rg|fd|ls|tar|zip|du|rsync`,
   positional absolute-path args must also land under allowed roots. For
   `bash -c "<script>"`, the script is scanned for these tool+absolute-path
   patterns.

**Contract:** call `assertSpawnAllowed(command, args, cwd)` BEFORE `spawn()`.
Throws `ShellGuardViolation` (non-retriable — Phase A.3 catches this and does
not retry).

**Env overrides:**

- `SHELL_GUARD_EXTRA_ROOTS` — comma-separated additional roots (for tests or
  ops exceptions).

**Violation → attention item** via `handleGuardViolation(jobId, details)` in
`agent-daemon.mjs` (resolves planId from epicId and writes `policy-violation`,
severity=high).

### A.3 Retry ladder

In-daemon per-job exponential backoff, `30s → 2m → 8m`, max 3 retries.

Implementation lives in `agent-daemon.mjs` — `handleJobFailure(job, err)`:

- Non-retriable if `err.name === 'ShellGuardViolation'` OR message matches
  `/OAuth expired|authentication expired|Not logged in|Please run \/login/i`.
- Retry path: sets `job.status = PENDING`, `job.retryAttempt`, `job.retryAfter`
  (ISO timestamp of now + delay). Poll loop filters via
  `FilterExpression: attribute_not_exists(retryAfter) OR retryAfter <= :now`.
- Exhaustion: marks FAILED + emits `retry-exhausted` attention item
  (severity=high).

**Job schema additions** (in `futurator-agent-jobs` table — no schema
migration needed, dynamic attributes):

- `retryAttempt: number` (0 for original run)
- `retryAfter: string` (ISO, optional)

**Constants** (edit in `agent-daemon.mjs` if tuning):

```js
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000]; // 30s → 2m → 8m
const MAX_RETRIES = RETRY_DELAYS_MS.length;
```

### A.4 AttentionItems DDB table + repository

**New SST table:** `futurator-attention-items` declared in `sst.config.ts`
alongside the other tables. PK `planId`, SK `itemId`. Linked to API Lambda
and WaveCompletionCheck Lambda with `ATTENTION_ITEMS_TABLE` env.

**IAM note for ops:** the EC2 daemon writes this table directly (Phase A.5).
The EC2 role `develope-it-ec2-ssm` needs `dynamodb:PutItem`,`GetItem`,
`UpdateItem` on `arn:aws:dynamodb:us-east-1:*:table/futurator-attention-items`
added out-of-band (not managed by SST).

**Types:** `functions/shared/types/attention.ts`

- `AttentionItem` with `severity` ∈ {low, medium, high, critical}
- `category` ∈ {policy-violation | retry-exhausted | daemon-shutdown-timeout
  | tamper-reverted | budget-warning | test-gate-failed | dev-server-down
  | other}
- `status` ∈ {open, resolving, resolved}
- `context: { epicId?, storyId?, jobId?, stepId? }`
- `suggestedActions: [{ label, kind }]`

**Repository:** `functions/shared/repositories/attention-items-repository.ts`

- `listAttentionItems(planId)` / `getAttentionItem(planId, itemId)`
- `createAttentionItem(item)` / `updateAttentionStatus(planId, itemId, status)`
- Added to `TABLE_NAMES.attentionItems` in `dynamo-client.ts`.

### A.5 Daemon attention writer

`daemon/pipelines/lib/attention-writer.mjs`:

- `writeAttentionItem(ddb, item, log)` — fire-and-forget Put to the attention
  table. Errors are logged but never thrown.
- `resolvePlanIdFromEpicId(ddb, epicId)` — cached lookup (daemon only has
  `job.epicId`, not planId).

Called inline by:

- Shutdown-timeout handler (A.1)
- Guard-violation handler (A.2)
- Retry-exhausted handler (A.3)

### A.6 API endpoints + hook + counter badge

`functions/api/index.ts` (added after the plan DELETE route):

- `GET /api/plans/:id/attention-items?status=<filter>` — sorted by severity
  desc, then createdAt desc. Returns `{ items, unresolvedCount, total }`.
- `POST /api/plans/:id/attention-items/:itemId/resolve` — flips to `resolved`.
- `POST /api/plans/:id/attention-items/:itemId/reopen` — flips back to `open`.

`src/hooks/use-attention-items.ts`:

- `useAttentionItems(planId, statusFilter?)` — 10s refetch interval, returns
  **deduped** items (see B.5).
- `useResolveAttentionItem(planId)` / `useReopenAttentionItem(planId)`.

`src/components/labs/plan-dashboard/project-hero.tsx`:

- `<AttentionBell count={unresolvedCount} onClick={...} />` in the hero
  metrics row. Bell is disabled when count=0.

---

## Phase B — Attention Inbox Dock (SHIPPED)

### B.1–B.3 Right-side dock + chips + optimistic resolve

`src/components/labs/plan-dashboard/attention-dock.tsx` — single component
containing:

- 420px fixed-right panel, backdrop with Esc/click-outside close,
  `transform: translateX` for slide animation, `zIndex: 71`.
- Filter chips row: `All / Critical / High / Medium / Low / Resolved`. Active
  chip highlighted. Pure client-side filter over fetched items.
- Item cards with left severity color-bar, title, relative time
  (`formatRelative()`), body, and action buttons.
- **Optimistic resolve:** local `resolving: Set<string>` tracks in-flight
  resolves. Card shows opacity=0.55 + "Resolving…" button text
  immediately, then server confirms via the mutation.

Wired into `project-hero.tsx` via local `dockOpen` state.

### B.4 Reducer path

`functions/shared/services/wave-reducer.ts`:

- `WaveReducerDeps` gained optional `writeAttentionItem` + `uuid`.
- On `wave-failed`: one item per failed story (severity=high,
  category=test-gate-failed).
- On `wave-build-check-failed`: one item (severity=high, same category).
- Writes are wrapped in `.catch(() => {})` — attention writes never break
  the reducer.

`functions/cron/wave-completion-check.ts` wires
`attentionRepo.createAttentionItem` into `waveDeps`.

### B.5 Client-side dedupe + scroll-to-story

`dedupeAttentionItems(items)` in `use-attention-items.ts`:

- Keys: `title::storyId` within a 60s `createdAt` window collapse.
- Keeps earliest, annotates `duplicateCount`.
- Returned shape: `DedupedAttentionItem extends AttentionItem { duplicateCount }`.

Card shows `+N` badge when `duplicateCount > 0`.

**"Open story" action** in dock → `scrollToStory(storyId)`:

- Closes dock (220ms for animation).
- `document.getElementById('story-<storyId>')?.scrollIntoView({block:'center'})`.
- Amber background flash for 900ms.
- Required hook: `hierarchy-view.tsx` story row gets
  `id="story-<storyId>"` and `data-story-id` attributes.

**Tests:** `src/hooks/__tests__/use-attention-items.test.ts` (4 unit tests
for dedupe).

---

## Phase C — Rigor + TEST Agent + Logs Tab (SHIPPED)

### C.1 + C.2 Rigor dropdown + Playwright toggle + Test model

**Plan type additions** (`functions/shared/types/plan.ts` + mirrored
`src/types/plan.ts`):

```ts
export type PlanRigor = 'prototype' | 'mvp' | 'production';

export interface PlanTestingProfile {
  hasBrowserTests?: boolean;
  viewport?: string;
  interactionModel?: string;
}

export interface Plan {
  // … existing fields …
  testModel?: string; // default 'sonnet'
  rigor?: PlanRigor; // default 'mvp'
  testingProfile?: PlanTestingProfile;
}
```

**Schema additions** (`functions/shared/schemas/plan-schema.ts`):

- `planRigorSchema`, `planTestingProfileSchema`
- Both `planCreateInputSchema` and `planPatchSchema` accept the new fields.

**Form** (`src/components/labs/plans/new-plan-form.tsx` Advanced Settings):

- Rigor dropdown (full-width) with dynamic `<small>` explanation per option.
- Playwright toggle directly under Execution mode. Default follows rigor
  (off for prototype, on for mvp/production). User override is sticky via
  `browserTestsDirty` flag.
- Test model dropdown alongside Dev and Reviewer. Default `sonnet`.
- Payload forwards `rigor`, `testModel`, `testingProfile: { hasBrowserTests }`.

**Persistence:** `/api/plans` and `/api/plans/from-intent` set defaults:
`rigor: input.rigor || 'mvp'`, `testModel: input.testModel || 'sonnet'`,
`testingProfile: input.testingProfile`.

### C.3 Pipeline builder rigor variants

`functions/shared/pipelines/story-pipeline.ts` — `generateStoryPipeline`
gained `rigor`, `testModel`, `hasBrowserTests` in its `opts`:

```
prototype:   dev → review → retry → compile-*
mvp:         test-author → dev → test-verify → review → retry → compile-*
production:  test-author → test-gate-red → dev → test-verify →
             tamper-check → review → retry → compile-*
```

**New TEST agent** in pipeline `agents` map:

- `allowedTools: 'Bash,Read,Write,Edit,Glob,Grep'`
- `model: opts.testModel || 'sonnet'`
- Prompt instructs: write tests in `**/*.test.*`, `__tests__/**`, `e2e/**`,
  `tests/**` only; output `---TEST_FILES---` block + `---WORK_SUMMARY---`.

**Shell gate steps:**

- `test-gate-red` (production) — `! npm test` so success = tests failed (red
  state confirmed).
- `test-verify` (mvp + production) — `npm test`, expects exit 0.
- `tamper-check` (production) — diffs `{{TEST_FILES}}` against `HEAD`,
  reverts dirty files with `git checkout --`, exits 1 on detection.

### Plumbing rigor through the call chain

Two paths for launching a wave:

1. **`/api/plans/:id/start`** (plan-wave 0) — reads plan, builds `planOpts`,
   passes to `launchPipelineWave`.
2. **`wave-completion-check` cron** → `plan-reducer.reducePlan` → builds
   `planOpts` from `plan.rigor / plan.testModel /
plan.testingProfile?.hasBrowserTests` → passes to both `reduceEpicWaves`
   and the inner `launchPipelineWave` calls.

**New types** (`functions/shared/services/pipeline-launcher.ts`):

```ts
export interface PlanExecutionOpts {
  rigor?: PlanRigor;
  testModel?: string;
  hasBrowserTests?: boolean;
}
```

Optional 6th arg on `launchPipelineWave(...)`. Optional 3rd arg on
`reduceEpicWaves(epic, deps, planOpts?)`.

**If you add a new launchPipelineWave callsite:** remember to build
`planOpts` from the plan row and pass it, or tests will run with no rigor
(defaults to 'mvp' in the pipeline builder, so behavior is safe — but
Playwright and test model won't propagate).

### C.4 Tamper-check with auto-revert

Implemented entirely inside the `tamper-check` shell step (see C.3). No
new daemon step type. Uses `{{TEST_FILES}}` template var captured by the
`test-author` step.

**Deferred:** `tamperCount` story-level counter + "3-strike"
`tamper-reverted` attention item. Current design relies on the Phase A.3
retry ladder — a story that keeps tripping tamper-check will eventually hit
`retry-exhausted`. Fine for prototype rigor level.

### C.5 Per-story Logs tab

`src/components/labs/plan-dashboard/views/hierarchy-view.tsx` — the
`StoryDetailPanel` gained a tab strip (`OVERVIEW` / `LOGS`):

- **Overview tab** = existing two-column description + live log view.
- **Logs tab** = `<StoryLogsPane>`:
  - Per-step filter chips (derived from events' unique `stepId`s with
    counts).
  - Monospace `<pre>` pane with `[timestamp] stepId / agentId / eventType`
    headers per event.
  - **Copy to clipboard** button with green confirmation.

**Source:** same `useAgentEvents` hook as the live log — NOT S3. The DDB
events table has a 7-day TTL; older logs are gone.

**Deferred:** S3 persistence (daemon would need to flush events to
`logs/<planSlug>/<storyId>/<stepId>.log` on step close, API would need a
pre-signed URL route). Not built; MVP value is already usable.

---

## Phase D — Polish (SHIPPED)

### D.1 Budget warning banner

`src/components/labs/plan-dashboard/budget-banner.tsx` — loud amber banner
that renders above the pipeline stepper when `plan.totalCostUsd` exceeds a
rigor-specific threshold:

```ts
const THRESHOLDS: Record<PlanRigor, number> = {
  prototype: 5,
  mvp: 10,
  production: 25,
};
```

Dismissal is tracked in `sessionStorage` per plan
(`budget-banner-dismissed:<planId>` key → last-dismissed dollar amount).
The banner re-arms when spend grows more than $1 beyond the dismissed
level — so a $1.23 extra spend after you dismissed at $12 will re-alarm
at $13+.

**Lazy init pattern:** state is initialized inside `useState(() => ...)`
rather than in a `useEffect`. This avoids the `react-hooks/set-state-in-effect`
lint error and is SSR-safe (`typeof window === 'undefined'` check inside the
initializer).

Rendered from `src/components/labs/plan-dashboard/index.tsx` between
`<ProjectHero>` and `<Pipeline>`.

### D.2 Epic attention dot

`src/components/labs/plan-dashboard/views/hierarchy-view.tsx` —
`HierarchyView` calls `useAttentionItems(plan.id)` once and builds a
`epicId → unresolvedCount` map, passed down to each `<EpicCard>` as
`attentionCount`. When > 0, an amber pill (`<EpicAttentionDot>`) renders
next to the status label:

```
E1  Foundation  IN PROGRESS  ● 2
```

Tooltip shows `"N unresolved attention items on this epic"`. Styled as a
rounded chip with an amber dot + count, matching the budget-banner amber
for visual consistency.

### D.3 Retry-count pill on story rows

Story rows gain a `<RetryPill>` when the linked `AgentJob` has
`retryAttempt > 0`. Renders as `retry N/3` in the same amber palette:

```
▶ S-123 Implement ball physics … 50% 2m 3k $0.12 RUNNING  retry 2/3
```

**Schema extension:** `AgentJob` now formally declares `retryAttempt` +
`retryAfter` (Phase A.3 wrote these dynamically; Phase D.3 locks them
into the types so the UI can read them).

**Adapter:** `DashboardStory` gains `retryAttempt` + `maxRetries`; the
adapter (`src/components/labs/plan-dashboard/adapter.ts`) reads
`job?.retryAttempt ?? 0` and hard-codes `maxRetries: 3` (the daemon's
current ladder length).

**Grid change:** the story row's `gridTemplateColumns` went from
`'24px 60px 1fr auto auto auto auto auto'` (8 cols) to a 9-column layout
to make room for the pill. If you add more metric chips on the row,
update the grid accordingly.

---

## Runtime Controls Split (post-phase, SHIPPED)

`src/components/labs/runtime-controls.tsx` replaces the single-row
`<Ec2Toggle>` + `<DaemonStatus>` in `LabsHeader` (and `app/labs/page.tsx`)
with two visually grouped panels sharing the `ec2-status` query:

- **Daemon panel** — Local/EC2 toggle, state chip (with heartbeat-time
  tooltip), active/max-concurrent count, and a new **Restart** button.
  Restart calls `useRestartEc2Daemon()` (new hook hitting the existing
  `POST /api/ec2/start-daemon` endpoint, which is already idempotent
  `systemctl restart`). Restart confirms before firing (warns about the
  Phase A.1 30s graceful window), shows a spinner while the SSM command
  runs, and re-invalidates `ec2-status` 3s after the command returns.
- **Claude Code panel** — OAuth status chip (`oauth` green / `auth
  expired` red / `probing` spinner) + `<ReauthorizeButton>`. Renders only
  when EC2 mode is selected AND the instance is `running` (nothing to
  authorize in local mode).

Shared `<PanelShell>` keeps both containers visually consistent (monospace
uppercase label → separator dot → content). Old `ec2-toggle.tsx` +
`daemon-status.tsx` are kept in the tree as references but no longer
imported from production routes.

**If you add a new daemon action:** put it in `DaemonPanel`. Add a new
hook in `src/hooks/use-ec2-daemon.ts` if it hits an endpoint. The panel
already handles spinner + confirm patterns — mimic `handleRestart`.

---

## Invariants to preserve

1. **Never register a spawn without unregistering.** Breaks graceful
   shutdown. See A.1.
2. **Never bypass `assertSpawnAllowed` for new spawns in the daemon.**
   A.2 is the only backstop against another runaway-grep incident.
3. **Attention writes must not throw.** Reducer and daemon both swallow
   errors. If you add a new writer call site, wrap in `.catch(() => {})`.
4. **Do not narrow `launchPipelineWave`'s signature.** `planOpts` is
   optional for test injectability.
5. **Story rows must have `id="story-<storyId>"`** for the dock's
   scroll-to-story behavior. If you rebuild the hierarchy, keep this.
6. **Story row grid has 9 columns.** Adding another metric chip means
   extending the `gridTemplateColumns` in `StoryRow`. See D.3.
7. **Runtime-controls panels share one `useEc2Status` query.** Don't
   mount two `RuntimeControls` on the same screen — they'd double-poll.

---

## Known deferred / future work

- **S3 log persistence** — see C.5 deferred note. Events table has a
  7-day TTL; logs older than that are not retrievable.
- **`tamperCount` tracking + 3-strike `tamper-reverted` attention item**
  — see C.4 deferred note. Current design relies on Phase A.3 retry
  ladder as the eventual backstop.
- **Attention items for `budget-warning` / `dev-server-down`** — category
  values are defined in `AttentionCategory` union but no writer sites
  exist yet. D.1 surfaces budget visually but doesn't emit an item.
- **Attention badges on the pipeline stepper** — the v2 plan mentioned
  this as a Phase D polish but it wasn't shipped. Only epic rows got
  the badge (D.2). Can be added to `plan-dashboard/pipeline.tsx` if
  needed.

## Deploy status (as of 2026-04-23)

- `sst deploy --stage production` → complete.
- `futurator-attention-items` DDB table → ACTIVE.
- `develope-it-ec2-ssm` IAM role `dynamodb-access` policy → updated to
  include `futurator-attention-items`, `…/index/*`, and
  `futurator-plans` (the last was also missing pre-fix).
- Daemon on `i-0826d68c316ae97dd` → restarted via SSM, `systemctl
  is-active` = `active`. New `shell-guard.mjs`, `child-tracker.mjs`,
  `attention-writer.mjs`, updated `agent-daemon.mjs`,
  `epic-dev-pipeline.mjs`, `party-turn.mjs` are live in
  `/opt/futurator-daemon/`.
- 5 commits landed on `main` locally (not pushed to remote); see
  `git log --oneline -6` for the chain.

---

## Quick reference — where things live

| Concern                                | Path                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| Daemon shutdown + retry + guard wiring | `daemon/agent-daemon.mjs`                                       |
| Child tracker                          | `daemon/pipelines/lib/child-tracker.mjs`                        |
| Shell guard                            | `daemon/pipelines/lib/shell-guard.mjs`                          |
| Daemon attention writer                | `daemon/pipelines/lib/attention-writer.mjs`                     |
| Attention types                        | `functions/shared/types/attention.ts`                           |
| Attention repo                         | `functions/shared/repositories/attention-items-repository.ts`   |
| Plan type                              | `functions/shared/types/plan.ts` (mirrored `src/types/plan.ts`) |
| Plan schema                            | `functions/shared/schemas/plan-schema.ts`                       |
| Story pipeline (rigor variants)        | `functions/shared/pipelines/story-pipeline.ts`                  |
| Pipeline launcher (PlanExecutionOpts)  | `functions/shared/services/pipeline-launcher.ts`                |
| Wave reducer (attention + rigor)       | `functions/shared/services/wave-reducer.ts`                     |
| Plan reducer (cascades planOpts)       | `functions/shared/services/plan-reducer.ts`                     |
| Wave-completion cron wiring            | `functions/cron/wave-completion-check.ts`                       |
| Attention API routes                   | `functions/api/index.ts` (search `attention-items`)             |
| Attention hook + dedupe                | `src/hooks/use-attention-items.ts`                              |
| Attention dock                         | `src/components/labs/plan-dashboard/attention-dock.tsx`         |
| New-plan form (rigor UI)               | `src/components/labs/plans/new-plan-form.tsx`                   |
| Story detail (Logs tab + retry pill)   | `src/components/labs/plan-dashboard/views/hierarchy-view.tsx`   |
| Budget banner (D.1)                    | `src/components/labs/plan-dashboard/budget-banner.tsx`          |
| Dashboard adapter (retryAttempt pass)  | `src/components/labs/plan-dashboard/adapter.ts`                 |
| Runtime controls split                 | `src/components/labs/runtime-controls.tsx`                      |
| Labs header (hosts runtime-controls)   | `src/components/labs/plan-dashboard/labs-header.tsx`            |
| Labs plans page (also hosts controls)  | `src/app/labs/page.tsx`                                         |
| useRestartEc2Daemon hook               | `src/hooks/use-ec2-daemon.ts`                                   |
| SST attention table                    | `sst.config.ts` (`AttentionItemsTable`)                         |

**Plan doc (decisions, not code):** `docs/concepts/pipeline-enhancement-plan-v2.md`.
