// story-retry.mjs — G5: bounded fix-forward helpers for the P3 story-dev retry loop.
//
// Pure functions — no I/O, no DynamoDB, no spawn. The orchestrator (runStoryDevJob)
// calls these after each attempt to decide whether to loop and what context to hand
// to the next attempt.
//
// Deterministic-oracle invariant (enforced by reuse, never weakened here):
//   deterministicPasses requires testBinding.status==='passing' AND lastRunSha===headSha.
//   ONLY runStoryBindings (from a real executor exit code) sets status='passing'.
//   The agent's <BINDING> only sets testRef/testKind — it CANNOT self-pass.
//   Each retry MUST call integrateStory → fresh headSha before handleStoryCompletion,
//   else the staleness guard fires and the AC stays 'failing' regardless of the fix.

/** Executor kinds that are not wired — deterministic re-run is useless for these. */
const NON_RETRYABLE_KINDS = new Set(['browser', 'manual']);

/**
 * Build a markdown block that summarises the prior attempt's failing tests.
 * Injected verbatim into the next attempt's prompt so the agent targets the
 * exact failing assertions — not a generic "try again".
 *
 * Sources pulled from completion:
 *   - verdict.failing  — list of AC IDs that did not pass
 *   - verdict.reasons  — gate explanation strings (includes stale-sha info)
 *   - acceptanceCriteria[].testBinding.{testRef,testKind,detail}  — executor output
 *
 * @param {{
 *   verdict?: { failing?: string[], reasons?: string[] },
 *   acceptanceCriteria?: object[],
 * }} completion  — return value of handleStoryCompletion
 * @returns {string}  markdown (always non-empty)
 */
export function buildPriorFailureBlock(completion) {
  const { verdict = {}, acceptanceCriteria = [] } = completion || {};
  const failingIds = Array.isArray(verdict.failing) ? verdict.failing : [];
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];

  if (!failingIds.length && !reasons.length) {
    return '(no failing-test detail captured)';
  }

  const acMap = new Map(
    Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map((ac) => [ac.id, ac])
      : [],
  );

  const lines = ['## Failing acceptance criteria from prior attempt'];

  for (const acId of failingIds) {
    const ac = acMap.get(acId);
    const tb = ac?.testBinding || {};

    lines.push('');
    lines.push(`### ${acId}${ac?.text ? `: ${ac.text}` : ''}`);

    if (tb.testRef) {
      lines.push(`- **testRef**: \`${tb.testRef}\``);
    } else {
      lines.push('- _(unbound — emit `<BINDING>` mapping this AC id to a test)_');
    }
    if (tb.testKind) lines.push(`- **testKind**: ${tb.testKind}`);
    lines.push(`- **binding status**: ${tb.status || 'unbound'}`);

    if (tb.detail) {
      lines.push('- **test output**:');
      lines.push('  ```');
      // Indent every line so the fenced block renders correctly inside the list.
      for (const l of String(tb.detail).split('\n')) {
        lines.push(`  ${l}`);
      }
      lines.push('  ```');
    }
  }

  if (reasons.length) {
    lines.push('');
    lines.push('## Gate reasons');
    for (const r of reasons) {
      lines.push(`- ${r}`);
    }
  }

  return lines.join('\n');
}

/**
 * A6 — gate-DATA failures (dossier, pacman1 job 677f9e70): failing entries a
 * re-spawned IMPLEMENTER can never fix because the gap is pipeline DATA, not
 * code — the binding/validator wiring comes from the test-author/planner, and
 * the implementer has no channel to repair it:
 *   • an AC with NO testRef (unbound — nothing exists for the implementer to
 *     satisfy; in the split model only the test-author emits <BINDING>),
 *   • an AC whose binding is `misbound` (wrong testKind / no-mock violation —
 *     rebinding is test-author data),
 *   • an invariant with NO authored validator ref (manifest missing and no
 *     persisted binding — the implementer never authors validators).
 * Pseudo-entries (test-tampering, green-trunk, foundation-gate) and failing
 * BOUND tests / authored-but-failing validators are agent-fixable and are NOT
 * data gaps. PURE over the completion shape.
 *
 * @param {{
 *   verdict?: { failing?: string[] },
 *   acceptanceCriteria?: object[],
 *   invariants?: object[],
 * }} completion
 * @returns {string[]}  one human-readable reason per data gap (empty = none)
 */
