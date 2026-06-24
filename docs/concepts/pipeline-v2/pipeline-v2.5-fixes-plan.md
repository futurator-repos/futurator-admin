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

> **[deployment · 2026-06-18] Fourth stage, same shape — the deployment control panel.**
> Designing + shipping the v2.5 promotion ladder (dev → staging → production,
> build-once-promote-many) surfaced the _clean-agent / leaky-harness_ pattern in the **deploy
> stage**: the agent built correct apps (brick1 went live, playable), but the harness
> (a) **truncated the published dev/staging URLs** at the `_` in `_dev`/`_staging` so "Open in
> dev" was a dead link (F19); (b) ran **Vite-only deploy prompts against Next.js apps** so the
> agent had to improvise the config (F20); (c) left **dev/staging deploys unobservable** — no
> streamed logs (F21); and (d) **blocked every agent spawn** when the Mycelium MCP config file
> went missing (F23). New **Track H** (F19–F23). **Fixed this session** (`1755365`, live
> `c937de7`): F19/F20/F21 + the dual-prod-path reconcile. **Open:** **F22** (provision the
> dev/staging subdomains — today fallback prefixes force a _rebuild_ per rung, so "build-once"
> isn't real) and **F23** (MCP-config self-heal — cross-cutting; it halts the _whole_ pipeline,
> cheapest high-leverage fix). Also confirmed the **deploy side of F11** (deploy still rewrites
> QA's `next.config.ts` even after the F20 fix) — see F11 agent notes. (NB: the deployment
> rubric forward-referenced F22/F23 as "F14/F15" before cross-checking this registry; the
> canonical IDs here are **F22/F23**.)

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

#### Agent notes — skills (2026-06-18, Claude)

**Extends F5, and partly de-risks it.** The "advisory-only, nothing auto-acts" half of this
finding is now **closed in code** by the Skills-Institution branch (unshipped): the apply
consumer that was missing has been built — `daemon/pipelines/reflector-apply.mjs:209-213`
authors a **new app-evolved skill** from a confirmed `project-skill/create` reflection's
`content` (Gate-1-scanned before commit), and `daemon/lib/reflection-apply-poller.mjs:41`
(`runReflectionApplyTick`) is the daemon poller that actually consumes `confirmed`
reflections (wired in `agent-daemon.mjs`, gated by `agent.paused`). **However the loop is
still blocked upstream by F5's two root causes:** (1) the **IAM write failure** means
`written=0` — no reflection row is ever stored, so the new poller has nothing to consume;
(2) at **`mvp` rigor story-scope reflection doesn't fire** (production-only), so pacman3
only got plan/wave-scope proposals. **Net: fix F5's IAM grant first — only then does the
now-built E1 loop close end-to-end.** See Track I (F24) for using a "relevant-skill-
available but zero-activation" event as an additional reflector trigger.

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

### Agent notes — deployment (2026-06-18)

