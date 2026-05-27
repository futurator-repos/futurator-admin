/**
 * deployer-orchestrator.ts — 2026-05-27 PR C.c.
 *
 * Pure orchestration logic for the self-deploy flow. The DeployerLambda
 * (functions/cron/deployer-lambda.ts) wires this to SSM + DDB + the
 * event/attention surfaces.
 *
 * Step machine:
 *
 *   probe-main-sha       — git fetch origin && rev-parse origin/main on EC2
 *   compare-last-sha     — read agent.deployer.last-deployed-sha flag
 *   rsync-mtime-check    — operator-rsync detector (§9.1 RESOLVED)
 *   snapshot             — cp -a /opt/futurator-daemon /opt/.rollback/<ts>
 *   rsync-from-worktree  — pull main + rsync daemon/ → /opt/futurator-daemon
 *   restart              — systemctl restart futurator-daemon; wait 60s
 *   health-check         — 60s budget, 1 probe/sec
 *   rollback             — on health-check fail; cp -a /opt/.rollback back
 *
 * Health-check criteria (all must pass within 60s):
 *   a) `systemctl is-active futurator-daemon` returns 'active'
 *   b) daemon writes a fresh DAEMON_HEARTBEAT row to DDB (lastHeartbeat
 *      newer than the restart time)
 *   c) Auth probe ok line in journalctl (`Auth probe: OK` recent)
 *
 * The DeployerLambda is itself danger-listed (PR C.b), so changes to it
 * always require operator typed-confirmation.
 */

export const RSYNC_BACKOFF_WINDOW_MS = 10 * 60 * 1000; // 10 min per §9.1
export const HEALTH_CHECK_BUDGET_MS = 60_000;
export const HEALTH_CHECK_INTERVAL_MS = 1_000;

export interface DeployerDeps {
  sendSsmCommand: (cmd: string) => Promise<string>;
  waitForSsmOutput: (commandId: string) => Promise<string>;
  now?: () => number;
}

export type DeployResult =
  | {
      kind: 'skipped';
      reason: 'no-new-commit' | 'rsync-detected';
      detail: string;
      lastDeployedSha?: string;
      mainSha?: string;
    }
  | { kind: 'completed'; deployedSha: string; healthCheckMs: number }
  | { kind: 'rolled-back'; targetSha: string; failureReason: string; rollbackSnapshot: string }
  | { kind: 'errored'; phase: string; detail: string };

/**
 * Resolve the current `origin/main` SHA on the operator's checkout
 * mirror at /home/ubuntu/projects/futurator-admin. Includes a `git fetch`
 * because the deployer doesn't trust the cached refs.
 */
