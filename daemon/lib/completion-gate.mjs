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

/**
 * Does this AC assert genuinely APP-LEVEL behavior that MUST be driven in the real
 * app through the browser probe executor (window.__harness)? True for a
 * verify:'behavior' AC or an explicit needsBrowser:true — a mocked-hook unit test
 * does NOT satisfy such an AC. Advisory ACs are EXCLUDED: advisory-taste/security
 * are non-blocking by design and their visual/appearance checks belong at the VQA
 * wave gate, not the per-story browser executor (an advisory appearance AC often
 * carries needsBrowser but must never be forced to fail-closed here). PURE.
 */
export function requiresBrowser(ac) {
  const cls = ac?.acClass || 'deterministic';
  if (cls === 'advisory-security' || cls === 'advisory-taste') return false;
  return ac?.verify === 'behavior' || ac?.needsBrowser === true;
}

/** Partition ACs by class. `manual` ACs (verify:'manual') are split out. */
export function classifyAcs(acs = []) {
  const buckets = { deterministic: [], advisoryTaste: [], advisorySecurity: [], manual: [] };
  for (const ac of acs) {
    const cls = ac.acClass || 'deterministic';
    // Advisory class takes PRECEDENCE over the manual/browser routing. An
    // advisory AC is non-blocking by design (only advisory-security can block,
    // via a reviewer fail); routing it to `manual` first would land a browser/
    // appearance advisory AC in pending → needs-human and wrongly FAIL the story
    // (its visual check belongs at the VQA wave gate, not the per-story gate).
    if (cls === 'advisory-security') { buckets.advisorySecurity.push(ac); continue; }
    if (cls === 'advisory-taste') { buckets.advisoryTaste.push(ac); continue; }
    // A behavior/needsBrowser AC is ALWAYS deterministic (verified by the real
    // browser probe executor) — it can NEVER route to the manual bucket. This
    // fails CLOSED: without this branch, a mis-declared testKind:'manual' on a
    // behavior AC would escape to manual → needs-human (operator-escapable) OR,
    // worse, a testKind:'unit' mocked pass would satisfy it as deterministic.
    // Keeping it deterministic means deterministicPasses() rejects any non-browser
    // binding for it. (This is the story-level hole Slice C closes.)
    if (requiresBrowser(ac)) { buckets.deterministic.push(ac); continue; }
    if (ac.verify === 'manual' || ac.testBinding?.testKind === 'manual') { buckets.manual.push(ac); continue; }
    buckets.deterministic.push(ac);
  }
  return buckets;
}

/**
 * Immutably bind an AC from the agent's <BINDING> manifest.
 *
 * FAIL CLOSED for app-level behavior: an AC that requiresBrowser() MUST be bound
 * testKind:'browser'. A 'unit'/'integration'/'manual'/omitted testKind for such an
 * AC is a MISBINDING — the browser probe executor drives the real app via
 * window.__harness, so a mocked-hook unit test can never satisfy a behavioral AC.
 * We record status:'misbound' (a distinct non-passing state) rather than 'bound',
 * so the deterministic gate treats it as not-done and the runner refuses to run it
 * as a unit test.
 */
export function bindAc(ac, binding) {
  if (!binding || !binding.testRef) return ac;
  const testKind = binding.testKind || ac.testBinding?.testKind;
  if (requiresBrowser(ac) && testKind !== 'browser') {
    return {
      ...ac,
      testBinding: {
        ...(ac.testBinding || {}),
        status: 'misbound',
        testRef: binding.testRef,
        testKind,
        detail: `behavior/needsBrowser AC must be bound testKind:'browser'; got '${testKind || 'omitted'}' — a mocked-hook test does not satisfy it`,
      },
    };
  }
  return {
    ...ac,
    testBinding: { ...(ac.testBinding || {}), status: 'bound', testRef: binding.testRef, testKind },
  };
}

/** Apply a parsed binding manifest to a list of ACs (immutable). */
export function applyBindings(acs = [], manifest = {}) {
  return acs.map((ac) => (manifest[ac.id] ? bindAc(ac, manifest[ac.id]) : ac));
}

/** A deterministic AC passes iff bound-test passing AND run against the live SHA. */
function deterministicPasses(ac, currentHeadSha) {
  const tb = ac.testBinding || {};
  // FAIL CLOSED: an app-level behavior AC only counts as passing when it was
  // verified through the BROWSER probe executor. A 'passing' status carried by any
  // other testKind (a mocked-hook unit test) is the exact hole Slice C closes — it
  // is NOT a satisfied behavioral AC, no matter what the runner recorded.
  if (requiresBrowser(ac) && tb.testKind !== 'browser') return false;
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
      const misbound = requiresBrowser(ac) && tb.testKind !== 'browser';
      reasons.push(`${ac.id}: deterministic AC not passing (status=${tb.status || 'unbound'}${misbound ? `, misbound: behavior AC needs testKind:'browser' not '${tb.testKind || 'omitted'}'` : ''}${tb.lastRunSha && currentHeadSha && tb.lastRunSha !== currentHeadSha ? ', stale-sha' : ''})`);
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
