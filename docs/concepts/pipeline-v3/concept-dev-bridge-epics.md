# Epics & Stories — Concept→Dev Bridge

Status: **RECONCILED against deployed code (2026-06-19)** · shards `concept-dev-bridge-prd.md`.

> **Reconciliation note.** The first cut of this plan (FOR-BUILD, 2026-06-19) was authored from the
> clean-repo Pac-Man **spike**, which had none of the production plan-gen / pipeline code. A 16-agent
> audit workflow (`v3-epic-reconcile-audit`, one auditor + one adversarial verifier per epic) matched
> every story against the **deployed** codebase. It found the plan systematically over-scopes: much of
> the proposed work already ships under different names, several stories are inert until the E4 bench
> exists, and one (E5-S3) is fully built. Each story below now carries a **[verdict · action]** tag and
> a **Deployed reality** line with `file:line` evidence. Story IDs are preserved so traceability holds;
> ACs are tightened, not invented. The original aspirational stories are recoverable from git history
> (`222ddea`).

Every story tags the FR id it satisfies (coverage holds) + touchPoints (real file:line targets) + ACs.

> **Build prerequisite (still true):** build from `feat/pipeline-v3`, which is freshly off `main` — main
> has the pacman4 lint↔tamper deadlock fix (`5f497c0`) that E4 builds on. (Done: we are on that branch.)

## Audit verdict map (per story)

