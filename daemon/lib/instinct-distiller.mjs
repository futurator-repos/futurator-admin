// instinct-distiller — turn raw gate/tool observations into scored instincts
// (development-plan §5.5, Pillar 3). PURE frequency reducer.
//
// The deterministic alternative to the IAM-blocked reflector: instead of an LLM
// authoring privileged CLAUDE.md/skill mutations, we observe what the live gate
// and tools actually did (scope violations, blocks, fails) and distill the
// recurring patterns into "instincts" — data the next spawn reads, not repo
// writes. Confidence grows with support (recurrence); an instinct graduates from
// advisory → gate → test as confidence and a human/operator promote it.

const SUPPORT_FOR_FULL_CONFIDENCE = 5;

/** Stable grouping key for an observation: what went wrong, where, for whom. */
function observationKey(o) {
  const target = pathPattern(o.target);
  // W4.3 — a TDD signal discriminates the group so tamper/redFirst/coverage/
  // mutation don't collapse into one 'n/a' bucket.
  const signal =
    (o.tamper && 'tamper') || (o.redFirstFail && 'redFirst') || (o.coverageGap && 'covGap') ||
    (o.mutationSurvivor && 'mutation') || o.exitOutcome || o.gateTier || 'n/a';
  return [o.role || 'any', o.tool || 'any', signal, target].join('|');
}

/** Generalize a concrete path to a coarse glob so instincts aren't per-file. */
export function pathPattern(target) {
  if (!target || typeof target !== 'string') return '*';
  const segs = target.split('/').filter(Boolean);
  if (segs.length <= 1) return target || '*';
  return `${segs.slice(0, 2).join('/')}/**`;
}

/** Human-readable instinct text for a grouped pattern. */
function describe(sample, support) {
  const where = pathPattern(sample.target);
  if (sample.scopeViolation) return `Edits to ${where} repeatedly fell outside story scope (${support}×) — confirm ${where} is in touches before writing.`;
  // W4.3 — TDD-gate telemetry patterns.
  if (sample.tamper) return `The implementer tried to edit authored tests on ${where} (${support}×) — implement to green; never touch the tests.`;
  if (sample.redFirstFail) return `Authored tests on ${where} passed before implementation (${support}×) — write a genuinely failing (RED) test first.`;
  if (sample.coverageGap) return `ACs on ${where} shipped without a covering test (${support}×) — bind every AC to a real test.`;
  if (sample.mutationSurvivor) return `Tests on ${where} missed injected mutations (${support}×) — assert behavior, not just execution.`;
  if (sample.gateTier === 'block' || sample.exitOutcome === 'blocked') return `${sample.tool} on ${where} was blocked ${support}× — treat as high-risk; state callers/rollback first.`;
  if (sample.exitOutcome === 'fail') return `${sample.tool} on ${where} failed ${support}× — check the failing test before re-attempting.`;
  return `Recurring pattern on ${where} (${support}×).`;
}

/**
 * Distill observations into candidate instincts. Only NEGATIVE-signal groups
 * (scope violations, blocks, fails) with support ≥ minSupport become candidates —
 * we don't mint instincts from routine success.
 *
 * @param {Array<object>} observations
 * @param {{ minSupport?: number }} opts
 * @returns {Array<{ id, key, role, tool, touchesGlob, enforcement, confidence, support, text, sample }>}
 */
export function distill(observations = [], { minSupport = 2 } = {}) {
  const groups = new Map();
  for (const o of observations) {
    const negative = o.scopeViolation || o.gateTier === 'block' || o.exitOutcome === 'blocked' || o.exitOutcome === 'fail'
      || o.tamper || o.redFirstFail || o.coverageGap || o.mutationSurvivor;
    if (!negative) continue;
    const key = observationKey(o);
    const g = groups.get(key) || { support: 0, sample: o };
    g.support += 1;
    groups.set(key, g);
  }
  const out = [];
  for (const [key, g] of groups) {
    if (g.support < minSupport) continue;
    const confidence = Math.min(1, Math.round((g.support / SUPPORT_FOR_FULL_CONFIDENCE) * 100) / 100);
    out.push({
      id: `instinct:${key}`,
      key,
      role: g.sample.role || null,
      tool: g.sample.tool || null,
      touchesGlob: pathPattern(g.sample.target),
      enforcement: 'advisory', // graduates later via promote
      confidence,
      support: g.support,
      text: describe(g.sample, g.support),
      sample: g.sample,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || b.support - a.support);
}
