/**
 * free-agent-unification-migration.mjs — 2026-05-27.
 *
 * One-shot migration that runs on daemon startup:
 *   1. Delete /home/ubuntu/free-agent-worktrees/ entirely (the legacy root).
 *   2. Mark all ACTIVE/PROCESSING free-agent sessions as EXPIRED with
 *      errorReason='WORKTREE_UNIFICATION_MIGRATION'. Operator opens new
 *      chats; new sessions land on the unified path at
 *      /home/ubuntu/worktrees/<app>/_assist/<sidShort>/.
 *   3. Touch /var/lib/futurator-daemon/free-agent-unified.flag so
 *      subsequent restarts skip this.
 *
 * No file-level migration. Assist branches are local-only at this rung; nothing
 * persistable is lost. Operator inconvenience is "start a new chat" which is
 * near-zero for a half-dozen concurrent sessions at v1 scale.
 *
 * Idempotent. Safe to call any number of times — the sentinel short-circuits
 * subsequent runs; `rm -rf` on a non-existent dir is a no-op; marking an
 * already-EXPIRED row is rejected by the underlying transitionStatus
 * condition and counted under `markErrors` (acceptable noise on retry).
 *
 * See `docs/concepts/free-agent-unification.md` §3.7 + §5 risk register.
 */

import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

const OLD_ROOT = '/home/ubuntu/free-agent-worktrees';
const SENTINEL_DIR = '/var/lib/futurator-daemon';
const SENTINEL_PATH = `${SENTINEL_DIR}/free-agent-unified.flag`;

/**
 * @param {object} args
 * @param {object} args.sessionsRepo — facade with `listAllSessions` + `markError`
 * @param {(level: string, msg: string, ctx?: object) => void} args.log
 * @param {object} [args.fs] — { existsSync, rmSync, writeFileSync, mkdirSync } shim for tests
 * @param {string} [args.oldRoot]
 * @param {string} [args.sentinelPath]
 * @param {string} [args.sentinelDir]
 * @returns {Promise<{ran: boolean, reason?: string, rmStatus?: string, markedCount?: number, markErrors?: number}>}
 */
export async function maybeRunUnificationMigration({
  sessionsRepo,
  log = () => {},
  fs = { existsSync, rmSync, writeFileSync, mkdirSync },
  oldRoot = OLD_ROOT,
  sentinelPath = SENTINEL_PATH,
  sentinelDir = SENTINEL_DIR,
} = {}) {
  if (!sessionsRepo) {
    throw new Error('maybeRunUnificationMigration: sessionsRepo required');
  }
  if (fs.existsSync(sentinelPath)) {
    return { ran: false, reason: 'sentinel-present' };
  }
  log('info', '[unification-migration] starting one-shot migration');

  // ── Step 1: remove the old worktree root ───────────────────────────────
  let rmStatus = 'noop';
  if (fs.existsSync(oldRoot)) {
    try {
      fs.rmSync(oldRoot, { recursive: true, force: true });
      rmStatus = 'removed';
    } catch (err) {
      log('error', `[unification-migration] rm failed: ${err.message}`);
      rmStatus = `error: ${err.message}`;
    }
  }

  // ── Step 2: mark in-flight sessions EXPIRED ────────────────────────────
  let markedCount = 0;
  let markErrors = 0;
  try {
    const allSessions = await sessionsRepo.listAllSessions();
    for (const sess of allSessions) {
      if (sess.status === 'ACTIVE' || sess.status === 'PROCESSING') {
        try {
          await sessionsRepo.markError(sess.sessionId, 'WORKTREE_UNIFICATION_MIGRATION');
          markedCount++;
        } catch (err) {
          markErrors++;
          log(
            'warn',
            `[unification-migration] mark failed for ${sess.sessionId}: ${err.message}`,
          );
        }
      }
    }
  } catch (err) {
    log('error', `[unification-migration] sessions scan failed: ${err.message}`);
  }

  // ── Step 3: touch sentinel ─────────────────────────────────────────────
  try {
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(sentinelPath, `${new Date().toISOString()}\n`);
  } catch (err) {
    // Sentinel write is best-effort. Without it the migration re-runs on
    // every boot — idempotent in effect (subsequent runs find no old root
    // and no ACTIVE/PROCESSING rows), just noisy in logs.
    log('warn', `[unification-migration] sentinel write failed: ${err.message}`);
  }

  log(
    'info',
    `[unification-migration] complete: oldRoot=${rmStatus}, sessionsMarked=${markedCount}, markErrors=${markErrors}`,
  );
  return { ran: true, rmStatus, markedCount, markErrors };
}

// Exported for tests.
export const UNIFICATION_MIGRATION_DEFAULTS = {
  OLD_ROOT,
  SENTINEL_DIR,
  SENTINEL_PATH,
};
