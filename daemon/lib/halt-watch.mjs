// halt-watch — mid-turn kill on the cost-ceiling sentinel (development-plan §5.4).
//
// The PostToolUse ceiling hook writes <workingDir>/.futurator/halt the instant
// reconciled spend reaches the ceiling in enforce mode. This module is the daemon
// side: detect the sentinel and signal the job's children so the run dies
// mid-turn rather than burning to the wave boundary. Reuses the existing
// child-tracker signal path. Fail-open + idempotent (clears the sentinel after
// acting so it fires once).

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function haltPath(dir) {
  return join(dir, '.futurator', 'halt');
}

/** Read the halt sentinel, or null when absent/unreadable. */
export function readHalt(dir, { fs = { existsSync, readFileSync } } = {}) {
  const p = haltPath(dir);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { reason: 'halt (unparseable sentinel)' }; }
}

/** Remove the halt sentinel. Best-effort. */
export function clearHalt(dir) {
  try { rmSync(haltPath(dir), { force: true }); } catch { /* best-effort */ }
}

/**
 * Check a job's workingDir for the halt sentinel and, if present, signal its
 * children to stop. Clears the sentinel so it fires exactly once.
 *
 * @param {{
 *   dir: string, jobId: string,
 *   signalChildren: (jobId:string, signal?:string)=>void,
 *   signal?: string, clear?: boolean,
 *   fs?: object,
 * }} args
 * @returns {{ halted: boolean, reason?: string }}
 */
export function checkAndSignalHalt({ dir, jobId, signalChildren, signal = 'SIGTERM', clear = true, fs }) {
  try {
    const halt = readHalt(dir, fs ? { fs } : undefined);
    if (!halt) return { halted: false };
    if (typeof signalChildren === 'function') signalChildren(jobId, signal);
    if (clear) clearHalt(dir);
    return { halted: true, reason: halt.reason };
  } catch (err) {
    return { halted: false, error: String(err?.message || err) };
  }
}
