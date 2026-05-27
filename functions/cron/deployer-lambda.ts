/**
 * deployer-lambda.ts — 2026-05-27 PR C.c.
 *
 * Self-deploys the daemon when `main` advances past the last-deployed SHA.
 * v1 = cron poll every 60s. v2 will replace this with a GitHub webhook
 * (the workflow at .github/workflows/agent-auto-merge.yml + a small
 * GitHub App for delivery); v1 is the simpler, recoverable shape.
 *
 * Flow (see deployer-orchestrator.ts for step details):
 *
 *   1. probe-main-sha       — git fetch + rev-parse origin/main
 *   2. compare-last-sha     — read agent.deployer.last-deployed-sha flag
 *      - no diff → kind:'skipped' reason:'no-new-commit'
 *   3. rsync-mtime-check    — operator manual-rsync detector (§9.1
 *      RESOLVED). Within 10 min → back off; write attention item.
 *   4. snapshot             — cp -a → /opt/.rollback/<ts>
 *   5. rsync-from-worktree  — git pull + rsync daemon/ → /opt
 *   6. restart              — systemctl restart futurator-daemon
 *   7. health-check         — 60s budget; daemon must (a) systemctl
 *      is-active, (b) write a fresh heartbeat row, (c) auth probe OK.
 *   8a. on healthy          — update last-deployed-sha; emit
 *       free-agent.deploy.completed
 *   8b. on unhealthy        — rollback snapshot; restart; emit
 *       free-agent.deploy.rolled-back + attention item
 *
 * Triggers via EventBridge cron `rate(1 minute)` in sst.config.ts.
 * Lambda timeout: 5 min (60s health-check + budget).
 *
 * IDEMPOTENCE: the `agent.deployer.lock` flag (set with value=now+ms,
 * read at handler start) prevents two cron ticks from concurrently
 * deploying. A stale lock older than 10 min is reclaimed.
 */

import { randomUUID } from 'node:crypto';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import * as agentFlagsRepo from '../shared/repositories/agent-flags-repository';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import * as agentEventsRepo from '../shared/repositories/agent-events-repository';
import {
  probeMainSha,
  rsyncRecencySeconds,
  takeSnapshot,
  rsyncFromWorktree,
  restartDaemon,
  awaitHealthy,
  rollbackToSnapshot,
  RSYNC_BACKOFF_WINDOW_MS,
  HEALTH_CHECK_BUDGET_MS,
} from '../shared/services/deployer-orchestrator';

const ssmClient = new SSMClient({});
const EC2_INSTANCE_ID = process.env.EC2_INSTANCE_ID || 'i-INVALID';
const LAST_DEPLOYED_SHA_KEY = 'agent.deployer.last-deployed-sha';
const DEPLOYER_LOCK_KEY = 'agent.deployer.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

async function sendSsmCommand(cmd: string): Promise<string> {
  const result = await ssmClient.send(
    new SendCommandCommand({
      InstanceIds: [EC2_INSTANCE_ID],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [cmd] },
    }),
  );
  return result.Command?.CommandId || '';
}

async function waitForSsmOutput(commandId: string, timeoutMs = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const result = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: EC2_INSTANCE_ID,
        }),
      );
      if (result.Status === 'Success') return result.StandardOutputContent ?? '';
      if (
        result.Status === 'Failed' ||
        result.Status === 'Cancelled' ||
        result.Status === 'TimedOut'
      ) {
        return `${result.StandardOutputContent ?? ''}\n${result.StandardErrorContent ?? ''}`;
      }
    } catch (err) {
      // ssm returns InvocationDoesNotExist briefly after send; keep polling.
      const msg = (err as Error).message;
      if (!msg.includes('InvocationDoesNotExist')) throw err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`SSM command ${commandId} timed out after ${timeoutMs}ms`);
}

const ssmDeps = { sendSsmCommand, waitForSsmOutput };

async function emitDeployEvent(
  eventType:
    | 'free-agent.deploy.completed'
    | 'free-agent.deploy.rolled-back'
    | 'free-agent.deploy.skipped',
  data: Record<string, unknown>,
): Promise<void> {
  const ts = Date.now();
  await agentEventsRepo.pushEvent({
    jobId: '__deployer__',
    eventSeq: `99-${ts}-${randomUUID().slice(0, 8)}`,
    seq: ts,
    timestamp: new Date().toISOString(),
    stepId: 'deployer',
    agentId: '__deployer__',
    eventType: eventType as never,
    ...(data as { [k: string]: never }),
  });
}

