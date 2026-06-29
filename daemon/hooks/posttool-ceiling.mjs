// posttool-ceiling — mid-turn hard cost ceiling (development-plan §5.4).
//
// Registered as a PostToolUse hook on daemon spawns. After each tool call it
// reconciles the true spend (across orchestrator + subagents, via the harness-
// cost bridge) and compares it to the ceiling:
//   • < 0.8×        → allow, silent
//   • ≥ 0.8× < 1×   → warn (stderr advisory)
//   • ≥ 1×          → in enforce mode, drop a `.futurator/halt` sentinel that the
//                     daemon watches to kill the run mid-turn; in observe mode,
//                     just log the breach (recalibration data, never blocks).
//
// This makes the ceiling MID-TURN rather than only at the wave boundary — the
// difference between a $14-reported overrun and the real $147 one. Fail-open.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile } from '../lib/harness-cost-bridge.mjs';

/** Pure decision: where does `spend` sit relative to `ceiling`? */
export function decideCeiling({ spend, ceiling, warnAt = 0.8 }) {
  const c = Number(ceiling);
  if (!Number.isFinite(c) || c <= 0) return { action: 'allow', spend, ceiling: c, fraction: 0 };
  const fraction = Math.round((spend / c) * 100) / 100;
  if (spend >= c) return { action: 'halt', spend, ceiling: c, fraction };
  if (spend >= c * warnAt) return { action: 'warn', spend, ceiling: c, fraction };
  return { action: 'allow', spend, ceiling: c, fraction };
}

/** Write the halt sentinel the daemon watches. Best-effort; returns the path. */
export function writeHalt(haltDir, reason) {
  const path = join(haltDir, '.futurator', 'halt');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ reason, at: new Date().toISOString() }), 'utf8');
    return path;
  } catch {
    return null;
  }
}

export function main(env = process.env) {
  try {
    const mode = (env.FUTURATOR_COST_CEILING || 'off').toLowerCase(); // off | observe | enforce
    if (mode === 'off') return 0;

    const ceiling = Number(env.FUTURATOR_COST_CEILING_USD);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;

    // session-scoped reconcile when the job's sessions are known; else all.
    const sessionIds = (env.FUTURATOR_SESSION_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const dir = env.FUTURATOR_HARNESS_COST_DIR || undefined;
    const { totalUsd } = reconcile({ dir, sessionIds: sessionIds.length ? sessionIds : null });

    const d = decideCeiling({ spend: totalUsd, ceiling });
    if (d.action === 'allow') return 0;

    if (d.action === 'warn') {
      process.stderr.write(`[cost-ceiling] WARN spend $${totalUsd.toFixed(2)} at ${Math.round(d.fraction * 100)}% of $${ceiling.toFixed(2)}\n`);
      return 0;
    }

    // halt
    if (mode === 'enforce') {
      const haltDir = env.FUTURATOR_HALT_DIR || process.cwd();
      writeHalt(haltDir, `cost ceiling $${ceiling.toFixed(2)} reached (spend $${totalUsd.toFixed(2)})`);
      process.stderr.write(`[cost-ceiling] HALT spend $${totalUsd.toFixed(2)} ≥ ceiling $${ceiling.toFixed(2)} — sentinel written\n`);
      // exit 2 surfaces the breach to the model; the daemon's halt-watch does the kill.
      return 2;
    }
    process.stderr.write(`[cost-ceiling] would-halt (observe) spend $${totalUsd.toFixed(2)} ≥ ceiling $${ceiling.toFixed(2)}\n`);
    return 0;
  } catch {
    return 0; // fail-open
  }
}

// stdin isn't needed for the decision (we reconcile from disk), but drain it so
// the hook contract is satisfied.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  process.exit(main());
}
