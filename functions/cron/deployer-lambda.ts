/**
 * deployer-lambda.ts — RETIRED 2026-07-22 (EU-migration S0.4, KD-4).
 *
 * ── History ──────────────────────────────────────────────────────────────
 * Originally added 2026-05-27 (PR C.c) to self-deploy the daemon: cron-poll
 * every 60s; when `origin/main` advanced past
 * `agent.deployer.last-deployed-sha` (futurator-agent-flags), it ran a
 * snapshot → rsync → restart → 60s-health-check → auto-rollback flow via
 * SSM against a single hard-coded EC2 instance
 * (`EC2_INSTANCE_ID`, `i-0826d68c316ae97dd`).
 *
 * ── Why retired ──────────────────────────────────────────────────────────
 * That instance lived in the old AWS account and is dead post-EU-migration
 * (421515025850/eu-central-1) — this cron has been firing SSM commands at
 * nothing every minute. The singleton-EC2 deploy model it implemented is
 * superseded by KD-2 (fleet/`futurator-servers` model): each fleet host
 * already self-deploys via a daemon-bundle pull, so there is no longer a
 * single instance for a central Lambda to reach into over SSM.
 *
 * The EventBridge trigger itself (`sst.aws.Cron('DeployerLambda', …)`) is
 * retired in `sst.config.ts` by S0.1 (§2.1 row `:1864-1893`), landing in
 * the same DEPLOY-1 window as this file's change (`WaveCompletionCheck`
 * stays on via the `ENABLE_DAEMON_CRONS` split). This handler is defused
 * defensively in case the trigger lingers past a partial/out-of-order
 * deploy: it acquires no lock, sends no SSM commands, touches no snapshot
 * or rollback state, and returns immediately.
 *
 * The step-by-step orchestration this cron drove (probe-main-sha →
 * compare-last-sha → rsync-mtime-check → snapshot → rsync-from-worktree →
 * restart → health-check → commit/rollback) lived in
 * `functions/shared/services/deployer-orchestrator.ts`, which is deprecated
 * alongside this file — its exports are no longer called by any live code
 * path. Both files are left in place (not deleted) so the retirement is a
 * pure code-level no-op pending an explicit follow-up deletion story; do
 * not re-wire either back onto SSM.
 */

export const handler = async () => {
  console.info(
    '[deployer] RETIRED (EU-migration S0.4, KD-4) — singleton-EC2 self-deploy is superseded by ' +
      'per-fleet-host daemon-bundle pull. No SSM command sent; no-op.',
  );
};
