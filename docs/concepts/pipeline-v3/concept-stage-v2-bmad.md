# Concept Stage v2 — BMAD Spec-Development Adoption

**Status:** v0.6 — design draft (adversarially stress-tested, 2026-06-16)
**Author:** Ricardo (with Claude + BMAD agent panel)
**Date:** 2026-06-16
**Lineage:** Concept v1 (single PM shot: intent → epics/stories/waves) → **Concept v2 (BMAD-grade spec depth, dynamically routed, conversationally converged)**
**Scope:** the **Concept** (planning) stage only — everything between user `intent` and the **Start development** button. Developing / QA / Deploy stages are unchanged except where they _consume_ the enriched plan (§6).
**Sister doc:** `vqa-qa-review-redesign.md` (VQA v3) — meets this design **at the acceptance criterion**; coordination resolved in its §9. The AC's BDD triple is the input to VQA v3's probe compiler.

> **Changelog v0.5 → v0.6** (2026-06-16, six-adversary stress test — see §13 W-list):
>
> - **7 BLOCKERs / 5 SHOULD-FIX surfaced (§13).** Design is directionally sound; the gaps are "the doc assumed a primitive the codebase lacks" + two factual errors, now corrected inline.
> - **W6 (factual fix):** the interactive substrate is **NOT** "Lambda-mediated" — the free agent runs on the **daemon** (resumable Claude CLI). §3.3/§7.2 corrected. No cross-host sync exists or is needed; the real work is a daemon-local **promote-on-Approve** + worktree/git-cleanliness handling.
> - **W5 (factual fix):** §8 no longer "bounces `manual`→`behavior`" (an altitude violation) — the Concept gate **flags for operator confirmation**; the QA-AUTHOR performs the downgrade at dev time.
> - **W8 (factual fix):** `prototype` now **bypasses `concept-route` entirely** (§3.2/R4) — the prior "byte-identical, zero-latency" claim was false with a mandatory Router hop.
> - **W1–W4, W7, W9–W12** captured in §13 with fixes; the biggest is **W4** (enrichment was inert at the apply-mapper — Slice 1 must edit `applyPlanOutput`, not just the Zod schema).

> **Changelog v0.4 → v0.5** (2026-06-16, VQA v3 §9 MQ6 — the `manual` verify class):
>
> - **`verify:'manual'` added (§4)** — human-in-the-loop verification class (operator lane at QA Review; never auto-pass/fail; blocks ship). Requires `manualReason`.
> - **Anti-`UNVERIFIABLE` clause (§8)** — the Concept gate-check **bounces any `manual` AC that is actually stubbable** (via the test-mode seam) back to `behavior`. `manual` is reserved for the _knowably_-unautomatable (real payment / OAuth consent / captcha / native / subjective); it must not become the new escape hatch.
> - **Two human-in-the-loop moments disambiguated (§3.3):** `conceptInteraction:interactive` (spec convergence, planning) ≠ `verify:'manual'` (behavior verification, QA Review).
> - Open back to QA: `needsBrowser` independent for `manual` (MQ1 follow-up); test-mode stubs cited via `'harness'` source (MQ7).

> **Changelog v0.3 → v0.4** (2026-06-16, the interaction model):
>
> - **Third control axis — interactivity (§3.3, §7.2).** Artifact agents are no longer one-shot batch jobs. A per-plan **operator toggle** (`conceptInteraction: interactive | autopilot`, independent of rigor) decides whether each artifact runs as a **free-agent convergence chat with an explicit Approve gate** (BMAD-faithful elicit→converge→approve→advance) or a **daemon one-shot that auto-advances** (review-after). Resolves "the agents should converge like a chat, then ask for approval."
> - **Substrate (§7.2):** interactive tier runs on the existing **free-agent (Lambda-mediated) chat infra**; autopilot stays on the daemon. The "Copy LLM prompt / import" seam is demoted to an **escape hatch**, not the primary human-in-loop path.
> - **DAG is now converge→approve checkpoints (§7.1):** in interactive mode PRD must be _approved_ before UX/Arch consume it; in autopilot it auto-advances. (Fixes the v0.3 implication that artifacts always auto-chain.)
> - **§12 rail nodes** become live chat threads + Approve gates (interactive) or status tiles (autopilot).

> **Changelog v0.2 → v0.3** (2026-06-16, after VQA v3 coordination):
>
> - **`verify` intent on `AcceptanceCriterion` (§4)** — `build|appearance|state|behavior`, PM-set at planning; the source the downstream QA-AUTHOR derives the L-level from. `needsBrowser` becomes a derivation candidate.
> - **Idle-visible rule RELAXED (§5)** — gated on `verify`; appearance ACs stay idle-visible, behavior ACs may describe post-interaction state (the probe reaches it). Reverses v0.2; resolves the one cross-session collision (VQA v3 §9 Q3).
> - **`'harness'` reference source (§4)** — stories cite the boilerplate `__harness` seam shape DEV must populate (VQA v3 §9 Q6).
> - **`then` stays prose-observable** — PM authors claims, the QA-AUTHOR compiles prose→seam assertions; PM authors no probes (VQA v3 §9 Q2/Q4/Q7).

> **Changelog v0.1 → v0.2** (2026-06-16, after exploring dynamic-workflow direction):
>
> - **Two-axis model (§3).** Split the old single `rigor` gate into **applicability** (which artifacts apply — owned by a new **Concept Router**) and **depth** (how much rigor — owned by `rigor`). UX is no longer rigor-gated; it activates whenever the app is **UI-bearing**, at a depth scaled by rigor. This corrects the v0.1 flaw where a CLI at `production` would have generated UX and a UI prototype would have skipped it.
> - **Concept Router added (§3.2)** — an **LLM-classifier agent** (Analyst/Mary persona) that reads intent + boilerplate + rigor and emits a `conceptPlan` DAG. Futurator analog of BMAD `workflow-init`.
> - **UX/Arch ordering decided (§7):** UI-bearing ⇒ **always serial `PRD → UX → Architecture`** (Architecture cites the UX spec). Non-UI ⇒ `PRD → Architecture`, UX skipped.
> - **Q1/Q2 resolved (§10):** epics get thin enrichment (`goal` + `requirementRefs`); artifacts are disk-canonical + Plan-row pointers.
> - **New §11 (Agents & logging)** and **§12 (Concept Stage UI)** — named personas per job, copy/download transcript auditing, and the Concept pipeline-rail UI.

