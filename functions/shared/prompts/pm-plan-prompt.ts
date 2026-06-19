import type { BoilerplateType } from '../boilerplates/registry';
import { BOILERPLATE_REGISTRY } from '../boilerplates/registry';
import type { PlanRigor, PlanKind } from '../types/plan';

/**
 * PM agent prompt for generating a Plan from a free-text intent.
 *
 * Pipeline v2.0 PR-5: now boilerplate-aware. The previous version hardcoded
 * "Vite+React+TS" in its example, which the LLM imitated regardless of the
 * operator's actual boilerplate choice — producing ACs that mismatched the
 * scaffold (e.g., asking the dev to "Bootstrap with Vite" when the project
 * was Next.js). This version draws framework name, conventional file
 * paths, "what's already scaffolded" hints, and example AC voice from the
 * BOILERPLATE_REGISTRY entry for the chosen type.
 *
 * Rigor (`prototype` | `mvp` | `production`) tunes:
 *   - Story count (prototype: minimal; production: comprehensive)
 *   - AC density per story (prototype: 1-3; mvp: 3-5; production: 4-6)
 *   - Test-spec strictness (prototype suggests `needsBrowser: false` defaults)
 */
export function buildPmPlanPrompt(args: {
  planName: string;
  intent: string;
  executionMode: 'pipeline' | 'orchestrator';
  /** Which boilerplate the App was scaffolded from. Drives framework-aware prompt content. */
  boilerplateType: BoilerplateType;
  /** Plan rigor — drives expected AC density. */
  rigor: PlanRigor;
  /**
   * PR-23d — plan kind: 'initial' (first plan on this App) vs 'change'
   * (additive plan on top of existing shipped code). When 'change', the
   * PM must read existing files via the project tree + knowledge index
   * and propose ADDITIVE stories only — never recreate types, primitives,
   * or files that already exist on disk. Defaults to 'initial' for legacy
   * plans without a kind field. Phase-2 kinds (feature/bugfix/…) are
   * accepted; only 'change' currently switches prompt content (the
   * brownfield clause) — others use the default voice.
   */
  kind?: PlanKind;
  /**
   * Concept v2 (E7.8) — section ids the upstream artifacts expose, by source.
   * Present only for mvp/production AFTER prd/ux/architecture generation. When
   * given, the PM may cite them via `references[]` (validated set-membership at
   * decompose, E4.2). Absent → no references emitted (prototype / pre-artifact).
   */
  citableSections?: Partial<Record<'prd' | 'architecture' | 'ux', string[]>>;
  /**
   * Concept v2 (E5.1) — set when the plan IS concept-chain-bearing (mvp/
   * production with a conceptPlan) but `citableSections` was not resolved at
   * build time (the Lambda can't read the EC2 manifests). The prompt then emits
   * a daemon-fillable `{{CITABLE_SECTIONS}}` placeholder, which the daemon
   * substitutes with the real ids at run time (Story 5.2). Ignored on the
   * inline-supplied path and for prototype plans (byte-identical lean output).
   */
  expectsCitations?: boolean;
  /**
   * Concept v2 (Round 1.1, 2026-06-17) — the approved upstream specs (PRD / UX /
   * Architecture) inlined as markdown, so the PM plans GROUNDED in them (the
   * BMAD "shard the PRD into epics/stories" model) instead of re-deriving scope
   * from the bare intent. The Lambda passes the daemon-fillable
   * `{{PRIOR_ARTIFACTS}}` placeholder; the daemon substitutes the real on-disk
   * section bodies at run time (mirrors ux/arch gen). Absent on the legacy
   * eager-PM path (no approved docs exist) → the prompt stays intent-only.
   */
  priorArtifacts?: string;
}): string {
  const meta = BOILERPLATE_REGISTRY[args.boilerplateType];
  if (!meta) {
    throw new Error(`buildPmPlanPrompt: unknown boilerplateType "${args.boilerplateType}"`);
  }
  const ctx = meta.pmContext;
  if (!ctx) {
    throw new Error(
      `buildPmPlanPrompt: boilerplate "${args.boilerplateType}" has no pmContext (registry not yet wired for PM use)`,
    );
  }

  const rigorGuidance = renderRigorGuidance(args.rigor);
  const exampleStoryDescription = `Define the core domain types under \`${ctx.conventions.typesPath}\` (DinoState, Obstacle, GameState — adjust to the intent). Export from a barrel file.`;
  const exampleStoryCriteria = ctx.exampleAcceptanceCriteria.slice(0, 2).map((text, i) => ({
    id: `AC-S1-${i + 1}`,
    text,
    needsBrowser: false,
    // Concept v2 — foundation/types ACs are build-verifiable (typecheck/unit).
    verify: 'build' as const,
  }));

  // Concept v2 (E3.1) — BMAD-grade story fields are emitted only for mvp/production;
  // `prototype` stays lean (byte-identical to the v1 shape). `references[]` are
  // grafted later (Epic E7, once the artifact manifests exist).
  const enriched = args.rigor !== 'prototype';
  // Concept v2 (E7.8) — which artifact sections the PM may cite via references[].
  const citable = args.citableSections || {};
  const citableEntries = (['prd', 'architecture', 'ux'] as const)
    .filter((k) => Array.isArray(citable[k]) && citable[k]!.length > 0)
    .map((k) => `${k}: ${citable[k]!.join(', ')}`);
  const hasCitable = enriched && citableEntries.length > 0;
  // E5.1 — emit the daemon-fillable placeholder when the chain WILL produce
  // citable sections but they aren't inlined at build time.
  const usePlaceholder = enriched && !hasCitable && args.expectsCitations === true;
  const exampleStoryEnrichment = enriched
    ? `,
            "userStory": { "role": "developer", "action": "import the domain types", "benefit": "every later story shares one contract" },
            "technicalNotes": "Add to the existing scaffold; export from the barrel file. No new build config.",
            "tasks": [
              { "id": "T1", "text": "Define and export the core domain types", "acRefs": ["AC-S1-1"] }
            ]`
    : '';

  // Concept v2 (Round 1.1) — when the spec chain produced approved PRD/UX/
  // Architecture docs, lead with them: the PM SHARDS those docs into epics +
  // stories instead of re-deriving scope from the one-line intent. This is the
  // fix for "the planner ignored the docs the agents just wrote".
  // E1-S1 (v3) — the FR-coverage traceability field is meaningful only for a
  // spec-grounded plan (the PRD defines the FR ids). Intent-only / prototype
  // plans have no PRD, so the example omits it (schema-optional → byte-identical
  // legacy output). When grounded, the example shows the field so the PM emits it.
  const exampleRequirementRefs = args.priorArtifacts
    ? `\n        "requirementRefs": ["FR1", "FR2"],`
    : '';
  const groundingBlock = args.priorArtifacts
    ? `## Approved specs — PLAN FROM THESE (the source of truth)

Specialized agents already produced, and the operator APPROVED, the documents
below: **John (PRD)**, **Sally (UX)**, **Winston (Architecture)**. They are the
contract for this build — your epics and stories are a DECOMPOSITION of them,
not a fresh interpretation of the intent. Hard rules:

  - **Cover the specs.** Every functional requirement (PRD), screen/flow (UX),
    and module/decision (Architecture) must map to at least one story. Walk the
    docs section by section and make sure nothing approved is dropped.
  - **Trace coverage explicitly.** Each epic MUST declare \`requirementRefs\`: the
    list of PRD requirement ids (\`FR1\`, \`FR2\`, …, exactly as numbered under the
    PRD's \`## Functional Requirements\`) that the epic's stories deliver. Every FR
    in the PRD must appear in at least one epic's \`requirementRefs\` — this is the
    traceability spine the readiness gate checks, and an uncovered FR blocks the
    start of development. Cite only ids that exist in the PRD; never invent one.
  - **Honor the architecture.** Use its concrete tech choices, data model,
    module boundaries, and file layout when you write \`touchPoints\` and
    \`technicalNotes\` — do not invent a different structure.
  - **Do not invent scope** these docs don't cover, and **never contradict**
    them. If the intent and a spec disagree, the approved spec wins.
  - Prefer the docs' own wording for behaviors and acceptance criteria.

${args.priorArtifacts}

---

`
    : '';

  return `You are the Product Manager. Transform the ${args.priorArtifacts ? 'approved specs below' : "user's intent"} into a Plan
with 1..N Epics organized by concern, maximizing parallel execution via a
careful dependency graph.

## Plan name (fixed, do NOT change)

${args.planName}

## User intent

${args.intent}

${groundingBlock}
## Boilerplate context (CRITICAL — read first)

The App was scaffolded from the **${meta.displayName}** boilerplate.
Framework: **${ctx.framework}**.

### What is ALREADY in place — do NOT propose stories that "create" or
### "set up" any of these. They exist; configure on top of them.

${ctx.scaffoldedAlready.map((s) => `  - ${s}`).join('\n')}

### Conventional paths for this boilerplate

When writing story descriptions and ACs, use these paths verbatim:
  - Types:      \`${ctx.conventions.typesPath}\`
  - Source root:\`${ctx.conventions.sourceRoot}\`
  - Pages/app:  \`${ctx.conventions.pagesOrAppPath}\`
  - Components: \`${ctx.conventions.componentsPath}\`
  - Tests:      \`${ctx.conventions.testsPath}\`
  - Styles:     \`${ctx.conventions.stylesPath || '(n/a)'}\`
  - Config (do NOT modify unless intent requires it): ${ctx.conventions.configFiles.map((c) => `\`${c}\``).join(', ')}

