// model-router — pick the cheapest model that fits the work, WITHIN Max
// (development-plan §5.4, lever 9).
//
// This is a throughput/quality lever, not a per-token cost move: the operator
// stays on the Max subscription; routing just reserves Opus for the work that
// needs it (orchestrator + production-rigor review) and pushes trivial/mechanical
// work down to Haiku/Sonnet. The dev SUBAGENTS already route via their custom
// agent definitions (dev-trivial→Haiku, dev-standard→Sonnet, dev-architectural→
// Opus); this module covers the DAEMON-spawned roles where buildAgentConfig sets
// an explicit model.
//
// Model IDs are env-overridable so they never go stale in code — confirm current
// IDs via the claude-api skill at wire time (plan §10). Defaults below are the
// current family at authoring time.

export const DEFAULT_MODEL_IDS = Object.freeze({
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
});

export function resolveModelIds(env = process.env) {
  return {
    haiku: env.P3_MODEL_HAIKU || DEFAULT_MODEL_IDS.haiku,
    sonnet: env.P3_MODEL_SONNET || DEFAULT_MODEL_IDS.sonnet,
    opus: env.P3_MODEL_OPUS || DEFAULT_MODEL_IDS.opus,
  };
}

const HEAVY_CHARS = 10000;
const HEAVY_ITEMS = 30;

/**
 * Choose a model tier for a daemon-spawned role.
 *
 * Rules (plan §5.4):
 *   • orchestrator, or production-rigor REVIEW  → opus
 *   • complexity trivial                         → haiku
 *   • complexity medium/large, OR size signals over threshold (>10k chars /
 *     >30 items)                                 → sonnet
 *   • otherwise                                  → the caller's default (or sonnet)
 *
 * Routing is OFF by default: when not opted in (P3_MODEL_ROUTING !== 'on') the
 * caller's `defaultModel` is returned unchanged, so legacy behavior is preserved.
 *
 * @param {{
 *   role?: string, complexity?: string, rigor?: string,
 *   chars?: number, items?: number, defaultModel?: string,
 *   env?: Record<string,string>,
 * }} args
 * @returns {string|undefined} the chosen model id (undefined ⇒ CLI default)
 */
export function selectModel({ role, complexity, rigor, chars = 0, items = 0, defaultModel, env = process.env } = {}) {
  if ((env.P3_MODEL_ROUTING || 'off') !== 'on') return defaultModel;

  const ids = resolveModelIds(env);
  const r = String(role || '').toLowerCase();
  const c = String(complexity || '').toLowerCase();

  if (r.includes('orchestrat')) return ids.opus;
  if (r.includes('review') && rigor === 'production') return ids.opus;

  if (c === 'trivial') return ids.haiku;

  const heavy = c === 'medium' || c === 'large' || c === 'standard' || c === 'complex' ||
    c === 'architectural' || chars > HEAVY_CHARS || items > HEAVY_ITEMS;
  if (heavy) return ids.sonnet;

  return defaultModel ?? ids.sonnet;
}
