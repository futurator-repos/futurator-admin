/**
 * Agentic Document Center — E2.1 (W2): the Doc Router decision contract.
 *
 * The router is the one new brain: every generated artifact passes through it
 * and gets a validated {realm, action} over FOUR closed actions. The organizing
 * principle of the whole center lives here — provenance decides routing:
 *   - reality (shipped code) MERGES into a god-doc shard      → 'merge-shard'
 *   - a plan-intention only PROPOSES / INFORMS                → 'edge-only'
 *   - audit trails RECORD                                     → 'log-only'
 *   - transient/superseded noise is dropped                   → 'discard'
 *
 * Shaped like the Reflector's ReflectionProposal: a Zod schema validated at the
 * boundary so a malformed decision is rejected, never applied. See
 * `docs/concepts/pipeline-v3/agentic-document-center-epics.md` E2.
 */
import { z } from 'zod';
import { GOD_DOC_TYPES } from '../types/docs';

/** Which realm an artifact belongs to. */
export const DOC_REALMS = [
  'official', // god docs — the persistent sink
  'concept', // plan-intentions — propose only
  'self-reflection', // Reflector proposals — operator-gated
  'decisions', // ADRs / decision records / CLAUDE.md
  'system-graph', // facts that feed the graph, not a doc
  'discard', // transient / superseded
] as const;
export type DocRealm = (typeof DOC_REALMS)[number];

/** The four — and only four — actions the router may emit. */
export const DOC_ACTIONS = ['merge-shard', 'edge-only', 'log-only', 'discard'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

/**
 * The known provenance kinds the deterministic layer recognizes. Anything else
 * is 'unknown' and escalates to the propose-only LLM classifier (E2.3).
 */
export const PROVENANCE_KINDS = [
  'code-wiki-change', // a knowledge/code/*.md changed → reality
  'concept-arch-section', // a plan's concept architecture.md section → intention
  'plan-json', // PLAN_JSON epic/story breakdown → intention
  'concept-plan-json', // CONCEPT_PLAN_JSON → intention
  'reflection-proposal', // Reflector output → self-reflection
  'decision-record', // an ADR / decision doc → decisions
  'claude-md-append', // a CLAUDE.md AC append → decisions
  'log', // log.md / commit / screenshot / vqa-observations
  'ast-facts', // AST_FACTS → graph fuel
  'dependency-map', // dependency-map → graph fuel
  'scorecard', // retrospect scorecard → log
  'build-output', // transient build artifact
  'transient', // intermediate variable / superseded dup
  'unknown', // escalate to LLM
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** A shard target — required when action is 'merge-shard'. */
export const ShardTargetSchema = z.object({
  docType: z.enum(GOD_DOC_TYPES as unknown as [string, ...string[]]),
  shardKey: z.string().min(1),
});
export type ShardTarget = z.infer<typeof ShardTargetSchema>;

/** A graph edge — required when action is 'edge-only'. */
export const DecisionEdgeSchema = z.object({
  type: z.enum(['PROPOSES', 'INFORMS', 'GOVERNS', 'DERIVED_FROM']),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type DecisionEdge = z.infer<typeof DecisionEdgeSchema>;

export const DocRouterDecisionSchema = z
  .object({
    /** Stable identifier of the artifact being routed. */
    artifactRef: z.string().min(1),
    provenance: z.enum(PROVENANCE_KINDS),
    realm: z.enum(DOC_REALMS),
    action: z.enum(DOC_ACTIONS),
    target: ShardTargetSchema.optional(),
    edge: DecisionEdgeSchema.optional(),
    reason: z.string().min(1),
    /**
     * 'applied' — a deterministic, auto-actionable decision.
     * 'proposed' — operator-gated (LLM-classified ambiguous prose, or the
     *   self-reflection realm); NEVER acted on until approved.
     */
    status: z.enum(['applied', 'proposed']).default('applied'),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'merge-shard' && !d.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action 'merge-shard' requires a target {docType, shardKey}",
        path: ['target'],
      });
    }
    if (d.action === 'edge-only' && !d.edge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "action 'edge-only' requires an edge {type, from, to}",
        path: ['edge'],
      });
    }
  });
export type DocRouterDecision = z.infer<typeof DocRouterDecisionSchema>;

/** Validate a decision (e.g. an LLM-emitted one) at the boundary. */
export function validateDecision(
  raw: unknown,
): { ok: true; decision: DocRouterDecision } | { ok: false; error: string } {
  const result = DocRouterDecisionSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || '<root>';
    return { ok: false, error: `${path}: ${issue?.message ?? 'invalid decision'}` };
  }
  return { ok: true, decision: result.data };
}