### Build/test commands (use these in AC text)
  - Build: \`${meta.defaultStack.buildCommand}\`
  - Dev:   \`${meta.defaultStack.devCommand}\`
  - Test:  \`${meta.defaultStack.testCommand}\`

### AC voice (match this style — boilerplate-specific)

Sample ACs that match this boilerplate's conventions:
${ctx.exampleAcceptanceCriteria.map((c) => `  - "${c}"`).join('\n')}

${meta.scaffoldContract ? renderScaffoldContractBlock(meta.scaffoldContract) : ''}
${args.kind === 'change' ? renderBrownfieldClause() : ''}
## Rigor: ${args.rigor}

${rigorGuidance}

## Your task

Produce a JSON document describing the Plan's epics, each epic's stories, and
the dependency graph at both layers. **Parallelism is a primary goal.**

### Parallelism model — read carefully

The \`dependsOn\` arrays you produce drive WAVES — groups of stories that
execute simultaneously across multiple agent instances. Concretely:

- Stories with \`dependsOn: []\` run in **wave 0** (parallel with each other).
- A story with \`dependsOn: ["S1"]\` runs in **wave 1** (only after S1).
- A story with \`dependsOn: ["S2", "S3"]\` runs after BOTH, so wave = max(S2, S3) + 1.
- Epics follow the same model at their layer: all wave-0 epics start together.
- **HARD RULE — a story's \`dependsOn\` may ONLY reference EARLIER stories in
  the SAME epic.** Cross-epic ordering is expressed exclusively through the
  EPIC's own \`dependsOn\` (the epic layer). If a story needs work from
  another epic (e.g. a final assembly that composes everything), put that
  story in an epic that \`dependsOn\` those other epics — never point the
  story's \`dependsOn\` across epics. Plans violating this are REJECTED at
  apply time.

**A plan with more parallelism ships faster.** When in doubt about whether two
stories actually depend on each other, prefer empty \`dependsOn\` — BUT only
when they are behaviorally independent (see "Anti-pattern: behaviorally
coupled siblings" below). File-level independence is not enough; siblings
whose behaviors interact WILL fail the merge gate and burn repair time.

### Decomposition guidelines

- **Simple intents** (one game, one page, one CRUD screen): one epic with
  3-8 stories. Aim for a "contract in wave 0, vertical features in wave 1
  (parallel), assembly in wave 2" shape.
- **Medium intents** (app with auth + UI + API): 2-4 epics. Foundation usually
  has no deps; feature epics depend on foundation; integration epic depends
  on the feature epics.
- **Large intents**: 4-6 epics max. Keep cross-epic deps minimal so epics
  themselves can run in parallel waves.
- **Name epics by VALUE, not by technical layer.** "Player Movement",
  "Scoring & Progression", "Content Discovery" — not "Rendering Layer",
  "State Management", "Components". Layer-named epics are a symptom of
  horizontal slicing (see below).

### Slice VERTICALLY — the single most important structural rule

Each parallel story must be a **self-contained vertical slice**: one
capability delivered end-to-end (its logic + its rendering + its tests),
living in its OWN modules, integrated through the contracts of earlier
waves. A vertical slice is independently developable, independently
verifiable on screen, and merges without touching its siblings.

The anti-shape is **horizontal slicing**: one story does "all the
renderers", a sibling does "all the mechanics", a third does "the HUD" —
every behavior then SPANS stories, their tests encode assumptions about
each other, and the merged union fails even though each passed alone.

Test for each parallel wave you emit: *"could each of these stories ship
alone on top of the previous wave and demonstrably work?"* If a story only
makes sense once its sibling lands, it is not a vertical slice — merge them
into one story or sequence them.

### What usually depends on what

- **Types/interfaces/constants** are wave 0 (nothing depends on them yet,
  they define the contract). Types stories should ALWAYS have
  \`dependsOn: []\`. The contract story must define EVERY name two later
  stories will both reference — siblings must never co-invent a shared type.
- **Vertical feature slices** are wave 1+, depending on the contract story —
  but **independent of each other** (disjoint files, disjoint behaviors).
- **Interaction behaviors** (entity A reacts to entity B) depend on BOTH
  feature stories — a later wave by construction.
- **App-level assembly / integration** depends on most of the above — wave N.

### Anti-pattern: sequential chains

If you produce \`S1 -> S2 -> S3 -> S4 -> S5\` (each depends only on the prior),
every story runs alone. That's the worst case. **Look for sibling stories
that can share a wave.**

### Anti-pattern: behaviorally coupled siblings

Same-wave stories are developed **in parallel, blind to each other's code** —
they meet only at the merge gate, so two siblings must never implement or test
ONE behavior that spans both. Classic failure: story A implements ghost
movement/state, sibling B implements "Pacman eats a frightened ghost" — B's
tests assume A's entities A never saw, both pass alone, and the merged union
fails the wave gate.

Rules:
- An **interaction behavior** between two entities/modules (collision,
  eating, scoring triggered by another entity's state, A-reacts-to-B) belongs
  in ONE story that \`dependsOn\` the stories owning both sides — a later
  wave, never split across siblings.
- A story's tests may only assert code that story itself delivers (plus
  already-merged contracts from earlier waves) — never a sibling's behavior.
- Siblings must have **disjoint touch points**. Shared types/contracts come
  from an earlier wave's contract story; a sibling never edits another
  sibling's module.
- Stories never touch **shared infrastructure**: \`package.json\` (deps,
  scripts), lockfiles, test-runner/build config, or \`@generated\` files. The
  scaffold ships the test runner and lifecycle scripts; a story that thinks
  it needs a new dependency is mis-scoped — restructure it to use what the
  scaffold provides.

### Touch points — REQUIRED on every story

Each story declares \`touchPoints\`: the file paths it will create or
modify (relative to the project root, using the conventional paths above).

- **Be precise and honest.** List every file. The wave scheduler uses this
  to serialize stories that would collide: two siblings declaring the same
  file are automatically pushed into sequential waves. Honest touch points
  cost a little parallelism; dishonest ones cost a failed merge gate and an
  agent repair cycle (far slower).
- If a story has no clear file set, the story is mis-scoped — restate it
  until it does. For genuinely cross-cutting stories (integration,
  refactors spanning many files) declare \`"touchPoints": ["<EPIC_WIDE>"]\`
  — that story is excluded from parallel waves entirely and runs alone.
- Stories in the same wave must have **disjoint** touch points.
- NEVER list shared infrastructure (\`package.json\`, lockfiles, build/test
  config, \`@generated\` files) — plans claiming them are REJECTED at the
  API layer. The scaffold owns those.

### Story guidelines

- Each story is ~1-3 hours of agent time — sized so a single dev agent
  completes it in one focused session. If you can't describe the
  deliverable in two sentences, split it.
- **Acceptance criteria are behavior contracts, not task lists.** Prefer
  the Given/When/Then shape where it fits ("Given the game is idle, when
  the page loads, then the canvas shows…"); always state an observable
  outcome, never an implementation step ("uses a reducer" is not an AC).
  Every AC must be verifiable by exactly one of: the test suite, the
  typechecker/build, or the idle screenshot.
- A story's ACs (and therefore its tests) may only assert THIS story's
  deliverable plus contracts from earlier waves — never a sibling's
  behavior.
- **Every story MUST produce a concrete code deliverable** (source files the
  DEV writes/edits). NEVER create a standalone "browser smoke test",
  "verify X end-to-end", "QA pass", or "integration test" story whose only
  output is verification. Browser/visual verification happens **automatically
  per code-story** — each story with \`needsBrowser: true\` criteria is
  screenshotted and judged against those ACs inside its own pipeline (the
  runtime review), and failures are fed back to that story's DEV. A
  verification-only story has no source to commit, so it cannot pass the
  commit gate and blocks the whole epic. Fold the verification intent into
  the \`needsBrowser\` ACs of the code story that builds the feature instead.
- Each story has the AC count appropriate for the rigor (see "Rigor" above).
  Mark \`needsBrowser: true\` for criteria that need visual/DOM verification.
- **Set a \`verify\` intent on every AC (Concept v2).** This is YOUR planning-time
  signal of HOW the claim is checked; the QA author later compiles it into the
  concrete test. Choose one:
    • \`build\`      — typecheck / unit / pure-logic (no browser). \`needsBrowser:false\`.
    • \`appearance\` — a single idle-load frame is judged (it must be visible at
                     load, no interaction). \`needsBrowser:true\`.
    • \`state\`      — a deterministic app-state read after an interaction.
    • \`behavior\`   — reach → act → observe over time (the richest check).
    • \`manual\`     — only the *knowably* unautomatable (real payment, OAuth
                     consent, captcha, native device, subjective quality). You
                     MUST add a \`manualReason\` from the closed set
                     (real-payment | oauth-consent | captcha | native-device |
                     email-sms-loop | subjective-quality | video-audio-perception
                     | no-stub-possible). Do NOT use \`manual\` to dodge a check
                     that a test harness could stub — that is rejected at the gate.
  Write \`given\`/\`when\`/\`then\` (BDD) alongside \`text\` whenever the AC is more
  than a one-line build check; keep \`then\` a PROSE-OBSERVABLE human claim
  (never a code/selector expression — the QA author writes the assertion).${
    enriched
      ? `
