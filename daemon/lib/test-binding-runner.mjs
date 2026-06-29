// test-binding-runner — the Verify-stage executor (development-plan §5.5).
//
// Given a story's BOUND acceptance criteria, run each binding's test by `kind`
// and flip its status passing/failing, stamping `lastRunSha` (the staleness
// guard the completion-gate checks). Deterministic AC ⇒ deterministic done.
// `manual` ACs are NOT auto-run — they're routed to VQA/human by the gate.
//
// Executors are injected so this unit-tests without spawning; the daemon wires
// the real ones (unit→vitest filter, integration→vitest, browser→probe harness,
// lint/typecheck→cached-tsc+eslint), each content-hash-cached upstream.

const DEFAULT_EXECUTORS = {
  // each returns { passed: boolean, detail?: string }
  unit: async () => ({ passed: false, detail: 'no unit executor wired' }),
  integration: async () => ({ passed: false, detail: 'no integration executor wired' }),
  browser: async () => ({ passed: false, detail: 'no browser executor wired' }),
};

/** Immutably set a binding result on an AC. */
function recordResult(ac, { passed, detail }, sha, at) {
  return {
    ...ac,
    testBinding: {
      ...(ac.testBinding || {}),
      status: passed ? 'passing' : 'failing',
      lastRunSha: sha,
      lastRunAt: at,
      detail: detail || ac.testBinding?.detail,
    },
  };
}

/**
 * Run all runnable bindings for a story. Returns the updated AC list (immutable)
 * plus a summary. ACs that are `unbound` or `manual` are passed through untouched
 * (unbound ⇒ the gate treats as not-done; manual ⇒ routed to human).
 *
 * @param {{
 *   acceptanceCriteria: object[],
 *   headSha: string,
 *   executors?: Record<string, (ac)=>Promise<{passed:boolean,detail?:string}>>,
 *   now?: () => string,
 * }} args
 */
export async function runStoryBindings({ acceptanceCriteria = [], headSha, executors = {}, now = () => new Date().toISOString() }) {
  const exec = { ...DEFAULT_EXECUTORS, ...executors };
  const at = now();
  const out = [];
  let ran = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const ac of acceptanceCriteria) {
    const tb = ac.testBinding || {};
    const kind = tb.testKind;
    const isManual = ac.verify === 'manual' || kind === 'manual';
    if (isManual || tb.status === 'unbound' || !tb.testRef) {
      out.push(ac);
      skipped += 1;
      continue;
    }
    const runner = exec[kind] || exec.unit;
    let result;
    try {
      result = await runner(ac);
    } catch (err) {
      result = { passed: false, detail: `runner threw: ${err?.message || err}` };
    }
    ran += 1;
    if (result.passed) passed += 1; else failed += 1;
    out.push(recordResult(ac, result, headSha, at));
  }

  return { acceptanceCriteria: out, summary: { ran, passed, failed, skipped } };
}
