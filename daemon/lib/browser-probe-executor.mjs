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
import { isRemapActive } from './path-remap.mjs';

// Remapped hosts only: concurrent story-dev jobs in ONE daemon each boot a QA
// dev server; on the shared default port the second boot finds a squatter
// (observed live: `status=squatter` on a 2/2-concurrency Mac). Each executor
// takes the next slot above the default. Fleet/EC2 (remap inactive) keeps the
// exact default-port behavior.
let portSlot = 0;

// Next.js 16 additionally enforces ONE dev server per project dir (a dev lock
// keyed on the cwd — the second boot exits "already running (PID …)" no matter
// the port; observed live as status=000 on port 3001 while 3000 served). So
// concurrent probes on the SAME checkout must serialize their whole
// boot→journey→stop critical section. Story parallelism is untouched — only
// the probe sections queue, and each holds the lock for well under a minute.
const cwdProbeLocks = new Map();
function withCwdProbeLock(cwd, fn) {
  const tail = cwdProbeLocks.get(cwd) || Promise.resolve();
  const run = tail.then(fn, fn);
  cwdProbeLocks.set(cwd, run.then(() => undefined, () => undefined));
  return run;
}

// ── Pure probe interpreter ──────────────────────────────────────────────────

/** Coerce a scalar token: 'true'/'false' → boolean, numeric → Number, else string. */
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && /^-?[\d.]+$/.test(v) && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

// Natural-language / shorthand → real DOM KeyboardEvent `key` name. A behavioral
// AC's prose says "holds the RIGHT arrow" or "press SPACE to jump" — the probe
// parser captures the bare word ('right'/'space'), but Playwright's
// `keyboard.down/press` only accepts real key names ('ArrowRight'/'Space') and
// THROWS `Unknown key: "right"` on the raw word (killing the very held-key
// feature this file adds). Normalize the captured word to the DOM name; unknown
// tokens (letters/digits/already-real names like 'Enter'/'ArrowUp') pass through.
const KEY_ALIASES = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  space: 'Space', spacebar: 'Space', spacebutton: 'Space',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  tab: 'Tab', shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete',
};
export function normalizeKeyName(raw) {
  if (!raw) return raw;
  const k = String(raw).trim();
  return KEY_ALIASES[k.toLowerCase()] || k;
}

// ── Boot-failure classification (R3, infra-attempt protection) ─────────────
//
// A story-level browser-AC failure is either an APP defect (the implementer's
// code is genuinely wrong — must consume a retry attempt) or an INFRA hiccup
// (dev server didn't come up, a squatter answered, the page timed out — the
// implementer's diff may be fine, burning an attempt on it is unfair and
// exactly the "5 attempts torched on host flake" class from the worklog).
// This is a PURE classifier over a boot/probe failure's shape — no I/O, no
// retry policy (that's infra-retry.mjs) — so story-dev-pipeline.mjs (R2's
// file) can call it without importing anything Playwright-shaped.
//
// Accepts either:
//   - a boot result `{ ok:false, status }` (from dev-server-boot.mjs), or
//   - a probe/executor result `{ passed:false, detail }`, or
//   - a bare detail string (e.g. `exec(ac)`'s `.detail`).
export function classifyProbeFailure(input) {
  const text = typeof input === 'string' ? input : String(input?.detail ?? '');
  const rawStatus = input && typeof input === 'object' && 'status' in input ? String(input.status) : undefined;
  const textStatusMatch = /status=([^)\s]+)/.exec(text);
  const status = rawStatus ?? textStatusMatch?.[1];

  if (status === 'squatter' || /squatter/i.test(text)) {
    return { infra: true, reason: 'port-squatter' };
  }
  if (status === '404') {
    return { infra: true, reason: 'boot-404' };
  }
  // A Playwright ACTION / LOCATOR / SELECTOR timeout is NOT an infra hiccup: it
  // means a control the AC drives never appeared or was never interactable —
  // the exact R2 "unwired control" APP defect. It must CONSUME an attempt, not
  // earn free non-consuming infra retries. Only a navigation / dev-server boot
  // timeout (page.goto, "did not boot … timeout") is infra. Distinguish the two
  // BEFORE the broad text match so an "action failed: … Timeout … waiting for
  // locator(…)" detail (pushed by runBrowserJourney) falls through to app-fail.
  const isActionTimeout =
    /action failed|waiting for (?:locator|selector)|locator\.|getBy(?:Role|Text|Label|TestId|Placeholder)/i.test(text);
  if (!isActionTimeout && /timeout|timed out/i.test(text)) {
    return { infra: true, reason: 'boot-timeout' };
  }
  if (status === '000' || status === 'unknown' || (!status && /did not boot/i.test(text))) {
    return { infra: true, reason: 'boot-000' };
  }
  return { infra: false, reason: 'app-fail' };
}

