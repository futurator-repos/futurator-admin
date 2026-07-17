/**
 * Agentic Document Center — E2.2 (W2): the deterministic routing layer.
 *
 * Zero-LLM. Given an artifact descriptor whose provenance is KNOWN, return the
 * single {realm, action} decision by rule — the routing matrix encoded as data,
 * not branches. Code-derived deltas (reality) and plan-intentions both route
 * here without an LLM call (the token law: deterministic-first). Only an
 * 'unknown' provenance returns null, escalating to the propose-only LLM
 * classifier (E2.3).
 *
 * The matrix (see the epic doc):
 *   code-wiki-change      → official    / merge-shard   (+ implies GOVERNS later)
 *   concept-arch-section  → concept     / edge-only PROPOSES
 *   plan-json|concept-*   → concept     / edge-only INFORMS
 *   reflection-proposal   → self-reflect/ edge-only INFORMS  (status: proposed)
 *   decision|claude-md    → decisions   / log-only   (merge handled by E6 doc)
 *   log|scorecard         → decisions   / log-only
 *   ast-facts|dependency  → system-graph/ edge-only (graph fuel)
 *   build-output|transient→ discard     / discard
 */
import type {
  DocAction,
  DocRealm,
  DocRouterDecision,
  ProvenanceKind,
} from '../schemas/doc-router-schema';
import { DocRouterDecisionSchema } from '../schemas/doc-router-schema';
import type { GodDocType } from '../types/docs';

/**
 * What the router needs to know about an artifact to classify it. Only the
 * fields relevant to a provenance are required; the matrix consumes them.
 */
export interface ArtifactDescriptor {
  /** Stable identifier (file path, node id, job id). */
  ref: string;
  provenance: ProvenanceKind;
  /** For 'code-wiki-change': the subsystem shard key the change lands in. */
  subsystemShardKey?: string;
  /** For 'concept-arch-section': the source docSection node + the shard it proposes. */
  conceptSection?: { docSectionNodeId: string; targetShardKey: string };
  /** For 'plan-json'/'concept-plan-json'/'reflection-proposal': the source node. */
  sourceNodeId?: string;
  /** For 'reflection-proposal': the shard the reflection informs (optional). */
  reflectionTargetShardKey?: string;
}

interface MatrixRule {
  realm: DocRealm;
  action: DocAction;
  /** Build target/edge/status from the descriptor; throws if a required field is absent. */
  fill?: (d: ArtifactDescriptor) => Partial<DocRouterDecision>;
  reason: string;
}

function requireField<T>(value: T | undefined, msg: string): T {
  if (value === undefined || value === null) throw new Error(msg);
  return value;
}

const MATRIX: Partial<Record<ProvenanceKind, MatrixRule>> = {
  'code-wiki-change': {
    realm: 'official',
    action: 'merge-shard',
    reason: 'shipped code changed — the official god doc reacts and merges the affected shard',
    fill: (d) => ({
      target: {
        docType: 'architecture' as GodDocType,
        shardKey: requireField(d.subsystemShardKey, 'code-wiki-change requires subsystemShardKey'),
      },
    }),
  },
  'concept-arch-section': {
    realm: 'concept',
    action: 'edge-only',
    reason: "a plan's concept architecture is an intention — PROPOSES the shard, never merged",
    fill: (d) => {
      const cs = requireField(d.conceptSection, 'concept-arch-section requires conceptSection');
      return { edge: { type: 'PROPOSES', from: cs.docSectionNodeId, to: cs.targetShardKey } };
    },
  },
  'plan-json': {
    realm: 'concept',
    action: 'edge-only',
    reason: 'plan breakdown informs the god docs but is never merged',
    fill: (d) => ({
      edge: {
        type: 'INFORMS',
        from: requireField(d.sourceNodeId, 'plan-json requires sourceNodeId'),
        to: 'doc/architecture',
      },
    }),
  },
  'concept-plan-json': {
    realm: 'concept',
    action: 'edge-only',
    reason: 'concept plan informs the god docs but is never merged',
    fill: (d) => ({
      edge: {
        type: 'INFORMS',
        from: requireField(d.sourceNodeId, 'concept-plan-json requires sourceNodeId'),
        to: 'doc/architecture',
      },
    }),
  },
  'reflection-proposal': {
    realm: 'self-reflection',
    action: 'edge-only',
    reason: 'reflection informs the relevant shard but is operator-gated — never auto-merged',
    fill: (d) => ({
      edge: {
        type: 'INFORMS',
        from: requireField(d.sourceNodeId, 'reflection-proposal requires sourceNodeId'),
        to: d.reflectionTargetShardKey ?? 'doc/architecture',
      },
      status: 'proposed' as const,
    }),
  },
  'decision-record': {
    realm: 'decisions',
    action: 'log-only',
    reason: 'decision record is recorded in the decisions realm',
  },
  'claude-md-append': {
    realm: 'decisions',
    action: 'log-only',
    reason: 'CLAUDE.md AC append is recorded, not merged into a god doc',
  },
  log: { realm: 'decisions', action: 'log-only', reason: 'audit trail — recorded only' },
  scorecard: {
    realm: 'decisions',
    action: 'log-only',
    reason: 'retrospect scorecard — recorded only',
  },
  'ast-facts': {
    realm: 'system-graph',
    action: 'edge-only',
    reason: 'AST facts feed the system graph, not a doc',
    fill: (d) => ({
      edge: { type: 'DERIVED_FROM', from: d.ref, to: d.sourceNodeId ?? 'system-graph' },
    }),
  },
  'dependency-map': {
    realm: 'system-graph',
    action: 'edge-only',
    reason: 'dependency map feeds the system graph, not a doc',
    fill: (d) => ({
      edge: { type: 'DERIVED_FROM', from: d.ref, to: d.sourceNodeId ?? 'system-graph' },
    }),
  },
  'build-output': {
    realm: 'discard',
    action: 'discard',
    reason: 'transient build output — discarded',
  },
  transient: { realm: 'discard', action: 'discard', reason: 'intermediate/superseded — discarded' },
};

/**
 * Deterministically route a KNOWN artifact. Returns null for 'unknown'
 * provenance (escalate to the LLM classifier). Throws only if a rule's required
 * descriptor field is missing — a programming error, not an ambiguous input.
 */
export function routeDeterministic(d: ArtifactDescriptor): DocRouterDecision | null {
  const rule = MATRIX[d.provenance];
  if (!rule) return null; // 'unknown' or unmapped → escalate
  const base = {
    artifactRef: d.ref,
    provenance: d.provenance,
    realm: rule.realm,
    action: rule.action,
    reason: rule.reason,
    ...(rule.fill ? rule.fill(d) : {}),
  };
  // Validate through the schema so target/edge invariants hold at the source.
  const parsed = DocRouterDecisionSchema.parse(base);
  return parsed;
}
