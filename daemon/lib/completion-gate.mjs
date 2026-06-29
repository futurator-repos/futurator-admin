// completion-gate — bound-AC deterministic completion (development-plan §5.5, Pillar 1).
//
// "Done" stops being a subjective reviewer verdict and becomes a pure function of
// the graph: a deterministic AC passes iff its bound test is `passing` AND was run
// against the current head SHA (the staleness guard). The reviewer is still
// spawned but ADVISORY — only `advisory-security` can block; `advisory-taste`
// failures become an operator note, never a retry. This kills the reviewer
// triple-fails.
//
// Also hosts the `<BINDING>` manifest parser: the agent emits acId→testRef at
// write time (mirrors how touch-point-inference parses <INFERENCE>), flipping ACs
// unbound→bound; the Verify stage runs them and flips passing/failing.

const BINDING_RE = /<BINDING>([\s\S]*?)<\/BINDING>/i;

/**
 * Parse a `<BINDING>` manifest out of agent output. Tolerant: accepts the JSON
 * object inside the tags, or a bare JSON object, or fenced JSON. Returns
 * `{ [acId]: { testRef, testKind } }` (empty when absent/unparseable).
 */
export function parseBindingManifest(text) {
  if (typeof text !== 'string') return {};
  const m = BINDING_RE.exec(text);
  const body = (m ? m[1] : text)
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();
  const tryParse = (s) => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : null; } catch { return null; } };
  let obj = tryParse(body);
  if (!obj) {
    const brace = /\{[\s\S]*\}/.exec(body);
    if (brace) obj = tryParse(brace[0]);
  }
  if (!obj) return {};
  const out = {};
  for (const [acId, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[acId] = { testRef: v };
    else if (v && typeof v === 'object') out[acId] = { testRef: v.testRef || v.test || '', testKind: v.testKind || v.kind };
  }
  return out;
}

/** Partition ACs by class. `manual` ACs (verify:'manual') are split out. */
export function classifyAcs(acs = []) {
  const buckets = { deterministic: [], advisoryTaste: [], advisorySecurity: [], manual: [] };
  for (const ac of acs) {
    if (ac.verify === 'manual' || ac.testBinding?.testKind === 'manual') { buckets.manual.push(ac); continue; }
    const cls = ac.acClass || 'deterministic';
    if (cls === 'advisory-security') buckets.advisorySecurity.push(ac);
    else if (cls === 'advisory-taste') buckets.advisoryTaste.push(ac);
    else buckets.deterministic.push(ac);
  }
  return buckets;
}

/** Immutably bind an AC: set testBinding.status='bound' with the manifest's testRef. */
export function bindAc(ac, binding) {
  if (!binding || !binding.testRef) return ac;
  return {
    ...ac,
    testBinding: { ...(ac.testBinding || {}), status: 'bound', testRef: binding.testRef, testKind: binding.testKind || ac.testBinding?.testKind },
  };
}

/** Apply a parsed binding manifest to a list of ACs (immutable). */
export function applyBindings(acs = [], manifest = {}) {
  return acs.map((ac) => (manifest[ac.id] ? bindAc(ac, manifest[ac.id]) : ac));
}

/** A deterministic AC passes iff bound-test passing AND run against the live SHA. */
function deterministicPasses(ac, currentHeadSha) {
  const tb = ac.testBinding || {};
  if (tb.status !== 'passing') return false;
  if (currentHeadSha && tb.lastRunSha && tb.lastRunSha !== currentHeadSha) return false; // stale
  return true;
}

/**
 * Evaluate story completion. Deterministic over the graph.
 *
 * @param {{
 *   acceptanceCriteria: object[],
 *   currentHeadSha?: string,
 *   reviewerVerdicts?: Record<string,'pass'|'fail'>,  // advisory-only
 *   needsHuman?: string[],                            // ac ids escalated
 * }} args
 * @returns {{
 *   done: boolean,
 *   status: 'done'|'failing'|'blocked'|'needs-human',
 *   failing: string[], blocking: string[], attention: string[], pending: string[],
 *   reasons: string[],
 * }}
 */
export function evaluateCompletion({ acceptanceCriteria = [], currentHeadSha, reviewerVerdicts = {}, needsHuman = [] }) {
  const buckets = classifyAcs(acceptanceCriteria);
  const failing = [];
  const blocking = [];
  const attention = [];
  const pending = [];
  const reasons = [];

  for (const ac of buckets.deterministic) {
    if (!deterministicPasses(ac, currentHeadSha)) {
      failing.push(ac.id);
      const tb = ac.testBinding || {};
      reasons.push(`${ac.id}: deterministic AC not passing (status=${tb.status || 'unbound'}${tb.lastRunSha && currentHeadSha && tb.lastRunSha !== currentHeadSha ? ', stale-sha' : ''})`);
    }
  }
  for (const ac of buckets.advisorySecurity) {
    if (reviewerVerdicts[ac.id] === 'fail') { blocking.push(ac.id); reasons.push(`${ac.id}: advisory-security reviewer fail (blocks)`); }
  }
  for (const ac of buckets.advisoryTaste) {
    if (reviewerVerdicts[ac.id] === 'fail') { attention.push(ac.id); reasons.push(`${ac.id}: advisory-taste reviewer fail (attention, non-blocking)`); }
  }
  for (const ac of buckets.manual) {
    if (ac.testBinding?.status !== 'passing') { pending.push(ac.id); }
  }

  // Precedence: needs-human > failing > blocked > pending-manual > done.
  const escalated = needsHuman.filter((id) => acceptanceCriteria.some((ac) => ac.id === id));
  let status;
  if (escalated.length) status = 'needs-human';
  else if (failing.length) status = 'failing';
  else if (blocking.length) status = 'blocked';
  else if (pending.length) status = 'needs-human'; // unresolved manual ACs route to human
  else status = 'done';

  return {
    done: status === 'done',
    status,
    failing, blocking, attention, pending,
    reasons,
  };
}