/** Extract ordered actions from the `when` prose. */
function parseActions(src) {
  const found = [];
  let m;

  const keyRe = /(?:press(?:es|ing)?\s+(?:the\s+)?(\w+))|(?:keydown\s+code=['"]?(\w+)['"]?)/gi;
  while ((m = keyRe.exec(src))) found.push({ index: m.index, obj: { type: 'key', key: normalizeKeyName(m[1] || m[2]) } });

  // HELD keys (VQA canvas-game power): "hold ArrowRight", "holding down Space".
  // A held key is dispatched keyboard.down → (settle while held) → keyboard.up,
  // so a continuous-input game (isDown polling) actually moves during the settle
  // window instead of registering a single instantaneous keydown. Optional.
  // normalizeKeyName maps the captured word ('right'/'space') to the DOM key name
  // ('ArrowRight'/'Space') so keyboard.down never throws `Unknown key`.
  const holdRe = /hold(?:s|ing)?\s+(?:down\s+)?(?:the\s+)?(\w+)/gi;
  while ((m = holdRe.exec(src))) found.push({ index: m.index, obj: { type: 'key', key: normalizeKeyName(m[1]), hold: true } });

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
      // SETTLE WINDOW: honour the per-step hint, but FLOOR it whenever the action
      // is a key (held or not) regardless of the AC's declared `verify` tag — a
      // continuous-motion AC that the planner mistagged 'state' (or left untagged)
      // would otherwise fall back to the 2-frame/300ms window and reintroduce the
      // render race this redesign targets. The code-level signal (a key action)
      // wins over the model-authored tag.
      let settleN = step?.settle?.frames ?? 8;
      let pollMs = step?.settle?.pollMs ?? 1000;
      if (step?.action?.type === 'key') {
        settleN = Math.max(settleN, 12);
        pollMs = Math.max(pollMs, 1200);
      }
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
      // reading the snapshot — the fix for deterministic false-negatives on a
      // WORKING canvas game.
      await settleFrames(page, settleN, { wait });

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

      // AFTER frame — captured AFTER the deterministic poll window resolves (not
      // at the fixed settle mark) so the VQA judge sees the SAME settled state the
      // deterministic lane used to decide. A step whose true visual change lands
      // late (within the poll window) would otherwise get a stale 'after' frame
      // and a false VQA fail. Held keys are still down here (released below), so
      // the frame shows the app mid-interaction.
      if (capture) frame.after = await page.screenshot();
      if (capture) frames.push(frame);

      // Release a HELD key AFTER the observation window + after-frame.
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
 * Execute a single OBSERVE step (p3-journey-source.mjs `toObserveStep`): a
 * pure-appearance AC has no driving action and no deterministic assertion, so
 * the honest thing to do is navigate to the journey URL, let the app SETTLE, and
 * capture ONE "after" frame for the single-frame VQA judge. No actions, no
 * assertions, never a deterministic pass/fail — the runner judges the frame
 * VQA-primary (attention-only, never blocking; the advisory-taste contract).
 *
 * Two entry shapes (both supported for the runner's convenience):
 *  - REUSE an already-open page (part of a running journey): pass `page`; it
 *    only re-navigates if the page isn't already at `url`.
 *  - STANDALONE: pass `playwright`; this launches its own headless browser,
 *    navigates, captures, and closes it.
 *
 * Frame capture reuses the exact `page.screenshot()` path `runBrowserJourney`
 * uses. Returns `{ ok:true, frames:{ after:<Buffer> }, observe:true }` on success;
 * a launch/navigation/screenshot error returns `{ ok:false, observe:true,
 * infra:true, detail }` (honesty contract — never a fabricated frame).
 *
 * @param {{ url?:string, step?:{acId?:string,spec?:string,settleMs?:number}, page?:object,
 *   playwright?:object, settleMs?:number, timeoutMs?:number, log?:Function, wait?:Function }} opts
 * @returns {Promise<{ ok:boolean, observe:true, frames?:{after:Buffer}, acId?:string,
 *   spec?:string, infra?:boolean, detail?:string }>}
 */
export async function runObserveStep({
  url,
  step,
  page: providedPage,
  playwright,
  settleMs,
  timeoutMs = 30_000,
  log = () => {},
  wait,
} = {}) {
  const effectiveSettle = Number(step?.settleMs ?? settleMs ?? 1200) || 0;
  const acId = step?.acId;
  const spec = step?.spec;
  const sleep = typeof wait === 'function' ? wait : (ms) => new Promise((r) => setTimeout(r, ms));

  const settleAndShoot = async (page) => {
    // SETTLE: give the app a beat to paint (fonts/canvas/first render) before
    // the single frame — the same reason journeys settle before reading state.
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(effectiveSettle);
    else await sleep(effectiveSettle);
    // ONE frame, reusing the existing capture path.
    const after = await page.screenshot();
    log('info', `[browser-observe] ${acId ?? '?'} captured 1 frame after ${effectiveSettle}ms settle`);
    return { ok: true, observe: true, frames: { after }, acId, spec };
  };

  // REUSE path: an already-navigated page from a running journey.
  if (providedPage) {
    try {
      const alreadyThere = url && typeof providedPage.url === 'function' ? providedPage.url() === url : true;
      if (url && !alreadyThere) await providedPage.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      return await settleAndShoot(providedPage);
    } catch (err) {
      return { ok: false, observe: true, infra: true, detail: `observe step error: ${err?.message || err}`, acId, spec };
    }
  }

  // STANDALONE path: launch our own headless browser.
  const chromium = playwright?.chromium ?? playwright?.default?.chromium;
  if (!chromium) {
    return { ok: false, observe: true, infra: true, detail: 'playwright chromium unavailable (import interop)', acId, spec };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    return await settleAndShoot(page);
  } catch (err) {
    return { ok: false, observe: true, infra: true, detail: `observe step error: ${err?.message || err}`, acId, spec };
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Convert a parsed probe (ordered actions + assertions) into `runBrowserJourney`
 * steps: every action but the last becomes an assertion-less "pre" step so the
 * app still advances through the whole `when`, and the FINAL action carries the
 * assertions. Zero actions → one assertion-only step. PURE.
 */
function probeToJourneySteps(probe, { label, settle } = {}) {
  const actions = probe.actions?.length ? probe.actions : [null];
  const steps = [];
  for (let i = 0; i < actions.length - 1; i++) {
    steps.push({ label: `${label}__pre${i}`, action: actions[i], assertions: [], settle });
  }
  steps.push({ label, action: actions[actions.length - 1], assertions: probe.assertions, settle });
  return steps;
}

/**
 * Build the `browser` executor for a story's worktree. Returns an
 * `async (ac) => { passed, detail }`. Deps are injectable for tests; production
 * defaults boot the real dev server + lazy-import real Playwright.
 *
 * DRIVER (reality-spine review fix): the story-level completion gate now shares
 * the SAME hardened driver as wave QA — `runBrowserJourney` (focusApp +
 * settleFrames rAF advance + pollUntil settle-window + held-key + key-based
 * settle floor) — instead of the legacy single-read `runBrowserProbe`. That
 * closes the render race that made a genuinely-working continuous-movement AC
 * fail at story-completion time (the fail-closed `requiresBrowser` rule forces
 * every such AC onto this path, so it must be the hardened one). `observeOnly`
 * is FALSE here: story granularity may legitimately drive the harness to set up
 * a slice's precondition — the DRIVE-lane ban is a wave-QA probe policy, and
 * flipping it here would only ADD false-fails, the opposite of this fix's intent.
 *
 * @param {{ cwd:string, qaContext:object|undefined, deps?:object }} opts
 */
// 404-at-root dirty-config guard (I13/R3 root cause): a prior dev-deploy job
// patches a `basePath` into next.config.(ts|js|mjs) IN THE SHARED CHECKOUT
// and leaves it uncommitted, so every subsequent boot probes `/` against a
// basePath'd app and gets 404 forever — looking exactly like a real boot
// failure, burning attempts on nothing the implementer touched. This is a
// narrow, deterministic recovery: only reverts a config file that BOTH (a)
// declares a basePath and (b) is uncommitted per git status — never touches
// a committed basePath (that's a real app config, not drift). Fail-open by
// design: any exec/parse error just returns false and the caller falls back
// to the existing no-boot failure path unchanged.
const BASE_PATH_CONFIG_CANDIDATES = ['next.config.ts', 'next.config.js', 'next.config.mjs'];

/** Find an uncommitted config file that declares a `basePath`, or null. */
export async function findDirtyBasePathConfig({ cwd, shell }) {
  for (const file of BASE_PATH_CONFIG_CANDIDATES) {
    try {
      const statusResult = await shell(`git status --porcelain -- ${file} 2>/dev/null || true`, cwd, 10_000);
      if (!/\S/.test(statusResult?.stdout || '')) continue; // not present or clean
      const contentResult = await shell(`cat ${file} 2>/dev/null || true`, cwd, 10_000);
      if (!/basePath\s*[:=]/.test(contentResult?.stdout || '')) continue; // working copy has no basePath — unrelated dirt
      // ONLY uncommitted basePath DRIFT qualifies. If HEAD already declares a
      // basePath, the working-copy token is a real COMMITTED app config, not the
      // deploy job's leftover mutation — a `git checkout -- <file>` would then
      // (a) NOT remove the 404-causing basePath (checkout restores the committed
      // value) and (b) blow away any UNRELATED uncommitted edits to the same
      // file. Skip it so the invariant "never touches a committed basePath" holds
      // and the caller falls through to the pre-existing no-boot failure path.
      const headResult = await shell(`git show HEAD:./${file} 2>/dev/null || true`, cwd, 10_000);
      if (/basePath\s*[:=]/.test(headResult?.stdout || '')) continue; // committed basePath — not drift
      return file;
    } catch {
      // fail-open: treat this candidate as clean, keep scanning
    }
  }
  return null;
}

/**
 * Revert an uncommitted-basePath config via `git checkout --`. Returns true
 * only if a dirty basePath file was found AND reverted; false (no-op) on a
 * clean/committed config or any error — the caller must not retry the boot
 * unless this returns true.
 */
export async function revertDirtyBasePathConfig({ cwd, shell, log = () => {} }) {
  try {
    const file = await findDirtyBasePathConfig({ cwd, shell });
    if (!file) return false;
    log(`dirty-config: reverting uncommitted basePath (${file})`);
    await shell(`git checkout -- ${file}`, cwd, 10_000);
    return true;
  } catch {
    return false;
  }
}

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

    // Whole boot→journey→stop section runs under the per-cwd probe lock: Next
    // 16's dev lock allows one dev server per project dir (see cwdProbeLocks).
    return withCwdProbeLock(cwd, async () => {
    const port = (qaContext.defaultPort ?? 3000) + (isRemapActive() ? 1 + (portSlot++ % 40) : 0);
    let boot;
    try {
      boot = await bootDevServer({ cwd, qaContext, port, shell, log: bootLog });
      if (!boot?.ok && classifyProbeFailure(boot).reason === 'boot-404') {
        // 404-at-root guard: try the dirty-basePath revert ONCE, then retry
        // the boot ONCE. Any error inside falls open to the pre-existing
        // no-boot failure path below (never swallows a real failure).
        const reverted = await revertDirtyBasePathConfig({ cwd, shell, log: bootLog }).catch(() => false);
        if (reverted) {
          boot = await bootDevServer({ cwd, qaContext, port, shell, log: bootLog });
        }
      }
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
      // A continuous-motion (behavior) AC needs a real settle/poll window; the
      // key-based floor in runBrowserJourney widens it further for key actions.
      const settle = ac?.verify === 'behavior' ? { frames: 12, pollMs: 1200 } : undefined;
      const steps = probeToJourneySteps(probe, { label: ac?.id || 'story-ac', settle });
      const r = await runBrowserJourney({ url, steps, playwright, log, observeOnly: false });
      return done({ passed: r.passed, detail: r.detail });
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
    });
  };
}