| Story | Verdict            | Action          | One-line                                                                                       |
| ----- | ------------------ | --------------- | ---------------------------------------------------------------------------------------------- |
| E1-S1 | partial            | **reframe**     | reuse `requirementRefs` (don't add `coversSpecIds`); only the PM prompt fails to emit it       |
| E1-S2 | partial            | **reduce**      | acyclicity already throws; coverage already coded in `runSolutioningGate` — just unwired       |
| E1-S3 | inert              | **split/defer** | collision already resolved by wave serializer; conformance has no substrate → E4/E8            |
| E1-S4 | partial            | **reduce**      | blocking posture already throws; net-new = persist the existing verdict on the plan row        |
| E2-S1 | net-new            | **build**       | extract prose essays to a rubric (scope: prose only, keep the touch-point hard rule)           |
| E2-S2 | partial            | **reduce**      | harness rig reusable but never calls the real prompt; add a real-prompt token/field-diff probe |
| E3-S1 | partial            | **reduce**      | `lint-verify` category gap is real & ships now; `__gate__` events wait on E1/E4                |
| E3-S2 | inert              | **defer**       | no swarm on the daemon to harvest; OV4 already reconciles per-job spend → after E4             |
| E3-S3 | inert              | **defer**       | scorecard scaffold ready; reads `plan.checkoutGates` (E1-S4) → build right after E1            |
| E3-S4 | net-new            | **build**       | `workflow-lint.mjs` has no workflow-kind profile; self-contained, buildable now                |
| E4-S1 | net-new            | **build**       | relocate api/test-author; ⚠ re-derive pacman1 commit-staging invariant for pre-wave files      |
| E4-S2 | partial            | **reframe**     | freeze is existence-only (no tsc, no SHA on daemon); add tsc gate; swarm is net-new            |
| E4-S3 | partial            | **reframe**     | parse/RED self-gate exists per-story; add parallel bench + AC-coverage + contract-typecheck    |
| E4-S4 | partial            | **reduce**      | pacman4 regression already green on main; net-new = capped re-route + sonnet→opus bump         |
| E4-S5 | partial            | **reframe**     | scope via `role-policy` (CLI-enforced) not frontmatter; JIT per-wave hook is net-new           |
| E5-S1 | partial            | **reduce**      | `contextDigest` injection + no-re-Explore rules ship; net-new = a scout fills the slot         |
| E5-S2 | partial            | **reduce**      | typed handoffs + slicing ship; net-new = cache-aligned prefix + cache_read metering            |
| E5-S3 | **already-exists** | **DROP**        | model tiering fully wired in `.claude/agents/*.md`; reviewer pinned to sonnet                  |
| E6-S1 | partial            | **reduce**      | dynamic project loadout + skill-scout ship; net-new = per-ROLE selection (gated on E4)         |
| E6-S2 | inert              | **defer**       | bundle records activations not offered-loadout; needs E3-S2/S3 + E4 swarm                      |
| E7-S1 | partial            | **reframe**     | reuse `yoloMode/conceptInteraction`; net-new = make YOLO bypass `runSolutioningGate`           |
| E7-S2 | inert              | **defer**       | nothing to stamp until `plan.checkoutGates` (E1-S4) + `scoreCheckouts` (E3-S3) exist           |
| E8-S1 | inert              | **defer**       | `run-heavy.sh` ships; gated run on EC2 after E5/E6 — correct as deferred                       |

## Revised epic map & dependency waves

The original waves assumed E1 builds the swarm/gate substrate that E3/E5/E6/E7 hang off. Reality inverts
this: **the swarm already exists** (E5 substrate is live), **E1 is small wiring on an existing gate**, and
the one genuinely-new swarm is **E4's contract/test bench**. Inert stories cluster behind E4 and E1's
`checkoutGates` field, not behind a planning swarm.

| Wave  | Build now / order                                                           | Gate to enter                                      |
| ----- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| **0** | ✅ **BUILT (2026-06-19)** — E1-S1, E1-S2, E1-S4, E2-S1, E3-S1, E3-S4, E7-S1 | none — all real net-new/wiring on deployed code    |
| **1** | E3-S3, E7-S2, E2-S2                                                         | E1-S4 lands `plan.checkoutGates`                   |
| **2** | E4-S1 → E4-S2 → E4-S3 → E4-S4 → E4-S5 (the contract/test bench)             | wave 0; mind the pacman1 commit-staging invariant  |
| **3** | E3-S2, E5-S1, E5-S2, E6-S1, E6-S2                                           | E4 bench/swarm exists to harvest + scope           |
| spike | E8-S1, E1-S3 (conformance)                                                  | E4/E8 introduce a contractSurface + planning swarm |
| —     | ~~E5-S3~~ **DROPPED** (already shipped)                                     | —                                                  |

**Recommended first PR = Wave 0.** It is entirely additive on shipped code, unblocks waves 1–3, and
needs no new infrastructure.

> **Wave 0 shipped (2026-06-19).** All seven stories built additively on the deployed code, +365/−100
> across 8 source files + 4 test files, 88 tests green, no new type errors or regressions (the 5 failing
> tests in `epic-dev-pipeline`/`concept-chain-e2e` pre-date this work on `feat/pipeline-v3`). Highlights:
> E1-S1 PM emits `requirementRefs` (grounded plans only); E1-S2 daemon extracts PRD `FR` ids →
> `plan.prdRequirementIds` → live `runSolutioningGate` coverage; E1-S4 persists the verdict as
> `plan.checkoutGates`; E7-S1 YOLO bypasses the block at the call site (verdict still recorded,
> `bypassedByYolo`); E2-S1 condensed the three prose essays (~1.5k chars, ≈40% off the essays);
> E3-S1 `lint-verify→compile`/`lint-fix→fix`; E3-S4 `@workflow-kind: planning` linter profile.
> **Wave 1 next** (E3-S3 `scoreCheckouts`, E7-S2 bypass-stamping) now that `plan.checkoutGates` exists.

---

## E1 — Plan checkout gates (FR-A, FR-B3)

**Goal:** every plan's structural defects are caught and the verdict is recorded — by **activating and
persisting the gates that already exist**, not building parallel ones.

**Deployed reality (missed by the original plan):**

- `runSolutioningGate` (`functions/shared/services/solutioning-gate.ts`) is the live §8 readiness gate at
  `POST /api/plans/:id/start` (`functions/api/index.ts:2884`). It already does requirement coverage
  (`:84-88`), BDD/user-story, manual-AC, and appearance-floor checks, and **already blocks** the
  concept→dev transition (`if (gate.blocks) throw` at `:2885`). E1 **extends** it; it does not duplicate it.
- `computePlanWaves` (`plan-waves.ts:31-35`) **already throws on cycles** at apply (`plan-generation-service.ts:356`)
  AND start (`index.ts:2873`). Acyclicity is already a hard gate.
- `computeStoryWavesWithTouchPoints` (`story-waves.ts:62-117`) **already serializes** same-file siblings
  into separate waves (`plan-generation-service.ts:280`). Collision is already resolved at plan time.
- `epic.requirementRefs` is already a schema-validated, persisted field (`plan-output-schema.ts:123`,
  `plan-generation-service.ts:333`) — but the **PM prompt never emits it**, so it is always `undefined`.

- **E1-S1 — Make the PM emit `requirementRefs` (FR-B3). [partial · reframe]**
  - **Do NOT add a `coversSpecIds` field** — it would duplicate the shipped `epic.requirementRefs`.
    The only missing link is the prompt: add an instruction + emit `requirementRefs` in the JSON output
    example. The schema already accepts it (`.optional()`) and `applyPlanOutput` already persists it.
  - Touch: `functions/shared/prompts/pm-plan-prompt.ts` (instruction near the FR-coverage prose `:122`;
    emit the field in the output example `:505-521`).
  - AC: every emitted epic carries a non-empty `requirementRefs`; legacy plans without it still parse
    (`.optional()` already guarantees this).
- **E1-S2 — Wire requirement coverage live (FR-A1, FR-A6). [partial · reduce]**
  - **Do NOT port `acyclic.py` and do NOT create `checkout-gates.ts`** — acyclicity is already enforced
    twice by `computePlanWaves` throwing, and coverage logic already exists in `runSolutioningGate:84-88`.
    The real work is to **source `prdRequirementIds`** (from the PRD / `conceptPlan`) and pass it into the
    `runSolutioningGate({ plan, epics, prdRequirementIds })` call so the dormant coverage branch fires.
  - Touch: `functions/api/index.ts:2884` (the gate call site); a producer for `prdRequirementIds`
    (extract FR ids from the approved PRD artifact / `conceptPlan`).
  - AC: a plan dropping a PRD requirement → `runSolutioningGate` flags it (production = error, mvp =
    condition, per the existing `scaled()` severity); determinism holds (the gate is a pure function).
- **E1-S3 — Conformance gate (FR-A4). [inert · split/defer]**
  - Collision (FR-A2) is **already-exists** (`computeStoryWavesWithTouchPoints`) — **drop that half**.
  - Cross-epic contract-surface conformance has **no substrate**: there is no `contractSurface`/`subtrees`
    on the single-shot path (`grep` returns zero in `functions/src/daemon`). It only exists in the
    planning-swarm spike. **Defer** to E4/E8, which introduce the swarm + contract surface.
- **E1-S4 — Persist the gate verdict on the plan row (FR-A5, FR-G3). [partial · reduce]**
  - The blocking posture already exists (`index.ts:2885` throws). Net-new is narrow: **(1)** add a
    `checkoutGates` field to `Plan` mirroring `qaContractStatus` (`plan.ts:305`); **(2)** persist the
    existing `GateResult` (`verdict`/`errors`/`report`) onto the plan row via the **generic**
    `updatePlanFields` (`plan-repository.ts:72-100` — no repo change needed). Today the verdict is only
    returned in the response body (`index.ts:2945`), never stored — so the AC "stored on the plan row
    with reasons" is currently unmet. (YOLO bypass is E7.)
  - AC: after a start attempt, the plan row carries the gate verdict + reasons; a blocking violation is
    both thrown AND recorded.

## E2 — pm-plan prompt slimming (FR-B1, FR-B2)

**Goal:** cut pm-plan wall-clock + output tokens without regressing plan quality.

- **E2-S1 — Extract the prose essays to a consulted rubric. [net-new · build]**
  - **Scope correction:** extract **only the prose essays** — sequential-chains (`:262-267`),
    coupled-siblings (`:268-293`), visual-coverage (`:428-486`). **Keep** the touch-points HARD RULE
    (`:294-311`, REJECTED-at-API language the downstream validators key off) and the output-format block
    (`:494-526`). The original `:262-311` range wrongly bundled the hard rule with the essays.
  - **Decision point:** `buildPmPlanPrompt` runs in the **API Lambda (no filesystem)**, so a "consult a
    separate rubric file" design only works on the daemon path. Either make the rubric a build-time
    include, or use the existing daemon-fillable placeholder seam (`{{PRIOR_ARTIFACTS}}` `:60`,
    `{{CITABLE_SECTIONS}}` `:376`).
  - Touch: `functions/shared/prompts/pm-plan-prompt.ts` (+ a rubric file / include).
  - AC: prompt instruction tokens materially reduced; E1 coverage gate stays green on the Pac-Man docs;
    no validator-keyed text removed.
- **E2-S2 — Measure before/after on the real prompt. [partial · reduce]**
  - The spike harness (`spikes/v3-hybrid/probes/E1-plan-swarm/`) gives reusable wall-clock + token
    plumbing on the fixed Pac-Man docs, BUT its baseline arm uses an **ad-hoc inline prompt, not
    `buildPmPlanPrompt`**, and emits `tok=` only for the swarm arm. Net-new: a probe that calls the
    **actual `buildPmPlanPrompt(args)`** at pre/post-trim revisions, **deterministically counts rendered
    instruction tokens** (no LLM needed for the token-reduction AC), times a live generation, and
    **diffs emitted story fields** (FR-B2). Prefer the frozen-plan `probes/B2-ab/` harness for an
    apples-to-apples "same input, prompt-only differs" comparison; reuse `probes/B1-harvester/harvest.mjs`.
  - AC: a recorded delta (G1) into `spikes/v3-hybrid/results/`, gates green, no per-story field dropped.

## E3 — Audit & Retrospect integration (FR-G, FR-H)

**Goal:** every gate/agent/subagent is a replayable event surfaced in one Plan Retrospect bundle.

**Deployed reality:** the _consumption_ substrate is largely built (8 detectors, OV4 cost reconciliation
wired to the agent-spend-log, `composeRealityCheck`, `GET /api/plans/:id/scorecard` all live). The
_producing_ substrate (checkout gates, swarm subagents) is what's missing — and that's E1/E4.

- **E3-S1 — Fix the `lint-verify` category gap now; defer `__gate__` events (FR-G1). [partial · reduce]**
  - **Ships today:** `story-pipeline.ts:915` emits a `lint-verify` shell step, but
    `step-category-map.ts:26-68` has **no entry** for it, so it falls through to the default `compile`
    bucket. Add the map entry — independent, buildable now.
  - **Defer:** `__gate__` emission has no gates to emit yet. Reuse the existing `__shell__`
    stepId→category convention (gates already flow as `__shell__` events with `durationMs` via
    `executeShellStep` `agent-daemon.mjs:1711/1950`) rather than a parallel `__gate__` role; add the
    checkout/bench gate stepIds when E1/E4 land them.
  - AC (now): `lint-verify` maps to the correct TimerCategory. AC (deferred): each gate → AgentEvent → TimerSlice.
- **E3-S2 — Subagent telemetry harvester (FR-G2, FR-G5). [inert · defer]**
  - The deployed daemon writes no `subagents/workflows/<runId>/` tree (no swarm to harvest); the B1
    harvester is spike-only and its own verdict says it's not productionizable as-is (needs a stable
    per-agent stepId schema convention). OV4 already reconciles **per-job walltime spend**
    (`detectors/overview.ts` `scoreOV4`/`reconcileCost`), not harvested tokens. **Defer to after E4/E5**
    stand up the swarm; then fold harvested spend into OV4 as additive work.
