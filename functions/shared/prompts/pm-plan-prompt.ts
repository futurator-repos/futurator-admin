import type { BoilerplateType } from '../boilerplates/registry';
import { BOILERPLATE_REGISTRY } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';

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
  }));

  return `You are the Product Manager. Transform the user's intent into a Plan
with 1..N Epics organized by concern, maximizing parallel execution via a
careful dependency graph.

## Plan name (fixed, do NOT change)

${args.planName}

## User intent

${args.intent}

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

**A plan with more parallelism ships faster.** When in doubt about whether two
stories actually depend on each other, prefer empty \`dependsOn\` — if they
conflict at integration time, the final build-check catches it.

### Decomposition guidelines

- **Simple intents** (one game, one page, one CRUD screen): one epic with
  3-8 stories. Aim for a "scaffold in wave 0, features in wave 1 (parallel),
  assembly in wave 2" shape.
- **Medium intents** (app with auth + UI + API): 2-4 epics. Foundation usually
  has no deps; feature epics depend on foundation; integration epic depends
  on the feature epics.
- **Large intents**: 4-6 epics max. Keep cross-epic deps minimal so epics
  themselves can run in parallel waves.

### What usually depends on what

- **Types/interfaces** are wave 0 (nothing depends on them yet, they define
  the contract). Types stories should ALWAYS have \`dependsOn: []\`.
- **Pure functions / hooks / services** can often be wave 1, depending on the
  types story — but **independent of each other**.
- **Components** usually depend on the hooks/services they consume.
- **App-level assembly / integration** depends on most of the above — wave N.

### Anti-pattern: sequential chains

If you produce \`S1 -> S2 -> S3 -> S4 -> S5\` (each depends only on the prior),
every story runs alone. That's the worst case. **Look for sibling stories
that can share a wave.**

### Story guidelines

- Each story is ~1-3 hours of agent time.
- Each story has the AC count appropriate for the rigor (see "Rigor" above).
  Mark \`needsBrowser: true\` for criteria that need visual/DOM verification.
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
        "acceptanceCriteria": "${ctx.exampleAcceptanceCriteria[0]}\\nAll shared types exported from \`${ctx.conventions.typesPath}index.ts\`",
        "dependsOn": [],
        "stories": [
          {
            "id": "S1",
            "title": "Define core domain types",
            "description": "${exampleStoryDescription}",
            "dependsOn": [],
            "criteria": ${JSON.stringify(exampleStoryCriteria)}
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
  least one acceptance criterion.
- **Maximize parallelism**: when two stories don't genuinely depend on each
  other's output, give both \`dependsOn: []\`.
- **Respect the boilerplate**: never propose "create a new <framework> project"
  or "scaffold from scratch" — the scaffold exists. Add to it.
- Output the JSON between the fences. Nothing else.

Output the JSON now.`;
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
