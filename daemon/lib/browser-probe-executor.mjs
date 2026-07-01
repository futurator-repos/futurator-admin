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
  const { chromium } = playwright;
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
      const url = `http://127.0.0.1:${boot.port}${qaContext.healthcheckPath ?? '/'}`;
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