- **E3-S3 — `scoreCheckouts` detector + bundle key (FR-G4). [inert · defer-to-wave-1]**
  - The detector array (`scorecard/index.ts:197`), `RealityCheck` (`compose.ts:86-113`), and the scorecard
    endpoint (`index.ts:12790`) are clean extension points — but the detector reads `plan.checkoutGates`,
    which is **E1-S4's deliverable**. Build immediately **after E1** (wave 1). Hook the existing
    `DetectorContext` fetcher pattern (`scorecard/index.ts:247-274`) and the scorecard-repo persistence /
    stage-projection round-trip. (The skill-loadout part of the AC waits on E6.)
- **E3-S4 — Planning-workflow linter profile (FR-H). [net-new · build]**
  - `docs/concepts/dynamic_workflows/workflow-lint.mjs` is single-profile: C1 (`:101-106`) forces a
    verification role from `VERIFICATION_ROLES` (`:27`) and C8 (`:191`) requires a git-commit checkpoint —
    so a planning workflow must fake a `compile-gate`. Add an `@workflow-kind: planning` header branch
    treating checkout-gate as verification and plan-persistence (DDB) as checkpoint. Self-contained,
    buildable now; useful once a planning workflow exists.

## E4 — Contract & test bench (FR-C)

**Goal:** blind, enforced, deadlock-free contract+test authoring before dev; dev starts at DEV. This is
the **largest genuinely-net-new epic** — the contract/test _bench_ does not exist; api/test-author run
**per-story, single-agent, inline** in `story-pipeline.ts` today.

