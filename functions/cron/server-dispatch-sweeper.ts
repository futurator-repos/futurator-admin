// Servers module (spec §5 / §11) — 1-minute dispatch sweeper.
//
// Two independent passes each tick, isolated so one failing never blocks the
// other (Task 15):
//   1. `runDispatchSweep` — re-runs the server-aware assignment plan: stamps
//      `assignedServerId` on newly PENDING agent jobs, reassigns jobs stranded
//      on stale-heartbeat servers, releases expired claim leases. When flag
//      `dispatch.serverAware` is off it short-circuits to `{ skipped: true }`,
//      so this cron is legacy-safe.
//   2. `refreshProvisioningServers` — drives the provisioning state machine
//      (spec §4.2): PROVISIONING → BOOTSTRAPPING when the provider reports
//      the VM running; BOOTSTRAPPING → ACTIVE on the first daemon heartbeat.
import { runDispatchSweep } from '../shared/services/server-dispatcher';
import { refreshProvisioningServers } from '../shared/services/server-provisioning';

export const handler = async () => {
  const [sweep, refresh] = await Promise.allSettled([
    runDispatchSweep(),
    refreshProvisioningServers(),
  ]);

  if (sweep.status === 'fulfilled') {
    console.log('[server-dispatch-sweeper]', JSON.stringify(sweep.value));
  } else {
    console.error('[server-dispatch-sweeper] dispatch sweep failed:', sweep.reason);
  }

  if (refresh.status === 'rejected') {
    console.error('[server-dispatch-sweeper] provisioning refresh failed:', refresh.reason);
  }
};
