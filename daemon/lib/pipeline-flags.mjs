// pipeline-flags.mjs — the Pipeline-3 flag registry (development-plan §7).
//
// One binary, two behaviors. Every P3 capability ships behind an env-sourced
// flag that defaults OFF, so the legacy daemon path is always the fallback and
// no big-bang is ever forced. Flags are resolved PER-EPIC, deterministically,
// and the resolved set is frozen onto `job.p3Flags` at claim so a single job's
// behavior can never drift mid-flight even if the operator edits env.
//
// Rollout gating (per the plan):
//   • P3_EPIC_ALLOWLIST — comma list; when non-empty, only these epics get ANY
//     non-default flag (the canary set).
//   • P3_ROLLOUT_PCT    — 0..100; deterministic per-(flag,epic) bucketing via
//     sha256(flag|epicId) % 100 < pct. Stable across restarts, no central state.
//
// This module is PURE (no I/O beyond reading the passed-in env map) so it is
// trivially testable and safe to import anywhere in the daemon.

import { createHash } from 'node:crypto';

/**
 * The flag registry. Each flag is a small enum: the FIRST value is always the
 * OFF/legacy default. `mode` flags carry their value straight through (after
 * allowlist + rollout gating); there are no boolean-only flags — "off" is just
 * the first enum member, which keeps the A/B channel uniform.
 */
export const P3_FLAGS = Object.freeze({
  P3_GATE_MODE: { values: ['off', 'audit', 'enforce'], default: 'off' },
  P3_LAZY_MODE: { values: ['off', 'lite', 'full', 'ultra'], default: 'off' },
  P3_COST_CEILING: { values: ['off', 'observe', 'enforce'], default: 'off' },
  P3_READY_FRONTIER: { values: ['off', 'shadow', 'on'], default: 'off' },
  // Graded ready-frontier (TDD blueprint §6). 'kahn' = legacy: a dependent
  // unblocks only when every dep is fully `done`. 'contract' = a dependent may
  // start once its deps are integrated/committed (contract frozen), so
  // test-authoring parallelizes against the contract. 'green' = start once deps'
  // tests pass (pre-merge). First value is the OFF/legacy default.
  P3_FRONTIER_MODE: { values: ['kahn', 'contract', 'green'], default: 'kahn' },
  P3_BOUND_AC_GATE: { values: ['off', 'shadow', 'on'], default: 'off' },
  P3_WORKTREE_CACHE: { values: ['off', 'on'], default: 'off' },
  P3_SESSION_REUSE: { values: ['off', 'dev_compile', 'full'], default: 'off' },
  P3_COMPACTION: { values: ['off', 'on'], default: 'off' },
});

export const P3_FLAG_NAMES = Object.freeze(Object.keys(P3_FLAGS));

/** Parse a comma/space-separated env list into a trimmed string array. */
function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Deterministic 0..99 bucket for a (flag, epicId) pair. Stable, no state. */
export function rolloutBucket(flag, epicId) {
  const h = createHash('sha256').update(`${flag}|${epicId ?? ''}`).digest('hex');
  return parseInt(h.slice(0, 8), 16) % 100;
}

/** Coerce a raw env value to a valid flag value, falling back to the default. */
function coerceValue(spec, raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return spec.values.includes(v) ? v : spec.default;
}

/**
 * Resolve the full P3 flag-set for one epic. PURE — reads only `env`.
 *
 * Resolution order per flag:
 *   1. read env, coerce to a valid enum value (invalid → default OFF);
 *   2. if it resolved to the default, keep it (no gating needed);
 *   3. else apply the allowlist: epic not listed (when a non-empty allowlist
 *      exists) → forced to default;
 *   4. else apply the rollout bucket: bucket >= pct → forced to default.
 *
 * @param {{ epicId?: string, env?: Record<string,string|undefined> }} args
 * @returns {Readonly<Record<string,string>>} frozen { P3_GATE_MODE: 'audit', ... }
 */
export function resolveFlags({ epicId, env = process.env } = {}) {
  const allowlist = parseList(env.P3_EPIC_ALLOWLIST);
  const allowlisted = allowlist.length === 0 || allowlist.includes(String(epicId));
  const pctRaw = Number(env.P3_ROLLOUT_PCT);
  const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 100;

  const resolved = {};
  for (const name of P3_FLAG_NAMES) {
    const spec = P3_FLAGS[name];
    let value = coerceValue(spec, env[name]);
    if (value !== spec.default) {
      if (!allowlisted) value = spec.default;
      else if (rolloutBucket(name, epicId) >= pct) value = spec.default;
    }
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}

/**
 * Read a flag's mode out of an already-resolved (frozen) flag-set. Missing /
 * unknown name → that flag's OFF default. Use this everywhere downstream so call
 * sites never re-resolve from env (which could drift mid-job).
 */
export function flagMode(flags, name) {
  const spec = P3_FLAGS[name];
  if (!spec) return undefined;
  return (flags && flags[name]) || spec.default;
}

/** True when a flag is set to anything other than its OFF default. */
export function isEnabled(flags, name) {
  const spec = P3_FLAGS[name];
  if (!spec) return false;
  return flagMode(flags, name) !== spec.default;
}

/**
 * Freeze the resolved flag-set onto a job row at claim time. Idempotent: if the
 * job already carries `p3Flags`, that frozen set wins (a job's behavior is fixed
 * once claimed). Returns the flag-set actually in force for the job.
 */
export function freezeFlagsOntoJob(job, { env = process.env } = {}) {
  if (job && job.p3Flags) return job.p3Flags;
  const epicId = job?.epicId || job?.cohort?.epicId || job?.planId;
  const flags = resolveFlags({ epicId, env });
  if (job) job.p3Flags = flags;
  return flags;
}