**Deployed reality & the load-bearing caution:**

- A **swarm primitive to model on already exists** — `daemon/pipelines/epic-dev-pipeline.mjs` runs an
  orchestrator that spawns parallel dev/reviewer Task subagents wave-by-wave (`job-router.mjs:79`,
  phase `epic-dev`). Build the bench on this pattern, not from scratch.
- ⚠ **pacman1 commit-staging invariant** (`story-pipeline.ts:275-301, 636-638`): every file an agent
  writes after `capture-dev-baseline` ships in that story's commit delta. Moving contract/test authoring
  to a **pre-wave** bench means frozen contracts land **outside** every story's delta → re-opens the exact
  wave-merge typecheck failure pacman1 fixed. E4-S1 **must** re-derive where pre-wave files get committed
  and how freeze SHAs reach each per-story `tamper-check`. This is the epic's top risk.

- **E4-S1 — Relocate api/test-author out of story-pipeline (FR-C1). [net-new · build]**
  - Remove `api-author` (step `:317`, role `:257`) + `test-author` (step `:341`, role `:246`) from
    `functions/shared/pipelines/story-pipeline.ts`; story pipeline starts at `dev` (`:640`).
  - AC: a story job runs DEV-first against pre-existing contracts+tests; **and** the pacman1 invariant
    holds — pre-wave contract/test files are committed such that wave-merge typecheck passes.
