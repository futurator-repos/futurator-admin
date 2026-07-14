// tdd-gates.mjs — pure, deterministic TDD gate primitives (TDD blueprint §4/§7).
//
// These are the two things pipeline-3 lost when it collapsed the legacy
// test-first pipeline into a single spawn:
//   1. test-immutability  — the implementer must not edit the authored tests
//      ("cheat" prevention). Legacy enforced this with `tamper-check`
//      (story-pipeline.ts), which auto-reverted any DEV edit to a test file.
//   2. RED-first proof     — the authored tests must FAIL before implementation,
//      proving they aren't tautologies. Legacy enforced this with `test-gate-red`
//      (inverts the suite exit code before DEV runs).
//
// Both are FACTS about files and exit codes, so they belong in code, not in a
// second LLM. This module is PURE (no I/O) so it unit-tests trivially and can be
// wired into the existing single-spawn path BEFORE the test-author split lands —
// the whole point of Wave-0 is to prove each gate is deterministic before we
// spend a token on a new spawn. Not wired into dispatch yet.

/**
 * test-immutability. Given the set of test files the Test-Author owns (the
 * baseline) and the set of files the Implementer changed, return which owned
 * test files were touched. A non-empty result is a tamper violation.
 *
 * Path comparison is exact-string after a light normalize (strip leading "./",
 * collapse duplicate slashes) so callers can pass `git diff --name-only` output
 * directly. Creating NEW test files is allowed (not in the owned baseline);
 * editing an OWNED test file is the violation legacy reverted.
 *
 * @param {string[]} ownedTestFiles  test files authored/owned by the Test-Author
 * @param {string[]} changedFiles    files the Implementer changed (e.g. git diff)
 * @returns {{ tampered: string[], ok: boolean }}
 */
export function detectTestTampering(ownedTestFiles = [], changedFiles = []) {
  const norm = (p) => String(p || '').trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const owned = new Set(ownedTestFiles.map(norm).filter(Boolean));
  const changed = new Set(changedFiles.map(norm).filter(Boolean));
  const tampered = [...owned].filter((f) => changed.has(f)).sort();
  return { tampered, ok: tampered.length === 0 };
}

/**
 * RED-first proof. Given the summary of running the story's BOUND tests BEFORE
 * implementation (the shape returned by `runStoryBindings().summary`), assert
 * that the story has genuine new work to do: at least ONE bound test is RED
 * (ran-and-failed). Legacy's `test-gate-red` rule ("If a test passes before
 * implementation, it's not a valid acceptance test") demanded that ALL bound
 * tests fail — correct for a greenfield story, but WRONG for an integration /
 * walking-skeleton story built on a live foundation.
 *
 * B2 (Incident F): a behavioral/integration AC can be ALREADY satisfied at RED
 * time because a DEPENDENCY (the walking-skeleton foundation) already provides
 * that state — e.g. an assemble story asserting `snapshot.status=='idle'` /
 * `lives==3` when the foundation's initial state already seeds them. Requiring
 * ALL-RED falsely rejected such stories ("passed before implementation") and,
 * under pacman8 no-fallback, failed them CLOSED — an integration story building
 * on a live foundation can NEVER have an all-RED state. So the requirement is
 * relaxed to AT LEAST ONE RED: that one genuine RED proves the story has real
 * new work, while the GREEN completion gate still requires ALL bound tests to
 * pass — so a partially-pre-satisfied story cannot fake completion, and a
 * story whose tests ALL already pass (nothing to implement) is still rejected.
 *
 * @param {{ ran?: number, passed?: number, failed?: number, errored?: number }} summary
 * @returns {{ ok: boolean, ran: number, passed: number, failed: number, errored: number, reason: string }}
 */
export function assertRedFirst(summary = {}) {
  const ran = Number(summary.ran) || 0;
  const passed = Number(summary.passed) || 0;
  const failed = Number(summary.failed) || 0;
  const errored = Number(summary.errored) || 0;
  // F3 (Incident C, C5): a binding that ERRORED — an unrunnable testRef (resolved
  // to no real test file) or a runner fault — is NOT a valid RED. A genuine RED is
  // a test that RAN and FAILED; a test that CANNOT be executed proves nothing and
  // silently dead-ends completion (the exact class where a malformed composite
  // ref "passes" RED then fails forever). Surface it LOUDLY and block. Checked
  // FIRST (unchanged): an errored binding is a fault regardless of the run tallies.
  if (errored > 0) {
    return {
      ok: false,
      ran,
      passed,
      failed,
      errored,
      reason: `binding fault: ${errored} binding(s) could not be executed (unrunnable testRef) — a test that cannot be executed is not a valid RED`,
    };
  }
  if (ran === 0) {
    return { ok: false, ran, passed, failed, errored, reason: 'no bound tests ran — cannot prove RED-first' };
  }
  // B2 (Incident F): a story whose EVERY bound test already passes before any
  // implementation has nothing to implement — a tautology or work already done
  // by a dependency with no NEW claim of its own. Still rejected (the GREEN gate
  // could not tell this apart from real completion, so RED-first must).
  if (failed === 0) {
    return {
      ok: false,
      ran,
      passed,
      failed,
      errored,
      reason: `all ${ran} bound test(s) already pass before implementation — nothing to implement (tautology or pre-existing)`,
    };
  }
  // At least one bound test is RED → the story has genuine new work. When SOME
  // bound tests already pass (passed>0), those are legitimately satisfied by the
  // live foundation (Incident F) — note it, don't reject.
  const preSatisfied = passed > 0 ? ` (${passed} already satisfied by a dependency)` : '';
  return {
    ok: true,
    ran,
    passed,
    failed,
    errored,
    reason: `${failed}/${ran} bound test(s) RED before implementation${preSatisfied}`,
  };
}