- **Give each story a BMAD-grade definition (Concept v2).** Beyond the ACs, emit:
    • \`userStory\`: { role, action, benefit } — the "As a / I want / So that" triple.
    • \`technicalNotes\`: implementation guidance — affected components, constraints,
      what to reuse from the scaffold. Keep it concrete, not a restatement of the title.
    • \`tasks\`: an ordered checklist, each \`{ id, text, acRefs }\`, where \`acRefs\`
      lists the AC ids that task satisfies. Every AC should be covered by ≥1 task.
  (These make the story self-sufficient for the DEV agent.)${
    hasCitable
      ? `
    • \`references\`: cite the upstream artifacts a story depends on — each
      { source, section } where \`section\` is one of the available ids (cite
      ONLY these; never invent an id):
      ${citableEntries.join('\n      ')}`
      : usePlaceholder
        ? `
    • \`references\`: cite the upstream artifacts a story depends on — each
      { source, section } where \`section\` is one of the available ids (cite
      ONLY these; never invent an id):
      {{CITABLE_SECTIONS}}`
        : `
    • Do NOT emit \`references[]\` yet — citations are added once the PRD/UX/
      architecture artifacts exist.`
  }`
      : `
- This is a \`prototype\` plan: keep stories lean — ACs + touchPoints only. Do NOT
  emit userStory/technicalNotes/tasks/references (that depth is for mvp/production).`
  }
