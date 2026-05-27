/**
 * cw-to-attention.ts — 2026-05-27 PR D.c.
 *
 * SNS-triggered Lambda: receives a CloudWatch alarm notification and
 * writes a corresponding `attention-items` row. Combined with PR D.b's
 * attention-poller, this is the "agent acts without me opening a chat"
 * pipeline:
 *
 *   CloudWatch alarm (e.g. Lambda errors > 0 over 5 min) →
 *   SNS topic `futurator-cw-alarms` →
 *   this Lambda → write attention item with severity-based category →
 *   30s later, the daemon's poller resolves the policy →
 *   if `auto-draft` or `auto-fix` → spawn free-agent session →
 *   agent investigates, drafts a fix, opens a PR.
 *
 * Alarm-to-category mapping:
 *   Lambda errors        → `policy-violation` severity=high
 *   API 5xx rate         → `policy-violation` severity=high
 *   DDB throttling       → `policy-violation` severity=medium
 *   Daemon heartbeat     → `daemon-shutdown-timeout` severity=critical
 *   (anything else)      → `other` severity=medium
 *
 * Operator graduates these categories to `auto-draft` / `auto-fix` in the
 * remediation-policies panel as confidence builds. v1 default is
 * `manual` everywhere (no implicit auto-spawn).
 *
 * Idempotence via `dedupKey = cw:<alarm-name>:<state-change-time>` so a
 * retried SNS delivery doesn't write two rows.
 */

import { randomUUID } from 'node:crypto';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import type {
  AttentionCategory,
  AttentionSeverity,
  AttentionItem,
} from '../shared/types/attention';

interface CloudWatchAlarmMessage {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
  Region?: string;
  Trigger?: {
    MetricName?: string;
    Namespace?: string;
  };
}

interface SNSRecord {
  Sns: {
    Message: string;
    Subject?: string;
    Timestamp: string;
  };
}

interface SNSEvent {
  Records: SNSRecord[];
}

/**
 * Heuristic mapping from a CloudWatch alarm to an AttentionCategory +
 * severity. Pure — exported for unit tests.
 */
export function classifyAlarm(alarm: CloudWatchAlarmMessage): {
  category: AttentionCategory;
  severity: AttentionSeverity;
} {
  const name = (alarm.AlarmName ?? '').toLowerCase();
  if (name.includes('daemon') && (name.includes('heartbeat') || name.includes('down'))) {
    return { category: 'daemon-shutdown-timeout', severity: 'critical' };
  }
  if (name.includes('lambda') && name.includes('error')) {
    return { category: 'policy-violation', severity: 'high' };
  }
  if (name.includes('api') && name.includes('5xx')) {
    return { category: 'policy-violation', severity: 'high' };
  }
  if (name.includes('throttle') || name.includes('ddb-throttle')) {
    return { category: 'policy-violation', severity: 'medium' };
  }
  return { category: 'other', severity: 'medium' };
}

/**
 * Build the attention-item shape from an alarm. Pure — exported for tests.
 */
export function buildAttentionFromAlarm(alarm: CloudWatchAlarmMessage): AttentionItem {
  const { category, severity } = classifyAlarm(alarm);
  const stateChangeTime = alarm.StateChangeTime ?? new Date().toISOString();
  const alarmName = alarm.AlarmName ?? 'unknown-alarm';
  const dedupKey = `cw:${alarmName}:${stateChangeTime}`;
  return {
    planId: '__cloudwatch__',
    itemId: randomUUID(),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    severity,
    category,
    title: `CloudWatch alarm: ${alarmName}`,
    body:
      `**Alarm:** ${alarmName}\n` +
      `**State:** ${alarm.NewStateValue ?? 'unknown'}\n` +
      `**Region:** ${alarm.Region ?? 'unknown'}\n` +
      (alarm.Trigger?.Namespace ? `**Namespace:** ${alarm.Trigger.Namespace}\n` : '') +
      (alarm.Trigger?.MetricName ? `**Metric:** ${alarm.Trigger.MetricName}\n` : '') +
      `\n${alarm.NewStateReason ?? alarm.AlarmDescription ?? '(no reason provided)'}`,
    context: { jobId: alarmName },
    suggestedActions: [],
    status: 'open',
    dedupKey,
  };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records ?? []) {
    let alarm: CloudWatchAlarmMessage;
    try {
      alarm = JSON.parse(record.Sns.Message) as CloudWatchAlarmMessage;
    } catch (err) {
      console.warn(`[cw-to-attention] could not parse SNS Message: ${(err as Error).message}`);
      continue;
    }
    // Only act on ALARM state changes (skip OK/INSUFFICIENT_DATA).
    if (alarm.NewStateValue !== 'ALARM') {
      console.info(
        `[cw-to-attention] skipping state=${alarm.NewStateValue} for ${alarm.AlarmName}`,
      );
      continue;
    }
    const item = buildAttentionFromAlarm(alarm);
    try {
      await attentionRepo.createAttentionItem(item);
      console.info(
        `[cw-to-attention] created item ${item.itemId} (${item.severity} ${item.category}) for ${alarm.AlarmName}`,
      );
    } catch (err) {
      console.error(`[cw-to-attention] write failed for ${item.itemId}: ${(err as Error).message}`);
    }
  }
};
