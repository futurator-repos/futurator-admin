import { z } from 'zod';

/**
 * External pipeline-dispatch schema — the machine-callable "intent/seal →
 * running Pipeline-3 plan" fast path (reached by an external `x-queue-key`
 * caller instead of the operator JWT). Parse with `.safeParse()` at the call
 * site (queue-request-schema style).
 *
 * Two caller shapes, both valid:
 *   • Simple:   { source, intent }                    — throwaway app, no dedup.
 *   • Mycelium: { source, app, seal, git? }           — identity-aware:
 *       - `app.ref`     stable external app id → a deterministic Futurator app
 *                       (first seal scaffolds it "greenfield"; later seals
 *                       iterate the same app).
 *       - `seal.id` (+ `version`) → a deterministic run id → idempotency: a
 *                       re-sent same seal+version returns the SAME run; a new
 *                       version starts a NEW run (re-develop).
 *       - `seal.document` is the converged/approved plan the concept stage
 *                       transforms into StoryNodes (replaces bare `intent`).
 *       - `git`         provenance only in v1 (repoUrl/branch/commit recorded +
 *                       echoed; brownfield-clone against it is a later phase).
 *       - `dependsOn` / `priorPlan` — OPTIONAL, ADVISORY ONLY (C4). Opaque
 *                       prior seal ids / runIds (or a structured
 *                       `{sealId, version}` resolved the same deterministic
 *                       way as idempotency). Stamped into `sealProvenance`
 *                       and echoed on the status endpoint; Futurator never
 *                       relies on it for correctness — the same-app
 *                       precedence check at the dispatch frontier is the
 *                       sole authoritative ordering gate.
 */

const appIdentitySchema = z.object({
  /** Caller's STABLE app identifier — the key that maps to a Futurator app. */
  ref: z.string().min(1, 'app.ref is required'),
  /** Human label; used to make the app slug readable on first (greenfield) create. */
  name: z.string().optional(),
});

const sealSchema = z.object({
  /** Idempotency key — one (sealId, version) = one dev run. */
  id: z.string().min(1, 'seal.id is required'),
  /** Caller's version string (e.g. 'v1.01.203'). New version → new run. */
  version: z.string().optional(),
  /** The converged/approved plan contract the concept stage transforms. */
  document: z.string().min(3, 'seal.document must be at least 3 chars'),
});

const gitProvenanceSchema = z.object({
  repoUrl: z.string().url('git.repoUrl must be a valid URL').optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
});

/**
 * C4 — optional structured predecessor reference: a prior (sealId, version)
 * pair. Resolved server-side via the SAME deterministic `deriveRunId(source,
 * sealId, version)` used for idempotency, so a named predecessor maps to a
 * runId without Mycelium keeping a mapping table.
 */
const priorPlanSchema = z.object({
  sealId: z.string().min(1, 'priorPlan.sealId is required'),
  version: z.string().optional(),
});

export const dispatchPipelineSchema = z
  .object({
    /** Calling app/system id (stamped into `createdBy` + provenance). */
    source: z.string().min(1, 'source is required'),
    /** Optional app identity — absent = throwaway greenfield app (simple path). */
    app: appIdentitySchema.optional(),
    /** Optional seal — absent = no idempotency dedup (simple path). */
    seal: sealSchema.optional(),
    /** Simple-path work item (used when `seal` is absent). */
    intent: z.string().min(3, 'intent must be at least 3 chars').optional(),
    /** Optional git provenance (recorded + echoed; not cloned in v1). */
    git: gitProvenanceSchema.optional(),
    /** Optional display label (simple path). */
    name: z.string().optional(),
    /**
     * Optional caller-declared scaffold template for a GREENFIELD dispatch (a
     * boilerplate-registry key, e.g. `'nextjs-base'`). Honored verbatim when it
     * names a known template; otherwise the service falls back to the NEUTRAL
     * base (`'nextjs-base'`). Absent = neutral base. The dispatch surface never
     * infers a template from the NL intent (that is a deferred enhancement, O-8)
     * and never forces a domain-specific (e.g. game) scaffold.
     */
    boilerplateType: z.string().min(1).optional(),
    /**
     * C4 — OPTIONAL, ADVISORY ONLY. Opaque prior seal ids / runIds that this
     * dispatch's caller considers predecessors. Futurator stamps and echoes
     * these verbatim; it never interprets their content and never uses them
     * to gate admission or frontier scheduling — the same-app precedence
     * check at the frontier (C1) is the sole AUTHORITATIVE ordering
     * mechanism. This field exists so a caller with CROSS-APP ordering
     * knowledge (which C1's same-app check can't see) can express it and
     * have Futurator round-trip it for correlation.
     */
    dependsOn: z.array(z.string().min(1)).optional(),
    /**
     * C4 — OPTIONAL, ADVISORY ONLY. A single structured predecessor
     * reference, resolved to a runId and folded into the stamped
     * `dependsOn` list (see `priorPlanSchema`). Same non-authoritative
     * caveat as `dependsOn`.
     */
    priorPlan: priorPlanSchema.optional(),
  })
  .refine((v) => Boolean(v.seal?.document) || Boolean(v.intent), {
    message: 'Either seal.document or intent is required',
  });

export type DispatchPipelineInput = z.infer<typeof dispatchPipelineSchema>;
