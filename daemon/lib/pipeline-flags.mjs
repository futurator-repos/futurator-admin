// pipeline-flags.mjs — the Pipeline-3 flag registry (development-plan §7).
//
// One binary, two behaviors. Every P3 capability ships behind an env-sourced
// flag. Most flags still default OFF (legacy daemon path), but as of the
// quality-defaults rollout (see the P3_FLAGS doc comment below) nine flags
// plus two new gate flags now default to their QUALITY posture — an operator
// can still force legacy behavior with an explicit env override. Flags are
// resolved PER-EPIC, deterministically, and the resolved set is frozen onto
// `job.p3Flags` at claim so a single job's behavior can never drift mid-flight
// even if the operator edits env.
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
 * The flag registry. Each flag is a small enum. The FIRST value is always the
 * OFF/legacy value, but `default` is an independent field — a flag's default
 * no longer needs to be its first enum member. `mode` flags carry their value
 * straight through (after allowlist + rollout gating).
 *
 * ── Quality-defaults invariant (pipeline-v3 redesign, Part 3 §5 / Part 5 #1) ──
 * As of this rollout, nine flags below default to their QUALITY posture
 * (enforce/on/contract) instead of legacy off, and two new flags
 * (P3_FOUNDATION_GATE, P3_GREEN_TRUNK) default 'on'. Flipping these defaults
 * is safe ONLY because the allowlist/rollout gate in resolveFlags() is inert
 * in this single-operator prototype: no P3_EPIC_ALLOWLIST is configured (so
 * every epic is allowlisted) and no P3_ROLLOUT_PCT is configured (so pct=100
 * and rolloutBucket()'s 0..99 result is NEVER >= 100 — the rollout gate never
 * fires). If either env var is ever set, the gating logic re-engages exactly
 * as designed and CAN force flags back to their default from arbitrary env.
 * An explicit env override (e.g. P3_GATE_MODE=off) always wins over the
 * registry default — operator intent is authoritative. daemon/.env currently
 * pins no P3_ flags, so these registry defaults are what actually runs on the
 * box today.
 */
export const P3_FLAGS = Object.freeze({
  P3_GATE_MODE: { values: ['off', 'audit', 'enforce'], default: 'enforce' },
  P3_LAZY_MODE: { values: ['off', 'lite', 'full', 'ultra'], default: 'off' },
  P3_COST_CEILING: { values: ['off', 'observe', 'enforce'], default: 'off' },
  P3_READY_FRONTIER: { values: ['off', 'shadow', 'on'], default: 'on' },
  // Graded ready-frontier (TDD blueprint §6). 'kahn' = legacy: a dependent
  // unblocks only when every dep is fully `done`. 'contract' = a dependent may
  // start once its deps are integrated/committed (contract frozen), so
  // test-authoring parallelizes against the contract. 'green' = start once deps'
  // tests pass (pre-merge).
  P3_FRONTIER_MODE: { values: ['kahn', 'contract', 'green'], default: 'contract' },
  P3_BOUND_AC_GATE: { values: ['off', 'shadow', 'on'], default: 'on' },
  P3_WORKTREE_CACHE: { values: ['off', 'on'], default: 'off' },
  P3_SESSION_REUSE: { values: ['off', 'dev_compile', 'full'], default: 'off' },
  P3_COMPACTION: { values: ['off', 'on'], default: 'off' },
  // ── TDD-native rollout (implementation-plan waves) ──
  // Quality verdict (PASS/CONCERNS/FAIL/WAIVED) + risk-tiered reviewer. shadow =
  // compute the verdict but discard reviewer output (byte-identical completion).
  P3_QUALITY_GATE: { values: ['off', 'shadow', 'on'], default: 'on' },
  // Split the single story spawn into Test-Author → Implementer (RED-first +
  // tamper). off = today's single untrimmed dev spawn.
  P3_TEST_AUTHOR_SPLIT: { values: ['off', 'on'], default: 'on' },
  // Emit deterministic TESTS/COVERS graph edges (testRef → symbol) at compile.
  P3_TEST_COVER_EDGES: { values: ['off', 'on'], default: 'off' },
  // Run ts-morph semantic-extract (cross-file CALLS/RENDERS) at compile. cohort =
  // only on the last story of a cohort; on = every story.
  P3_SEMANTIC_COMPILE: { values: ['off', 'cohort', 'on'], default: 'off' },
  // Split story-compile-graph into a deterministic AST lane (per story) + an LLM
  // article lane (cohort/plan close).
  P3_GRAPH_GROWTH_SPLIT: { values: ['off', 'on'], default: 'off' },
  // Surgical cross-story regression: run only prior tests covering changed
  // symbols after a commit (replaces the retired wave-merge full-suite gate).
  P3_SELECTIVE_REGRESSION: { values: ['off', 'shadow', 'on'], default: 'on' },
  // Scope the reflector prompt to landing targets + emit skill-requirement.
  P3_REFLECTOR_SCOPE: { values: ['off', 'on'], default: 'off' },
  // QA-Review W1 — the P3 plan lifecycle driver. When on, the daemon advances
  // plan.status (concept→developing on dispatch, →review when every story is
  // done + reviewAt), which lets the auto dev-deploy + QA stages engage. Off →
  // P3 plans stay in 'concept' forever (legacy behavior), no dev-deploy.
  P3_LIFECYCLE: { values: ['off', 'on'], default: 'on' },
  // QA-Review W2 — the deployed-app QA Review. THE single flag gating every W2
  // producer AND read (cron enqueue, daemon runner, API GET, UI branch — the
  // TS/UI sides read process.env.P3_QA_REVIEW directly, same value strings).
  // 'shadow' = compute + persist the verdict but never surface / never gate;
  // 'on' = surface it in the QA Review tab + gate Approve on a clean verdict.
  P3_QA_REVIEW: { values: ['off', 'shadow', 'on'], default: 'on' },
  // Foundation gate (pipeline-v3 redesign): boot-liveness + tsc + build must
  // pass on foundation stories before dependents unblock. Fail-closed.
  P3_FOUNDATION_GATE: { values: ['off', 'on'], default: 'on' },
  // Green-trunk gate (pipeline-v3 redesign): tsc + build must pass on every
  // story's tree before it can be marked done. Fail-closed.
  P3_GREEN_TRUNK: { values: ['off', 'on'], default: 'on' },
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
 * Read a single flag straight from env, coerced to a valid value (invalid or
 * absent → the flag's registry default). Skips allowlist/rollout gating
 * entirely — this is for call sites that want "operator intent, no A/B
 * machinery" rather than the per-epic resolveFlags() pipeline.
 *
 * @param {string} name
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|undefined} the resolved value, or undefined if `name` is
 *   not a known flag.
 */
export function envFlag(name, env = process.env) {
  const spec = P3_FLAGS[name];
  if (!spec) return undefined;
  return coerceValue(spec, env[name]);
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
