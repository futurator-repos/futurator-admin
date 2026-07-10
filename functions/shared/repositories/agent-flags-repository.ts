/**
 * agent-flags-repository.ts — 2026-05-27 PR B.f.
 *
 * Global agent feature flags. Single source of truth for runtime kill-switches
 * + cap overrides. The daemon polls these BEFORE claiming a PENDING job; the
 * admin UI surfaces a global Pause toggle in the panel header.
 *
 * Schema:
 *   { flagName: string (PK), value: string, updatedBy: string, updatedAt: string }
 *
 * v1 keys:
 *   - `agent.paused` → 'true' | 'false'. When 'true', daemon refuses to claim
 *     new PENDING jobs across all agent classes (party + pipeline-v2 +
 *     free-agent). In-flight jobs complete normally.
 *
 * Future keys (PR C): `agent.daily-spend-cap`, `agent.max-concurrent-override`.
 *
 * Pattern: per-concern table; values stored as strings so the table shape
 * stays uniform regardless of value type. Callers parse.
 */

import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';

export interface AgentFlag {
  flagName: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
}

/** Canonical flag names. Keep in sync with daemon callers. */
export const AGENT_FLAG_KEYS = {
  paused: 'agent.paused',
  // Queues module — runtime-settable shared concurrency cap, per daemon target.
  // The daemon reads the key matching its DAEMON_SOURCE each poll tick and
  // applies it via ConcurrencyManager.setMax(). Values are integer strings.
  // A small-host RAM guard in the daemon still clamps EC2 to 2 on <3GB hosts.
  maxConcurrentEc2: 'concurrency.maxConcurrent.ec2',
  maxConcurrentLocal: 'concurrency.maxConcurrent.local',
} as const;

/**
 * Read a per-target concurrency cap flag as a positive integer. Returns null
 * when the flag is absent or unparseable (caller falls back to its boot default).
 */
export async function getMaxConcurrentOverride(target: 'ec2' | 'local'): Promise<number | null> {
  const key =
    target === 'ec2' ? AGENT_FLAG_KEYS.maxConcurrentEc2 : AGENT_FLAG_KEYS.maxConcurrentLocal;
  const flag = await getFlag(key);
  if (!flag) return null;
  const n = Number.parseInt(flag.value, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Get a single flag row. Returns null when the row is absent (= flag has
 * never been written; callers treat as "default off").
 */
export async function getFlag(flagName: string): Promise<AgentFlag | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAMES.agentFlags,
      Key: { flagName },
    }),
  );
  return (result.Item as AgentFlag | undefined) ?? null;
}

/**
 * Specialized read for the most common check. Returns true only when the flag
 * row exists AND value === 'true' (case-sensitive). Absent or any other value
 * → false. Used by the daemon's pre-claim gate.
 */
export async function isAgentPaused(): Promise<boolean> {
  const flag = await getFlag(AGENT_FLAG_KEYS.paused);
  return flag?.value === 'true';
}

/**
 * Upsert a flag row. `updatedBy` is the operator id (or 'system' for
 * daemon-side writes — none in v1).
 */
export async function setFlag(
  flagName: string,
  value: string,
  updatedBy: string,
): Promise<AgentFlag> {
  const row: AgentFlag = {
    flagName,
    value,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAMES.agentFlags,
      Item: row,
    }),
  );
  return row;
}

/**
 * List all flag rows. Bounded by v1's tiny key-space; full scan is fine.
 * Used by `GET /api/admin/flags` for the operator UI to render current state.
 */
export async function listAllFlags(): Promise<AgentFlag[]> {
  const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAMES.agentFlags }));
  return (result.Items as AgentFlag[] | undefined) ?? [];
}