> **Decisions locked (2026-06-16):**
>
> - **D1 — Adoption scope:** adopt BMAD's **planning + solutioning artifacts** (PRD, UX, Architecture, solutioning-gate-check) **plus** mine `create-epics-and-stories` + `create-story` to make the _story definitions themselves_ BMAD-grade. **Do NOT** import BMAD's implementation-phase machinery (`sprint-planning`, `story-context`, `story-ready`) — it duplicates infrastructure we already shipped (§2).
> - **D2 — Two control axes, not one (§3):** **applicability** is decided dynamically by the **Concept Router** (LLM classifier); **depth** scales with the existing `rigor` dial (`prototype | mvp | production`). No new operator field — the router is automatic, rigor already exists.
> - **D3 — Never rebuild substrate:** DynamoDB `Plan/Epic/Story`, the wave engine, the Story Context Pack, the reviewer's scope check, and VQA all stay. We **extend**, we do not replace. (Consistent with the v3 "never rebuild git substrate" rule.)
> - **D4 — Router brain:** the Concept Router is an **LLM classifier agent**, not a static heuristic — fully dynamic workflow selection.
> - **D5 — UX/Arch order:** UI-bearing ⇒ **serial `PRD → UX → Architecture`**.
> - **D6 — Interactivity is a third, orthogonal axis (§3.3):** a per-plan operator toggle `conceptInteraction: interactive | autopilot`, **independent of rigor**. Interactive = free-agent convergence chat + per-artifact Approve gate; autopilot = daemon one-shot, auto-advance, review-after. Chat is always _available_ on any node regardless; the toggle decides whether convergence is _forced_ before advancing.

---

## 0. TL;DR

Our **Concept stage is already BMAD's `create-epics-and-stories` step** — collapsed into one PM agent shot (`buildPmPlanPrompt` → `PLAN_JSON` → `applyPlanOutput`). What we lack is everything _upstream_ of decomposition (a real **PRD**, **UX spec**, **Architecture decision doc**) and a real **readiness gate** between planning and execution.

BMAD provides exactly those, _and_ its story template is richer than ours along five axes we don't yet structure: **user-story triple**, **BDD acceptance criteria**, **technical notes**, **AC-mapped tasks**, and **source citations**. Adopting them means:

1. **Extend the `Story`/`Epic` schema + plan-output schema** with the 5 BMAD-grade fields (§4).
2. **Graft BMAD's decomposition rules into `buildPmPlanPrompt`** so the PM emits them (§5).
3. **Teach the Story Context Pack to carry them** so the DEV/REVIEWER agents actually see them at **Start development** — the choke point (§6).
4. **Add rigor-scaled upstream artifact-gen jobs** (`prd-gen`, `ux-gen`, `arch-gen`) whose `.md` outputs become the **citation sources** the new `references[]` point to (§5, §7).
5. **Add the `solutioning-gate-check`** as the upgraded **Start development** gate (§8).

Crucially, three things I first scoped as "build" turned out to be **already live** and are reused, not rebuilt: `forbiddenAreas`→reviewer scope check, `workSummary`/`prevWorkSummaries` cross-wave learnings, and the Story Context Pack itself (§2).

---

## 1. What BMAD's spec-dev chain actually is

BMAD (a spec-driven-development framework alongside GitHub Spec Kit, Kiro, OpenSpec) runs a four-phase loop: **specify → plan → break into testable tasks → implement**, where the spec docs become _executable validation gates_, not just prose. Its workflows, owners, and artifacts:

| Phase             | Workflow                                       | Owner               | Output artifact                      |
| ----------------- | ---------------------------------------------- | ------------------- | ------------------------------------ |
| 0 Discovery (opt) | `brainstorm` / `research` / `product-brief`    | Analyst (Mary)      | `product-brief.md`                   |
| 1 Planning        | `prd`                                          | PM (John)           | `PRD.md`                             |
| 1 Planning        | `create-ux-design` (if UI)                     | UX (Sally)          | `ux-design-specification.md`         |
| 1 Planning        | `create-epics-and-stories`                     | PM/SM               | `epics.md`                           |
| 2 Solutioning     | `architecture`                                 | Architect (Winston) | `architecture.md`                    |
| 2→3 **Gate**      | `solutioning-gate-check`                       | Architect           | `implementation-readiness-report.md` |
| 3 Implementation  | `sprint-planning`                              | SM (Bob)            | `sprint-status.yaml`                 |
| 3 Implementation  | `create-story` → `story-context` → `dev-story` | SM → Dev            | `stories/{key}.md` + `.context.xml`  |

BMAD routes by **Level 0–4** (quick-flow vs method vs enterprise). That maps cleanly onto our **`rigor`** dial (§3, D2).

**Key structural difference:** BMAD has **no "waves."** Our wave model (parallel execution layers via touch-point disjointness) is a Futurator _advantage_; BMAD batches stories only implicitly via prerequisites. We keep our waves and feed them richer stories.

---

## 2. What we ALREADY have (verified in code — do not rebuild)

| BMAD concept                                    | Futurator equivalent (already shipped)                                                      | Evidence                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `create-epics-and-stories`                      | `buildPmPlanPrompt` → `PLAN_JSON` → `applyPlanOutput`                                       | `functions/shared/prompts/pm-plan-prompt.ts`; `functions/shared/schemas/plan-output-schema.ts` |
| `sprint-status.yaml` source of truth            | DynamoDB `Plan` / `EpicWorkflow` / `EpicStory` rows                                         | `functions/shared/types/plan.ts`, `…/epic-workflow.ts`                                         |
| `forbiddenAreas` → reviewer scope-forbidden ACs | **Live**: `forbiddenAreas?: string[]` + scope detector                                      | `epic-workflow.ts:268`; `daemon/pipelines/lib/scope-violation-detector.mjs` (+ tests)          |
| "Learnings from Previous Story"                 | **Live**: `workSummary` + `prevWorkSummaries` (adapted to the wave DAG)                     | `epic-workflow.ts:244`; `daemon/pipelines/lib/story-context-pack.mjs:157`                      |
| `story-context` XML                             | **Live**: Story Context Pack (byte-identical to DEV/REVIEWER/COMPILER, prompt-cache-stable) | `daemon/pipelines/lib/story-context-pack.mjs`                                                  |
| Story sizing / complexity routing               | **Live**: `complexity`, `reviewRigor`, `inferenceMetadata`                                  | `epic-workflow.ts:269–271`                                                                     |
| Test design                                     | **Live**: `VisualTestDef` 3-level routing (L0/L1/L2), VQA wave gate                         | `epic-workflow.ts:100–169`                                                                     |

**Implication:** BMAD's _implementation-phase_ workflows (`sprint-planning`, `story-context`, `story-ready`) are redundant with the above. Importing them is bolting a second steering wheel onto a car that drives. **Excluded by D1.**

---

## 3. Two control axes: applicability (router) × depth (rigor)

v0.1's flaw was forcing a single dial (`rigor`) to answer two unrelated questions. v0.2 separates them:

| Axis              | Owned by                                   | Answers                  | Examples                                                        |
| ----------------- | ------------------------------------------ | ------------------------ | --------------------------------------------------------------- |
| **Applicability** | **Concept Router** (LLM classifier, §3.2)  | _Which_ artifacts apply? | UX on iff **UI-bearing**; Arch on iff complex; UX/Arch ordering |
| **Depth**         | **`rigor`** (`prototype\|mvp\|production`) | _How much_ rigor?        | PRD lite vs full; gate noop/light/strict; story + AC density    |

