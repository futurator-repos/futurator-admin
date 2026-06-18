import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';

/**
 * Concept v2 (E2 / Story 2.2) — the UX generator prompt (UX / Sally persona).
 *
 * The AUTOPILOT one-shot builder for `ux-spec.md`. Consumes the approved PRD
 * sections (passed as `priorArtifacts` — inlined section bodies, NOT paths) so
 * component/state/journey decisions are grounded in the PRD scope; the serial
 * PRD→UX ordering (D5) means this only runs after the PRD is approved. Emits ATX
 * headings per the BMAD UX 9-section template so each becomes a citable anchor.
 *
 * This builder only AUTHORS the doc — the `uiBearing` applicability gate (run
 * ux-gen only when the conceptPlan says so) is owned by the Concept Reducer (E3),
 * never here.
 *
 * Template mirrors `bmad/bmm/workflows/2-plan-workflows/create-ux-design/instructions.md`.
 */
export function buildUxGenPrompt(args: {
  intent: string;
  boilerplateType: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  /** Inlined approved PRD sections the UX spec must stay consistent with. */
  priorArtifacts?: string;
}): string {
  return `You are the UX Designer (Sally). Produce ux-spec.md — the user-experience
contract the Architect and every UI story will be held to. Write it in ONE pass.
Do not ask questions; make defensible UX decisions from the PRD scope and state
your assumptions.

## Execution discipline (READ FIRST — it keeps you fast)
- ONE-SHOT document generation. Do NOT use TodoWrite and do NOT call ToolSearch —
  they are not available here; each attempt wastes a full model round-trip.
- You have everything you need below. Do NOT broadly Glob/Read the project. Do not
  greet or narrate — your FIRST action is emitting the document between the fences.

## Intent
${args.intent}

## Signals
- Boilerplate: ${args.boilerplateType}
- Rigor: ${args.rigor}
- Depth: ${args.depth}
${
  args.priorArtifacts
    ? `\n## Approved PRD (your UX MUST be consistent with this scope — cite it, never exceed it)\n${args.priorArtifacts}\n`
    : '\n## No PRD provided\nProduce a valid UX skeleton from the intent alone; keep it consistent with a reasonable MVP scope.\n'
}
## Rules
- Use ATX headings (\`## Section Title\`) for every section — each becomes a
  citable section id (the manifest anchors one per heading).
- Required sections (the BMAD UX template, in order):
  1. \`## UX Goals & Principles\`
  2. \`## Personas & Context\`
  3. \`## Information Architecture\` — the screen/route map.
  4. \`## Key User Journeys\` — the critical flows, step by step.
  5. \`## Screens & Components\` — the component inventory + per-screen layout.
  6. \`## Interaction & State Model\` — states, transitions, empty/loading/error.
  7. \`## Visual Design & Theme\` — tokens, spacing, typography direction.
  8. \`## Accessibility\` — keyboard, focus, contrast, ARIA expectations.
  9. \`## Responsiveness & Edge Cases\` — breakpoints + degraded states.
- Stay within the PRD's MVP scope: do not invent features the PRD does not
  authorize. Where the PRD is silent, make the smallest reasonable choice.
- Be concrete: a UI story must be able to cite a section and build from it.

## Output — between the fences, the full markdown document, nothing else.
---UX_MD---
# UX Specification

## UX Goals & Principles
<...>
---END_UX_MD---`;
}
