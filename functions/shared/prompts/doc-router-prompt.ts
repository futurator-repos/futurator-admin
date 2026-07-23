/**
 * Agentic Document Center — E2.3 (W2): the propose-only LLM classifier prompt.
 *
 * Used ONLY when `routeDeterministic` returned null (an artifact of 'unknown'
 * provenance — novel prose the rule layer can't classify). The agent emits a
 * PROPOSED DocRouterDecision the operator approves before it is acted on — the
 * Reflector governance pattern. It never auto-merges.
 */

export interface DocRouterPromptArgs {
  /** The artifact being classified — path + a content excerpt. */
  artifactRef: string;
  artifactExcerpt: string;
  /** The god docs that exist for this app (so it can target a real one). */
  knownDocTypes: string[];
}

export const DOC_ROUTER_DECISION_START = '---DOC_ROUTER_DECISION---';
export const DOC_ROUTER_DECISION_END = '---END_DOC_ROUTER_DECISION---';

export function buildDocRouterPrompt(args: DocRouterPromptArgs): string {
  return `You are the Doc Router for an agentic document center. Classify ONE artifact
into a realm and exactly one action. You are PROPOSE-ONLY: your decision is
reviewed by an operator before anything happens. Never assume it is applied.

THE ORGANIZING PRINCIPLE — provenance decides routing:
- Reality (what the app IS, shipped code) MERGES into a god-doc shard.
- A plan-INTENTION only PROPOSES (a graph edge), never merges.
- Audit trails are RECORDED (log-only).
- Transient / superseded noise is DISCARDED.

THE FOUR ACTIONS (closed set — use exactly one):
- "merge-shard"  → requires target {docType, shardKey}. Only for verified reality.
- "edge-only"    → requires edge {type: PROPOSES|INFORMS|GOVERNS|DERIVED_FROM, from, to}.
- "log-only"     → recorded, no doc change, no edge.
- "discard"      → dropped.

REALMS: official | concept | self-reflection | decisions | system-graph | discard

Known god-doc types for this app: ${args.knownDocTypes.join(', ') || '(none yet)'}

DEFAULT TO CAUTION: if you are unsure whether something is reality vs intention,
prefer "edge-only" (PROPOSES) or "log-only" over "merge-shard". Merging the wrong
thing into an official doc is the worst outcome.

ARTIFACT
  ref: ${args.artifactRef}
  excerpt:
${args.artifactExcerpt}

Emit ONE decision as JSON between the markers, nothing else:
${DOC_ROUTER_DECISION_START}
{
  "artifactRef": "${args.artifactRef}",
  "provenance": "unknown",
  "realm": "...",
  "action": "...",
  "target": { "docType": "...", "shardKey": "..." },   // omit unless merge-shard
  "edge": { "type": "...", "from": "...", "to": "..." }, // omit unless edge-only
  "reason": "one sentence",
  "status": "proposed"
}
${DOC_ROUTER_DECISION_END}`;
}
