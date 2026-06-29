// harness-cost-bridge — the ~10× under-report fix (development-plan §5.4).
//
// The daemon read cost from a single orchestrator `finalResult.total_cost_usd`,
// which misses every subagent's spend (≈10× under-report). The fix: EVERY Claude
// process (orchestrator + each subagent) runs the statusline-cost hook, writing
// its own authoritative spend to /tmp/harness-cost-{sessionId}.json. This module
// is the read side: `reconcile` sums all those files for a job's session tree,
// dedups by sessionId, and returns the TRUE total the cost gate should act on.
//
// Posture: fail-open. A missing dir or a corrupt file is a MISS (skip), never a
// throw — a cost-accounting blip must never wedge a plan.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const PREFIX = 'harness-cost-';

/** Canonical per-process cost file path for a session. */
export function harnessCostPath(sessionId, dir = tmpdir()) {
  return join(dir, `${PREFIX}${sessionId}.json`);
}

/** Write one process's authoritative spend. Best-effort; never throws. */
export function writeHarnessCost(sessionId, record, dir = tmpdir()) {
  const path = harnessCostPath(sessionId, dir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId, ...record }), 'utf8');
    return path;
  } catch {
    return null;
  }
}

/** Read one process's spend in USD. Missing/corrupt → null (a miss, not 0). */
export function readHarnessCost(sessionIdOrPath, dir = tmpdir()) {
  const path = sessionIdOrPath.endsWith('.json')
    ? sessionIdOrPath
    : harnessCostPath(sessionIdOrPath, dir);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const usd = Number(j.usd ?? j.total_cost_usd ?? j.totalCostUsd);
    return Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}

/**
 * Sum every harness-cost-*.json in `dir`, deduped by sessionId (the filename is
 * the dedup key — a re-run of the same session overwrites, never double-counts).
 *
 * @param {{ dir?: string, sessionIds?: string[] }} opts
 *   sessionIds: when provided, restrict the sum to this job's sessions; else all.
 * @returns {{ totalUsd: number, files: number, perSession: Record<string,number>, missed: number }}
 */
export function reconcile({ dir = tmpdir(), sessionIds = null } = {}) {
  const out = { totalUsd: 0, files: 0, perSession: {}, missed: 0 };
  let entries = [];
  try {
    entries = readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.json'));
  } catch {
    return out; // missing dir → fail-open with zero
  }
  const wanted = sessionIds ? new Set(sessionIds) : null;
  for (const file of entries) {
    const sessionId = file.slice(PREFIX.length, -'.json'.length);
    if (wanted && !wanted.has(sessionId)) continue;
    const usd = readHarnessCost(join(dir, file));
    if (usd == null) { out.missed += 1; continue; }
    out.perSession[sessionId] = usd; // dedup: last write per session wins
    out.files += 1;
  }
  out.totalUsd = Math.round(Object.values(out.perSession).reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  return out;
}

/**
 * Observe-mode helper: given the daemon's internally-metered total and the
 * reconciled harness total, return the gap (how badly the old path under-reports)
 * so the A/B channel can expose the ~10× and recalibrate the baseline before
 * enforce.
 */
export function reconcileGap(internalTotalUsd, reconciledTotalUsd) {
  const internal = Number(internalTotalUsd) || 0;
  const real = Number(reconciledTotalUsd) || 0;
  const ratio = internal > 0 ? Math.round((real / internal) * 100) / 100 : null;
  return { internal, real, deltaUsd: Math.round((real - internal) * 1e6) / 1e6, ratio };
}
