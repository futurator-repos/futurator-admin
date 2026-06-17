# Pipeline v2.5 — Fixes Plan

> **Status:** DRAFT (open for multi-agent contribution)
> **Owner of this draft:** Claude (forensic analysis pass #1)
> **Created:** 2026-06-17
> **Supersedes/extends:** [`PipelineV2-definitive-fixes.md`](./PipelineV2-definitive-fixes.md)

This is the master remediation plan for the development pipeline, derived from a deep
forensic analysis of the `pacman3` plan (`plan_pacman3_mqi8x64w`, mvp rigor) plus
cross-checks against the live EC2 daemon log and on-disk state. It catalogs **what is
wrong, the evidence, the root cause, and the proposed fix** for each issue, then
organizes the fixes into prioritized workstreams.

---

## 0. How collaborating agents should use this doc

Multiple agents are contributing. To avoid collisions:

1. **Findings are append-only.** Each finding has a stable ID (`F1`, `F2`, …). Do not
   renumber. If you discover a new issue, add the next free `F<n>` at the end of §3.
2. **Edit in place only inside a finding's `### Agent notes` subsection**, tagged with
   your agent name + date. Don't rewrite another agent's evidence — add a note that
   confirms, refutes, or extends it.
3. **Claim a workstream** in §4 by putting your name in the `Owner` cell. Don't start
   coding a fix another agent owns.
4. **Severity scale:** `P0` (data corruption / cost runaway), `P1` (major waste or lost
   feedback loop), `P2` (UX / observability), `P3` (polish).
5. **Status values:** `proposed` → `accepted` → `in-progress` → `shipped` → `verified`.
6. **Every code claim must carry a `file:line` ref.** If you can't cite it, mark it
   `[unverified]`.
7. Update the **Changelog (§7)** with a one-line entry per contribution.

---

## 1. Executive summary

The pipeline **works end-to-end** but is **expensive, near-serial, and loses both logs
and its own learning output.** Headline metrics from `pacman3` (forensic reconciled
against the daemon log — they agree):

| Metric                | Value                               | Read                                                |
| --------------------- | ----------------------------------- | --------------------------------------------------- |
| Wall clock            | **176.9 min** (15:59:59 → 18:56:50) | startedAt → reviewAt                                |
| Cumulative attributed | **170.9 min**                       | parallelism factor ≈ **1.03× → effectively serial** |
| Cost                  | **$21.01** vs **$20** ceiling       | ceiling is a soft post-hoc check, not a gate        |
| Stories               | total = **14**, done = **15**       | `done > total` — count-integrity bug                |
| Jobs                  | **29**                              | 15 dev-story, 13 wave-gate, 1 inter-wave wait       |

Time by category (cumulative): **compile 49.2 min (29%)**, vqa-gate 38.9 min (23%),
test-author 28.5 min, dev 27.9 min, merge-gate 15.3 min, review 4.9 min.

The four things that matter most:

- **Compile thrash** is the single biggest cost (49 min, 65–102 `tsc` runs _per story_),
  and a cache helper already exists but isn't wired into the dev loop.
- **Retries orphan their logs** (read-side), so the UI and the forensic export silently
  drop every superseded attempt — and with it, the true cost.
- **VQA mints new "fix" stories** that inflate `done` past `total` and produce the
  confusing "Fix visual regression: …" titles; one fix round was pure waste
  (`improved nothing → revert`).
- **The reflector ran, produced 3 proposals, and wrote 0** — silently blocked by an EC2
  IAM permission gap. The learning loop is firing into a void.

---

## 2. Evidence base & provenance

- **Primary:** `plan_pacman3_mqi8x64w-forensic.json` (743 KB, schema `timer-intel-v1.0`,
  2423 time-slices across 29 jobs). `events[]` omitted by default; aggregate + slices
  used for timing.
- **Absolute-truth cross-check:** `/var/log/futurator-daemon.log` on EC2
  `i-0826d68c316ae97dd` (`ec2-54-86-226-233`) — VQA outcomes, fix rounds, reflector
  result, and IAM failures all corroborate the forensic.
- **On-disk:** `/home/ubuntu/projects/pacman3/.context/vqa-handoffs/AC-S4-1.json` (the
  confirmed S4 failure); `inbox/reflections.md` **empty**.
- Per-story `tsc`/test invocations live inside the Claude subprocess and surface as
  DynamoDB `agent-events` (which the forensic is built from); the daemon stdout only
  carries orchestration lines. So the forensic is the granular source; the log is the
  orchestration source. **They are consistent.**

---

## 3. Findings catalog

### F1 — Compile thrash (P1, biggest single cost)

**Evidence.** `compile` is the largest category: **49.2 min / 29%** across **1159
slices**. Per dev story: **65–102 compile/test shell invocations** (job `1afb6167` = 102
compiles / 6.0 min; `5eeb6984` = 75 / 4.2 min). Only **1** formal
`compilation-started`/`completed` event per job — so the ~100 are agent-initiated `tsc`
re-runs inside the edit loop, not the formal baseline gate.

**Root cause.** The dev edit→verify loop re-runs full `tsc`/tests on every iteration.
A cache helper exists — `daemon/lib/cached-tsc.mjs` — but is wired **only** into the
prework-gate (`daemon/lib/prework-gate.mjs`, Signal 3), **not** into the in-loop
`test-verify` / `lint-verify` / `test-fix` steps (`functions/shared/pipelines/story-pipeline.ts`).

**Proposed fix.**

- Route the in-loop typecheck through `cached-tsc.mjs` (hash-keyed skip when inputs
  unchanged) and prefer incremental `tsc --build`.
- Debounce/batch: compile once per edit _batch_ at a checkpoint, not per file write.
- Scope typecheck to the story's touch-points + dependents where possible.

**Effort:** M. **Track:** A (perf). **Status:** proposed.

### F2 — Retries orphan their logs (read-side, not deletion) (P1)

**Evidence.** Retry/requeue does **not** delete events. A retry mints a **new jobId** and
overwrites `story.jobId` **in place** — `functions/shared/services/story-rerun-launcher.ts:140`
(`{ ...s, jobId }`). There is **no `priorJobIds` history** on the story. Prior events
remain in the `agent-events` table (7-day TTL,
`functions/shared/repositories/agent-events-repository.ts`) under the old jobId but are
unreachable. The UI hook `src/hooks/use-agent-events.ts` resets `events` to `[]` when the
jobId changes; `src/components/labs/agentic-workflow/story-live-output.tsx` keys on a
single `jobId`.

**Root cause.** Story → job is a 1:1 mutable pointer with no history. Every downstream
reader (UI, forensic) can only see the surviving job.

**Proposed fix.** Add `priorJobIds: string[]` (or a `jobHistory[]`) to the story row;
push the old jobId before overwriting in `story-rerun-launcher.ts`. Teach the forensic
collector (F3) and the UI to union across all jobIds.

**Effort:** S–M. **Track:** B (correctness). **Status:** proposed.

### F3 — Forensic export is not full start-to-finish (P1)

**Evidence.** `collectRawEvents()` (`functions/shared/timer/forensic-builder.ts:277`)
walks `epic.stories[i].jobId` — the **current jobId only** (plus orchestrator and
wave-build jobs). For each discovered jobId it correctly pages _all_ events, but it
**never discovers prior jobIds** from retried stories. Consequence: the downloaded
forensic is complete for surviving jobs but **silently omits every retried attempt**.
The cost gap is measurable — `plan.totalCostUsd` = $21.01 (daemon running sum across all
jobs) will exceed the sum of the forensic's `events[]` costs; the difference is invisible
retry spend.

**Root cause.** Same as F2 — no job history to walk.

**Proposed fix.** Once F2 lands, have `collectRawEvents()` union
`story.jobId ∪ story.priorJobIds`. Add a reconciliation assertion: forensic event-cost
sum should equal `plan.totalCostUsd` (±epsilon); surface the delta as
"orphaned/superseded spend" rather than hiding it.

**Effort:** S. **Track:** B (correctness). **Status:** proposed. **Depends on:** F2.

### F4 — VQA mints fix stories → `done > total` + confusing titles (P1)

**Evidence.** `daemon/lib/wave-vqa-fix-story.mjs:53`:

```js
title: `Fix visual regression: ${acList} — ${(owner?.title || ownerId).slice(0, 80)}`;
```

When VQA confirms a failure it **mints a new story** (`storyId: uuid()`,
`wave: maxWave+1`, `origin: 'wave-vqa-fix'`). The original story is **not renamed** — the
row you see labeled _"Fix visual regression: AC-S4-1 — Assemble the final Pacman…"_ is its
**child**. This minted story is the **+1 that makes done=15 > total=14**: `totalStories`
is never incremented when VQA adds work. Disk confirms a single confirmed failure this
run: `.context/vqa-handoffs/AC-S4-1.json`.

**Root cause.** Two bugs: (a) the displayed title is a derived label that's easy to
mistake for a rename of the parent; (b) the plan's `totalStories` counter is set at plan
build and never adjusted when the pipeline adds fix-forward stories.

**Proposed fix.**

- Increment `totalStories` (and re-derive `doneStories` consistently) whenever a
  fix-forward story is minted; or compute both from the live epic/story tree instead of a
  denormalized counter.
- UI: visually badge minted fix stories as **children of** their parent AC/story (origin
  `wave-vqa-fix`) rather than free-standing siblings, so the lineage is obvious.

**Effort:** S–M. **Track:** B (correctness). **Status:** proposed.

### F5 — Reflector output silently dropped (IAM) (P1, lost feedback loop)

**Evidence.** Daemon log at plan-close:
`reflector pipeline {"scope":"plan","planId":"plan_pacman3_mqi8x64w"}` →
`reflector produced 3 proposal(s)` → **`reflector completed (proposals=3, written=0)`**,
with `reflection-row write failed: User: arn:aws:sts::83… no identity-based policy
allow` and `…reflections because no identity-based policy allow…`. On disk
`inbox/reflections.md` is **empty**.

**Root cause.** The EC2 daemon's IAM role lacks `dynamodb:PutItem` on the reflections
table (and the file/S3 write also failed). Compounding: the reflector is **advisory-only**
(`daemon/pipelines/reflector-runner.mjs` — nothing auto-acts on its output), and at `mvp`
rigor **story-level reflection doesn't fire** (production-only); only wave + plan scopes
run.

**Proposed fix.**

- **IAM:** grant the daemon role write to the reflections table + `inbox/reflections.md`
  (and/or S3 backup path). This is the unblock.
- **Visibility:** surface proposals in the dashboard Reflection Inbox so the operator
  actually sees them.
- **Optional:** allow story-scope reflection at mvp (cheap signal) behind a flag.

**Effort:** S (IAM) + M (surface UI). **Track:** C (learning loop). **Status:** proposed.

### F6 — Cost ceiling is a soft post-hoc check (P0 for cost safety)

**Evidence.** `totalCostUsd` = **$21.01** with `costCeilingUsd` = **$20** → overran 105%.
The VQA judge has a `skipped-budget` / `plan cost ceiling reached` path (seen in the
daemon log), but the **dev pipeline does not consult the ceiling between stages/waves**,
so dev work overruns before VQA's guard ever applies.

**Root cause.** Ceiling enforcement is localized to the VQA judge, not a pipeline-wide
gate.

**Proposed fix.** Check `plan.totalCostUsd` vs `costCeilingUsd` at each wave boundary
(and ideally between expensive sub-stages); when exceeded, stop spawning new work and
mark the remainder `skipped-budget` with an operator attention card. Make the ceiling a
**hard gate with a small overrun tolerance**, not advisory.

**Effort:** M. **Track:** A (perf/safety). **Status:** proposed.

### F7 — test-author cost rivals/exceeds dev (P2)

**Evidence.** `test-author` = **28.5 min** total. In the largest job `eb01eb9c`:
test-author **344s** > compile 228s > **dev 163s**. Authoring failing tests (api-author
`.d.ts` freeze + TEST agent per AC) costs more than implementing the feature.

**Root cause.** Full test-authoring runs for every AC at every rigor, including `mvp`.

**Proposed fix.** At `mvp`: author tests only for ACs flagged verifiable / high-value;
skip the api-author `.d.ts` freeze for trivial stories (gate on complexity/touch-point
count). Keep full authoring for `production`.

**Effort:** M. **Track:** A (perf). **Status:** proposed. **Risk:** weakens the red-gate
contract — validate against the test-dev contract before shipping.

### F8 — Wasted VQA fix rounds + frequent `unverifiable` (P2)

**Evidence.** Daemon log:
`[wave-vqa] fix round 1 improved nothing — reverting the vqa-fix commit` →
`outcome=fix-forward` (AC-E3S3-1: a full FIXER agent run thrown away). VQA verdict
tally: `unverifiable=0` ×6, `unverifiable=1` ×2, `unverifiable=2` ×6 — the judge panel
frequently spends full runs and **can't conclude** (interaction-gated false negatives;
see `project_qa_remediation_model`, `project_vqa_v3_behavioral_probes`).

