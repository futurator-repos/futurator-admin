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
const INVARIANTS_RE = /<INVARIANTS>([\s\S]*?)<\/INVARIANTS>/i;

// A file token that "looks like" a runnable test/spec file. This MIRRORS
// test-executors.mjs TEST_FILE_RE (kept a local copy rather than a cross-import
// because that module imports resolveTestRefs from HERE — importing it back would
// close a module cycle). Used ONLY for parse-time disambiguation of the legacy
// " + " composite separator (below); the executor still owns the authoritative
// real-file existence gate. Matches .ts/.tsx/.js/.jsx/.mts/.cts + spec variants.
const FILE_TOKEN_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Normalize ONE raw ref chunk into a runnable test-file token: strip a trailing
 * human-readable parenthetical prose "( … )" the test-author appends, then take
 * the segment BEFORE the first vitest report separator " > " (the file path),
 * then trim. Non-string → ''. PURE. (prose stripped first so a " > " inside the
 * prose can never leak into the file token.)
 */
function normalizeRefToken(raw) {
  if (typeof raw !== 'string') return '';
  const noProse = raw.replace(/\s*\([^()]*\)\s*$/, '');
  return noProse.split(' > ')[0].trim();
}

/**
 * Normalize ONE already-isolated ref (a full array element, or one accumulated
 * " + " composite chunk) into a token, or `null` to drop it. PURE.
 *
 * finding-1 (2026-07-14): the OLD code did `chunks.map(normalizeRefToken).
 * filter(Boolean)`, which SILENTLY DROPPED any chunk that normalized to '' —
 * including a chunk that is ENTIRELY parenthetical prose (e.g. " + (all pellets
 * reachable — enforced by verify:build)"). Dropping it meant an intended-coverage
 * claim was never executed while the AC could still green on its remaining real
 * file → a false/unverified GREEN in the exact Incident-C composite class. We now
 * DISTINGUISH two empties:
 *   - a chunk that was blank/whitespace to begin with (a trailing " + " separator,
 *     an empty array slot) → truly nothing to run → drop silently (return null).
 *   - a chunk that had CONTENT but normalized to '' (pure parenthetical prose, no
 *     file) → keep the RAW text as a NON-FILE token so the vitest executor's
 *     TEST_FILE_RE flags it `errored` (a loud BINDING FAULT), never a silent pass.
 */
function normalizeSingleRef(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null; // truly-empty (whitespace / trailing separator) → drop
  const token = normalizeRefToken(raw);
  // pure-prose chunk → surface the raw so it errors loud rather than vanishing.
  return token || trimmed;
}

/**
 * Is `trimmed` (a " + "-split chunk, already trimmed) a STANDALONE ref rather than
 * a fragment of the PRECEDING ref's selector/prose that happened to contain " + "?
 * A chunk is standalone iff its leading token is a file-shaped path OR it is pure
 * parenthetical prose (which must surface as its own errored token). PURE.
 */
function isStandaloneRef(trimmed) {
  const token = normalizeRefToken(trimmed);
  if (token === '') return true; // pure parenthetical prose → its own (errored) token
  return FILE_TOKEN_RE.test(token);
}

/**
 * Split a legacy " + "-joined composite STRING into its constituent refs WITHOUT
 * mis-splitting a single-file selector whose describe/it name contains " + ".
 *
 * finding-2 (2026-07-14): the OLD code did `testRef.split(' + ')` at the TOP level
 * BEFORE the 'file > describe > it' selector segment was extracted. A supported
 * shape-#2 selector like "src/x/foo.test.ts > reducer > adds a + b" split into
 * ["…adds a", "b"]; the bogus "b" token resolved to no test file → an errored
 * binding fault → a permanently un-completable AC (the Incident-C wall re-opened
 * for a LEGITIMATE input). Fix: split on " + ", then RE-JOIN any chunk that is not
 * a standalone ref back onto the preceding ref — i.e. only a " + " OUTSIDE the
 * selector portion acts as a composite separator. A " + " nested in prose is also
 * healed, because re-joining reconstructs the full "(…)" that normalizeRefToken
 * then strips. PURE.
 */
function splitComposite(str) {
  const refs = [];
  for (const part of str.split(' + ')) {
    const trimmed = part.trim();
    if (!trimmed) continue; // truly-empty chunk (whitespace / trailing separator) → drop
    if (refs.length && !isStandaloneRef(trimmed)) {
      // " + " was INSIDE the previous ref's selector it-name / prose — re-join it
      // (with the original separator) so the selector reconstructs intact.
      refs[refs.length - 1] += ` + ${part}`;
    } else {
      refs.push(part);
    }
  }
  return refs;
}

