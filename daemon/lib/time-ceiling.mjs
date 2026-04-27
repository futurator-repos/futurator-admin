// Pipeline v1 — Story 4.2. Per-step time ceiling.
//
// Default ceilings by agent kind (PRD §FR-10). The runtime uses these
// when a pipeline step doesn't declare its own `timeCeilingMs`.

export const DEFAULT_TIME_CEILING_MS = {
  pm: 5 * 60 * 1000,
  dev: 20 * 60 * 1000,
  reviewer: 10 * 60 * 1000,
  qa: 10 * 60 * 1000,
  deploy: 5 * 60 * 1000,
  default: 10 * 60 * 1000,
};

export function resolveTimeCeilingMs(step, agent) {
  if (step?.timeCeilingMs) return step.timeCeilingMs;
  const kind = (agent?.name || agent?.id || '').toLowerCase();
  for (const [key, ms] of Object.entries(DEFAULT_TIME_CEILING_MS)) {
    if (kind.includes(key)) return ms;
  }
  return DEFAULT_TIME_CEILING_MS.default;
}

/**
 * Schedule the 80% warning + 100% kill timers around a Claude subprocess.
 * Caller passes a `terminate(reason)` callback that will be invoked at the
 * hard deadline. Returns a `cancel` function the caller invokes when the
 * step completes naturally so we don't fire timers post-completion.
 */
export function scheduleTimeCeilingTimers(timeCeilingMs, { onWarn, onTerminate }) {
  if (!Number.isFinite(timeCeilingMs) || timeCeilingMs <= 0) {
    return () => undefined;
  }
  const warnAt = Math.floor(timeCeilingMs * 0.8);
  const warnTimer = setTimeout(() => {
    try {
      onWarn?.(timeCeilingMs - warnAt);
    } catch {
      // best-effort
    }
  }, warnAt);
  const killTimer = setTimeout(() => {
    try {
      onTerminate?.('TIME_CEILING');
    } catch {
      // best-effort
    }
  }, timeCeilingMs);
  return () => {
    clearTimeout(warnTimer);
    clearTimeout(killTimer);
  };
}