**Root cause.** (a) The FIXER runs even when triage classifies the failure as
`environment` / `ac-wording` (non-code-bug) — wasting a run that can't help. (b) VQA
lacks a deterministic interaction seam, so static-frame judging stalls at `unreachable`.

**Proposed fix.**

- Skip/cap the FIXER when triage ≠ `code-bug`; route `ac-wording`/`environment` straight
  to a handoff card.
- Feed the FIXER the **prior attempt's diff** (recovered via F2) so it doesn't repeat the
  reverted change.
- Land the behavioral-probe / `__harness` seam from the VQA v3 design to cut
  `unverifiable`.

**Effort:** M–L. **Track:** A + C. **Status:** proposed. **Depends on:** F2 (for prior
diff).

### F9 — Per-session boilerplate overhead (P3)

**Evidence.** `claude_md_loaded` and `skills_available` each fire **77 times** (once per
agent session). **66 skills** are advertised into every session; only `frontend-design`
ever activated (2×). `skillScoutRuns: []`. That catalog is injected as context tokens on
all 77 sessions for ~no use.

**Root cause.** Full skills catalog + CLAUDE.md loaded unconditionally per session.

**Proposed fix.** Inject the skills catalog only for roles that can invoke `Skill`
(DEV/REVIEWER), or gate by rigor; trim the advertised set to the skills actually relevant
to web-app dev. Measure token delta.

