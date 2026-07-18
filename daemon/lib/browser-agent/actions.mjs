// actions.mjs — Action schema, validation, and xdotool→Playwright/CDP key maps
// for the computer-use tool.
//
// VENDORED from the operator's BrowserAgent project:
//   ~/GetReal/elevenLabsConcepts/BrowserAgent/server/executors/actions.js
// Copied verbatim (only the file extension changed to .mjs). Keep the action
// schema and key maps in lock-step with upstream — the computer-use tool spec
// depends on these exact strings.

// The action names mirror Anthropic's `computer_20251124` tool exactly. The agent
// loop passes tool input through untouched, so these are the strings we must accept.
export const ACTIONS = Object.freeze([
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "cursor_position",
]);

const ACTION_SET = new Set(ACTIONS);

// Actions that carry a target `coordinate: [x, y]`.
const NEEDS_COORDINATE = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "scroll",
  "left_click_drag",
]);

const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isCoordinatePair(c) {
  return Array.isArray(c) && c.length === 2 && isFiniteNumber(c[0]) && isFiniteNumber(c[1]);
}

/**
 * Validate a raw tool-input object.
 * @param {any} input
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateAction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "action input must be an object" };
  }
  const action = input.action;
  if (typeof action !== "string" || !ACTION_SET.has(action)) {
    return { ok: false, error: `unknown action: ${JSON.stringify(action)}` };
  }

  if (NEEDS_COORDINATE.has(action) && !isCoordinatePair(input.coordinate)) {
    return { ok: false, error: `${action} requires coordinate [x, y]` };
  }

  switch (action) {
    case "left_click_drag":
      if (!isCoordinatePair(input.start_coordinate)) {
        return { ok: false, error: "left_click_drag requires start_coordinate [x, y]" };
      }
      break;
    case "scroll":
      if (typeof input.scroll_direction !== "string" || !SCROLL_DIRECTIONS.has(input.scroll_direction)) {
        return { ok: false, error: "scroll requires scroll_direction of up|down|left|right" };
      }
      if (!isFiniteNumber(input.scroll_amount) || input.scroll_amount < 0) {
        return { ok: false, error: "scroll requires a non-negative scroll_amount" };
      }
      break;
    case "type":
      if (typeof input.text !== "string") {
        return { ok: false, error: "type requires text (string)" };
      }
      break;
    case "key":
      if (typeof input.text !== "string" || input.text.length === 0) {
        return { ok: false, error: "key requires text (non-empty string)" };
      }
      break;
    case "hold_key":
      if (typeof input.text !== "string" || input.text.length === 0) {
        return { ok: false, error: "hold_key requires text (non-empty string)" };
      }
      if (!isFiniteNumber(input.duration) || input.duration <= 0) {
        return { ok: false, error: "hold_key requires a positive duration (seconds)" };
      }
      break;
    case "wait":
      if (!isFiniteNumber(input.duration) || input.duration < 0) {
        return { ok: false, error: "wait requires a non-negative duration (seconds)" };
      }
      break;
    default:
      break;
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Key maps
// ---------------------------------------------------------------------------

// Build the letter/digit/function-key portions programmatically to stay concise.
function buildXdotoolToPw() {
  const map = {
    // Named keys → Playwright names
    Return: "Enter",
    Enter: "Enter",
    KP_Enter: "Enter",
    Escape: "Escape",
    Esc: "Escape",
    space: "Space",
    Space: "Space",
    Tab: "Tab",
    BackSpace: "Backspace",
    Backspace: "Backspace",
    Delete: "Delete",
    Del: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    Page_Up: "PageUp",
    Prior: "PageUp",
    Page_Down: "PageDown",
    Next: "PageDown",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    // Modifiers
    shift: "Shift",
    Shift: "Shift",
    ctrl: "Control",
    control: "Control",
    Control: "Control",
    alt: "Alt",
    Alt: "Alt",
    Meta: "Meta",
    super: "Meta",
    Super: "Meta",
    cmd: "Meta",
    Command: "Meta",
    // Misc printable named keys
    minus: "-",
    plus: "+",
    equal: "=",
    period: ".",
    comma: ",",
    slash: "/",
    backslash: "\\",
    semicolon: ";",
    apostrophe: "'",
    grave: "`",
    bracketleft: "[",
    bracketright: "]",
  };
  // Letters a-z pass through as-is (Playwright accepts single characters).
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(97 + i);
    map[ch] = ch;
  }
  // Digits 0-9 pass through.
  for (let i = 0; i <= 9; i++) {
    map[String(i)] = String(i);
  }
  // Function keys F1-F12 pass through.
  for (let i = 1; i <= 12; i++) {
    map[`F${i}`] = `F${i}`;
  }
  return map;
}

export const XDOTOOL_TO_PW = Object.freeze(buildXdotoolToPw());

function cdp(key, code, vk) {
  return { key, code, windowsVirtualKeyCode: vk };
}

function buildXdotoolToCdp() {
  const map = {
    Return: cdp("Enter", "Enter", 13),
    Enter: cdp("Enter", "Enter", 13),
    KP_Enter: cdp("Enter", "NumpadEnter", 13),
    Escape: cdp("Escape", "Escape", 27),
    Esc: cdp("Escape", "Escape", 27),
    space: cdp(" ", "Space", 32),
    Space: cdp(" ", "Space", 32),
    Tab: cdp("Tab", "Tab", 9),
    BackSpace: cdp("Backspace", "Backspace", 8),
    Backspace: cdp("Backspace", "Backspace", 8),
    Delete: cdp("Delete", "Delete", 46),
    Del: cdp("Delete", "Delete", 46),
    Insert: cdp("Insert", "Insert", 45),
    Home: cdp("Home", "Home", 36),
    End: cdp("End", "End", 35),
    Page_Up: cdp("PageUp", "PageUp", 33),
    Prior: cdp("PageUp", "PageUp", 33),
    Page_Down: cdp("PageDown", "PageDown", 34),
    Next: cdp("PageDown", "PageDown", 34),
    Up: cdp("ArrowUp", "ArrowUp", 38),
    Down: cdp("ArrowDown", "ArrowDown", 40),
    Left: cdp("ArrowLeft", "ArrowLeft", 37),
    Right: cdp("ArrowRight", "ArrowRight", 39),
    // Modifiers
    shift: cdp("Shift", "ShiftLeft", 16),
    Shift: cdp("Shift", "ShiftLeft", 16),
    ctrl: cdp("Control", "ControlLeft", 17),
    control: cdp("Control", "ControlLeft", 17),
    Control: cdp("Control", "ControlLeft", 17),
    alt: cdp("Alt", "AltLeft", 18),
    Alt: cdp("Alt", "AltLeft", 18),
    super: cdp("Meta", "MetaLeft", 91),
    Super: cdp("Meta", "MetaLeft", 91),
    Meta: cdp("Meta", "MetaLeft", 91),
    cmd: cdp("Meta", "MetaLeft", 91),
    Command: cdp("Meta", "MetaLeft", 91),
    // Common punctuation
    minus: cdp("-", "Minus", 189),
    equal: cdp("=", "Equal", 187),
    period: cdp(".", "Period", 190),
    comma: cdp(",", "Comma", 188),
    slash: cdp("/", "Slash", 191),
    backslash: cdp("\\", "Backslash", 220),
    semicolon: cdp(";", "Semicolon", 186),
    apostrophe: cdp("'", "Quote", 222),
    grave: cdp("`", "Backquote", 192),
    bracketleft: cdp("[", "BracketLeft", 219),
    bracketright: cdp("]", "BracketRight", 221),
  };
  // Letters a-z: virtual key code is the uppercase ASCII value (65..90).
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    map[lower] = cdp(lower, `Key${upper}`, 65 + i);
  }
  // Digits 0-9: virtual key code 48..57.
  for (let i = 0; i <= 9; i++) {
    map[String(i)] = cdp(String(i), `Digit${i}`, 48 + i);
  }
  // Function keys F1-F12: virtual key code 112..123.
  for (let i = 1; i <= 12; i++) {
    map[`F${i}`] = cdp(`F${i}`, `F${i}`, 111 + i);
  }
  return map;
}

export const XDOTOOL_TO_CDP = Object.freeze(buildXdotoolToCdp());

// CDP modifier bitmask values (Input.dispatchKeyEvent `modifiers`).
const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_NAMES = new Set([
  "shift", "Shift",
  "ctrl", "control", "Control",
  "alt", "Alt",
  "super", "Super", "Meta", "cmd", "Command",
]);

function splitChord(xdotoolKey) {
  const raw = String(xdotoolKey);
  // A bare "+" is the plus key, not a separator.
  if (raw === "+") return ["plus"];
  const parts = raw.split("+").filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [raw];
}

/**
 * Convert an xdotool key/chord (e.g. "ctrl+s", "Return", "a") to a Playwright
 * key string (e.g. "Control+s", "Enter", "a") usable with keyboard.press().
 * @param {string} xdotoolKey
 * @returns {string}
 */
