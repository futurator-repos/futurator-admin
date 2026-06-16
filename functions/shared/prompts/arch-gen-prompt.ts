import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';

/**
 * Concept v2 (E7.4, §7) — the Architecture artifact prompt (Architect/Winston).
 *
 * Produces `architecture.md` — the multi-agent consistency contract that stories
 * cite via `references[].source:'architecture'`. Emits ATX headings so the
 * section-manifest generator (E4.1) can anchor each section. For UI-bearing
 * plans it consumes the approved UX spec (serial PRD→UX→Arch ordering, D5).
 *
 * E7.5 (graph grounding) layers a `<ground_truth>` block of real graph structure
 * into `priorArtifacts` for `change` plans — wired daemon-side via Mycelium-MCP;
 * this builder just renders whatever grounding context it is handed.
 */
export function buildArchGenPrompt(args: {
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  uiBearing: boolean;
  /** Inlined PRD (+ UX when uiBearing) sections the architecture must stay consistent with. */
  priorArtifacts?: string;
  /** E7.5 — real structural facts from the system graph (brownfield); empty when cold/greenfield. */
  groundTruth?: string;
}): string {
  return `You are the Architect (Winston). Produce architecture.md — the contract
every developer story will be held to. It must be consistent with the PRD${
    args.uiBearing ? ' and the UX spec' : ''
  } provided below; cite their decisions, never contradict them.

## Intent
${args.intent}

## Rigor / depth
${args.rigor} — write a ${args.depth} architecture (lite = key decisions only;
full = components, state model, data contracts, error handling, NFRs).

${args.priorArtifacts ? `## Prior artifacts (stay consistent with these)\n${args.priorArtifacts}\n` : ''}${
    args.groundTruth
      ? `## Ground truth — real structure from the system graph (do not contradict)\n${args.groundTruth}\n`
      : ''
  }
## Rules
- Use ATX headings (\`## Section Title\`) for every section — they become the
  citable section ids (the manifest anchors each one).
- Name real components, state shapes, data contracts, and error strategy.
- ${args.uiBearing ? 'Match the UX spec’s component/state/routing decisions.' : 'No UI — focus on services, data, and integration boundaries.'}
- No prose hand-waving: every section should be something a story can cite.

## Output — between the fences, the full markdown document, nothing else.
---ARCHITECTURE_MD---
# Architecture

## Overview
<...>
---END_ARCHITECTURE_MD---`;
}
