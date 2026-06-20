import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';

/**
 * Concept v2 (E2 / Story 2.3) — the Architecture generator prompt (Architect /
 * Winston persona).
 *
 * Produces `architecture.md` — the multi-agent CONSISTENCY CONTRACT that kills
 * parallel-wave drift: every developer story cites it via
 * `references[].source:'architecture'`, so its sections must be concrete enough
 * to build from. The load-bearing anti-drift surface is the Implementation
 * Patterns section covering the 7 categories (naming / structure / format /
 * communication / lifecycle / location / consistency) — when these are pinned,
 * agents working different waves converge instead of diverging.
 *
 * Depth scales by the conceptPlan artifact depth (derived from rigor):
 *   - lite  (non-production) → Decision Summary Table + key patterns only
 *     (aggressively trimmed to stay citable + within the ~400KB variable cap)
 *   - full  (production)     → all sections (Project Structure, Epic Mapping,
 *     Tech Stack, Consistency Rules, Data Architecture, API Contracts)
 *
 * For UI-bearing plans it consumes the approved UX spec (serial PRD→UX→Arch).
 * For `change` plans, a `<ground_truth>` block of real system-graph structure is
 * injected (Story 2.5) — the prompt forbids contradicting it.
 *
 * Sections mirror `bmad/bmm/workflows/3-solutioning/architecture/instructions.md`
 * + `pattern-categories.csv`.
 */
export function buildArchGenPrompt(args: {
  intent: string;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  uiBearing: boolean;
  /** Inlined PRD (+ UX when uiBearing) sections the architecture must stay consistent with. */
  priorArtifacts?: string;
  /** Story 2.5 — real structural facts from the system graph (brownfield); empty when cold/greenfield. */
  groundTruth?: string;
}): string {
  const full = args.depth === 'full';
  return `You are the Architect (Winston). Produce architecture.md — the contract
every developer story will be held to. It must be consistent with the PRD${
    args.uiBearing ? ' and the UX spec' : ''
  } provided below; cite their decisions, never contradict them. Write it in ONE
pass — a complete, internally consistent document. State assumptions explicitly.

## Execution discipline (READ FIRST — it keeps you fast)
- ONE-SHOT document generation, not an interactive task. Do NOT use TodoWrite and
  do NOT call ToolSearch — they are not available here; each attempt wastes a full
  model round-trip (and is the #1 cause of slow runs).
- You already have the intent, prior artifacts, and (when present) the real
  codebase ground truth below. Do NOT broadly Glob/Read the project — read at most
  2–3 specific files only if a decision truly depends on them.
- Do not greet or narrate. Your FIRST action is emitting the document between the
  fences.

## Intent
${args.intent}

## Rigor / depth
${args.rigor} — write a ${args.depth} architecture (${
    full
      ? 'full = every section below, fully specified'
      : 'lite = Decision Summary Table + the key Implementation Patterns only; trim aggressively, omit exhaustive data/API detail'
  }).

## Length budget — HARD (a bloated architecture starves the planner downstream)
This document is INLINED verbatim into the planner's context, so length here is
not free — an over-long architecture pushes the plan generator past its output
cap and breaks plan generation. Keep the WHOLE document under **${full ? '~3500 words' : '~1800 words'}**.
It is a citable CONTRACT of concrete rules, not a textbook: prefer tables and
terse one-line rules over paragraphs. Do NOT restate the PRD/UX; reference their
decisions. No code samples longer than ~5 lines; no exhaustive enumerations.
${args.priorArtifacts ? `\n## Prior artifacts (stay consistent with these — cite, never contradict)\n${args.priorArtifacts}\n` : ''}${
    args.groundTruth
      ? `\n## Ground truth — real structure from the system graph (do NOT contradict; build on what exists)\n${args.groundTruth}\n`
      : ''
  }
## Rules
- Use ATX headings (\`## Section Title\`) for every section — each becomes a
  citable section id (the manifest anchors one per heading). A story cites by
  slug, so titles are load-bearing and must be stable.
- Required sections (in order):
  1. \`## Decision Summary Table\` — the key architectural decisions, one row
     each (decision · choice · rationale). The fastest thing a story can cite.
  2. \`## Implementation Patterns\` — the anti-drift core. Pin a concrete rule
     for EACH of the 7 categories so parallel waves converge:
     **naming** (files, symbols, routes), **structure** (folder/module layout),
     **format** (data/response shapes, serialization), **communication**
     (how modules/services talk — calls, events, props), **lifecycle**
     (init / mount / teardown / error-recovery order), **location** (where a
     given kind of code lives), **consistency** (shared invariants every story
     must uphold). Each category gets at least one explicit, citable rule.
${
  full
    ? `  3. \`## Project Structure\` — the directory tree + what lives where.
  4. \`## Tech Stack\` — the chosen libraries/frameworks and WHY.
  5. \`## Epic Mapping\` — how the planned epics map onto the structure.
  6. \`## Consistency Rules\` — cross-cutting invariants (auth, errors, state).
  7. \`## Data Architecture\` — entities, storage, schemas, ownership.
  8. \`## API Contracts\` — endpoints/interfaces, request/response shapes.\n`
    : `  (lite depth: omit Project Structure / Tech Stack / Epic Mapping / Data
     Architecture / API Contracts unless trivially short — keep the document
     citable and within budget.)\n`
}- ${args.uiBearing ? "Match the UX spec's component / state / routing model exactly — name the same screens, states, and components." : 'No UI — focus on services, data, and integration boundaries.'}
- Do NOT hardcode specific dependency versions (they rot). Say "latest stable
  <lib> <major>.x" and, when a current version genuinely matters, use WebSearch
  to verify the latest stable line rather than pinning a number from memory.
- No prose hand-waving: every section must be something a story can cite and a
  reviewer can check.

## Output — between the fences, the full markdown document, nothing else.
---ARCHITECTURE_MD---
# Architecture

## Decision Summary Table
| Decision | Choice | Rationale |
| --- | --- | --- |
| <...> | <...> | <...> |

## Implementation Patterns
<one citable rule per category: naming, structure, format, communication, lifecycle, location, consistency>
---END_ARCHITECTURE_MD---`;
}