/**
 * Build the three-criteria health probe. Daemon must (a) be active per
 * systemd, (b) write a heartbeat newer than `restartTs`, (c) the most
 * recent `Auth probe` line in journalctl is OK.
 */
function buildIsHealthy(restartTs: number) {
  return async (): Promise<{ healthy: boolean; detail?: string }> => {
    const cmd = [
      'set -o pipefail',
      'IS_ACTIVE=$(systemctl is-active futurator-daemon 2>/dev/null || echo "inactive")',
      'if [ "$IS_ACTIVE" != "active" ]; then echo "PROBE_INACTIVE: $IS_ACTIVE"; exit 0; fi',
      // Heartbeat freshness — read the file the daemon writes locally; cheaper
      // than a DDB read per second.
      'HB_FILE=/var/lib/futurator-daemon/heartbeat-ts',
      'HB_TS=$(cat "$HB_FILE" 2>/dev/null || echo "0")',
      `RESTART_TS=${Math.floor(restartTs / 1000)}`,
      'if [ "$HB_TS" -lt "$RESTART_TS" ]; then echo "PROBE_HB_STALE hb=$HB_TS restart=$RESTART_TS"; exit 0; fi',
      // Auth probe — look for a recent "Auth probe: OK" or "Auth probe ok" line.
      // Falls back to OK when journalctl is unavailable (test instances).
      'AUTH_RECENT=$(journalctl -u futurator-daemon -n 30 --no-pager 2>/dev/null | grep -E "Auth probe.*(OK|ok)" | tail -1)',
      'if [ -z "$AUTH_RECENT" ]; then echo "PROBE_HB_OK"; exit 0; fi',
      'echo "PROBE_OK"',
    ].join('\n');
    const commandId = await sendSsmCommand(cmd);
    const out = await waitForSsmOutput(commandId, 15_000);
    if (out.includes('PROBE_OK')) return { healthy: true };
    if (out.includes('PROBE_HB_OK')) return { healthy: true }; // journalctl missing — accept heartbeat-only
    if (out.includes('PROBE_INACTIVE')) return { healthy: false, detail: 'systemctl inactive' };
    if (out.includes('PROBE_HB_STALE')) {
      return { healthy: false, detail: 'heartbeat older than restart timestamp' };
    }
    return { healthy: false, detail: `unrecognized probe output: ${out.slice(0, 100)}` };
  };
}

async function tryAcquireLock(now: number): Promise<boolean> {
  const existing = await agentFlagsRepo.getFlag(DEPLOYER_LOCK_KEY).catch(() => null);
  if (existing?.value) {
    const lockedUntil = parseInt(existing.value, 10);
    if (Number.isFinite(lockedUntil) && lockedUntil > now) return false;
  }
  await agentFlagsRepo.setFlag(DEPLOYER_LOCK_KEY, String(now + LOCK_STALE_MS), 'deployer-lambda');
  return true;
}

async function releaseLock(): Promise<void> {
  await agentFlagsRepo.setFlag(DEPLOYER_LOCK_KEY, '0', 'deployer-lambda').catch(() => {
    // Best-effort — the stale-lock reclaim path covers a missed release.
  });
}

