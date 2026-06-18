# Concept Document-Generation Engine — Epic & Story Breakdown

- **Author:** Richie
- **Date:** 2026-06-16
- **Status:** Planned (BMAD-grade epic/story breakdown)
- **Design source:** `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` (§3–§13)

## Intent

The Concept stage evolves from a single PM shot (intent → epics/stories/waves) into a BMAD-grade spec-development chain: a dynamic, operator-facing DAG (`intent → concept-route → prd-gen → [ux-gen iff UI] → arch-gen → enriched pm-plan → readiness gate → Start development`) where the Concept Router decides _which_ artifacts apply, the rigor dial decides _how much_ rigor, and the `conceptInteraction` toggle decides _how_ each sub-stage runs (interactive convergence chat with an Approve gate vs autopilot one-shot). This plan delivers the real payload behind the already-shipped Router: it generates the actual PRD/UX/Architecture documents (with section manifests), orchestrates their dependency-ordered activation, runs interactive convergence on the free-agent substrate, ingests the generated docs into Mycelium as connected document/docSection nodes wired to code, and feeds the cited sections forward so the PM plan — and the DEV agent that consumes it — read the contract rather than guess at it.

## Why this plan

Today the Concept Router **only DECIDES** the chain — it emits a `conceptPlan` (uiBearing, complexity, artifacts[], gate) and persists it on the Plan row. But:

- **No document is generated.** `prd.md`, `ux-spec.md`, `architecture.md` are never written. arch-gen has a builder/prompt skeleton but no service/apply/daemon-write/enqueue. prd-gen and ux-gen do not exist.
- **No sub-stage activates.** `reducePlan` does not auto-advance after concept-route applies (FK-gating deferred). The DAG never moves past Route.
- **The PM plan ignores it.** `buildPmPlanPrompt` accepts `citableSections` but **no caller supplies it** (the E7.8 gap), so the PM defers `references[]` and the whole consistency-contract loop stays dark.
- **Nothing is visible.** Generated docs (when they exist) are not connected to each other or to code, and not surfaced in graphify.

This plan turns the Router's decision into a live, verified, visible spec-development engine.

## Builds on (already shipped — REUSE, do not re-plan)

| Primitive                              | Where                                                                                                                                                                                                                                                                                                                     | What we reuse                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Concept Router** (E7.1)              | `functions/shared/pipelines/concept-route-pipeline.ts`, `prompts/concept-route-prompt.ts`, `schemas/concept-plan-schema.ts`, `concept/concept-plan.ts`, `services/concept-route-service.ts`, `api/index.ts` (enqueue 11150–11243; apply 2040–2091), `daemon/agent-daemon.mjs` (extractors 669–707; executeStep 2072–2209) | The end-to-end single-step pipeline job template: builder → fenced-output prompt → Zod schema → guard → parse/validate/apply service → enqueue-at-creation + FK on Plan → idempotent apply endpoint → generic daemon extractor. Clone 3× for prd/ux/arch. |
| **Section manifest** (E4.1)            | `functions/shared/concept/section-manifest.ts`                                                                                                                                                                                                                                                                            | `generateSectionManifest`, `hasSection`, `sectionIds`, `resolveSection`, `slugifyHeading` — `<!--§id-->` anchors + `{id,title,lineStart,lineEnd,contentHash}` sidecar.                                                                                    |
| **Artifact versioning** (E4.4)         | `functions/shared/concept/artifact-version.ts`                                                                                                                                                                                                                                                                            | `ConceptArtifact {kind,rev,contentHash,status,dependsOn[],dependsOnHashes?}`, `recordApproval`, `applyEdit`, `staleCascade`, `railIsConsistent`, `staleArtifacts`.                                                                                        |
| **Pack cited-section inlining** (E7.7) | `daemon/pipelines/lib/story-context-pack.mjs`                                                                                                                                                                                                                                                                             | `resolveCitedSections` — inlines cited section text as the non-trimmable floor.                                                                                                                                                                           |
| **PM citableSections** (E7.8)          | `functions/shared/prompts/pm-plan-prompt.ts` (41–86, 304–322)                                                                                                                                                                                                                                                             | `buildPmPlanPrompt({citableSections?})` — renders "cite ONLY these ids" block when enriched. The single missing caller is the gap this plan closes.                                                                                                       |
| **Readiness gate** (E9)                | `functions/shared/services/solutioning-gate.ts`, `schemas/plan-output-schema.ts` (`validateReferenceSections`)                                                                                                                                                                                                            | `runSolutioningGate`, set-membership reference validation at decompose + gate.                                                                                                                                                                            |
| **arch-gen prompt/pipeline**           | `functions/shared/pipelines/arch-gen-pipeline.ts`, `prompts/arch-gen-prompt.ts`                                                                                                                                                                                                                                           | Existing builder + (generic) prompt — upgrade the prompt to BMAD sections, wire service/apply.                                                                                                                                                            |
| **Free-agent substrate**               | `daemon/pipelines/free-agent-session.mjs`, `lib/free-agent-worktree.mjs`, `repositories/free-agent-{sessions,conversations}-repository.ts`, `src/hooks/use-free-agent-session.ts`                                                                                                                                         | Resumable Claude CLI session, `_assist/<sid>/` worktree confinement, per-turn persistence, event long-poll, Approve/merge card pattern, processing lock.                                                                                                  |
| **Reactive reducer + cron + lock**     | `functions/shared/services/plan-reducer.ts` (`reducePlan`), `functions/cron/wave-completion-check.ts`, `plan-repository.ts` (`acquirePlanReduceLock`)                                                                                                                                                                     | The FK-gated, lock-guarded, cron+reactive advancement model — cloned as `reduceConcept`.                                                                                                                                                                  |
| **Graph ingest**                       | `daemon/scripts/lib/system-graph-ingest.mjs` (`upsertExtractedFacts`), `lib/extractor-envelope.mjs`, `daemon/scripts/graph-sync.mjs`, `mcp/mycelium-mcp.mjs` (`blastRadius`), `lib/graph-integrity.mjs`, `src/components/development/graph-viewer.tsx`, `src/lib/graph-insights.ts`                                       | MERGE-on-nodeId idempotent ingest, allowlisted edge types, blast_radius, orphan reporting, Graph-tab rendering.                                                                                                                                           |
| **Doc→code resolution oracle** (E6.4)  | `daemon/scripts/ground-truth-injection.mjs:20-22` (`touchPointToNodeId`), `daemon/pipelines/lib/glob-intersect.mjs`                                                                                                                                                                                                       | The EXACT touchPoint→`code/<path>` encoding DEV already uses (`/`→`--`, `code/`-prefix passthrough) + glob expansion against `code/*` nodeIds. GOVERNS/blast joins reuse this — provably the same join, no reinvention.                                   |

---

## Epic Summary

| #   | Epic                                                             | Value                                                                                                                                                                                                       | Stories | Depends on | Wave |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- | ---- |
| 1   | **Durable artifact write-back & version registry**               | Generated docs land on disk WITH manifests AND a versioned Plan-row record — the choke point that makes everything downstream non-empty                                                                     | 3       | —          | W1   |
| 2   | **PRD / UX / Architecture generators**                           | The real BMAD-grade upstream documents get GENERATED by their personas (John/Sally/Winston)                                                                                                                 | 5       | E1         | W2   |
| 3   | **Dynamic sub-stage orchestration (the Concept Reducer)**        | The DAG actually MOVES — dependency-ordered activation of only the artifacts the plan needs, prototype-bypassed, idempotent, with eager-pm-plan suppressed + server-driven apply + priorArtifacts grounding | 5       | E1, E2     | W3   |
| 4   | **Interactive convergence chat + Approve gates + autopilot**     | Operators CONVERGE on specs via a real elicit→converge prompt + decision cards and Approve to advance; autopilot auto-advances                                                                              | 9       | E2, E3     | W4   |
| 5   | **PM-plan enrichment & loop closure**                            | The PM cites REAL sections (daemon + manual/import paths); references are verified at decompose + gate (incl. contentHash equality); DEV inlines the contract                                               | 6       | E2, E3     | W5   |
| 6   | **Graphify doc-ingestion (doc↔doc↔code + Graph-tab visibility)** | Generated docs become connected, visible graph nodes wired to the code they govern (via `touchPointToNodeId` + glob), with edge-prune + soft-orphan invariant                                               | 6       | E2, E5     | W6   |
| 7   | **End-to-end verification & dynamic-axis guards**                | Prove the whole chain works across every rigor × uiBearing × interaction cell, byte-identical prototype, pm-plan ordering, and Graph-tab payoff                                                             | 3       | E1–E6      | W7   |

**Totals: 7 epics, 37 stories, 7 waves.**

---

## Dynamic-workflow handling (applies to every epic)

Four control facts thread through all stories; each is enforced ONCE, at a single choke point, never re-inferred:

- **UX iff `uiBearing`** — ux-gen is enqueued/rendered/ingested only when `conceptPlan.uiBearing === true` (i.e. a `ux-spec.sections.json` exists on disk). Non-UI plans run `route → prd → arch → pm-plan` with UX skipped entirely; Architecture then `dependsOn: ['prd']`.
- **Architecture iff in `conceptPlan`** — arch-gen runs only when `artifactPlanned(conceptPlan, 'architecture')`; Architecture's `dependsOn` is `['prd','ux']` (UI) or `['prd']` (non-UI).
- **Prototype bypass (W8)** — `rigor === 'prototype'` ⇒ no `conceptPlan` is written, no generator enqueues, no `concept/*.md` files exist, no manifest read, no doc-ingest. **`pm-plan` is byte-identical to today.** Every reducer/driver/extractor/prompt branch treats _absent `conceptPlan` / absent `concept/` dir_ as the v1 path. Never synthesize an empty `conceptPlan` or empty document node.
- **Brownfield change ⇒ graph-grounded arch** — for `kind === 'change'` plans, arch-gen inlines real system-graph facts (tables/lambdas/endpoints/files the change touches) so the architecture is grounded in what exists, not invented. Greenfield runs cold (empty ground-truth).
- **No eager pm-plan when a chain will exist** — at plan creation (`functions/api/index.ts:11118-11142`) today a `pm-plan` job is enqueued PENDING _unconditionally_ for `initial|change|experiment`, in parallel with the concept-route job. When `shouldRunConceptRoute(plan)` is true (non-prototype, a `conceptPlan` WILL exist) this eager pm-plan must be SUPPRESSED — `reduceConcept` owns the single `enqueue-pm-plan` transition once all artifacts approve. Only the prototype path keeps the creation-time eager enqueue (preserving the W8 byte-identical guarantee). Enforced once, at creation, in Story 3.2.
- **`priorArtifacts` are injected daemon-side, not Lambda-side** — every generator prompt that consumes an upstream artifact (ux-gen needs the approved PRD; arch-gen needs PRD+UX) is enqueued by the Lambda with a `{{PRIOR_ARTIFACTS}}` placeholder; the daemon fills it from the on-disk approved manifests at run time, mirroring `loadCitableSections` (Story 5.2). The Lambda CANNOT read EC2 disk — the same constraint that forces the pm-plan placeholder. Owned by Story 3.2a.

---

## EPIC 1 — Durable artifact write-back & version registry

**Value:** Make any generated concept artifact land deterministically on disk WITH its citable-section manifest AND a versioned record on the Plan row. Without this, every generator is a no-op that drops its own output, citation has nothing to resolve against, and the W1 stale cascade has no ground to stand on. **Highest leverage — must land first.**

### Story 1.1 — Per-artifact version registry + generator FKs on the Plan row

- **As a** pipeline engineer
- **I want** the Plan row to carry an optional `conceptArtifacts[]` registry plus per-generator FK fields
- **So that** the orchestrator, rail, stale-cascade, and gate all read one durable source of truth for which artifacts exist and their draft/approved/stale status

**Acceptance criteria**

