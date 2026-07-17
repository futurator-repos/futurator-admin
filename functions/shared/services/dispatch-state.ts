/**
 * dispatch-state.ts — Servers module (spec §5) — dispatch policy / feature
 * flag / affinity-owner state, persisted as rows in the existing agent-flags
 * table. Thin wrappers over `agent-flags-repository`'s generic get/set —
 * no new table, no new I/O primitives.
 *
 * Flag `dispatch.serverAware` gates the whole server-aware dispatch feature.
 * When it is unset/false, `isServerAwareDispatchEnabled()` returns false and
 * every caller (dispatcher, daemon) must treat that as "legacy behavior,
 * byte-for-byte" per the plan's Global Constraints — this module never
 * assumes the flag is on.
 */

import { getFlag, setFlag, AGENT_FLAG_KEYS } from '../repositories/agent-flags-repository';
import { dispatchPolicySchema } from '../schemas/servers-schema';
import { DEFAULT_DISPATCH_POLICY, type DispatchPolicy } from '../types/compute-server';

const SYSTEM_UPDATED_BY = 'system';
const AFFINITY_OWNER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface AffinityOwnerEntry {
  serverId: string;
  lastSeenAt: string;
}

/**
 * Read the operator-configured dispatch policy. Falls back to
 * `DEFAULT_DISPATCH_POLICY` when the flag is unset, unparseable, or fails
 * schema validation (defensive against hand-edited/corrupt rows).
 */
export async function getDispatchPolicy(): Promise<DispatchPolicy> {
  const flag = await getFlag(AGENT_FLAG_KEYS.dispatchPolicy);
  if (!flag) return DEFAULT_DISPATCH_POLICY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(flag.value);
  } catch {
    return DEFAULT_DISPATCH_POLICY;
  }

  const result = dispatchPolicySchema.safeParse(parsed);
  if (!result.success) return DEFAULT_DISPATCH_POLICY;

  return { ...result.data, updatedAt: flag.updatedAt };
}

/**
 * Upsert the dispatch policy. `updatedBy` is the operator id (or 'system'
 * for daemon/dispatcher-side writes).
 */
export async function setDispatchPolicy(
  policy: Omit<DispatchPolicy, 'updatedAt'>,
  updatedBy = SYSTEM_UPDATED_BY,
): Promise<DispatchPolicy> {
  const row = await setFlag(AGENT_FLAG_KEYS.dispatchPolicy, JSON.stringify(policy), updatedBy);
  return { ...policy, updatedAt: row.updatedAt };
}

/**
 * Whether server-aware dispatch is enabled. Absent or any value other than
 * the literal string 'true' is treated as OFF (fail-safe default).
 */
export async function isServerAwareDispatchEnabled(): Promise<boolean> {
  const flag = await getFlag(AGENT_FLAG_KEYS.dispatchServerAware);
  return flag?.value === 'true';
}

/**
 * Operator toggle for server-aware dispatch. Stores the literal string
 * 'true'/'false' so `isServerAwareDispatchEnabled()`'s strict equality check
 * reads it back correctly.
 */
export async function setServerAwareDispatch(
  enabled: boolean,
  updatedBy = SYSTEM_UPDATED_BY,
): Promise<void> {
  await setFlag(AGENT_FLAG_KEYS.dispatchServerAware, enabled ? 'true' : 'false', updatedBy);
}

async function readAffinityEntries(): Promise<Record<string, AffinityOwnerEntry>> {
  const flag = await getFlag(AGENT_FLAG_KEYS.dispatchAffinityOwners);
  if (!flag) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(flag.value);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const result: Record<string, AffinityOwnerEntry> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const candidate = entry as Partial<AffinityOwnerEntry> | null;
    if (
      candidate &&
      typeof candidate.serverId === 'string' &&
      typeof candidate.lastSeenAt === 'string'
    ) {
      result[key] = { serverId: candidate.serverId, lastSeenAt: candidate.lastSeenAt };
    }
  }
  return result;
}

function pruneStale(
  entries: Record<string, AffinityOwnerEntry>,
  nowMs: number,
): Record<string, AffinityOwnerEntry> {
  const result: Record<string, AffinityOwnerEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const age = nowMs - new Date(entry.lastSeenAt).getTime();
    if (Number.isFinite(age) && age <= AFFINITY_OWNER_MAX_AGE_MS) {
      result[key] = entry;
    }
  }
  return result;
}

/**
 * Flat affinityKey -> serverId map for the dispatch policy engine
 * (`planAssignments`'s `affinityOwners` input/output shape).
 */
export async function getAffinityOwners(): Promise<Record<string, string>> {
  const entries = await readAffinityEntries();
  const now = Date.now();
  const fresh = pruneStale(entries, now);
  const flat: Record<string, string> = {};
  for (const [key, entry] of Object.entries(fresh)) {
    flat[key] = entry.serverId;
  }
  return flat;
}

/**
 * Merge-write affinity ownership. Keys present in `map` are stamped with
 * `lastSeenAt = now` (they were actively referenced this dispatch cycle);
 * keys already stored but absent from `map` keep their existing timestamp.
 * Any entry — new or carried-over — older than 7 days is dropped on write,
 * so an affinity key that stops being referenced ages out on its own.
 */
export async function setAffinityOwners(
  map: Record<string, string>,
  updatedBy = SYSTEM_UPDATED_BY,
): Promise<void> {
  const existing = await readAffinityEntries();
  const nowIso = new Date().toISOString();

  const merged: Record<string, AffinityOwnerEntry> = { ...existing };
  for (const [key, serverId] of Object.entries(map)) {
    merged[key] = { serverId, lastSeenAt: nowIso };
  }

  const pruned = pruneStale(merged, Date.now());
  await setFlag(AGENT_FLAG_KEYS.dispatchAffinityOwners, JSON.stringify(pruned), updatedBy);
}
