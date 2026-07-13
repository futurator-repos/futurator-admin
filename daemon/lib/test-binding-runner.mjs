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

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requiresBrowser } from './completion-gate.mjs';
import { detectInRepoMock } from './no-mock-check.mjs';

const DEFAULT_EXECUTORS = {
  // each returns { passed: boolean, detail?: string }
  unit: async () => ({ passed: false, detail: 'no unit executor wired' }),
  integration: async () => ({ passed: false, detail: 'no integration executor wired' }),
  browser: async () => ({ passed: false, detail: 'no browser executor wired' }),
};

/** Immutably set a binding result on an AC. `statusOverride` forces a status
 *  (e.g. 'misbound') regardless of `passed`. */
function recordResult(ac, { passed, detail }, sha, at, statusOverride) {
  return {
    ...ac,
    testBinding: {
      ...(ac.testBinding || {}),
      status: statusOverride || (passed ? 'passing' : 'failing'),
      lastRunSha: sha,
      lastRunAt: at,
      detail: detail || ac.testBinding?.detail,
    },
  };
}

/** Extract the file segment of a vitest-report testRef ("<file> > describe > it"). */
function testRefFile(testRef) {
  return String(testRef).split(' > ')[0].trim();
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
 *   cwd?: string,                       // worktree root — bound files read relative to it
 *   readFile?: (path:string, enc:string)=>Promise<string>,  // injectable for tests
 *   enforceNoMock?: boolean,            // GREEN-phase no-mock rule (default ON)
 * }} args
 */
