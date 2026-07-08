// boot-liveness — the generic "the app is actually interactive" reality probe
// (redesign Part 2 P1 ③, Part 4 skill). Boots headless against a served URL,
// waits for the window.__harness seam, snapshots the initial state, replays a
// small ordered battery of synthetic user inputs, and asserts that AT LEAST ONE
// input produces an observable state delta. This is the gate that would have
// caught the pacman6 wall-locked-spawn bug at story 1, day 0.
//
// HONESTY CONTRACT — a reality gate must NEVER pass unobserved. Unlike the QA
// journey runner (which degrades a broken browser rig to 'uncertain'), boot-
// liveness has NO infra-skip: a chromium/launch error, an absent seam, or an
// inert app all return { passed:false }. The only path to passed:true is a real,
// observed before→after state delta.
//
// The chromium launch + seam-wait pattern is deliberately REPLICATED (not
// imported) from browser-probe-executor.mjs: this module has a distinct verdict
// (delta-observed vs assertion-passed) and must stay importable/testable without
// playwright present. `playwright` is injected so it unit-tests with a fake page.

/**
 * The ordered synthetic-input battery. Kept small and generic so it fits any
 * interactive app: arrow/space/enter keys cover games and canvases; a click on
 * the first button covers start-screens, menus, and CRUD. Order matters — the
 * probe stops at the first input that moves state.
 * @returns {Array<{type:'key',key:string}|{type:'click',target:string}>}
 */
export function defaultLivenessInputs() {
  return [
    { type: 'key', key: 'ArrowRight' },
    { type: 'key', key: 'Space' },
    { type: 'key', key: 'Enter' },
    { type: 'key', key: 'ArrowDown' },
    { type: 'click', target: '__first_button__' },
  ];
}

/**
 * PURE: did the observable state change? Structural inequality via JSON.
 * @returns {boolean}
 */
export function snapshotDelta(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Replay one synthetic input against a live Playwright page. */
async function replayInput(page, input) {
  if (!input) return;
  if (input.type === 'key') {
    await page.keyboard.press(input.key);
    return;
  }
  if (input.type === 'click') {
    if (input.target === '__first_button__') {
      const loc = page.getByRole?.('button') ?? page.locator?.('button');
      if (loc) await loc.first().click();
      return;
    }
    const byRole = page.getByRole?.('button', { name: input.target, exact: false });
    if (byRole && (await byRole.count?.()) > 0) await byRole.first().click();
    else await page.getByText(input.target, { exact: false }).first().click();
  }
}

/**
 * Boot the served app headless and prove it is alive.
 *
 * Semantics (all FAIL CLOSED):
 *  - chromium unavailable / launch error → { passed:false, seamMounted:false }
 *  - window.__harness seam never mounts   → { passed:false, seamMounted:false }
 *  - no input produces a snapshot delta   → { passed:false, seamMounted:true }
 *  - ≥1 input produces a delta            → { passed:true,  seamMounted:true, before, after }
 *
 * @param {{ url:string, playwright:object, inputs?:Array<object>, timeoutMs?:number, log?:Function }} opts
 * @returns {Promise<{ passed:boolean, detail:string, seamMounted:boolean, before?:object, after?:object }>}
 */
export async function runBootLiveness({
  url,
  playwright,
  inputs = defaultLivenessInputs(),
  timeoutMs = 30_000,
  log = () => {},
}) {
  // Playwright is CommonJS: `await import('playwright')` exposes chromium on
  // `.default`, not top-level. Accept both the real dynamic-import shape and the
  // flat `{ chromium }` the tests inject.
  const chromium = playwright?.chromium ?? playwright?.default?.chromium;
  if (!chromium) {
    return { passed: false, seamMounted: false, detail: 'playwright chromium unavailable (import interop)' };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // 'load', not 'networkidle': a live app may keep long-lived connections that
    // never idle — the explicit __harness wait below is the real readiness gate.
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

    try {
      await page.waitForFunction(
        () => window.__harness && typeof window.__harness.snapshot === 'function',
        { timeout: 10_000 },
      );
    } catch {
      log('info', `[boot-liveness] ${url} → FAIL seam-not-mounted`);
      return { passed: false, seamMounted: false, detail: 'window.__harness seam not mounted on the served app' };
    }

    const before = await page.evaluate(() => window.__harness.snapshot());
    let after = before;
    let observed = false;
    for (const input of inputs) {
      try {
        await replayInput(page, input);
      } catch {
        // A single bad input (e.g. no button to click) must not abort the
        // battery — try the next input. Fail-closed only if NONE move state.
        continue;
      }
      after = await page.evaluate(() => window.__harness.snapshot());
      if (snapshotDelta(before, after)) {
        observed = true;
        break;
      }
    }

    if (!observed) {
      log('info', `[boot-liveness] ${url} → FAIL no-delta (${inputs.length} input(s) replayed)`);
      return {
        passed: false,
        seamMounted: true,
        detail: `no synthetic input produced an observable state delta (${inputs.length} input(s) tried)`,
        before,
        after,
      };
    }

    log('info', `[boot-liveness] ${url} → PASS (input produced an observable state delta)`);
    return { passed: true, seamMounted: true, detail: 'boot-liveness: input produced an observable state delta', before, after };
  } catch (err) {
    // A launch/navigation error is still a FAIL (no infra-skip for a reality
    // gate) — we never observed the app, so we must not pass it.
    return { passed: false, seamMounted: false, detail: `boot-liveness error: ${err?.message || err}` };
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* best-effort */
    }
  }
}
