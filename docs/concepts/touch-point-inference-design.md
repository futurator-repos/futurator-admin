# Touch-Point Inference Design

Companion to `docs/concepts/epic-orchestrator-architecture.md` §6 (Wave Conflict Handling) and §13 (Phased Implementation Plan). Specifies how stories get populated with `touchPoints`, `complexity`, and `reviewRigor` before the epic-dev orchestrator dispatches.

> **Goal:** at epic-dev job start, every story in the epic has a deterministic, conflict-checked set of file globs declaring what it will touch. The orchestrator reads these upstream values and rarely hits runtime collisions.

---

## 1. Where this runs

**Not** inside `daemon/pipelines/predev-compile-pipeline.mjs` or `epic-compile-pipeline.mjs` — those are the Mycelium knowledge-graph pipelines (PRD → wiki articles). Naming collision in early planning notes; corrected here.

Touch-point inference runs as **step 1 of the new `epic-dev-pipeline.mjs`** (Phase 4 of the implementation plan), before the orchestrator spawns. Proposed file:

```
daemon/pipelines/epic-dev-pipeline.mjs          (Phase 4 — orchestrator dispatch)
daemon/pipelines/touch-point-inference.mjs      (this design — standalone module)
```

`epic-dev-pipeline.mjs` imports and invokes `touch-point-inference.mjs` as its pre-step. Keeping inference in its own module lets us unit-test it in isolation and run it as a CLI for development.

### Control flow

```
epic-dev job spawned
  → touch-point-inference
    → for each story in epic.stories (parallel, up to maxParallel):
      → spawn Haiku via Claude CLI with inference prompt
      → parse <INFERENCE> block
    → collision check across stories (compile-time)
    → wave re-assignment if needed
    → persist touchPoints/complexity/reviewRigor/wave on epic row
  → orchestrator spawned
    → consumes upstream-populated story fields
```

---

## 2. Story model additions

Extend `functions/shared/types/epic-workflow.ts :: EpicStory`:

```ts
export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';
export type ReviewRigor = 'light' | 'standard' | 'strict';

export interface EpicStory {
  // existing fields …
  storyId: string;
  order: number;
  title: string;
  description: string;
  status: StoryStatus;
  dependsOn?: string[];
  wave?: number;
  criteria?: AcceptanceCriterion[];
  // … etc

  // NEW — populated by touch-point-inference step
  touchPoints?: string[]; // glob patterns, edit boundary for dev subagent
  complexity?: StoryComplexity; // selects subagent type (trivial → haiku, …)
  reviewRigor?: ReviewRigor; // selects reviewer effort keyword
  inferenceMetadata?: {
    inferredAt: string; // ISO
    model: 'haiku'; // frozen to haiku; upgrade requires explicit flag
    confidence: 'low' | 'medium' | 'high';
    reasoning?: string; // Haiku's short justification
    retries?: number; // 0 on first success
  };
}
```

No existing field is modified. All new fields optional on the interface so historical stories continue to validate; the epic-dev job validator (Phase 4) requires them present.

---

## 3. Inputs to inference

For each story, the inference step passes Haiku:

| Input                             | Source                           | Purpose                           |
| --------------------------------- | -------------------------------- | --------------------------------- |
| `storyId`, `title`, `description` | existing `EpicStory` fields      | the story itself                  |
| `criteria`                        | existing `AcceptanceCriterion[]` | AC list, bullet form              |
| `projectCodebaseIndex`            | see §4 below                     | compressed repo map               |
| `siblingStories`                  | other stories in the epic        | for collision awareness           |
| `conventionsDigest`               | see §5 below                     | where things live in this project |

The `projectCodebaseIndex` and `conventionsDigest` are **shared across all stories in the epic** — computed once per epic-dev job, reused for every inference call.

---

## 4. Codebase index

Haiku cannot Glob/Grep the repo on every story — too slow, too many tokens. It needs a pre-built, compressed map.

### 4.1 Index source

**Primary: Mycelium `knowledge/code/*.md` articles** (if the project uses Mycelium Devs).

