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

> **[QAreview-agentic · 2026-06-18] New P0 failure class — QA false-blocks correct apps.**
> A second forensic on the _same_ `pacman3` run found the **QA stage** (job `3c99fd51`,
> which the original forensic didn't walk — F2/F3) returned **VQA 0/10, FAIL, BLOCKING on a
> correct app** (`overview.png` is a complete, playable Pac-Man). Origin: the deploy stage
> rewrote QA's `next.config.ts` mid-run, relocating the app off root so every per-test
> capture 404'd; QA then scored the missing/404 frames as blocking defects. Three new
> findings: **F11** (deploy×QA same-worktree race), **F12** (broken evidence scored as
> defects), **F13** (state ACs with no executable probe) → new **Track F**. F11 is the
> origin and is P0 (the UI's "Send all failing back (6)" would re-run 6 dev stories on
> working code = cost runaway).

> **[graphify · 2026-06-18] Same shape, third stage — the knowledge graph.** A third
> forensic on `pacman3` found the **knowledge-compile** output (the system graph the next
> run grounds on) was **broken on correct code**: 177 nodes / 290 edges, 29 unconnected,
> `Orphan invariant: FAIL (20)`. Same lesson as F11/F12 — _clean agents, leaky harness_. Four
> root causes, new **Track G**: **F14** (persisted ast-facts = last story's 3-file worktree,
> not the 51-file project), **F15** (additive ingest never prunes deleted-source nodes),
> **F16** (the invariant is computed but swallowed at `exit 3`), **F17** (file nodes stamped
> with a job-UUID `projectId` → silently dropped DEFINES). **F17 + F18** (living-doc
> `REFERENCES` linking) are **fixed this session**; after the fixes pacman3's graph is 212
> nodes / 526 edges, **0 orphans**. F16 is the cheapest unfixed win — the FAIL signal already
> exists, nothing consumes it.

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

### F11 — Deploy mutates QA's worktree mid-run → evidence destroyed (P0, false-blocks correct apps)

> Contributed by **QAreview-agentic** (2026-06-18). The origin of the whole pacman3 QA failure.

**Evidence.** The QA stage returned VQA **0/10, OVERALL FAIL, BLOCKING** on a **correct**
app (`overview.png` from QA job `3c99fd51` is a fully-assembled, playable Pac-Man). In a
**single per-plan loop iteration**, `functions/cron/wave-completion-check.ts` both
(a) auto-approves QA and launches qa-execute (`launchPlanQaExecute`,
`wave-completion-check.ts:210`; sets `qaJobId`/`qaContractStatus:'approved'` at `:226-231`)
**and** (b) enqueues the dev-deploy (`buildDeployJob`, `wave-completion-check.ts:273-283`).
Forensic confirms both jobs started **18:57:49** against the **same**
`workingDir /home/ubuntu/projects/pacman3` (QA `3c99fd51`, deploy `d777f835`). The deploy
step is a freeform agent with Edit/Write (`functions/shared/deploy/build-deploy-pipeline.ts:47`)
that **rewrites `next.config.ts`** to inject `basePath:'/apps/_dev/pacman3/'`,
`output:'export'`, `images.unoptimized` (`build-deploy-pipeline.ts:66`). The QA dev-server
log (S3 `qa-snapshots/pacman3-initial/3c99fd51…/devserver.log`) shows the consequence:

```
GET / 200 in 5.6s            ← overview.png captured (real game) ✓
⚠ Found a change in next.config.ts. Restarting the server…
○ Compiling /_not-found/page …
GET / 404 in 27.4s  (×5)     ← app relocated to /apps/_dev/pacman3/; root now 404s
⚠ Found a change in next.config.ts. Restarting the server…
```

QA's `framework-detect` read `basePath=""` _before_ the rewrite (`PREPARE_OUTPUT`), so every
per-test navigation targeted `/` — which 404'd once the deploy moved the app off root.

**Root cause.** QA and deploy run **concurrently on the same git worktree + the same live
dev server**, with no mutual exclusion. The deploy's stated purpose is to give QA a stable
target — the cron comment says the dev-deploy exists "so the operator can click exactly
what headless QA tests against" (`wave-completion-check.ts:259-260`) — yet **QA ignores the
deployed URL and boots its own `next dev` in the dir the deploy is rewriting**
(`functions/shared/pipelines/visual-qa-pipeline.ts` qa-prepare, `:454-505`). Two stages
designed to cooperate instead collide.

**Proposed fix.**

- **Point QA at the dev-deploy URL** (the published, immutable preview the deploy already
  produces) instead of booting a dev server in the shared worktree — this is the stated
  intent, removes the race entirely, and makes QA test "exactly what the operator clicks."
- If a local dev server is still wanted, **serialize**: gate qa-execute on the dev-deploy
  job being COMPLETED (or run QA against a **per-run isolated checkout**, never
  `projects/<appId>`).
- Replace the freeform Edit/Write config-rewrite with the declarative
  `BoilerplateRuntimeContract.build.requiredConfig` (see `boilerplate-runtime-contract.md`)
  so deploy never improvises edits on a watched tree.

**Effort:** M. **Track:** F. **Status:** proposed. **Severity note:** P0 — a false BLOCKING
verdict on correct code; the UI "Send all failing back (6)" would re-run 6 dev stories on
working code → cost runaway.

### F12 — QA scores broken/missing evidence as blocking defects (P1)

> Contributed by **QAreview-agentic** (2026-06-18).

**Evidence.** Three coupled defects on `pacman3` (QA job `3c99fd51`):

- **(a) Capture failure isn't a gate.** `PREPARE_OUTPUT: SCREENSHOTS_CAPTURED 0/10` — zero
  per-test screenshots (only `overview.png` survived). The pipeline judged anyway. The 5
  per-test PNGs that did upload are **byte-identical** (`md5 1d931e7f…` = the same 404
  page); the rest are absent (plain capture `npx playwright screenshot` has a 20 s spawn
  timeout < the 25 s restarting server → SIGKILL → no file). Capture:
  `visual-qa-pipeline.ts` (per-test loop `:518-662`, `SCREENSHOTS_CAPTURED` `:656`, upload
  `:669-676`).
- **(b) Missing/404 frames become blocking FAILs.** `qa-report` computes
  `overall = fail>0 ? 'FAIL'` (`visual-qa-pipeline.ts:955`). All 6 FAILs have rationales
  like "Screenshot file not found" or "404 error page displayed instead of game canvas" —
  **infra artifacts scored as product defects** → BLOCKING. A missing/404/blank/sub-2KB
  frame can never be a product verdict.
- **(c) Judge hallucination on absent frames.** Under the identical "no usable frame"
  condition, judges split — 3 honest `UNCERTAIN` ("Screenshot file not found"); ≥1 `FAIL`
  with **fabricated** detail ("cannot verify direction value… VERDICT: FAIL") about a frame
  it never read. Prompts ask for UNCERTAIN on missing images (`visual-qa-pipeline.ts:786`,
  `:886`) but the model doesn't reliably comply. UI compounds it: `claims-table.tsx:296`
  hides any 404/broken thumbnail via `<img onError>` → operator sees empty "·" cells, no
  evidence.

**Root cause.** No **evidence-integrity precondition** and no **error/infra verdict lane**
distinct from `fail`. The verdict math treats "harness failed to produce evidence"
identically to "the app is wrong," and the judge is trusted to self-report missing
evidence.

**Proposed fix.**

- **Evidence gate before judging:** after qa-prepare, abort+retry when
  `SCREENSHOTS_CAPTURED < threshold` (~90%) or frames are blank/identical (size+hash) —
  _before_ any judge spends a token (§7 Q6).
- **Honest verdict lane:** missing/404/blank/sub-2KB frame → `errored` (retry/operator
  card), never `fail`; `overall=FAIL` only on genuine `fail`.
- **Don't trust the judge for existence:** check file existence + min size in code before
  invoking the judge; only judge real frames.

**Effort:** S–M. **Track:** F. **Status:** proposed.

### F13 — `state`/`behavior` ACs authored with no executable probe (P1, decoupled authoring)

> Contributed by **QAreview-agentic** (2026-06-18). Authoring-side root; complements F8 (execution-side).

**Evidence.** The two L2 tests on `pacman3` describe **internal entity state** —
`AC-S2-2 "position.col has increased from spawn column"`, `AC-S2-3 "direction changes to
UP"` — yet were authored with `url=null, flow=null` and **no `assert`** (verified on the
epic-workflow rows; `CLASSIFIED_TESTS` shows level set, mechanism empty). No screenshot can
show these, and no `window.__harness` assert was emitted to read them → unverifiable even
with perfect capture. The seam/assert executor **already exists** (`visual-qa-pipeline.ts`
runFlow `assert` → `page.evaluate(window.__harness)`, `:616-626`); the tests don't use it.
Separately the classifier **overrode its own better call**: `AC-S1-1` has
`resolvedLevel:"L0"` but kept `level:"L1"` ("level set in source — preserved");
`L0_RESULTS:[]` — a deterministic check ran as a probabilistic vision judge.

**Root cause.** Authoring sets the _level_ (and prose) but does **not author the executable
mechanism** (flow/assert/seam read) for state/behavior ACs — the "decoupled authoring" the
VQA v3 redesign targets. Shared root of the §3.7 wave-gate `unverifiable` rate (~43%) and
the final-QA uncertain/false-FAIL.

**Proposed fix.**

- **No `verify:state|behavior` AC may merge without an executable flow/assert** (gate in
  test-authoring). Land the QA-AUTHOR + `__harness` seam from the VQA v3 PRD
  (`docs/concepts/pipeline-v3/`).
- **Honor the classifier's `resolvedLevel`** (cheapest-correct oracle); stop preserving a
  worse source level.

**Effort:** M–L. **Track:** F (ties to F8 + VQA v3). **Status:** proposed.

### F14 — Truncated AST facts: the persisted graph is the last story's worktree, not the project (P1, knowledge-graph completeness)

> Contributed by **graphify** (2026-06-18). Root cause of the broken pacman3 knowledge graph.

**Evidence.** On pacman3 the persisted `/home/ubuntu/projects/pacman3/.mycelium/ast-facts.json`
held **`fileCount: 3`** with `root` = the **last** story's detached worktree
(`…/pacman3-initial/a085aa07…`, the HUD/Overlay visual-fix story) — while the integrated
project has **51** source files. The published snapshot was **177 nodes / 290 edges with 29
unconnected nodes and `Orphan invariant: FAIL (20)`**: every function in a file finalized in
an _earlier_ story had no `file→function DEFINES` edge because the partial facts never
re-asserted it. A full-project rebuild —
`bootstrap-ast --project pacman3 --root /home/ubuntu/projects/pacman3` — re-scanned **51
files / 120 functions** and the orphan count dropped from 20 → 6 immediately.

**Root cause.** Per-story DEV compiles incrementally against a **detached worktree**;
`bootstrap-ast.mjs` runs `ast-extract --scan` over `args.root`
(`daemon/scripts/bootstrap-ast.mjs:301-305`) and persists _that_ scan as the project's
ast-facts (`:297`, `:328`), so whichever worktree compiled last wins. `processAstFacts`
(`daemon/scripts/graph-sync.mjs:686`) is additive, so a later **full** resync against the
partial facts can only re-assert the 3 files it sees — it can't recover the other 48, and a
naive `--full-resync` against a partial file would _prune_ them.

**Proposed fix.** At **wave-close / plan-close**, regenerate ast-facts from the **integrated
project tree** (`projects/<id>`), not the per-story worktree — i.e. one authoritative
full-repo `bootstrap-ast` after merges land, before the snapshot is published. Alternatively
gate `graph-sync` to refuse to _narrow_ a project's file set from a scan whose `root` is a
worktree. (Manual full rebuilds fixed pacman3 + brick1 this session; the **pipeline mechanism
is unchanged**.)

**Effort:** M. **Track:** G. **Status:** proposed.

### F15 — Additive ingest never prunes deleted-source nodes → zombie orphans (P2)

> Contributed by **graphify** (2026-06-18).

**Evidence.** pacman3's last story consolidated three `src/features/pacman-*.feature.tsx`
files into one and **deleted them from disk** (AC-S4-5), and a decision article was renamed.
Their graph nodes survived: **5 degree-0 function zombies** + 1 dead decision node, all
flagged as orphans/"removal candidates". The MERGE ingest never removes a node whose source
file no longer exists.

**Root cause.** `processAstFacts` (`graph-sync.mjs:686`) and the wiki upsert are purely
**additive** — articles get `status:'pruned'` on delete, but **code function/file nodes for
deleted sources are never pruned**.

**Proposed fix.** A **delete-aware prune** pass, gated to a _known-complete_ scan (so it
never fires on a partial worktree scan — see F14): delete code `function`/`file` nodes whose
defining path is absent from the full scan and which carry no live article. Distinguish from
legitimately-edgeless nodes (test files) before flagging.

**Effort:** S–M. **Track:** G. **Status:** proposed. **Depends on:** F14 (needs a trustworthy full scan).

### F16 — Orphan invariant is computed but swallowed (`exit 3`, non-blocking) (P2, observability)

> Contributed by **graphify** (2026-06-18). The cheapest win in this track.

**Evidence.** `graph-sync` **already computes and logs** the failure:
`ERROR: Orphan invariant FAILED — N non-file orphan(s) (extractor dropped an edge)`
(`daemon/scripts/graph-sync.mjs:1049`; logic in
`daemon/scripts/lib/graph-integrity.mjs:112`) and exits non-zero — but every caller treats
it as advisory: `bootstrap-ast.mjs:371` logs `graph-sync exited 3 (non-blocking)` and moves
on, and the per-story daemon sync does the same. So a 20-orphan FAIL was **invisible** to the
operator until someone inspected the graph by hand.

**Root cause.** The integrity gate is wired as a log line, not a signal anything consumes.

**Proposed fix.** Surface the invariant result: a wave-gate/UI badge (orphan count +
delta-vs-last-wave) and, behind a threshold, an operator attention card. Optionally fail the
knowledge-compile step when genuine code-orphans exceed a cut — **after** subtracting
legitimate floaters (test files, deleted-source zombies per F15) so it doesn't false-alarm.

**Effort:** S. **Track:** G. **Status:** proposed.

### F17 — `projectId` partition drift: nodes stamped with a job/plan UUID → silent edge loss (P1) — SHIPPED

> Contributed by **graphify** (2026-06-18). **Fixed this session — commit `0d5dd6a`.**

**Evidence.** The file node `code/src--types--index.test.ts` carried
`projectId = "353ab84c-8660-…"` (a **job/plan UUID**) while its function node carried
`projectId = "pacman3"`. The `DEFINES` MATCH filters the file node on `projectId`
(`graph-sync.mjs` processAstFacts), so the file was stranded in a phantom partition, the
MATCH missed, and the function orphaned **permanently** — and the file node wasn't even in
the project's snapshot (the snapshot query requires both endpoints in the same `projectId`).
A Memgraph scan showed a **long UUID tail across many projects** (dino, snake, …), not just
pacman3.

**Root cause.** Early ingestion stamped the job/plan UUID as `projectId`; the old
`ON MATCH SET n.projectId = coalesce(n.projectId, $projectId)` MERGE **preserved** the bad
stamp on every resync.

**Fix (shipped).** `code/*` nodeIds are project-unique (verified: **zero cross-project
collisions**), and `processAstFacts` iterates _this_ project's own scanned files, so the
file-node MERGE now **overwrites** `projectId` to the canonical slug
(`daemon/scripts/graph-sync.mjs:745`) — self-healing on every project's next sync. Verified:
pacman3 orphans 6 → 0, `chain`'s file node `353ab84c…` → `pacman3`.

**Effort:** S. **Track:** G. **Status:** **shipped** (`0d5dd6a`); → `verified` once other
projects re-sync.

### F18 — Living docs float: no doc→code edge for inline references (P2, grounding/handoff) — SHIPPED

> Contributed by **graphify** (2026-06-18). **Fixed this session — commit `0445e6a`.**

**Evidence.** pacman3 had **9 unconnected knowledge docs** (`decisions/*`, `index`, `log`,
`system/dependency-map`) **even though they contained `[[wikilinks]]` to real code nodes**
(e.g. `ghost-pathfinding-greedy.md` → `[[code/src--game--ai--ghostAI.ts]]`). The wikilink→edge
extractor only emitted an edge when the link sat under a _mapped_ section header (`##
Dependencies` …); links in prose (`## Implementation`) or under an H1 (`# Code Articles`) were
silently dropped.

**Root cause.** Section-gated wikilink extraction with no generic reference edge for
"living" documents that _describe_ code without a structured dependency section.

**Fix (shipped).** New `REFERENCES` edge layer (`daemon/scripts/lib/doc-references.mjs`, wired
in `graph-sync.mjs`): for **living docs only**, any `[[link]]` not claimed by a structured
section becomes a `REFERENCES` edge — **controlled by construction** (the MERGE binds only
when _both_ nodes exist, so a doc connects only when it actually references a real node; no
phantom/`(suggested)` edges). **Plan-run docs** (a plan's PRD/epics/stories) are **excluded**
via `isLivingDoc` (type denylist + plan markers + path) — their linking is owner-defined
later (bears on §2 concept→plan authoring). Verified: 9 floaters → 0, +82 `REFERENCES`,
`index` became a 29-edge hub. 10 unit tests.

> **Grounding bonus:** these doc→code edges make the rubric's §2 grounding criteria
> (`C-D3` handoff, `C-P1` "plans from the specs") **machine-checkable** — a PRD/arch doc that
> grounds real code now leaves `REFERENCES`/`DEPENDS_ON` edges to it (once plan-doc linking
> is designed, per the exclusion above).

**Effort:** M. **Track:** G. **Status:** **shipped** (`0445e6a`).

---

## 4. Workstreams

| Track | Theme                                           | Findings                 | Owner        | Status                            |
| ----- | ----------------------------------------------- | ------------------------ | ------------ | --------------------------------- |
| **A** | Perf / token reduction                          | F1, F6, F7, F8(part), F9 | _unclaimed_  | proposed                          |
| **B** | Correctness / observability                     | F2, F3, F4               | _unclaimed_  | proposed                          |
| **C** | Learning loop                                   | F5, F8(part)             | _unclaimed_  | proposed                          |
| **D** | Planning / parallelism                          | F10                      | _unclaimed_  | proposed                          |
| **E** | Context management (design)                     | see §5                   | _unclaimed_  | proposed                          |
| **F** | QA evidence integrity & stage isolation         | F11, F12, F13            | _unclaimed_  | proposed                          |
| **G** | Knowledge-graph integrity & grounding substrate | F14, F15, F16, F17, F18  | **graphify** | F17/F18 shipped; F14–F16 proposed |

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
4. **F11 stop the deploy×QA race** — QA against the dev-deploy URL (or serialize). Stops
   QA false-blocking correct apps; biggest correctness leak in the QA stage. _(QAreview-agentic)_
5. **F12 evidence gate + honest verdict lane** — never block on missing/404 frames; small
   guard, prevents the false-FAIL cascade. _(QAreview-agentic)_
6. **F16 surface the orphan invariant** — the FAIL signal already exists and is swallowed
   (`exit 3`); wiring it to a badge/gate is the cheapest knowledge-graph win. _(graphify)_

> **Already shipped this session (graphify):** **F17** (`projectId` normalization — heals
> UUID-stranded orphans across all projects, `0d5dd6a`) and **F18** (`REFERENCES` living-doc
> linking, `0445e6a`). They need no roadmap slot — just `verified` once projects re-sync.

**Phase 2 — Restore observability & correctness:** 4. **F2 priorJobIds history** → **F3 forensic union + cost reconciliation**. 5. **F4 totalStories count + fix-story lineage badge.** 6. **F14 full-project ast-facts at wave-close** — the root of the broken-graph class; without it orphans recur every multi-story run. _(graphify)_

**Phase 3 — Deeper efficiency:** 6. **F7 mvp test-authoring trim**, **F8 fixer gating + prior-diff**, **F9 catalog trim**, **F13 probe-authoring gate (with F8 + VQA v3)**, **F15 delete-aware graph prune (needs F14)** _(graphify)_. 7. **F10 planner parallelism**, **§5 context-management redesign.**

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
- **Q6 (F12) [QAreview-agentic]:** Should the evidence-integrity check be a hard
  **precondition gate** that aborts + retries the QA run on degraded capture (0/N,
  identical/blank frames) _before_ any judge spends a token — vs. a post-hoc score? (A 0/10
  capture should never reach the judges.)
- **Q7 (F11) [QAreview-agentic]:** Where to enforce **stage isolation**? Strongest:
  QA against the already-published **dev-deploy URL** (immutable) — which is the deploy's
  stated purpose. Alternatives: serialize qa-execute after deploy COMPLETED, per-run
  isolated checkout, or a `workingDir` mutex. (Overlaps `boilerplate-runtime-contract.md`
  and `multi-host-dispatch-readiness.md`.)
- **Q8 (F14) [graphify]:** Where should the **authoritative full-project ast-facts** be
  built — a dedicated wave-close/plan-close `bootstrap-ast` over the integrated `projects/<id>`
  tree, or should `graph-sync` simply **refuse to narrow** a project's file set from a scan
  whose `root` is a per-story worktree (treat a worktree scan as additive-only, never
  authoritative)? The second is cheaper but leaves the snapshot stale until a full run.
- **Q9 (F16) [graphify]:** Should the orphan invariant **gate** the wave or just **surface**?
  Genuine code-orphans (a real dropped DEFINES) should block; legitimate floaters (test
  files with no inbound edge, deleted-source zombies pending F15, decision docs awaiting
  plan-doc linking) must not. Needs an agreed "genuine orphan" definition before it can gate
  — otherwise it false-alarms. (The graph snapshot already distinguishes these in the UI's
  "Unconnected / Dead code" split — reuse that classification.)
- **Q10 (F18) [graphify]:** When plan-run docs (PRD/epics/stories) eventually enter the
  graph, what is their linking scheme? They're **deliberately excluded** from auto-`REFERENCES`
  now (`isLivingDoc`). Owner-defined — overlaps the §2 concept→plan authoring contract and the
  VQA v3 PRD; resolving it makes `C-D3`/`C-P1` grounding machine-checkable (see F18 note).

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

| Concern                                      | File:line                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-story pipeline                           | `functions/shared/pipelines/story-pipeline.ts`                                                                                                                                                          |
| Story context pack                           | `daemon/pipelines/lib/story-context-pack.mjs`                                                                                                                                                           |
| Cached tsc (exists, prework-only)            | `daemon/lib/cached-tsc.mjs`                                                                                                                                                                             |
| Prework gate                                 | `daemon/lib/prework-gate.mjs`                                                                                                                                                                           |
| Wave VQA runner                              | `daemon/lib/wave-vqa-runner.mjs`                                                                                                                                                                        |
| Wave merge                                   | `daemon/lib/wave-merge.mjs`                                                                                                                                                                             |
| VQA fix-story mint (title)                   | `daemon/lib/wave-vqa-fix-story.mjs:53`                                                                                                                                                                  |
| Retry / story rerun (jobId overwrite)        | `functions/shared/services/story-rerun-launcher.ts:140`                                                                                                                                                 |
| Forensic builder (event collection)          | `functions/shared/timer/forensic-builder.ts:277`                                                                                                                                                        |
| Forensic endpoint                            | `functions/api/index.ts:12125` (`GET /plans/:id/timing/forensic`)                                                                                                                                       |
| Agent events repo (7-day TTL)                | `functions/shared/repositories/agent-events-repository.ts`                                                                                                                                              |
| Reflector runner                             | `daemon/pipelines/reflector-runner.mjs`                                                                                                                                                                 |
| UI live output / events                      | `src/components/labs/agentic-workflow/story-live-output.tsx`, `src/hooks/use-agent-events.ts`                                                                                                           |
| QA auto-approve + dev-deploy co-launch (F11) | `functions/cron/wave-completion-check.ts:210` (qa-execute), `:273-283` (dev-deploy), `:259-260` (intent comment)                                                                                        |
| Deploy config rewrite (F11)                  | `functions/shared/deploy/build-deploy-pipeline.ts:47` (Edit/Write tools), `:66` (next.config basePath/output rewrite)                                                                                   |
| QA execute pipeline / capture / report (F12) | `functions/shared/pipelines/visual-qa-pipeline.ts:454` (qa-prepare boot), `:518-662` (per-test capture), `:656` (SCREENSHOTS_CAPTURED), `:955` (`overall = fail>0`)                                     |
| QA judge prompts (F12c)                      | `functions/shared/pipelines/visual-qa-pipeline.ts:786` (L1), `:886` (L2)                                                                                                                                |
| Seam/assert executor (F13, exists)           | `functions/shared/pipelines/visual-qa-pipeline.ts:616-626` (`assert` → `page.evaluate(window.__harness)`)                                                                                               |
| Claims-table thumbnail (F12 UI)              | `src/components/labs/plan-dashboard/views/qa/claims-table.tsx:296` (`<img onError>` hides broken/404)                                                                                                   |
| AST scan + ast-facts persist (F14)           | `daemon/scripts/bootstrap-ast.mjs:301-305` (`ast-extract --scan` over `args.root`), `:297`/`:328` (writes `<root>/.mycelium/ast-facts.json`)                                                            |
| AST → graph translation, additive (F14/F15)  | `daemon/scripts/graph-sync.mjs:686` (`processAstFacts`)                                                                                                                                                 |
| Orphan invariant emit + swallow (F16)        | `daemon/scripts/graph-sync.mjs:1049` (`Orphan invariant FAILED`), `daemon/scripts/lib/graph-integrity.mjs:112` (logic); swallowed at `daemon/scripts/bootstrap-ast.mjs:371` (`exited 3 (non-blocking)`) |
| projectId normalization (F17, shipped)       | `daemon/scripts/graph-sync.mjs:745` (file-node MERGE `ON MATCH SET n.projectId = $projectId` — commit `0d5dd6a`)                                                                                        |
| Living-doc REFERENCES layer (F18, shipped)   | `daemon/scripts/lib/doc-references.mjs` (`isLivingDoc`, `extractWikilinks({inlineRefs})`), wired in `daemon/scripts/graph-sync.mjs` — commit `0445e6a`                                                  |

---

## Changelog

| Date       | Agent                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1) | Initial draft: findings F1–F10, workstreams A–E, roadmap, appendices from pacman3 forensic + daemon-log cross-check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-06-18 | QAreview-agentic      | QA-stage forensic on the same pacman3 run (QA job `3c99fd51`, not walked by the original forensic — F2/F3). Added F11 (deploy×QA same-worktree race → `next.config.ts` rewrite relocates app off root → per-test 404s), F12 (broken/missing evidence scored as blocking defects; capture gate + honest verdict lane + judge hallucination), F13 (state/behavior ACs authored with no executable probe). New Track F; F11/F12 → Phase 1, F13 → Phase 3; open Q6/Q7; Appendix B refs. Verdict: QA false-blocked a correct app — every FAIL was an infra artifact.                                                                                                                                                                                                                                    |
| 2026-06-18 | graphify              | Knowledge-graph (knowledge-compile output) forensic on the same pacman3 run — broken graph on correct code (177/290, 29 unconnected, Orphan invariant FAIL 20). Added new **Track G** + F14 (truncated ast-facts = last story's worktree scope, not the project), F15 (additive ingest never prunes deleted-source zombies), F16 (orphan invariant computed but swallowed at `exit 3`), F17 (job-UUID `projectId` strands file nodes → silent DEFINES loss — **shipped `0d5dd6a`**), F18 (living docs float; new `REFERENCES` doc→code edge layer for living docs, plan-docs excluded — **shipped `0445e6a`**). F16 → Phase 1, F14 → Phase 2, F15 → Phase 3; open Q8/Q9/Q10; Appendix B refs. After fixes: pacman3 graph 212/526, 0 orphans. Same lesson as F11/F12 — clean agents, leaky harness. |
