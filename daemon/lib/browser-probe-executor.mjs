// browser-probe-executor — the `kind=browser` bound-AC executor (Pipeline-3,
// development-plan §5.5). Behavioral ACs assert `window.__harness.snapshot()`
// after driving the running app (reach/act/observe). Per-story this needs the
// app SERVED + a real browser, which the deterministic unit/typecheck executors
// can't provide — so `kind=browser` used to fail-closed. This wires the real
// thing: boot the dev server, drive Playwright through the AC's structured
// probe, assert the snapshot.
//
// HONESTY CONTRACT: this NEVER fake-passes. If the app won't boot, the seam
// isn't mounted, or the probe can't be interpreted, it returns { passed:false }
// with a reason. Only a real, asserted, passing snapshot returns passed:true.
//
// Playwright is imported LAZILY (inside the executor) so this module stays
// importable — and its pure parser stays testable — without playwright present.

import { bootDevServer as realBootDevServer, drainPort as realDrainPort } from './dev-server-boot.mjs';
import { defaultShellRunner as realShell } from './wave-merge-runner.mjs';

// ── Pure probe interpreter ──────────────────────────────────────────────────

/** Coerce a scalar token: 'true'/'false' → boolean, numeric → Number, else string. */
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && /^-?[\d.]+$/.test(v) && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Extract ordered actions from the `when` prose. */
function parseActions(src) {
  const found = [];
  let m;

  const keyRe = /(?:press(?:es|ing)?\s+(?:the\s+)?(\w+))|(?:keydown\s+code=['"]?(\w+)['"]?)/gi;
  while ((m = keyRe.exec(src))) found.push({ index: m.index, obj: { type: 'key', key: m[1] || m[2] } });

  const fsRe = /(?:forces?\s+status\s+to\s+['"](\w+)['"])|(?:forceStatus\(['"](\w+)['"]\))/gi;
  while ((m = fsRe.exec(src)))
    found.push({ index: m.index, obj: { type: 'harness', method: 'forceStatus', args: [m[1] || m[2]] } });

  const hRe = /__harness\.(\w+)\(([^)]*)\)/gi;
  while ((m = hRe.exec(src))) {
    if (m[1] === 'forceStatus') continue; // already captured above
    const args = m[2].trim()
      ? m[2].split(',').map((a) => coerce(a.trim().replace(/^['"]|['"]$/g, '')))
      : [];
    found.push({ index: m.index, obj: { type: 'harness', method: m[1], args } });
  }

  const wRe = /(\d+)\s*seconds?/gi;
  while ((m = wRe.exec(src))) found.push({ index: m.index, obj: { type: 'wait', ms: Number(m[1]) * 1000 } });

  return found.sort((a, b) => a.index - b.index).map((f) => f.obj);
}

/** Extract snapshot assertions from the `thenObservable` prose. */
function parseAssertions(src) {
  const out = [];
  for (const clause of src.split(/\s+and\s+|,\s*/i)) {
    let m;
    if ((m = clause.match(/snapshot(?:\(\))?\.?(\w+)\s+(?:is\s+)?greater than\s+([\d.]+)/i))) {
      out.push({ field: m[1], op: 'gt', value: Number(m[2]) });
    } else if ((m = clause.match(/snapshot(?:\(\))?\.?(\w+)\s+(?:is\s+)?less than\s+([\d.]+)/i))) {
      out.push({ field: m[1], op: 'lt', value: Number(m[2]) });
    } else if ((m = clause.match(/snapshot(?:\(\))?\.?(\w+)\s+is\s+true\b/i))) {
      out.push({ field: m[1], op: 'eq', value: true });
    } else if ((m = clause.match(/snapshot(?:\(\))?\.?(\w+)\s+is\s+false\b/i))) {
      out.push({ field: m[1], op: 'eq', value: false });
    } else if ((m = clause.match(/snapshot(?:\(\))?\.?(\w+)\s+equals?\s+['"]?([\w.-]+)['"]?/i))) {
      out.push({ field: m[1], op: 'eq', value: coerce(m[2]) });
    }
  }
  return out;
}

/**
 * Parse an AC's structured behavioral probe into ordered actions + assertions.
 * PURE and deterministic (no LLM). `interpretable:false` (with a reason) when no
 * snapshot assertion can be parsed — the executor fail-closes on that rather
 * than fake-passing an uninterpretable probe.
 *
 * @param {{ when?:string, thenObservable?:string, then?:string, text?:string }} ac
 * @returns {{ actions:object[], assertions:object[], interpretable:boolean, reason?:string }}
 */
export function parseProbe({ when, thenObservable, then, text } = {}) {
  const actionSrc = [when, text].find((s) => s && s.trim()) || '';
  const assertSrc = [thenObservable, then, text].find((s) => s && s.trim()) || '';
  const actions = parseActions(actionSrc);
  const assertions = parseAssertions(assertSrc);
  if (assertions.length === 0) {
    return { actions, assertions, interpretable: false, reason: `no snapshot assertion in "${assertSrc.slice(0, 80)}"` };
  }
  return { actions, assertions, interpretable: true };
}

// ── Browser execution (Playwright) ──────────────────────────────────────────

/**
 * Drive a served app through a parsed probe and assert its harness snapshot.
 * `playwright` is injected (`{ chromium }`) so this unit-tests with a fake.
 *
 * @returns {Promise<{ passed:boolean, detail:string }>}
 */
export async function runBrowserProbe({ url, actions = [], assertions = [], playwright, timeoutMs = 30_000, log = () => {} }) {
  // Playwright is CommonJS: `await import('playwright')` exposes chromium on
  // `.default`, NOT as a top-level named export (that's undefined). Accept both
  // shapes (real dynamic import, and the flat `{ chromium }` the tests inject).
  const chromium = playwright?.chromium ?? playwright?.default?.chromium;
  if (!chromium) return { passed: false, detail: 'playwright chromium unavailable (import interop)' };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    try {
      await page.waitForFunction(
        () => window.__harness && typeof window.__harness.snapshot === 'function',
        { timeout: 10_000 },
      );
    } catch {
      return { passed: false, detail: 'window.__harness seam not mounted on the served app' };
    }

    for (const a of actions) {
      if (a.type === 'key') await page.keyboard.press(a.key);
      else if (a.type === 'harness')
        await page.evaluate(({ m, args }) => window.__harness[m](...args), { m: a.method, args: a.args || [] });
      else if (a.type === 'wait') await page.waitForTimeout(a.ms);
    }

    const snap = await page.evaluate(() => window.__harness.snapshot());
    const failures = [];
    for (const as of assertions) {
      const actual = snap ? snap[as.field] : undefined;
      const ok =
        as.op === 'gt' ? Number(actual) > as.value : as.op === 'lt' ? Number(actual) < as.value : actual === as.value;
      if (!ok) failures.push(`snapshot.${as.field}=${JSON.stringify(actual)} not ${as.op} ${JSON.stringify(as.value)}`);
    }
    log('info', `[browser-probe] ${url} → ${failures.length ? 'FAIL' : 'PASS'} (${assertions.length} assertion(s))`);
    return {
      passed: failures.length === 0,
      detail: failures.length ? failures.join('; ') : `probe passed (${assertions.length} assertion(s))`,
    };
  } catch (err) {
    return { passed: false, detail: `browser probe error: ${err?.message || err}` };
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* best-effort */
    }
  }
}

/** Run one step's replayed action against a live Playwright page. */
async function replayAction(page, action) {
  if (!action) return;
  if (action.type === 'key') await page.keyboard.press(action.key);
  else if (action.type === 'harness')
    await page.evaluate(({ m, args }) => window.__harness[m](...args), { m: action.method, args: action.args || [] });
  else if (action.type === 'wait') await page.waitForTimeout(action.ms);
}

/** Assert a snapshot against a list of {field,op,value} assertions; returns failure strings. */
function assertSnapshot(snap, assertions = []) {
  const failures = [];
  for (const as of assertions) {
    const actual = snap ? snap[as.field] : undefined;
    const ok =
      as.op === 'gt' ? Number(actual) > as.value : as.op === 'lt' ? Number(actual) < as.value : actual === as.value;
    if (!ok) failures.push(`snapshot.${as.field}=${JSON.stringify(actual)} not ${as.op} ${JSON.stringify(as.value)}`);
  }
  return failures;
}

/**
 * Drive a REMOTE deployed url (plan.devUrl — QA-Review W2, NEVER a local dev
 * server: this must not import dev-server-boot or boot anything) through an
 * ordered sequence of journey steps, asserting the `window.__harness` snapshot
 * after each step's replayed action. Reuses the exact seam gate + honesty
 * contract as `runBrowserProbe` (seam-not-mounted → passed:false; a thrown/
 * uninterpretable run fails closed — never a fake-pass).
 *
 * Frame capture (before/after `page.screenshot()` Buffers per step) is
 * OPT-IN via `capture` so callers that don't need frames (and tests of the
 * unrelated `runBrowserProbe`/`makeBrowserExecutor` path) are unaffected.
 *
 * @param {{ url:string, steps:Array<{label:string, action?:object, assertions?:object[]}>,
 *   playwright:object, timeoutMs?:number, log?:Function, capture?:boolean }} opts
 * @returns {Promise<{ passed:boolean, detail:string, frames:Array<{stepLabel:string, before?:Buffer, after?:Buffer}> }>}
 */
export async function runBrowserJourney({
  url,
  steps = [],
  playwright,
  timeoutMs = 30_000,
  log = () => {},
  capture = false,
}) {
  const chromium = playwright?.chromium ?? playwright?.default?.chromium;
  // `infra:true` marks a failure of the TEST HARNESS itself (no browser, a
  // network/launch error) — distinct from a real app failure (seam not mounted,
  // a failed assertion). The QA runner routes infra failures to 'uncertain'
  // (non-blocking) so a broken test rig never false-blocks a working app; a real
  // app failure (no `infra` flag) still blocks.
  if (!chromium) return { passed: false, infra: true, detail: 'playwright chromium unavailable (import interop)', frames: [] };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // 'load', NOT 'networkidle': a deployed app may keep long-lived connections
    // (polling, websockets) that never go idle — this only needs the document +
    // the explicit __harness wait below, which is the real readiness signal.
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    try {
      await page.waitForFunction(
        () => window.__harness && typeof window.__harness.snapshot === 'function',
        { timeout: 10_000 },
      );
    } catch {
      return { passed: false, detail: 'window.__harness seam not mounted on the served app', frames: [] };
    }

    const frames = [];
    const failures = [];
    for (const step of steps) {
      const label = step?.label ?? '(unlabeled step)';
      const frame = { stepLabel: label };
      if (capture) frame.before = await page.screenshot();
      await replayAction(page, step?.action);
      if (capture) frame.after = await page.screenshot();
      if (capture) frames.push(frame);

      const snap = await page.evaluate(() => window.__harness.snapshot());
      const stepFailures = assertSnapshot(snap, step?.assertions);
      if (stepFailures.length) failures.push(`${label}: ${stepFailures.join('; ')}`);
    }

    log('info', `[browser-journey] ${url} → ${failures.length ? 'FAIL' : 'PASS'} (${steps.length} step(s))`);
    return {
      passed: failures.length === 0,
      detail: failures.length ? failures.join(' | ') : `journey passed (${steps.length} step(s))`,
      frames,
    };
  } catch (err) {
    // A launch/navigation/browser error is a harness/infra failure, not an app
    // verdict — mark infra so the runner degrades to 'uncertain', not a block.
    // (Note: the seam-not-mounted return above is deliberately NOT infra — that
    // IS a real app failure and must block.)
    return { passed: false, infra: true, detail: `browser journey error: ${err?.message || err}`, frames: [] };
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Build the `browser` executor for a story's worktree. Returns an
 * `async (ac) => { passed, detail }`. Deps are injectable for tests; production
 * defaults boot the real dev server + lazy-import real Playwright.
 *
 * @param {{ cwd:string, qaContext:object|undefined, deps?:object }} opts
 */
export function makeBrowserExecutor({ cwd, qaContext, deps = {} }) {
  const bootDevServer = deps.bootDevServer || realBootDevServer;
  const drainPort = deps.drainPort || realDrainPort;
  const shell = deps.shell || realShell;
  const log = deps.log || (() => {});
  // bootDevServer/wave-vqa call log with a single-arg message; adapt to (level,msg).
  const bootLog = (m) => { try { log('info', `[browser-probe:dev-server] ${m}`); } catch { /* best-effort */ } };
  const getPlaywright = deps.playwright ? async () => deps.playwright : async () => import('playwright');

  return async (ac) => {
    // Surface EVERY outcome to the daemon journal (grep `[browser-probe]`) so a
    // browser-AC failure is diagnosable — seam-not-mounted vs a named assertion
    // vs boot failure — instead of a silent `failing` on the story row.
    const done = (r) => {
      try {
        log('info', `[browser-probe] ac=${ac?.id ?? '?'} passed=${r.passed} :: ${r.detail || ''}`);
      } catch { /* best-effort */ }
      return r;
    };
    if (!qaContext) {
      return done({ passed: false, detail: 'browser AC needs a served app but no qaContext for this boilerplate' });
    }
    const probe = parseProbe({
      when: ac?.when,
      thenObservable: ac?.thenObservable,
      then: ac?.then,
      text: ac?.text || ac?.testBinding?.testRef,
    });
    if (!probe.interpretable) {
      return done({ passed: false, detail: `browser probe not interpretable: ${probe.reason}` });
    }

    const port = qaContext.defaultPort ?? 3000;
    let boot;
    try {
      boot = await bootDevServer({ cwd, qaContext, port, shell, log: bootLog });
      if (!boot?.ok) {
        return done({ passed: false, detail: `dev server did not boot (status=${boot?.status ?? 'unknown'})` });
      }
      // Navigate via `localhost`, NOT 127.0.0.1: Next.js 16 dev only allow-lists
      // `localhost` as a dev origin, so a 127.0.0.1 page has its /_next resources
      // cross-origin-blocked → the client never hydrates → the client-mounted
      // window.__harness never appears → false "seam not mounted". (Verified live:
      // 0.0.0.0-served app, 127.0.0.1 → harness absent, localhost → harness present.)
      const url = `http://localhost:${boot.port}${qaContext.healthcheckPath ?? '/'}`;
      const playwright = await getPlaywright();
      return done(await runBrowserProbe({ url, actions: probe.actions, assertions: probe.assertions, playwright, log }));
    } catch (err) {
      return done({ passed: false, detail: `browser probe error: ${err?.message || err}` });
    } finally {
      try {
        if (boot?.stop) await boot.stop();
        else await drainPort({ port, shell, cwd });
      } catch {
        /* best-effort */
      }
    }
  };
}