**Confirmed the deploy side from building the v2.5 ladder, and `F20` does NOT close this.**
My framework-aware deploy prompt (F20) made the `next.config.ts` patch _correct_, but the
DEPLOY agent **still `Edit`s a tracked config in the shared `projects/<appId>` worktree** —
so the mid-run rewrite that 404'd QA is unchanged. The clean fix is F11 bullet #3 generalized:
**inject the base path via env (`NEXT_BASE_PATH` / Vite `--base`) or build in an isolated dir
— never edit a tracked config in the shared tree** (this also retires F20's improvisation).
F11 fix #1 (point QA at the dev-deploy URL) is now _easier_: the v2.5 deploy makes the dev
deploy a first-class, observable, immutable artifact with its own `deployEnvironment` routing
(F21), so QA can target the published preview instead of booting `next dev` in the worktree.
**Recommend Q7 resolve to "QA against the dev-deploy URL."** (Bears on F22 — once the
dev/staging subdomains exist, that URL is per-env and stable.)

> **Update (2026-06-19, deployment):** **F29** makes that URL concrete — `dev.futurator.ai/<plan>`,
> plan-scoped and immutable (the merged plan QA reviews). When F29 lands, QA can switch from
> booting `next dev` in the shared worktree to verifying that URL, closing Q-C9/Q7 at the root.

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

### F19 — DEPLOY*URL extractor truncates dev/staging URLs at `*` (P1) — SHIPPED

> Contributed by **deployment** (2026-06-18). **Fixed this session — commit `1755365`** (live `c937de7`).

**Evidence.** The DEPLOY/PROMOTE agent emits a machine-parsed `DEPLOY_URL: <url>` line that
the daemon extracts via regex. The URL capture class **excluded `_`**, so the v2.5 fallback
targets `…/apps/_dev/<slug>/` and `…/apps/_staging/<slug>/` were captured only up to the
underscore → `plan.devUrl` / `stagingUrl` stored as **`"https://futurator.ai/apps/"`** — a
dead link (the operator's "Open in dev" landed on the bare apps index). Production
(`apps/<slug>/`, no `_`) was unaffected, which masked the bug until the ladder added
underscore-prefixed environments. (Root of rubric **DP-U1 / IE20**; this is §12's "secondary"
`devUrl = …/apps/` observation, now root-caused.)

**Root cause.** The extractor's URL character class excluded `_` (a leftover from
trailing-markdown stripping), in **both** `build-deploy-pipeline.ts` and
`build-promote-pipeline.ts`.

**Fix (shipped).** Allow `_` in the capture class (drop `_` from the excluded set; keep
stripping trailing `*`/backtick). Added a regex unit test asserting `_dev`/`_staging`/prod
and markdown-decorated URLs all extract fully.

**Effort:** S. **Track:** H. **Status:** **shipped** (`1755365`); → `verified` on the next
dev/staging deploy of a real plan.

### F20 — Deploy/promote prompts are framework-blind (Vite-only) → agent improvises Next config (P2) — SHIPPED

> Contributed by **deployment** (2026-06-18). **Fixed this session — commit `1755365`.**

**Evidence.** The deploy/promote prompts hard-coded Vite (`vite.config.ts`, `base`, `dist/`),
but the apps are Next.js static exports (`next.config.ts`, `basePath`, `output:'export'`,
`out/`). On brick1/pacman3 the agent **improvised** the correct Next config (a smart agent
compensating for a blind prompt) — fragile, and a source of the deploy-side config churn that
feeds **F11** (the `next.config.ts` rewrite that 404'd QA).

**Root cause.** Prompt assumed one framework's config shape and output dir.

**Fix (shipped).** Framework-aware prompt: detect `next.config.*` → Next (`basePath` _no_
trailing slash + `output:'export'` + `images.unoptimized` + `out/`) vs `vite.config.*` → Vite
(`base` _with_ slash + `dist/`), else inspect `package.json`. Applied to the deploy builder and
the promote-rebuild branch.

**Important limitation.** This makes the patch _correct_ but it **still `Edit`s a tracked
config in the shared worktree** — it does **not** close the F11 race (see F11 agent notes).
The root fix is to inject the base via env / isolated build dir (Q11).

**Effort:** S. **Track:** H. **Status:** **shipped** (`1755365`).

### F21 — Non-prod deploys unobservable + smoke result unsurfaced (P2) — SHIPPED

> Contributed by **deployment** (2026-06-18). **Fixed this session — commit `1755365`.**

**Evidence.** dev/staging deploys streamed **no logs and showed no step tracker** — the Deploy
stage's `deploy-logs`/`deploy-steps` bound only to `report.current` (production `deployJobIds`),
so a dev/staging deploy was a black box (the operator couldn't watch or share the very thing
they were debugging). Separately, the promote pipeline's smoke check (`curl`+parse →
`SMOKE_STATUS`) was computed but **never displayed** anywhere.

**Root cause.** The deploy report exposed only the production job as "current"; per-environment
job status + smoke result weren't carried in the report.

**Fix (shipped).** `deploy-report.environments[]` now carries per-rung `activeJobId` +
`smokeStatus`; the Deploy stage **and** the QA stage stream the active environment's job; the
ladder renders a smoke badge and the prod-promote confirm **soft-warns** on a failed staging
smoke. (This is the streaming the operator used to capture the F23 MCP error live.) Covers
rubric **DP-O1 / DP-S2 / IE24**.

**Effort:** M. **Track:** H. **Status:** **shipped** (`1755365`).

### F22 — Build-once is not real: dev/staging unprovisioned → promotion rebuilds per rung (P2)

> Contributed by **deployment** (2026-06-18). Rubric **DP-L2 / DP-E1 / IE22**. (The rubric
> forward-referenced this as "F14" before cross-checking this registry — **canonical ID F22**.)

**Evidence.** `deploy-targets.ts` resolves dev/staging to **reserved prefixes on the shared
public bucket** (`apps/_dev/<slug>/`, `apps/_staging/<slug>/`) because the
`dev.`/`staging.futurator.ai` subdomains aren't provisioned. Each environment therefore has a
**different base path**, so a promotion **rebuilds** at the destination instead of copying the
tested bytes. "Build-once-promote-many" exists in code (copy mode when `src.basePath ===
dst.basePath`) but **never activates** in fallback mode → the artifact the operator approved on
dev is _not_ the artifact that reaches prod (the exact failure class the ladder was meant to
prevent). Separately, the release-strip used to offer a **second** production path — a fresh
build that bypassed staging entirely (a build-once violation).

**Root cause.** No per-environment bucket+domain; in fallback the base path differs per env, so
byte-copy promotion is impossible. The subdomains are deferred infra (SST recipe + EC2-IAM
prereq already written in [`deployment-v2.5.md §14`](../deployment-v2.5.md)).

**Proposed fix.**

- **[shipped `1755365`]** Collapse the dual production path: the release-strip primary CTA
  **advances the ladder** (byte-copy when provisioned); the staging-bypassing fresh build is
  demoted to a warning-gated "Force rebuild to prod" escape hatch — never the primary action.
- **[open]** Provision `dev.`/`staging.futurator.ai` (own Bucket + CloudFront + ACM + Route53,
  per `deployment-v2.5.md §14`) **and** grant the EC2 instance role write to the two new
  buckets. Then every env shares base `apps/<slug>/`, `deploy-targets` flips `provisioned:true`,
  and promotion becomes a true `s3 sync` **byte-copy** (no rebuild) — closing IE22/DP-L2/DP-E1.

**Effort:** M (infra, mostly SST + IAM; code seam already in place). **Track:** H.
**Status:** partial — dual-path reconcile **shipped**; subdomain provisioning **proposed**.

### F23 — Agent-spawn precondition fragility: a missing MCP config halts every spawn (P1, cross-cutting)

> Contributed by **deployment** (2026-06-18). Rubric **OV11 / IE23**. Surfaced on a deploy job
> but **not deploy-specific** — it's the graph agent's Mycelium feature. (Rubric forward-ref
> "F15" — **canonical ID F23**.)

**Evidence.** pacman3 re-deploy-dev died _before the agent ran_:
`step_error … Invalid MCP configuration: MCP config file not found:
/opt/futurator-daemon/mcp/mcp-config.generated.json` (exit 1, retry 1/3). The Mycelium MCP
integration injects `--mcp-config <path>` into **every** Claude CLI spawn when `MYCELIUM_MCP=on`
(`daemon/agent-daemon.mjs:872`). `ensureConfig()` writes the file once behind a module-level
`configWritten` latch (`daemon/lib/mcp-config.mjs:37-52`, path at `:23`) with **no `existsSync`
re-check and no `mkdirSync`**. A daemon redeploy (DeployerLambda `git clean`/sync) deletes the
untracked generated file; if the latched process keeps running it passes `--mcp-config` to a
file that no longer exists → the CLI aborts. **This blocks all agent jobs (QA, dev, fix,
deploy), not just deploy** — it merely surfaced first on a deploy.

**Root cause.** A generated, untracked spawn prerequisite cached behind a write-once latch with
no existence guard, deleted out from under the process by a redeploy.

**Proposed fix.** Self-heal `ensureConfig()`:
`if (configWritten && existsSync(CONFIG_PATH)) return; mkdirSync(dirname(CONFIG_PATH), {recursive:true}); writeFileSync(...)`.
**Immediate unblock (no deploy):** daemon **Restart** (resets the latch → next spawn
regenerates the file) or set `MYCELIUM_MCP=off`. **Owner:** the graph/`graphify` agent (it's
their `mcp-config.mjs`, commit `ceea33e`).

**Effort:** S (two lines). **Track:** H (cross-cuts every stage). **Status:** proposed.
**Severity:** P1 — presents as a **full pipeline stall** until daemon restart (fails fast, no
corruption / no cost runaway, self-heals on restart — hence P1 not P0).

### F24 — Skill activation collapse: agents ignore the loadout (P1, dominant under-utilization)

**Evidence (pacman3 forensic `skills` block).** `hasSkillTool: true`,
`sessionsReportingZeroSkills: 0`, `availableSkillCount: 66` — loading works. But
`totalSkillToolUseEvents: 4` across `sessionsReportingAvailability: 77` = **5.2% of
sessions ever invoke a skill**, and `activatedSkills` = **one** distinct skill
(`frontend-design @ anthropic-official`, ×2, both `dev`/`compile` early in the run) =
**1.5% of the 66 available skills used**. For a Canvas2D game (ghost AI, collision,
game-loop, scoring), no game-domain skill activated. The skill **infrastructure** is
healthy; **utilization** has collapsed.

**Root cause.** This is a behavioral/prompting problem, not a loading or curation one. The
loadout is offered as a flat name+description block
(`daemon/lib/skills-prompt.mjs:140-155`) with generic, utterance-shaped descriptions; the
agent is never _pushed_ a relevant skill body for the story it's on. The earlier
manifest-rationale fix (task-shaped descriptions) helped surface intent but activation is
still ~nil. **None of the Skills-Institution work (gate / trust / inbox / authoring)
touches activation** — a perfectly-curated, `trusted`, game-relevant skill still dies here.

**Proposed fix (best decision: make skill use _push_, not _pull_).**

- **Per-story relevance injection.** At dev/test/api-author spawn, rank the trusted
  loadout by cosine of the **story text** vs `index.embeddings.json` (see F27 — the
  sidecar is written but never read) and inject the **top-3 skill _bodies_** (not just
  names) into that agent's system prompt for that story. A body in-context is invoked far
  more than a name in a list.
- **Activation as a learning signal.** Emit a reflector signal when a story had a
  high-relevance trusted skill available but `skill_activated == 0` — this is exactly the
  "non-obvious happened" trigger the reflector wants, and it feeds the E1 loop (F5).
- **Measure it.** Promote `activationRate` (tool-uses / sessions) to a first-class forensic
  KPI with a cohort baseline, so this regression is visible per plan.

**Effort:** M (prompt injection + ranking) + S (forensic KPI). **Track:** I. **Status:** proposed.

### F25 — Scout dormancy: zero plan-tailored skill discovery (P1)

**Evidence.** `skills.skillScoutRuns: []` — the scout **never fired during the entire
14-story plan**. The loadout was frozen at whatever app-bootstrap installed; it was never
refreshed for the game's actual needs. The plan `intent` literally reads _"Create a pacman
game, with different ghost types … eat all the dots …"_ — a strong domain signal that
produced **no** skill search.

**Root cause.** The scout is wired (`daemon/agent-daemon.mjs:187` `runSkillScoutJob`;
spawned at `daemon/pipelines/app-bootstrap.mjs:419,459`), but its in-plan triggers are
**mechanical only** — T4/T5 new-dependency (`daemon/lib/skill-scout-triggers.mjs:38`
`detectNewDependencies`, `:71` debouncer) and T6 reviewer-clusters (`:110`
`detectReviewerClusters`). A Canvas2D scaffold adds **no new deps** (kills T4/T5) and
reviewer rejections didn't cluster (kills T6), so nothing fired. **There is no
intent-aware trigger** — plan _meaning_ never drives discovery.

**Proposed fix.** Add a **T-intent trigger** at plan-build: derive a domain query from the
plan `intent` + concept artifacts (PRD/UX/architecture) and run one scout resolve at plan
start (rigor-gated, mvp+). Route its discoveries through the gate/inbox (F26), not
straight to install. This is the trigger that would have surfaced "canvas-game / sprite /
collision" skills for pacman3.

**Effort:** M. **Track:** I. **Status:** proposed.

### F26 — ⚠️ Trusted-only gate now blocks the scout's community installs; two disconnected trust authorities (P1, pre-deploy reconcile)

**Evidence / regression introduced by Skills-Institution Story 4.2 (not yet deployed).**
The scout's install dispositions both terminate at `applyConfirmedProposals`
(`daemon/pipelines/skill-scout-job-runner.mjs:243` auto-confirm; surface-card → operator
approve → same installer), which calls `runVendorSkills`. Story 4.2 inserted a trusted-only
gate _inside_ vendor (`daemon/lib/app-bootstrap-steps/vendor-skills.mjs:195-200`
`isInstallable`). Effect:

- ✅ Existing on-disk skills + future installs from **auto-trust** sources
  (`anthropic-official`, `futurator-internal`) — unaffected (legacy entries grandfathered,
  gate runs _after_ the on-disk skip).
- ❌ Scout-discovered **community-source** skills — now **blocked at vendor even after the
  operator approves the scout card**. We don't own the community index, and retro-scan
  (`scripts/retro-scan-skills.mjs`) only stamps our canonical repo, so a community entry
  can never become `trustTier: trusted` on that path. The scout-card "approve" and the
  inbox "ratify" are **two disconnected trust gates** — the operator approves and _nothing
  installs_.

Moot for pacman3 (scout was dormant), but a **latent behavior change** that ships the
moment 4.2 deploys.

**Root cause.** The Skills-Institution gate/inbox (`functions/api/index.ts` →
`/api/skills/gate`, `/api/skill-proposals/*`) was built as a parallel path; the **scout was
never wired into it.** Two trust mechanisms (scout autoTrust/operator-card vs the index
`trustTier` facet) coexist without a bridge.

**Proposed fix (best decision: make the gate the single trust authority).**

- The scout's non-auto-trust (`surface-card`) disposition should **emit a skill-proposal
  (`source: bulk`) into the inbox** rather than `applyConfirmedProposals` → vendor.
  Operator ratifies → it publishes into our `trusted` registry → installs from there. This
  is the design the inbox was built for; only the scout→inbox edge is missing.
- Auto-trust internal/anthropic discoveries keep auto-installing (grandfathered) — no
  change to the common case.
- **Sequencing:** do NOT deploy 4.2's vendor gate alone. Either ship the scout→inbox
  bridge in the same release, or ship 4.2 and explicitly document the community path as
  intentionally disabled-pending-bridge. Recommended: ship together — the security win is
  real and the dead window is avoidable.

**Effort:** M (scout→inbox adapter + daemon-side proposal write). **Track:** I.
**Status:** proposed. **Pre-deploy gate for the Skills-Institution branch.**

### F27 — Loadout relevance is unranked; the embeddings sidecar is write-only (P2)

**Evidence.** `index.embeddings.json` is generated (`scripts/ingest-skills.mjs:226`,
Voyage `voyage-3`, 1024-dim) and its header even calls itself _"the retrieval sidecar
SKILL-SCOUT queries"_ (`scripts/ingest-skills.mjs:16`) — but **no reader exists**: grep
finds zero cosine/vector reads in `skills-prompt.mjs`, `federation-resolver.mjs`, or
`skill-scout-runner.mjs`. The loadout is ordered **pins-first, then readdir**
(`daemon/lib/skills-prompt.mjs:140-145`), never by relevance to the current story. (Note:
truncation was _not_ the bottleneck for pacman3 — 66 skills < `MAX_SKILLS = 80`
(`daemon/lib/skills-prompt.mjs:26`) — so every skill was visible and still ignored.)

**Root cause.** The two-stage retrieval from the vision (trust-filter → keyword⊕vector →
rerank) is unbuilt; the embeddings are write-only. Skills-Institution added the
**trust-filter** half (`daemon/lib/skill-trust.mjs` `isInstallable`) and uses cosine in
dedup (`functions/shared/skill-gate/dedup.ts`), but never wired retrieval into _load-time_
ordering.

**Proposed fix.** Implement load-time two-stage retrieval: trust-filter (reuse
`isInstallable`) → cosine over `index.embeddings.json` vs the story/plan text → top-K
rank. Cheapest first step: just **read** the already-written sidecar in `skills-prompt.mjs`
and re-rank. Direct enabler of F24's per-story injection.

**Effort:** M. **Track:** I. **Status:** proposed.

### F28 — No usage telemetry → dead skills never pruned; loadout only grows (P2)

**Evidence.** 66 skills available, 1 used (F24). The other 65 ride in **every** future
loadout, diluting relevance, with nothing to retire them. The forensic already computes
`skills.activatedSkills` / `skills.perJob` per plan, but that signal is never persisted
back to the registry. The `maturity` facet added in Story 2.1
(`functions/shared/schemas/skill-index-entry-schema.ts`) is **never populated** —
`index.usage.json` is a Phase-2 deferral.

**Root cause.** No feedback edge from activation telemetry → registry facets → loadout
composition. Curation is currently input-only (what enters), never output-pruned (what's
dead).

**Proposed fix.** Persist per-plan `skill_activated` counts into `index.usage.json` (and
the `maturity` facet); a periodic curator pass (extend `retro-scan-skills.mjs`) marks
skills with **0 activations across N plans** as `deprecated` — which 4.2 already makes
non-installable — shrinking the loadout to what's actually used. Surface "stale/dead" in
the Registry browse (Story 4.3 already has the trust column to hang it on).

**Effort:** M. **Track:** I. **Status:** proposed.

### F29 — Environment-true subdomains: CloudFront index-rewrite + plan/app identity (P1)

> Contributed by **deployment** (2026-06-19). Full design: [`deployment-v2.5.md` §15](./deployment-v2.5.md). **Touches the QA stage — see hand-off below.**

**Evidence (confirmed against live AWS).** The F22 subdomains 403 on bare directory
paths: dev dist `E10EO7ORIP20S6` + staging dist `E3F34BER0RR7H7` have
`DefaultRootObject:""`, **`FunctionAssociations:0`**, an S3 **REST** origin + OAC, and the
buckets have **no website hosting** — so `dev.futurator.ai/<x>/` → S3 key `<x>/` (not an
object) → 403 (only `…/index.html` + assets serve). Prod works only because
`futurator-ai-website` is a website-hosting bucket. The fix is what `StaticSite` does
automatically (proven in-account: `futurator-production-AdminSiteCloudfrontFunctionRequest-*`)
and a bare `Router` doesn't. (Until fixed, `DEPLOY_ENV_SUBDOMAINS` is OFF → dev/staging run
on the working fallback prefixes `apps/_dev/`, `apps/_staging/` on the prod bucket.)