export function findGateDataGaps(completion) {
  const { verdict = {}, acceptanceCriteria = [], invariants = [] } = completion || {};
  const failingIds = Array.isArray(verdict.failing) ? verdict.failing : [];
  if (!failingIds.length) return [];

  const acMap = new Map(
    Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map((ac) => [ac.id, ac]) : [],
  );
  const invMap = new Map(
    Array.isArray(invariants) ? invariants.map((inv) => [inv.id, inv]) : [],
  );

  const gaps = [];
  for (const id of failingIds) {
    const inv = invMap.get(id);
    if (inv) {
      if (!inv.validator?.ref) {
        gaps.push(`${id}: invariant has no authored validator (manifest missing, no persisted binding) — an implementer respawn cannot author one`);
      }
      continue;
    }
    const ac = acMap.get(id);
    if (!ac) continue; // pseudo-id (test-tampering/green-trunk/foundation-gate) → agent-fixable
    const tb = ac.testBinding || {};
    if (tb.status === 'misbound') {
      gaps.push(`${id}: binding is misbound (${tb.detail || 'wrong testKind / no-mock violation'}) — rebinding is test-author data, not implementer work`);
    } else if (!tb.testRef) {
      gaps.push(`${id}: AC is unbound — no test binding exists for an implementer respawn to satisfy`);
    }
  }
  return gaps;
}

/**
 * Classify whether a failed completion is retryable (bounded fix-forward).
 *
 * Returns `false` when ANY failing entry is a gate-DATA failure (see
 * findGateDataGaps) — completion needs EVERY entry to pass, so one unfixable
 * data gap makes a re-spawn pure waste: fail fast instead (dossier A6; the
 * pacman1 unbound-invariant failure consumed a fix-forward attempt AND a
 * reviewer for nothing).
 * Returns `false` when every failing AC is `browser` or `manual` — those
 * executors are not wired, so re-spawning loops forever on untestable criteria.
 * Returns `false` when there are no failing deterministic ACs (nothing a re-run
 * can fix — e.g. story failed because of `blocked` or `needs-human`).
 * Returns `true` when at least one failing entry is agent-fixable: a failing
 * BOUND test with a wired executor kind (unit | integration), an
 * authored-but-failing invariant, or a pseudo-entry (test-tampering,
 * green-trunk, foundation-gate).
 *
 * @param {{
 *   verdict?: { failing?: string[] },
 *   acceptanceCriteria?: object[],
 *   invariants?: object[],
 * }} completion
 * @returns {boolean}
 */
export function classifyRetryable(completion) {
  const { verdict = {}, acceptanceCriteria = [], invariants = [] } = completion || {};
  const failingIds = Array.isArray(verdict.failing) ? verdict.failing : [];

  if (!failingIds.length) return false;

  // Gate-DATA failure anywhere → fail fast (respawning cannot clear it).
  if (findGateDataGaps(completion).length) return false;

  const acMap = new Map(
    Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map((ac) => [ac.id, ac])
      : [],
  );
  const invMap = new Map(
    Array.isArray(invariants) ? invariants.map((inv) => [inv.id, inv]) : [],
  );

  for (const acId of failingIds) {
    // An authored-but-failing invariant is a failing bound test — retryable.
    if (invMap.has(acId)) return true;
    const ac = acMap.get(acId);
    // verify='manual' on the AC itself is also a non-retryable signal.
    const kind = ac?.testBinding?.testKind ?? ac?.verify;
    // If ANY failing AC is NOT in the non-retryable set the loop is useful.
    if (!NON_RETRYABLE_KINDS.has(kind)) return true;
  }

  // Every failing AC is browser/manual → escalate, do not loop.
  return false;
}

/**
 * Gate function for the retry loop: true iff the story failed, attempts remain,
 * AND at least one failing AC has a wired executor (classifyRetryable).
 *
 * @param {{ newState?: string, verdict?: object, acceptanceCriteria?: object[] } | null} completion
 * @param {number} attempt       current (just-finished) attempt number (1-based)
 * @param {number} maxAttempts
 * @returns {boolean}
 */
export function shouldRetry(completion, attempt, maxAttempts) {
  if (!completion) return false;
  if (completion.newState !== 'failed') return false;
  if (attempt >= maxAttempts) return false;
  return classifyRetryable(completion);
}