**Effort:** S. **Track:** A (perf). **Status:** proposed.

### F10 — Near-zero parallelism (P2, mostly plan-shape)

**Evidence.** Cumulative 170.9 min ≈ wall 176.9 min → parallelism factor **1.03×**. Most
waves were 1 story; only one wave had 2 parallel stories.

**Root cause.** Primarily a _plan-shape_ artifact (the epic/wave decomposition produced
mostly single-story waves), not a scheduler defect. But it means the wave machinery's
fixed overhead (merge gate, VQA gate, inter-wave wait) isn't amortized.

**Proposed fix.** Bias the planner toward wider waves where stories are independent (more
parallel slots per wave); measure the wave fixed-overhead and weigh it against story
granularity. **Constraint:** never reduce concurrency to fix host saturation — fix the
root (see `feedback_preserve_parallelism`).

**Effort:** M (planner heuristics). **Track:** D (planning). **Status:** proposed.

---

## 4. Workstreams

| Track | Theme                       | Findings                 | Owner       | Status   |
| ----- | --------------------------- | ------------------------ | ----------- | -------- |
| **A** | Perf / token reduction      | F1, F6, F7, F8(part), F9 | _unclaimed_ | proposed |
| **B** | Correctness / observability | F2, F3, F4               | _unclaimed_ | proposed |
| **C** | Learning loop               | F5, F8(part)             | _unclaimed_ | proposed |
| **D** | Planning / parallelism      | F10                      | _unclaimed_ | proposed |
| **E** | Context management (design) | see §5                   | _unclaimed_ | proposed |