- **Given** a legacy/prototype plan with no `conceptPlan` **When** it is read and persisted **Then** `conceptArtifacts` stays absent and round-trip is byte-identical _(verify: state)_
- **Given** an mvp plan whose `conceptPlan.artifacts = [prd, arch]` (uiBearing=false) **When** `apply-concept-plan` persists **Then** `plan.conceptArtifacts` contains exactly `prd` + `arch` rows (`status:'draft', rev:0`, `dependsOn` copied from each `ConceptPlanArtifact`) and NO `ux` row _(verify: state)_
- **Given** the same plan **Then** `conceptArtifactJobIds` and `prdGenJobId`/`uxGenJobId`/`archGenJobId` FK fields exist and are optional _(verify: build)_
- **Given** the chain-started signal **Then** a durable `conceptChainStarted` predicate is defined as: `any non-undefined generator FK (prd/ux/archGenJobId) OR any conceptArtifacts[].rev > 0`; this single predicate is the source of truth for the `conceptInteraction` mode-lock referenced by Stories 4.5d and 7.2 (no new persisted "first-artifact-started" fact is needed — it is derived from fields this story already introduces) _(verify: build)_

**Prerequisites:** none
**Touch Points:** `functions/shared/types/plan.ts`, `functions/shared/concept/artifact-version.ts`, `functions/shared/repositories/plan-repository.ts`, `functions/shared/services/concept-route-service.ts`, `functions/shared/services/resolve-concept-interaction.ts` (define `conceptChainStarted` predicate), `functions/api/index.ts`
**Forbidden Areas:** do NOT modify the wave engine, `EpicStory`/`AcceptanceCriterion` schema (owned by E5), or any prototype/v1 code path; all new fields optional.
**Technical Notes:** reuse the shipped `ConceptArtifact` type and state machine in `artifact-version.ts` verbatim — this story only adds the Plan-row field + seeds it from `conceptPlan.artifacts` at apply time.

### Story 1.2 — Daemon artifact write-back helper (capture → manifest → two-phase atomic write → register)

- **As a** daemon
- **I want** a `writeConceptArtifact(projectDir, kind, rawMd, {rev})` helper
- **So that** a generated markdown artifact and its `.sections.json` sidecar land atomically and idempotently on disk with deterministic anchors

**Acceptance criteria**

- **Given** captured `ARCHITECTURE_MD` **When** write-back runs **Then** `<projectDir>/concept/architecture.md` + `architecture.sections.json` both exist, `<!--§id-->` anchors sit above every ATX heading, and the sidecar `contentHash` matches the file _(verify: state)_
- **Given** a re-run with identical content **When** write-back runs **Then** both files are byte-identical and `resolveSection` slices a known section deterministically _(verify: behavior)_
- **Given** a partial crash mid-write **Then** no half-written file is visible (tmp → fsync → atomic rename) _(verify: state)_
- **Given** a shared markdown fixture **When** the daemon `.mjs` reimplemented slugifier + `contentHash` run over it **Then** the emitted `.sections.json` (ids, line ranges, `contentHash`) is BYTE-IDENTICAL to `functions/shared/concept/section-manifest.ts` `generateSectionManifest` output for the same fixture — the parity check lands in W1 with the reimplementation, NOT five waves later at E7.3 _(verify: build)_

**Prerequisites:** 1.1
**Touch Points:** `daemon/agent-daemon.mjs`, `daemon/pipelines/lib/free-agent-worktree.mjs`, `daemon/pipelines/__tests__/concept-manifest-parity.test.mjs` (new — shared-fixture parity vs the TS `generateSectionManifest`); reads contract from `functions/shared/concept/section-manifest.ts`
**Forbidden Areas:** do NOT import `section-manifest.ts` into a `.mjs` at runtime — keep the slugifier/sidecar contract as the shared surface (mirror the inline `resolveSection` already in `story-context-pack.mjs`); do NOT write on draft, only on apply/promote; do NOT land the reimplemented slugifier in W1 without the parity AC above passing.
**Technical Notes:** the `.md` is the artifact of record (not a job variable) — this dodges the `stripTransientVars` ~400KB DDB cap. Reuse `generateSectionManifest`'s `contentHash` so manifest and Plan-row never drift. The W1 fixture parity test is the local guard; E7.3's end-to-end join-key test remains the integration backstop — both exist, neither replaces the other. A slugifier divergence introduced in W1 is caught in W1.

### Story 1.3 — Generic apply-service: parse fenced MD, register rev/contentHash/status on Plan

- **As a** plan service
- **I want** a `concept-artifact-service.ts` that parses a generator's fenced output and updates the matching `ConceptArtifact` row
- **So that** apply is an idempotent parse→validate→persist funnel that drives the version state machine

**Acceptance criteria**

- **Given** a completed arch-gen job with `ARCHITECTURE_MD` **When** apply runs **Then** `plan.conceptArtifacts` has `architecture` at `status:'draft'`, rev bumped, `contentHash` = the manifest's _(verify: state)_
- **Given** the same job re-applied **When** apply runs again **Then** one rev (no double-bump), identical `contentHash`, status unchanged _(verify: behavior)_
- **Given** the PRD is later edited via `applyEdit` **Then** `architecture` flips to `stale` via `staleCascade` _(verify: state)_