export function toPlaywrightKey(xdotoolKey) {
  const parts = splitChord(xdotoolKey);
  return parts
    .map((p) => XDOTOOL_TO_PW[p] ?? (p.length === 1 ? p : p))
    .join("+");
}

// Determine the printable text a key produces (for CDP `char` events), or null.
function printableText(mainName, shiftHeld) {
  const entry = XDOTOOL_TO_CDP[mainName];
  if (!entry) {
    return mainName.length === 1 ? mainName : null;
  }
  const k = entry.key;
  if (k === " ") return " ";
  if (k.length === 1) {
    // Letters honor shift; leave other single-char keys as their base glyph.
    if (/^[a-z]$/.test(k)) return shiftHeld ? k.toUpperCase() : k;
    return k;
  }
  return null;
}

/**
 * Convert an xdotool key/chord to an ordered array of CDP key-event param
 * objects for `Input.dispatchKeyEvent`. Modifiers are pressed first and
 * released last; the main key emits rawKeyDown, an optional char, then keyUp.
 * @param {string} xdotoolKey
 * @returns {Array<object>}
 */
export function toCdpEvents(xdotoolKey) {
  const parts = splitChord(xdotoolKey);
  const modifiers = [];
  let mainName = null;
  for (const p of parts) {
    if (MODIFIER_NAMES.has(p)) modifiers.push(p);
    else mainName = p;
  }

  const events = [];
  let mask = 0;

  const canonicalMod = (name) => XDOTOOL_TO_PW[name] ?? name; // → Shift/Control/Alt/Meta

  // Press modifiers (accumulating the bitmask).
  for (const m of modifiers) {
    const canon = canonicalMod(m);
    mask |= MOD_BIT[canon] ?? 0;
    const e = XDOTOOL_TO_CDP[m];
    if (e) events.push({ type: "rawKeyDown", ...e, modifiers: mask });
  }

  if (mainName !== null) {
    const e =
      XDOTOOL_TO_CDP[mainName] ??
      (mainName.length === 1
        ? cdp(mainName, `Key${mainName.toUpperCase()}`, mainName.toUpperCase().charCodeAt(0))
        : cdp(mainName, mainName, 0));
    events.push({ type: "rawKeyDown", ...e, modifiers: mask });

    // A `char` event only fires for printable keys with no non-shift modifier.
    const nonShiftModifiers = mask & ~MOD_BIT.Shift;
    const text = printableText(mainName, (mask & MOD_BIT.Shift) !== 0);
    if (text && !nonShiftModifiers) {
      events.push({ type: "char", text, ...e, modifiers: mask });
    }
    events.push({ type: "keyUp", ...e, modifiers: mask });
  }

  // Release modifiers in reverse order.
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const canon = canonicalMod(modifiers[i]);
    mask &= ~(MOD_BIT[canon] ?? 0);
    const e = XDOTOOL_TO_CDP[modifiers[i]];
    if (e) events.push({ type: "keyUp", ...e, modifiers: mask });
  }

  return events;
}
