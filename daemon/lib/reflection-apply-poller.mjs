/**
 * reflection-apply-poller.mjs — Skills Institution, Story 1.2 (2026-06-17).
 *
 * Closes the loop. The API confirm route (`POST /api/reflections/:slug/:id/
 * confirm`) only flips a reflection to `confirmed` — it can't touch the EC2
 * filesystem where the app repos live. This daemon-side ticker is the consumer
 * that actually LANDS a confirmed reflection: it scans for `confirmed` rows that
 * haven't been applied yet, runs `applyReflection` (which authors the app-evolved
 * SKILL.md, Gate-1-scanned, and commits), and stamps the landing record back on
 * the row.
 *
 * Mirrors the attention-poller pattern: pure tick logic, all I/O via injected
 * deps, so it unit-tests without a real DDB or daemon. Idempotency is two-layer:
 * the tick filters out rows already carrying `appliedAt`, AND `markApplied`'s
 * conditional write (`attribute_not_exists(appliedAt)`) is the load-bearing guard
 * if two ticks race.
 *
 * Outcome handling:
 *   applied  → stamp appliedAt + commitSha (done).
 *   failed   → stamp (incl. Gate-1 quarantine — a malicious body must NOT be
 *              retried forever). Operator can inspect applyError.
 *   deferred → stamp (promote-from-project isn't wired); avoids re-polling a
 *              row we knowingly can't land yet. Clearing appliedAt re-arms it.
 *   missing working dir → SKIP without stamping, so a later tick (after the repo
 *              is checked out) can retry.
 */

export const REFLECTION_APPLY_POLLER_INTERVAL_MS = 60_000;

/**
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.isPaused
 * @param {() => Promise<Array<object>>} deps.listConfirmed — confirmed rows
 *   (the poller filters out already-applied ones).
 * @param {(projectSlug: string) => (string | null)} deps.resolveWorkingDir —
 *   absolute path to the app repo, or null/'' if it isn't checked out yet.
 * @param {(args: object) => Promise<object>} deps.applyReflection
 * @param {(args: object) => Promise<object|null>} deps.markApplied
 * @param {(level: string, msg: string, ctx?: object) => void} [deps.log]
 */
export async function runReflectionApplyTick({
  isPaused,
  listConfirmed,
  resolveWorkingDir,
  applyReflection,
  markApplied,
  log = () => {},
}) {
  if (await isPaused()) return { applied: 0, failed: 0, deferred: 0, skipped: 0, reason: 'paused' };

  const rows = await listConfirmed();
  let applied = 0;
  let failed = 0;
  let deferred = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.appliedAt) {
      skipped += 1;
      continue;
    }
    const workingDir = resolveWorkingDir(row.projectSlug);
    if (!workingDir) {
      // Repo not checked out yet — skip WITHOUT stamping so a later tick retries.
      skipped += 1;
      log('warn', `[reflection-apply] ${row.id}: no working dir for ${row.projectSlug} — retry later`);
      continue;
    }

    let result;
    try {
      result = await applyReflection({
        workingDir,
        projectSlug: row.projectSlug,
        proposal: row,
        logFn: log,
      });
    } catch (err) {
      result = { status: 'failed', target: row.target, error: String(err?.message || err) };
    }

    const status = result?.status ?? 'failed';
    // 'noop'/'applied'/'failed'/'deferred' all stamp (terminal for this row);
    // only the missing-working-dir case above skips without a stamp.
    try {
      await markApplied({
        projectSlug: row.projectSlug,
        id: row.id,
        outcome: status,
        commitSha: result?.commitSha,
        error: result?.error || result?.reason,
      });
    } catch (err) {
      log('error', `[reflection-apply] markApplied failed for ${row.id}: ${err?.message || err}`);
    }

    if (status === 'applied') {
      applied += 1;
      log('info', `[reflection-apply] applied ${row.id} (${row.target}) → ${result?.commitSha?.slice(0, 8) ?? 'no-commit'}`);
    } else if (status === 'deferred') {
      deferred += 1;
    } else {
      failed += 1;
      log('warn', `[reflection-apply] ${status} ${row.id} (${row.target}): ${result?.reason || result?.error || ''}`);
    }
  }

  return { applied, failed, deferred, skipped };
}

/**
 * Start the recurring ticker. Returns a `{stop}` handle for graceful shutdown +
 * tests. First tick after a small delay so the daemon doesn't probe DDB during
 * startup.
 */
export function startReflectionApplyPoller(deps, options = {}) {
  const intervalMs = options.intervalMs ?? REFLECTION_APPLY_POLLER_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? 90_000;
  const log = deps.log ?? (() => {});
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const summary = await runReflectionApplyTick(deps);
      if (summary.applied > 0 || summary.failed > 0 || summary.deferred > 0) {
        log(
          'info',
          `[reflection-apply] tick: applied=${summary.applied} failed=${summary.failed} deferred=${summary.deferred} skipped=${summary.skipped}`,
        );
      }
    } catch (err) {
      log('error', `[reflection-apply] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, initialDelayMs);
  log(
    'info',
    `[reflection-apply] poller started; first tick in ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 1000)}s`,
  );
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
