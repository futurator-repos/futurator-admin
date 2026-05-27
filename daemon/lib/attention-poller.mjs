/**
 * attention-poller.mjs — 2026-05-27 PR D.b.
 *
 * 30s daemon ticker that scans `futurator-attention-items` for open items
 * with a non-manual remediationPolicy and spawns a free-agent session for
 * each (priming the first user-turn with the attention item's body).
 *
 * Step machine per tick:
 *
 *   1. Check the global pause flag (PR B.f) — if paused, skip.
 *   2. Scan open items, group by category, resolve per-category policy
 *      from `futurator-remediation-policies` (default 'manual' for absent
 *      categories).
 *   3. For each item with policy in {'auto-draft', 'auto-fix'} AND no
 *      `agentSessionId` yet:
 *        a. Generate sessionId.
 *        b. Attempt `claimForAgent(planId, itemId, sessionId)` — conditional
 *           update fails when another tick raced us, in which case skip.
 *        c. Enqueue a `free-agent-session` PENDING job with the attention
 *           context as the first user-turn. The poll-loop picks it up in
 *           the normal way; same path as operator-created sessions.
 *
 * Auto-fix vs auto-draft:
 *   - `auto-draft`: agent investigates + opens a PR + waits for operator
 *     approval via the inline card. This is the v1 default for graduating
 *     categories.
 *   - `auto-fix`: agent investigates + opens a PR + (if classifier
 *     returns `green` AND all gates pass) the daemon-bot calls
 *     /approve-merge itself. The poller stamps `metadata.autoFix=true`
 *     on the session payload so downstream handlers know to attempt the
 *     auto-merge. v1.0 ships the metadata + spawn — the auto-merge
 *     trigger itself is wired in a v1.1 follow-up; until then both
 *     policies behave identically (operator approves via card).
 *
 * Idempotence: `claimForAgent`'s conditional `attribute_not_exists(agentSessionId)`
 * is the load-bearing guard. Two concurrent ticks can both `Scan` the
 * same row, but only one will `claim` it; the other gets null and skips.
 *
 * The poller is pure — all I/O via injected deps so the unit test exercises
 * the policy resolution + claim logic without a real DDB.
 */

import { randomUUID } from 'node:crypto';

export const ATTENTION_POLLER_INTERVAL_MS = 30_000;

export const POLLER_ELIGIBLE_POLICIES = new Set(['auto-draft', 'auto-fix']);

/**
 * @param {object} args
 * @param {() => Promise<boolean>} args.isPaused — true if the global
 *   pause flag is set; tick is a no-op when true.
 * @param {() => Promise<Array<object>>} args.scanOpenItems — returns ALL
 *   open attention items (status=open). Caller is responsible for
 *   filtering / pagination as needed.
 * @param {(category: string) => Promise<string>} args.getPolicy — resolve
 *   the per-category policy ('manual' | 'auto-draft' | 'auto-fix').
 * @param {(args: {planId: string, itemId: string, sessionId: string}) => Promise<object | null>} args.claimForAgent
 * @param {(args: {sessionId: string, item: object, autoFix: boolean}) => Promise<void>} args.enqueueSession
 * @param {(level: string, msg: string, ctx?: object) => void} [args.log]
 */
export async function runAttentionPollerTick({
  isPaused,
  scanOpenItems,
  getPolicy,
  claimForAgent,
  enqueueSession,
  log = () => {},
}) {
  const paused = await isPaused();
  if (paused) return { spawned: 0, skipped: 0, reason: 'paused' };

  const items = await scanOpenItems();
  let spawned = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.agentSessionId) {
      skipped += 1;
      continue;
    }
    // Resolve policy. Per-item override beats category default.
    const policy = item.remediationPolicy ?? (await getPolicy(item.category));
    if (!POLLER_ELIGIBLE_POLICIES.has(policy)) {
      skipped += 1;
      continue;
    }

    const sessionId = randomUUID();
    const claimed = await claimForAgent({
      planId: item.planId,
      itemId: item.itemId,
      sessionId,
    });
    if (!claimed) {
      // Another tick raced us; skip silently.
      skipped += 1;
      continue;
    }

    try {
      await enqueueSession({
        sessionId,
        item,
        autoFix: policy === 'auto-fix',
      });
      spawned += 1;
      log('info', `[attention-poller] spawned ${sessionId.slice(0, 8)} for ${item.itemId} (${policy})`);
    } catch (err) {
      log(
        'error',
        `[attention-poller] enqueue failed for ${item.itemId}: ${(err instanceof Error ? err.message : String(err))}`,
      );
      // The item is now claimed but no session is running; the operator
      // will see the attention-item still in 'open' status with an
      // agentSessionId pointing at nothing. Resolution: manually clear
      // agentSessionId via the admin UI (out-of-scope for v1; rare
      // failure mode).
    }
  }

  return { spawned, skipped };
}

/**
 * Compose the first user-turn message body. The agent's AGENT.md tells
 * it to read its operator-context — we prepend the attention-item details
 * here so the agent has a concrete starting point.
 */
export function composeAttentionPromptBody(item) {
  const lines = [
    `An automated remediation policy assigned this attention item to you for investigation:`,
    ``,
    `**Item ID:** \`${item.itemId}\``,
    `**Plan ID:** \`${item.planId}\``,
    `**Severity:** ${item.severity}`,
    `**Category:** ${item.category}`,
    `**Title:** ${item.title}`,
    ``,
    `### Body`,
    ``,
    item.body || '_(no body)_',
  ];
  if (item.context) {
    const ctx = Object.entries(item.context)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `- \`${k}\`: ${v}`)
      .join('\n');
    if (ctx) {
      lines.push('', '### Context', '', ctx);
    }
  }
  lines.push(
    '',
    '---',
    '',
    `Please investigate the issue, propose a fix if one exists, and call \`POST /api/free-agent/sessions/${'<this-sessionId>'}/open-pr\` ` +
      `when you have a candidate change ready for operator review. ` +
      `If the issue is not actionable by the agent, surface the reason in chat so the operator can decide manually.`,
  );
  return lines.join('\n');
}

/**
 * Start a recurring ticker. Returns an `{stop}` handle for tests +
 * graceful daemon shutdown. First tick fires after a small initial
 * delay so the daemon doesn't probe DDB during startup.
 */
export function startAttentionPoller(deps, options = {}) {
  const intervalMs = options.intervalMs ?? ATTENTION_POLLER_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? 60_000;
  const log = deps.log ?? (() => {});
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const summary = await runAttentionPollerTick(deps);
      if (summary.spawned > 0) {
        log('info', `[attention-poller] tick: spawned=${summary.spawned} skipped=${summary.skipped}`);
      }
    } catch (err) {
      log(
        'error',
        `[attention-poller] tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, initialDelayMs);
  log(
    'info',
    `[attention-poller] started; first tick in ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 1000)}s`,
  );
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