- **E4-S2 — api-author swarm + **enforced** contract freeze (FR-C2). [partial · reframe]**
  - Deployed freeze is **existence/non-empty only** (`api-author-pipeline.ts:9`) — **no tsc gate, and the
    SHA-256 gate the prompt claims does not exist in the daemon** (verifier `grep`). So the A1-stub
    backfire is currently possible. Net-new: a `tsc --noEmit` gate on stubs **before** freeze (reuse
    `daemon/lib/cached-tsc.mjs`), plus parallel authoring (the swarm primitive from E5's orchestrator).
  - AC: a stub failing typecheck is not frozen; the A1-stub backfire cannot occur.
- **E4-S3 — Parallel test authoring + validate-then-freeze (FR-C3, FR-C4). [partial · reframe]**
  - Reuse: `stage-test-files` (`:512`, parse/lint before baseline) and `test-gate-red` (`:617`, RED vs
    absent impl) already ship per-story. Net-new: lift them to a **wave-level bench**, add an **AC-coverage**
    gate (`AC_TEST_MAP` is emitted `:483-487` but **no deterministic step consumes it**), and a
    **typecheck against frozen contracts** as a freeze precondition.
  - AC: a test failing its self-gate is never frozen; a passing set becomes the SHA baseline.
- **E4-S4 — Capped re-route (FR-C5). [partial · reduce]**
  - The pacman4 parse-error regression is **already green on main**: `stage-test-files` detects it →
    `loopTo: test-fix-author` (`:564`) → re-spawn (`:575`), the apostrophe case is prompted (`:583`) and
    covered by `5f497c0`'s end-to-end test. Net-new: model escalation **sonnet→opus** (loop has
    `maxIterations:3` `:221` but no tier bump) and siblings-untouched / operator-on-exhaustion semantics
    (need the bench from S2/S3). Port `probes/C1-fixswarm/` capped+escalate logic.
  - AC: re-run the pacman4 injection through the **bench** → caught + re-routed pre-freeze; the model
    escalates on repeated failure.
- **E4-S5 — Just-in-time per-wave + capability scoping (FR-C6, FR-C7). [partial · reframe]**
  - **Scope via `role-policy`, not frontmatter.** `role-policy.ts:131-133` already enforces tool denial at
    the CLI layer (`--allowedTools`/`--disallowedTools`) — stronger than the A5 frontmatter stub (which
    the v3-spike proved _backfires_). `API_AUTHOR` already denies Bash (`:164-167`); the one change is to
    move Bash to `deniedExtras` for the bench TEST role (`:168-171`) — but only after test **execution**
    becomes a deterministic shell step (depends on S3). JIT per-wave launch is net-new: wire the bench at
    `index.ts:~2906`, **before** the `launchPipelineWave` loop (`:2907`).
  - AC: wave N+1 tests author against wave N frozen contracts; a bench agent cannot run Bash.