- **Browser AC text must be SCREEN-VERIFIABLE.** When \`needsBrowser: true\`,
  phrase the criterion so a person looking at a screenshot can apply it without
  reading the source code — concrete observable signal (count + color/style +
  position + a FAIL clause when it's not obvious) beats general adjectives. (PR-63)

  ❌ Vague (FAIL the classifier's specificity check): "The login form renders correctly."
  ✅ Concrete (supports the QA judge): "At game start (before any input) the canvas
     shows the player sprite standing on the ground band, with the score HUD reading
     '0' in the top-left corner."

  The dev agent mirrors this concrete voice into the story's visualTests \`judge:\`
  block, which is the actual contract the QA judge applies.

  **Browser ACs are verified against the story's own registered feature
  surface — and HOW depends on the AC's \`verify\` intent (Concept v2).**
  Visual QA captures each story's feature in ISOLATION (the generated page
  renders one feature at a time via its registration). A \`needsBrowser\` AC
  must always describe the story's OWN feature — never what a sibling
  renders. Then, by intent:
    • \`verify:'appearance'\` → MUST be idle-visible: true at the INITIAL load
      frame (no clicks, no keypresses, no elapsed time). Never write a
      \`click to see\` appearance AC — phrase it about what the load frame
      physically shows.
    • \`verify:'behavior'|'state'\` (with \`when\`/\`then\`) → MAY describe a
      POST-INTERACTION state. The QA probe REACHES it (\`given\`→reach,
      \`when\`→act, \`then\`→observe), so you do NOT have to contort dynamic
      behaviour (spawning, motion, score changes, "during play") into a
      load-frame description — state the real observable outcome directly.
  Every UI-bearing story should still carry at least one
  \`verify:'appearance'\` AC for its idle signal (the appearance floor), so a
  blank load screen can never pass.

  **HARD REQUIREMENT — visual coverage (your plan is REJECTED without it).**
  This app renders a UI, so the plan MUST contain \`needsBrowser: true\` criteria;
  a plan with zero browser ACs fails validation and is regenerated (it would
  disable visual QA entirely). Per story: renders something on screen (canvas,
  sprite, component, page, HUD, overlay, background) → ≥1 \`needsBrowser: true\` AC
  for its idle-visible signal (e.g. "at load the canvas shows the dragon sprite on
  the ground band", "the HUD reads 'Score: 0' top-left"); pure-logic story (types,
  reducers, physics/collision math, spawn timing) → NONE (the test suite asserts
  its dynamics).

  **Make visibility structural — PROGRESSIVE FEATURE REGISTRATION.** A browser AC
  is only judgeable if the story's output is REGISTERED as a feature (the
  registered feature IS the isolation surface visual QA captures). So a story that
  delivers something visible MUST also mount it in the SAME story: register/extend
  \`src/features/<slug>.feature.tsx\` (listed in its touchPoints), rendering the
  deliverable in a meaningful idle state. Therefore:
  - Do NOT write "unit-test-only" rendering stories asserting mocked canvas-context
    calls instead of pixels — mount it, then write the browser AC about the idle frame.
  - The final assembly story composes everything into the real app feature, marks it
    PRIMARY (\`export const feature = { slug: '<app>', order: 0, primary: true }\`), and
    RETIRES interim preview features (list the removed files in its touchPoints; it
    runs in a later wave, so editing earlier-wave files is safe). \`primary: true\`
    makes the bare route \`/\` render ONLY the real app (previews stay at
    \`?feature=<slug>\`). It should also carry browser ACs for the composed initial frame.

  **Interaction- and time-gated ACs need a PROBE, not a static frame.** If an AC is
  only visible AFTER an action or elapsed time (a title screen needing Space/Enter, a
  HUD that appears once play starts, a GAME OVER / score-changed screen), one idle
  screenshot CANNOT verify it and a vision judge will false-FAIL it. The visual test
  MUST carry a \`flow\` that performs the gating interaction then captures, e.g.
  \`flow: [{ "action": "press", "key": "Enter" }, { "action": "wait", "ms": 500 }, { "action": "screenshot" }]\`,
  or a deterministic \`{ "action": "assert", "expr": "snapshot.phase", "op": "eq", "expected": "gameover" }\`
  reading \`window.__harness\`. Plain "what the idle frame shows" ACs stay probe-free.
- Titles are action-oriented ("Implement useGameLoop hook", not "The
  useGameLoop hook").
- **Stories must respect the existing boilerplate** — if the AC says
  "Bootstrap the project with X" or "Create a new Y project", you have written
  the wrong AC. The project IS already scaffolded. Your stories should ADD
  files to it or MODIFY existing ones in the conventional paths above.

### Output format — strict

Output EXACTLY the structure below. Do NOT add prose before or after the
fences. Do NOT include trailing commas. Use double quotes. Do NOT wrap the
JSON in a code block.

---PLAN_JSON---
{
  "plan": {
    "name": "${args.planName}",
    "description": "<2-3 sentence summary of what's being built ON TOP OF the ${ctx.framework} scaffold>",
    "epics": [
      {
        "id": "E1",
        "title": "Foundation",
        "goal": "Define shared types and constants in the existing scaffold",
        "acceptanceCriteria": "${ctx.exampleAcceptanceCriteria[0]}\\nAll shared types exported from \`${ctx.conventions.typesPath}index.ts\`",${exampleRequirementRefs}
        "dependsOn": [],
        "stories": [
          {
            "id": "S1",
            "title": "Define core domain types",
            "description": "${exampleStoryDescription}",
            "dependsOn": [],
            "touchPoints": ["${ctx.conventions.typesPath}index.ts"],
            "criteria": ${JSON.stringify(exampleStoryCriteria)}${exampleStoryEnrichment}
          }
        ]
      }
    ]
  }
}
---END_PLAN_JSON---

## Constraints

- Plan name MUST equal "${args.planName}" exactly.
- Use LOCAL IDs like "E1", "S1" — do NOT invent UUIDs.
- Epic \`dependsOn\` can only reference epics defined earlier in the array.
- Story \`dependsOn\` can only reference stories earlier in the same epic.
- At least one epic. Each epic has at least one story. Each story has at
  least one acceptance criterion AND a non-empty \`touchPoints\` array.
- **Maximize parallelism**: when two stories don't genuinely depend on each
  other's output, give both \`dependsOn: []\` — provided they are vertical
  slices with disjoint touch points and independent behaviors.
- **Respect the boilerplate**: never propose "create a new <framework> project"
  or "scaffold from scratch" — the scaffold exists. Add to it.
- Output the JSON between the fences. Nothing else.

## Final self-check (run mentally BEFORE emitting)

1. **Coverage** — every requirement in the user intent maps to at least one
   story. Nothing the user asked for is missing; nothing they didn't ask
   for was invented.
2. **Vertical slices** — every parallel wave passes the "could each story
   ship alone on top of the previous wave?" test.
3. **No coupled siblings** — no behavior spans two stories in one wave; no
   story's ACs mention a sibling's deliverable.
4. **Touch points** — present on every story, precise, disjoint within each
   wave, no shared infrastructure.
5. **Contract-first** — every name two stories reference is defined by an
   earlier-wave story both depend on.
6. **Visual coverage** — every story that renders something has an
   idle-visible \`needsBrowser\` AC; pure-logic stories have none.${
     args.priorArtifacts
       ? `