**Two coupled changes.**

- **(A) Infra** — attach a CloudFront viewer-request Function (`cloudfront-js-2.0`)
  rewriting `/<x>/`→`/<x>/index.html` and `/`→`/index.html` to the dev + staging Routers
  (durable in `sst.config.ts`: native Router edge option if the installed SST exposes one,
  else a Pulumi `aws.cloudfront.Function` via the Router `transform`). Then flip
  `DEPLOY_ENV_SUBDOMAINS=on`.
- **(B) Code** — adopt **plan-vs-app identity**: `resolveDeployTarget({planSlug, appId}, env)`
  → dev = `dev.futurator.ai/<plan>` (plan-scoped), staging = `stage.futurator.ai/<app>`,
  prod = `futurator.ai/apps/<app>`. The deploy/promote/cron call sites pass both ids.
- **(C) Harness contract** (load-bearing; raised + accepted from `QAreview-agentic` 2026-06-19) —
  the **dev** build MUST set `NEXT_PUBLIC_TEST_HARNESS=1` so QA's `window.__harness` L2 probes
  (`registry.ts:427`, `visual-qa-pipeline.ts:523`) work against the deployed `dev.futurator.ai/<plan>`
  artifact, else `SEAM_ABSENT`. **staging/prod build harness-OFF** (seam is production-absent by
  design). Deployment owns injecting the flag in the dev deploy pipeline; QA owns the seam.

