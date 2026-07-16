// Servers module (spec §5 / §11) — 1-minute dispatch sweeper.
//
// Re-runs the server-aware assignment plan: stamps `assignedServerId` on newly
// PENDING agent jobs and reassigns jobs stranded on stale-heartbeat servers.
// The real orchestration lives in `runDispatchSweep` (Task 6); this handler is
// a thin Lambda entrypoint. When flag `dispatch.serverAware` is off the sweep
// short-circuits to `{ skipped: true }`, so this cron is legacy-safe.
import { runDispatchSweep } from '../shared/services/server-dispatcher';

export const handler = async () => {
  const summary = await runDispatchSweep();
  console.log('[server-dispatch-sweeper]', JSON.stringify(summary));
};
