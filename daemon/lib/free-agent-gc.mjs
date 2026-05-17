/**
 * free-agent-gc.mjs — Story 18.1 (Epic 18: Free Claude Code Agent)
 *
 * Daily garbage collection for free-agent worktrees.
 *
 * **Architectural note:** the GC was originally specified as an SST cron
 * Lambda (Story 18.1 AC #6). That doesn't work — Lambdas have no access to
 * the EC2 filesystem where worktrees live (`/home/ubuntu/free-agent-worktrees/`).
 * The GC therefore runs inside the daemon process as a throttled periodic
 * task, scheduled by `agent-daemon.mjs` (wired in Story 18.2 alongside the
 * session-table introduction). Effective behavior matches AC #6: a single
 * run per 24h, summarizing reaped + orphaned + kept counts.
 *
 * Inputs (all injectable for tests):
 *   - listProjectWorktrees() → returns Array<{projectId, sessionId, worktreePath}>
 *   - querySessionsScan() → returns Array<{sessionId, status, lastActivityAt}>
 *   - now() → current Date.now()-ish timestamp
 *   - logFn(level, msg, ctx) → daemon logger
 *   - reapFn({projectId, sessionId}) → from free-agent-worktree.mjs
 *
 * Reap policy (AC #6):
 *   - status IN ('IDLE','EXPIRED','BUDGET_EXHAUSTED') AND lastActivityAt > 7 days ago → reap
 *   - status IN ('ACTIVE','PROCESSING') → keep, regardless of age
 *   - no DDB row found for worktree → orphan, reap
 *
 * Returns: { reapedCount, orphansRemoved, kept, errors }
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync } from 'node:fs';
import { join } from 'node:path';

import { FREE_AGENT_WORKTREES_ROOT, reapWorktree } from '../pipelines/lib/free-agent-worktree.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses that prevent reaping regardless of age. */
const PROTECTED_STATUSES = new Set(['ACTIVE', 'PROCESSING']);

/** Statuses eligible for reaping after the age threshold. */
const REAPABLE_STATUSES = new Set(['IDLE', 'EXPIRED', 'BUDGET_EXHAUSTED']);

/**
 * Default filesystem-side worktree lister. Returns one entry per
 * <projectId>/<sessionId>/ pair found under the worktrees root.
 */
export function defaultListProjectWorktrees({
  worktreesRoot = FREE_AGENT_WORKTREES_ROOT,
  fs = { existsSync: fsExistsSync, readdirSync: fsReaddirSync },
} = {}) {
  if (!fs.existsSync(worktreesRoot)) return [];

  const out = [];
  const projectDirs = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  for (const projectDirent of projectDirs) {
    if (!projectDirent.isDirectory()) continue;
    const projectId = projectDirent.name;
    const projectPath = join(worktreesRoot, projectId);

    const sessionDirs = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const sessionDirent of sessionDirs) {
      if (!sessionDirent.isDirectory()) continue;
      out.push({
        projectId,
        sessionId: sessionDirent.name,
        worktreePath: join(projectPath, sessionDirent.name),
      });
    }
  }
  return out;
}

/**
 * Run the GC sweep. Returns a structured summary.
 *
 * Story 18.1 ships this function but the wiring (daemon loop integration) is
 * deferred to Story 18.2 — at which point the sessions table actually exists.
 * Without the session table, every worktree is classified as an orphan
 * (which is correct: no sessions = nothing to keep).
 */
export async function runFreeAgentGc({
  listProjectWorktrees = defaultListProjectWorktrees,
  querySessionsScan = async () => [],
  reapFn = reapWorktree,
  now = () => Date.now(),
  logFn = (level, msg, ctx) => console.log(`[${level}] free-agent-gc: ${msg}`, ctx || ''),
} = {}) {
  const startMs = now();
  const result = { reapedCount: 0, orphansRemoved: 0, kept: 0, errors: 0 };

  let worktrees;
  try {
    worktrees = listProjectWorktrees();
  } catch (err) {
    logFn('error', 'Failed to list worktrees', { error: String(err) });
    return { ...result, errors: 1 };
  }

  if (worktrees.length === 0) {
    logFn('info', 'No worktrees found; nothing to GC', { ...result });
    return result;
  }

  let sessions;
  try {
    sessions = await querySessionsScan();
  } catch (err) {
    // If the sessions table doesn't exist yet (pre-Story-18.2), treat all
    // worktrees as orphans (safe behavior: no sessions = clean everything).
    logFn('warn', 'Session scan failed; treating all worktrees as orphans', { error: String(err) });
    sessions = [];
  }

  // Build a lookup table for O(1) session resolution.
  const sessionsBySessionId = new Map();
  for (const session of sessions) {
    sessionsBySessionId.set(session.sessionId, session);
  }

  for (const wt of worktrees) {
    const session = sessionsBySessionId.get(wt.sessionId);

    if (!session) {
      // Orphan: no DDB row for this worktree.
      try {
        await reapFn({ projectId: wt.projectId, sessionId: wt.sessionId });
        result.orphansRemoved += 1;
        logFn('info', 'Removed orphan worktree', {
          projectId: wt.projectId,
          sessionId: wt.sessionId,
        });
      } catch (err) {
        result.errors += 1;
        logFn('error', 'Failed to remove orphan worktree', {
          projectId: wt.projectId,
          sessionId: wt.sessionId,
          error: String(err),
        });
      }
      continue;
    }

    // Protected status — keep regardless of age.
    if (PROTECTED_STATUSES.has(session.status)) {
      result.kept += 1;
      continue;
    }

    // Eligible only if status is reapable AND last activity is old enough.
    if (!REAPABLE_STATUSES.has(session.status)) {
      result.kept += 1;
      continue;
    }

    const lastActivityMs = Date.parse(session.lastActivityAt || '');
    const isOld = !Number.isNaN(lastActivityMs) && startMs - lastActivityMs > SEVEN_DAYS_MS;

    if (!isOld) {
      result.kept += 1;
      continue;
    }

    try {
      await reapFn({ projectId: wt.projectId, sessionId: wt.sessionId });
      result.reapedCount += 1;
      logFn('info', 'Reaped stale worktree', {
        projectId: wt.projectId,
        sessionId: wt.sessionId,
        status: session.status,
        ageMs: startMs - lastActivityMs,
      });
    } catch (err) {
      result.errors += 1;
      logFn('error', 'Failed to reap stale worktree', {
        projectId: wt.projectId,
        sessionId: wt.sessionId,
        error: String(err),
      });
    }
  }

  logFn('info', 'free-agent-gc.run', {
    reapedCount: result.reapedCount,
    orphansRemoved: result.orphansRemoved,
    kept: result.kept,
    errors: result.errors,
    elapsedMs: now() - startMs,
  });

  return result;
}
