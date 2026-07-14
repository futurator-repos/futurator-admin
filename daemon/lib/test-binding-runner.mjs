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
import { requiresBrowser, resolveTestRefs } from './completion-gate.mjs';
import { detectInRepoMock } from './no-mock-check.mjs';

// A resolved ref token names a runnable test file iff it matches this — used to
// decide verify-typed routing (F2) and to iterate the no-mock check per file.
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

const DEFAULT_EXECUTORS = {
  // each returns { passed: boolean, detail?: string }
  unit: async () => ({ passed: false, detail: 'no unit executor wired' }),
  integration: async () => ({ passed: false, detail: 'no integration executor wired' }),
  browser: async () => ({ passed: false, detail: 'no browser executor wired' }),
};

/** Immutably set a binding result on an AC. `statusOverride` forces a status
 *  (e.g. 'misbound') regardless of `passed`. */
function recordResult(ac, { passed, detail, errored }, sha, at, statusOverride) {
  return {
    ...ac,
    testBinding: {
      ...(ac.testBinding || {}),
      status: statusOverride || (passed ? 'passing' : 'failing'),
      lastRunSha: sha,
      lastRunAt: at,
      detail: detail || ac.testBinding?.detail,
      // F3: mark an ERRORED binding (unrunnable testRef / runner fault) so the
      // completion gate can surface it as a BINDING FAULT distinct from a plain
      // ran-and-failed. Only stamp when true (keeps clean rows unchanged).
      ...(errored ? { errored: true } : {}),
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
 *   touches?: string[],                 // the story's `touches` — the module(s) UNDER TEST
 * }} args
 */
export async function runStoryBindings({
  acceptanceCriteria = [], headSha, executors = {}, now = () => new Date().toISOString(),
  cwd, readFile = nodeReadFile, enforceNoMock = true, touches = [],
}) {
  const exec = { ...DEFAULT_EXECUTORS, ...executors };
  const at = now();
  const out = [];
  let ran = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0; // F3: bindings whose executor reported a BINDING FAULT

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
    // NO-MOCK RULE (redesign Part 3 §1; NARROWED Incident D): a verify:'state' AC
    // bound to a unit/integration test must exercise the REAL module UNDER TEST —
    // it may not vi.mock/jest.mock the module it claims to verify (self-report).
    // It MAY mock a DEPENDENCY to build a fixture (e.g. a system test mocking the
    // foundation's ../maze for spawn points — that is legitimate isolation, not a
    // self-mock). Scope the check to the module under test: the bound test file's
    // sibling implementation OR a path in the story's `touches`. Statically check
    // the bound file BEFORE running: unreadable OR a mock of the module under test
    // ⇒ status:'misbound', do NOT run it.
    if (enforceNoMock && ac.verify === 'state' && (kind === 'unit' || kind === 'integration')) {
      // Check EACH resolved file (a state AC can bind multiple files). Using
      // resolveTestRefs also fixes the array-shape testRef: the old
      // testRefFile(tb.testRef) did String(['a','b']) → 'a,b' → ENOENT and
      // falsely misbound every multi-file state AC.
      const files = resolveTestRefs(tb.testRef);
      let misboundDetail;
      for (const file of (files.length ? files : [testRefFile(tb.testRef)])) {
        let source;
        let readErr;
        try {
          source = await readFile(cwd ? join(cwd, file) : file, 'utf8');
        } catch (err) {
          readErr = err;
        }
        // Narrow scope: pass the file being read (its sibling impl is under test)
        // plus the story's `touches`. A mock of a mere dependency now passes.
        const mock = source != null
          ? detectInRepoMock(source, { testFilePath: file, underTest: touches })
          : { violation: true, hits: [] };
        if (readErr || mock.violation) {
          const why = readErr ? '(file unreadable)' : mock.hits.join(', ');
          misboundDetail = `verify:'state' AC must exercise the real module — bound test ${file} mocks in-repo module(s): ${why} (no-mock rule) → misbound`;
          break;
        }
      }
      if (misboundDetail) {
        ran += 1;
        failed += 1;
        out.push(recordResult(ac, { passed: false, detail: misboundDetail }, headSha, at, 'misbound'));
        continue;
      }
    }
    // F2 (Incident C, C3): a verify:'build'/'typecheck' AC (or testKind:'typecheck')
    // is a COMPILE check — it must run the TYPECHECK executor (`tsc --noEmit`),
    // NEVER a unit vitest filename filter (which silently mis-runs it). EXCEPTION:
    // when the AC also carries runnable test-file refs, those bound files ARE the
    // check (a foundation AC "types compile AND buildInitialState returns idle" is
    // satisfied by its unit files; the pure tsc is additionally covered by the
    // foundation build gate), so run them via the vitest executor.
    const wantsTypecheck = ac.verify === 'build' || ac.verify === 'typecheck' || kind === 'typecheck';
    let runner;
    let routeFaultDetail;
    if (wantsTypecheck) {
      const hasRunnableTests = resolveTestRefs(tb.testRef).some((t) => TEST_FILE_RE.test(t));
      if (hasRunnableTests) {
        runner = exec.unit; // its bound test files satisfy it
      } else if (exec.typecheck) {
        runner = exec.typecheck;
      } else {
        // No typecheck executor wired AND no runnable refs — REFUSE to mis-route
        // a compile AC to a vitest filter (the C3 mislabel). Loud binding fault.
        routeFaultDetail = `verify:'${ac.verify || kind}' AC has no runnable test refs and no typecheck executor — refusing to mis-route to a vitest filter`;
      }
    } else {
      runner = exec[kind] || exec.unit;
    }
    if (routeFaultDetail) {
      ran += 1;
      failed += 1;
      errored += 1;
      out.push(recordResult(ac, { passed: false, errored: true, detail: routeFaultDetail }, headSha, at));
      continue;
    }
    let result;
    try {
      result = await runner(ac);
    } catch (err) {
      // A runner that THROWS could not execute the test → BINDING FAULT (errored),
      // not a clean ran-and-failed.
      result = { passed: false, errored: true, detail: `runner threw: ${err?.message || err}` };
    }
    ran += 1;
    if (result.passed) passed += 1; else failed += 1;
    if (result.errored) errored += 1;
    out.push(recordResult(ac, result, headSha, at));
  }

  return { acceptanceCriteria: out, summary: { ran, passed, failed, skipped, errored } };
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
  let errored = 0; // F3: validators that could not be EXECUTED (binding faults)

  for (const inv of invariants) {
    const v = inv?.validator || {};
    // fail-closed: nothing was authored to check this property. This is a BINDING
    // FAULT (the validator cannot be executed), distinct from a validator that
    // ran and failed — F3's error-vs-fail distinction, mirrored for invariants.
    if (v.status === 'declared' || !v.ref) {
      out.push(stampInvariant(inv, {
        status: 'failing',
        errored: true,
        detail: 'no authored validator (declared) — fail-closed',
        lastRunSha: headSha,
        lastRunAt: at,
      }));
      failed += 1;
      errored += 1;
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
      // Unreadable / mocking validator ⇒ cannot honestly execute ⇒ BINDING FAULT.
      out.push(stampInvariant(inv, {
        status: 'failing',
        errored: true,
        detail: readErr
          ? `validator ${v.ref} unreadable — fail-closed`
          : `validator ${v.ref} mocks in-repo module(s): ${mock.hits.join(', ')} (no-mock rule)`,
        lastRunSha: headSha,
        lastRunAt: at,
      }));
      failed += 1;
      errored += 1;
      continue;
    }
    // execute the authored validator.
    let result;
    try {
      result = await executor(inv);
    } catch (err) {
      // A validator that THROWS could not be executed → BINDING FAULT, not a
      // clean ran-and-failed.
      result = { passed: false, errored: true, detail: `validator threw: ${err?.message || err}` };
    }
    ran += 1;
    if (result?.passed) passed += 1; else failed += 1;
    if (result?.errored) errored += 1;
    out.push(stampInvariant(inv, {
      status: result?.passed ? 'passing' : 'failing',
      ...(result?.errored ? { errored: true } : {}),
      detail: result?.detail || v.detail,
      lastRunSha: headSha,
      lastRunAt: at,
    }));
  }

  return { invariants: out, summary: { ran, passed, failed, skipped, errored } };
}

/** Run a shell command, return { passed, detail } from the exit code. */
function runInvariantCommand(spawnSync, cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  // A spawn error means the validator could not be executed → BINDING FAULT.
  if (res.error) return { passed: false, errored: true, detail: `${cmd} error: ${res.error.message}` };
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
