// playwright-executor.mjs — Playwright (headless/headed Chromium) executor
// implementing the shared executor interface.
//
// VENDORED from the operator's BrowserAgent project:
//   ~/GetReal/elevenLabsConcepts/BrowserAgent/server/executors/playwrightExecutor.js
// Copied verbatim; the only change is the sibling import path (./actions.js →
// ./actions.mjs) and the file extension. The executor interface
// (start/execute/screenshot/getViewport/stop) is kept EXACTLY as upstream so the
// vendored agent loop drives it unchanged. `playwright` resolves from the
// daemon's own node_modules; the agentic-vqa runner imports this module lazily so
// a missing/broken Playwright install degrades that one journey rather than the
// whole daemon.
import { chromium } from "playwright";
import { validateAction, toPlaywrightKey } from "./actions.mjs";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const PIXELS_PER_SCROLL = 120; // one scroll "click" ≈ 120px, matching CDP wheel ticks
const SETTLE_MS = 300;
const LOAD_TIMEOUT_MS = 3000;
const GOTO_TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlaywrightExecutor {
  constructor() {
    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    this.lastX = 0;
    this.lastY = 0;
    this.viewport = { ...DEFAULT_VIEWPORT };
    // This executor owns the browser lifecycle (server launched it).
    this.ownsBrowser = true;
    this._stopped = false;
  }

  async start({ url, viewport, headed = false } = {}) {
    this.viewport = {
      width: viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: viewport?.height ?? DEFAULT_VIEWPORT.height,
    };
    this.lastX = Math.floor(this.viewport.width / 2);
    this.lastY = Math.floor(this.viewport.height / 2);

    this.browser = await chromium.launch({ headless: !headed });
    this.context = await this.browser.newContext({
      viewport: { ...this.viewport },
      deviceScaleFactor: 1,
    });
    this.page = await this.context.newPage();

    if (url) {
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        // Navigation timeout / slow page is non-fatal; the agent works with whatever loaded.
        console.log("[executor-pw] goto non-fatal error:", err?.message ?? err);
      }
    }
    return { ok: true };
  }

  _ensurePage() {
    if (!this.page) throw new Error("executor not started (no page)");
    return this.page;
  }

  async screenshot() {
    const page = this._ensurePage();
    const buf = await page.screenshot({ type: "png" });
    return buf.toString("base64");
  }

  // The model's coordinate space. Playwright renders at exactly this viewport,
  // so screenshots and input coordinates already map 1:1.
  async getViewport() {
    return { width: this.viewport.width, height: this.viewport.height };
  }

  // Wait briefly for the page to stabilize, then capture a fresh screenshot.
  async _settleAndShoot() {
    const page = this._ensurePage();
    await page.waitForLoadState("load", { timeout: LOAD_TIMEOUT_MS }).catch(() => {});
    await sleep(SETTLE_MS);
    return this.screenshot();
  }

  async execute(actionInput) {
    const check = validateAction(actionInput);
    if (!check.ok) return { ok: false, error: check.error };

    if (this._stopped || !this.page) {
      return { ok: false, error: "executor is not running" };
    }

    const page = this.page;
    const mouse = page.mouse;
    const keyboard = page.keyboard;
    const action = actionInput.action;

    try {
      switch (action) {
        case "screenshot": {
          // Just capture — no settle wait.
          const base64Png = await this.screenshot();
          return { ok: true, base64Png };
        }

        case "cursor_position": {
          // Reported as text, not a screenshot.
          return { ok: true, text: `${this.lastX},${this.lastY}` };
        }

        case "mouse_move": {
          const [x, y] = actionInput.coordinate;
          await mouse.move(x, y);
          this.lastX = x;
          this.lastY = y;
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "left_click":
        case "right_click":
        case "middle_click": {
          const [x, y] = actionInput.coordinate;
          const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
          await mouse.move(x, y);
          this.lastX = x;
          this.lastY = y;
          await mouse.click(x, y, { button });
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "double_click": {
          const [x, y] = actionInput.coordinate;
          await mouse.move(x, y);
          this.lastX = x;
          this.lastY = y;
          await mouse.dblclick(x, y);
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "triple_click": {
          const [x, y] = actionInput.coordinate;
          await mouse.move(x, y);
          this.lastX = x;
          this.lastY = y;
          await mouse.click(x, y, { clickCount: 3 });
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "left_click_drag": {
          const [sx, sy] = actionInput.start_coordinate;
          const [ex, ey] = actionInput.coordinate;
          await mouse.move(sx, sy);
          await mouse.down();
          await mouse.move(ex, ey, { steps: 20 });
          await mouse.up();
          this.lastX = ex;
          this.lastY = ey;
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "scroll": {
          const [x, y] = actionInput.coordinate;
          await mouse.move(x, y);
          this.lastX = x;
          this.lastY = y;
          const amount = Number(actionInput.scroll_amount) * PIXELS_PER_SCROLL;
          const dir = actionInput.scroll_direction;
          let dx = 0;
          let dy = 0;
          if (dir === "down") dy = amount;
          else if (dir === "up") dy = -amount;
          else if (dir === "right") dx = amount;
          else if (dir === "left") dx = -amount;
          await mouse.wheel(dx, dy);
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "type": {
          await keyboard.type(actionInput.text);
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "key": {
          await keyboard.press(toPlaywrightKey(actionInput.text));
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "hold_key": {
          const pwKey = toPlaywrightKey(actionInput.text);
          await keyboard.down(pwKey);
          await sleep(Number(actionInput.duration) * 1000);
          await keyboard.up(pwKey);
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        case "wait": {
          await sleep(Number(actionInput.duration) * 1000);
          return { ok: true, base64Png: await this._settleAndShoot() };
        }

        default:
          return { ok: false, error: `unsupported action: ${action}` };
      }
    } catch (err) {
      return { ok: false, error: err?.message ? String(err.message) : String(err) };
    }
  }

  async stop() {
    // Tolerant of being called more than once and of a browser that closed itself.
    this._stopped = true;
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Already closed or crashed — nothing more to do.
      }
    }
  }
}

export default PlaywrightExecutor;