Each article has frontmatter + `## Purpose`, `## Key Exports`, `## Dependencies` — exactly the shape Haiku needs. We flatten these into a single markdown string:

```
src/hooks/use-costs.ts — TanStack Query hook for cost aggregation rows. Exports: useCosts(range). Depends on: api-client, cost-repository contract.
src/stores/auth-store.ts — Zustand auth store with JWT refresh. Exports: useAuthStore, authActions. Depends on: api-client, identity-broker.
functions/shared/repositories/cost-repository.ts — DynamoDB reads/writes for costs. Exports: getCosts, putCostRow, … Depends on: dynamo-client.
functions/api/index.ts — Hono.js single-file API handler. Route: /api/costs, /api/projects, …
…
```

Target size: ≤ 8 KB for a typical Futurator-Admin-sized repo. Larger repos get filtered by phase (`code/` only, skip `planning/`).

### 4.2 Fallback: bootstrap scan

For projects without Mycelium installed (or where `knowledge/code/` is empty), the inference step runs a lightweight scan:

```
daemon/scripts/bootstrap-scan.mjs
```

Already exists (`bootstrap-scan.mjs`). Produces a similar markdown summary by walking `src/`, `functions/`, `daemon/` and reading the top N lines of each file. Less accurate than Mycelium articles, but serviceable for touch-point inference.

Fallback path selected when `knowledge/code/` is empty or absent.

### 4.3 Caching

The index is cached per commit SHA on the epic's `workingDir`:

```
{workingDir}/.futurator/codebase-index-{git-sha-short}.md
```

Rebuilt on SHA change. This cache is invalidated automatically when a previous epic-dev job lands changes.

---

## 5. Conventions digest

Each project has conventions that encode "where things live":

- API routes → `functions/api/index.ts` (Hono, single file)
- DynamoDB reads → `functions/shared/repositories/<concern>-repository.ts`
- React hooks → `src/hooks/use-<domain>.ts`
- UI primitives → `src/components/ui/…`
- Zustand stores → `src/stores/<domain>-store.ts`

Source: **`CLAUDE.md`** (§Architecture/§Key Conventions). The inference step reads `{workingDir}/CLAUDE.md` and passes the "Architecture" + "Key Conventions" sections to Haiku verbatim. No extra work — this content is already curated and authoritative.

For projects without a `CLAUDE.md`, the conventions digest is empty. Haiku's accuracy drops; inferenceMetadata.confidence reflects this.

---

## 6. Haiku prompt

Invoked via Claude CLI per story:

```
claude --model haiku --allowedTools '' --print < /tmp/inference-prompt-{storyId}.txt
```

No tool use — pure reasoning over provided context. `--allowedTools ''` locks it down.

### 6.1 Prompt template

Stored at `daemon/pipelines/templates/touch-point-inference.md.tpl`. Rendered per story:

