// statusline-cost — per-process authoritative spend writer (development-plan §5.4).
//
// Registered as the `statusLine` hook on every daemon Claude spawn (orchestrator
// AND subagents). Claude Code invokes the statusLine command each turn with a
// JSON blob on stdin that carries `session_id` + a `cost` object. This hook
// persists THIS process's spend to /tmp/harness-cost-{sessionId}.json so the
// harness-cost bridge can later sum every process and recover the true total
// (the ~10× under-report fix). It also prints a one-line status to stdout (what
// the status line renders). Best-effort, fail-open — a status hook must never
// break the turn.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeHarnessCost } from '../lib/harness-cost-bridge.mjs';

/** Pull session id + cumulative USD out of a statusLine payload. */
export function extractCost(input = {}) {
  const sessionId = input.session_id || input.sessionId || 'nosession';
  const usd = Number(
    input.cost?.total_cost_usd ??
      input.total_cost_usd ??
      input.cost?.totalCostUsd ??
      0,
  );
  return { sessionId, usd: Number.isFinite(usd) ? usd : 0 };
}

/** Pure core: persist spend, return the status line string. */
export function processStatusline(input, { dir, role } = {}) {
  const { sessionId, usd } = extractCost(input);
  writeHarnessCost(sessionId, { usd, role: role || input.role || '', at: new Date().toISOString() }, dir);
  return `💰 $${usd.toFixed(4)}${role ? ` · ${role}` : ''}`;
}

export function main(env = process.env) {
  try {
    let raw = '';
    try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    let input = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
    const dir = env.FUTURATOR_HARNESS_COST_DIR || undefined;
    process.stdout.write(processStatusline(input, { dir, role: env.FUTURATOR_AGENT_ROLE }) + '\n');
    return 0;
  } catch {
    return 0; // fail-open
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // statusLine hooks read stdin synchronously above; main handles it.
  process.exit(main());
}