---

## 5. Context-management design (the design-rich area)

How a story's context is built today (`daemon/pipelines/lib/story-context-pack.mjs`,
30k-token budget, ≈120 KB at 4 bytes/token):

- **Rebuilt from scratch every story:** full `plan.md` (3–50 KB) + `knowledge/index.md`
  - project tree (depth 2) + last-20 diffs + up to **5 prior-story summaries × 4000 chars**
  - touch-point file digests (head **300 lines** each, trimmed to 100 only under budget)
  - public exports + cited concept sections.
- **Caching today:** the DEV prompt's `project_context` block is prompt-cached across
  DEV/REVIEWER/COMPILER **within one story** (good). But test-author/api-author don't
  share it, and **nothing is shared across stories** except the prose `prevWorkSummaries`.

**Design opportunities** (this branch is literally `treesitter-slice` — lean into it):

1. **Treesitter symbol slices instead of head-300-lines.** Touch-point digests are blunt
   line-heads; symbol-level slices (the AC's named exports + their callers/callees) cut
   context size _and_ raise relevance simultaneously.
2. **Wave-level shared, prompt-cached context block.** `plan.md` + knowledge index + tree
   are identical for every story in a wave — build once per wave, cache it, and let
   stories diff against it instead of re-injecting per story.
3. **Per-role catalog trimming** (ties to F9).
4. **VQA handoff as first-class context** — feed the FIXER the prior attempt's diff
   (ties to F2/F8) to stop revert loops.
5. **Budget-aware progressive disclosure** — currently a static 30k trim waterfall; could
   be demand-driven (let the agent request more of a file rather than pre-loading 300
   lines of each touch-point).

---

## 6. Prioritized roadmap (draft — agents may re-sequence)

**Phase 1 — Unblock & stop the bleeding (small, high-leverage):**

1. **F5 IAM** — grant reflections write. Unblocks the learning loop (currently 100% lost).
2. **F6 hard cost gate** — stop $20→$21 overruns.
3. **F1 compile cache** — biggest single perf win; helper already exists.

**Phase 2 — Restore observability & correctness:** 4. **F2 priorJobIds history** → **F3 forensic union + cost reconciliation**. 5. **F4 totalStories count + fix-story lineage badge.**

**Phase 3 — Deeper efficiency:** 6. **F7 mvp test-authoring trim**, **F8 fixer gating + prior-diff**, **F9 catalog trim**. 7. **F10 planner parallelism**, **§5 context-management redesign.**

> Rationale for Phase 1 ordering: F5 is cheap and re-enables the feedback loop that will
> tell the operator which later fixes matter most; F6 is a safety stop; F1 is the largest
> measured waste.

---

## 7. Open questions (for the operator / other agents)

- **Q1 (F7):** Is trimming mvp test-authoring acceptable given the red-gate contract, or
  should the red gate stay mandatory at all rigors?
- **Q2 (F6):** Hard-stop at the ceiling, or stop-after-current-wave with an operator
  "continue anyway" button?
- **Q3 (F4):** Should fix-forward stories count toward `total`, or be tracked in a
  separate `remediationStories` counter so the original plan size stays meaningful?
- **Q4 (F5):** Should the reflector remain advisory, or graduate to auto-proposing PRs
  (REFLECTOR-APPLY, per `project_skills_institution_planning`)?
- **Q5 (§5):** Adopt treesitter slices now (branch is set up for it) or after Phase 2?

---

## Appendix A — Raw forensic metrics

**By category (cumulative ms / count):**

| Category       | Time         | Count    | Note                                                     |
| -------------- | ------------ | -------- | -------------------------------------------------------- |
| compile        | 49m 10s      | 1159     | 65–102 per story                                         |
| vqa-gate       | 38m 55s      | 41       | top gates 893s + 892s                                    |
| test-author    | 28m 30s      | 174      | rivals/exceeds dev                                       |
| dev            | 27m 51s      | 494      |                                                          |
| merge-gate     | 15m 18s      | 205      |                                                          |
| machine-wait   | 5m 22s       | 46       | mostly inter-wave                                        |
| review         | 4m 53s       | 60       |                                                          |
| test-execute   | 33.6s        | 45       |                                                          |
| baseline-check | 1.8s         | 45       |                                                          |
| tamper-check   | 0.7s         | 45       |                                                          |
| git            | 18.9s        | 105      |                                                          |
| fix            | 0.2s         | 4        | **mis-attributed — real fix work lands in vqa-gate/dev** |
| **total**      | **170m 55s** | **2423** |                                                          |

**Per-story compile load (top):** `1afb6167` 102/361s · `5eeb6984` 75/253s ·
`5fe9bed2` 85/247s · `98310d1a` 77/230s · `eb01eb9c` 86/228s.

**VQA gate split (top):** `1adb5638` vqa 830s / merge 63s · `b8d9376f` vqa 623s /
merge 269s · `8c39c9f7` vqa 369s · `805cdb92` vqa 339s.

**Skills:** activated `frontend-design` ×2; available 66; `skillScoutRuns: []`;
`claude_md_loaded`/`skills_available` ×77 each.

**Reflector:** `proposals=3, written=0` (IAM-blocked).

---

## Appendix B — Key file references

| Concern                               | File:line                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Per-story pipeline                    | `functions/shared/pipelines/story-pipeline.ts`                                                |
| Story context pack                    | `daemon/pipelines/lib/story-context-pack.mjs`                                                 |
| Cached tsc (exists, prework-only)     | `daemon/lib/cached-tsc.mjs`                                                                   |
| Prework gate                          | `daemon/lib/prework-gate.mjs`                                                                 |
| Wave VQA runner                       | `daemon/lib/wave-vqa-runner.mjs`                                                              |
| Wave merge                            | `daemon/lib/wave-merge.mjs`                                                                   |
| VQA fix-story mint (title)            | `daemon/lib/wave-vqa-fix-story.mjs:53`                                                        |
| Retry / story rerun (jobId overwrite) | `functions/shared/services/story-rerun-launcher.ts:140`                                       |
| Forensic builder (event collection)   | `functions/shared/timer/forensic-builder.ts:277`                                              |
| Forensic endpoint                     | `functions/api/index.ts:12125` (`GET /plans/:id/timing/forensic`)                             |
| Agent events repo (7-day TTL)         | `functions/shared/repositories/agent-events-repository.ts`                                    |
| Reflector runner                      | `daemon/pipelines/reflector-runner.mjs`                                                       |
| UI live output / events               | `src/components/labs/agentic-workflow/story-live-output.tsx`, `src/hooks/use-agent-events.ts` |

---

## Changelog

| Date       | Agent                 | Change                                                                                                               |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1) | Initial draft: findings F1–F10, workstreams A–E, roadmap, appendices from pacman3 forensic + daemon-log cross-check. |
