/**
 * instinct-repository — read-side surface for the Pipeline-3 instinct loop
 * (development-plan §5.5, Pillar 3) consumed by Labs3's Skills & Learnings tab.
 *
 * The instinct loop is, by design, daemon-local: the gate's `posttool-observe`
 * sibling appends `observations.jsonl` and the live gate appends
 * `gate-events.jsonl`, both under `<workingDir>/.pipeline/`; `instinct-distiller`
 * reduces observations into scored instincts and `instinct-promote` graduates
 * the high-confidence ones into Mycelium `Instinct` nodes. None of those JSONL
 * files or the Mycelium graph are reachable from this API Lambda today.
 *
 * This repository is therefore a GREENFIELD read seam: it owns the response
 * SHAPE (so the Labs3 panel renders against a stable contract) and returns
 * empty arrays until a durable, Lambda-reachable source (a plan-scoped DDB
 * mirror, an S3 rollup, or a Mycelium read endpoint) is wired in. The
 * `getPlanInstincts` function is the single extension point — fill its body
 * when that source lands; the route and the client never change.
 */

/** One raw deterministic observation (mirrors daemon posttool-observe rows). */
export interface InstinctObservation {
  at: string;
  session: string;
  role?: string;
  tool?: string;
  target?: string;
  exitOutcome?: 'ok' | 'fail';
  scopeViolation?: boolean;
  gateTier?: string;
  sha?: string;
}

/** A scored instinct distilled from recurring negative-signal observations. */
export interface DistilledInstinct {
  id: string;
  key?: string;
  role?: string;
  tool?: string;
  touchesGlob?: string;
  enforcement: 'advisory' | 'gate' | 'test';
  confidence: number;
  support: number;
  text: string;
  status?: 'candidate' | 'active' | 'promoted';
}

/** A high-confidence instinct graduated to a Mycelium `Instinct` node. */
export interface PromotedInstinct {
  id: string;
  text: string;
  role?: string;
  touchesGlob?: string;
  enforcement: 'advisory' | 'gate' | 'test';
  confidence: number;
  support: number;
  status: 'promoted';
  promotedAt?: string;
}

/** One live-gate decision (audit-mode would-block or enforce-mode block). */
export interface GateBlockEvent {
  at?: string;
  session?: string;
  decision: 'allow' | 'audit' | 'block' | 'fact-force' | 'fact-force-cleared';
  enforce?: boolean;
  reason?: string;
  target?: string;
  risk?: { tier?: string; factors?: string[]; score?: number };
}

/** The bundled instinct-loop feed for one plan. */
export interface InstinctFeed {
  observations: InstinctObservation[];
  distilled: DistilledInstinct[];
  promoted: PromotedInstinct[];
  gateBlocks: GateBlockEvent[];
}

/** An always-renderable empty feed. */
export function emptyInstinctFeed(): InstinctFeed {
  return { observations: [], distilled: [], promoted: [], gateBlocks: [] };
}

/**
 * The instinct-loop feed for a plan. Returns empty arrays until a durable,
 * Lambda-reachable source is wired (see file header). Never throws on a missing
 * source — the Skills & Learnings panel always renders.
 *
 * @param planId the plan whose instinct loop to surface (reserved for the
 *   future plan-scoped query; the seam already carries it so the route and
 *   client never change when a source is wired).
 */
export async function getPlanInstincts(planId: string): Promise<InstinctFeed> {
  // No durable source is reachable from the API Lambda yet. Surface an empty,
  // well-typed feed so Labs3's instinct panel renders rather than erroring.
  void planId;
  return emptyInstinctFeed();
}
