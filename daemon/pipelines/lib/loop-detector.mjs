// Pipeline v1 — Story 1.3. Loop detector.
//
// Per-step monitor that hashes (toolName, sortedArgs) tuples emitted by an
// agent and detects thrashing — the dino3-style "search playwright every-
// where" pattern. Intervenes at two thresholds:
//
//   - HINT_AT (default 4): surface a hint suggesting ---ESCALATE---
//   - FORCE_AT (default 6): force-escalate; daemon kills the subprocess and
//     transitions the job to NEEDS_ATTENTION with triggeredBy=LOOP_DETECTED
//
// Sliding window (default 10) keeps memory O(window). Per-step instance —
// state never bleeds across steps so a legitimate retry on a new step does
// not inherit the previous step's history.
//
// Hash function: sha1(toolName + JSON.stringify(deepSort(args))). Args are
// sorted by key recursively to canonicalize {a:1,b:2} === {b:2,a:1}.

import { createHash } from 'node:crypto';

const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_HINT_AT = 4;
const DEFAULT_FORCE_AT = 6;

export const LOOP_HINT_MESSAGE =
  'You appear to be retrying the same operation. If you cannot find a different approach, please escalate via ---ESCALATE---.';

/**
 * Read env-var-overridable defaults at the time the detector is created.
 * Reading lazily lets tests override without tearing down the module cache.
 */
function readConfigFromEnv(overrides = {}) {
  const env = process.env || {};
  return {
    windowSize: clampInt(overrides.windowSize ?? env.LOOP_DETECTOR_WINDOW_SIZE, DEFAULT_WINDOW_SIZE, 1),
    hintAt: clampInt(overrides.hintAt ?? env.LOOP_DETECTOR_HINT_AT, DEFAULT_HINT_AT, 1),
    forceAt: clampInt(overrides.forceAt ?? env.LOOP_DETECTOR_FORCE_AT, DEFAULT_FORCE_AT, 1),
  };
}

function clampInt(value, fallback, min) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Deep-sort: returns a new structure where every plain object's keys are
 * lexicographically ordered. Arrays preserve order (order is meaningful
 * for tool args). Primitives are returned as-is. Cycles are not expected
 * in tool-input payloads.
 */
function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = deepSort(value[key]);
    }
    return sorted;
  }
  return value;
}

export function hashToolCall(toolName, args) {
  const canonical = JSON.stringify({ tool: toolName, args: deepSort(args ?? {}) });
  return createHash('sha1').update(canonical).digest('hex');
}

/**
 * Per-step loop detector. Construct one per Claude spawn; discard on step
 * boundary. The class is intentionally tiny — observation, count, decision.
 * Daemon-side actions (hint injection, force-kill) are owned by the caller.
 */
export class LoopDetector {
  constructor(opts = {}) {
    const { windowSize, hintAt, forceAt } = readConfigFromEnv(opts);
    this.windowSize = windowSize;
    this.hintAt = hintAt;
    this.forceAt = forceAt;
    /** @type {string[]} sliding window of hashes, newest at end */
    this.window = [];
    /** Hashes that have already triggered a 'hint' so we don't re-hint repeatedly */
    this.hinted = new Set();
    /** True after force-escalate fires once; subsequent observes are no-ops */
    this.forced = false;
  }

  /**
   * Observe one tool-use event. Returns the action the caller should take.
   *
   * @param {string} toolName
   * @param {object} args
   * @returns {{ action: 'continue' | 'hint' | 'force-escalate', repeatCount: number, hash: string, hintMessage?: string, repeatedToolCall?: { toolName: string, args: object } }}
   */
  observe(toolName, args) {
    if (this.forced) {
      return { action: 'continue', repeatCount: 0, hash: '' };
    }
    const hash = hashToolCall(toolName, args);
    this.window.push(hash);
    if (this.window.length > this.windowSize) this.window.shift();

    const repeatCount = this.window.filter((h) => h === hash).length;

    if (repeatCount >= this.forceAt) {
      this.forced = true;
      return {
        action: 'force-escalate',
        repeatCount,
        hash,
        repeatedToolCall: { toolName, args },
      };
    }
    if (repeatCount >= this.hintAt && !this.hinted.has(hash)) {
      this.hinted.add(hash);
      return {
        action: 'hint',
        repeatCount,
        hash,
        hintMessage: LOOP_HINT_MESSAGE,
      };
    }
    return { action: 'continue', repeatCount, hash };
  }
}
