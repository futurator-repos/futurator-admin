# Pipeline v2.5 — Concept Stage v2 + VQA/QA-Review v3 — Epic & Story Breakdown

**Author:** Richie
**Date:** 2026-06-16
**Project Level:** 3–4 (method → enterprise; two merged PRDs, cross-session-coordinated)
**Target Scale:** 13 epics / 72 stories / 6 waves
**Workflow:** BMAD `create-epics-and-stories` (merged decomposition)

**Source PRDs (both required):**

- `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` (v0.6) — Concept stage: PM role, Plan/Epic/Story + AcceptanceCriterion schema, Router, artifacts, gate. §9 = 5 Slices.
- `docs/concepts/pipeline-v3/vqa-qa-review-prd.md` (v1.2) — VQA/QA-Review: probe grammar, seam, oracle, fix loop. **§11.1 = canonical epic list; §11 Hardening OVERRIDES §5.**

---

## ⏱️ Implementation status — handoff (2026-06-16)

> **Read this first.** One session built the entire **pure-logic spine** + the **two live API integrations** + the **one data-backed UI**. Everything still open is **daemon-runtime / live-MCP / daemon-data-blocked-UI** — best continued in an environment where the daemon and/or a frontend dev server can actually run, not blind from the repo. All work below is on branch `feat/treesitter-slice-c-brownfield-bootstrap`; every commit is independently shippable, typecheck-clean for its own files, ~245 tests green. (The branch carries 61 **pre-existing** tsc errors in `agent-job-state-machine.ts` et al. — unrelated to this work; clear before `npm run ci`/deploy.)

**Legend:** ✅ done+tested · 🟡 cores done, tails deferred · ⛔ not started · _(deferred reason)_

