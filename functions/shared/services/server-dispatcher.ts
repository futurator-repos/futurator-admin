// Servers module (spec §5 / §11) — server-aware dispatch orchestration.
//
// STUB (Task 2): the real I/O orchestration — reading eligible servers, the
// dispatch policy/flag/affinity state, the pending-job queue, running
// `planAssignments`, and writing `assignedServerId` back onto agent-jobs — is
// implemented in Task 6, which replaces this file. Until then this stub keeps
// the sweeper cron (`functions/cron/server-dispatch-sweeper.ts`) type-safe and
// makes the whole module inert (nothing is dispatched) so a deploy with flag
// `dispatch.serverAware` off is legacy behavior byte-for-byte.
export const runDispatchSweep = async () => ({
  skipped: true,
  reason: 'not implemented',
});