The key correction: **UX is applicability-driven, not rigor-driven.** A CLI tool at `production` gets no UX; a UI game at `prototype` gets a UX pass (light, because rigor is low). "Despite the rigor," as the operator put it.

### 3.1 Depth ladder (rigor)

`plan.rigor` (`functions/shared/types/plan.ts:27`) already tunes story count / AC density / test strictness. It additionally sets spec depth + gate strictness:

| `rigor`      | BMAD level       | PRD            | Decompose richness              | Gate        |
| ------------ | ---------------- | -------------- | ------------------------------- | ----------- |
| `prototype`  | 0–1 (quick-flow) | lite / skipped | user-story + ACs                | no-op pass  |
| `mvp`        | 2–3 (method)     | full           | full §4 fields, references      | light gate  |
| `production` | 3–4 (method/ent) | full           | full §4 fields + full citations | strict gate |

> Note: rigor sets the **depth** of whatever artifacts the router activates — it does **not** decide UX/Arch on/off. `prototype` remains the low-latency path, but a UI-bearing prototype still gets a _light_ UX pass if the router says so.

### 3.2 The Concept Router (D4 — LLM classifier)

A new agent step, run **immediately after intent**, before any artifact-gen. Futurator analog of BMAD `workflow-init`. Persona: **Analyst (Mary)** — BMAD's routing owner.

**Input:** `intent`, `boilerplateType`, `rigor`, `kind` (`new`|`change`), and (for `change`) the project knowledge index.
**Output:** a `conceptPlan` — the ordered artifact-job DAG:

```jsonc
// conceptPlan emitted by the Router (LLM classifier)
{
  "uiBearing": true, // drives UX activation + serial ordering (§7)
  "complexity": "medium", // hint for arch activation + story sizing
  "artifacts": [
    { "kind": "prd", "depth": "full" },
    { "kind": "ux", "depth": "light", "dependsOn": ["prd"] }, // present only if uiBearing
    { "kind": "architecture", "depth": "full", "dependsOn": ["prd", "ux"] }, // dependsOn ux iff uiBearing
  ],
  "gate": "strict", // noop | light | strict (from rigor)
  "rationale": "Next.js boilerplate + intent mentions screens/HUD → UI-bearing; multi-subsystem → arch needed.",
}
```

Because it's an **LLM classifier** (D4), it handles novel intents the heuristics wouldn't anticipate — at the cost of one cheap, fast (Haiku-class) inference hop before artifacts run. The `rationale` is logged (§11) so routing decisions are auditable. The `conceptPlan` is persisted on the Plan row and is what the Concept UI rail renders (§12).

