/**
 * Agentic Document Center — the "god doc" type set.
 *
 * Unblocks the in-flight doc-router workstream (E2.1/E2.2): both
 * `functions/shared/schemas/doc-router-schema.ts` (ShardTarget.docType enum)
 * and `functions/shared/services/doc-router.ts` (the routing matrix's
 * `merge-shard` target) depend on this module. Kept as its own root type file
 * so the schema, the router service, and the arch-shard compile pipeline all
 * import ONE canonical list rather than re-declaring it.
 *
 * A "god doc" is one of the persistent, codebase-reactive official documents
 * that reality (shipped code) MERGES into via a shard. Today the router only
 * merges into `architecture`; `decisions` and `index` are declared now so the
 * decision-record realm (E6) and the knowledge index can adopt the same
 * shard-merge contract without a schema break.
 */

/** The official god-doc kinds a routed artifact may target. */
export const GOD_DOC_TYPES = ['architecture', 'decisions', 'index'] as const;

/** Union of the god-doc kinds — the type a `merge-shard` decision targets. */
export type GodDocType = (typeof GOD_DOC_TYPES)[number];
