import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth, ConceptArtifactKind } from '../concept/concept-plan';
import {
  TEMPLATE_OUTPUT_START,
  TEMPLATE_OUTPUT_END,
  DECISION_CARD_START,
  DECISION_CARD_END,
  CONVERGENCE_CHECKPOINT,
} from './concept-markers';

/**
 * Concept v2 (E4 / Story 4.1a) — the INTERACTIVE convergence prompt builders.
 *
 * Distinct from the E2 autopilot one-shot builders (`build{Prd,Ux,Arch}GenPrompt`).
 * Those emit a finished doc in one turn with NO halt. THESE seed a free-agent
 * convergence session: the persona drafts section-by-section, HALTS at each
 * major decision to present a methodologically-grounded option menu (a distilled
 * subset of BMAD's adv-elicit methods, inlined here because the free-agent
 * substrate is a raw CLI with no BMAD workflow engine), incorporates the
 * operator's choice/free-text, and emits a parseable checkpoint when the whole
 * document has converged.
 *
 * The mode branch (Story 4.1/4.2) selects: interactive → these builders;
 * autopilot → the E2 one-shot builders.
 */

// A distilled, inlined subset of `bmad/core/tasks/adv-elicit-methods.csv` — the
// elicitation method menu the agent draws from at each halt. Kept small + stable
// (the substance, not the full BMAD registry).
const ELICIT_METHODS = [
  'Expand or Contract — widen or narrow the scope of this decision',
  'Critique and Refine — argue the weakest part of the current draft, then improve it',
  'Identify Risks — surface the top risks this choice introduces',
  'Tree of Thought — lay out 2–3 distinct approaches and their trade-offs',
  'Stakeholder Round Table — voice the concerns of user / engineer / operator',
  'Challenge Assumptions — name an implicit assumption and test it',
];

function header(args: {
  persona: string;
  artifactNoun: string;
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  priorArtifacts?: string;
}): string {
  return `You are ${args.persona}. Converge with the operator on ${args.artifactNoun}
through a guided, section-by-section conversation — NOT a wall of prose. This is
spec convergence at PLANNING time.

## Intent
${args.intent}

## Rigor / depth
${args.rigor} — ${args.depth}.
${args.priorArtifacts ? `\n## Approved upstream (stay consistent — cite, never contradict)\n${args.priorArtifacts}\n` : ''}
## How to converge (the elicit → converge protocol)
1. Draft ONE major section at a time.
2. At each meaningful fork, HALT and present a decision card — a NUMBERED menu of
   methodologically-grounded options, drawn from these elicitation methods:
${ELICIT_METHODS.map((m, i) => `   ${i + 1}. ${m}`).join('\n')}
   Emit the card between the markers, exactly:
   ${DECISION_CARD_START}
   <a short title for the decision>
   1. <option> — <one-line consequence>
   2. <option> — <one-line consequence>
   3. <option> — <one-line consequence>
   ${DECISION_CARD_END}
3. Incorporate the operator's selection or free-text reply, then continue.
4. When a section is finalized, emit it between:
   ${TEMPLATE_OUTPUT_START}
   <the finalized section markdown, with an ATX \`## Heading\`>
   ${TEMPLATE_OUTPUT_END}
5. When the ENTIRE document has converged (every required section finalized),
   emit the full document once more inside a single ${TEMPLATE_OUTPUT_START} …
   ${TEMPLATE_OUTPUT_END} block, then on its own line emit EXACTLY:
   ${CONVERGENCE_CHECKPOINT}
   Do not emit the checkpoint until the operator's open questions are resolved —
   it unlocks the Approve button.

## Rules
- ATX headings (\`## Title\`) for every section — they become citable anchors.
- Be concrete and testable; the operator must be able to Approve a real spec.
- Ask, don't assume, when a decision materially shapes the product.`;
}

export function buildPrdConvergencePrompt(args: {
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  priorArtifacts?: string;
}): string {
  const full = args.depth === 'full';
  return `${header({ persona: 'the Product Manager (John)', artifactNoun: 'the PRD (prd.md)', ...args })}

## Required sections (converge through each in order)
- Description, Goals, Scope (MVP → Growth → Vision), Functional Requirements${
    full ? ', Non-Functional Requirements, Domain Requirements' : ''
  }.`;
}

export function buildUxConvergencePrompt(args: {
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  priorArtifacts?: string;
}): string {
  return `${header({ persona: 'the UX Designer (Sally)', artifactNoun: 'the UX spec (ux-spec.md)', ...args })}

## Required sections (the BMAD UX template)
- UX Goals & Principles, Personas & Context, Information Architecture
- Key User Journeys, Screens & Components, Interaction & State Model
- Visual Design & Theme, Accessibility, Responsiveness & Edge Cases.`;
}

export function buildArchConvergencePrompt(args: {
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  uiBearing: boolean;
  priorArtifacts?: string;
}): string {
  const full = args.depth === 'full';
  return `${header({ persona: 'the Architect (Winston)', artifactNoun: 'the architecture (architecture.md)', ...args })}

## Required sections (converge through each in order)
- Decision Summary Table, Implementation Patterns (the 7 categories: naming,
  structure, format, communication, lifecycle, location, consistency)${
    full
      ? ', Project Structure, Tech Stack, Epic Mapping, Consistency Rules, Data Architecture, API Contracts'
      : ''
  }.
- ${args.uiBearing ? 'Match the UX component / state / routing model exactly.' : 'No UI — services, data, integration boundaries.'}
- Do NOT hardcode dependency versions; say "latest stable X major.x" (WebSearch to verify).`;
}

/** Select the convergence builder for a kind (the interactive mode branch). */
export function buildConvergencePrompt(
  kind: ConceptArtifactKind,
  args: {
    intent: string;
    rigor: PlanRigor;
    depth: ConceptArtifactDepth;
    uiBearing: boolean;
    priorArtifacts?: string;
  },
): string {
  if (kind === 'prd') return buildPrdConvergencePrompt(args);
  if (kind === 'ux') return buildUxConvergencePrompt(args);
  return buildArchConvergencePrompt(args);
}