```markdown
You are a senior engineer inferring which files a story will modify. Output a strict JSON block — nothing else after it.

## Story

storyId: {{storyId}}
title: {{title}}

Description:
{{description}}

Acceptance criteria:
{{criteriaBullets}}

## Project conventions

{{conventionsDigest}}

## Codebase index

{{codebaseIndex}}

## Sibling stories in this epic (avoid overlapping their scope)

{{siblingBullets}}

## Your task

1. Read the story and identify every file the implementer will Edit or Write. Be precise — avoid blanket globs like `src/**`. Prefer specific files; use globs only when a story touches a clear pattern (e.g., `src/components/admin/costs/*.tsx`).
2. Classify the complexity as one of:
   - `trivial` — one-line changes, renames, config bumps, mechanical edits
   - `standard` — typical feature, bug fix, moderate refactor
   - `complex` — multi-file coordinated change, new feature touching 3+ layers
   - `architectural` — introduces or modifies patterns, contracts, cross-cutting infra
3. Set reviewer rigor:
   - `light` — trivial complexity, docs/comments, cosmetic UI
   - `standard` — everything else by default
   - `strict` — architectural complexity, security-adjacent, payment/auth paths
4. Note any sibling story whose likely touch points overlap yours. List them in `collisionsWith`.

## Output format

Return exactly this JSON block, nothing before or after:

<INFERENCE>
{
  "touchPoints": ["path/or/glob", "…"],
  "complexity": "trivial" | "standard" | "complex" | "architectural",
  "reviewRigor": "light" | "standard" | "strict",
  "confidence": "low" | "medium" | "high",
  "reasoning": "≤ 2 sentences on what you inferred and why",
  "collisionsWith": ["siblingStoryId", …]
}
</INFERENCE>
```

### 6.2 Template variables

| Var                 | Type   | Size budget | Source                                              |
| ------------------- | ------ | ----------- | --------------------------------------------------- |
| `storyId`, `title`  | string | —           | `EpicStory`                                         |
| `description`       | string | ≤ 2 KB      | `EpicStory.description`                             |
| `criteriaBullets`   | string | ≤ 1 KB      | `EpicStory.criteria` rendered as `- ` bullets       |
| `conventionsDigest` | string | ≤ 3 KB      | CLAUDE.md §Architecture + §Key Conventions, trimmed |
| `codebaseIndex`     | string | ≤ 8 KB      | §4 above                                            |
| `siblingBullets`    | string | ≤ 1 KB      | `- {siblingId}: {title}` per sibling                |

Total prompt ≤ 15 KB. Haiku input window far exceeds this; we optimize for cost, not capacity.

### 6.3 Output parsing

```ts
function parseInference(output: string): Inference | InferenceError {
  const match = output.match(/<INFERENCE>\s*(\{[\s\S]*?\})\s*<\/INFERENCE>/);
  if (!match) return { ok: false, reason: 'no-block' };
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed.touchPoints) || parsed.touchPoints.length === 0) {
      return { ok: false, reason: 'empty-touch-points' };
    }
    if (!['trivial', 'standard', 'complex', 'architectural'].includes(parsed.complexity)) {
      return { ok: false, reason: 'invalid-complexity' };
    }
    return { ok: true, inference: parsed };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}
```

---

## 7. Collision check (compile-time)

After Haiku returns for every story in the epic, the inference step runs a deterministic cross-story pass:

### 7.1 Overlap detection

For each pair of stories `A`, `B` in the same epic:

```
overlap(A, B) = any (a ∈ A.touchPoints, b ∈ B.touchPoints):
  globIntersects(a, b)
```

`globIntersects` tests whether two globs could match a common file. Implemented via `picomatch.matcher` + known-extension enumeration for `**` patterns. Conservative — false positives are fine, false negatives are not.

### 7.2 Resolution strategy

Three outcomes for an overlap:

| Condition                                       | Action                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Both stories have `dependsOn` relationship      | Respect the existing wave order. No action.                                                                       |
| Haiku flagged the collision in `collisionsWith` | Trust the upstream signal; split into adjacent waves.                                                             |
| Collision undetected by Haiku but present       | Emit `wave_conflict_autosplit` event; assign higher-complexity story to earlier wave, split sibling to next wave. |

### 7.3 Wave re-assignment

If the epic already has `wave` assigned (from prior planning), the inference step preserves the DAG order but inserts micro-waves where needed:

```
Before: wave=1 [S-7, S-8, S-9]
After overlap detected between S-7 and S-9:
  wave=1 [S-7, S-8]
  wave=2 [S-9]
  wave=3 [S-10, …]  (shifted)
```

Wave numbers are re-normalized (no gaps) and persisted on the epic row.

---

## 8. Confidence handling

Haiku's `confidence` field is informational, but drives two downstream behaviors:

- **`confidence: "low"`** — epic-dev pipeline marks the story with `requiresOperatorReview: true`. UI shows an amber badge on the story card pre-dispatch. Operator can approve or edit `touchPoints` directly.
- **`confidence: "low"` AND `complexity: "architectural"`** — the epic-dev job **pauses** before dispatch until operator acknowledges. Architectural stories with low confidence are too risky to dispatch blindly.

Medium/high confidence proceeds without intervention.

---

## 9. Failure modes

| Failure                                             | Behavior                                                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Haiku output has no `<INFERENCE>` block             | Retry once with the same prompt                                                                                                                                                  |
| Still no block after retry                          | Fall back: set `touchPoints: [description-derived keyword globs]`, `complexity: 'standard'`, `reviewRigor: 'standard'`, `confidence: 'low'`; mark `requiresOperatorReview: true` |
| JSON parse error                                    | Same retry + fallback                                                                                                                                                            |
| Empty `touchPoints` array                           | Same retry + fallback                                                                                                                                                            |
| Claude CLI non-zero exit                            | Retry once; second failure → epic-dev job stays in `PENDING_INFERENCE` state, emits `inference_failed` event, operator intervenes                                                |
| Project has no `CLAUDE.md` and no `knowledge/code/` | Run `bootstrap-scan.mjs` and use its output as codebase index. Accuracy degraded but viable.                                                                                     |

The inference step **never** silently dispatches with bad touch points. A missing/invalid inference result blocks dispatch.

---

## 10. Parallelism and cost

### 10.1 Fan-out

Inference runs per story in parallel, capped at the epic-dev job's `maxParallel` (default 8). For a 10-story epic: ~2 batches.

Wall-clock per story: ~3–6 seconds for Haiku with ≤15 KB prompt. A 10-story epic completes inference in ~10–15 seconds.

### 10.2 Cost budget

Per story:

| Quantity                | Size/count                    |
| ----------------------- | ----------------------------- |
| Input tokens            | ~4,000                        |
| Output tokens           | ~300                          |
| Haiku pricing (current) | input $1/Mtok, output $5/Mtok |
| Per-story cost          | ~$0.0055                      |
| 10-story epic           | ~$0.055                       |
| 50-story epic           | ~$0.275                       |

Negligible compared to dev/review runs. Running inference always (never cached per-story) is fine.

### 10.3 No per-story caching

We do NOT cache inference results across runs. Re-runs are cheap and stories often change between runs. Keep simple.

The codebase index IS cached (§4.3) because it's shared across all stories and expensive to rebuild.

---

## 11. API surface

### 11.1 CLI entry point

```
node daemon/pipelines/touch-point-inference.mjs \
  --epic-id EPIC-42 \
  --working-dir /path/to/cloned/repo \
  --out /tmp/inference-result.json
```

Writes a JSON document:

```json
{
  "epicId": "EPIC-42",
  "stories": [
    {
      "storyId": "STORY-7",
      "touchPoints": ["src/hooks/use-costs.ts", "src/components/admin/costs/cost-chart.tsx"],
      "complexity": "standard",
      "reviewRigor": "standard",
      "confidence": "high",
      "reasoning": "…"
    },
    …
  ],
  "collisions": [
    { "stories": ["STORY-7", "STORY-9"], "overlap": "src/hooks/use-costs.ts", "resolution": "split-wave" }
  ],
  "waveReassignments": [ … ],
  "requiresOperatorReview": ["STORY-12"],
  "totalCostUSD": 0.055
}
```

Also writes touch-point inference fields onto the epic row via `epicWorkflowRepo.updateEpic()`.

### 11.2 Library entry point

```ts
export async function inferTouchPoints(opts: {
  epic: EpicWorkflow;
  workingDir: string;
  codebaseIndex?: string; // optional override
  maxParallel?: number; // default 8
  haikuModel?: string; // default 'haiku'
}): Promise<InferenceResult>;
```

Used by `epic-dev-pipeline.mjs` directly (no intermediate disk write).

### 11.3 HTTP surface (Phase 5+)

Operator-facing retry endpoint for failed inference:

```
POST /api/epic-workflows/:epicId/infer-touch-points
body: { force?: boolean; storyIds?: string[] }
```

Re-runs inference for specified stories or all. Used when CLAUDE.md changes or the codebase index is known stale.

---

## 12. Events emitted

Via the observability spine (emit-event.sh). Under `role: "orchestrator"` with `storyId` per story:

| Event                     | When                               | Payload                                                           |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `inference_start`         | per epic-dev job start, once       | `{storyCount, maxParallel}`                                       |
| `story_inferred`          | per story Haiku return             | `{storyId, complexity, reviewRigor, confidence, touchPointCount}` |
| `wave_conflict_autosplit` | collision check re-assigned a wave | `{storyIds, overlap, fromWave, toWave}`                           |
| `inference_failed`        | Haiku failed twice                 | `{storyId, reason, fallbackApplied}`                              |
| `inference_complete`      | entire epic inferred               | `{totalStories, requiresOperatorReview, totalCostUSD}`            |

These surface in the Event Log and Agentic Office (supervisor at whiteboard "planning" animation).

---

## 13. UI surface (minimal for Phase 5)

Pre-dispatch view, per story card:

```
┌─────────────────────────────────────┐
│ STORY-7 — Add cost chart filter     │
│ wave 1 · standard · light review    │  ← inferred chips
│ 📝 2 touch points                    │  ← click to expand
│   src/hooks/use-costs.ts             │
│   src/components/admin/costs/…       │
└─────────────────────────────────────┘
```

For `requiresOperatorReview: true` stories:

```
┌─────────────────────────────────────┐
│ STORY-12 — Migrate auth flow        │
│ wave 3 · architectural · ⚠️ low confidence │
│ [Edit touch points] [Approve]       │
└─────────────────────────────────────┘
```

Full UI design is in Phase 5's UI doc (shortlist item d covers the blocker side).

---

## 14. Testing strategy

**Unit tests:**

- `parseInference` — malformed blocks, missing fields, invalid values
- `globIntersects(a, b)` — known pairs that should/shouldn't overlap
- `reassignWaves(stories, collisions)` — idempotent, preserves DAG order
- Fallback generator when Haiku output is unusable — deterministic output for a fixed input

**Integration tests:**

- Fake Claude CLI (returns canned `<INFERENCE>` blocks) — assert end-to-end inference pipeline populates story fields correctly
- 3-story epic with known overlap — assert wave reassignment
- Story with missing CLAUDE.md and empty knowledge/code/ — assert bootstrap-scan fallback works

**Smoke (post-Phase 4):**

- Real epic from Labs with 5+ stories against Futurator-Admin itself — inspect inferred touch points, manually verify ≥80% of files Haiku predicts do get edited during dev

---

## 15. Open items

1. **Touch-point globs vs explicit file lists.** Start with "prefer explicit, allow globs when obvious." If Haiku over-uses globs we add a prompt constraint.
2. **Complexity auto-escalation.** Should inference flag "this story says 'trivial rename' but actually touches 8 files" as a mismatch? Current design: no — trust Haiku's explicit classification. Revisit if we see bad classifications in practice.
3. **Story dependencies from Haiku.** Haiku could also infer `dependsOn` between sibling stories ("STORY-9 depends on STORY-7's new hook"). Not in v1 — dependencies come from epic planning. Add as follow-up when we see how often planning misses them.
4. **Reviewer-rigor rubric overlap.** `reviewRigor: 'strict'` is used for architectural and security paths. Should Haiku also key off path patterns (e.g., anything touching `/auth/` is automatically strict)? Candidate for a deterministic post-processing step that upgrades rigor regardless of Haiku's output.
5. **Re-inference on story edit.** When the operator edits a story mid-epic, inference should re-run for that one story. Hook-point TBD — likely in the `PATCH /api/epic-workflows/:epicId/stories/:storyId` endpoint.

---

## 16. Implementation sequence

Lands in Phase 1.5 of the architecture doc (between subagent specs and epic-dev pipeline):

1. Extend `EpicStory` interface with the four new optional fields (§2).
2. Write `daemon/pipelines/templates/touch-point-inference.md.tpl`.
3. Write `daemon/pipelines/touch-point-inference.mjs` — CLI + library API.
4. Write `daemon/pipelines/lib/glob-intersect.mjs` — pure utility.
5. Write `daemon/pipelines/lib/codebase-index.mjs` — index builder (Mycelium + bootstrap-scan fallback).
6. Unit tests for parser, glob intersect, wave reassignment.
7. Integration test with canned Haiku responses.
8. Wire into Phase 4's epic-dev-pipeline as its pre-step.
9. Smoke against a live Futurator-Admin epic.