**Why subdomains, not the `apps/_dev/` path-prefix.** Separate origin = browser-level
isolation of cookies/`localStorage`/`IndexedDB`/service-worker scope — required once apps
store state (a shared-origin path-prefix shares a game's high-score store across all three
envs); plus blast-radius (can't touch the homepage bucket) and per-env controls. Path-prefix
is fine only for stateless static apps / as the zero-infra stopgap.

**Build-once tradeoff.** Two things force **dev→staging to always rebuild** (never byte-copy):
the identity change (`<plan>`→`<app>`) and the harness flip (ON→OFF, change C). So byte-copy
applies **only to staging↔prod** — align their base (`/apps/<app>/`) to keep it (overlaps **Q11**).
Dev is a per-plan, harness-ON rebuild by design — not a regression.

**Effort:** M (infra + code). **Track:** H. **Status:** proposed.

> **🔔 Hand-off — QA-review session (`QAreview-agentic`):** this directly enables your
> deferred root fix. **F11/Q-C9/Q7** wanted "QA against the dev-deploy URL instead of booting
> `next dev` in the shared worktree." Once F29 lands, that URL is **real, plan-scoped, and
> immutable**: `dev.futurator.ai/<plan>` is the merged plan QA reviews. Please (a) point
> "Open in dev" + your verification at it, and (b) resolve F11/Q-C9 by targeting it (close out
> Q7). You own the corresponding rubric/criteria updates (DP-I1 / Q-C9 / Q7).
>
> **✅ Accepted your 2026-06-19 feedback:** the `window.__harness` requirement is now change
> **(C)** above — deployment builds dev with `NEXT_PUBLIC_TEST_HARNESS=1`, staging/prod
> harness-off. Agreed dev→staging is a rebuild (identity + harness), byte-copy only staging↔prod.
> No overlap with your QA-side files; we run in parallel, integration point = QA verifies
> `dev.futurator.ai/<plan>` once F29 ships.
>
> **Hand-off — concept/pipeline owner:** the plan-vs-app identity + the `resolveDeployTarget`
> signature change ripple to all deploy/promote/cron call sites.
>
> **✅ Confirmation back — `QAreview-agentic` (2026-06-24):** the harness contract (Part C) is
> exactly the dependency I needed — confirmed. When F29 lands I'll target `dev.futurator.ai/<plan>`
> and close F11/Q-C9/Q7. **Accepted your ask-back: `SEAM_ABSENT`/`SEAM_NEVER_PUBLISHED` become
> ENVIRONMENT-AWARE** — a hard blocking signal on **dev** (harness ON → the seam must publish;
> absence is a real regression), but an **expected, non-blocking** condition on **staging/prod**
> (seam is production-absent by design, so a harness-off smoke must not misread a missing seam as
> a defect). I own that gating on the QA side; tracked in `qa-review-delivery-rethink.md` §3.1.

---

## 4. Workstreams

| Track | Theme                                           | Findings                                         | Owner          | Status                                                                                         |
| ----- | ----------------------------------------------- | ------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------- |
| **A** | Perf / token reduction                          | F1, F6, F7, F8(part), F9                         | _unclaimed_    | proposed                                                                                       |
| **B** | Correctness / observability                     | F2, F3, F4                                       | _unclaimed_    | proposed                                                                                       |
| **C** | Learning loop                                   | F5, F8(part)                                     | _unclaimed_    | proposed                                                                                       |
| **D** | Planning / parallelism                          | F10                                              | _unclaimed_    | proposed                                                                                       |
| **E** | Context management (design)                     | see §5                                           | _unclaimed_    | proposed                                                                                       |
| **F** | QA evidence integrity & stage isolation         | F11, F12, F13                                    | _unclaimed_    | proposed                                                                                       |
| **G** | Knowledge-graph integrity & grounding substrate | F14, F15, F16, F17, F18                          | **graphify**   | F17/F18 shipped; F14–F16 proposed                                                              |
| **H** | Deployment control panel & promotion ladder     | F19, F20, F21, F22, F23, F29 (+ F11 deploy side) | **deployment** | F19/F20/F21 shipped; **F29 enables QA's F11/Q7 root fix**; F22-subdomains + F23 + F29 proposed |
| **I** | Skill activation, discovery & trust integration | F24, F25, F26, F27, F28 (+ F5 loop side)         | _unclaimed_    | proposed; **F26 is a pre-deploy gate for the Skills-Institution branch**                       |

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
7. **F23 MCP-config self-heal** — two lines (`existsSync` + `mkdirSync`); a missing generated
   file currently **halts every agent spawn** (pipeline-wide stall). Immediate unblock is a
   daemon Restart, but the self-heal is the permanent fix. _(deployment)_

> **Already shipped this session (graphify):** **F17** (`projectId` normalization — heals
> UUID-stranded orphans across all projects, `0d5dd6a`) and **F18** (`REFERENCES` living-doc
> linking, `0445e6a`). They need no roadmap slot — just `verified` once projects re-sync.
>
> **Already shipped this session (deployment):** **F19** (URL-truncation regex), **F20**
> (framework-aware deploy prompts), **F21** (dev/staging log streaming + smoke surfacing), and
> the **F22 dual-prod-path reconcile** — all in `1755365`, live on prod (`c937de7`). No roadmap
> slot — `verified` on the next real plan's dev→staging→prod run.

**Phase 2 — Restore observability & correctness:** 4. **F2 priorJobIds history** → **F3 forensic union + cost reconciliation**. 5. **F4 totalStories count + fix-story lineage badge.** 6. **F14 full-project ast-facts at wave-close** — the root of the broken-graph class; without it orphans recur every multi-story run. _(graphify)_

**Phase 3 — Deeper efficiency:** 6. **F7 mvp test-authoring trim**, **F8 fixer gating + prior-diff**, **F9 catalog trim**, **F13 probe-authoring gate (with F8 + VQA v3)**, **F15 delete-aware graph prune (needs F14)** _(graphify)_. 7. **F10 planner parallelism**, **§5 context-management redesign.** 8. **F22 provision dev/staging subdomains** — turns "build-once-promote-many" from code-only into reality (today fallback rebuilds per rung); infra-gated (SST + EC2-IAM, recipe in `deployment-v2.5.md §14`); also unblocks pointing QA at a stable per-env dev-deploy URL (F11 #1 / Q7). _(deployment)_

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
- **Q11 (F11/F20) [deployment]:** Where should the **deploy base path be injected**? Editing
  `next.config.ts` in the shared worktree is the root of the deploy×QA race (F11) _and_ the
  improvisation (F20) — one change closes both. Options: an env var the build reads
  (`NEXT_BASE_PATH` / Vite `--base`), a declarative
  `BoilerplateRuntimeContract.build.requiredConfig` (overlaps `boilerplate-runtime-contract.md`),
  or an isolated per-deploy build dir. Recommend coupling this with Q7 (QA against the
  dev-deploy URL) since both want the build to stop mutating the live tree. Needs an owner.
- **Q12 (F22) [deployment]:** Once the dev/staging subdomains exist, should **build-once be a
  hard gate** — a promotion that would _rebuild_ (base paths differ) is blocked, forcing a
  byte-copy — or stay advisory while any fallback-prefix mode remains? The deterministic
  answer-key is whether the promoted bytes' hash equals the source environment's (rubric DP-L2).

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

| Concern                                      | File:line                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-story pipeline                           | `functions/shared/pipelines/story-pipeline.ts`                                                                                                                                                                                                                                      |
| Story context pack                           | `daemon/pipelines/lib/story-context-pack.mjs`                                                                                                                                                                                                                                       |
| Cached tsc (exists, prework-only)            | `daemon/lib/cached-tsc.mjs`                                                                                                                                                                                                                                                         |
| Prework gate                                 | `daemon/lib/prework-gate.mjs`                                                                                                                                                                                                                                                       |
| Wave VQA runner                              | `daemon/lib/wave-vqa-runner.mjs`                                                                                                                                                                                                                                                    |
| Wave merge                                   | `daemon/lib/wave-merge.mjs`                                                                                                                                                                                                                                                         |
| VQA fix-story mint (title)                   | `daemon/lib/wave-vqa-fix-story.mjs:53`                                                                                                                                                                                                                                              |
| Retry / story rerun (jobId overwrite)        | `functions/shared/services/story-rerun-launcher.ts:140`                                                                                                                                                                                                                             |
| Forensic builder (event collection)          | `functions/shared/timer/forensic-builder.ts:277`                                                                                                                                                                                                                                    |
| Forensic endpoint                            | `functions/api/index.ts:12125` (`GET /plans/:id/timing/forensic`)                                                                                                                                                                                                                   |
| Agent events repo (7-day TTL)                | `functions/shared/repositories/agent-events-repository.ts`                                                                                                                                                                                                                          |
| Reflector runner                             | `daemon/pipelines/reflector-runner.mjs`                                                                                                                                                                                                                                             |
| UI live output / events                      | `src/components/labs/agentic-workflow/story-live-output.tsx`, `src/hooks/use-agent-events.ts`                                                                                                                                                                                       |
| QA auto-approve + dev-deploy co-launch (F11) | `functions/cron/wave-completion-check.ts:210` (qa-execute), `:273-283` (dev-deploy), `:259-260` (intent comment)                                                                                                                                                                    |
| Deploy config rewrite (F11)                  | `functions/shared/deploy/build-deploy-pipeline.ts:47` (Edit/Write tools), `:66` (next.config basePath/output rewrite)                                                                                                                                                               |
| QA execute pipeline / capture / report (F12) | `functions/shared/pipelines/visual-qa-pipeline.ts:454` (qa-prepare boot), `:518-662` (per-test capture), `:656` (SCREENSHOTS_CAPTURED), `:955` (`overall = fail>0`)                                                                                                                 |
| QA judge prompts (F12c)                      | `functions/shared/pipelines/visual-qa-pipeline.ts:786` (L1), `:886` (L2)                                                                                                                                                                                                            |
| Seam/assert executor (F13, exists)           | `functions/shared/pipelines/visual-qa-pipeline.ts:616-626` (`assert` → `page.evaluate(window.__harness)`)                                                                                                                                                                           |
| Claims-table thumbnail (F12 UI)              | `src/components/labs/plan-dashboard/views/qa/claims-table.tsx:296` (`<img onError>` hides broken/404)                                                                                                                                                                               |
| AST scan + ast-facts persist (F14)           | `daemon/scripts/bootstrap-ast.mjs:301-305` (`ast-extract --scan` over `args.root`), `:297`/`:328` (writes `<root>/.mycelium/ast-facts.json`)                                                                                                                                        |
| AST → graph translation, additive (F14/F15)  | `daemon/scripts/graph-sync.mjs:686` (`processAstFacts`)                                                                                                                                                                                                                             |
| Orphan invariant emit + swallow (F16)        | `daemon/scripts/graph-sync.mjs:1049` (`Orphan invariant FAILED`), `daemon/scripts/lib/graph-integrity.mjs:112` (logic); swallowed at `daemon/scripts/bootstrap-ast.mjs:371` (`exited 3 (non-blocking)`)                                                                             |
| projectId normalization (F17, shipped)       | `daemon/scripts/graph-sync.mjs:745` (file-node MERGE `ON MATCH SET n.projectId = $projectId` — commit `0d5dd6a`)                                                                                                                                                                    |
| Living-doc REFERENCES layer (F18, shipped)   | `daemon/scripts/lib/doc-references.mjs` (`isLivingDoc`, `extractWikilinks({inlineRefs})`), wired in `daemon/scripts/graph-sync.mjs` — commit `0445e6a`                                                                                                                              |
| DEPLOY_URL extractor regex (F19)             | `functions/shared/deploy/build-deploy-pipeline.ts`, `functions/shared/deploy/build-promote-pipeline.ts` (`DEPLOY_URL` pattern — `_` now allowed) — commit `1755365`                                                                                                                 |
| Framework-aware deploy prompt (F20)          | `functions/shared/deploy/build-deploy-pipeline.ts` (step-1 next/vite detect), `build-promote-pipeline.ts` (rebuild branch) — commit `1755365`                                                                                                                                       |
| Per-env streaming + smoke (F21)              | `functions/shared/repositories/deploy-report-aggregator.ts` (`environments[].activeJobId`/`smokeStatus`), `views/deploy-stage-view.tsx`, `views/deploy/{environment-ladder,deploy-logs,deploy-steps}.tsx` — commit `1755365`                                                        |
| Env-target resolution / build-once (F22)     | `functions/shared/deploy/deploy-targets.ts` (`provisioned` flag, prefix vs subdomain), `build-promote-pipeline.ts` (`copyMode`), `views/deploy/release-strip.tsx` (ladder CTA); subdomain recipe `deployment-v2.5.md §14`                                                           |
| MCP-config spawn injection (F23)             | `daemon/lib/mcp-config.mjs:23` (`CONFIG_PATH`), `:37-52` (`ensureConfig` write-once latch, no `existsSync`/`mkdirSync`), `:60` (`myceliumMcpSpawn`); injected at `daemon/agent-daemon.mjs:872`; introduced commit `ceea33e`                                                         |
| Skill prompt-line build + ordering (F24/F27) | `daemon/lib/skills-prompt.mjs:140-155` (pins-first then readdir, `buildSkillsPromptLine`), `:26` (`MAX_SKILLS=80`), `:28` (`MAX_SECTION_CHARS=8000`)                                                                                                                                |
| Scout triggers + spawn (F25)                 | `daemon/lib/skill-scout-triggers.mjs:38/71/110` (T4/T5/T6 helpers — no intent trigger); `daemon/agent-daemon.mjs:187` (`runSkillScoutJob`); `daemon/pipelines/app-bootstrap.mjs:419,459` (bootstrap spawn)                                                                          |
| Scout install dispositions (F26)             | `daemon/pipelines/skill-scout-job-runner.mjs:238-269` (`auto-confirm`→`applyConfirmedProposals`; `surface-card`); installs via `skill-installer.mjs`→`runVendorSkills`                                                                                                              |
| Trusted-only vendor gate (F26, Story 4.2)    | `daemon/lib/app-bootstrap-steps/vendor-skills.mjs:140-160` (`getSourceIndexEntry`), `:195-200` (`isInstallable` gate, after on-disk skip), `:242` (`blocked` count); predicate `daemon/lib/skill-trust.mjs`                                                                         |
| Gate / inbox (F26 target path)               | `functions/api/index.ts` (`/api/skills/gate`, `/api/skill-proposals/*`); `functions/shared/skill-gate/{index,labeling,security-scan,dedup}.ts`; store `functions/shared/repositories/skill-proposals-repository.ts`                                                                 |
| Embeddings sidecar write-only (F27)          | `scripts/ingest-skills.mjs:226` (writes `index.embeddings.json`, voyage-3 1024-dim), `:16` (header _claims_ SCOUT queries it — no reader exists in prompt/resolver/scout)                                                                                                           |
| E1 apply loop (F5 extension)                 | `daemon/pipelines/reflector-apply.mjs:209-213` (`authorAppSkill` from reflection `content`), `daemon/lib/reflection-apply-poller.mjs:41` (`runReflectionApplyTick` consumes `confirmed`); `maturity` facet unpopulated (F28) `functions/shared/schemas/skill-index-entry-schema.ts` |

---

## Changelog

| Date       | Agent                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-17 | Claude (forensics #1)        | Initial draft: findings F1–F10, workstreams A–E, roadmap, appendices from pacman3 forensic + daemon-log cross-check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-06-18 | QAreview-agentic             | QA-stage forensic on the same pacman3 run (QA job `3c99fd51`, not walked by the original forensic — F2/F3). Added F11 (deploy×QA same-worktree race → `next.config.ts` rewrite relocates app off root → per-test 404s), F12 (broken/missing evidence scored as blocking defects; capture gate + honest verdict lane + judge hallucination), F13 (state/behavior ACs authored with no executable probe). New Track F; F11/F12 → Phase 1, F13 → Phase 3; open Q6/Q7; Appendix B refs. Verdict: QA false-blocked a correct app — every FAIL was an infra artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-06-18 | deployment                   | Deployment-stage findings from building + shipping the v2.5 promotion-ladder control panel (brick1 went live dev→staging→prod). New **Track H**: F19 (DEPLOY*URL extractor truncated dev/staging URLs at `*`→ dead "Open in dev" link — **shipped`1755365`**), F20 (Vite-only deploy prompts vs Next.js apps → agent improvised; framework-aware now — **shipped `1755365`**; does NOT close F11), F21 (dev/staging deploys unobservable + smoke unsurfaced → per-env streaming + smoke badge/soft-gate — **shipped `1755365`**), F22 (build-once not real — fallback prefixes force rebuild-per-rung; dual-prod-path reconcile **shipped**, subdomain provisioning **open**, recipe in `deployment-v2.5.md §14`), F23 (MCP-config missing → halts **every** agent spawn; 2-line `existsSync`+`mkdirSync`self-heal — **open**, owner graphify). Added F11 agent-notes (deploy still rewrites QA's`next.config.ts` post-F20 → Q7/Q11), Q11/Q12, roadmap slots (F23→Phase 1, F22→Phase 3), Appendix B refs. Reconciled the deployment rubric's forward-refs "F14/F15" → canonical **F22/F23**. Same lesson as F11/F12/F14 — clean agents, leaky harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-06-18 | graphify                     | Knowledge-graph (knowledge-compile output) forensic on the same pacman3 run — broken graph on correct code (177/290, 29 unconnected, Orphan invariant FAIL 20). Added new **Track G** + F14 (truncated ast-facts = last story's worktree scope, not the project), F15 (additive ingest never prunes deleted-source zombies), F16 (orphan invariant computed but swallowed at `exit 3`), F17 (job-UUID `projectId` strands file nodes → silent DEFINES loss — **shipped `0d5dd6a`**), F18 (living docs float; new `REFERENCES` doc→code edge layer for living docs, plan-docs excluded — **shipped `0445e6a`**). F16 → Phase 1, F14 → Phase 2, F15 → Phase 3; open Q8/Q9/Q10; Appendix B refs. After fixes: pacman3 graph 212/526, 0 orphans. Same lesson as F11/F12 — clean agents, leaky harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-06-18 | Claude (skills)              | Skill-management forensic on the same pacman3 run, through the lens of the (built, unshipped) Skills-Institution branch. New **Track I** + F24 (activation collapse — 5.2% of sessions, 1.5% of 66 skills used; push relevant bodies per-story + activation-as-reflector-signal), F25 (scout dormancy — `skillScoutRuns:[]`; no intent-aware trigger; add T-intent at plan-build), **F26 ⚠️ pre-deploy gate** (Story 4.2's trusted-only vendor gate silently blocks scout community installs; scout↔inbox are two disconnected trust authorities — wire scout `surface-card`→inbox proposal, ship with 4.2), F27 (embeddings sidecar write-only → no load-time relevance ranking; read it in skills-prompt), F28 (no usage telemetry → dead skills never pruned; populate `index.usage.json`/`maturity`, auto-deprecate 0-activation skills). Added F5 agent-note (E1 apply loop + poller now built — but still blocked by F5's IAM write-fail + mvp-no-story-reflection; fix IAM first). Appendix B refs. Lesson: Skills-Institution fixed **curation/security/authoring**; the forensic shows the live bottlenecks are **activation, discovery, and retrieval** — and our security gate needs the scout→inbox bridge before it deploys.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-06-19 | deployment                   | **Environment-true subdomains plan (F29, Track H).** Confirmed against live AWS _why_ `dev.futurator.ai` 403s: dev/staging dists (`E10EO7ORIP20S6`/`E3F34BER0RR7H7`) have `DefaultRootObject:""`, `FunctionAssociations:0`, S3 REST origin + OAC, buckets no website hosting → bare `…/<id>/` 403 (index.html + assets DO serve); prod works only because its bucket is website-hosting. Fix = CloudFront viewer-request index-rewrite Function on the dev/staging Routers (the pattern `StaticSite` auto-creates, proven in-account) + adopt **plan-vs-app identity** (dev=`dev.futurator.ai/<plan>`, staging=`stage.futurator.ai/<app>`, prod=`futurator.ai/apps/<app>`). Documented the subdomain-vs-path-prefix rationale (origin isolation of cookies/localStorage/SW once apps store state; blast-radius; per-env controls) + build-once tradeoff (Q11). Full design: deployment-v2.5.md §15. **🔔 Notifies the QA-review session:** the plan-scoped immutable `dev.futurator.ai/<plan>` is exactly the mechanism F11/Q-C9/Q7 deferred — QA should target it and close out its stage-isolation root fix. Status: proposed (infra + code; not yet implemented).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-06-18 | Claude (implementation pass) | **Reconciled all findings against current code + implemented the in-repo set.** De-bias: **F1 dropped as a false finding** (no in-loop `tsc` step exists — `test-verify`=vitest, `lint-verify`=eslint; the "thrash" was ad-hoc agent Bash calls). Confirmed **F17/F18/F19/F20/F21 already shipped**. **Implemented this session** (focused tests green; daemon `.mjs` need rsync+restart to take effect): **F2** (`retryOf` chain), **F3** (forensic retry-union + `costReconciliation`), **F4** (`totalStories` rollup), **F6** (hard cost gate at wave boundary), **F11** (serialize QA vs dev-deploy — race removed; deeper QA→dev-deploy-URL/env-base-path root fix deferred to Q7/Q11), **F12/F13** (QA evidence-integrity gate + `errored` lane + probe-gated L2), **F14** (graph-sync refuse-to-narrow + `ast-facts.full.json`; wave-close `regenAstFacts` daemon hook deferred), **F15** (delete-aware code-node prune; infra-node prune deferred), **F16** (orphan-invariant surfaced as `orphan-signal.json` + attention log; downstream consumer deferred), **F23** (MCP-config self-heal), **F24** (per-story top-3 skill-body push), **F26** (`fromBulk` gate adapter + `/api/skills/gate/bulk` route; daemon-side `emitBulkProposal` call deferred), **F27** (embeddings relevance ranking). Commits `25acde1` (fixes), `a066b75` (rubric v1.0-draft + plan-retrospect-spec), `26337ad` (Plan Retrospect feature). **Still infra-only:** F5 (reflections IAM grant), F22 (dev/staging subdomains). The Plan Retrospect feature (this doc's companion scorecard-spec, now `plan-retrospect-spec.md`) is the mechanism that will re-score every future run against the v1.0 rubric. |