export async function runStoryBindings({
  acceptanceCriteria = [], headSha, executors = {}, now = () => new Date().toISOString(),
  cwd, readFile = nodeReadFile, enforceNoMock = true,
}) {
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
    // FAIL CLOSED: an app-level behavior AC MUST run under the browser probe
    // executor. `exec[kind] || exec.unit` silently downgraded an unknown/misbound
    // kind to a unit run — for a behavioral AC that is precisely the mocked-unit
    // hole (a green mock reported as a satisfied behavior). Never downgrade: record
    // a fail with a reason so the completion gate keeps the story not-done.
    if (requiresBrowser(ac) && kind !== 'browser') {
      ran += 1;
      failed += 1;
      out.push(recordResult(ac, {
        passed: false,
        detail: `behavior/needsBrowser AC requires testKind:'browser'; refusing to run as '${kind || 'unit'}' (mocked-hook test does not satisfy it)`,
      }, headSha, at));
      continue;
    }
    // NO-MOCK RULE (redesign Part 3 §1): a verify:'state' AC bound to a
    // unit/integration test must exercise the REAL module under test — it may not
    // vi.mock/jest.mock an in-repo module. Statically check the bound file BEFORE
    // running: unreadable OR an in-repo mock ⇒ status:'misbound', do NOT run it.
    if (enforceNoMock && ac.verify === 'state' && (kind === 'unit' || kind === 'integration')) {
      const file = testRefFile(tb.testRef);
      let source;
      let readErr;
      try {
        source = await readFile(cwd ? join(cwd, file) : file, 'utf8');
      } catch (err) {
        readErr = err;
      }
      const mock = source != null ? detectInRepoMock(source) : { violation: true, hits: [] };
      if (readErr || mock.violation) {
        ran += 1;
        failed += 1;
        const why = readErr ? '(file unreadable)' : mock.hits.join(', ');
        out.push(recordResult(ac, {
          passed: false,
          detail: `verify:'state' AC must exercise the real module — bound test ${file} mocks in-repo module(s): ${why} (no-mock rule) → misbound`,
        }, headSha, at, 'misbound'));
        continue;
      }
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

/** Immutably stamp a validator patch onto an invariant. */
function stampInvariant(inv, patch) {
  return { ...inv, validator: { ...(inv?.validator || {}), ...patch } };
}

/**
 * Run a story's declared invariant validators (redesign Part 4). The planner
 * DECLARES the property, the story AUTHORS the validator, the gate RUNS it.
 * FAIL CLOSED throughout: a declared-but-unauthored invariant (no validator ref)
 * is `failing` ("no authored validator"); a validator that mocks an in-repo
 * module is `failing`; otherwise the injected executor decides passing/failing.
 *
 * @param {{
 *   invariants?: object[],
 *   headSha: string,
 *   executor: (inv)=>Promise<{passed:boolean,detail?:string}>,
 *   cwd?: string,                      // worktree root — relative validator refs resolve against it
 *   readFile?: (path:string, enc:string)=>Promise<string>,
 *   now?: () => string,
 * }} args
 * @returns {Promise<{ invariants: object[], summary: {ran,passed,failed,skipped} }>}
 */
export async function runStoryInvariants({
  invariants = [], headSha, executor, cwd, readFile = nodeReadFile, now = () => new Date().toISOString(),
}) {
  const at = now();
  const out = [];
  let ran = 0;
  let passed = 0;
  let failed = 0;
  const skipped = 0;

  for (const inv of invariants) {
    const v = inv?.validator || {};
    // fail-closed: nothing was authored to check this property.
    if (v.status === 'declared' || !v.ref) {
      out.push(stampInvariant(inv, {
        status: 'failing',
        detail: 'no authored validator (declared) — fail-closed',
        lastRunSha: headSha,
        lastRunAt: at,
      }));
      failed += 1;
      continue;
    }
    // no-mock rule on the validator source itself. The manifest's ref is
    // repo-RELATIVE (authored inside the app worktree), so it MUST resolve
    // against cwd — reading it raw resolves against the DAEMON's cwd and every
    // validator comes back ENOENT → "unreadable — fail-closed", failing the
    // story on all attempts no matter how green the code (pacman1, 2026-07-13;
    // runStoryBindings has always joined cwd — this mirrors it).
    let source;
    let readErr;
    try {
      const refPath = cwd && !String(v.ref).startsWith('/') ? join(cwd, v.ref) : v.ref;
      source = await readFile(refPath, 'utf8');
    } catch (err) {
      readErr = err;
    }
    const mock = source != null ? detectInRepoMock(source) : { violation: true, hits: [] };
    if (readErr || mock.violation) {
      out.push(stampInvariant(inv, {
        status: 'failing',
        detail: readErr
          ? `validator ${v.ref} unreadable — fail-closed`
          : `validator ${v.ref} mocks in-repo module(s): ${mock.hits.join(', ')} (no-mock rule)`,
        lastRunSha: headSha,
        lastRunAt: at,
      }));
      failed += 1;
      continue;
    }
    // execute the authored validator.
    let result;
    try {
      result = await executor(inv);
    } catch (err) {
      result = { passed: false, detail: `validator threw: ${err?.message || err}` };
    }
    ran += 1;
    if (result?.passed) passed += 1; else failed += 1;
    out.push(stampInvariant(inv, {
      status: result?.passed ? 'passing' : 'failing',
      detail: result?.detail || v.detail,
      lastRunSha: headSha,
      lastRunAt: at,
    }));
  }

  return { invariants: out, summary: { ran, passed, failed, skipped } };
}

/** Run a shell command, return { passed, detail } from the exit code. */
function runInvariantCommand(spawnSync, cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.error) return { passed: false, detail: `${cmd} error: ${res.error.message}` };
  const passed = res.status === 0;
  const tail = ((res.stdout || '') + (res.stderr || '')).trim().slice(-400);
  return { passed, detail: passed ? 'pass' : `exit ${res.status}: ${tail}` };
}

/**
 * Real invariant executor bound to a worktree. kind:'script' → `node <ref>`
 * (exit 0 = pass); kind:'test' → `npx vitest run <file>` on the ref's file segment.
 * Spawn is injected so the dispatch logic unit-tests without running anything.
 */
export function makeInvariantExecutor({ cwd, spawnSync = nodeSpawnSync }) {
  return async (inv) => {
    const v = inv?.validator || {};
    const ref = v.ref;
    if (!ref) return { passed: false, detail: 'no validator ref' };
    if (v.kind === 'script') {
      return runInvariantCommand(spawnSync, 'node', [ref], cwd);
    }
    // kind:'test' (default) → vitest filter on the file segment.
    return runInvariantCommand(spawnSync, 'npx', ['vitest', 'run', testRefFile(ref)], cwd);
  };
}