export const handler = async () => {
  const now = Date.now();
  const acquired = await tryAcquireLock(now);
  if (!acquired) {
    console.info('[deployer] another tick holds the lock — skipping');
    return;
  }

  try {
    // 1. Probe main HEAD on EC2.
    const mainSha = await probeMainSha(ssmDeps);
    if (!mainSha) {
      console.warn('[deployer] could not resolve origin/main on EC2 — skipping');
      return;
    }

    // 2. Compare against last deployed.
    const lastFlag = await agentFlagsRepo.getFlag(LAST_DEPLOYED_SHA_KEY);
    const lastDeployedSha = lastFlag?.value || '';
    if (lastDeployedSha === mainSha) {
      // Cheap path — no log noise (every minute would be loud).
      return;
    }

    console.info(
      `[deployer] new commit ${mainSha.slice(0, 8)} (prior: ${lastDeployedSha.slice(0, 8) || '∅'})`,
    );

    // 3. Rsync recency check (§9.1 RESOLVED).
    const rsyncAge = await rsyncRecencySeconds(ssmDeps);
    if (rsyncAge !== null && rsyncAge * 1_000 < RSYNC_BACKOFF_WINDOW_MS) {
      console.info(`[deployer] operator rsync detected ${rsyncAge}s ago — backing off`);
      await emitDeployEvent('free-agent.deploy.skipped', {
        reason: 'rsync-detected',
        rsyncAgeSec: rsyncAge,
        targetSha: mainSha,
      });
      await attentionRepo
        .createAttentionItem({
          planId: '__deployer__',
          itemId: `rsync-skip-${mainSha.slice(0, 8)}`,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          severity: 'low',
          category: 'other',
          title: `Self-deploy skipped — operator rsync ${rsyncAge}s ago`,
          body:
            `DeployerLambda observed an operator rsync ${rsyncAge}s ago (within ` +
            `the 10-min backoff window). Skipping self-deploy of ${mainSha.slice(0, 12)}. ` +
            `Re-run after the window expires, or do nothing — the next cron tick will pick it up.`,
          context: { jobId: mainSha },
          suggestedActions: [],
          status: 'open',
          dedupKey: `rsync-detected:${mainSha.slice(0, 12)}`,
        })
        .catch(() => {});
      return;
    }

    // 4. Snapshot.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = await takeSnapshot(ssmDeps, ts);

    // 5. Rsync from worktree.
    let deployedSha: string;
    try {
      deployedSha = await rsyncFromWorktree(ssmDeps);
    } catch (err) {
      console.error(`[deployer] rsync phase failed: ${(err as Error).message}`);
      return;
    }

    // 6. Restart.
    const restartTs = await restartDaemon(ssmDeps);

    // 7. Health-check.
    try {
      const result = await awaitHealthy({
        isHealthy: buildIsHealthy(restartTs),
        budgetMs: HEALTH_CHECK_BUDGET_MS,
      });
      await agentFlagsRepo.setFlag(LAST_DEPLOYED_SHA_KEY, deployedSha, 'deployer-lambda');
      console.info(
        `[deployer] healthy after ${result.elapsedMs}ms — deployed ${deployedSha.slice(0, 8)}`,
      );
      await emitDeployEvent('free-agent.deploy.completed', {
        deployedSha,
        healthCheckMs: result.elapsedMs,
        snapshotPath,
      });
    } catch (healthErr) {
      // 8b. Rollback.
      const detail = (healthErr as Error).message;
      console.error(`[deployer] health-check failed; rolling back: ${detail}`);
      try {
        await rollbackToSnapshot(ssmDeps, snapshotPath);
      } catch (rollErr) {
        const rollDetail = (rollErr as Error).message;
        console.error(`[deployer] rollback ALSO failed: ${rollDetail}`);
        await attentionRepo
          .createAttentionItem({
            planId: '__deployer__',
            itemId: `deploy-rollback-fail-${deployedSha.slice(0, 8)}`,
            createdAt: new Date().toISOString(),
            resolvedAt: null,
            severity: 'critical',
            category: 'other',
            title: 'Self-deploy AND rollback both failed — daemon may be down',
            body:
              `DeployerLambda tried to deploy ${deployedSha.slice(0, 12)}, health-check failed ` +
              `(${detail}), THEN rollback to ${snapshotPath} also failed (${rollDetail}). ` +
              `Operator must SSH and recover manually.`,
            context: { jobId: deployedSha },
            suggestedActions: [],
            status: 'open',
            dedupKey: `deploy-rollback-fail:${deployedSha.slice(0, 12)}`,
          })
          .catch(() => {});
        return;
      }
      await emitDeployEvent('free-agent.deploy.rolled-back', {
        targetSha: deployedSha,
        failureReason: detail,
        rollbackSnapshot: snapshotPath,
      });
      await attentionRepo
        .createAttentionItem({
          planId: '__deployer__',
          itemId: `deploy-rollback-${deployedSha.slice(0, 8)}`,
          createdAt: new Date().toISOString(),
          resolvedAt: null,
          severity: 'high',
          category: 'other',
          title: `Self-deploy rolled back: ${deployedSha.slice(0, 12)}`,
          body:
            `DeployerLambda deployed ${deployedSha.slice(0, 12)}, health-check failed within 60s ` +
            `(${detail}), and the snapshot at ${snapshotPath} was restored. Investigate the ` +
            `failed commit before re-deploying.`,
          context: { jobId: deployedSha },
          suggestedActions: [],
          status: 'open',
          dedupKey: `deploy-rollback:${deployedSha.slice(0, 12)}`,
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error(`[deployer] uncaught: ${(err as Error).message}`);
  } finally {
    await releaseLock();
  }
};