## E5 — Swarm token/context optimization (FR-D)

**Goal:** the (already-live) epic-dev swarm stays within rate-limit headroom; no redundant re-reads.

**Deployed reality (the plan's premise was wrong):** the swarm is **already deployed** —
`epic-dev-pipeline.mjs` orchestrates parallel dev/reviewer subagents. E5 is **optimization of live code**,
not "inert until E4."

- **E5-S1 — Scout-derived brief (FR-D1). [partial · reduce]**
  - `contextDigest` is already injected into the orchestrator + dev subagents with explicit
    no-re-discovery rules (`epic-orchestrator-prompt.md.tpl:13`, `dev-subagent-prompt.md.tpl:19-22`) — the
    "no double-Explore" AC is **already satisfied**. Net-new: replace the **static** digest
    (`epic-dev-launcher.ts:105`, currently `epic.description`) with a **scout/graph-derived** brief
    (port the spike's `plan.workflow.js` graph-scout). Fill the already-wired slot; don't rebuild injection.
  - AC: the injected brief is scout-derived; no worker re-runs Explore.
- **E5-S2 — Cache-aligned prompts + slicing + typed handoffs (FR-D2/D3/D4). [partial · reduce]**
  - Typed handoffs (D4: `<DEV_RESULT>`/`<VERDICT>`, `StoryManifestEntry`) and per-agent slicing (D3:
    `rubricExcerpt`, per-story touchPoints/siblingGlobs) **already ship**. Net-new: **D2 cache-aligned
    prefix** — today the subagent prompt is **inverted** (`{{storyId}}` at line 1; `templates/README.md:59`
    flags this as blocked). Reorder so the stable prefix (system+brief+contract surface) is first; this
    likely requires moving prompt composition **into code** (the orchestrator LLM composes it today).
    Wire the cache_read measurement through `daemon/lib/cost-meter.mjs` (reconcile with the existing
    `session-warmth.mjs` HOT/WARM/COLD policy), not a new harness.
  - AC: harvested `cache_read` share rises vs an unaligned baseline; per-agent input shrinks.
- ~~**E5-S3 — Model tiering.**~~ **DROPPED — already-exists.** `.claude/agents/{dev-trivial,dev-standard,
dev-architectural,senior-reviewer}.md` bind haiku/sonnet/opus; the orchestrator selects by complexity
  (`epic-orchestrator-prompt.md.tpl:33-52`); `senior-reviewer` is pinned to **sonnet** (the gate-floor AC).
  Both ACs are met end-to-end. **At most**, add a verification test asserting reviewers never run below
  sonnet — do not author a tier map.

## E6 — Skill-scout for swarms (FR-E)

**Goal:** each swarm role gets its pertinent skills, dynamically, auditably.

**Deployed reality:** a live skills federation + per-spawn loadout injection already ships
(`skills-prompt.mjs`, F27 cosine rank, F24 body-PUSH at `agent-daemon.mjs:2233`) and a fully-wired
skill-scout (`skill-scout-runner.mjs`). It is scoped **per-project + per-story-text**, never **per-role**.

- **E6-S1 — Per-role dynamic loadout (FR-E1, FR-E2). [partial · reduce]**
  - The dynamic, no-code-change **project** loadout (`skills-prompt.mjs:121-155`) already meets "adding a
    new test skill makes it available without code change." Net-new: **per-ROLE skill selection** — today
    `SKILLS_PUSH_ROLES` (`agent-daemon.mjs:2233`) only switches PUSH-vs-flat, every role gets the same set.
    Build a thin per-role **filter** on the existing loadout, extending the `SKILLS_PUSH_ROLES` hook.
    Gated on E4 landing distinct swarm roles to scope. Drop the "against the live skills module" framing
    (already exists).
- **E6-S2 — Scoped + auditable loadout (FR-E3, FR-E4). [inert · defer]**
  - The bundle records skill **activations** per-job (`forensic-builder.ts` `ForensicSkillsBlock`), not the
    **offered loadout** per-subagent — a different artifact. Depends on S1 (per-role), E4 (swarm subagents),
    and E3-S2/S3 (subagent harvester + bundle key). `compose.ts:64` SK3 is a hardcoded red waiting for it.
    Defer; then it's a small additive per-subagent field feeding `compose.ts`.

## E7 — YOLO auto-approve toggle (FR-F)

**Goal:** unattended concept→dev runs with every bypass recorded.

**Deployed reality:** concept-artifact auto-approval is **already live end-to-end** via
`yoloMode → conceptInteraction='autopilot' → autoApprove` (`index.ts:11927-11933`, `concept-driver.ts:75`,
`concept-artifact-service.ts:141`). **Reuse this convention — do not add `plan.autoApproveGates`.**

- **E7-S1 — Make YOLO bypass the existing blocking gate (FR-F1). [partial · reframe]**
  - Concept approvals already auto-pass under YOLO. The **real** net-new work: `runSolutioningGate` today
    auto-passes only on `rigor==='prototype'` and **never reads `yoloMode`** — so a YOLO mvp/production plan
    still hard-blocks at `index.ts:2885`. Add the YOLO bypass there. The "plan approval / test-bench review /
    E1 blocking gates" the original story listed are inert (E1/E4 not built) — defer those.
  - Touch: `solutioning-gate.ts` (or the `index.ts:2884` call site), threading `resolveConceptInteraction`.
  - AC: a YOLO plan never stops at the solutioning gate.
- **E7-S2 — Record every bypass (FR-F2, FR-F3). [inert · defer]**
  - Nothing to stamp until `plan.checkoutGates` (E1-S4) and the `scoreCheckouts` detector (E3-S3) exist.
    Defer; then stamp bypasses into `checkoutGates` + emit events the way the concept-approve path advances
    the DAG.
  - AC: a YOLO run with a known coverage gap completes and the bundle shows it was auto-approved (G6).

## E8 — Deferred spike: planning-swarm crossover (FR-I) [inert · defer — correct as written]

**Goal:** decide whether the planning swarm replaces the single-shot pm-plan. **Not a build epic.**

- **E8-S1 — Envelope-matched EC2 crossover run.** `run-heavy.sh` ships complete; the remaining work is a
  measurement **run** on EC2 `i-0826d68c316ae97dd`, gated on E5/E6 and on a planning swarm existing on the
  deployed path (it does not — deployed plan-gen is single-shot `pm-plan-pipeline.ts`).
  - **Decision-grade caveat (missed by the original):** the single-shot arm hard-codes its own PM prompt
    (`run-heavy.sh:43-49`) instead of importing the deployed `buildPmPlanPrompt` — for the crossover to be
    decision-grade it must mirror the real prompt, and the spike-only Python gates (`conformance.py`,
    `acyclic.py`) would need re-homing into the TS gate layer first.
  - AC: a recorded crossover point (story-count where swarm wall-clock < single-shot). If none, FR-I stays
    deferred and the checkout gates remain on the single-shot.

---

## Coverage check (PRD → epics)

FR-A→E1 · FR-B→E1-S1+E2 · FR-C→E4 · FR-D→E5 (FR-D5 already satisfied, E5-S3 dropped) · FR-E→E6 · FR-F→E7 ·
FR-G→E3 · FR-H→E3-S4 · FR-I→E8. NFRs (determinism, ephemeral-state safety, undocumented-API isolation,
deploy safety, throughput-not-cost, backward-compat) remain cross-cutting acceptance constraints.

## Cross-cutting integrations the original plan missed (fold into the relevant story)

- **`runSolutioningGate`** is the real plan-quality gate — E1 extends it, never duplicates it.
- **`role-policy.ts`** CLI-level tool denial is stronger than A5 frontmatter — E4-S5 scopes through it.
- **`yoloMode`/`conceptInteraction`** is the deployed YOLO convention — E7 reuses it, no new flag.
- **`epic-dev-pipeline.mjs`** is a live orchestrator swarm — E4 models the bench on it; E5 optimizes it.
- **`updatePlanFields`** is generic — persisting `checkoutGates` needs no repo change.
- **`cached-tsc.mjs`**, **`cost-meter.mjs`/`session-warmth.mjs`**, **`B1-harvester`**, **`DetectorContext`
  fetchers** — reuse these existing seams rather than inventing parallels.
