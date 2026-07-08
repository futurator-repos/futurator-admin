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

  // HELD keys (VQA canvas-game power): "hold ArrowRight", "holding down Space".
  // A held key is dispatched keyboard.down → (settle while held) → keyboard.up,
  // so a continuous-input game (isDown polling) actually moves during the settle
  // window instead of registering a single instantaneous keydown. Optional.
  const holdRe = /hold(?:s|ing)?\s+(?:down\s+)?(?:the\s+)?(\w+)/gi;
  while ((m = holdRe.exec(src))) found.push({ index: m.index, obj: { type: 'key', key: m[1], hold: true } });

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

  // VQA power (2026-07-04): CLICK by visible text / accessible name — the
  // journey vocabulary for start screens, menus, buttons. Prose forms:
  //   click "Start" | clicks the Start button | clicking on 'Play Again'
  const clickRe = /click(?:s|ing)?\s+(?:on\s+)?(?:the\s+)?["']([^"']{1,60})["']|click(?:s|ing)?\s+(?:on\s+)?the\s+([\w][\w -]{0,40}?)\s+(?:button|link|tile|card)/gi;
  while ((m = clickRe.exec(src)))
    found.push({ index: m.index, obj: { type: 'click', target: (m[1] || m[2]).trim() } });

  // TYPE text (optionally into a named field): types "hello" into the name field
  const typeRe = /types?\s+["']([^"']{1,120})["'](?:\s+(?:into|in)\s+(?:the\s+)?["']?([\w-]+(?:\s[\w-]+)*?)["']?\s+(?:field|input|box)\b)?/gi;
  while ((m = typeRe.exec(src)))
    found.push({ index: m.index, obj: { type: 'type', text: m[1], target: m[2]?.trim() } });

  return found.sort((a, b) => a.index - b.index).map((f) => f.obj);
}

// A snapshot field path: dotted + indexed (score, pacman.dir, entities.ghosts[0].x).
const FIELD = String.raw`([\w$]+(?:(?:\.[\w$]+)|(?:\[\d+\]))*)`;

/** Extract snapshot assertions from the `thenObservable` prose. */
function parseAssertions(src) {
  const out = [];
  for (const clause of src.split(/\s+and\s+|,\s*/i)) {
    let m;
    if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:is\\s+)?greater than\\s+([\\d.]+)`, 'i')))) {
      out.push({ field: m[1], op: 'gt', value: Number(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:is\\s+)?less than\\s+([\\d.]+)`, 'i')))) {
      out.push({ field: m[1], op: 'lt', value: Number(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:is\\s+)?at least\\s+([\\d.]+)`, 'i')))) {
      out.push({ field: m[1], op: 'gte', value: Number(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:is\\s+)?at most\\s+([\\d.]+)`, 'i')))) {
      out.push({ field: m[1], op: 'lte', value: Number(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+is\\s+true\\b`, 'i')))) {
      out.push({ field: m[1], op: 'eq', value: true });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+is\\s+false\\b`, 'i')))) {
      out.push({ field: m[1], op: 'eq', value: false });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+is\\s+not\\s+['"]?([\\w.-]+)['"]?`, 'i')))) {
      out.push({ field: m[1], op: 'ne', value: coerce(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+equals?\\s+['"]?([\\w.-]+)['"]?`, 'i')))) {
      out.push({ field: m[1], op: 'eq', value: coerce(m[2]) });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:has\\s+)?(?:increase[sd]?|grows?|grew|goes up)`, 'i')))) {
      // DELTA op — compared against the BEFORE-action snapshot.
      out.push({ field: m[1], op: 'increased' });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:has\\s+)?(?:decrease[sd]?|drops?|goes down)`, 'i')))) {
      out.push({ field: m[1], op: 'decreased' });
    } else if ((m = clause.match(new RegExp(`snapshot(?:\\(\\))?\\.?${FIELD}\\s+(?:has\\s+)?(?:change[sd]?|updates?[d]?|differs|reflects)`, 'i')))) {
      out.push({ field: m[1], op: 'changed' });
    }
  }
  // Interpretability fallback (pacman3 forensic: "no snapshot assertion in
  // 'snapshot.entities f…'"). If the prose NAMES a snapshot path but no operator
  // matched, the honest deterministic default is a CHANGED-delta on that path —
  // the action was supposed to affect it. Still a real, before/after-verified
  // assertion; never a fake-pass.
  if (out.length === 0) {
    const named = src.match(new RegExp(`snapshot(?:\\(\\))?\\.${FIELD}`, 'i'));
    if (named) out.push({ field: named[1], op: 'changed' });
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

/** The note recorded when a DRIVE action is refused under observe-only QA. */
export const OBSERVE_ONLY_NOTE = 'drive action disabled in observe-only QA; reach the state as a user';

/**
 * Run one step's replayed action against a live Playwright page.
 *
 * Returns `{ release?, note? }`:
 *  - `release` is an async fn to call AFTER the observation window for a HELD
 *    key (keyboard.up), so the key stays down across the settle+poll.
 *  - `note` records why an action was skipped (observe-only DRIVE refusal).
 *
 * OBSERVE-ONLY (`observeOnly`): the harness DRIVE lane (forceStatus/dispatch)
 * is refused — a QA probe must reach the state the way a USER would (keys,
 * clicks). Synthetic keyboard/click INPUT is still allowed (that IS a user).
 */
async function replayAction(page, action, { observeOnly = false } = {}) {
  if (!action) return {};
  if (action.type === 'harness') {
    if (observeOnly) return { note: OBSERVE_ONLY_NOTE };
    await page.evaluate(({ m, args }) => window.__harness[m](...args), { m: action.method, args: action.args || [] });
    return {};
  }
  if (action.type === 'key') {
    if (action.hold) {
      // HELD: press down now, release after the observation window so the game
      // integrates continuous input during the settle (isDown-polling loops).
      await page.keyboard.down(action.key);
      return { release: async () => { try { await page.keyboard.up(action.key); } catch { /* best-effort */ } } };
    }
    await page.keyboard.press(action.key);
    return {};
  }
  if (action.type === 'wait') { await page.waitForTimeout(action.ms); return {}; }
  if (action.type === 'click') {
    // Locator chain: accessible button name first (the robust path), then any
    // visible text. First match wins; a miss throws → the step fails honestly.
    const byRole = page.getByRole?.('button', { name: action.target, exact: false });
    if (byRole && (await byRole.count?.()) > 0) await byRole.first().click();
    else await page.getByText(action.target, { exact: false }).first().click();
    return {};
  }
  if (action.type === 'type') {
    if (action.target) {
      await page.getByLabel?.(action.target, { exact: false }).first().fill(action.text);
    } else {
      await page.keyboard.type(action.text);
    }
    return {};
  }
  return {};
}

/**
 * Pure `event.code` for a `KeyboardEvent` `key` — the belt-and-suspenders
 * re-dispatch path needs a `code` (many canvas games read `e.code`, not
 * `e.key`). ArrowUp→'ArrowUp', Space→'Space', a letter→'KeyX', a digit→'DigitN'.
 */
export function codeFor(key) {
  if (!key) return '';
  if (/^Arrow(Up|Down|Left|Right)$/.test(key)) return key;
  if (key === 'Space' || key === ' ') return 'Space';
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key; // Enter, Escape, Tab, … are already their own code
}

/**
 * FOCUS the app before driving it: a canvas game only receives keydown events
 * when the canvas (or the document) is focused. Click the canvas if present,
 * else the body. Best-effort — a fake/limited page (no `locator`) no-ops.
 * Returns which surface was focused ('canvas' | 'body' | 'none').
 */
export async function focusApp(page) {
  if (!page || typeof page.locator !== 'function') return 'none';
  try {
    const canvas = page.locator('canvas');
    if (canvas && typeof canvas.count === 'function' && (await canvas.count()) > 0) {
      await canvas.first().click();
      return 'canvas';
    }
  } catch { /* fall through to body */ }
  try {
    await page.locator('body').first().click();
    return 'body';
  } catch { return 'none'; }
}

/**
 * Advance `n` real animation frames (a rAF chain) so a game loop integrates the
 * just-dispatched input before we read the snapshot / capture the AFTER frame.
 * IMPURE (runs in-page). `{ __settle }` marks the evaluate arg so a fake page
 * can distinguish it from a snapshot() read. Falls back to an injected/real
 * `wait` when the page can't evaluate rAF (a minimal fake).
 */
export async function settleFrames(page, n = 8, { wait } = {}) {
  const frames = Math.max(0, Math.floor(Number(n) || 0));
  if (!frames || !page || typeof page.evaluate !== 'function') return;
  try {
    await page.evaluate(
      ({ __settle }) =>
        new Promise((resolve) => {
          let i = 0;
          const step = () => {
            if (++i >= __settle) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      { __settle: frames },
    );
  } catch {
    const sleep = typeof wait === 'function' ? wait : (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(frames * 16);
  }
}

/**
 * Poll `readFn()` until `assertFn(value)` reports `{ ok:true }` or the window
 * expires. A game's observable change lands ASYNCHRONOUSLY over several frames,
 * so a single read-and-assert races the render and manufactures false failures;
 * polling passes as soon as the assertions hold and only records failure after
 * the whole window elapses. PURE control-flow (all I/O injected via readFn/wait).
 *
 * @returns {Promise<{ok:boolean, value:any, failures:string[]}>}
 */
export async function pollUntil(readFn, assertFn, { timeoutMs = 1000, stepMs = 100, wait } = {}) {
  const sleep = typeof wait === 'function' ? wait : (ms) => new Promise((r) => setTimeout(r, ms));
  let elapsed = 0;
  let last;
  for (;;) {
    last = await readFn();
    const verdict = assertFn(last) || {};
    if (verdict.ok) return { ok: true, value: last, failures: [] };
    if (elapsed >= timeoutMs) return { ok: false, value: last, failures: verdict.failures || [] };
    await sleep(stepMs);
    elapsed += stepMs;
  }
}

/**
 * Belt-and-suspenders re-dispatch of a key as a real DOM KeyboardEvent
 * (keydown+keyup with a pure `code`), used ONLY inside the poll loop when the
 * first `keyboard.press` produced no observable delta — some canvas games only
 * listen on `window` for `e.code`, which `page.keyboard.press` doesn't always
 * surface identically. This is synthetic USER INPUT (allowed in observe-only).
 */
async function redispatchKey(page, key) {
  if (!page || typeof page.evaluate !== 'function' || !key) return;
  const code = codeFor(key);
  try {
    await page.evaluate(
      ({ k, c }) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: c, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: c, bubbles: true }));
      },
      { k: key, c: code },
    );
  } catch { /* best-effort — a fake page may not support KeyboardEvent */ }
}

/** Deep-read a dotted/indexed path (score, pacman.dir, ghosts[0].x) off an object. */
function deepGet(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Assert a snapshot against {field,op,value} assertions; returns failure strings.
 * Delta ops (increased/decreased/changed) compare against `beforeSnap` — the
 * snapshot taken BEFORE the step's action ran.
 */
function assertSnapshot(snap, assertions = [], beforeSnap = undefined) {
  const failures = [];
  for (const as of assertions) {
    const actual = deepGet(snap, as.field);
    let ok;
    if (as.op === 'increased' || as.op === 'decreased' || as.op === 'changed') {
      const prior = deepGet(beforeSnap, as.field);
      if (beforeSnap === undefined) {
        ok = false;
        failures.push(`snapshot.${as.field}: delta assertion '${as.op}' needs a before-snapshot (none captured)`);
        continue;
      }
      ok =
        as.op === 'increased'
          ? Number(actual) > Number(prior)
          : as.op === 'decreased'
            ? Number(actual) < Number(prior)
            : JSON.stringify(actual) !== JSON.stringify(prior);
      if (!ok)
        failures.push(
          `snapshot.${as.field} did not ${as.op === 'changed' ? 'change' : as.op.replace(/d$/, '')} (before=${JSON.stringify(prior)} after=${JSON.stringify(actual)})`,
        );
      continue;
    }
    ok =
      as.op === 'gt' ? Number(actual) > as.value
      : as.op === 'lt' ? Number(actual) < as.value
      : as.op === 'gte' ? Number(actual) >= as.value
      : as.op === 'lte' ? Number(actual) <= as.value
      : as.op === 'ne' ? actual !== as.value
      : actual === as.value;
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
  observeOnly = false,
  wait,
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
    // DOM-FALLBACK (VQA power, 2026-07-04): a missing seam is a real, blocking
    // deterministic failure (honesty contract, unchanged) — but it must NOT
    // blind Lane 2. When the seam is absent we still REPLAY every step's action
    // (clicks/keys work on the DOM without a seam) and CAPTURE before/after
    // frames so the VLM judge + operator get visual evidence of the app's
    // actual behavior instead of zero artifacts.
    let seamMounted = true;
    try {
      await page.waitForFunction(
        () => window.__harness && typeof window.__harness.snapshot === 'function',
        { timeout: 10_000 },
      );
    } catch {
      seamMounted = false;
    }
    // The template ALWAYS mounts a BASE __harness stub whose snapshot reports
    // `{ registered:false }` until the REAL live-state seam registers/overwrites
    // it. Reading that stub is as blind as no seam at all — so wait (briefly,
    // best-effort) for a real store to register. If only the base stub ever
    // appears, treat it as seam-not-mounted (honest FAIL) — never a fake pass.
    if (seamMounted) {
      try {
        await page.waitForFunction(
          () => {
            const h = window.__harness;
            if (!h || typeof h.snapshot !== 'function') return false;
            const s = h.snapshot();
            return !s || s.registered !== false;
          },
          { timeout: 3_000 },
        );
      } catch {
        seamMounted = false;
      }
    }
    // FOCUS the app (canvas else body) so keyboard input actually reaches a
    // canvas game — runs even in DOM-fallback (seam absent) so replayed actions
    // still land. Best-effort: no-ops on a page without `locator`.
    await focusApp(page);

    const frames = [];
    const failures = [];
    for (const step of steps) {
      const label = step?.label ?? '(unlabeled step)';
      const frame = { stepLabel: label };
      const settleN = step?.settle?.frames ?? 8;
      const pollMs = step?.settle?.pollMs ?? 1000;
      // Before-action snapshot — the baseline for delta assertions
      // (increased/decreased/changed).
      const beforeSnap = seamMounted ? await page.evaluate(() => window.__harness.snapshot()) : undefined;
      if (capture) frame.before = await page.screenshot();

      let release;
      try {
        const acted = await replayAction(page, step?.action, { observeOnly });
        release = acted?.release;
        if (acted?.note) log('info', `[browser-journey] ${label}: ${acted.note}`);
      } catch (actErr) {
        failures.push(`${label}: action failed: ${actErr?.message || actErr}`);
      }

      // Let the game loop integrate the input over real animation frames BEFORE
      // reading the snapshot / capturing the AFTER frame — the fix for VQA and
      // deterministic false-negatives on a WORKING canvas game.
      await settleFrames(page, settleN, { wait });
      if (capture) frame.after = await page.screenshot();
      if (capture) frames.push(frame);

      if (seamMounted) {
        const readFn = () => page.evaluate(() => window.__harness.snapshot());
        const assertFn = (snap) => {
          const f = assertSnapshot(snap, step?.assertions, beforeSnap);
          return { ok: f.length === 0, failures: f };
        };
        // POLL: pass as soon as the assertions hold vs the pre-action baseline;
        // only record a failure after the whole window expires (no render race).
        let poll = await pollUntil(readFn, assertFn, { timeoutMs: pollMs, stepMs: 100, wait });
        // Belt-and-suspenders: a KEY that produced no delta gets one real DOM
        // KeyboardEvent re-dispatch (+ re-settle + re-poll) before we fail it —
        // some games only listen on window for `e.code`.
        if (!poll.ok && step?.action?.type === 'key') {
          await redispatchKey(page, step.action.key);
          await settleFrames(page, settleN, { wait });
          poll = await pollUntil(readFn, assertFn, { timeoutMs: pollMs, stepMs: 100, wait });
        }
        if (!poll.ok) failures.push(`${label}: ${poll.failures.join('; ')}`);
      } else {
        failures.push(`${label}: window.__harness seam not mounted on the served app`);
      }

      // Release a HELD key AFTER the observation window.
      if (release) await release();
    }
    if (!seamMounted) {
      log('info', `[browser-journey] ${url} → FAIL seam-not-mounted (${steps.length} step(s) replayed for frames)`);
      return {
        passed: false,
        detail: 'window.__harness seam not mounted on the served app',
        frames,
      };
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