| Epic                                                  | Status | Commit                            | Done                                                                                                                                                                                                                                                                       | Deferred (and why)                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** Shared AC/Story schema + W4 persist            | ✅     | `5152621`                         | E1.1–E1.5 (all)                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                               |
| **E2** Interaction grammar & deterministic time       | ✅     | `26775fc`                         | E2.1–E2.5 (all)                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                               |
| **E3** Enriched decomposition → DEV (+ collision fix) | ✅     | `5258836`                         | E3.1–E3.5; E3.6 by composition                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                               |
| **E4** Section-addressable artifacts (W1+W2+W3)       | ✅     | `09391fe`                         | E4.1–E4.4 (all)                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                               |
| **E5** Verifiability seam & L2-state oracle           | 🟡     | `bd3f31e`                         | E5.1 (type), E5.3 (assert oracle), E5.4 (R1 cap-split)                                                                                                                                                                                                                     | E5.2 ship `__harness` in canvas-game scaffold _(scaffold files)_; E5.5 seam tamper-check in `story-pipeline.ts` _(daemon)_; E5.6 state-AND-appearance pairing _(lands with E11.5)_                                                                              |
| **E6** Shared verdict + `(level×verdict)→block`       | 🟡     | `60d7baa`                         | E6.2 (verdict vocab), E6.3 (block rule); E6.1 grammar via E2.1                                                                                                                                                                                                             | E6.4 evidence-drawer rendering _(UI; richer payloads)_                                                                                                                                                                                                          |
| **E7** Concept Router + architecture artifact         | 🟡     | `5c0122b` + integration `394c227` | E7.1 (Router contract+prompt+pipeline+bypass), E7.4 (arch-gen prompt+pipeline), E7.7 (pack inlines cited sections), E7.8 (PM references); **+ live wiring: enqueue concept-route at plan creation + `POST /api/plans/:id/apply-concept-plan` persists `plan.conceptPlan`** | E7.2 route-confirm endpoint; E7.3/E7.5 graph complexity+grounding _(live Mycelium-MCP)_; E7.6 daemon promote-on-Approve _(free-agent session)_; the **route→arch→pm-plan SEQUENCE** _(needs a job-chain orchestrator — none exists; pm-plan is still one-shot)_ |
| **E8** QA Authorship & level-setting                  | ⛔     | —                                 | —                                                                                                                                                                                                                                                                          | all _(daemon `story-pipeline.ts`; the QA-AUTHOR persona derives `manual` ACs + compiles probes — this is what unblocks the E11 manual lane UI)_                                                                                                                 |
| **E9** Readiness gate (solutioning-gate-check)        | ✅     | `8e76623`                         | E9.1–E9.4 + E9.5 route↔AC (W7c); **wired into `POST /api/plans/:id/start`**                                                                                                                                                                                                | E9.5 blast-radius scope cross-check _(live MCP)_; reference set-membership at start defers to decompose-time (Lambda can't read EC2 manifests — by design)                                                                                                      |
| **E10** Closed agentic fix loop                       | ⛔     | —                                 | —                                                                                                                                                                                                                                                                          | all _(daemon `wave-vqa-runner.mjs`)_                                                                                                                                                                                                                            |
| **E11** Human-in-the-loop & generality                | ⛔     | —                                 | —                                                                                                                                                                                                                                                                          | E11.1/E11.2 manual operator lane **blocked on E8** _(qa-report carries no per-AC `verify`/manual data yet — building the lane now = a shell with no producer)_; rest daemon/driver                                                                              |
| **E12** PRD/UX artifacts & Concept rail UI            | 🟡     | `15a9e72`                         | E12.4 Concept rail (renders persisted `conceptPlan`, wired into PlanReviewView)                                                                                                                                                                                            | E12.1/E12.2 prd-gen/ux-gen jobs _(daemon)_; E12.3 log envelope, E12.5 convergence chat, E12.6 timeout/immutability, E12.7 traceability overlay _(UI + daemon free-agent)_                                                                                       |
| **E13** Wave-gate evidence rewrite                    | ⛔     | —                                 | —                                                                                                                                                                                                                                                                          | all _(daemon `wave-vqa-runner.mjs` agentic→programmatic rewrite — biggest single lift, OQ3)_                                                                                                                                                                    |

### Suggested next session (in a daemon-capable environment)

1. **E8 (QA-AUTHOR)** — highest leverage: it's the cross-PRD convergence point, and it **unblocks the E11 manual lane UI** (once it populates `manual` ACs into the qa-report). Pure-ish daemon logic over the now-shipped `verify`/BDD schema + the E5.4 `deriveLevelFromVerify`/`capVisionLevelByRigor` helpers + the E5.3 assert oracle.
2. **E7 sequence + arch-gen execution** — wire route→arch→pm-plan as a job chain (SKILL-SCOUT FK-gating is the model), run `generateArchGenPipeline`, write the manifest via `generateSectionManifest` (E4.1), feed `citableSections` into `buildPmPlanPrompt` (E7.8 already accepts them).
3. **E5.2 + E5.5** — ship `__harness` in the `nextjs-canvas-game` scaffold + the seam tamper-check, so the E5.3 assert oracle has something real to read.

**Reusable primitives already shipped for the above:** `section-manifest.ts` (E4.1), `artifact-version.ts` (E4.4 cascade + the E7.6 two-phase-commit contract), `concept-route-service.ts` (apply pattern), `solutioning-gate.ts` (E9), `probe-verdict.ts` (E6.3), the `verify`/`manualReason` schema (E1), the probe grammar + `assert` interpreter (E2/E5.3).

---

## Overview

This document decomposes **two cross-session-coordinated PRDs into one unified epic/story plan**. The PRDs meet at the **`AcceptanceCriterion`**: the Concept PM authors the BDD claim + `verify` intent; the VQA QA-AUTHOR compiles it into an executable probe. Coordination rounds 1–3 are **CLOSED** (Concept §13 / VQA §11 H12) — the schema, the `manualReason` 8-enum, and the shared section/harness manifest formats are **locked** on both sides.

**Decomposition rules applied (BMAD `create-epics-and-stories`):**

- Stories sized for a **single dev-agent session**; vertically sliced; no forward dependencies.
- BDD acceptance criteria (`Given/When/Then`) + the project's own `verify` intent (dogfooding the model under construction).
- **Touch Points** declared per story (feeds the existing wave-conflict resolver — Futurator keeps its waves; BMAD has none).
- **Forbidden Areas** where a story must not stray (feeds the reviewer's `scope-forbidden` check).
- Epic 1 establishes the **shared schema foundation** both PRDs build on.

**What is reused, not rebuilt** (Concept §2, verified in code): DynamoDB `Plan/Epic/Story`, the wave engine, the Story Context Pack, `forbiddenAreas`→scope check, `workSummary`/`prevWorkSummaries`, `VisualTestDef`. We **extend**; we do not replace.

### System-Graph integration (Pipeline v3 — now live, consume don't rebuild)

A parallel initiative — the **System Graph** (`docs/epics-system-graph.md`, 7 epics; Epics 1–6 **shipped**, Epic 7 finishing) — extended Mycelium from a code graph into a _system_ graph and shipped the **Mycelium-MCP** (`blast_radius`, `query_graph`, `god_nodes`, `shortest_path`, `orphans`) plus **`<ground_truth>` blast-radius injection into the DEV loop** (system-graph Story 4.4). This plan **consumes** that substrate; it does not duplicate any extractor or MCP work.

**Hard coordination — the Story Context Pack collision (MUST fix):** three initiatives now mutate the **same DEV-context surface**, each under a byte-identical determinism contract:

- system-graph **4.4** — injects `blast_radius` `<ground_truth>` (`daemon/pipelines/compiler-prompt.md` + AST-facts injection module) — **already live**;
- Concept **E3** — BMAD story fields in `normalizeStorySpec`/`serializeStoryContextPack`/`dev-subagent-prompt.md.tpl`, `STORY_CONTEXT_PACK_VERSION→2`;
- VQA **E8 / H9** — probe/seam section in `story-context-pack.mjs`.

Landed blind they clobber each other and break pack-cache stability. **E3 gains a reconciliation story** (one serializer; fixed section order: graph `<ground_truth>` → BMAD story fields → probe/seam section; single version bump covering all three). This is a blocking dependency, not a note.

**Graph-consuming additions folded in below:**

- **E7-A** — `arch-gen` (Winston) queries the graph to **ground `architecture.md` in real structure** (esp. brownfield `change` plans); makes `references[].source:'architecture'` cite true structure, not a guess.
- **E7-B** — Concept Router derives `complexity` from `blast_radius` size / god-nodes for `kind:'change'` (the graph _is_ the "project knowledge index" the Router already reads).
- **E9-A** — the readiness gate cross-checks declared `touchPoints`/`forbiddenAreas` against `blast_radius(touchPoints)` — catches under-scoped stories + auto-suggests forbidden areas.
- **E11-A** — QA-AUTHOR uses `externalService` (`costModel.billable`) nodes to discover boundaries a story crosses → test-mode stub vs. `manual` (partially automates `no-stub-possible`).

All four hard-depend on **system-graph Epics 1–6** (live) and degrade gracefully on cold Memgraph (the cascade already falls back to `ast-extract`+grep).

### Epic Summary

| #   | Epic                                     | Source                 | Value delivered                                                                                                     | Stories | Depends on                 | Wave |
| --- | ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------- | ---- |
| E1  | Shared AC & Story Schema Foundation      | Concept Slice 1(a,b)   | The contract both sessions build on: `verify`/BDD/`manualReason` + persist works                                    | 5       | —                          | W1   |
| E2  | Interaction Grammar & Deterministic Time | VQA E1                 | Probes can `reach→act→observe` over controlled time (no Concept dep)                                                | 5       | —                          | W1   |
| E3  | Enriched Decomposition & DEV Context     | Concept Slice 1(c,d,e) | Richer stories reach the DEV agent (PM graft + pack render + plumbing) **+ pack-collision reconciliation**          | 6       | E1, **SysGraph 4.4**       | W2   |
| E4  | Section-Addressable Artifacts            | Concept Slice 2        | `references[]` + harness become resolvable: manifest, budget waterfall, versioning                                  | 4       | E1                         | W2   |
| E5  | Verifiability Seam & L2-State Oracle     | VQA E2                 | Deterministic state oracle: `RuntimeContract`/`__harness`, rigor-cap split, tamper-check                            | 6       | E4 (harness schema)        | W3   |
| E6  | Shared Probe Engine & Verdict            | VQA E3                 | One grammar/types + one verdict vocab + `(level×verdict)→block` rule                                                | 4       | E2, E5                     | W3   |
| E7  | Concept Router & Architecture Artifact   | Concept Slice 3        | Dynamic artifact routing + `architecture.md` as the consistency contract **(graph-grounded)**                       | 8       | E4, **SysGraph 1–6**       | W3   |
| E8  | QA Authorship & Level-Setting            | VQA E4                 | QA-AUTHOR compiles probes from ACs; derives L-level; pack carries probes                                            | 6       | E1, E4, E5, E6             | W4   |
| E9  | Readiness Gate (solutioning-gate-check)  | Concept Slice 4        | Semantic Start-development gate: coverage, reference-resolution, `manual`-flag **+ blast-radius scope cross-check** | 5       | E3, E4, E7, **SysGraph 4** | W4   |
| E10 | Closed Agentic Fix Loop                  | VQA E5                 | "Fix until tests pass" is real & un-gameable: triage, frozen oracle, flake-guard                                    | 5       | E5, E6                     | W4   |
| E11 | Human-in-the-Loop & Platform Generality  | VQA E6                 | `manual` operator lane + `manualReason` + test-mode seams **(graph-discovered boundaries)** + state-AND-appearance  | 7       | E1, E8, **SysGraph 1–6**   | W5   |
| E12 | PRD/UX Artifacts & Concept Rail UI       | Concept Slice 5        | Full artifact chain + the pipeline-rail UI + per-agent auditable logs                                               | 7       | E7, E9                     | W5   |
| E13 | Wave-Gate Evidence Rewrite (E7-arch)     | VQA E7-arch            | Replace daemon agentic-LLM evidence with programmatic probe runner (biggest lift)                                   | 4       | E6                         | W6   |

**Totals:** 13 epics · **72 stories** · 6 waves. **Bold deps** = hard dependency on the live System Graph. The 5 graph-consuming stories are **E3.5** (pack-collision reconcile), **E7.3** (router complexity), **E7.5** (arch grounding), **E9.5** (gate scope cross-check), **E11.4** (boundary discovery).

### Sequencing rationale

- **W1 (foundation, parallel):** **E1** (shared AC/Story schema + the W4 persist fix) ∥ **E2** (VQA interaction grammar). These are the **ship-together pair** — the probe-from-AC payoff only appears once both land. Both are leaf dependencies. E1's apply-mapper fix (W4) is the "make enrichment non-inert" gate.
- **W2 (Concept consumption + primitives):** **E3** renders the richer stories into the DEV context (proves richer-stories→richer-DEV-context). **E4** builds the two load-bearing primitives — the **section manifest** (W2) and **artifact versioning** (W1) — that everything citing `references[]`/harness depends on, including VQA E8.
- **W3 (oracle + engine + routing):** **E5** (seam + L2-state oracle, consumes E4's `__harness.schema.json`), **E6** (shared probe engine), **E7** (Concept Router + `architecture.md`, consumes E4's manifest).
- **W4 (authoring + gates):** **E8** (QA-AUTHOR — the cross-PRD convergence point), **E9** (Concept readiness gate), **E10** (fix loop).
- **W5 (HITL + UI):** **E11** (`manual` lane + generality), **E12** (PRD/UX + Concept rail UI).
- **W6 (deferred arch lift):** **E13** (wave-gate evidence rewrite) — explicitly budgeted, biggest single lift; non-blocking until it lands (VQA OQ3).

> **Cross-PRD coordination already CLOSED** (do not re-litigate): W5 (`manual→behavior` downgrade owned by E8/QA-AUTHOR), `manualReason` 8-enum (E1 validates, E11 displays), W2 manifest format (E4 emits, E8 reads), W9 appearance floor (E9 + E11), `needsBrowser` one-rule (derived for build/appearance/state/behavior, explicit for `manual`).

---

## Epic E1 — Shared AC & Story Schema Foundation

**Goal (value):** Ship the single contract both PRDs build on — the `verify` intent, BDD `given/when/then`, the `manualReason` 8-enum, and the four BMAD story fields — **and make the persist path actually carry them** (the W4 no-op fix). Until enrichment survives `applyPlanOutput`, every downstream epic is decorating a field that gets dropped at write time. All fields optional → legacy plans and `prototype` runs are byte-unaffected.

### Story E1.1: Extend `AcceptanceCriterion` with BDD + verify intent

As a PM agent,
I want `AcceptanceCriterion` to carry structured BDD + a `verify` intent alongside the legacy `text`,
So that the QA-AUTHOR can compile a probe from the claim and the gate can reason about verifiability.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the `AcceptanceCriterion` type, **When** an AC sets `given/when/then/thenObservable` + `verify ∈ {build,appearance,state,behavior,manual}`, **Then** it typechecks and the Zod schema `.safeParse()` accepts it (all new fields `.optional()`).

**AC2** `verify:build` — **Given** a `manual` AC, **When** parsed without `manualReason`, **Then** validation fails; **Given** `manualReason` from the closed 8-enum (`real-payment|oauth-consent|captcha|native-device|email-sms-loop|subjective-quality|video-audio-perception|no-stub-possible`), **Then** it passes.

**AC3** `verify:build` — **Given** a legacy flat-`text` AC (no BDD fields), **When** parsed, **Then** it still validates (back-compat).

**Prerequisites:** None (first story).

**Touch Points:**

- `functions/shared/types/epic-workflow.ts` (`AcceptanceCriterion` :80)
- `src/types/epic-workflow.ts` (mirror)
- `functions/shared/schemas/plan-output-schema.ts` (Zod AC shape)
- `functions/shared/schemas/__tests__/plan-output-schema.test.ts`

**Forbidden Areas:** existing `{id,text,needsBrowser}` field semantics (additive only — do not rename/remove); `daemon/pipelines/lib/story-context-pack.mjs` (E3 owns the serializer).

**Technical Notes:** `needsBrowser` stays authoritative for now (W12 — defer derivation). `then` is prose-observable; no seam expressions here. Enum lives in one shared const re-exported to both type files.

### Story E1.2: Extend `EpicStory` + `EpicWorkflow` with BMAD-grade fields

As a PM agent,
I want stories to carry `userStory/technicalNotes/tasks/references` and epics to carry `goal/requirementRefs`,
So that the definition reaches BMAD grade and traceability has a spine.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** `EpicStory`, **When** it sets `userStory{role,action,benefit}`, `technicalNotes`, `tasks: StoryTask[]` (`{id,text,acRefs[],done?}`), `references: StoryReference[]` (`source ∈ {prd,architecture,ux,harness}`, `section`, `note?`), **Then** it typechecks and Zod accepts it.

**AC2** `verify:build` — **Given** `EpicWorkflow`, **When** it sets `goal` + `requirementRefs[]`, **Then** it typechecks and Zod accepts it.

**AC3** `verify:build` — **Given** legacy stories/epics without these fields, **When** parsed, **Then** they still validate.

**Prerequisites:** E1.1.

**Touch Points:**

- `functions/shared/types/epic-workflow.ts` (`EpicStory` :219, `EpicWorkflow` :283)
- `src/types/epic-workflow.ts` (mirror)
- `functions/shared/schemas/plan-output-schema.ts`
- `functions/shared/schemas/__tests__/plan-output-schema.test.ts`

**Forbidden Areas:** existing `forbiddenAreas`/`touchPoints`/`complexity`/`workSummary` fields (reused as-is, §2 — do not touch).

**Technical Notes:** `StoryTask`/`StoryReference` are new exported interfaces. Keep `references` a closed-`source` union now; the `section` set-membership validation lands in E4 (manifest), not here.

### Story E1.3: [W4] Make enrichment survive `applyPlanOutput`

As a plan-generation service,
I want the apply mappers to copy every new field from `PLAN_JSON` onto the persisted rows,
So that enrichment is not silently dropped at write time (the W4 no-op).

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `PLAN_JSON` carrying BDD ACs + `userStory/tasks/references/technicalNotes` + epic `goal/requirementRefs`, **When** `applyPlanOutput` runs, **Then** the persisted Story/Epic/AC rows carry all of them (integration test reads them back from the repository).

**AC2** `verify:behavior` — **Given** persisted enriched rows, **When** `epicsToPlanOutput` round-trips them back to `PLAN_JSON`, **Then** no new field is lost (symmetric mapper).

**AC3** `verify:build` — **Given** a legacy `PLAN_JSON` with no new fields, **When** applied, **Then** it persists unchanged (no `.strict()` breakage).

**Prerequisites:** E1.1, E1.2.

**Touch Points:**

- `functions/shared/repositories/plan-generation-service.ts` (`applyPlanOutput` :287–302, `epicsToPlanOutput` :205–209)
- `functions/shared/repositories/__tests__/plan-generation-service.test.ts`

**Forbidden Areas:** the DynamoDB table schema / key structure (additive attributes only; multi-table preserved).

**Technical Notes:** This is the W4 blocker — the highest-leverage story in E1. The mappers copy a hardcoded field set today; extend both directions. Verify with a real round-trip, not a unit stub.

### Story E1.4: `conceptInteraction` plumbing on the Plan [W11]

As an operator,
I want a per-plan `conceptInteraction` field with a resolver and a sane default,
So that the interactivity axis has type/schema/default plumbing before any behavior depends on it.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the Plan type + create-schema, **When** a plan sets `conceptInteraction ∈ {interactive,autopilot}` (optional), **Then** it typechecks and validates.

**AC2** `verify:build` — **Given** `resolveConceptInteraction(plan)`, **When** the field is absent, **Then** it returns `autopilot` for `rigor:'prototype'` and `interactive` for `mvp`/`production` (the documented default); when present, the explicit value wins.

**Prerequisites:** None (independent plumbing; can run parallel to E1.1–E1.3).

**Touch Points:**

- `functions/shared/types/plan.ts`
- `functions/shared/schemas/plan-output-schema.ts` (create-schema)
- `functions/shared/plan/resolve-concept-interaction.ts` (new helper)
- `functions/shared/plan/__tests__/resolve-concept-interaction.test.ts`

**Forbidden Areas:** any concept-stage behavior (this story is plumbing only — no artifact jobs, no gate change).

**Technical Notes:** No behavior change yet (E12 consumes it). Immutability-after-start is enforced later (E12/W10).

### Story E1.5: AC `verify` authoring rules in `buildPmPlanPrompt` (idle-visible relaxation)

As a PM agent,
I want the decompose prompt to set `verify` correctly and apply the relaxed idle-visible rule,
So that appearance ACs stay load-visible while behavior/state ACs may describe post-interaction state (resolves the one cross-session collision).

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the PM prompt, **When** rendered, **Then** it instructs: `appearance` ⇒ AC MUST be idle-visible (no "click to see"); `behavior|state` with `when/then` ⇒ MAY describe a post-interaction state.

**AC2** `verify:behavior` — **Given** a UI-bearing intent, **When** the PM emits a plan, **Then** every `needsBrowser` AC carries a `verify` value and no behavior AC is contorted into a load-frame description (golden-output assertion).

**Prerequisites:** E1.1.

**Touch Points:**

- `functions/shared/prompts/pm-plan-prompt.ts` (idle-visible rule :282–293)
- `functions/shared/prompts/__tests__/pm-plan-prompt.test.ts`

**Forbidden Areas:** the existing value-named-epics / vertical-slicing / wave / touch-point rules (graft alongside; do not rewrite). The `userStory/tasks/references` graft is E3 — keep this story to `verify` + idle-visible only.

**Technical Notes:** This is the §5 relaxation that reverses v0.2 and resolves VQA §9 Q3. Pair-test against an `appearance` and a `behavior` AC.

---

## Epic E2 — Interaction Grammar & Deterministic Time (VQA E1)

**Goal (value):** Make probes able to `reach → act → observe` over controlled time. Today only `navigate|click|wait|screenshot|fill` exist; this adds the full action grammar + deterministic `page.clock` + un-stales the judge prompt. No Concept dependency — landable immediately, in parallel with E1. The ship-together payoff with E1 appears once both land.

### Story E2.1: Extend the `ProbeStep` action grammar (types + parser)

As a QA-AUTHOR,
I want the full action grammar in the type union and Zod parser,
So that probes can express keyboard, pointer, time, and assertion steps.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the `ProbeStep.action` union, **When** a step uses `press` with `key:'Space'`, **Then** it typechecks and the Zod parser accepts it. (Grammar adds `press,hold,tap,pointer,clock,select,drag,assert,seed` + fields `key,x,y,ms,expr,op,expected`.)

**AC2** `verify:build` — **Given** legacy specs using `navigate|click|wait|screenshot|fill`, **When** parsed, **Then** they still validate (back-compat).

**AC3** `verify:build` — **Given** H10 grammar gaps, **When** the union is defined, **Then** it also includes `viewport{w,h}`, `upload`, `download`, `network:'offline'`, and continuous-gesture `stroke[]` (typed now; interpreter support may be deferred per-story).

**Prerequisites:** None.

**Touch Points:**

- `functions/shared/types/epic-workflow.ts` (`VisualTestFlowStep` :106–119)
- `functions/shared/schemas/` (probe-step Zod)
- `functions/shared/__tests__/probe-grammar.test.ts`

**Forbidden Areas:** the interpreter (`runFlow`) — types/parser only here; execution is E2.2.

**Technical Notes:** Keep the grammar **driver-agnostic** (NFR/FR-29) — no Playwright types in the grammar. `assert` carries `{expr, op, expected}` for the L2-state oracle (E5 consumes it).

### Story E2.2: Interpreter executes the new actions

As a probe runner,
I want `runFlow` to dispatch the new actions to the driver,
So that a probe physically drives the app.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a game route, **When** a probe runs `press Space → wait → screenshot`, **Then** the captured frame shows the post-press state (integration test).

**AC2** `verify:behavior` — **Given** a `clock` step of 5000ms, **When** run, **Then** time-dependent UI advances deterministically with no real wall-clock wait (uses `page.clock` install/fastForward/runFor, not `waitForTimeout`).

**Prerequisites:** E2.1.

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (`runFlow` :146–167, :553–573)
- `functions/shared/pipelines/__tests__/visual-qa-pipeline.flow.test.ts`

**Forbidden Areas:** the verdict/judge logic (E2.4 / E6); capture path beyond the new actions.

**Technical Notes:** `press→keyboard.press`, `pointer→mouse.click(x,y)`, `clock→page.clock`, `select/drag` to their Playwright equivalents — but routed through a thin driver seam so the native driver (deferred) can swap in.

### Story E2.3: Deterministic time via `page.clock` (NFR-1)

As a probe author,
I want time-dependent probes to use installed clock control,
So that spawn/decay/animation timing is reproducible and flake-free.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a probe with `clock: install` then `runFor: 3000`, **When** executed, **Then** a time-gated UI element appears deterministically across 5 consecutive runs (no flake).

**AC2** `verify:build` — **Given** any probe using `wait`, **When** linted, **Then** synchronization via `waitForTimeout` is flagged (NFR-1: no timeout-as-sync).

**Prerequisites:** E2.2.

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (clock integration)
- `functions/shared/pipelines/__tests__/visual-qa-pipeline.clock.test.ts`

**Forbidden Areas:** none beyond the above.

**Technical Notes:** Clock control is the substrate the E10 flake-guard (H2) relies on; keep it explicit, not implicit.

### Story E2.4: Un-stale the vision-judge prompt for interacted probes (FR-5)

As a QA Review pipeline,
I want the L2-vision judge told that frames are captured **after** interactions,
So that it can FAIL a contradicted post-action frame instead of excusing it as "idle/flow not executed."

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an interacted probe, **When** the L2-vision judge runs, **Then** its prompt states frames are post-interaction and MAY FAIL on dynamic state (the stale "flow NOT executed / idle" note is gone).

**Prerequisites:** E2.2.

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (judge prompt :719, :819)
- `functions/shared/pipelines/__tests__/visual-qa-pipeline.judge.test.ts`

**Forbidden Areas:** the verdict vocabulary (E6 unifies it).

**Technical Notes:** Small but load-bearing — the stale note is a documented false-negative source (E4 disease).

### Story E2.5: Document the grammar to authors (FR / E1-S3)

As a DEV/QA-AUTHOR,
I want a worked multi-step `flow:` example in the prompt template,
So that authored probes use the new grammar correctly.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the DEV/QA-AUTHOR prompt template, **When** rendered, **Then** it contains a worked `press/click/wait/assert` multi-step example with a `clock` step.

**Prerequisites:** E2.1.

**Touch Points:**

- `daemon/pipelines/templates/` (DEV/QA-AUTHOR prompt)
- corresponding template test

**Forbidden Areas:** the Story Context Pack serializer (E3/E8).

**Technical Notes:** Keep the example driver-agnostic and copy-pasteable.

---

## Epic E3 — Enriched Decomposition & DEV Context

**Goal (value):** Get the richer stories from E1 all the way to the DEV agent's eyes — graft the BMAD fields into the PM prompt, carry+render them through the Story Context Pack, and **reconcile the pack with the live system-graph `<ground_truth>` injection** so three writers don't clobber one serializer. Proves richer-stories → richer-DEV-context with no upstream artifacts yet.

### Story E3.1: Graft user-story + technicalNotes + tasks into `buildPmPlanPrompt`

As a PM agent,
I want to emit the user-story triple, technical notes, and AC-mapped tasks per story,
So that stories reach BMAD grade (references come later, in E7).

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the PM prompt, **When** rendered for `mvp`/`production`, **Then** it instructs emission of `userStory{role,action,benefit}`, `technicalNotes`, and `tasks[]` with `acRefs` mapping to AC ids.

**AC2** `verify:behavior` — **Given** an `mvp` intent, **When** the PM emits a plan, **Then** each story carries a user-story triple and ≥1 task whose `acRefs` resolve to real AC ids in the same story (golden-output assertion). **Given** `prototype`, **Then** tasks/references are omitted (purity).

**Prerequisites:** E1.2, E1.5.

**Touch Points:**

- `functions/shared/prompts/pm-plan-prompt.ts`
- `functions/shared/prompts/__tests__/pm-plan-prompt.test.ts`

**Forbidden Areas:** `references[]` emission (E7 — needs the manifest first); the idle-visible/`verify` rules (E1.5, already landed).

**Technical Notes:** Rigor-gated: `prototype` stays byte-identical to today.

### Story E3.2: Carry the new fields through `normalizeStorySpec`

As the Story Context Pack,
I want `normalizeStorySpec` to carry the BDD ACs + `userStory/technicalNotes/tasks/references`,
So that the choke point stops silently dropping them.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an enriched story row, **When** `normalizeStorySpec` runs, **Then** the normalized spec includes `given/when/then` on ACs plus `userStory/technicalNotes/tasks/references` (today it carries only `{id,title,description,acceptanceCriteria{id,text,needsBrowser},touchPoints,hasBrowserTests,wave}`).

**Prerequisites:** E1.3 (fields must persist first).

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (`normalizeStorySpec` :628)
- `daemon/pipelines/lib/__tests__/story-context-pack.test.mjs`

**Forbidden Areas:** the determinism contract (sorted, no timestamps) — carry fields in fixed order; do not introduce nondeterminism.

**Technical Notes:** Pure carry here; rendering is E3.3. Ships atomically with E3.3+E3.4 (one commit) to keep the pack coherent.

### Story E3.3: Render the new fields in `serializeStoryContextPack` + DEV template

As a DEV agent,
I want the pack to render the user-story header, Given/When/Then ACs, a Tasks sub-list, and a Technical Notes block,
So that I read the contract, not just a path.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a normalized enriched spec, **When** `serializeStoryContextPack` runs, **Then** the Story-spec section renders the user-story one-liner, ACs as `Given/When/Then` (fallback to `text` when absent), a Tasks sub-list, and a Technical Notes block — byte-identical across DEV/REVIEWER/COMPILER roles.

**AC2** `verify:behavior` — **Given** the DEV subagent template, **When** rendered, **Then** it surfaces tasks + technical notes (today it shows ACs + `{{contextDigest}}` only).

**Prerequisites:** E3.2.

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (`serializeStoryContextPack` :253)
- `daemon/pipelines/templates/dev-subagent-prompt.md.tpl`
- `daemon/pipelines/lib/__tests__/story-context-pack.serialize.test.mjs`

**Forbidden Areas:** the byte-identical cross-role guarantee (assert it in the test).

**Technical Notes:** Fixed field order, sorted maps. Falls back to flat `text` for legacy ACs (R2).

### Story E3.4: [W12] Bump `STORY_CONTEXT_PACK_VERSION`

As the pack cache,
I want a single version bump covering the new serializer shape,
So that stale-cached packs from the old shape are invalidated once.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the serializer change, **When** the version constant is read, **Then** `STORY_CONTEXT_PACK_VERSION` is bumped (→2) and the intra-story cross-role identity invariant still holds.

**Prerequisites:** E3.3.

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (`STORY_CONTEXT_PACK_VERSION` :30)
- version-invariant test

**Forbidden Areas:** none.

**Technical Notes:** One-time warm cost; the real invariant is intra-story cross-role identity, not cross-run stability.

### Story E3.5: [COLLISION] Reconcile the pack with system-graph `<ground_truth>` injection

As a DEV context assembler,
I want one serializer that emits graph `<ground_truth>`, the BMAD story fields, and (later) the probe/seam section in a fixed order,
So that the three initiatives writing the DEV context never clobber each other or break pack-cache stability.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** the live system-graph `blast_radius` `<ground_truth>` injection (system-graph Story 4.4) **and** the E3 BMAD-field rendering, **When** the DEV context is assembled, **Then** both appear in a single deterministic document with a declared section order (`<ground_truth>` → story-spec/BMAD fields → [probe/seam, reserved for E8]) and the byte-identical cross-role guarantee holds.

**AC2** `verify:behavior` — **Given** a cold Memgraph (no graph facts), **When** the context assembles, **Then** the `<ground_truth>` block degrades to `ast-extract`+grep (existing fallback) and the BMAD fields still render — no crash, deterministic output.

**AC3** `verify:build` — **Given** the reserved probe/seam slot, **When** E8 lands its section, **Then** it slots in without reordering the others (one version bump already spent in E3.4 covers the reserved slot).

**Prerequisites:** E3.3, E3.4; **system-graph Story 4.4 (live)**.

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (serializer section ordering)
- `daemon/pipelines/compiler-prompt.md` / DEV context-assembly module (the `<ground_truth>` seam from 4.4)
- `daemon/pipelines/lib/__tests__/story-context-pack.reconcile.test.mjs`

**Forbidden Areas:** the system-graph blast-radius query itself (consume its output; do not re-implement); the Knowledge Compiler's semantic wiki generation.

**Technical Notes:** This is the must-fix collision flagged in the Overview. Coordinate the section contract with the VQA E8/H9 owner so the reserved probe slot matches what they emit. Verify against a real assembled context, not a unit stub.

### Story E3.6: End-to-end verification — enriched plan renders in the DEV prompt

As a pipeline operator,
I want a single run that proves persist + render together,
So that the W4+W12 fixes are validated as one path, not two units.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a fresh `mvp` plan, **When** it is generated, persisted, and a story is dispatched, **Then** the DEV prompt renders Given/When/Then ACs + tasks + technical notes sourced from the persisted rows (proves E1.3 persist + E3.3 render in one flow).

**AC2** `verify:behavior` — **Given** a `prototype` plan, **When** dispatched, **Then** the DEV prompt is byte-identical to today's (no BMAD fields, R4 purity).

**Prerequisites:** E3.1–E3.5.

**Touch Points:**

- `daemon/pipelines/__tests__/enriched-plan-e2e.test.mjs` (new integration test)

**Forbidden Areas:** none (test-only story).

**Technical Notes:** The Slice-1 acceptance gate from Concept §9. If this passes, the foundation slice is real.

---

## Epic E4 — Section-Addressable Artifacts

**Goal (value):** Make `references[]` and the harness seam **resolvable**, not decorative — the two load-bearing primitives (W2 section manifest + W1 versioning) plus the W3 budget waterfall. This is the shared format VQA's QA-AUTHOR (E8) also reads. Must precede any epic that wires `references[]` (E7, E9).

### Story E4.1: [W2] Generators emit a stable section manifest + anchors

As an artifact generator,
I want each `.md` to ship a `<artifact>.sections.json` sidecar + `<!--§id-->` anchors,
So that a `references[].section` resolves deterministically by line range.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** a generated `architecture.md`, **When** the generator finishes, **Then** it writes `architecture.sections.json = {artifact, rev, contentHash, sections:[{id,title,lineStart,lineEnd}]}` and mirrors each `id` as `<!--§id-->` immediately above its heading.

**AC2** `verify:build` — **Given** `resolveSection(md, id)`, **When** called, **Then** it returns the `lineStart..lineEnd` slice with **no regex** (deterministic).

**AC3** `verify:build` — **Given** a section that persists across an edit, **When** the artifact is regenerated, **Then** its `id` is unchanged (ids are immutable slugs where the section persists).

**Prerequisites:** E1.2 (the `references` type exists).

**Touch Points:**

- `functions/shared/concept/section-manifest.ts` (new — emit + `resolveSection`)
- `functions/shared/concept/__tests__/section-manifest.test.ts`

**Forbidden Areas:** the artifact-gen agents themselves (E7/E12 wire them; this story is the manifest primitive only).

**Technical Notes:** This format is **locked and shared** with VQA (Concept §6.2 / VQA §11 H9). The VQA probe-compiler reads the same sidecar — do not diverge the shape. Co-author with the VQA E8 owner if anything changes.

### Story E4.2: [W2] Validate `references[].section` as set-membership

As the decompose + gate path,
I want `references[].section` validated against the manifest's id set,
So that a citation can never silently dangle.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** a story `reference` citing `architecture#error-handling`, **When** validated at decompose (`plan-output-schema`), **Then** it passes iff `error-handling ∈ manifest.ids`, else it's a validation error (not an `.optional()` free string).

**AC2** `verify:behavior` — **Given** a plan whose reference cites a non-existent section, **When** persisted, **Then** the write is rejected with a clear error naming the bad reference.

**Prerequisites:** E4.1.

**Touch Points:**

- `functions/shared/schemas/plan-output-schema.ts` (reference validation)
- `functions/shared/schemas/__tests__/plan-output-schema.references.test.ts`

**Forbidden Areas:** the §8 gate (E9 wires the gate-side membership check; this is the decompose-side one).

**Technical Notes:** Same predicate reused by E9's gate. Harness references (`source:'harness'`) validate against `__harness.schema.json` keys (E5 ships that schema; gate cross-check is in E9).

### Story E4.3: [W3] Priority-waterfall pack budget

As the Story Context Pack,
I want a non-trimmable floor for story-spec + cited sections, with digests taking the remainder,
So that budget pressure never silently drops the inlined contract (the whole point of W2).

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a 30k-token budget under pressure, **When** the pack assembles, **Then** story-spec + cited `references[].section` slices are allocated **first** (non-trimmable floor) and file digests take only the remainder.

**AC2** `verify:behavior` — **Given** cited sections that alone bust the floor, **When** assembly runs, **Then** it **blocks** with `references-over-budget` rather than silently dropping a citation.

**Prerequisites:** E4.1; E3.3 (serializer exists).

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (budget logic :215–239; `DEFAULT_TOKEN_BUDGET` :39)
- `daemon/pipelines/lib/__tests__/story-context-pack.budget.test.mjs`

**Forbidden Areas:** the byte-identical determinism contract.

**Technical Notes:** Today the only lever is digest-trim — under pressure it drops the architecture contract. Invert to a waterfall. Coordinate with VQA H9 (protect probe bytes before digests) — same floor, shared ordering.

### Story E4.4: [W1] Artifact versioning + approved→stale cascade

As the concept rail,
I want `{rev, contentHash}` per artifact + `dependsOnHashes` on consumers + a reverse stale-cascade,
So that editing an upstream artifact can't leave a green "consistency contract" that's silently stale.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** an artifact, **When** generated, **Then** it carries `{rev, contentHash}`; consumers (UX/Arch/stories) record `dependsOnHashes`.

**AC2** `verify:behavior` — **Given** an approved PRD that UX/Arch/stories cite, **When** the PRD is edited (new `contentHash`), **Then** all transitive dependents flip `approved → stale` (topological re-approval required).

**AC3** `verify:behavior` — **Given** an artifact write, **When** committed, **Then** it is two-phase (tmp → fsync → atomic-rename → flip Plan-row `status+hash`) — no torn read.

**Prerequisites:** E4.1.

**Touch Points:**

- `functions/shared/types/plan.ts` (`conceptArtifacts` pointer + hash fields)
- `functions/shared/concept/artifact-version.ts` (new — cascade + two-phase commit)
- `functions/shared/concept/__tests__/artifact-version.test.ts`

**Forbidden Areas:** the artifact-gen agents (E7/E12).

**Technical Notes:** W1 is the single highest-leverage primitive — closes five state-machine gaps. Needed before any approval gate (E9/E12) is meaningful. `contentHash`/`rev` also key the VQA probe-compiler cache (shared with H9/H12).

---

## Epic E5 — Verifiability Seam & L2-State Oracle (VQA E2)

**Goal (value):** A deterministic state oracle. **Create** the `RuntimeContract`/`testHarness` type (it does not exist as code — H6), ship the `__harness` seam in the canvas-game scaffold only (H8), add the L2-state `assert` oracle, **split the rigor cap so deterministic tiers are exempt** (the highest-risk requirement — R1), and tamper-guard the seam (H1).

### Story E5.1: [H6] Create the `RuntimeContract`/`testHarness` type

As a boilerplate registry,
I want a `testHarness` block on boilerplate metadata,
So that the seam's shape is a first-class, generator-owned contract.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** `BoilerplateMetadata`, **When** a UI-bearing boilerplate is read, **Then** it exposes `testHarness: {globalKey, readySignal, snapshotShape, stubs}` (new code — not an extension of a non-existent `nodeModulesStrategy`).

**Prerequisites:** None (VQA-side foundation).

**Touch Points:**

- `functions/shared/boilerplates/types.ts` (new `RuntimeContract`/`testHarness`)
- `functions/shared/boilerplates/registry.ts`
- `functions/shared/boilerplates/__tests__/runtime-contract.test.ts`

**Forbidden Areas:** stop citing `nodeModulesStrategy`/`basePath` as a live precedent (H6) — they were never built.

**Technical Notes:** Budgeted as **new surface**, not a refactor. The `snapshotShape` aligns with the generator-emitted `__harness.schema.json` (E4 format).

### Story E5.2: Ship default `__harness` in the canvas-game scaffold [H8]

As a generated app,
I want a test-only `window.__harness` conforming to the schema,
So that probes can read deterministic state.

**Acceptance Criteria:**

**AC1** `verify:state` — **Given** a scaffolded `nextjs-canvas-game` in test mode, **When** loaded, **Then** `window.__harness.ready` becomes true and `snapshot()` returns the domain shape (`{gameState,score,lives,entities,gameOver}`).

**AC2** `verify:build` — **Given** a production build, **When** inspected (+ CI assertion), **Then** `__harness` is absent/no-op (guarded by `process.env.NEXT_PUBLIC_TEST_HARNESS`).

**Prerequisites:** E5.1; **E4.1** (the `__harness.schema.json` shape it conforms to).

**Touch Points:**

- `functions/shared/boilerplates/` canvas-game scaffold (seam wiring)
- CI prod-absence assertion (new)
- scaffold seam test

**Forbidden Areas:** `nextjs-form-app`/`nextjs-dashboard` (status:stub — their seams depend on those starters being wired first, H8); production bundle behavior.

**Technical Notes:** v1 seam scope = canvas-game only. React state is not a singleton — needs per-app wiring (H8). DEV **conforms the running app** to the schema (FR-30); DEV does not author the schema.

### Story E5.3: L2-state `assert` oracle

As a probe,
I want an `assert` step that reads the seam and yields a deterministic verdict,
So that behavior logic is verified with no LLM call.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a collision/submit/filter event, **When** the `assert` step reads `window.__harness.snapshot()`/`events` via `page.evaluate` and compares with an operator (`eq/neq/gt/contains/truthy/...`), **Then** it yields deterministic PASS/FAIL with no vision-judge call.

**Prerequisites:** E5.1, E5.2; E2.1 (the `assert` grammar).

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (new `assert` evaluator)
- runner assert test

**Forbidden Areas:** vision-judge logic.

**Technical Notes:** This is the L2-state oracle (FR-4). Prefer independent observables (real store/DOM state) over a DEV convenience getter where feasible (FR-31).

### Story E5.4: [R1] Re-tier levels + split the rigor cap (blocking AC)

As the level classifier,
I want the rigor cap to gate **vision tiers only**, leaving L0 and L2-state rigor-exempt,
So that `prototype`/`mvp` don't silently downgrade deterministic state ACs to vision (re-introducing the disease).

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** `rigor:'prototype'` + a state AC with a seam, **When** classified, **Then** it routes to **L2-state** (NOT capped to L0).

**AC2** `verify:build` — **Given** an appearance AC at `prototype`, **When** classified, **Then** the vision tier is still rigor-capped.

**AC3** `verify:build` — **Given** the L-level derivation, **When** computed, **Then** `build→L0 · appearance→L1 · state→L2-state if seam else L1-vision · behavior→L2 · manual→operator-lane`.

**Prerequisites:** E5.3.

**Touch Points:**

- `functions/shared/pipelines/visual-test-classifier.ts` (cap split :123–127, derivation :174–254)
- classifier test (both directions)

**Forbidden Areas:** none.

**Technical Notes:** **Highest-risk, easiest-to-miss requirement (R1)** — keep it a blocking AC. The cap split (cost vs determinism) is the entire guard.

### Story E5.5: [H1] Seam tamper-check (un-self-certifiable oracle)

As the QA system,
I want the seam's shape contract to be generator-owned and tamper-reverted on DEV/fixer edits,
So that DEV cannot author the oracle that grades DEV.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** the generator-emitted `__harness.schema.json`, **When** a DEV/fixer edit changes the schema shape, **Then** it is tamper-reverted (mirror the existing test-contract guard at `story-pipeline.ts:910–982`); DEV may only conform values/app to the shape.

**Prerequisites:** E5.1, E5.2.

**Touch Points:**

- `daemon/pipelines/story-pipeline.ts` (tamper-check, near :910–982)
- tamper-revert test

**Forbidden Areas:** the assertion expressions (QA-AUTHOR owns those, E8) — this guards the **shape**, not the asserts.

**Technical Notes:** Core seam-trust fix (FR-30). The exit-gate side of the tamper guard is added in E10.

### Story E5.6: [H3/FR-32] L2-state never the sole witness for a UI-bearing AC

As the QA system,
I want a sampled L1/L2-vision cross-check to accompany L2-state passes on UI-bearing ACs,
So that a "right state, broken/invisible UI" defect can't ship green.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a UI-bearing AC that passes L2-state, **When** the gate evaluates it, **Then** a sampled L1/L2-vision frame on the assembled surface is also required (L2-state alone cannot block-green for render-class ACs).

**Prerequisites:** E5.3, E5.4.

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (pairing logic)
- pairing test

**Forbidden Areas:** none.

**Technical Notes:** Ties to H3 (E11 owns the appearance floor + render-class rule). This story is the per-AP pairing seam; E11.A/E11 finalizes the policy.

---

## Epic E6 — Shared Probe Engine & Verdict (VQA E3)

**Goal (value):** One probe grammar/types + one verdict vocabulary + the `(level × verdict) → block` rule, shared by the wave gate and QA Review. **Scope (H7):** share grammar/types/verdict only — the daemon's agentic-LLM evidence rewrite is E13, not here.

### Story E6.1: Extract the shared probe-runner library + types

As both checkpoints,
I want one probe-runner module and one type set,
So that wave-gate and QA Review execute probes identically.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** both checkpoints, **When** they execute probes, **Then** they import the same runner library + grammar types (no divergent copies).

**Prerequisites:** E2.1, E2.2.

**Touch Points:**

- `functions/shared/pipelines/probe-runner.ts` (new shared lib)
- `daemon/lib/wave-vqa-runner.mjs` (consume shared types)
- `functions/shared/pipelines/visual-qa-pipeline.ts` (consume shared lib)
- probe-runner test

**Forbidden Areas:** the daemon's agentic-evidence path (E13) — share types only; do not rewrite the evidence agent here (H7).

**Technical Notes:** H7: this is grammar/types/verdict sharing, **not** the re-architecture.

### Story E6.2: Unify the verdict vocabulary

As the QA system,
I want one verdict vocabulary across both checkpoints,
So that `(level × verdict) → block` is computable.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the two disjoint vocabularies today (`PASS|FAIL|UNREACHABLE|UNCERTAIN` vs `pass|fail|uncertain|…`), **When** unified, **Then** one canonical enum is used by both, with a documented mapping from the legacy values.

**Prerequisites:** E6.1.

**Touch Points:**

- `functions/shared/types/qa-report.ts` (verdict enum :80–86)
- `daemon/lib/wave-vqa-runner.mjs` (adopt canonical)
- verdict-mapping test

**Forbidden Areas:** none.

**Technical Notes:** Keep a back-compat reader for persisted legacy verdicts.

### Story E6.3: The `(level × verdict) → block` rule

As the gate,
I want a single rule that decides what blocks green,
So that FR-21 is buildable (deterministic blocks; vision never blocks).

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** the rule, **When** evaluated, **Then** deterministic failures (L0, L2-state, boot/build/test) **block green** and vision failures (L1/L2-vision) **never block**; the rule states **where** it is computed.

**AC2** `verify:behavior` — **Given** an L2-state FAIL at QA Review, **Then** green is blocked; **Given** the same at the wave gate (pre-E13), **Then** it runs **non-blocking** (OQ3 — until E13 replaces the agentic evidence path).

**Prerequisites:** E6.2.

**Touch Points:**

- `functions/shared/pipelines/` blocking-rule module (new)
- blocking-rule test

**Forbidden Areas:** none.

**Technical Notes:** OQ3 is closed by making wave-gate L2-state non-blocking until E13.

### Story E6.4: Render richer evidence (snapshots + frame sequences)

As an operator,
I want the claims table / drawer / gate arc to show state snapshots + frame sequences,
So that the richer probe payloads are legible without a UI redesign.

**Acceptance Criteria:**

**AC1** `verify:appearance` — **Given** a probe with a snapshot + frames, **When** the evidence drawer opens, **Then** it shows the state delta and the frame sequence (rendered, idle-visible).

**Prerequisites:** E6.1.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/qa/` (claims table / evidence drawer)
- component test

**Forbidden Areas:** the QA Review page layout (additive payload rendering only — no redesign, FR-25).

**Technical Notes:** Reuse existing drawer primitives; this is payload rendering, not new screens.

---

## Epic E7 — Concept Router & Architecture Artifact

**Goal (value):** Dynamic artifact routing (the LLM-classifier Router) + the `architecture.md` artifact as the multi-agent consistency contract, now **graph-grounded** by the live system graph. `references[]` resolve here via E4's manifest. Prototype-bypassed throughout (W8).

### Story E7.1: `concept-route` LLM-classifier job (prototype-bypassed)

As the concept pipeline,
I want an LLM classifier that emits a `conceptPlan` DAG immediately after intent,
So that artifact applicability is decided dynamically, not by a static dial.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an intent + boilerplateType + rigor + kind, **When** `concept-route` runs (Analyst/Mary persona), **Then** it emits a `conceptPlan {uiBearing, complexity, artifacts[{kind,depth,dependsOn}], gate, rationale}` persisted on the Plan row.

**AC2** `verify:build` — **Given** `rigor:'prototype'`, **When** a plan is created, **Then** the Router is **skipped entirely** (no inference, no Plan-row write, zero added latency — W8 guard); downstream branches treat an **absent** `conceptPlan` as the v1 path.

**AC3** `verify:behavior` — **Given** a Next.js boilerplate + an intent mentioning screens, **When** routed, **Then** `uiBearing:true` and a UX artifact appears with `dependsOn:['prd']`.

**Prerequisites:** E1.4 (`conceptInteraction` plumbing); E4.4 (artifact versioning for the Plan-row).

**Touch Points:**

- `daemon/pipelines/concept/route-job.mjs` (new)
- `functions/shared/types/plan.ts` (`conceptPlan` shape)
- `daemon/pipelines/concept/__tests__/route-job.test.mjs`

**Forbidden Areas:** the `pm-plan` path for `prototype` (must stay byte-identical, R4).

**Technical Notes:** Haiku-class classifier; `rationale` logged (§11). Output is operator-editable on the rail (E12).

### Story E7.2: [W7] Route-confirm checkpoint before paid artifacts

As an operator,
I want a cheap confirm step before any artifact-gen spends tokens,
So that a misroute can be corrected before it burns PRD+UX+arch.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a fresh `conceptPlan`, **When** the pipeline reaches the first paid artifact, **Then** it first surfaces a route-confirm checkpoint (the Router's `uiBearing`/`complexity`/artifact list, editable) and waits for confirm before `prd-gen` runs.

**Prerequisites:** E7.1.

**Touch Points:**

- `daemon/pipelines/concept/route-job.mjs` (confirm gate)
- `functions/api/index.ts` (route-confirm endpoint)
- route-confirm test

**Forbidden Areas:** auto-spend without confirm.

**Technical Notes:** Cheap recovery for the W7 "evidence-starved Router upstream of all spend" risk.

### Story E7.3: [E7-B / graph] Graph-informed complexity for brownfield routing

As the Concept Router,
I want `kind:'change'` complexity derived from `blast_radius`,
So that routing reflects the real structural footprint, not a guess.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** `kind:'change'` + an intent naming existing files, **When** the Router runs, **Then** it calls `blast_radius`/`god_nodes` (Mycelium-MCP) and folds the touched-node count / god-node hits into `conceptPlan.complexity`.

**AC2** `verify:behavior` — **Given** a cold Memgraph, **When** the Router runs, **Then** it degrades to the LLM-only heuristic (no crash); `rationale` notes the fallback.

**Prerequisites:** E7.1; **system-graph Epics 1–6 (live MCP)**.

**Touch Points:**

- `daemon/pipelines/concept/route-job.mjs` (MCP query)
- route-graph test (live + cold-fallback)

**Forbidden Areas:** the Mycelium-MCP / blast-radius implementation (consume; do not modify).

**Technical Notes:** The Router already reads "the project knowledge index" for `change` — the graph **is** that index. Medium-value addition; gated behind cold-Memgraph fallback.

### Story E7.4: `arch-gen` job emits `architecture.md` + section manifest

As the Architect (Winston),
I want a non-interactive (autopilot) job that produces `architecture.md` with a section manifest,
So that stories can cite real architecture sections.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `conceptPlan` including `architecture`, **When** `arch-gen` runs, **Then** it writes `<projectDir>/concept/architecture.md` + `architecture.sections.json` (E4.1 format) and registers it on the Plan row with `{rev,contentHash}`.

**AC2** `verify:behavior` — **Given** a UI-bearing plan, **When** `arch-gen` runs, **Then** it consumes the approved UX spec (`dependsOn:['prd','ux']`) so component/state/routing decisions match the interaction model.

**Prerequisites:** E4.1, E4.4, E7.1.

**Touch Points:**

- `daemon/pipelines/concept/arch-gen-job.mjs` (new)
- `daemon/pipelines/templates/arch-gen-prompt.md` (new)
- arch-gen test

**Forbidden Areas:** the `pm-plan` decompose (E3/E8).

**Technical Notes:** `architecture` version-verification via WebSearch allowed at gen time; cache results.

### Story E7.5: [E7-A / graph] Ground `arch-gen` in the system graph

As the Architect,
I want `arch-gen` to query the graph for real structure,
So that `architecture.md` is grounded (esp. brownfield), and citations point at truth.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `change` plan, **When** `arch-gen` runs, **Then** it queries `query_graph`/`god_nodes`/`blast_radius` and incorporates the real tables/endpoints/external-services/god-nodes into `architecture.md` (asserted by presence of graph-sourced node names in the output).

**AC2** `verify:behavior` — **Given** a cold Memgraph, **When** `arch-gen` runs, **Then** it falls back to file reads + `ast-extract` facts (no crash); the doc notes reduced grounding.

**Prerequisites:** E7.4; **system-graph Epics 1–6 (live)**.

**Touch Points:**

- `daemon/pipelines/concept/arch-gen-job.mjs` (MCP query)
- `daemon/pipelines/templates/arch-gen-prompt.md` (graph-grounding instructions)
- arch-graph test

**Forbidden Areas:** Mycelium-MCP internals; the Knowledge Compiler.

**Technical Notes:** This is what turns "architecture as consistency contract" from LLM-guessed into graph-grounded — high-value. The system graph **is** the structural architecture.

### Story E7.6: [W6] Daemon-hosted interactive session + promote-on-Approve

As the interactive concept tier,
I want artifact convergence to run on the daemon free-agent session and promote on Approve,
So that the converged `.md` reaches the project dir the Story Context Pack reads.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** `conceptInteraction:'interactive'`, **When** `arch-gen` converges in the daemon free-agent session (`_assist/<sid>/` worktree) and the operator Approves, **Then** the converged `concept/architecture.md` is **promoted** into `<projectDir>/concept/` and recorded on the Plan row.

**AC2** `verify:behavior` — **Given** the App worktree's `git clean -fdx` + `assertWorktreeClean`, **When** promotion happens, **Then** the artifact is stored as a tracked commit on the plan branch **or** outside the worktree with `concept/` added to the `git clean` exclude — so it survives cleaning.

**AC3** `verify:behavior` — **Given** `conceptInteraction:'autopilot'`, **When** `arch-gen` runs, **Then** it is a daemon one-shot that auto-advances (no Approve gate).

**Prerequisites:** E7.4; E1.4.

**Touch Points:**

- `daemon/pipelines/free-agent-session.mjs` (promote-on-Approve hook)
- `daemon/pipelines/concept/promote-artifact.mjs` (new)
- promote test (clean-survival assertion)

**Forbidden Areas:** the free-agent session's resumable turn-loop (reuse; do not fork — W6); any cross-host file delivery (there is none — same daemon host).

**Technical Notes:** W6 correction — both modes run on the **daemon**; the real work is daemon-local promote + git-cleanliness handling, not Lambda cross-host sync.

### Story E7.7: Wire `references[]` resolution into the pack (now resolvable)

As the Story Context Pack,
I want cited artifact sections inlined via the manifest,
So that the DEV agent reads the architecture contract, not a path.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a story citing `architecture#error-handling`, **When** the pack assembles, **Then** `resolveSection` (E4.1) inlines that section into the Story-spec, deterministically, within the E4.3 budget floor.

**AC2** `verify:behavior` — **Given** an editing of `architecture.md` that flips it `stale` (E4.4), **When** a story is dispatched against a stale citation, **Then** dispatch surfaces the staleness (does not silently inline an outdated section).

**Prerequisites:** E4.1, E4.3, E4.4, E7.4.

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (reference inlining; coexists with E3.5 ordering)
- reference-inline test

**Forbidden Areas:** the E3.5 section ordering (slot references into the BMAD-fields block; don't reorder `<ground_truth>`/probe sections).

**Technical Notes:** This is the consistency-contract win — the architecture doc becomes the cross-wave drift killer.

### Story E7.8: PM decompose emits `references[]` (rigor-gated)

As the PM agent,
I want decompose to cite real artifact sections for `mvp`/`production`,
So that stories link to the contract that governs them.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an `mvp`/`production` plan with generated artifacts, **When** the PM decomposes, **Then** stories carry `references[]` whose `section ∈ manifest.ids` (validated E4.2); **Given** `prototype`, **Then** `references[]` are omitted.

**Prerequisites:** E3.1, E4.1, E4.2, E7.4.

**Touch Points:**

- `functions/shared/prompts/pm-plan-prompt.ts` (references graft + artifact context)
- pm-references test

**Forbidden Areas:** none.

**Technical Notes:** The PM prompt for `mvp`/`production` receives the generated `.md`s + manifests as context so citations resolve to real sections.

---

## Epic E8 — QA Authorship & Level-Setting (VQA E4)

**Goal (value):** The cross-PRD convergence point — the QA-AUTHOR persona compiles probes from the PM's BDD ACs at story-dev start, derives the L-level from `verify`, owns the `manual→behavior` downgrade, and the pack carries the probe/seam section (slotting into E3.5's reserved slot). Depends on Concept schema + manifests + the seam.

### Story E8.1: QA-AUTHOR persona owns probes (reach/act/observe)

As a story-dev pipeline,
I want one QA-AUTHOR persona authoring code-tests + interaction probes at TDD-red,
So that "is this reachable + observable" has a single owner.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a story with BDD ACs, **When** the QA-AUTHOR runs at story-dev start, **Then** it emits probes (`given`→reach, `when`→act, `then`→observe) linked to ACs by `criteriaRef`.

**AC2** `verify:build` — **Given** the PM's prose `then`, **When** compiled, **Then** the QA-AUTHOR produces seam `assert` steps — the PM authored **no** probes (Q7).

**Prerequisites:** E1.1 (verify/BDD), E2.1 (grammar), E5.3 (assert oracle).

**Touch Points:**

- `daemon/pipelines/story-pipeline.ts` (:333, :631–704 — QA-AUTHOR step)
- `daemon/pipelines/templates/qa-author-prompt.md` (new)
- qa-author test

**Forbidden Areas:** DEV's code authorship (separate persona); the seam **shape** (generator-owned, E5.5).

**Technical Notes:** Consolidates code-test + visual-probe authorship under one persona.

### Story E8.2: Derive the L-level from `verify` (needsBrowser one-rule)

As the QA-AUTHOR,
I want the L-level derived from the PM's `verify` intent with one `needsBrowser` rule,
So that level-setting is consistent and `manual` stays independent.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** `verify:'state'` + a seam, **When** derived, **Then** level = L2-state; **Given** no seam, **Then** L1-vision.

**AC2** `verify:build` — **Given** `needsBrowser` derivation, **When** computed, **Then** it is derived for `build|appearance|state|behavior` (`build→false`) and **independent/explicit for `manual`** (MQ1-followup — the one rule all three docs share).

**Prerequisites:** E8.1, E5.4.

**Touch Points:**

- `functions/shared/pipelines/visual-test-classifier.ts` (derivation)
- derivation test

**Forbidden Areas:** the rigor-cap split (E5.4 owns it).

**Technical Notes:** Classifier-defaulted, operator-overridable at the ContractGate.

### Story E8.3: [W5/H12] `manual→behavior` downgrade (logged, forces needsBrowser)

As the QA-AUTHOR,
I want to perform the `manual→behavior` downgrade where seam availability is known,
So that `manual` can't become an escape hatch (Concept's gate only flags).

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `verify:'manual'` AC whose boundary is actually stubbable (test-mode seam exists), **When** the QA-AUTHOR runs, **Then** it downgrades to `behavior`, emits a **logged reclassification event**, and **forces `needsBrowser:true`**.

**AC2** `verify:behavior` — **Given** a genuinely unautomatable `manual` AC (`no-stub-possible`/`real-payment`/…), **When** the QA-AUTHOR runs, **Then** it is left `manual` and routed to the operator lane (E11).

**Prerequisites:** E8.1, E8.2; **Concept E9** (the gate that flags `manual`).

**Touch Points:**

- `daemon/pipelines/story-pipeline.ts` (downgrade + event)
- reflection/event sink
- downgrade test

**Forbidden Areas:** Concept's gate (it only flags + validates `manualReason` — it must NOT reclassify; W5 altitude rule).

**Technical Notes:** This is the cross-session ownership boundary, CONFIRMED round-3. Stub-availability is a mechanism fact known only here.

### Story E8.4: Coverage check (oracle-strength, not just presence)

As the aggregate gate,
I want every auto-verifiable AC to have a probe of adequate oracle strength,
So that a gap or a too-weak oracle fails the gate.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an `appearance|state|behavior` AC with no probe, **When** qa-aggregate runs, **Then** the gate reports the coverage gap.

**AC2** `verify:behavior` — **Given** a render-class AC covered only by L2-state, **When** checked, **Then** the gate flags insufficient oracle strength (must pair vision — premise-F4 / H3).

**Prerequisites:** E8.1, E8.2, E5.6.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (aggregate coverage)
- coverage test

**Forbidden Areas:** none.

**Technical Notes:** Coverage asserts **strength**, not just presence (the premise-F4 fix).

### Story E8.5: [H9/W2] Pack carries the probe/seam section + manifest read path

As the Story Context Pack,
I want a dedicated sorted probe/seam section and the manifest read path,
So that probes survive serialization and citations resolve.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** authored probes + seam references, **When** `serializePack` runs, **Then** a dedicated **sorted probe/seam section** is emitted in E3.5's reserved slot, byte-identical across roles.

**AC2** `verify:behavior` — **Given** budget pressure, **When** the pack overflows, **Then** **probe bytes are protected before digest-dropping** (the E4.3 waterfall extended to probes — H9).

**AC3** `verify:build` — **Given** a `source:'harness'` reference, **When** resolved, **Then** it reads `__harness.schema.json` by JSON-path (E4.1 harness manifest), keyed on `contentHash`/`rev`.

**Prerequisites:** E3.5 (reserved slot), E4.1, E4.3.

**Touch Points:**

- `daemon/pipelines/lib/story-context-pack.mjs` (probe/seam section + harness read path)
- pack-probe test

**Forbidden Areas:** the `<ground_truth>` and BMAD-field sections (E3.5 ordering — slot in, don't reorder).

**Technical Notes:** This is VQA's H9, building the pack-serializer **read** path for both manifests Concept emits. Coordinate the slot with E3.5's owner.

### Story E8.6: Operator override at the ContractGate

As an operator,
I want to override the derived L-level/verify at a contract gate,
So that classifier defaults are correctable before dev proceeds.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a derived L-level, **When** the operator overrides it at the ContractGate, **Then** the override persists and the probe re-derives accordingly; **Given** no override, **Then** the classifier default stands.

**Prerequisites:** E8.2.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/qa/contract-gate.tsx` (+ existing test)
- override persistence

**Forbidden Areas:** none.

**Technical Notes:** Reuse the existing ContractGate surface (tests already exist).

---

## Epic E9 — Readiness Gate (solutioning-gate-check)

**Goal (value):** Upgrade **Start development** from a structural check to a semantic gate — coverage of PRD requirements, reference resolution, the `manual`-flag-for-confirmation, the appearance-coverage floor, and a **blast-radius scope cross-check** against the live graph. Rigor-scaled: `prototype` auto-passes, `production` must be Ready.

### Story E9.1: `gate-check` job + readiness report + verdict

As the gate,
I want a semantic `solutioning-gate-check` producing a verdict + report,
So that planning→execution has a real readiness boundary.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a non-`prototype` plan, **When** `gate-check` runs (TEA/Murat persona), **Then** it writes `<projectDir>/concept/readiness-report.md` and a verdict ∈ {Ready, Ready-with-conditions, Not-ready}.

**AC2** `verify:behavior` — **Given** `prototype`, **Then** auto-pass; **Given** `production` + Not-ready, **Then** the Start-development button is disabled.

**Prerequisites:** E4.4, E7.4.

**Touch Points:**

- `daemon/pipelines/concept/gate-check-job.mjs` (new)
- `functions/api/index.ts` (`POST /api/plans/:id/start` gate hook)
- gate-check test

**Forbidden Areas:** the existing structural validation (additive — the semantic gate runs alongside, not replacing, SKILL-SCOUT + schema checks).

**Technical Notes:** Surfaced inline in `PlanReviewView` next to the SKILL-SCOUT gate card.

### Story E9.2: Requirement coverage + structural assertions

As the gate,
I want every PRD requirement mapped to ≥1 epic and every story well-formed,
So that gaps and forward-deps are caught before dev.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** epic `requirementRefs[]`, **When** the gate runs, **Then** it asserts every PRD functional-requirement maps to ≥1 epic; an uncovered requirement → Not-ready (production) / warning (mvp).

**AC2** `verify:behavior` — **Given** the plan, **When** checked, **Then** foundation epic exists, no forward deps, every story has a user-story triple + ≥1 BDD AC; contradictions / gold-plating flagged.

**Prerequisites:** E1.2, E9.1.

**Touch Points:**

- `daemon/pipelines/concept/gate-check-job.mjs` (coverage rules)
- coverage test

**Forbidden Areas:** none.

**Technical Notes:** `requirementRefs` is the traceability spine (§4.1).

### Story E9.3: [W2] Reference set-membership at the gate

As the gate,
I want every `references[].section` to resolve to a real manifest section,
So that "every reference resolves" is mechanized, not aspirational.

**Acceptance Criteria:**

**AC1** `verify:build` — **Given** story references, **When** the gate runs, **Then** each `section ∈ manifest.ids` (reusing E4.2's predicate); a dangling reference → Not-ready.

**Prerequisites:** E4.1, E4.2, E9.1.

**Touch Points:**

- `daemon/pipelines/concept/gate-check-job.mjs` (membership check)
- gate-references test

**Forbidden Areas:** none.

**Technical Notes:** Same predicate as decompose-side (E4.2) — one implementation, two call sites.

### Story E9.4: [W5] Flag `manual` ACs + validate `manualReason`; [W9] appearance floor

As the gate,
I want to flag every `manual` AC for operator confirmation and enforce the appearance floor,
So that `manual` is audited and L1 is always exercised on UI-bearing plans.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `verify:'manual'` AC, **When** the gate runs, **Then** it **flags it for operator confirmation** and rejects an empty/invalid `manualReason` (closed 8-enum) — it does **NOT** reclassify `manual→behavior` (that's E8.3).

**AC2** `verify:behavior` — **Given** a `uiBearing` plan, **When** the gate runs, **Then** it requires ≥1 `verify:'appearance'` AC per primary screen/route — **warn at `mvp`, block at `production`** (W9).

**Prerequisites:** E9.1, E1.1.

**Touch Points:**

- `daemon/pipelines/concept/gate-check-job.mjs` (manual-flag + appearance floor)
- gate-manual test, gate-appearance test

**Forbidden Areas:** any `manual→behavior` reclassification (altitude violation — W5; E8.3 owns it in the QA session).

**Technical Notes:** The appearance floor restores the L1 guarantee the §5 idle-visible relaxation removed (W9, complementary to VQA H3).

### Story E9.5: [E9-A / graph + W7c] Blast-radius scope cross-check & route↔AC cross-check

As the gate,
I want to cross-check declared `touchPoints`/`forbiddenAreas` against `blast_radius`, and route against ACs,
So that under-scoped stories and misroutes are caught before dev.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a story's declared `touchPoints`, **When** the gate runs `blast_radius(touchPoints)`, **Then** it flags stories whose real blast surface (tables/endpoints/event sources/dependents) materially exceeds the declared touch points, and **suggests `forbiddenAreas`** from the dependents.

**AC2** `verify:behavior` — **Given** the `conceptPlan`'s `uiBearing`/`complexity`, **When** the gate runs, **Then** it cross-checks them against the actual ACs (e.g. `uiBearing:false` but appearance/behavior ACs exist → route reconciliation flag, W7c).

**AC3** `verify:behavior` — **Given** a cold Memgraph, **When** the gate runs, **Then** the blast-radius check degrades to a warning (not a hard block) and notes reduced confidence.

**Prerequisites:** E9.1, E7.1; **system-graph Epics 1–6 (live)**.

**Touch Points:**

- `daemon/pipelines/concept/gate-check-job.mjs` (blast-radius + route↔AC cross-check)
- gate-blast-radius test (live + cold-fallback)

**Forbidden Areas:** Mycelium-MCP internals; the wave-conflict resolver (the gate _informs_ touchPoints; it doesn't re-implement wave assignment).

**Technical Notes:** E9-A high-value graph addition + W7c route reconciliation in one gate pass. Degrades gracefully — never blocks solely on a cold graph.

---

## Epic E10 — Closed Agentic Fix Loop (VQA E5)

**Goal (value):** Make "fix until tests pass" real **and un-gameable** — `reach-wrong` triage routing, a deterministic exit gate that re-runs the exact failing probe, an N-run flake-guard + frozen oracle (so a flaky/self-certified pass can't close the loop), bounded escalation, and reflector seam-delta capture.

### Story E10.1: `reach-wrong` triage + routing

As the fix loop,
I want failures classified and routed to the right author,
So that a wrong-path probe goes to the QA-AUTHOR, not the DEV fixer.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a probe that drove the wrong path, **When** triaged, **Then** it is classed `reach-wrong` and routed to the QA-AUTHOR; **Given** a real code bug, **Then** `code-bug`→DEV; `ac-wording`→PM/operator; `environment`→infra.

**Prerequisites:** E6.1, E8.1.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (triage classifier)
- triage test

**Forbidden Areas:** none.

**Technical Notes:** FR-18. Misrouting is the main reason fix loops thrash.

### Story E10.2: Deterministic exit gate (re-run the exact failing probe)

As the fix loop,
I want closure to require the exact failing probe to pass deterministically,
So that the loop closes on truth, not on a judged approximation.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a fixed L2-state failure, **When** the loop re-runs the **exact** failing probe, **Then** a deterministic pass closes it; **Given** a vision FAIL, **Then** it routes to `ac-wording`/operator, never an unbounded loop.

**Prerequisites:** E10.1, E5.3, E6.3.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (exit gate)
- exit-gate test

**Forbidden Areas:** none.

**Technical Notes:** FR-19. The probe is frozen at first failure (see E10.3).

### Story E10.3: [H1/H2] Frozen oracle + N-run flake-guard closure

As the fix loop,
I want the oracle frozen mid-loop and timing/concurrency ACs closed only after N passing runs,
So that a self-certified or flaky pass cannot game closure.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a loop in progress, **When** a DEV/fixer edits the seam schema, **Then** it is tamper-reverted (E5.5 guard applied at the exit gate — H1); the oracle shape is frozen.

**AC2** `verify:behavior` — **Given** an AC whose `when/then` involves timing/concurrency/eventual-consistency, **When** the exit gate evaluates it, **Then** **single-pass closure is forbidden** — it must pass the required N runs (`flakeGuard`, H2) before closing.

**Prerequisites:** E10.2, E5.5, E2.3 (clock for deterministic N-runs).

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (frozen oracle + flakeGuard)
- flake-guard test

**Forbidden Areas:** none.

**Technical Notes:** "Deterministic read ≠ deterministic system" (H2). The clock control (E2.3) makes N-run reproducibility possible.

### Story E10.4: Bounded escalation + blocking policy

As the fix loop,
I want a round cap + cost ceiling and a clear blocking policy,
So that the loop terminates and only deterministic failures block green.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** exhausted rounds (cap by rigor + plan `costCeilingUsd`), **When** the loop ends, **Then** it fix-forwards, mints **one** fix story, and emits an operator card with the handoff packet.

**AC2** `verify:behavior` — **Given** a deterministic failure (L0/L2-state/boot/build/test), **Then** green is blocked; **Given** a vision FAIL, **Then** green is **not** blocked (FR-21, via E6.3 rule).

**Prerequisites:** E10.2, E6.3.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (escalation + policy)
- `daemon/agent-daemon.mjs` (fix-story mint, near :5611–5658)
- escalation test

**Forbidden Areas:** auto-merge without the operator card (consent).

**Technical Notes:** FR-20. One fix story, not a swarm.

### Story E10.5: [H5] Reflector seam-delta capture (`story.vqa.fix` target)

As the reflection loop,
I want confirmed-fixed deterministic failures to emit a seam delta,
So that the fix is learnable.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a confirmed-fixed deterministic failure, **When** it resolves, **Then** `reflector-apply.mjs` writes a reflection row with the **seam delta** (before/after `snapshot()` + diff) — adding the missing `story.vqa.fix` case to its switch (it is a working 291-line applier, not a stub).

**Prerequisites:** E10.2.

**Touch Points:**

- `daemon/pipelines/reflector-apply.mjs` (add `story.vqa.fix` target + writer)
- reflector test

**Forbidden Areas:** the existing on-disk apply targets (additive switch case only).

**Technical Notes:** H5 factual correction — add the target + writer, not "wire a stub." On-disk apply for this target is in scope.

---

## Epic E11 — Human-in-the-Loop & Platform Generality (VQA E6)

**Goal (value):** The `manual` operator lane + `manualReason` surface, test-mode boundary seams (now **graph-discovered**), the generative-content rule, state-AND-appearance + the appearance floor, the security-on-prod oracle, and the mobile/Expo driver path. Covers the unautomatable class + all app types.

### Story E11.1: `verify:'manual'` operator lane (blocks ship)

As an operator,
I want a verification-lane checklist for `manual` ACs,
So that the unautomatable class is confirmed by a human and never silently passed.

**Acceptance Criteria:**

**AC1** `verify:manual` — **Given** a `manual` AC, **When** QA Review renders, **Then** it appears in the operator verification lane and ship is **blocked until confirmed**.

**AC2** `verify:build` — **Given** a `manual` AC, **When** the auto-pipeline runs, **Then** it is neither auto-passed nor auto-failed.

**Prerequisites:** E1.1 (manual enum); E8.3 (downgrade already applied upstream).

**Touch Points:**

- `src/components/labs/plan-dashboard/views/qa/` (operator lane)
- `functions/shared/types/qa-report.ts` (manual-lane state)
- operator-lane test

**Forbidden Areas:** auto-pass/fail of `manual` ACs.

**Technical Notes:** FR-26. The block-ship enforcement lives here (Concept's gate only flags).

### Story E11.2: `manualReason` 8-enum display/validate

As an operator,
I want the `manualReason` shown and validated,
So that I know _why_ a check is manual and bad reasons are rejected.

**Acceptance Criteria:**

**AC1** `verify:appearance` — **Given** a `manual` AC in the lane, **When** rendered, **Then** its `manualReason` (one of the 8) is displayed with a human-readable label.

**AC2** `verify:build` — **Given** an invalid/empty `manualReason`, **When** validated, **Then** it is rejected (closed enum).

**Prerequisites:** E11.1.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/qa/` (reason chip)
- reason display test

**Forbidden Areas:** none.

**Technical Notes:** The 8 values map to a stub-availability verdict (seven named) + `no-stub-possible` catch-all.

### Story E11.3: Test-mode boundary seams (declared in contract)

As the QA system,
I want external/human boundaries converted to deterministic probes via declared stubs,
So that OAuth/payment/chat-partner flows are verifiable.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an OAuth/payment/chat-partner boundary with a declared test-mode stub (scripted partner, test keys, mock inbox), **When** a probe runs, **Then** the boundary is stubbed and the behavior is verified deterministically; the stub is cited via `references[].source:'harness'`.

**AC2** `verify:behavior` — **Given** no stub possible, **When** classified, **Then** it falls back to `manual` (`no-stub-possible`).

**Prerequisites:** E5.1 (contract stubs), E8.1.

**Touch Points:**

- `functions/shared/boilerplates/` runtime-contract `stubs`
- stub-seam test

**Forbidden Areas:** production builds (stubs are test-only).

**Technical Notes:** FR-27. Cited via the existing `harness` source — no new reference source (MQ7).

### Story E11.4: [E11-A / graph] Graph-discovered boundaries (stub-vs-manual)

As the QA-AUTHOR,
I want external boundaries discovered from the graph's `externalService` nodes,
So that "which boundaries does this story cross, and do they need a stub?" is answered from real structure.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a story's `touchPoints`, **When** the QA-AUTHOR queries `blast_radius`, **Then** crossed `externalService` nodes (with `costModel.billable`) are surfaced as boundaries needing a test-mode stub or a `manual` fallback.

**AC2** `verify:behavior` — **Given** a billable external service with no declared stub, **When** evaluated, **Then** it is flagged (candidate `no-stub-possible` → `manual`) rather than silently un-tested.

**AC3** `verify:behavior` — **Given** a cold Memgraph, **When** discovery runs, **Then** it degrades to contract-declared stubs only (no crash).

**Prerequisites:** E11.3, E8.1; **system-graph Epics 1–6 (live)**.

**Touch Points:**

- `daemon/pipelines/templates/qa-author-prompt.md` (boundary discovery via MCP)
- boundary-discovery test (live + cold)

**Forbidden Areas:** Mycelium-MCP / `service-extract` internals (consume).

**Technical Notes:** Medium-value graph addition — partially automates the `no-stub-possible` decision using `externalService` nodes already in the graph.

### Story E11.5: [H3/W9] State-AND-appearance + appearance floor + render-class rule

As the QA system,
I want UI-bearing behavior ACs verified by both a seam assert and a vision frame, with a per-screen appearance floor,
So that "right state, broken/invisible UI" can't ship green.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a UI-bearing `behavior` AC, **When** verified, **Then** it gets **both** a seam assert **and** a post-action L2-vision frame on the assembled surface (not either/or — FR-34).

**AC2** `verify:behavior` — **Given** a render-class AC (animation/transition/chart geometry/WebGL/canvas), **When** verified, **Then** L2-state **cannot block-green alone** — vision (or exposed geometry) is required (FR-35).

**AC3** `verify:behavior` — **Given** a UI-bearing plan, **When** QA Review runs, **Then** the appearance floor (≥1 `appearance` AC per primary screen, L1 runs regardless of rigor) is enforced (warn mvp / block prod); the "majority at L2-state" metric is deleted.

**Prerequisites:** E5.6, E9.4 (gate-side floor).

**Touch Points:**

- `functions/shared/pipelines/visual-qa-pipeline.ts` (pairing + render-class rule)
- `daemon/lib/wave-vqa-runner.mjs` (floor enforcement)
- pairing/floor test

**Forbidden Areas:** none.

**Technical Notes:** H3 — the appearance oracle was demoted; this restores it. Complementary to Concept's gate-side floor (E9.4).

### Story E11.6: [H10] Security-on-prod-build oracle + missing-class rows

As the QA system,
I want security ACs verified on the production-equivalent build via non-seam oracles,
So that the test-only seam (stripped in prod) is never the security witness.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a security AC, **When** verified, **Then** it uses HTTP status / DOM-escape / CSP checks on the prod-equivalent build — **never** the test-only seam.

**AC2** `verify:build` — **Given** the H10 coverage classes (file upload/download, a11y, i18n/RTL, responsive, offline/PWA, notifications, audio-structural, long-running jobs, cross-origin iframes, charts-as-geometry), **When** the matrix is reviewed, **Then** each is either given an oracle or **explicitly listed as deferred** (no silent funnel to `manual`).

**Prerequisites:** E5.2 (seam absent in prod), E6.1.

**Touch Points:**

- `functions/shared/pipelines/` security-oracle module (new)
- coverage-matrix doc + test

**Forbidden Areas:** using `__harness` for security (it's stripped in prod — H10/H11).

**Technical Notes:** Acknowledge the seam's four boundaries (H11): production-absent, in-process, post-hydration, same-origin, single-snapshot.

### Story E11.7: [FR-28/29] Generative-content rule + mobile Expo-web driver

As the QA system,
I want generative content asserted structurally (never exact-match) and mobile driven via Expo-web,
So that LLM output and mobile apps are testable without flakiness or a native driver.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a chat AC over LLM output, **When** verified, **Then** it asserts a structural invariant (e.g. assistant message appended) + a non-blocking semantic judgment, **never** an exact string.

**AC2** `verify:behavior` — **Given** a mobile (Expo) app, **When** a probe runs, **Then** it drives the Expo-web target under device emulation; native-only ACs are tagged `manual` (real-native driver deferred).

**Prerequisites:** E6.1; E2.2 (driver seam).

**Touch Points:**

- `functions/shared/pipelines/` generative-rule + driver-abstraction
- generative test, mobile-driver test

**Forbidden Areas:** exact-match oracles for generative content; Playwright-specific assumptions leaking past the driver seam (FR-29).

**Technical Notes:** Realtime/multiplayer ACs = `manual` for v1 (H4); the multi-context probe primitive is deferred.

---

## Epic E12 — PRD/UX Artifacts & Concept Rail UI

**Goal (value):** Complete the artifact chain (`prd-gen`, `ux-gen`) and build the operator-facing Concept stage — the pipeline-rail UI rendering the `architecture → prd → (ux) → plan → gate` DAG, per-agent auditable logs, the interactive convergence chat + Approve gates, and the traceability overlay. This is the operator's "check the chain" view.

### Story E12.1: `prd-gen` job + section manifest

As the PM (John),
I want a `prd-gen` job emitting `prd.md` + manifest,
So that the PRD is the citable root of the artifact chain.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a `conceptPlan` including `prd`, **When** `prd-gen` runs, **Then** it writes `<projectDir>/concept/prd.md` + `prd.sections.json` with `{rev,contentHash}`, depth-scaled by rigor (lite/full).

**Prerequisites:** E4.1, E4.4, E7.1.

**Touch Points:**

- `daemon/pipelines/concept/prd-gen-job.mjs` (new)
- `daemon/pipelines/templates/prd-gen-prompt.md` (new)
- prd-gen test

**Forbidden Areas:** the decompose path.

**Technical Notes:** `prd-gen` runs before UX/Arch; PRD-time route reconciliation (W7b) re-emits `uiBearing`/`complexity` with real FRs and re-plans on disagreement.

### Story E12.2: `ux-gen` job (UI-bearing only) + serial PRD→UX→Arch

As the UX designer (Sally),
I want a `ux-gen` job that runs only when `uiBearing`, before Arch,
So that Architecture cites the UX spec.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** `conceptPlan.uiBearing:true`, **When** the chain runs, **Then** `ux-gen` produces `ux-spec.md` + manifest and Arch's `dependsOn` includes `ux`; **Given** non-UI, **Then** `ux-gen` is skipped and the chain is `PRD→Architecture`.

**Prerequisites:** E12.1, E7.4.

**Touch Points:**

- `daemon/pipelines/concept/ux-gen-job.mjs` (new)
- `daemon/pipelines/templates/ux-gen-prompt.md` (new)
- ux-gen ordering test

**Forbidden Areas:** the non-UI path (UX must be fully absent, not empty).

**Technical Notes:** D5 — serial `PRD→UX→Architecture` when UI-bearing.

### Story E12.3: Per-agent log envelope + copy/download (auditing)

As an operator,
I want each concept job wrapped in an auditable log envelope with copy/download,
So that I can paste a specific agent's transcript for debugging.

**Acceptance Criteria:**

**AC1** `verify:appearance` — **Given** a running/finished concept job, **When** I open its node, **Then** I see the envelope header (`persona · job · artifact · model · phase · rigor · timing · tokens · cost`) above the token stream, with **Copy log**, **Download transcript**, **Copy LLM prompt** actions.

**AC2** `verify:behavior` — **Given** a finished job, **When** I copy its log, **Then** the rendered transcript reaches the clipboard; the envelope + transcript persist after the job ends (post-mortem).

**Prerequisites:** E7.1 (jobs exist with personas).

**Touch Points:**

- `src/components/labs/agentic-workflow/` (log envelope component)
- `functions/shared/types/agent-orchestrator.ts` (`{agent,persona,phase}` tags)
- envelope test

**Forbidden Areas:** the live token-stream plumbing (`StoryLiveOutput`) — wrap it, don't replace.

**Technical Notes:** §11.2. Reuses `AgentJob` rows + persisted `agent-<id>.jsonl`.

### Story E12.4: Concept pipeline-rail DAG (status tiles)

As an operator,
I want the `conceptPlan` rendered as a DAG rail,
So that I can see and verify the `route→prd→(ux)→arch→plan→gate` chain.

**Acceptance Criteria:**

**AC1** `verify:appearance` — **Given** a `conceptPlan`, **When** `PlanReviewView` renders, **Then** the rail shows one node per artifact with persona + status dot (`drafting→awaiting-you→approved` interactive, `running→ready` autopilot); router-skipped nodes (e.g. UX on a CLI) are greyed/absent.

**AC2** `verify:appearance` — **Given** the Plan node, **When** expanded, **Then** it shows the existing epics→waves view as the penultimate node (kept as-is).

**Prerequisites:** E7.1, E12.3.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/` (Concept rail; extend `PlanReviewView`)
- rail render test

**Forbidden Areas:** the existing epics→waves rendering (frame it as a node; don't rebuild it).

**Technical Notes:** §12. Motion honors `prefers-reduced-motion`.

### Story E12.5: Interactive convergence chat + Approve gates

As an operator,
I want each node to open a convergence chat with decision cards and an Approve gate,
So that artifacts converge like a chat before dependents consume them (interactive mode).

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** `conceptInteraction:'interactive'`, **When** I open a node, **Then** a split panel shows rendered markdown (left) + the convergence chat with `adv-elicit` decision cards (right); the dependent node stays blocked until I click **✓ Approve**.

**AC2** `verify:behavior` — **Given** `autopilot`, **When** artifacts resolve, **Then** edges auto-light and the chat is available but non-blocking.

**Prerequisites:** E7.6 (daemon session + promote-on-Approve), E12.4.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/` (split panel + chat)
- `src/hooks/use-epic-workflow.ts` (Approve mutation)
- chat/approve test

**Forbidden Areas:** the free-agent chat substrate (reuse; do not fork).

**Technical Notes:** §3.3/§12. The "Copy LLM prompt / import" path is the escape hatch, not the primary seam.

### Story E12.6: [W10] Convergence-state persistence, timeout & mode immutability

As the concept pipeline,
I want per-turn convergence state, an approval timeout, and post-start immutability,
So that abandoned sessions don't wedge the plan and mode-flips mid-flight are defined.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** an interactive convergence, **When** each turn completes, **Then** state is persisted (resumable after a crash).

**AC2** `verify:behavior` — **Given** an abandoned session, **When** `approvalTimeout` elapses, **Then** the documented policy fires (e.g. fall back to autopilot draft / notify); **Given** the first artifact job has started, **Then** `conceptInteraction` is immutable.

**Prerequisites:** E1.4, E12.5.

**Touch Points:**

- `daemon/pipelines/free-agent-session.mjs` (per-turn persist)
- `functions/shared/plan/resolve-concept-interaction.ts` (immutability guard)
- timeout/immutability test

**Forbidden Areas:** none.

**Technical Notes:** W10 — the wedged-plan / undefined-mode-flip fix.

### Story E12.7: Traceability overlay (epic→requirement, story→section)

As an operator,
I want an overlay drawing requirement + section links,
So that coverage is visible at a glance — the "check architecture > prd > final plan" view.

**Acceptance Criteria:**

**AC1** `verify:appearance` — **Given** `requirementRefs` + `references`, **When** I toggle the overlay, **Then** it draws `epic → PRD requirement` and `story → architecture#section` links; uncovered requirements are visually flagged.

**Prerequisites:** E12.4, E1.2, E4.1.

**Touch Points:**

- `src/components/labs/plan-dashboard/views/` (overlay)
- overlay test

**Forbidden Areas:** the rail layout (additive overlay).

**Technical Notes:** §12 traceability toggle. Reuses `requirementRefs` (E1.2) + manifest sections (E4.1).

---

## Epic E13 — Wave-Gate Evidence Rewrite (VQA E7-arch)

**Goal (value):** Replace the daemon's **agentic-LLM evidence path** (improvising CLI) with the **programmatic probe runner**, enabling wave-gate L2-state **blocking** (until now non-blocking, OQ3). Explicitly budgeted — the single biggest lift; isolated last so the rest of the plan ships without it.

### Story E13.1: Programmatic evidence path at the wave gate

As the wave gate,
I want evidence collected by the programmatic probe runner,
So that wave-gate verdicts match QA Review's deterministic semantics.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a behavior AC at the wave gate, **When** evaluated, **Then** the **programmatic** runner (E6.1) reaches→acts→observes (replacing the agentic-LLM evidence agent at `wave-vqa-runner.mjs:126–150`), with no automatic `UNVERIFIABLE`.

**Prerequisites:** E6.1, E6.2, E6.3.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (evidence rewrite)
- wave-gate evidence test

**Forbidden Areas:** the QA Review programmatic path (already correct — converge toward it).

**Technical Notes:** H7 — this is the re-architecture E6 explicitly deferred. Biggest single lift.

### Story E13.2: Wave-gate gains interaction (reach→act before capture)

As the wave gate,
I want probes to drive interaction before capturing,
So that behavior is verified at the gate, not just idle.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** a behavior AC, **When** the wave gate runs, **Then** the probe reaches the state and verifies it (no idle-only capture; FR-24).

**Prerequisites:** E13.1.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (interaction path)
- wave-gate interaction test

**Forbidden Areas:** none.

**Technical Notes:** FR-24 — wave-gate VQA gains interaction.

### Story E13.3: Enable wave-gate L2-state blocking

As the wave gate,
I want deterministic L2-state failures to block green,
So that OQ3 is closed (wave-gate L2-state was non-blocking until the rewrite).

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** the programmatic evidence path live, **When** an L2-state probe FAILs at the wave gate, **Then** green is **blocked** (the E6.3 rule now applies at the wave gate too).

**Prerequisites:** E13.1, E13.2, E6.3.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs` (blocking flip)
- blocking test

**Forbidden Areas:** vision blocking (still never blocks).

**Technical Notes:** Flip the OQ3 non-blocking flag once the path is programmatic.

### Story E13.4: End-to-end verdict unification

As the QA system,
I want one verdict semantics end-to-end across both checkpoints,
So that wave-gate and QA Review agree.

**Acceptance Criteria:**

**AC1** `verify:behavior` — **Given** the same probe at both checkpoints, **When** run, **Then** the verdict + block decision are identical (one vocabulary, one `(level×verdict)→block` rule).

**Prerequisites:** E13.1–E13.3.

**Touch Points:**

- `daemon/lib/wave-vqa-runner.mjs`, `functions/shared/pipelines/visual-qa-pipeline.ts` (parity)
- end-to-end parity test

**Forbidden Areas:** none.

**Technical Notes:** Closes the two-system drift originally targeted by E6, now fully realized.

---

## Epic Breakdown Summary & Validation

**72 stories across 13 epics, 6 waves.** All stories carry BDD acceptance criteria (in the project's own `given/when/then` + `verify` form — dogfooding), backward-only `Prerequisites`, `Touch Points`, and `Forbidden Areas`.

### Source → epic traceability

| Source                                                    | Covered by                    |
| --------------------------------------------------------- | ----------------------------- |
| Concept Slice 1 (schema, persist, prompt, pack, plumbing) | E1, E3                        |
| Concept Slice 2 (W2 manifest, W3 budget, W1 versioning)   | E4                            |
| Concept Slice 3 (Router, arch artifact, references)       | E7                            |
| Concept Slice 4 (gate)                                    | E9                            |
| Concept Slice 5 (PRD/UX, rail UI, logs)                   | E12                           |
| VQA E1 (grammar, clock, judge)                            | E2                            |
| VQA E2 (seam, L2-state, rigor-cap, tamper)                | E5                            |
| VQA E3 (shared engine, verdict, block rule)               | E6                            |
| VQA E4 (QA-AUTHOR, level-set, pack)                       | E8                            |
| VQA E5 (fix loop)                                         | E10                           |
| VQA E6 (HITL, generality)                                 | E11                           |
| VQA E7-arch (wave-gate rewrite)                           | E13                           |
| **System-Graph integration (live substrate)**             | E3.5, E7.3, E7.5, E9.5, E11.4 |

### Cross-session contract (CLOSED rounds 1–3 — encoded, not re-litigated)

| Item                        | Concept side                 | VQA side                                       |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| `manual→behavior` downgrade | E9.4 (flag + validate only)  | **E8.3 owns it** (logged, forces needsBrowser) |
| `manualReason` 8-enum       | E1.1 (validate), E9.4 (gate) | E11.2 (display)                                |
| W2 section/harness manifest | **E4.1 emits**               | E8.5 reads (H9)                                |
| W9 appearance floor         | E9.4 (gate-side)             | E11.5 (per-AC pairing)                         |
| `needsBrowser` one-rule     | E1.1                         | E8.2                                           |

### Validation checklist

- ✅ **All requirements covered** — both PRDs' epics/FRs + all W-list/H-items + the 5 graph additions map to a story (traceability above).
- ✅ **Foundation first** — E1 (shared schema + W4 persist) and E2 (grammar) are leaf-dependency, ship-together.
- ✅ **No forward dependencies** — every `Prerequisites` points to earlier stories/epics or the live System Graph.
- ✅ **Vertically sliced** — each story ships type+impl+test or a usable surface; the must-fix pack collision is its own story (E3.5).
- ✅ **BDD + verify** on all 74 (dogfooding); mostly `verify:build`/`behavior` (this plan builds the QA system), `appearance` on UI stories.
- ✅ **Touch Points + Forbidden Areas** on all 74 — wave-conflict resolver can serialize collisions.
- ✅ **Constraints honored** — DynamoDB multi-table; Bearer-only; never auto-bypass a gate (E9 flags, E8 downgrades, E11 blocks ship); never rebuild substrate (extend pack/wave/Story Context Pack); graph consumed, not rebuilt; cold-Memgraph graceful degradation on every graph dependency.

### Wave-collision notes (for the resolver)

- `story-context-pack.mjs`: **E3.2, E3.3, E3.5, E4.3, E7.7, E8.5** all touch it → serialized (each additive; E3.5 fixes the section-order contract first, then E7.7/E8.5 slot in).
- `pm-plan-prompt.ts`: **E1.5, E3.1, E7.8** → serialized.
- `plan-output-schema.ts`: **E1.1, E1.2, E4.2** → serialized.
- `visual-qa-pipeline.ts`: **E2.2, E2.3, E2.4, E5.3, E5.6, E11.5** → serialized.
- `wave-vqa-runner.mjs`: **E6.2, E8.4, E10.1–E10.5, E13.1–E13.4** → serialized (E13 is the rewrite; everything else additive before it).
- `gate-check-job.mjs`: **E9.1–E9.5** → serialized (same new file, build up).
- `visual-test-classifier.ts`: **E5.4, E8.2** → serialized.
- Concept rail UI (`plan-dashboard/views/`): **E12.4, E12.5, E12.7** → serialized (additive panels/overlays).

### Recommended delivery order

1. **W1 (ship-together foundation):** E1 ∥ E2 — proves probe-from-AC once both land.
2. **W2 (consume + primitives):** E3 (incl. the pack-collision fix E3.5) ∥ E4.
3. **W3 (oracle + engine + routing):** E5 → E6; E7 in parallel (graph-grounded arch).
4. **W4 (authoring + gates):** E8 (cross-PRD convergence) ∥ E9 (gate) ∥ E10 (fix loop).
5. **W5 (HITL + UI):** E11 ∥ E12.
6. **W6 (deferred lift):** E13.

### Next step

Use the `create-story` workflow per story for implementation plans, **or** (per the operator's standing preference — `[[implement_from_epics_directly]]`) feed this epics file straight into the enriched `pm-plan` decompose once E1–E4 land, since the story specs here are already BMAD-grade. The cross-PRD **ship-together pair is E1 + E2**; start there.