> **`prototype` → `concept-route` is BYPASSED entirely (W8).** Not "emit an empty plan" — an explicit `rigor==='prototype' ⇒ skip the Router` guard, so `pm-plan` runs directly with **no Router inference, no Plan-row write, truly zero added latency** (today's single PM shot, byte-identical). The earlier "empty conceptPlan" framing was false — an LLM hop still costs. Guard every v2 branch on the conceptPlan's presence, treating _absent_ (prototype) as "v1 path."

### 3.3 The interactivity axis (D6 — operator toggle, orthogonal to rigor)

A **third control axis**, separate from applicability (router) and depth (rigor). A per-plan operator toggle set at plan creation:

```ts
// On the Plan:
conceptInteraction?: 'interactive' | 'autopilot';  // default: autopilot for prototype, interactive for mvp/production (operator may flip)
```

| Mode              | Each artifact runs as…                                                                                                                                                                       | Advance to dependents  | Substrate                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------- |
| **`interactive`** | a **free-agent convergence chat**: agent drafts / proactively elicits (BMAD `adv-elicit`) → operator converses + answers decision cards → template-output checkpoint → **operator Approves** | only **after Approve** | free-agent (Lambda-mediated) chat, §7.2 |
| **`autopilot`**   | a **daemon one-shot** generating the `.md`                                                                                                                                                   | **auto-advances**      | daemon batch, §7.2                      |

**Orthogonal to rigor by design** (operator's explicit call): a `production` plan may run `autopilot` (deep docs, review-after); a `prototype` may run `interactive` (converse on a throwaway). Rigor still sets _depth_; the router still sets _applicability_; this toggle only sets _whether convergence is forced before advancing._

> The chat is **always available** on any rail node (§12) regardless of mode — `autopilot` simply doesn't _block_ on it. And the existing **"Copy LLM prompt / import"** path is demoted from primary seam to **escape hatch** (converge in an external LLM, paste back) for when the operator prefers that.

> **Two distinct human-in-the-loop moments — do not conflate** (VQA v3 coordination): `conceptInteraction: interactive` (this axis) = the human converges the **spec** at _planning_ time. `verify:'manual'` (§4) = the human verifies the **built behavior** at _QA-Review_ time (operator lane, blocks ship). Opposite ends of the pipeline; different mechanisms.

Two convergence primitives, both already in the codebase:

1. **Structured decision cards** — BMAD `adv-elicit` ≈ the SKILL-SCOUT gate-card / `AskUserQuestion` pattern. The agent surfaces _bounded_ forks ("PRD scope: MVP-only / +growth / full vision?").
2. **Free-text chat** — the free agent. Open-ended refinement around the decision cards.

---

## 4. The schema delta — BMAD-grade stories

Current `EpicStory` (`functions/shared/types/epic-workflow.ts:219`) and `AcceptanceCriterion` (`:80`) carry only flat fields. The five BMAD-grade additions (all **optional** → legacy plans and `prototype` runs are unaffected):

```ts
// AcceptanceCriterion — add optional BDD structure (text stays the fallback)
export interface AcceptanceCriterion {
  id: string;
  text: string; // remains the human-readable / legacy form
  needsBrowser: boolean; // candidate to DERIVE from `verify` (= verify !== 'build') — see VQA-v3 coordination
  // ── Concept v2 (BMAD BDD) ──
  given?: string; // precondition / initial state
  when?: string; // action or trigger
  then?: string; // expected outcome — PROSE-OBSERVABLE (a human claim), never a raw seam expr
  thenObservable?: string; // optional hint for the QA-AUTHOR's prose→assert compilation ("playing state", "score increments")
  // ── VQA v3 coordination (vqa-qa-review-redesign.md §9) ──
  // The PM sets the *verify intent* at planning altitude (sibling of needsBrowser).
  // It is the source the downstream QA-AUTHOR derives the concrete L-level from.
  // The PM does NOT set L0/L1/L2 (a mechanism fact unknown until the seam exists).
  verify?: 'build' | 'appearance' | 'state' | 'behavior' | 'manual';
  // 'manual' (VQA v3 §9 MQ6) → human-in-the-loop verification at QA Review (operator
  // lane: never auto-pass/fail, blocks ship until confirmed). RESERVED for the
  // *knowably*-unautomatable: real payment, real OAuth consent, captcha, native
  // device, subjective aesthetic. REQUIRES `manualReason`. The gate-check (§8)
  // BOUNCES any 'manual' AC that is actually stubbable (via the test-mode seam)
  // back to 'behavior' — so 'manual' cannot become the new UNVERIFIABLE.
  manualReason?: string; // required iff verify === 'manual'
}
```

> **The AC is the seam between Concept v2 and VQA v3.** The BDD triple is _exactly_ the input to VQA v3's probe compiler: `given`→reach, `when`→act, `then`→observe. The PM authors the **claim + `verify` intent**; the QA-AUTHOR (a Developing-stage persona) compiles it into an executable probe at story-dev start. The PM authors **no probes** (Q7 of the coordination contract). The compiled probe lives in the existing dev-populated `visualTests[]`/`probes[]`, never in `plan-output-schema.ts`.

```ts
// EpicStory — add the four structured BMAD fields
export interface EpicStory {
  // …existing…
  // ── Concept v2 (BMAD-grade definition) ──
  userStory?: { role: string; action: string; benefit: string }; // As a / I want / So that
  technicalNotes?: string; // impl guidance, affected components, constraints
  tasks?: StoryTask[]; // AC-mapped checklist for the DEV agent
  references?: StoryReference[]; // citations into prd.md / architecture.md / ux-spec.md / the test-harness seam
}

export interface StoryTask {
  id: string; // "T1"
  text: string;
  acRefs: string[]; // e.g. ["AC-S1-1"] — which ACs this task satisfies
  done?: boolean; // DEV flips during execution
}

export interface StoryReference {
  // 'harness' (VQA v3 §9 Q6) → cites the boilerplate __harness snapshot shape DEV must populate
  source: 'prd' | 'architecture' | 'ux' | 'harness';
  section: string; // e.g. "error-handling", or "snapshot.gameState" for harness
  note?: string; // why this story cites it
}
```

Mirror the same optional fields in `src/types/epic-workflow.ts` and in `functions/shared/schemas/plan-output-schema.ts` (Zod, `.optional()` everywhere so nothing breaks).

**Why these five and not the rest:** `forbiddenAreas`, `touchPoints`, `dependsOn`/`wave`, and "learnings" already exist (§2). These five are the _only_ gaps between our story and a BMAD story.

### 4.1 Epic enrichment (Q1 — thin, for traceability)

`EpicWorkflow` (`functions/shared/types/epic-workflow.ts:283`) already has `title`, `description`, `acceptanceCriteria` (string), `dependsOnEpics`, `epicWave`. Add only two optional fields:

```ts
export interface EpicWorkflow {
  // …existing…
  goal?: string; // value statement — "why this epic exists" (BMAD names epics by value)
  requirementRefs?: string[]; // PRD functional-requirement ids this epic covers (e.g. ["FR-3","FR-7"])
}
```

`requirementRefs` is the traceability spine: the gate (§8) asserts every PRD requirement maps to ≥1 epic, and the §12 overlay draws `epic → PRD requirement` links. Stories stay where the executable richness is.

---

## 5. The decompose prompt — graft BMAD's `create-epics-and-stories`

`buildPmPlanPrompt` already does value-named epics, vertical slicing, wave rules, touch-point hygiene, browser-AC specificity. Graft in, **rigor-gated**:

- **User-story triple** per story (BMAD `instructions.md:107`).
- **BDD acceptance criteria** — emit `given/when/then` alongside `text` (BMAD `:111–116`), plus the `verify` intent (§4).
- **Idle-visible rule — RELAXED, gated on `verify`** (reverses v0.2; resolves VQA v3 §9 Q3, the one cross-session collision). The old blanket "every `needsBrowser` AC must describe the idle load frame" re-baked the VQA "disease" into planning. New rule:
  - `verify:'appearance'` → **MUST be idle-visible** (no "click to see" — the boundary is hardened here instead).
  - `verify:'behavior'|'state'` with `when/then` → **MAY describe a post-interaction state**; the VQA v3 probe _reaches_ it (`given`→reach, `when`→act, `then`→observe). The PM no longer contorts behavior into a load-frame description.
- **Epic-1-is-foundation rule** (BMAD `:97–101`): Story 1.1 = project/infra setup. (Largely covered by our boilerplate scaffolding; assert it for greenfield.)
- **`technicalNotes`** per story.
- **`tasks[]`** mapped to AC ids.
- **`references[]`** — only populated for `mvp`/`production`, pointing into the artifacts generated in §7. For `prototype`, omitted.

The PM prompt for `mvp`/`production` additionally receives the generated `prd.md` / `architecture.md` / `ux-spec.md` as context, so its `references[]` resolve to real sections.

---

## 6. **Start development** consumption — the choke point

> Enriching the schema is **inert** unless the execution path reads the new fields. Verified: `normalizeStorySpec()` in the Story Context Pack (`story-context-pack.mjs:628`) carries only `{id, title, description, acceptanceCriteria{id,text,needsBrowser}, touchPoints, hasBrowserTests, wave}` — it would **silently drop** every new field.

Required, shipped **together** with §4:

1. **`normalizeStorySpec()`** — carry `userStory`, `technicalNotes`, `tasks`, `references`, and the BDD `given/when/then` on ACs.
2. **`serializeStoryContextPack()`** (`:253`) — render them in the **Story spec** section:
   - user-story triple as a one-liner header,
   - ACs as `Given/When/Then` when present (fallback to `text`),
   - a **Tasks** sub-list,
   - **Technical notes** block.
3. **Resolve `references[]`** — the pack already inlines `plan.md` + `knowledge/index.md`. Add `prd.md` / `architecture.md` / `ux-spec.md` (when present in the project dir) and render the cited sections so the DEV agent reads the _contract_, not just a path. This is how `architecture.md` becomes the **multi-agent consistency contract** that kills parallel-wave drift.
4. **DEV template** (`daemon/pipelines/templates/dev-subagent-prompt.md.tpl`) — surface tasks + technical notes (today it shows ACs + `{{contextDigest}}` only).

Determinism contract of the pack (sorted, no timestamps, byte-identical across roles) **must be preserved** — new fields serialized in fixed order, sorted maps.

### 6.1 Test-harness seam provisioning (VQA v3 coordination — MQ3)

VQA v3's behavioral probes read a deterministic `window.__harness` seam (`vqa-qa-review-redesign.md §3.2`). Provisioning that seam spans **two altitudes of this stage**, and both are required:

| Altitude                                         | Signal                                  | Decision                                                                                                                        | Knows seam internals? |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Concept Router** (`concept-route`, runs first) | `conceptPlan.uiBearing`                 | _Capability_ — select a **harness-capable boilerplate** so a seam is available if any story later needs one. Coarse pre-filter. | No                    |
| **PM decompose** (`pm-plan`, runs later)         | an AC with `verify ∈ {state, behavior}` | _Requirement_ — DEV must **populate** the seam for that story; the AC carries a `references[].source:'harness'` citation.       | No                    |

> Why both: a static marketing page is `uiBearing` yet needs no game-state seam (the Router's coarse filter alone over-provisions); but a `verify:behavior` AC authored at decompose-time has nothing to read unless the Router _already_ picked a seam-capable scaffold (the real trigger alone under-provisions — ACs don't exist at Router-time). The Router provisions **capability**; the `verify` AC crystallizes the **requirement**. Neither knows the snapshot shape — the boilerplate contract owns it (§4 `'harness'` reference), DEV populates it.

### 6.2 Locked manifest formats (W2 + MQ7 — shared with VQA v3)

`references[]` resolution and VQA v3's probe compiler both depend on artifacts being **section-addressable**. This is the **locked, shared format** both sessions build to (VQA v3 budgeted the pack-serializer side as Hardening H9):

**Doc section manifest** — every `prd-gen`/`ux-gen`/`arch-gen` job emits `<artifact>.sections.json` alongside the `.md`, and mirrors each `id` as an HTML-comment anchor immediately above the heading:

```jsonc
// architecture.sections.json  (sibling of architecture.md)
{
  "artifact": "architecture", // 'prd' | 'architecture' | 'ux'
  "rev": 3,
  "contentHash": "sha256:…", // W1 binding — manifest is tied to one artifact rev
  "sections": [
    { "id": "error-handling", "title": "Error Handling Strategy", "lineStart": 42, "lineEnd": 71 },
    { "id": "state-model", "title": "State Model", "lineStart": 72, "lineEnd": 110 },
  ],
}
```

```md
<!--§error-handling-->

## Error Handling Strategy
```

- The **generator mints `id`** (stable slug); ids are **immutable across revs** where the section persists, so a `references[].section` survives an edit that doesn't delete the section.
- `references[].section` must ∈ `manifest.ids` → **set-membership** validation at decompose (`plan-output-schema.ts`) and at the §8 gate (this is what makes "every reference resolves" mechanizable).
- `resolveSection(md, id)` slices `lineStart..lineEnd` (deterministic, no regex) → the inlined contract for the Story Context Pack (W3 floor).

**Harness manifest** (`source:'harness'`, MQ7) — shipped by the boilerplate contract, populated by DEV; cited by JSON-path, not heading:

```jsonc
// __harness.schema.json  (boilerplate contract; DEV conforms the running app to it)
{
  "globalKey": "window.__harness",
  "snapshot": {
    // keys are the addressable reference paths
    "gameState": { "type": "string", "enum": ["idle", "playing", "gameOver"] },
    "score": { "type": "number" },
  },
  "events": ["spawn", "collision", "game-over"],
}
```

- `references[].source:'harness'`, `section:"snapshot.gameState"` → resolves against these JSON-path keys.
- VQA v3's **probe compiler reads this** to compile `assert` steps; the PM cites the path; DEV builds the seam to match.

---

## 7. Upstream artifact generation (driven by the conceptPlan)

Each artifact = a **non-interactive agent job** (daemon-spawned, like `pm-plan`), emitting a reviewable `.md` into the plan's project dir **and** persisted/surfaced in the Concept UI (§12). BMAD's interactive `adv-elicit` steps are **disabled** (non-interactive mode) — the human-in-the-loop seam is our existing **export / import / regenerate / "Copy LLM prompt"** affordances, not a blocking conversation.

| Job             | Persona             | Source workflow                                    | Output                      | Runs when                             |
| --------------- | ------------------- | -------------------------------------------------- | --------------------------- | ------------------------------------- |
| `concept-route` | Analyst (Mary)      | BMAD `workflow-init` (LLM classifier)              | `conceptPlan` (on Plan row) | always (first)                        |
| `prd-gen`       | PM (John)           | BMAD `prd` (non-interactive)                       | `prd.md`                    | `conceptPlan` includes `prd`          |
| `ux-gen`        | UX (Sally)          | BMAD `create-ux-design`                            | `ux-spec.md`                | `conceptPlan.uiBearing`               |
| `arch-gen`      | Architect (Winston) | BMAD `architecture`                                | `architecture.md`           | `conceptPlan` includes `architecture` |
| `pm-plan`       | PM (John)           | `create-epics-and-stories` (existing, enriched §5) | epics/stories/waves         | always                                |
| `gate-check`    | TEA (Murat)         | BMAD `solutioning-gate-check`                      | `readiness-report.md`       | `gate !== 'noop'`                     |

### 7.1 Ordering (D5 — serial when UI-bearing)

```
intent
  └─▶ concept-route ─▶ prd-gen ─▶ ┬─[uiBearing]─▶ ux-gen ─▶ arch-gen ─▶ pm-plan ─▶ gate-check ─▶ [Start dev]
                                  └─[non-UI]──────────────▶ arch-gen ─▶ pm-plan ─▶ gate-check ─▶ [Start dev]
```

- **UI-bearing ⇒ serial `PRD → UX → Architecture`** — Architecture's `dependsOn: ['prd','ux']`, so it cites the UX spec and its component/state/routing decisions match the interaction model. Costs +1 artifact of latency; bought consistency.
- **Non-UI ⇒ `PRD → Architecture`** — UX skipped entirely.

Each arrow above is a **converge→approve checkpoint, not an auto-advance** — and what happens _at_ each arrow depends on the interactivity toggle (§3.3):

- **`interactive`** → the artifact converges in a free-agent chat and **waits for the operator's Approve** before the dependent artifact starts. PRD is approved before UX/Arch can cite it.
- **`autopilot`** → the artifact is generated one-shot and **auto-advances**; the operator reviews after, on the rail.

`architecture` version-verification via WebSearch is allowed at gen time (network available in both substrates); cache results.

### 7.2 Substrate (D6)

| Mode          | Runs on                                                                                                                                                                                                | Why                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `interactive` | **daemon-hosted resumable Claude CLI session** (the _existing free-agent substrate_ — `free-agent-session.mjs`; Lambda only orchestrates + persists turns to DynamoDB, it does **not** host the model) | a resumable multi-turn session already exists on the daemon (`--resume`/`--session-id`); reuses it. |
| `autopilot`   | **daemon one-shot** (spawned Claude CLI, like `pm-plan` today)                                                                                                                                         | no human in the turn loop → batch is correct and cheapest.                                          |

> **W6 correction (§13):** both modes run on the **same host (the daemon)** — they differ only in turn-loop shape, not compute location. There is **no Lambda-resident chat** and therefore **no cross-host file delivery to build**. The real requirement is daemon-local: the free-agent session is confined to an `_assist/<sid>/` worktree, so on **Approve** the converged `concept/*.md` must be **promoted** into `<projectDir>/concept/` (which the Story Context Pack reads), and stored either as a **tracked commit on the plan branch** or **outside the git worktree** (the App worktree is force-cleaned by `git clean -fdx` and guarded by `assertWorktreeClean`). See §13 W6.

> The `concept-route` (Router) step is **always autopilot** — it's a fast classifier, not a conversation. Its `conceptPlan` output is operator-editable on the rail; **W7 (§13)** adds a one-click route-confirm checkpoint before any paid artifact runs. `pm-plan` (decompose) follows the plan's `conceptInteraction` like the artifact jobs.

---

## 8. The gate — upgraded Start development

Today **Start development** (`POST /api/plans/:id/start`) gates on: `status==='concept'` + epics-exist + SKILL-SCOUT resolved + structural validation (schema / refs / touch-point hygiene / visual coverage). That is _structural_.

Add the BMAD `solutioning-gate-check` as a **semantic** gate, rigor-scaled, producing `implementation-readiness-report.md`:

- every story has a user-story triple + ≥1 BDD AC (screen-verifiable where `needsBrowser`),
- every `references[]` resolves to a real section in a real artifact,
- foundation epic exists; no forward deps; epic/story coverage of PRD requirements,
- contradictions / gold-plating flagged,
- **anti-`UNVERIFIABLE` clause (VQA v3 §9 MQ6) — W5-corrected:** every `verify:'manual'` AC carries a `manualReason` from a **closed enum** (`real-payment | oauth-consent | captcha | native-device | email-sms-loop | subjective-quality | video-audio-perception | no-stub-possible`). The final `no-stub-possible` is the QA-confirmed catch-all (their QA-AUTHOR routes on the _stub-availability answer_, not the cause); the named seven each map to a known "stub possible?" verdict against the boilerplate contract. The Concept gate **flags every `manual` AC for operator confirmation** and rejects an empty/invalid reason — it does **NOT** reclassify `manual→behavior` itself (judging _stubbability_ is a mechanism fact unknown at planning altitude, per VQA §9 Q5). The actual `manual→behavior` **downgrade is performed by the QA-AUTHOR at story-dev start**, where seam availability is known, and re-derives `needsBrowser`. (Enforcement of the manual verification lane — block-ship — lives in QA Review. See §13 W5.)
- **appearance-coverage floor (W9):** for a `uiBearing` plan, ≥1 `verify:'appearance'` AC must exist per primary screen/route — warn at `mvp`, block at `production`. The §5 idle-visible relaxation removed the old floor; this restores it so L1 (appearance-at-load) is always exercised and a blank load screen can't pass.

Verdict: **Ready / Ready-with-conditions / Not-ready** — surfaced inline in `PlanReviewView` next to the existing SKILL-SCOUT gate card. `prototype` → auto-pass. `production` → must be Ready to enable the button.

---

## 9. Build order (smallest loop that proves value first — W-corrected)

> **Reordered after the §13 stress test.** The original order shipped enrichment that was inert at the apply-mapper (W4) and wired `references[]` before the primitives that make them resolvable existed (W2/W3). The corrected order front-loads those primitives and the full persist→consume path so every slice is genuinely end-to-end. Each slice is `prototype`-safe: prototype bypasses the Router (W8) and carries no references.

**Slice 1 — story richness loop, persisted _and_ consumed (proves richer-stories → richer-DEV-context, no upstream artifacts yet).**

- (a) Extend `Story`/`AcceptanceCriterion` schema + Zod plan-output schema (§4) + epic `goal`/`requirementRefs` (§4.1). Add `verify` + `manualReason` (closed enum) + `thenObservable`.
- (b) **[W4 — the no-op fix]** Edit the persist path so the new fields actually land: `applyPlanOutput` story/epic/criteria mappers (`plan-generation-service.ts:287–302`) **and** the round-trip `epicsToPlanOutput` (`:205–209`). Without this, (a) is inert.
- (c) Graft user-story + BDD + technicalNotes + tasks into `buildPmPlanPrompt` (§5, _no references yet_).
- (d) **[W12]** Carry + render them in `normalizeStorySpec` + `serializeStoryContextPack` + DEV template (§6.1–6.2, 6.4) — **atomically in one commit** (normalizer + serializer + schema), and **bump `STORY_CONTEXT_PACK_VERSION→2`**.
- (e) **[W11]** Add `conceptInteraction` to the Plan type + create-schema (optional) + a `resolveConceptInteraction(plan)` helper (no behavior change yet — plumbing only).
- → **Verifiable:** run a `prototype`/`mvp` plan, confirm the persisted story rows carry the new fields _and_ the DEV prompt renders Given/When/Then + tasks. (Tests the W4 persist + W12 render together.)

**Slice 2 — the two load-bearing primitives (must precede any `references[]` wiring).**

- (a) **[W2]** Generators emit a stable **section manifest** (`<!--§id-->` anchors + `{id,title,lineStart,lineEnd}` sidecar); `resolveSection(md, id)` slices by line range; validate `references[].section` ∈ manifest at decompose; §8 gate becomes set-membership.
- (b) **[W3]** Rebuild the pack budget as a **priority waterfall**: non-trimmable floor for story-spec + cited sections first, digests take the remainder; `references-over-budget` blocks rather than silently drops.
- (c) **[W1]** Artifact versioning: `{rev, contentHash}` per artifact + `dependsOnHashes` on consumers + the `approved→stale` reverse cascade + two-phase commit. (Needed before any approval gate is meaningful.)
- → **Verifiable:** a cited `architecture.md#id` resolves and inlines deterministically; editing the artifact flips dependents to `stale`; an over-budget reference blocks instead of vanishing.

**Slice 3 — Concept Router + architecture artifact + references (the consistency-contract win).**

- `concept-route` LLM-classifier job (§3.2, **prototype-bypassed** per W8) emitting `conceptPlan`; **[W7]** the route-confirm checkpoint + PRD-time reconciliation hooks; `arch-gen` job (§7) with **[W6]** daemon-hosted session + **promote-on-Approve** into `<projectDir>/concept/` (tracked-commit or outside-worktree, `git clean` exclude); `references[]` now resolve via Slice-2's manifest.

**Slice 4 — the gate.**

- **[W7c/W9]** `solutioning-gate-check` wired to Start development (§8): route↔AC cross-check, appearance-coverage floor, `manual`-flag-for-confirmation, reference set-membership.

**Slice 5 — PRD + UX + interactive Concept UI rail.**

- `prd-gen`, `ux-gen`, full citation chain (§7); **[W10]** per-turn convergence-state persistence + `approvalTimeout` + `conceptInteraction` immutability-after-start; the pipeline-rail UI + per-agent logs (§11–§12).

> **Cross-session dependency:** Slice 4's W5 (`manual→behavior` downgrade) lands in the **VQA v3 / QA-AUTHOR** session, not here — our gate only flags. Coordinate before building the gate's manual path.

---

## 10. Risks / open questions

- **R1 — Pack token budget.** The Context Pack is capped at 30k tokens with progressive trimming (`story-context-pack.mjs:39`). Richer story specs + inlined artifact sections compete with file digests for budget. Mitigation: render _only the cited_ artifact sections (`references[].section`), never whole docs; account story-spec bytes before digests.
- **R2 — BDD migration.** Existing plans have flat `text` ACs. The serializer must fall back to `text` when `given/when/then` absent. (Built into §4.)
- **R3 — Non-interactive BMAD fidelity.** BMAD workflows assume `adv-elicit`. Running them headless may lose quality vs. the interactive original. Mitigation: the export/"Copy LLM prompt" seam lets the operator run the interactive version externally and import the result.
- **R4 — `prototype` purity.** Must guarantee `prototype` path is byte-for-byte today's behavior (no references, no artifacts, no gate). Guard every v2 branch on `rigor !== 'prototype'`.
- **Q1 — RESOLVED: epics get _thin_ enrichment, stories get the full §4.** The DEV agent works at story granularity, so richness lives there. Epics add only two fields, both for **traceability**: `goal` (value statement) + `requirementRefs[]` (which PRD functional requirements this epic covers). The latter powers the gate's "every requirement covered" check and the §12 traceability overlay. See §4.1.
- **Q2 — RESOLVED: disk-canonical + Plan-row pointers + read API** (mirrors how `plan.md` already works). Artifacts at `<projectDir>/concept/{prd,ux,architecture,readiness-report}.md` (canonical, read by the Story Context Pack). Plan row carries `conceptArtifacts` (pointer + status + persona + jobId, **not** the full markdown — could be large). UI reads via `GET /api/plans/:id/artifacts/:kind`. See §6.3 + §11.

---

## 11. Agents & logging (auditable, copy-pasteable)

Each Concept job runs as a **named BMAD persona** so logs are legible and the operator can copy a specific agent's transcript for debugging. The mechanism reuses what already ships (`AgentJob` rows + `StoryLiveOutput` live token stream + the daemon's persisted `agent-<id>.jsonl` transcript) — we only add identity + export.

### 11.1 Persona ↔ job map

| Concept job     | Persona             | Icon | Produces                        |
| --------------- | ------------------- | ---- | ------------------------------- |
| `concept-route` | Analyst (Mary)      | 📊   | `conceptPlan` + `rationale`     |
| `prd-gen`       | PM (John)           | 📋   | `prd.md`                        |
| `ux-gen`        | UX (Sally)          | 🎨   | `ux-spec.md`                    |
| `arch-gen`      | Architect (Winston) | 🏗️   | `architecture.md`               |
| `pm-plan`       | PM (John)           | 📋   | epics/stories/waves             |
| `gate-check`    | TEA (Murat)         | 🧪   | `readiness-report.md` + verdict |

### 11.2 Structured log envelope

Each job's log is wrapped with an auditable header the UI renders above the raw stream:

```
┌─ 🏗️ Winston · arch-gen · architecture.md
│  model: claude-… · phase: solutioning · rigor: production
│  started 14:02:11 · finished 14:03:48 · 38.2k in / 6.1k out · $0.21
└─ [Copy log] [Download transcript ⤓] [Copy LLM prompt]
   <live / persisted token stream …>
```

- **Identity** — every job tagged `{ agent, persona, phase }` so streams are labeled by who's speaking.
- **`Copy log`** — clipboard the rendered transcript (paste-here-for-bugfixing path the operator asked for).
- **`Download transcript`** — the raw `agent-<id>.jsonl` for deep auditing.
- **`Copy LLM prompt`** — existing affordance; lets the operator re-run the same prompt in an external LLM and import the result (the non-interactive escape hatch, R3).
- Persisted, not just live: the envelope + transcript survive after the job ends, so a failed plan can be post-mortemed.

## 12. Concept stage UI — the pipeline rail

Today `PlanReviewView` is a flat intent-card + epics-list. v2 renders the **conceptPlan as a DAG rail** so the operator can _see and verify_ the `architecture → prd → (ux) → plan` chain (and copy any agent's log inline):

```
┌──────────────────────────── CONCEPT ─────────────────────────────────┐
│  Intent ─▶ 📊Route ─▶ 📋PRD ─▶ 🎨UX ─▶ 🏗️Arch ─▶ 📐Plan ─▶ 🧪Gate ─▶ [Start dev] │
│            Mary      John     Sally   Winston   (epics→waves)  verdict          │
│                                                                                  │
│   each node:  ● status · persona · [chat 💬] [view ⤢] [log ▤] [✓ Approve]      │
│   non-UI plan: 🎨UX node greyed/absent (router decided)                         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Nodes** = artifacts from the `conceptPlan`; greyed when the router didn't activate them (e.g. UX on a CLI). Status-dotted: `drafting → awaiting-you (needs-review) → approved` (interactive) or `running → ready` (autopilot).
- **Click a node** → split panel: rendered markdown artifact (left) + the **convergence chat + decision cards** (right, §3.3) in `interactive` mode, or that agent's log envelope (§11.2) with copy/download in `autopilot`. The chat is openable on any node in either mode; only `interactive` _blocks_ the dependent node until **Approve**.
- **Approve gate** — in `interactive`, the dependent node's edge stays unlit until the operator clicks **✓ Approve** (the "agent asks for final approval, then we move forward" step). In `autopilot`, edges auto-light as artifacts resolve.
- **Plan node** expands to the _existing_ epics→waves view (PW0/PW1, parallel story grouping) — already working, kept as-is, framed as the rail's penultimate node.
- **Gate node** shows the readiness verdict inline and gates the Start-development button (no longer a bare button).
- **Traceability toggle** — overlay drawing `epic → PRD requirement` (`requirementRefs`, §4.1) and `story → architecture#section` (`references`, §4) links, so coverage is visible at a glance. This is the operator's "check architecture > prd > final plan" view.
- **Motion** (Sue Render): running nodes shimmer (compositor-only, `prefers-reduced-motion` honored); DAG edges fill left-to-right as each artifact resolves, so the fan-out → gate is felt, not read.

## 13. Stress-test findings (W-list, v0.6)

Six independent adversaries each attacked one load-bearing surface of v0.5, instructed to find redesign-forcing gaps and verify against code. **7 BLOCKERs, 5 SHOULD-FIX.** Five of seven blockers are "add a primitive the doc assumed existed," not "the design is wrong."

| #       | Sev | Finding                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                    | Touches           |
| ------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **W1**  | 🔴  | **Artifacts unversioned; approval not bound to a version.** Edit a PRD after UX/Arch/stories cite it → rail stays green, the "consistency contract" silently becomes a _stale inconsistency_ contract (more dangerous than none). | `{rev, contentHash}` per artifact + `dependsOnHashes` on consumers + `approved→stale` reverse cascade (transitive, topological re-approval) + two-phase commit (tmp→fsync→atomic-rename→flip Plan-row `status+hash`).                                                                  | §7.1, §12, schema |
| **W2**  | 🔴  | **`references[]` is decorative.** No markdown section-addressing exists in the pack; §8's "every reference resolves" is non-mechanizable; free-text anchors drift silently and fail _most_ on high-rigor runs.                    | Generators emit a **stable section manifest** (`<!--§id-->` + `{id,title,lineStart,lineEnd}`); PM cites from that closed list (validated at decompose, not `.optional()` string); `resolveSection()` slices by line range; gate = set-membership.                                      | §4, §6.3, §8, §7  |
| **W3**  | 🔴  | **Budget trim is inverted** — only lever is digest-only (`story-context-pack.mjs:215–239`), so under pressure it silently drops the inlined architecture contract (the whole point of W2).                                        | Priority **waterfall**: non-trimmable floor for story-spec + cited sections allocated _first_; digests take the remainder; if cited sections alone bust the floor → **block** (`references-over-budget`), don't silently drop.                                                         | §6, R1/R7         |
| **W4**  | 🔴  | **Enrichment inert at persist.** `applyPlanOutput` (`plan-generation-service.ts:287–302`) + `epicsToPlanOutput` (`:205–209`) copy a hardcoded field set → new fields dropped at write time. Slice 1(a) as written is a **no-op**. | Slice 1(a) MUST edit the apply + round-trip mappers, not just the Zod schema.                                                                                                                                                                                                          | §9                |
| **W5**  | 🔴  | **§8 "bounces `manual`→`behavior`" is an altitude violation** — judges _stubbability_ (a mechanism fact unknown at planning) → recreates the disease.                                                                             | Gate **flags for operator confirmation** + validates `manualReason` (closed enum + `no-stub-possible` catch-all); **QA-AUTHOR performs the downgrade at dev time** (logged reclassification event, forces `needsBrowser:true`). **[corrected inline §8; CONFIRMED by VQA v3 round-3]** | §8 · **VQA ✓**    |
| **W6**  | 🔴  | **Substrate mislabeled "Lambda-mediated."** Free agent runs on the **daemon** (`free-agent-session.mjs:265`), confined to an `_assist/` worktree; Story Context Pack reads the **force-cleaned App worktree**.                    | Relabel (daemon-hosted resumable session); **promote-on-Approve** into `<projectDir>/concept/`; store as tracked commit _or_ outside the worktree + add `concept/` to `git clean` exclude. **[corrected inline §7.2]**                                                                 | §3.3, §7.2        |
| **W7**  | 🔴  | **Router evidence-starved, non-deterministic, autopilot-only, upstream of all spend, no recovery.** A misroute burns PRD+UX+arch before the operator can correct it.                                                              | (a) cheap **route-confirm checkpoint** before `prd-gen`; (b) **PRD-time route reconciliation** (re-emit `uiBearing`/`complexity` with real FRs, re-plan on disagreement); (c) **gate-time route↔AC cross-check**.                                                                      | §3.2, §7, §8      |
| **W8**  | 🟡  | **"prototype = byte-identical/zero-latency" was false** (mandatory Router hop).                                                                                                                                                   | Explicit `rigor==='prototype' ⇒ skip concept-route`. **[corrected inline §3.2]**                                                                                                                                                                                                       | §3.2, R4          |
| **W9**  | 🟡  | **No appearance-coverage floor** after the idle-visible relaxation — a behavior-only plan never exercises L1; a blank load screen passes.                                                                                         | Gate: `uiBearing` ⇒ ≥1 `verify:'appearance'` AC per primary screen/route (warn mvp, block prod). **[added inline §8]**                                                                                                                                                                 | §5, §8 · **VQA**  |
| **W10** | 🟡  | **Abandoned sessions wedge the plan; mode-flip mid-flight undefined.**                                                                                                                                                            | Persist convergence state per-turn (resumable); `approvalTimeout` policy; `conceptInteraction` immutable once first artifact job starts.                                                                                                                                               | §3.3, §7.2        |
| **W11** | 🟡  | **`conceptInteraction` has no schema/type/default plumbing** — the "autopilot-for-prototype" default is specified nowhere as code.                                                                                                | Add to Plan type + create-schema (optional) + one `resolveConceptInteraction(plan)` helper.                                                                                                                                                                                            | §3.3, schema      |
| **W12** | 🟡  | Pack **cache version** not bumped; `manualReason` free-text; `validateVisualCoverage` reconciliation.                                                                                                                             | Bump `STORY_CONTEXT_PACK_VERSION→2` (one-time warm cost; real invariant = intra-story cross-role identity); `manualReason`→closed enum; keep `needsBrowser` authoritative, defer derivation.                                                                                           | §4, §6            |

**Retracted over-claim:** the v0.5 fear that the prompt cache "reintroduces drift" is overstated — the pack **re-reads disk at every dispatch** and the Anthropic prefix cache is a 5-min ephemeral _cost_ optimization, not correctness state. The real defect is **W1 (artifact version-binding)**, not the cache.

**Single highest-leverage primitives:** **W1's** `{rev, contentHash}` versioning closes five state-machine gaps at once; **W2's** generator-emitted section manifest closes the references cluster (W2/W3 root). Both should land before any Slice that wires `references[]`.

**Cross-session — CLOSED with VQA v3 (round-3, 2026-06-16):**

- **W5** — confirmed: their QA-AUTHOR owns the `manual→behavior` downgrade (logged event, forces `needsBrowser:true`); our gate only flags. ✓
- **`manualReason` enum** — accepted with the added `no-stub-possible` catch-all (§8). ✓
- **W2 manifest** — one shared format locked (§6.2); their probe compiler resolves `source:'harness'` against `__harness.schema.json`; they build the pack-serializer side as their Hardening **H9**. ✓
- **W9** — accepted: our per-screen appearance floor + their per-AC "state AND appearance" pairing are complementary. ✓
- **MQ1-followup / MQ7** — confirmed: `needsBrowser` derived for build/appearance/state/behavior, explicit for `manual`; test-mode stubs cite `source:'harness'` (no new source). ✓
- **FYI (theirs, not a contract item):** realtime/multiplayer ACs are `verify:'manual'` for v1 — a single-page seam can't observe cross-client truth. Concept-side implication: when the Router picks a multiplayer/realtime app, the PM prompt should expect a higher `manual` rate (no action required, logged so it doesn't fall between the sessions).

---

## Appendix A — agent panel (party-mode debate, 2026-06-16)

Design pressure-tested by: **BMad Master** (schema-delta framing), **Bob/SM** (story-completeness field map), **Winston/Architect** (architecture-as-consistency-contract), **Amelia/Dev** (Start-development consumption choke point), **John/PM** (rigor↔level mapping), **Murat/TEA** (semantic gate), **Rick** (scope discipline — kill the redundant implementation-phase imports), **Ludwig** (interactive→autonomous conversion + fan-out-then-gate orchestration).