7. **Spec grounding** — every approved-doc requirement (PRD), screen/flow (UX),
   and module/decision (Architecture) maps to a story; nothing approved was
   dropped; nothing contradicts the docs.
8. **Coverage trace** — every PRD \`FR\` id appears in at least one epic's
   \`requirementRefs\`; no \`requirementRefs\` entry cites an id absent from the PRD.`
       : ''
   }

Output the JSON now.`;
}

/**
 * PR-13 Phase 2 — render the starter pack's scaffold contract as a hard
 * constraint block at the top of the PM prompt. This is the difference
 * between "boilerplate is advisory" and "boilerplate is contractually
 * forbidden territory."
 *
 * The contract content comes verbatim from the registry (mirror of the
 * SCAFFOLD.md in augment files). The PM is told upfront that any story
 * touching pre-baked files will be REJECTED at the API layer, so it
 * doesn't waste tokens emitting them.
 */
function renderScaffoldContractBlock(scaffoldContract: string): string {
  return `## SCAFFOLD CONTRACT (READ FIRST — STRICT)

This App was scaffolded from a starter pack that pre-bakes domain primitives.
You MUST treat the contract below as inviolable: any story whose touch points
fall inside the "Pre-baked" file list, or whose title matches a "Forbidden
story pattern", will be REJECTED at the API layer and force a Regenerate cycle.
Match your stories to the "Required story patterns" instead.

