/**
 * cancel-poller.mjs — Story 19.2 (party-push Epic 19 shared substrate).
 *
 * Extracted from `daemon/pipelines/free-agent-session.mjs` so both free-agent
 * sessions AND party-mode turns (Story 20.7) share one cancel-flag polling
 * primitive. Identical semantics, only the repo + sessionId differ.
 *
 * Contract:
 *   - Caller spawns a child process and passes it to `startCancelPoller`.
 *   - Poller reads the session row every `pollMs` and checks `cancelRequested`.
 *   - On `cancelRequested === true`: SIGTERM the child, then SIGKILL after
 *     `killGraceMs`. Sets an internal `cancelled` flag the caller reads via
 *     `isCancelled()`.
 *   - DDB read failures inside the loop log via `logger.warn` but never throw.
 *   - Caller stops the poller on child close via `await poller.stop()`. Stop
 *     ALWAYS clears the cancel flag on the session row before returning
 *     (per Story 19.2 AC 2 + Free Explorer §13.2 — atomic-clear semantics).
 *   - `isCancelled()` continues to return `true` after `stop()` so the close
 *     handler can branch on it (cancelled event vs normal completion event).
 *
 * The cancel-flag clear inside stop() is the bug-fix from §12.1.5: pre-fix,
 * two independent `clearCancelFlag` calls (pre-spawn + post-close) could
 * both fail (DDB blip) and leave the flag set, which would pre-cancel the
 * NEXT turn. Folding clear into stop() guarantees the flag is cleared once
 * by the same code path that owns the cancel decision.
 */

const DEFAULT_POLL_MS = 2_500;
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * @typedef {object} CancelPollerSessionsRepo
 * @property {(sessionId: string) => Promise<{ cancelRequested?: boolean } | null>} getSession
 * @property {(sessionId: string) => Promise<void>} [clearCancelFlag]
 *   Optional — when present, `stop()` calls it. When absent, `stop()`
 *   skips silently (logger.warn). Free-agent + party both implement it.
 *
 * @typedef {object} CancelPollerLogger
 * @property {(msg: string) => void} [info]
 * @property {(msg: string) => void} [warn]
 *
 * @typedef {object} CancelPollerArgs
 * @property {CancelPollerSessionsRepo} sessionsRepo
 * @property {string} sessionId
 * @property {import('node:child_process').ChildProcess} child
 * @property {CancelPollerLogger} logger
 * @property {number} [pollMs=2500]
 * @property {number} [killGraceMs=5000]
 *
 * @typedef {object} CancelPollerHandle
 * @property {() => boolean} isCancelled
 * @property {() => Promise<void>} stop
 */

/**
 * Start polling for a session's `cancelRequested` flag.
 *
 * @param {CancelPollerArgs} args
 * @returns {CancelPollerHandle}
 */
export function startCancelPoller({
  sessionsRepo,
  sessionId,
  child,
  logger,
  pollMs = DEFAULT_POLL_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
}) {
  if (!sessionsRepo || typeof sessionsRepo.getSession !== 'function') {
    throw new Error('startCancelPoller: sessionsRepo.getSession is required');
  }
  if (!sessionId) throw new Error('startCancelPoller: sessionId is required');
  if (!child) throw new Error('startCancelPoller: child is required');

  let cancelled = false;
  let killTimer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped || cancelled) return;
    try {
      const latest = await sessionsRepo.getSession(sessionId);
      if (latest?.cancelRequested && !cancelled) {
        cancelled = true;
        logger?.info?.(
          `[cancel-poller] cancel requested for ${sessionId.slice(0, 8)}; killing subprocess`,
        );
        try {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* best effort — child may have already exited */
            }
          }, killGraceMs);
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      // DDB read errors during polling shouldn't crash the turn — log + continue.
      logger?.warn?.(`[cancel-poller] read failed: ${err.message}`);
    }
  };

  const interval = setInterval(tick, pollMs);

  return {
    isCancelled() {
      return cancelled;
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      if (killTimer) clearTimeout(killTimer);
      if (typeof sessionsRepo.clearCancelFlag === 'function') {
        try {
          await sessionsRepo.clearCancelFlag(sessionId);
        } catch (err) {
          logger?.warn?.(
            `[cancel-poller] clearCancelFlag failed (best-effort): ${err.message}`,
          );
        }
      }
    },
  };
}