**Prerequisites:** 1.2
**Touch Points:** `functions/shared/services/concept-route-service.ts` (clone), `functions/shared/concept/artifact-version.ts`, `functions/shared/repositories/plan-repository.ts`, `functions/api/index.ts`
**Forbidden Areas:** no Zod schema for the markdown payload (it's prose, not JSON — validate non-empty + manifest-builds only); do NOT auto-record approval here (autopilot auto-approve and interactive Approve are owned by E3/E4).
**Technical Notes:** clone `parseConceptRouteOutput`/`applyConceptRouteOutput` shape — swap the variable name and call `recordApproval`/`applyEdit` + `staleCascade`. Use a conditional `updatePlanFields` so cron replay is a no-op.

---

## EPIC 2 — PRD / UX / Architecture generators

**Value:** Produce the real BMAD-grade upstream documents — each as a generic single-step pipeline job cloned from the proven Concept Router template, so the daemon needs NO new `jobType` and each artifact emits the section-manifest sidecar the `references[]` contract depends on.

### Story 2.1 — prd-gen pipeline builder + BMAD-sectioned prompt with depth scaling (PM/John)

- **As a** plan author
- **I want** a `generatePrdGenPipeline` + `buildPrdGenPrompt` that emit a BMAD-sectioned `prd.md`
- **So that** the PRD's ATX sections become meaningful manifest anchors that stories and the gate hang off of

**Acceptance criteria**

- **Given** rigor=mvp (depth=light) **When** the prompt is built **Then** it instructs ATX headings for Scope (MVP→Growth→Vision) + Functional Requirements and omits deep domain sections _(verify: build)_
- **Given** rigor=production (depth=full) **Then** NFR + Domain Requirements sections are required _(verify: build)_
- **Given** the builder runs **Then** the pipeline's extractor delimiters (`---PRD_MD---` / `---END_PRD_MD---`) match the prompt fences byte-for-byte _(verify: build)_

**Prerequisites:** none (parallel-safe within W2)
**Touch Points:** `functions/shared/pipelines/prd-gen-pipeline.ts` (new, clone of `concept-route-pipeline.ts`), `functions/shared/prompts/prd-gen-prompt.ts` (new), `functions/shared/pipelines/role-policy.ts`, `functions/shared/pipelines/__tests__/prd-gen-pipeline.test.ts`; section anchors per `bmad/bmm/workflows/2-plan-workflows/prd/instructions.md`
**Forbidden Areas:** no BMAD halt/elicitation in the autopilot prompt — this builder is the autopilot one-shot ONLY; the interactive elicit→converge prompt is a SEPARATE first-class builder authored in Story 4.1a, selected by the mode branch (Story 4.1/4.2), and these autopilot files must NOT be listed as the convergence touch points; do NOT add a daemon `jobType` discriminator — keep generic pipeline.
**Technical Notes:** clone `generateConceptRoutePipeline` (agent PM/John, `buildAgentConfig({role:'PM', name:'PRD (John)', model:'sonnet'})`). A typo'd delimiter silently yields an undefined variable — the parity test is mandatory.

### Story 2.2 — ux-gen pipeline builder + BMAD UX-sectioned prompt consuming PRD sections (UX/Sally)

- **As a** plan author
- **I want** a `generateUxGenPipeline` + `buildUxGenPrompt` that emit `ux-spec.md` consuming approved PRD sections
- **So that** component/state/journey decisions are grounded in the PRD scope (serial PRD→UX ordering)

**Acceptance criteria**

- **Given** PRD cited sections passed as `priorArtifacts` **When** the prompt is built **Then** it instructs ATX headings per the BMAD UX 9-section template AND directs consistency with the PRD scope _(verify: build)_
- **Given** no `priorArtifacts` **Then** it still emits a valid skeleton _(verify: build)_
- **Given** the builder runs **Then** `---UX_MD---` fences match the extractor delimiters _(verify: build)_

**Prerequisites:** 2.1
**Touch Points:** `functions/shared/pipelines/ux-gen-pipeline.ts` (new), `functions/shared/prompts/ux-gen-prompt.ts` (new); template per `bmad/bmm/workflows/2-plan-workflows/create-ux-design/instructions.md`
**Forbidden Areas:** this story only BUILDS the job; the `uiBearing` enqueue gate is owned by E3 — do NOT add applicability logic here.
**Technical Notes:** agent UX/Sally; `priorArtifacts` are resolved-cited PRD sections (inlined text), not paths.

### Story 2.3 — Upgrade arch-gen prompt to BMAD architecture sections + depth scaling (Architect/Winston)

- **As a** plan author
- **I want** the existing `buildArchGenPrompt` rewritten to real BMAD architecture sections
- **So that** `architecture.md` becomes the multi-agent consistency contract that kills parallel-wave drift

**Acceptance criteria**

- **Given** uiBearing=true **When** the prompt is built **Then** it requires matching the UX component/state/routing model AND emits an ATX-headed Implementation Patterns section covering the 7 categories (naming/structure/format/communication/lifecycle/location/consistency) _(verify: build)_
- **Given** depth=lite (non-production) **Then** only Decision Summary Table + key patterns are required (trimmed to stay citable + within size budget) _(verify: build)_
- **Given** depth=full **Then** all sections (Project Structure, Epic Mapping, Tech Stack, Consistency Rules, Data Architecture, API Contracts) are required _(verify: build)_
- **Given** the arch agent's role/persona config **Then** `role-policy.ts` grants the arch-gen agent the tools its prompt requires — notably WebSearch for the no-hardcoded-versions rule; if allowlists are role-keyed, either an ARCHITECT role is added OR it is documented that `role:'PM'` is the intended capability bucket for all doc generators AND that bucket includes WebSearch (a one-line assertion that the arch agent can actually WebSearch) _(verify: build)_

**Prerequisites:** none (parallel-safe within W2)
**Touch Points:** `functions/shared/prompts/arch-gen-prompt.ts`, `functions/shared/pipelines/role-policy.ts`; sections per `bmad/bmm/workflows/3-solutioning/architecture/instructions.md` + `pattern-categories.csv`
**Forbidden Areas:** do NOT hardcode tech versions (BMAD WebSearch-verify rule); keep the existing `arch-gen-pipeline.ts` builder shape — only the prompt body changes.
**Technical Notes:** the 7 implementation-pattern categories are the load-bearing anti-drift surface. Depth=lite must aggressively trim to avoid the ~400KB variable cap; the `.md` is captured to disk regardless (Story 1.2).

### Story 2.4 — Autopilot one-shot apply path: write manifest + register version for any generator

- **As a** daemon/Lambda
- **I want** apply endpoints (`apply-prd`/`apply-ux`/`apply-arch`) that route a completed generator job through write-back + apply-service
- **So that** any generated artifact lands on disk with its sidecar and a versioned Plan-row record, idempotently

**Acceptance criteria**

- **Given** a COMPLETED prd-gen job **When** `POST /api/plans/:id/apply-prd` runs **Then** `concept/prd.md` + `prd.sections.json` exist, `sectionIds()` is non-empty, and the `prd` row carries `rev=1`, `contentHash` set _(verify: state)_
- **Given** the same job **When** apply runs twice **Then** files are byte-identical and the row has one rev bump _(verify: behavior)_
- **Given** no `jobId` param **Then** auto-discovery finds the most-recent COMPLETED job with the artifact variable on the same `workingDir` _(verify: behavior)_

**Prerequisites:** 2.1, 2.3, Story 1.3
**Touch Points:** `functions/api/index.ts` (clone `apply-concept-plan` 2047–2091), `daemon/agent-daemon.mjs`, `functions/shared/concept/section-manifest.ts`, `functions/shared/concept/artifact-version.ts`
**Forbidden Areas:** do NOT read the full markdown from `job.variables` for persistence — read the on-disk `.md` (Story 1.2 wrote it); do NOT auto-advance to the next sub-stage here (E3 owns chaining).
**Technical Notes:** idempotent FK-lookup + parse/validate/persist, exactly the apply-concept-plan pattern.

### Story 2.5 — Brownfield grounding: inject system-graph ground truth into arch-gen for change plans

- **As a** plan author working on a brownfield repo
- **I want** `kind==='change'` plans to feed real system-graph facts into arch-gen
- **So that** the architecture is grounded in what actually exists, not invented greenfield

**Acceptance criteria**

- **Given** a change plan **When** arch-gen is enqueued **Then** a `<ground_truth>` block contains real node kinds (tables/lambdas/endpoints/files) from the Mycelium graph and the prompt forbids contradicting them _(verify: behavior)_
- **Given** a greenfield plan **Then** the ground-truth block is empty and the prompt runs cold _(verify: behavior)_

**Prerequisites:** 2.3, 2.4
**Touch Points:** `functions/api/index.ts`, `daemon/mcp/mycelium-mcp.mjs`, `functions/shared/prompts/arch-gen-prompt.ts`
**Forbidden Areas:** do NOT block greenfield plans on graph availability; ground-truth is additive context only.
**Technical Notes:** reuse `mycelium-mcp.mjs` blast/query to pull the change's touched nodes; mark the block as graph-sourced for provenance.

---

## EPIC 3 — Dynamic sub-stage orchestration (the Concept Reducer)

**Value:** The DAG actually MOVES. A pure reducer over `(conceptPlan, conceptArtifacts[], conceptInteraction)` computes the single next sub-stage to activate — only artifacts present in the plan, only when all `dependsOn` are approved — and a thin, lock-guarded, cron+reactive driver enqueues exactly that one job. Reuses the `reducePlan` + reduce-lock + orphan-requeue machinery already in production. **Mechanism decision: a daemon-adjacent reactive reducer in the Lambda, NOT daemon self-spawn and NOT an API step-machine** (the type system, Zod, and manifest reads live Lambda-side; the daemon stays dumb).

### Story 3.1 — `reduceConcept()` pure function: next-artifact selection in dependency order

- **As a** the orchestrator
- **I want** a pure `reduceConcept(plan)` that returns the single next action
- **So that** advancement is deterministic, table-testable, and reduces over `conceptPlan.artifacts` (no hardcoded artifact set)

**Acceptance criteria**

- **Given** `[prd approved, arch draft dependsOn prd]` **When** `reduceConcept` runs **Then** it returns `enqueue-artifact('arch')` _(verify: state)_
- **Given** all `conceptPlan.artifacts` approved **Then** it returns `enqueue-pm-plan` _(verify: state)_
- **Given** prototype (no `conceptPlan`) **Then** it returns `noop` (v1 path untouched, W8) _(verify: state)_
- **Given** interactive + a COMPLETED-but-not-approved artifact **Then** it returns `awaiting-approval` (BLOCKS dependents) _(verify: state)_

**Prerequisites:** Story 1.1
**Touch Points:** `functions/shared/services/concept-reducer.ts` (new — the ONLY genuinely new core file), `functions/shared/concept/artifact-version.ts`, `functions/shared/concept/concept-plan.ts`, `functions/shared/types/plan.ts`
**Forbidden Areas:** no I/O in the reducer (pure function); do NOT enqueue more than one artifact (serial DAG, D5).
**Technical Notes:** reuse `railIsConsistent`/`staleArtifacts`; topological selection over `dependsOn`. Table-driven tests must cover the non-UI (no ux) and stale cells.

### Story 3.2 — Concept driver: suppress eager pm-plan, auto-apply completed generators, enqueue-next on apply + on cron tick (idempotent, lock-guarded)

- **As a** the system
- **I want** to (1) suppress the creation-time eager pm-plan when a concept chain will exist, (2) detect a COMPLETED generator job and drive its `apply-<kind>` server-side, and (3) wire `reduceConcept` into two drivers (reactive apply + cron pass) under the per-plan reduce lock
- **So that** the next artifact auto-launches exactly once, replay-safe, without daemon self-spawn — and pm-plan never fires before the artifacts it must cite exist

**Acceptance criteria**

- **Given** an mvp/production plan at creation (`shouldRunConceptRoute(plan) === true`) **When** the create handler runs **Then** NO `pm-plan` job is enqueued at creation — only the concept-route job — and `pm-plan` is created later only via `reduceConcept → enqueue-pm-plan` after all artifacts are approved _(verify: behavior)_
- **Given** a `rigor='prototype'` plan at creation **When** the create handler runs **Then** the eager pm-plan IS enqueued exactly as today (byte-identical, W8) _(verify: behavior)_
- **Given** a generator job transitions to COMPLETED (e.g. prd-gen) **When** the server-driven completion path fires **Then** the corresponding `apply-<kind>` is invoked server-side (daemon job-completion hook OR cron pass), with NO frontend click required — a closed browser does not wedge the DAG _(verify: behavior)_
- **Given** an autopilot plan with arch next **When** `apply-prd` completes **Then** exactly one arch-gen job is created and the FK is stamped in `conceptArtifactJobIds` _(verify: behavior)_
- **Given** re-running `apply-prd` **Then** no duplicate job is created _(verify: behavior)_
- **Given** concurrent cron + reactive apply **Then** the reduce lock serializes them and exactly one next job exists _(verify: behavior)_
- **Given** the cron plan-selection filter (today `status ∈ {developing, fixing}`, `wave-completion-check.ts:31`) **When** the concept pass is added **Then** the filter is WIDENED to also scan `status === 'concept'` plans with `plan.conceptPlan` present — otherwise every concept-stage plan is skipped and the chain never advances unattended _(verify: behavior)_

**Prerequisites:** 3.1, Story 2.4
**Touch Points:** `functions/api/index.ts` (creation enqueue 11118-11142, `shouldRunConceptRoute` gate), `functions/cron/wave-completion-check.ts` (widen plan-selection filter beyond `{developing, fixing}`), `daemon/agent-daemon.mjs` (generator-COMPLETED → POST `apply-<kind>` hook), `functions/shared/services/concept-reducer.ts`, `functions/shared/repositories/plan-repository.ts`
**Forbidden Areas:** do NOT leave apply as a frontend poll (autopilot "no human click" cannot hold — `src/hooks/use-plans.ts:116` must be backed by a server-driven trigger); do NOT broaden the cron hot-loop for non-concept plans — gate the concept pass on `plan.conceptPlan` presence; do NOT enqueue when a non-terminal FK already exists for that artifact; do NOT enqueue the eager pm-plan for any non-prototype plan.
**Technical Notes:** mirror the `reducePlan` reactive (`POST /check-wave-completion`) + cron pattern and `acquirePlanReduceLock`. FK-stamp exactly as `index.ts:11230`. The connective trigger that detects a COMPLETED generator and POSTs `apply-<kind>` is the explicit seam: prefer the daemon job-completion hook (server-driven webhook) with the widened cron pass as the idempotent backstop. The frontend poll may remain as a UX accelerant but is never the sole driver.

### Story 3.2a — Daemon-side `priorArtifacts` injection for ux-gen / arch-gen (the grounding seam)

- **As a** the driver + daemon
- **I want** ux-gen/arch-gen to be enqueued by the Lambda with a `{{PRIOR_ARTIFACTS}}` placeholder that the daemon fills from the approved upstream manifests at run time
- **So that** ux-gen consumes the approved PRD sections and arch-gen consumes approved PRD+UX sections as INLINED text — the "consistency contract" is grounded, not hollow

**Acceptance criteria**

- **Given** ux-gen is enqueued after PRD approval **When** the daemon prepares the prompt **Then** `{{PRIOR_ARTIFACTS}}` is substituted (before `substituteTemplate`) with the resolved-cited PRD section bodies read from `concept/prd.sections.json` + `prd.md` on disk — inlined text, not paths _(verify: behavior)_
- **Given** arch-gen is enqueued after PRD (and UX, if uiBearing) approval **Then** the daemon fills `{{PRIOR_ARTIFACTS}}` with PRD (and UX) section bodies; for a non-UI plan only PRD is injected _(verify: behavior)_
- **Given** no upstream manifests on disk (shouldn't happen post-gate, but defensively) **Then** the placeholder resolves to an empty/skeleton instruction and the generator still produces a valid doc _(verify: behavior)_
- **Given** the Lambda enqueue path **Then** it NEVER carries the upstream markdown as a persisted job variable (avoids the ~400KB cap) — only the placeholder is enqueued; the daemon reads disk _(verify: build)_

**Prerequisites:** Story 2.2, Story 2.3, Story 3.2
**Touch Points:** `daemon/pipelines/lib/story-context-pack.mjs` (reader, sibling of `loadCitableSections`/`resolveCitedSections`), `daemon/agent-daemon.mjs` (substitution in `executeStep`), `functions/shared/pipelines/{ux-gen,arch-gen}-pipeline.ts`, `functions/shared/prompts/{ux-gen,arch-gen}-gen-prompt.ts`, `functions/api/index.ts`
**Forbidden Areas:** the Lambda must NOT attempt to read EC2 disk; never inline upstream text Lambda-side; keep id/section ordering stable (manifest order).
**Technical Notes:** this is the SAME daemon-side `{{...}}` substitution mechanism Story 5.2 builds for pm-plan — reuse the reader. The WHO/WHEN is now explicit: Lambda enqueues placeholder, daemon fills `priorArtifacts` from approved manifests, mirroring `loadCitableSections`. Without this story ux-gen/arch-gen run ungrounded.

### Story 3.3 — Edit-an-artifact triggers stale cascade + reducer re-activation; idempotent regenerate

- **As an** operator
- **I want** editing/regenerating an upstream artifact to flip dependents stale and re-activate them in order
- **So that** the "consistency contract" is never green-but-secretly-stale (the W1 highest-leverage fix)

**Acceptance criteria**

- **Given** prd+arch approved (`arch.dependsOnHashes` pins prd hash) **When** the PRD is edited (`applyEdit`) **Then** arch flips `stale`, the next driver tick re-enqueues arch-gen, and `railIsConsistent` is false until arch re-approved _(verify: state)_
- **Given** an approved prd **When** regenerate is triggered (FK cleared, status→draft, old `.md` retained until new lands) **Then** one fresh prd-gen job is enqueued and a concurrent double-submit creates no duplicate _(verify: behavior)_
- **Given** an upstream artifact edit/regenerate flips the rail inconsistent AFTER the PM plan was already decomposed (epics live, `EpicStory.references[]` frozen) **When** the edit applies **Then** `validateReferenceSections` is re-run against the NEW manifest over all persisted `references[]`; any now-dangling cite (section id removed/renamed) is reported on the rail and BLOCKS the gate as content-stale — never left silently in place — and the operator is told regenerate is the only sanctioned path to refresh frozen references (the epic tree is immutable post-decompose) _(verify: state)_
- **Given** an on-disk `concept/<kind>.md` whose Plan-row `conceptArtifacts[kind]` row is missing or behind (apply/write-back crashed between fsync-rename and the rev bump) **When** the cron `reduceConcept` tick runs **Then** it detects the orphaned `.md` and re-drives `apply-<kind>` idempotently (conditional `updatePlanFields` makes replay a no-op), recovering the stranded state _(verify: behavior)_

**Prerequisites:** 3.1, 3.2
**Touch Points:** `functions/api/index.ts` (`POST /plans/:id/concept/:kind/edit`, `.../regenerate`), `functions/shared/concept/artifact-version.ts`, `functions/shared/services/concept-reducer.ts`, `functions/shared/schemas/plan-output-schema.ts` (`validateReferenceSections`), `functions/cron/wave-completion-check.ts`, `functions/shared/repositories/plan-repository.ts`
**Forbidden Areas:** do NOT delete the prior `.md` before the new one lands (two-phase); do NOT silently re-plan on a stale rail; do NOT leave dangling frozen `references[]` after an upstream rename — surface them and block.
**Technical Notes:** `applyEdit` + `staleCascade` to fixpoint; `reduceConcept` treats `status!=='approved'` as re-runnable so re-activation is automatic. Write-back is the single source of truth: the on-disk `.md` re-drives apply on the next tick (idempotent). Citation-consistency (re-validate frozen `references[]`) is distinct from artifact-consistency (`staleCascade`) — both must close.

### Story 3.4 — Generalize orphan-requeue to autopilot concept-gen jobs (crash recovery)

- **As a** the daemon
- **I want** orphaned RUNNING autopilot concept jobs to auto-requeue to PENDING on restart
- **So that** a daemon crash doesn't wedge the plan in `concept` (mirrors the 2026-06-16 app-bootstrap fix)

**Acceptance criteria**

- **Given** a RUNNING autopilot arch-gen job whose daemon died **When** the stale sweep runs **Then** it requeues to PENDING and completes, not STALE-terminal _(verify: behavior)_
- **Given** an interactive free-agent convergence turn **When** the sweep runs **Then** it is NOT auto-requeued (mid-conversation state) _(verify: behavior)_
- **Given** a `graph-sync --doc-scan` (Story 6.5) that FAILED after an artifact apply (rail green, graph missing the doc edges) **When** the next cron pass runs **Then** the doc-scan is retried (idempotent MERGE makes replay free) and, until it succeeds, the rail/Graph-tab surfaces a "stale graph" badge rather than silently losing the edges _(verify: behavior)_

**Prerequisites:** 3.2
**Touch Points:** `daemon/agent-daemon.mjs` (`REQUEUE_ON_ORPHAN_JOB_TYPES`), `daemon/pipelines/stale-heartbeat.mjs`, `daemon/scripts/graph-sync.mjs`, `functions/cron/wave-completion-check.ts`, `functions/api/index.ts`
**Forbidden Areas:** never auto-requeue interactive turns; never mark a plan graph-clean while a doc-scan retry is pending.
**Technical Notes:** since there is no `jobType` discriminator, tag autopilot concept-gen jobs with a recognizable marker (e.g. `conceptArtifactKind` on payload) for the classifier to match.

---

## EPIC 4 — Interactive convergence chat + Approve gates + autopilot

**Value:** Operators CONVERGE on each artifact via free-text chat + bounded BMAD decision cards, reach a template-output checkpoint, and click Approve to promote + advance; autopilot runs the same artifacts as one-shots that auto-advance and are reviewed after. Built entirely on the shipped free-agent substrate. **`conceptInteraction` selects only the turn-loop shape — `reduceConcept`'s advancement logic is identical except for who flips `draft→approved`.** This is spec convergence at PLANNING time — NOT to be conflated with `verify:'manual'` (QA-time behavior verification).

### Story 4.1 — Mode-aware enqueue + auto-approve-on-complete for autopilot

- **As a** the driver
- **I want** enqueue to branch on `resolveConceptInteraction(plan)`
- **So that** autopilot runs a one-shot job (auto-approve on apply) while interactive runs a free-agent session (stays draft until Approve)

**Acceptance criteria**

- **Given** autopilot **When** prd-gen completes + applies **Then** prd auto-flips `approved` and arch enqueues with no human click _(verify: behavior)_
- **Given** interactive **Then** prd stays `draft` and arch is NOT enqueued until Approve _(verify: behavior)_

**Prerequisites:** Story 3.2
**Touch Points:** `functions/shared/services/concept-reducer.ts`, `functions/api/index.ts`, `daemon/pipelines/free-agent-session.mjs`, `functions/shared/services/resolve-concept-interaction.ts`
**Forbidden Areas:** do NOT gate the existing autopilot path on interactivity infra that isn't built yet; default resolution: autopilot for prototype, interactive for mvp/production.
**Technical Notes:** interactive enqueues a `free-agent-session.mjs` job scoped to `_assist/<sid>/` confined to `concept/`.

### Story 4.1a — Author the interactive convergence prompt builders (the elicit→converge contract)

- **As a** plan author
- **I want** NEW first-class convergence prompt builders (`buildPrdConvergencePrompt` / `buildUxConvergencePrompt` / `buildArchConvergencePrompt`) distinct from the E2 autopilot one-shot builders
- **So that** interactive mode produces genuinely BMAD-grade, meaningfully-sectioned docs via real elicit→converge, not flat one-shot markdown — this is the substance the whole interactive thesis rests on

**Acceptance criteria**

- **Given** an interactive PRD sub-stage **When** `buildPrdConvergencePrompt` is built **Then** the prompt pins the concrete elicitation contract: (1) a per-section `<template-output>`-equivalent checkpoint marker emitted as each major decision area converges, (2) a halt + decision-card emission protocol modeled on the numbered-option menu of `adv-elicit-methods.csv` (the agent presents methodologically-grounded options, not arbitrary forks), and (3) the parseable template-output checkpoint marker that flips the node to `awaiting-you` (Story 4.3) _(verify: build)_
- **Given** the autopilot path **Then** it uses the E2 one-shot `build{Prd,Ux,Arch}GenPrompt` builders (fenced output, no halt/elicitation) — UNCHANGED _(verify: build)_
- **Given** both builders **Then** the marker strings (`TEMPLATE_OUTPUT`, `DECISION_CARD`, checkpoint) are SHARED constants with fence-parity tests, same class as `CONCEPT_PLAN_JSON` — a typo silently fails substring extraction _(verify: build)_
- **Given** the mechanism is "distilled adv-elicit, not the BMAD XML engine" **Then** the convergence prompt inlines a distilled subset of `adv-elicit-methods.csv` (the elicitation method registry / menu semantics) directly — because the free-agent substrate (`free-agent-session.mjs`) is a raw Claude CLI session with substring-extracted markers and does NOT run the BMAD workflow engine; the card-emission marker the daemon substring-extracts is defined here with a parity test _(verify: build)_

**Prerequisites:** Story 2.1, Story 2.2, Story 2.3
**Touch Points:** `functions/shared/prompts/{prd,ux,arch}-convergence-prompt.ts` (NEW — interactive builders, sibling of the E2 one-shot builders), `functions/shared/prompts/__tests__/convergence-prompt.test.ts` (marker fence-parity), `functions/shared/prompts/concept-markers.ts` (shared marker constants); distilled methods from `bmad/core/tasks/adv-elicit.xml` + `adv-elicit-methods.csv`
**Forbidden Areas:** do NOT attempt to run the BMAD XML workflow engine inside the free-agent session (it isn't there); do NOT brand this "reuse adv-elicit" without the distilled-CSV inline + the substring-extractable card marker — that is the real work; do NOT list the autopilot gen-prompt files as the convergence builders (they are separate builders, selected by a mode branch).
**Technical Notes:** this resolves the autopilot-vs-convergence conflation: E2 one-shot ≠ E4 convergence. The card protocol is bespoke-but-methodologically-grounded (distilled adv-elicit methods), NOT a thin imitation. Adding it as a first-class story is what makes "genuinely high-quality BMAD docs + faithful elicit→converge" buildable rather than assumed.

### Story 4.2 — Concept convergence session bootstrap + bounded decision cards (uses the convergence builders)

- **As an** operator
- **I want** an interactive artifact to start as a persona-seeded free-agent session that drafts the doc using the convergence prompt builder (4.1a) and proactively surfaces bounded decision cards plus free-text refinement
- **So that** I converge on the spec through guided, methodologically-grounded forks, not a wall of prose

**Acceptance criteria**

- **Given** an mvp interactive plan reaching the PRD sub-stage **When** the rail PRD node is opened **Then** a resumable session exists (`claudeSessionId` captured) seeded with `buildPrdConvergencePrompt` (NOT the autopilot one-shot builder), `prd.md` is drafted in the worktree, and ≥1 decision card is emitted _(verify: behavior)_
- **Given** a drafting agent at an elicitation point **When** it halts **Then** the rail right-pane renders selectable decision cards (idle-visible) AND selecting an option appends it as a user turn and the agent revises _(verify: appearance + behavior)_
- **Given** the mode branch **Then** Story 2.1/4.1's enqueue selects the convergence builder for interactive and the one-shot builder for autopilot — the file each mode uses is stated explicitly _(verify: build)_

**Prerequisites:** Story 4.1a, Story 4.1
**Touch Points:** `functions/api/index.ts`, `daemon/pipelines/free-agent-session.mjs`, `daemon/pipelines/lib/free-agent-worktree.mjs`, `functions/shared/prompts/{prd,ux,arch}-convergence-prompt.ts`, `functions/shared/prompts/concept-markers.ts`, `src/hooks/use-free-agent-session.ts`, `src/components/labs/plan-dashboard/views/concept-rail.tsx`
**Forbidden Areas:** decision-card markers are substring-extracted — a typo silently fails; the fence-parity test lives in Story 4.1a; do NOT seed an interactive session with the autopilot one-shot prompt.
**Technical Notes:** reuse `createSession` + `runFreeAgentSession` + `ensureWorktree` unchanged; cards modeled on the SKILL-SCOUT gate-card / AskUserQuestion pattern AND the distilled adv-elicit method menu (4.1a). Free-text chat coexists with cards.

### Story 4.3 — Template-output checkpoint flips node to awaiting-you + reveals Approve

- **As an** operator
- **I want** the agent to emit a parseable template-output checkpoint when the doc is converged
- **So that** the rail node flips `drafting → awaiting-you` and the Approve button enables only when the draft is actually ready

**Acceptance criteria**

- **Given** an interactive session **When** the agent emits the checkpoint marker **Then** an event flips node status to `awaiting-you` and enables Approve; before that Approve is disabled _(verify: state + appearance)_

**Prerequisites:** 4.2
**Touch Points:** `daemon/pipelines/free-agent-session.mjs`, `functions/api/index.ts`, `src/hooks/use-free-agent-session.ts`, `src/components/labs/plan-dashboard/views/concept-rail.tsx`
**Forbidden Areas:** Approve must never be enabled before the checkpoint marker.
**Technical Notes:** reuse the event long-poll/aggregation in `use-free-agent-session.ts`.

### Story 4.4 — Approve endpoint: promote-on-Approve into `concept/` (W6, git-clean-safe) + reject re-drafts

- **As an** operator
- **I want** Approve to promote the converged doc into `<projectDir>/concept/`, version-bind it, and enqueue the next sub-stage; Reject to re-draft
- **So that** the converged spec survives `git clean` and unblocks the DAG, while rejection loops back with my reason

**Acceptance criteria**

- **Given** an interactive PRD at checkpoint **When** the operator Approves **Then** `concept/prd.md` + sidecar survive a subsequent `git clean -fdx`, the `prd` row becomes `approved` with `dependsOnHashes` snapshotted, and the next node (ux iff uiBearing, else arch) enqueues _(verify: behavior)_
- **Given** the operator Rejects with a reason **Then** the reason is appended as a user message, the agent re-drafts, and no promote/advance occurs _(verify: behavior)_

**Prerequisites:** 4.3, Story 1.3
**Touch Points:** `functions/api/index.ts` (`POST /plans/:id/concept/:kind/approve`, `.../reject`), `daemon/pipelines/lib/free-agent-worktree.mjs`, `functions/shared/concept/{section-manifest,artifact-version}.ts`, `daemon/pipelines/lib/story-context-pack.mjs`
**Forbidden Areas:** the promote MUST commit-or-exclude `concept/` so the App worktree's `git clean -fdx` doesn't wipe it — verify post-clean survival, not just file existence.
**Technical Notes:** `recordApproval` snapshots `dependsOnHashes`; promote target is the Story Context Pack's hardcoded `concept` path. Reuse `installCommitMsgHook` for the agent trailer.

### Story 4.5a — Rail rendering: live thread vs status tile, status dots / edge-fill / stale badges (UI)

- **As an** operator
- **I want** the Concept rail to render per mode (interactive chat+Approve / autopilot tile+log) with status dots, left-to-right edge-fill, and stale badges
- **So that** I can SEE convergence state at a glance

**Acceptance criteria**

- **Given** an mvp interactive plan **When** the rail renders **Then** PRD/UX/Arch nodes expose chat+Approve, a non-UI plan greys the UX node, and a `gate==='noop'` plan greys the gate node _(verify: appearance)_
- **Given** an approved PRD then edited **Then** PRD shows draft and dependent Arch shows a "stale — re-approve" badge; DAG edges fill left-to-right as nodes resolve _(verify: appearance)_
- **Given** a pending `graph-sync --doc-scan` retry (Story 3.4) **Then** the rail shows a "stale graph" badge _(verify: appearance)_

**Prerequisites:** 4.2, 4.4
**Touch Points:** `src/components/labs/plan-dashboard/views/concept-rail.tsx`, `src/components/labs/plan-dashboard/views/__tests__/concept-rail.test.tsx`, `src/hooks/use-free-agent-session.ts`
**Forbidden Areas:** UI-only — no backend state transitions here (timeout/mode-lock live in 4.5c/4.5d).
**Technical Notes:** reads `railIsConsistent`/`staleArtifacts`; persona icons from `buildAgentConfig` names.

### Story 4.5b — Resume convergence (closed/reopened thread)

- **As an** operator
- **I want** a closed convergence thread to reload all turns and resume
- **So that** I can leave and return mid-convergence without losing state

**Acceptance criteria**

- **Given** a 3-turn convergence session closed and reopened **Then** the thread reloads all turns and resumes via `--resume` _(verify: state)_
- **Given** a `drafting` interactive node whose daemon died (stranded past a heartbeat threshold — NOT auto-requeued by Story 3.4) **Then** the rail surfaces a resume/abandon affordance so the operator can recover it (this is the interactive-failure recovery path Story 3.4 deliberately excludes) _(verify: behavior)_

**Prerequisites:** 4.2, 4.4
**Touch Points:** `src/components/labs/plan-dashboard/views/concept-rail.tsx`, `src/hooks/use-free-agent-session.ts`, `functions/shared/repositories/free-agent-conversations-repository.ts`, `daemon/pipelines/free-agent-session.mjs`, `functions/api/index.ts`
**Forbidden Areas:** never auto-requeue a mid-conversation turn (operator-driven resume only).
**Technical Notes:** reuse `loadSession`/`getMessages` + the resumable CLI session; the `drafting`-heartbeat affordance extends coverage beyond Story 4.5c's `awaiting-you` timeout.

### Story 4.5c — `approvalTimeout` extend / convert-to-autopilot / abandon (backend state)

- **As an** operator
- **I want** an `awaiting-you` node past `approvalTimeout` to surface extend/convert/abandon — never silent auto-promote
- **So that** an abandoned convergence node doesn't wedge the DAG and is never promoted without my decision

**Acceptance criteria**

- **Given** a node `awaiting-you` past `approvalTimeout` **Then** the rail flags it and offers extend/convert-to-autopilot/abandon — never silently auto-promotes; the timer source of truth and the extend/convert/abandon transitions are defined here _(verify: behavior)_

**Prerequisites:** 4.4
**Touch Points:** `functions/api/index.ts`, `functions/shared/services/concept-artifacts-service.ts`, `functions/shared/repositories/plan-repository.ts`, `src/components/labs/plan-dashboard/views/concept-rail.tsx`
**Forbidden Areas:** `approvalTimeout` must never auto-promote.
**Technical Notes:** carries backend state — belongs near the E3/E4 reducer work, not the UI rendering story.

### Story 4.5d — `conceptInteraction` mode-lock + PATCH-reject guard (backend state)

- **As a** the system
- **I want** `conceptInteraction` to lock once the concept chain has started
- **So that** the turn-loop shape cannot flip mid-flight and destabilize the DAG

**Acceptance criteria**

- **Given** a plan where `conceptChainStarted` (the Story 1.1 predicate: any generator FK set OR any `conceptArtifacts[].rev > 0`) is true **When** `PATCH /plans/:id` carries `conceptInteraction` **Then** it is rejected (mode-locked, W10); before start it succeeds; the guard distinguishes "never set, using default" from "explicitly changed after start" via the predicate, not a separate flag _(verify: behavior)_

**Prerequisites:** Story 1.1, 4.1
**Touch Points:** `functions/api/index.ts` (`PATCH /plans/:id` conceptInteraction guard), `functions/shared/services/resolve-concept-interaction.ts` (reads `conceptChainStarted`), `functions/shared/repositories/plan-repository.ts`
**Forbidden Areas:** the mode-lock guard must distinguish default-unset from explicitly-changed-after-start; reuse the Story 1.1 predicate — do NOT restate it.
**Technical Notes:** the predicate is owned by Story 1.1; Stories 4.5d and 7.2 reference it. This carries backend state, split out of the former monolithic 4.5.

---

## EPIC 5 — PM-plan enrichment & loop closure

**Value:** Close the generate→cite→verify→consume loop. The enriched PM prompt receives `citableSections` built from the real on-disk manifests (the E7.8 gap), the emitted `references[]` are verified at decompose + gate, and the cited sections inline into the Story Context Pack so DEV reads the contract. **Defining constraint: the API Lambda CANNOT read the on-disk `<workingDir>/concept/*.sections.json` (those live on EC2)** — so `citableSections` assembly for the prompt happens daemon-side as a substituted variable; the Lambda reads manifests via SSM only for apply/gate validation.

### Story 5.1 — pm-plan prompt emits a daemon-fillable `{{CITABLE_SECTIONS}}` placeholder for enriched runs

- **As a** prompt builder
- **I want** `buildPmPlanPrompt` to emit a `{{CITABLE_SECTIONS}}` placeholder when enriched + conceptPlan-bearing but `citableSections` is not supplied at build time
- **So that** the Lambda can enqueue the job and the daemon fills the real ids at run time

**Acceptance criteria**

- **Given** rigor=production, no `citableSections` arg **Then** the prompt contains the `{{CITABLE_SECTIONS}}` token _(verify: build)_
- **Given** rigor=prototype **Then** no placeholder, no citation block, byte-identical lean output (W8) _(verify: build)_
- **Given** `citableSections` supplied (tests/inline path) **Then** the inline "cite ONLY these ids" block renders exactly as the shipped tests expect _(verify: build)_

- **Given** the manual-prompt endpoint (`functions/api/index.ts:2219`, `buildPmPlanPrompt` returned for paste-into-LLM + `/import-plan`) on a conceptPlan-bearing enriched plan **When** the prompt is requested **Then** the Lambda resolves `citableSections` via SSM (`readConceptManifests`, Story 5.3) and substitutes the REAL ids inline BEFORE returning — the human never receives an unresolvable `{{CITABLE_SECTIONS}}` token; on a prototype/legacy plan with no manifests the manual prompt returns the v1 lean output unchanged _(verify: behavior)_

**Prerequisites:** none for build path; the manual-path SSM resolution depends on Story 5.3's `readConceptManifests` (note prerequisite ordering)
**Touch Points:** `functions/shared/prompts/pm-plan-prompt.ts`, `functions/shared/prompts/__tests__/pm-plan-prompt.test.ts`, `functions/api/index.ts` (manual-prompt endpoint 2219)
**Forbidden Areas:** do NOT change the inline-supplied rendering (preserve shipped behavior); prototype path untouched; do NOT emit a literal `{{CITABLE_SECTIONS}}` placeholder to a human on the manual/import path — that token is daemon-only.
**Technical Notes:** extend the placeholder-vs-inline-vs-absent matrix in the existing test. TWO pm-plan citing routes exist: the daemon pipeline (placeholder filled at run time, Story 5.2) and the manual/import path (Lambda fills inline via SSM here). The placeholder is the daemon contract; the manual path must NEVER ship the raw token — the import contract is "Lambda resolves via SSM and inlines real ids."

### Story 5.2 — Daemon-side manifest reader + `{{CITABLE_SECTIONS}}` injection at run time

- **As a** the daemon
- **I want** `loadCitableSections(projectDir)` + substitution of `{{CITABLE_SECTIONS}}` before `substituteTemplate` runs
- **So that** the PM cites the real, current-rev section ids from disk (closing E7.8)

**Acceptance criteria**

- **Given** a concept dir with `prd.sections.json` + `architecture.sections.json`, `ux` absent **When** the helper runs **Then** it returns only the two present sources with exact closed-set ids and omits `ux` _(verify: state)_
- **Given** a pm-plan job with the placeholder + manifests on disk **When** `executeStep` prepares the prompt **Then** the spawned prompt contains the real ids formatted `prd: fr-3, fr-4` _(verify: behavior)_
- **Given** no manifests (prototype/legacy) **Then** the placeholder resolves to the defer-references instruction _(verify: behavior)_

**Prerequisites:** 5.1
**Touch Points:** `daemon/pipelines/lib/story-context-pack.mjs` (reader, sibling of `resolveCitedSections`), `daemon/agent-daemon.mjs`, `functions/shared/pipelines/pm-plan-pipeline.ts`
**Forbidden Areas:** never carry `citableSections` as a persisted job variable (stays transient prompt-substitution — avoids the 400KB cap); keep id ordering stable (sorted source keys, manifest-order ids).
**Technical Notes:** reimplement the reader daemon-side (the `.mjs/.ts` boundary, like `resolveCitedSections` already is) and keep it in sync with `section-manifest.ts`.

### Story 5.3 — Surface manifests via SSM + reject dangling references at decompose-time

- **As a** the apply-plan handler
- **I want** `readConceptManifests(plan)` (SSM `cat` of `*.sections.json`) wired into `validateReferenceSections`
- **So that** every emitted reference is set-membership-checked against the real manifest before persistence

**Acceptance criteria**

- **Given** a plan whose generators ran **When** apply-plan runs **Then** `readConceptManifests` returns the `{prd,architecture,ux}` SectionManifest dict; on SSM failure/prototype it returns `{}` and validation degrades to deferred _(verify: state)_
- **Given** a PM output citing `prd#fr-99` not in the manifest **Then** apply-plan returns 400 `REFERENCES_INVALID` listing the offending story/section _(verify: behavior)_
- **Given** all refs resolve OR manifests empty **Then** apply proceeds to `applyPlanOutput` _(verify: behavior)_

**Prerequisites:** 5.2
**Touch Points:** `functions/api/index.ts`, `functions/shared/concept/section-manifest.ts`, `functions/shared/schemas/plan-output-schema.ts`, `functions/shared/services/plan-generation-service.ts`
**Forbidden Areas:** harness refs are skipped (gate resolves those); never false-reject when manifests are unavailable.
**Technical Notes:** wire `validateReferenceSections` beside the existing `validateVisualCoverage` check; mirror how `plan.md` is read/written via `sendSsmCommand`.

### Story 5.4 — Gate consumes the same manifest dict (E9.3) + regenerate re-cites current-rev + stale precondition

- **As a** the readiness gate / regenerate path
- **I want** `runSolutioningGate` fed the same manifest dict and regenerate to re-read current-rev manifests, blocking on a stale rail
- **So that** the consistency contract is verified at the gate and re-planning never cites a stale section

**Acceptance criteria**

- **Given** a UI-bearing production plan with manifests supplied **When** the gate runs **Then** any unresolved `references[].section` produces a Not-ready line; undefined manifests defer to decompose (unchanged) _(verify: state)_
- **Given** `architecture.md` edited (rev bumped) **When** regenerate runs **Then** the new pm-plan prompt carries current-rev ids (stale citations cannot survive); prototype regenerate is byte-identical _(verify: behavior)_
- **Given** the PRD was edited after arch cited it (dependent flipped stale) **When** regenerate is triggered **Then** the response lists stale artifacts that must be re-approved first; `railIsConsistent` ⇒ proceed clean _(verify: state)_
- **Given** a decomposed plan at gate time **When** the gate reads the SSM manifest **Then** it asserts the SSM-read manifest `contentHash` EQUALS `plan.conceptArtifacts[kind].contentHash`; a mismatch (the `.md` on disk changed without a rev bump — content-stale) yields Not-ready, not a green pass — set-membership of ids alone is insufficient _(verify: state)_
- **Given** an already-persisted plan whose frozen `references[]` now point at sections whose `contentHash` changed (upstream edited post-decompose) **When** the gate runs **Then** `railIsConsistent` surfaces the content-stale condition and the gate explicitly tells the operator that regenerate is the only sanctioned path to refresh the frozen references — it never blocks silently _(verify: state)_

**Prerequisites:** 5.3, Story 3.3
**Touch Points:** `functions/api/index.ts`, `functions/shared/services/solutioning-gate.ts`, `functions/shared/concept/artifact-version.ts`, `daemon/agent-daemon.mjs`, `functions/shared/types/plan.ts`
**Forbidden Areas:** set-membership alone does NOT catch content-stale — rely on `contentHash`/`dependsOnHashes`; do NOT silently re-plan on an inconsistent rail; do NOT let a `.md` that changed without a rev bump pass the gate.
**Technical Notes:** share the `SectionManifest` shape across the daemon reader and the Lambda SSM reader (cross-path fixture test to prevent drift); the fixture test must cover `contentHash` EQUALITY (SSM-read == Plan-row), not just SectionManifest shape.

### Story 5.5a — Story Context Pack inlines cited sections for DEV (pack regression guard — the loop-closure gate)

- **As a** DEV agent
- **I want** cited sections inlined verbatim into the Story Context Pack as a non-trimmable floor
- **So that** DEV reads the contract, not a path — and a budget squeeze can never silently drop the citation

**Acceptance criteria**

- **Given** a persisted story with `references[{source:architecture, section:state-model}]` + manifest on disk **When** the pack is built **Then** the serialized pack contains the verbatim section body, not a path, and survives budget pressure (`references-over-budget` blocks rather than drops) _(verify: behavior)_

**Prerequisites:** 5.3
**Touch Points:** `daemon/pipelines/lib/story-context-pack.mjs`, `daemon/pipelines/__tests__/story-context-pack.test.mjs`
**Forbidden Areas:** never silently drop cited sections under budget.
**Technical Notes:** `resolveCitedSections` already inlines as the floor — this is the regression guard and the actual loop-closure gate (DEV consumes the contract). Daemon layer only.

### Story 5.5b — Traceability overlay + coverage-gap flag (UI — the visible payoff)

- **As an** operator
- **I want** an epic→FR + story→§section traceability overlay in PlanReviewView with a zero-references coverage-gap flag
- **So that** I SEE the citation chain pay off and spot stories that cite nothing

**Acceptance criteria**

- **Given** an enriched plan with resolved references **When** the operator toggles Traceability **Then** each story shows its cited section titles linking to the rendered artifact; a UI-bearing story with zero references is flagged as a coverage gap _(verify: appearance)_

**Prerequisites:** 5.5a
**Touch Points:** `src/components/labs/plan-dashboard/views/qa/verdict-strip.tsx`, `src/hooks/use-epic-workflow.ts`
**Forbidden Areas:** the overlay reads existing `requirementRefs`/`references`, no new schema.
**Technical Notes:** the visible overlay next to the SKILL-SCOUT/gate verdict; ships just after 5.5a (the gate), independent risk layer.

---

## EPIC 6 — Graphify doc-ingestion (doc↔doc↔code + Graph-tab visibility)

**Value:** Generated Concept docs become connected — to each other AND to code — and visible in graphify. One new deterministic zero-LLM extractor (`doc-extract.mjs`), one graph-sync step (`processDocumentFacts`), and a Graph-tab Concept-docs layer with a doc↔code overlay. **The choke point: `docSection` nodeId section-segment and `contentHash` MUST be byte-identical to the manifest slugifier output and the versioning `contentHash`** — story `references[]` and the stale-cascade key on exactly those values (the W4-class join-key trap).

### Story 6.1 — `doc-extract.mjs` emits document + docSection nodes from `concept/*.md` + `*.sections.json`

- **As a** graph-sync
- **I want** a deterministic extractor that reads the concept docs + their sidecars
- **So that** every doc and section becomes a first-class graph node carrying the exact ids/hashes the rest of the chain joins on

**Acceptance criteria**

- **Given** a `concept/` dir with `prd.md` + `prd.sections.json` **When** doc-extract runs **Then** it emits exactly 1 `document` node + N `docSection` nodes where N === `manifest.sections.length` and every `docSection.sectionId ∈ sectionIds(manifest)` _(verify: build)_
- **Given** no `concept/` dir (prototype) **Then** it emits `emptyEnvelope` (nodeCount 0, exit 0) _(verify: build)_
- **Given** a section the manifest deduped to `goals-2` **Then** the docSection id is `goals-2` and its `contentHash` matches the sidecar _(verify: build)_

**Prerequisites:** Story 2.4 (sidecars exist on disk)
**Touch Points:** `daemon/scripts/extractors/doc-extract.mjs` (new), `daemon/scripts/lib/extractor-envelope.mjs`; contract from `functions/shared/concept/section-manifest.ts`
**Forbidden Areas:** do NOT re-parse headings to derive section ids (would drift from the manifest slugifier) — read the sidecar as source of truth; do NOT import `section-manifest.ts` at runtime; do NOT emit a `readiness` document/docSection node — `readiness` is not in `ArtifactKind` and has no manifest (it is a gate verdict, not a citable spec).
**Technical Notes:** reuse `buildEnvelope`/`writeEnvelope`; docTypes are exactly `prd|ux|architecture` (matching `ArtifactKind`); nodeIds `doc/<type>/<projectSlug>`, `docSection/<docType>/<projectSlug>/<sectionId>`. A test asserts `hasSection(manifest, idTail)` for every emitted docSection.

### Story 6.2 — Extend ingest node-prop + edge-type allowlists for document/docSection

- **As a** the ingest path
- **I want** the new scalar props + edge types added to the closed allowlists
- **So that** document/docSection facts ingest through the SAME `upsertExtractedFacts` path with no schema rewrite (and the Cypher-injection guard holds)

**Acceptance criteria**

- **Given** a doc-extract envelope **When** `upsertExtractedFacts` runs **Then** document/docSection nodes upsert idempotently (re-run = no dupes), `REFERENCES`/`DERIVED_FROM`/`GOVERNS`/`DESCRIBES`/`SPECIFIES` edges execute, and an unknown edge type is counted-and-skipped (never executed) _(verify: build)_
- **Given** a prop not on `SYSTEM_GRAPH_NODE_PROPS` **Then** it is dropped, not persisted _(verify: build)_

**Prerequisites:** 6.1
**Touch Points:** `daemon/scripts/lib/system-graph-ingest.mjs`
**Forbidden Areas:** do NOT widen anything except the two exported allowlists; keep the closed-set guard.
**Technical Notes:** reuse `upsertExtractedFacts` as-is.

### Story 6.3 — DERIVED_FROM lineage + REFERENCES edges (doc↔doc)

- **As an** operator
- **I want** PRD→UX→Arch lineage and story→section citation edges
- **So that** the spec chain is wired together, provenance-honest

**Acceptance criteria**

- **Given** a uiBearing conceptPlan with `arch.dependsOn=['prd','ux']` **When** doc-extract runs **Then** `doc/architecture/*` DERIVED_FROM `doc/prd/*` and `doc/ux/*` (EXTRACTED from conceptPlan, not doc order); a non-UI plan emits no ux node and no ux lineage edge _(verify: build)_
- **Given** story S cites `{source:architecture, section:state-model}` present in the manifest **Then** `node/story/S` REFERENCES `docSection/architecture/*/state-model`; a cite to a non-existent section yields no edge and an `ambiguous[]` entry; harness refs are skipped _(verify: build)_

**Prerequisites:** 6.2, Story 5.3 (references[] persisted + validated)
**Touch Points:** `daemon/scripts/extractors/doc-extract.mjs`, `functions/shared/concept/concept-plan.ts`, `functions/shared/schemas/plan-output-schema.ts`, `functions/shared/types/epic-workflow.ts`
**Forbidden Areas:** never infer lineage from doc order; never invent a target for an unresolved cite (route to `ambiguous[]`).
**Technical Notes:** reuse `validateReferenceSections` set-membership semantics + `StoryReference` type as the resolution oracle.

### Story 6.4 — GOVERNS/DESCRIBES (doc→code) + SPECIFIES (doc→plan/epic/story) edges

- **As an** operator
- **I want** each spec section wired to the code/infra it governs and to the planning artifacts it traces to
- **So that** viewing a file shows "governed by §X of architecture" and viewing a section shows its code blast radius

**Acceptance criteria**

- **Given** story S references `architecture#state-model` AND touches `functions/shared/repositories/plan.ts` **When** ingest runs **Then** the touchPoint is normalized via `touchPointToNodeId` (`daemon/scripts/ground-truth-injection.mjs:20-22`: `/`→`--`, `code/`-prefix passthrough) to `code/functions--shared--repositories--plan.ts` BEFORE GOVERNS/blast lookup, `docSection/architecture/*/state-model` GOVERNS the matched node and DESCRIBES blast-reachable infra (≤2 hops, e.g. `PlansTable`); a normalized id with no matching `:Node` → `ambiguous[]`, NEVER a GOVERNS edge _(verify: build)_
- **Given** a touchPoint containing glob metacharacters (e.g. `src/components/**`) **When** ingest runs **Then** it is expanded against existing `code/*` nodeIds via `glob-intersect.mjs` and GOVERNS is emitted per matched node; a glob matching zero nodes routes to `ambiguous[]` (never a bogus `code/src--components--**` id) _(verify: build)_
- **Given** a plan with conceptPlan + cited epics **Then** `doc/prd/*` SPECIFIES the plan node and each cited docSection SPECIFIES the citing story; an uncited epic produces no SPECIFIES edge _(verify: build)_

**Prerequisites:** 6.3
**Touch Points:** `daemon/scripts/graph-sync.mjs`, `daemon/mcp/mycelium-mcp.mjs`, `daemon/scripts/lib/system-graph-ingest.mjs`, `daemon/scripts/ground-truth-injection.mjs` (`touchPointToNodeId` — the mandatory resolution oracle), `daemon/pipelines/lib/glob-intersect.mjs` (glob expansion), `functions/shared/types/{plan,epic-workflow}.ts`
**Forbidden Areas:** GOVERNS requires BOTH a cite AND a touchPoint (the AND-guard); cap blast at 2 hops; mark blast-derived DESCRIBES provenance `derived`; NEVER feed a raw touchPoint path/glob into the `f.nodeId IN $fileIds` blast match — it must be normalized via `touchPointToNodeId` (literals) or `glob-intersect.mjs` (globs) first, or the overlay silently yields zero edges.
**Technical Notes:** run in `processDocumentFacts` where a session exists (not the stateless extractor); reuse `blastRadius` + `BLAST_EDGE_TYPES`. The resolution method is the SAME one DEV already uses (`touchPointToNodeId` — reuse, do not reinvent — see the Builds-on reuse table ground-truth row); it must be TOTAL over the real touchPoint domain (literal paths AND glob patterns), since `wave-conflict-resolver.ts`/`glob-intersect.mjs` confirm touchPoints can be globs. `blastRadius` matches `f.nodeId IN $fileIds` literally (`mycelium-mcp.mjs:116-125`), so unnormalized ids match nothing.

### Story 6.5 — `processDocumentFacts` graph-sync step, triggered on artifact apply + at the gate

- **As a** graph-sync
- **I want** a `processDocumentFacts` step that runs the extractor + ingest + edge derivation + summary
- **So that** the graph reflects APPROVED specs, fired at apply/gate (never mid-draft), prototype-skipped

**Acceptance criteria**

- **Given** an approved arch artifact applied **When** `graph-sync --doc-scan` runs **Then** `knowledge/_graph/documents.json` reports new doc + section counts and edges are in Memgraph; re-run is idempotent _(verify: build)_
- **Given** an artifact was regenerated (rev bumped) and a section the PM previously cited was renamed/removed in the new manifest **When** `graph-sync --doc-scan` runs **Then** it MERGE-and-PRUNES: stale `REFERENCES`/`GOVERNS` edges whose target `docSection`/`contentHash` no longer exists in the new manifest are REMOVED (not just upserted) — orphaned edges to deleted sections never accumulate _(verify: build)_
- **Given** `rigor==='prototype'` (no `concept/` dir) **Then** the step logs "no concept docs, skipping" and adds zero nodes (byte-identical, zero latency) _(verify: build)_

**Prerequisites:** 6.4
**Touch Points:** `daemon/scripts/graph-sync.mjs`, `daemon/scripts/lib/system-graph-ingest.mjs` (prune pass), `functions/api/index.ts`
**Forbidden Areas:** ingest only on apply/gate, never on draft; never synthesize an empty document node for prototype; do NOT leave stale edges to deleted sections — the ingest is idempotent on nodeId but edges to vanished sections MUST be pruned, not orphaned.
**Technical Notes:** mirror `processSystemGraphFacts` shape (read `.mycelium` JSON, session lifecycle, log lines); the apply-artifact endpoint + gate-check enqueue a `graph-sync --doc-scan`. Runs after `processSystemGraphFacts`, before `processGraphIntegrity`. The prune is scoped to the regenerated doc's edge set (delete REFERENCES/GOVERNS whose target section id ∉ current `sectionIds(manifest)`), so replay stays free and only genuinely-vanished edges are removed.

### Story 6.6 — Graph-tab Concept-docs layer + doc↔code overlay + orphan/provenance invariants

- **As an** operator
- **I want** color-coded document/docSection nodes, a Concept-docs panel, a doc↔code overlay, and a docSection orphan/drift warning bucket
- **So that** I can click a section and watch its GOVERNS edges light up the code it specifies — and unlinked sections surface honestly (warning, not hard-fail)

**Acceptance criteria**

- **Given** a graph with document/docSection nodes **When** the Concept-docs panel opens **Then** there is one accordion per present docType (UX absent for non-UI plans), and clicking a section highlights its GOVERNS/DESCRIBES edges; a prototype plan shows an empty/absent panel _(verify: appearance)_
- **Given** a file node governed by `architecture#state-model` **When** selected **Then** the inspector lists that section as a governor with click-through; the overlay (default OFF, `includeDocs`-style toggle) draws doc→code edges; toggled off leaves the code graph unchanged _(verify: appearance)_
- **Given** the soft-orphan kind set in `classifyOrphans`/`reportOrphans` (today: only `file`/`dir` are soft; every other degree-0 node is a HARD FAILURE per `graph-integrity.mjs`) **When** Story 6.6 ships **Then** the soft-orphan set is EXTENDED to include `docSection` and `document`, routing unlinked sections to a distinct "Unlinked sections" bucket, NOT `orphans.json` hard-fail _(verify: build)_
- **Given** a degree-0 `docSection` (cited by no story, governing no code — a legitimate state for a narrative section) **When** integrity runs **Then** it yields a WARNING entry and exit 0 — it does NOT trip the non-`file` degree-0 hard-fail tripwire; a degree-0 fabricated node of a genuinely hard-fail kind STILL fails (the tripwire is narrowed, not disabled) _(verify: build)_
- **Given** an INFERRED transitive lineage hop **Then** it is emitted ONLY when `arch dependsOn ux` and `ux dependsOn prd` but `arch` does NOT directly `dependsOn prd` (otherwise the direct DERIVED_FROM chain already connects PRD→UX→Arch and no transitive edge is emitted), is tagged INFERRED, and is excluded from the EXTRACTED honesty count _(verify: build)_

**Prerequisites:** 6.5
**Touch Points:** `src/components/development/graph-viewer.tsx`, `src/app/development/graph/page.tsx`, `src/lib/graph-insights.ts`, `daemon/scripts/lib/graph-integrity.mjs` (extend soft-orphan kind set + `classifyOrphans`), `daemon/scripts/graph-sync.mjs`, `daemon/mcp/mycelium-mcp.mjs`, `src/components/development/__tests__/graph-viewer.test.tsx` or e2e smoke
**Forbidden Areas:** default the doc layer/overlay OFF; keep doc edges out of the default code `BLAST_EDGE_TYPES`; unlinked docSection is a warning, never a code-orphan hard-fail; do NOT disable the hard-fail tripwire wholesale — only add `docSection`/`document` to the soft set.
**Technical Notes:** node colors `document:'#eab308'`, `docSection:'#f59e0b'`; reuse the existing insight-panel accordion + blast-radius inspector + `reportOrphans` (extend, don't replace); mirror `computeIsolated`'s reason taxonomy. The orphan-invariant change is the load-bearing fix: without extending the soft-orphan set, the first real ingest hard-fails on a legitimately-unlinked narrative section.

---

## EPIC 7 — End-to-end verification & dynamic-axis guards

**Value:** Prove the whole engine works across every control-axis cell and that prototype is byte-identical to v1. This is the safety net that the dynamic-workflow invariants actually hold end-to-end.

### Story 7.1 — Prototype bypass + non-UI skip full-sequence guard test

- **As a** maintainer
- **I want** an end-to-end test asserting the job sequence per rigor × uiBearing cell
- **So that** prototype stays byte-identical and non-UI never generates UX

**Acceptance criteria**

- **Given** `rigor='prototype'` **When** a plan is created **Then** `conceptRouteJobId` is undefined, no `conceptArtifacts`, and the first (eager) job enqueued is pm-plan (not route); `reduceConcept → noop` _(verify: behavior)_
- **Given** a non-UI mvp plan **Then** the job sequence is `route, prd, arch, pm-plan` with NO ux job ever created, and CRITICALLY the pm-plan job is created AFTER arch approval (NOT eagerly at creation — blocker fix, Story 3.2) and its spawned prompt contains real section ids, not the `{{CITABLE_SECTIONS}}` defer instruction _(verify: behavior)_
- **Given** a UI mvp plan **Then** the sequence is `route, prd, ux, arch, pm-plan`, pm-plan is created after arch approval, and its prompt carries real ids _(verify: behavior)_

**Prerequisites:** E1–E5
**Touch Points:** `functions/api/index.ts`, `functions/shared/services/concept-reducer.ts`, `functions/shared/concept/concept-plan.ts`, `functions/cron/wave-completion-check.ts`
**Forbidden Areas:** the prototype assertion must check byte-identical pm-plan output, not just job count; the mvp/UI assertion must prove pm-plan is NOT created at plan creation.
**Technical Notes:** table-driven over each rigor × uiBearing cell, asserting created-job order.

### Story 7.2 — Interactive vs autopilot advancement guard test

- **As a** maintainer
- **I want** a test that interactive blocks on Approve while autopilot auto-advances
- **So that** the `conceptInteraction` axis is proven to change only the turn-loop shape

**Acceptance criteria**

- **Given** autopilot **When** prd-gen completes **Then** prd auto-approves and arch enqueues unattended _(verify: behavior)_
- **Given** interactive **Then** arch is NOT enqueued until `POST .../approve`; Reject re-drafts without advancing _(verify: behavior)_
- **Given** the first artifact job started **Then** `PATCH conceptInteraction` is rejected (mode-lock) _(verify: behavior)_

**Prerequisites:** E4
**Touch Points:** `functions/shared/services/concept-reducer.ts`, `functions/api/index.ts`, `daemon/pipelines/free-agent-session.mjs`
**Forbidden Areas:** the convergence Approve gate must NOT be conflated with the `verify:'manual'` QA gate.
**Technical Notes:** assert auto-advance vs block per mode + W6 post-clean promote survival.

### Story 7.3 — Closed-loop traceability + graph-connectedness end-to-end test

- **As a** maintainer
- **I want** a single fixture that runs generate → cite → verify → consume → ingest and asserts the chain connects
- **So that** join-key drift, dangling refs, and disconnected docs are caught before ship

**Acceptance criteria**

- **Given** an mvp UI plan through the full chain **When** it completes **Then** the PM cited real ids, decompose + gate validated them, the Story Context Pack inlined the verbatim sections, and the graph has REFERENCES/GOVERNS edges from those sections to the touched code _(verify: behavior)_
- **Given** a deliberately drifted section id **Then** the join-key test fails loudly (no silent disconnect) _(verify: build)_
- **Given** a seeded doc-bearing graph fixture in the Graph tab (Playwright/smoke) **When** the Concept-docs panel renders **Then** ≥1 docType accordion appears, selecting a section highlights its GOVERNS edges, and toggling `includeDocs` OFF leaves the code graph unchanged — the operator-facing payoff ("click a section, watch its edges light up") is asserted, not just the underlying Memgraph edges _(verify: appearance)_

**Prerequisites:** E5, E6
**Touch Points:** `daemon/pipelines/__tests__/`, `functions/shared/__tests__/`, `daemon/scripts/extractors/__tests__/doc-extract.test.mjs`, `tests/e2e/` (Graph-tab overlay smoke)
**Forbidden Areas:** none beyond the standard reuse-over-rebuild discipline.
**Technical Notes:** asserts `hasSection`/`contentHash` parity across manifest, references[], docSection nodeId, and versioning — the W4/join-key trap as an executable guard. The Graph-tab smoke closes the appearance-only gap so an overlay-toggle regression fails CI.

---

## Graphify connection

The operator's explicit requirement: generated Concept docs become connected (to each other AND to code) and visible in graphify. The connection substrate already exists — this plan adds exactly ONE extractor, ONE graph-sync step, and ONE Graph-tab layer, inventing nothing.

**Node kinds (new):**

- `document` — `doc/<docType>/<projectSlug>`; props `docType (prd|ux|architecture)`, `title`, `status`, `rev`, `contentHash`, `projectId`, `updated`. **`readiness` is NOT a citable docType** — it is absent from `ArtifactKind` (`section-manifest.ts`), `StoryReference.source` (`['prd','architecture','ux','harness']`), and `CITED_DOC_SOURCES` (`['prd','architecture','ux']`). The readiness gate is a verdict, not a citable spec; it gets NO `document`/`docSection` node and can never be the target of a REFERENCES edge. (Decision: dropped from the docType enum to keep the graph model consistent with the shipped type/citation surfaces.)
- `docSection` — `docSection/<docType>/<projectSlug>/<sectionId>`; props `docId`, `sectionId`, `title`, `contentHash`, `level`, `ordinal`, `lineStart`, `lineEnd`, `summary`.

**Edge types (new, added to `SYSTEM_GRAPH_EDGE_TYPES`):**

- `DERIVED_FROM` (document→document) — PRD→UX→Arch lineage, EXTRACTED from `conceptPlan.dependsOn`.
- `REFERENCES` (story→docSection) — from `EpicStory.references[]`, resolved by `hasSection` set-membership.
- `GOVERNS` (docSection→code/infra) — from stories that BOTH cite a section AND list touchPoints.
- `DESCRIBES` (docSection→infra) — blast_radius (≤2 hops) reach, provenance `derived`.
- `SPECIFIES` (document/docSection→plan/epic/story) — inverse projection of references/requirementRefs.

**Provenance discipline:** EXTRACTED for manifest/references/conceptPlan-derived edges; `derived` for blast_radius DESCRIBES; INFERRED only for the optional transitive lineage hop — precisely defined: `Arch DERIVED_FROM PRD` is emitted INFERRED ONLY when `Arch dependsOn UX` and `UX dependsOn PRD` but `Arch` does NOT directly `dependsOn PRD` (when the direct edge exists the transitive hop is redundant and is NOT emitted); it is excluded from the EXTRACTED honesty count (asserted in a test). Unresolved refs / dangling cites / unmatched touchPoints → `ambiguous[]`, NEVER invented nodes/edges.

**Doc→code resolution:** a docSection cited by a story whose touchPoints resolve to real graph nodes GOVERNS those nodes. The resolution method is EXPLICIT and reused, not reinvented: each literal touchPoint is normalized via `touchPointToNodeId` (`daemon/scripts/ground-truth-injection.mjs:20-22` — `/`→`--`, `code/`-prefix passthrough) to `code/<path>` BEFORE the GOVERNS/blast lookup; a glob touchPoint (e.g. `src/components/**`) is expanded against existing `code/*` nodeIds via `glob-intersect.mjs` and GOVERNS is emitted per matched node. A normalized/expanded id with no matching `:Node` → `ambiguous[]`, NEVER a GOVERNS edge. This is the SAME join DEV already uses — `blastRadius` matches `f.nodeId IN $fileIds` literally (`mycelium-mcp.mjs:116-125`), so an unnormalized raw touchPoint would silently match nothing. `blast_radius(normalized touchPoints)` (≤2 hops) yields DESCRIBES to reachable infra. The join keys are the manifest `sectionId` + `contentHash` — byte-identical across manifest, references[], docSection nodeId, and the versioning layer (the load-bearing choke point). On regenerate, stale REFERENCES/GOVERNS edges to sections that no longer exist are PRUNED (Story 6.5), not left to accumulate.

**Graph-tab surface:** document `#eab308` / docSection `#f59e0b` colors; a "Concept docs" accordion panel (per docType, UX hidden for non-UI plans); a default-OFF doc↔code overlay (`includeDocs` toggle) that draws doc→code edges and shows "Governed by sections" on a selected code node; a separate "Unlinked sections" warning bucket. **Orphan invariant change (load-bearing):** the soft-orphan kind set in `classifyOrphans`/`reportOrphans` (today only `file`/`dir`) is EXTENDED to include `docSection` and `document`, so a legitimately-unlinked narrative section yields a warning + exit 0 instead of tripping the non-`file` degree-0 HARD-FAIL tripwire that `graph-integrity.mjs` enforces today. The tripwire is narrowed, not disabled — a degree-0 fabricated node of a genuine hard-fail kind still fails. Without this change the first real ingest hard-fails.

**Determinism:** zero-LLM, MERGE-on-nodeId idempotent, re-runnable; same docs in → same graph out. Ingest fires only on artifact apply + at the gate (approved specs only), never mid-draft; prototype writes no docs ⇒ empty envelope ⇒ skip.

---

## Build order / waves

| Wave   | Epic(s)                            | Why this order                                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1** | E1 (write-back & version registry) | The choke point — generators are no-ops without durable write-back + the version registry; nothing downstream is meaningful until this lands.                                                                                                                                                                     |
| **W2** | E2 (generators)                    | Produce the real documents + sidecars. 2.1/2.3 are parallel-safe; 2.2 follows 2.1; 2.4 follows 2.1/2.3/1.3; 2.5 follows 2.4.                                                                                                                                                                                      |
| **W3** | E3 (orchestration)                 | The reducer + driver move the DAG: suppress eager pm-plan, server-driven apply + widened cron filter (3.2), daemon-side priorArtifacts grounding (3.2a), stale-cascade + citation re-validation + write-back recovery (3.3), crash + doc-scan recovery (3.4) — once artifacts can be generated + persisted.       |
| **W4** | E4 (interactive + autopilot)       | The interactive convergence prompt builders (4.1a, the elicit→converge substance) + chat + Approve gates on the free-agent substrate; rail rendering (4.5a), resume (4.5b), approvalTimeout (4.5c), and mode-lock (4.5d) split out so backend-state guards aren't stubbed. Gated by the now-working orchestrator. |
| **W5** | E5 (PM enrichment & loop closure)  | Close E7.8 (daemon + manual/import paths) + verify references at decompose/gate (incl. contentHash equality) + inline for DEV (5.5a gate) + traceability overlay (5.5b payoff); depends on generators (manifests) + orchestration (reaching pm-plan).                                                             |
| **W6** | E6 (graphify ingestion)            | Ingest the now-generated, now-cited docs as connected, visible graph nodes; depends on sidecars (E2) + persisted/validated references (E5).                                                                                                                                                                       |
| **W7** | E7 (E2E verification)              | Prove every control-axis cell + byte-identical prototype + closed-loop connectedness end-to-end.                                                                                                                                                                                                                  |

Within a wave, stories are sized for a single dev session and follow backward-only prerequisites listed per story. Reuse-over-rebuild is mandatory: the genuinely new core files are `concept-reducer.ts` (the orchestrator), `doc-extract.mjs` (sibling extractor), and the interactive convergence prompt builders + shared marker constants (`{prd,ux,arch}-convergence-prompt.ts`, `concept-markers.ts` — the elicit→converge substance, distinct from the E2 autopilot one-shot builders) — every other story extends a shipped seam (`touchPointToNodeId`, `glob-intersect.mjs`, `loadCitableSections`, `reportOrphans`, `validateReferenceSections`, etc. are reused, not reinvented).

---

## Traceability

| Design dimension (recon)                                                                                   | Epics                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Document Generators** (prd-gen / ux-gen / arch-gen as generic daemon pipeline jobs)                      | E1 (write-back + registry), E2 (generators)                                                              |
| **Dynamic Orchestration + Sub-Stage Activation** (concept-reducer, dependency-ordered, prototype-bypassed) | E1 (per-artifact state), E3 (reducer + driver + cascade + orphan-requeue)                                |
| **Interactive Convergence Chat** (elicit→converge→approve→promote→advance, autopilot)                      | E4 (modes, cards, checkpoint, Approve/promote, rail, durability)                                         |
| **Graphify Doc-Ingestion** (doc↔doc↔code + Graph-tab visibility)                                           | E6 (extractor, ingest, edges, processDocumentFacts, Graph-tab layer)                                     |
| **PM-Plan Enrichment + Loop Closure** (citableSections → verify → inline)                                  | E5 (placeholder, daemon reader, decompose/gate validation, regenerate/stale, pack inline + traceability) |
| **Cross-cutting verification** (dynamic axes, byte-identical prototype, closed loop)                       | E7 (full-sequence, mode, traceability/connectedness guards)                                              |

### Cross-cutting invariants (every epic)

- **Dynamic applicability** enforced once at enqueue (ux iff uiBearing, arch iff in conceptPlan, prototype bypass); never re-inferred downstream.
- **Determinism**: section ids from `slugifyHeading`, slices via `resolveSection` 1-based line ranges (no regex), two-phase atomic writes, MERGE-on-nodeId ingest — re-runnable, no LLM cost.
- **Provenance**: persona-tagged jobs (Mary/John/Sally/Winston/Murat); `ConceptArtifact` rev/contentHash/dependsOnHashes as the audit chain; EXTRACTED/derived/INFERRED/ambiguous discipline in the graph.
- **Reuse over rebuild**: clones of the Router template + reuse of section-manifest, artifact-version, free-agent substrate, `reducePlan` model, and the graph ingest path; net-new code is minimal.
- **Two human-in-the-loop moments stay distinct**: `conceptInteraction:'interactive'` (spec convergence at planning time) ≠ `verify:'manual'` (behavior verification at QA-Review time, VQA v3).

---

## Stress-test resolutions

An adversarial panel traced every pipeline seam against the live code. Each blocker/major (and sensible minors) is now folded into the plan as follows:

**Blockers**

- **Eager pm-plan defeats the citation thesis** — Story 3.2 now SUPPRESSES the creation-time eager pm-plan whenever `shouldRunConceptRoute(plan)` is true; only the prototype path keeps the eager enqueue (W8 byte-identical). `reduceConcept` owns the single `enqueue-pm-plan` transition post-arch-approval. New invariant added to "Dynamic-workflow handling"; Story 7.1 asserts pm-plan is created AFTER arch approval with real ids (not the defer instruction).
- **Generate→apply trigger unspecified** — Story 3.2 names the explicit seam: the daemon POSTs `apply-<kind>` on generator COMPLETED (server-driven), with the cron pass as the idempotent backstop, and WIDENS the cron plan-selection filter beyond `{developing, fixing}` to include `status==='concept'` plans. The frontend poll is no longer the sole driver ("no human click" holds; a closed browser can't wedge the DAG).
- **Doc→code resolution hand-wavy** — Story 6.4 + the "Doc→code resolution" section now name `touchPointToNodeId` (`ground-truth-injection.mjs:20-22`) as the mandatory resolution oracle with an explicit normalization AC; a normalized id with no `:Node` → `ambiguous[]`, never a GOVERNS edge. Added to the Builds-on reuse table.
- **Orphan invariant asserts an outcome the code won't produce** — Story 6.6 now adds an explicit AC + Touch Point to EXTEND the soft-orphan kind set in `classifyOrphans`/`reportOrphans` to include `docSection`/`document`, with a test that a degree-0 `docSection` warns + exits 0 while a fabricated hard-fail-kind node still fails.
- **BMAD convergence elicitation protocol never authored** — NEW Story 4.1a authors first-class convergence prompt builders (`build{Prd,Ux,Arch}ConvergencePrompt`) with the concrete elicit contract: per-section template-output markers, halt+decision-card protocol modeled on a distilled `adv-elicit-methods.csv`, shared marker constants with fence-parity tests. Story 2.1/4.2 now state the mode branch (autopilot one-shot vs convergence builder) explicitly.

**Majors**

- **Daemon write-back parity** — Story 1.2 now carries a W1 cross-path fixture parity AC (daemon `.mjs` manifest byte-identical to `generateSectionManifest`), so a slugifier divergence is caught in W1, not W7.
- **Manual/import pm-plan path uncovered** — Story 5.1 now covers the manual-prompt endpoint (`index.ts:2219`): the Lambda resolves `citableSections` via SSM and inlines real ids before returning; a human never receives a raw `{{CITABLE_SECTIONS}}` token.
- **ux/arch priorArtifacts seam unassigned** — NEW Story 3.2a assigns the daemon-side `{{PRIOR_ARTIFACTS}}` injection (Lambda enqueues placeholder, daemon fills from approved manifests), mirroring `loadCitableSections`; new invariant added to "Dynamic-workflow handling".
- **adv-elicit unmechanized** — Story 4.1a states the mechanism explicitly: distilled `adv-elicit-methods.csv` inlined into the convergence prompt (NOT the BMAD XML engine, which the raw-CLI free-agent substrate doesn't run), with a defined substring-extractable card marker + parity test.
- **Story 4.5 oversized** — split into 4.5a (rail rendering), 4.5b (resume + `drafting`-stranded recovery), 4.5c (approvalTimeout), 4.5d (mode-lock + PATCH-reject); the backend-state guards (4.5c/4.5d) are no longer bundled into a UI story.
- **Mode-lock forward dependency** — Story 1.1 now defines the durable `conceptChainStarted` predicate (any generator FK set OR any `conceptArtifacts[].rev>0`); Stories 4.5d and 7.2 reference it rather than restating.
- **Partial-failure recovery (3 nodes)** — write-back-crash recovery added to Story 3.3 (cron re-drives apply from the on-disk `.md`); `drafting`-stranded resume affordance added to Story 4.5b; doc-scan retry + "stale graph" badge added to Story 3.4.
- **Regenerate/edit→stale citation cascade** — Story 3.3/5.4 now re-run `validateReferenceSections` against the NEW manifest over persisted `references[]` (dangling cites block the gate); Story 6.5 PRUNES stale REFERENCES/GOVERNS edges on regenerate.
- **Glob touchPoints unhandled** — Story 6.4 now expands glob touchPoints against `code/*` nodeIds via `glob-intersect.mjs`; zero matches → `ambiguous[]`.

**Minors**

- **Persona role-policy / WebSearch** — Story 2.3 AC confirms `role-policy.ts` grants the arch agent WebSearch (or documents `role:'PM'` as the doc-generator bucket including WebSearch).
- **Content-stale gate** — Story 5.4 AC asserts SSM-read manifest `contentHash` == Plan-row `contentHash`; mismatch ⇒ Not-ready.
- **INFERRED transitive hop** — precisely defined (Arch→PRD only when Arch→UX→PRD chain exists without a direct Arch→PRD edge) and excluded from the EXTRACTED count via test (Story 6.6 + Graphify section).
- **Graph-tab payoff appearance-only** — Story 7.3 now has a Playwright/smoke AC: render a docType accordion, click a section to light GOVERNS edges, toggle `includeDocs` OFF leaves the code graph unchanged.
- **`readiness` docType inconsistency** — dropped from the `document` docType enum (gate verdict, not a citable spec); Story 6.1 forbids emitting a readiness node.
- **Story 5.5 bundling** — split into 5.5a (pack inlining regression guard, the loop-closure gate) and 5.5b (traceability overlay + coverage-gap flag, the visible payoff).

All blockers and majors are folded in; no prior coverage was removed.