\`\`\`
${scaffoldContract.trim()}
\`\`\`

`;
}

/**
 * PR-23d — brownfield clause for kind='change' plans.
 *
 * Plan kind 'change' means the App already has shipped code from a prior plan.
 * The PM must spec ADDITIVE stories only — never recreate types/primitives/
 * files that already exist. The story-context-pack ships the project tree
 * + knowledge index for free, but without an explicit clause the PM tends
 * to propose "Define core game types" stories even when types.ts already
 * exists with 50+ lines of dino-domain interfaces.
 *
 * 2026-05-04 — added before plan 2 of dino-runner-1 to prevent
 * re-scaffolding regression on the second iteration.
 */
function renderBrownfieldClause(): string {
  return `## BROWNFIELD MODE (READ — STRICT)

This is a **change plan** on top of an already-shipped App. There is existing
code on disk from prior plans. Your job is to propose ADDITIVE stories that
build on what's there, NOT to recreate it.

### Hard rules

1. **Never propose stories that "Define X types", "Set up Y", "Create Z
   component" if X/Y/Z already exists.** Use the project tree + knowledge
   index in your context to verify. If you're unsure, prefer "Extend X with
   <new field/feature>" over "Define X".
2. **Reuse existing primitives.** Hooks, helpers, reducers, render components
   from the prior plan's stories ARE part of the substrate now. Story
   descriptions should reference them by path (e.g. "extend
   \`src/game/reducer.ts\` with a NEW action…", not "create a reducer").
3. **Touch-points must point at REAL files** in most stories. A change-plan
   story whose only touch points are NEW file paths is suspicious — most
   change work modifies existing files.
4. **Every story description should reference the existing code by name**,
   making it explicit what's being extended/modified versus newly created.

### Anti-patterns (will be flagged at review)

- "Implement game state machine" → already exists; should be "Add <new
  action> to existing state machine in \`src/game/reducer.ts\`".
- "Create render components" → already exist as DinoRender, ObstacleRender,
  GroundRender; should be "Refactor DinoRender to support sprite assets" or
  "Add <new entity> render component".
- A wave-0 story without any \`dependsOn\` AND without any pre-existing file
  in its touch points is the smoking gun. Ask yourself: "is the dev going
  to read prior plan's code before writing this?". If no, the story is
  probably wrong.

### What good change-plan stories look like

- "Add cactus-variant rendering — modify \`src/components/canvas/ObstacleRender.tsx\`
  to switch between 3 SVG sprites based on \`obstacle.variant\` field."
- "Wire pause-on-blur — extend \`src/game/reducer.ts\` with PAUSE/RESUME
  actions; subscribe to \`document.visibilitychange\` in \`src/app/page.tsx\`."
- "Add high-score persistence — new \`src/game/highscore.ts\` reading/writing
  \`localStorage\`; called from existing GAME_OVER reducer case."

`;
}

function renderRigorGuidance(rigor: PlanRigor): string {
  switch (rigor) {
    case 'prototype':
      return `**Prototype rigor** — minimal viable footprint. Generate the SMALLEST
plan that achieves the intent. Stories should have **1-3 ACs each**.
Skip exhaustive test cases; one happy-path AC per story is fine. Browser
tests only when the intent is fundamentally visual. Aim for ~5 stories
total in a simple intent.`;
    case 'mvp':
      return `**MVP rigor** — typical balance. Stories should have **3-5 ACs each**,
covering the happy path plus 1-2 edge cases. Include build/typecheck ACs
on at least the foundation story. Browser tests on UI-bearing stories.
Typical decomposition: ~6-12 stories.`;
    case 'production':
      return `**Production rigor** — defensive. Stories should have **4-6 ACs each**,
covering happy path, edge cases, error paths, and accessibility/perf
where applicable. Every story needs at least one verifiable AC tied to a
test. Browser tests are the default for any UI story. Typical
decomposition: ~10-20 stories with explicit error-handling stories.`;
  }
}