/**
 * Resolve a binding `testRef` into the canonical list of runnable test-file-path
 * tokens the vitest executor drives. PURE; never throws.
 *
 * Incident C (2026-07-13, story 353af4a1, PROVEN on-box): the OLD executor did
 * `String(testRef).split(' > ')[0]` then `vitest run --passWithNoTests=false
 * <ref>`. The test-author emitted a " + "-joined MULTI-FILE composite with
 * parenthetical prose, e.g.
 *   "src/game/maze.test.ts (buildInitialState contract) + src/game/reducer.test.ts (… enforced separately by verify:build)"
 * There is no " > ", so the WHOLE composite became one unmatchable vitest
 * filename filter → exit 1 → the AC was PERMANENTLY failing even though every
 * underlying file passed individually. resolveTestRefs kills that by normalizing
 * ANY accepted shape into the run-list:
 *   - a single clean path                     → ['file']
 *   - a 'file > describe > it' selector        → ['file']            (file segment)
 *   - a JSON ARRAY of the above                → one token per element
 *   - a legacy " + "-joined composite + prose  → one token per chunk, prose stripped
 * Back-compat is mandatory: existing rows carry composite strings.
 *
 * SAFETY (finding-1 + finding-2, 2026-07-14): the run-list must NEVER silently
 * omit an intended-coverage token (would false-GREEN) NOR fabricate a bogus token
 * from a legitimate selector (would false-ERROR a valid story). A pure-prose chunk
 * survives as a non-file token (→ executor errors it loud); a " + " inside a
 * selector/prose is NOT a composite separator (see splitComposite); an array
 * element is a standalone ref (never " + "-split — its " + " belongs to its own
 * selector). Empties from whitespace/trailing separators are the ONLY silent drop.
 *
 * @param {string|string[]} testRef
 * @returns {string[]}
 */
export function resolveTestRefs(testRef) {
  let refs;
  if (Array.isArray(testRef)) refs = testRef; // each element is already a standalone ref
  else if (typeof testRef === 'string') refs = splitComposite(testRef);
  else return [];
  const out = [];
  for (const ref of refs) {
    const token = normalizeSingleRef(ref);
    if (token !== null) out.push(token);
  }
  return out;
}

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
    // testRef may be a SINGLE path/selector string OR a JSON ARRAY of paths
    // (cross-slice contract; resolveTestRefs normalizes both). Array must be
    // handled BEFORE the object branch — an array is `typeof === 'object'`, so
    // the old object branch would have read `v.testRef` (undefined) and dropped
    // every element. The ORIGINAL shape is stored for display; the runner
    // exposes the run-list via resolveTestRefs.
    if (typeof v === 'string' || Array.isArray(v)) out[acId] = { testRef: v };
    else if (v && typeof v === 'object') out[acId] = { testRef: v.testRef || v.test || '', testKind: v.testKind || v.kind };
  }
  return out;
}

/**
 * Parse an `<INVARIANTS>` manifest out of agent output. Mirrors
 * parseBindingManifest tolerance (tag → fenced → bare JSON). Maps an invariant id
 * to the validator the story authored: `{ [invariantId]: { ref, kind } }`. Applied
 * by the caller to flip declared invariants → authored. PURE.
 */
export function parseInvariantManifest(text) {
  if (typeof text !== 'string') return {};
  const m = INVARIANTS_RE.exec(text);
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
  for (const [id, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[id] = { ref: v };
    else if (v && typeof v === 'object') out[id] = { ref: v.ref || v.testRef || v.test || '', kind: v.kind || v.testKind };
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
 *   invariants?: object[],                            // ran invariant validators
 * }} args
 * @returns {{
 *   done: boolean,
 *   status: 'done'|'failing'|'blocked'|'needs-human',
 *   failing: string[], blocking: string[], attention: string[], pending: string[],
 *   reasons: string[],
 * }}
 */
export function evaluateCompletion({ acceptanceCriteria = [], currentHeadSha, reviewerVerdicts = {}, needsHuman = [], invariants = [] }) {
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
      // F3 (Incident C, C5): a binding that ERRORED — an unrunnable testRef
      // (resolved to no real committed test file) or a runner fault — is a
      // BINDING FAULT, surfaced LOUDLY and kept DISTINCT from a deterministic AC
      // that merely didn't pass. An errored binding can never be honestly
      // verified until the testRef is fixed; reading it as a plain "not passing"
      // is exactly what let Incident C dead-end an un-completable story.
      if (tb.errored) {
        reasons.push(`${ac.id}: binding fault (unrunnable testRef): ${tb.detail || 'resolved to no runnable test file'}`);
        continue;
      }
      const browserMisbound = requiresBrowser(ac) && tb.testKind !== 'browser';
      // A verify:'state' AC carrying status:'misbound' failed the no-mock rule —
      // surface the concrete mock detail so the reason reads clearly.
      const stateMisbound = tb.status === 'misbound' && !requiresBrowser(ac);
      reasons.push(`${ac.id}: deterministic AC not passing (status=${tb.status || 'unbound'}${browserMisbound ? `, misbound: behavior AC needs testKind:'browser' not '${tb.testKind || 'omitted'}'` : ''}${stateMisbound && tb.detail ? `, misbound: ${tb.detail}` : ''}${tb.lastRunSha && currentHeadSha && tb.lastRunSha !== currentHeadSha ? ', stale-sha' : ''})`);
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

  // Invariant gate (redesign Part 4) — FAIL CLOSED. An invariant blocks `done`
  // unless its authored validator is 'passing' AND was run against the live SHA.
  for (const inv of invariants) {
    const v = inv?.validator || {};
    const stale = v.lastRunSha && currentHeadSha && v.lastRunSha !== currentHeadSha;
    if (v.status !== 'passing' || stale) {
      failing.push(inv.id);
      reasons.push(`${inv.id}: invariant not satisfied (status=${v.status || 'declared'}${stale ? ', stale-sha' : ''}${v.detail ? ` — ${v.detail}` : ''})`);
    }
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