export async function probeMainSha(deps: DeployerDeps): Promise<string | null> {
  const cmd = [
    'set -e',
    'cd /home/ubuntu/projects/futurator-admin',
    'sudo -u ubuntu git fetch origin main 2>&1 | tail -3',
    'SHA=$(sudo -u ubuntu git rev-parse origin/main 2>/dev/null || echo "")',
    'echo "MAIN_SHA=$SHA"',
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  const m = out.match(/MAIN_SHA=([a-f0-9]{40})/);
  return m ? m[1] : null;
}

/**
 * Detect operator-rsync activity. The operator's manual rsync touches
 * a marker file (`/opt/futurator-daemon/.last-rsync-mtime`) — when that
 * mtime is within the last 10 min, the deployer backs off and posts
 * an attention item. Per §9.1 RESOLVED: rsync ALWAYS wins on last-write.
 *
 * Returns the seconds-since-touch, or null when the marker doesn't exist
 * (treat absent marker as "no recent operator activity").
 */
export async function rsyncRecencySeconds(deps: DeployerDeps): Promise<number | null> {
  const cmd = [
    'MARKER=/opt/futurator-daemon/.last-rsync-mtime',
    'if [ ! -f "$MARKER" ]; then echo "RSYNC_NO_MARKER"; exit 0; fi',
    'NOW=$(date +%s)',
    'MTIME=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER")',
    'AGE=$((NOW - MTIME))',
    'echo "RSYNC_AGE_SEC=$AGE"',
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  if (out.includes('RSYNC_NO_MARKER')) return null;
  const m = out.match(/RSYNC_AGE_SEC=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Take a snapshot of /opt/futurator-daemon to /opt/.rollback/<ts>/ via
 * `cp -a` (preserves perms, symlinks, env, node_modules, OAuth tokens).
 * Returns the snapshot path so rollback can target it.
 */
export async function takeSnapshot(deps: DeployerDeps, ts: string): Promise<string> {
  const dest = `/opt/.rollback/${ts}`;
  const cmd = [
    'set -e',
    `mkdir -p /opt/.rollback`,
    `cp -a /opt/futurator-daemon ${dest}`,
    `echo "SNAPSHOT_OK ${dest}"`,
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  if (!out.includes('SNAPSHOT_OK')) {
    throw new Error(`snapshot failed: ${out.slice(0, 200)}`);
  }
  return dest;
}

/**
 * Pull main into the operator's checkout mirror + rsync the `daemon/`
 * subtree into `/opt/futurator-daemon/`. Uses `--delete` so removed
 * files in the new tree disappear from /opt (matches the operator's
 * `scripts/rsync-daemon.sh` shape).
 *
 * Reads exitMarker on the last line: `RSYNC_OK <sha>` on success.
 */
export async function rsyncFromWorktree(deps: DeployerDeps): Promise<string> {
  const cmd = [
    'set -e',
    'cd /home/ubuntu/projects/futurator-admin',
    'sudo -u ubuntu git pull --ff-only origin main 2>&1 | tail -5',
    'sudo -u ubuntu cp -a daemon/. /tmp/futurator-daemon-staging',
    'rsync -a --delete /tmp/futurator-daemon-staging/ /opt/futurator-daemon/',
    'rm -rf /tmp/futurator-daemon-staging',
    'SHA=$(sudo -u ubuntu git rev-parse HEAD)',
    'echo "RSYNC_OK $SHA"',
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  const m = out.match(/RSYNC_OK ([a-f0-9]{40})/);
  if (!m) throw new Error(`rsync failed: ${out.slice(0, 300)}`);
  return m[1];
}

/**
 * Restart the daemon's systemd unit. Returns the timestamp the restart
 * fired (so the health-check can verify the heartbeat is post-restart).
 */
export async function restartDaemon(deps: DeployerDeps): Promise<number> {
  const t0 = (deps.now ?? Date.now)();
  const cmd = ['set -e', 'systemctl restart futurator-daemon', 'echo "RESTART_OK"'].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  if (!out.includes('RESTART_OK')) {
    throw new Error(`restart failed: ${out.slice(0, 200)}`);
  }
  return t0;
}

/**
 * Poll the daemon's health for up to `budgetMs`. Returns success time
 * when ALL three criteria pass; throws on timeout.
 *
 * deps.isHealthy must implement the three-check probe (see DeployerLambda).
 */
export async function awaitHealthy(args: {
  isHealthy: () => Promise<{ healthy: boolean; detail?: string }>;
  budgetMs?: number;
  intervalMs?: number;
  now?: () => number;
}): Promise<{ healthy: true; elapsedMs: number }> {
  const budget = args.budgetMs ?? HEALTH_CHECK_BUDGET_MS;
  const interval = args.intervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const now = args.now ?? Date.now;
  const t0 = now();
  let lastDetail = '';
  while (now() - t0 < budget) {
    const result = await args.isHealthy();
    if (result.healthy) return { healthy: true, elapsedMs: now() - t0 };
    lastDetail = result.detail ?? '';
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`health-check timed out after ${budget}ms; last detail: ${lastDetail}`);
}

/**
 * Roll back to a prior snapshot. cp -a the snapshot back over
 * /opt/futurator-daemon and restart. Worst-case path; called only after
 * health-check fails.
 */
export async function rollbackToSnapshot(deps: DeployerDeps, snapshotPath: string): Promise<void> {
  const cmd = [
    'set -e',
    `if [ ! -d "${snapshotPath}" ]; then echo "ROLLBACK_NO_SNAPSHOT ${snapshotPath}"; exit 1; fi`,
    `rsync -a --delete "${snapshotPath}/" /opt/futurator-daemon/`,
    'systemctl restart futurator-daemon',
    'echo "ROLLBACK_OK"',
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const out = await deps.waitForSsmOutput(commandId);
  if (!out.includes('ROLLBACK_OK')) {
    throw new Error(`rollback failed: ${out.slice(0, 300)}`);
  }
}
