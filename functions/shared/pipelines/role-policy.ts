import { z } from 'zod';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { AgentConfig } from '../types/agent-orchestrator';

/**
 * Pipeline v2 — Phase 2-A Story 2-A-1-1 (PR-32)
 *
 * Typed `RolePolicy` resolved at spawn time from `(boilerplateKind, rigor, role)`.
 * Replaces the eight hardcoded `allowedTools: '...,...'` strings scattered
 * across pipeline definitions with one shared source of truth.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * Phase 1 PR-3 tightened the allowlists per-pipeline-file by hand. Each
 * pipeline file independently declared its agents' allowed/disallowed tool
 * strings — six call sites that drifted: e.g. the wave-compile COMPILER had
 * no `disallowedTools` while the story-pipeline COMPILER did. v2.5 §10
 * specifies tool allowlists as a single role-keyed config tunable without
 * code changes ("agent-tool-policy.ts"). This module is that.
 *
 * ── Scope of PR-32 ─────────────────────────────────────────────────────────
 *
 * - Six functions/shared/pipelines/*.ts call sites migrate (story, pm-plan,
 *   wave-compile, visual-qa, plan-build, wave-build).
 * - Daemon-side `.mjs` pipelines (compile, epic-compile, conversation,
 *   self-reflection, deploy-compile) keep their hardcoded strings — a thin
 *   mirror lands in PR-32b once we choose a JS↔TS sharing strategy.
 * - `agent-daemon.mjs:644-645` string-pass interface is unchanged: agents
 *   continue to expose `allowedTools` + `disallowedTools` as comma-joined
 *   strings via `policyToAgentConfig`.
 * - Path-glob form (`Write(<glob>)`) is reserved on the schema but not
 *   populated yet — Story 2-A-3-2 wires per-call cwd-relative globs.
 *
 * ── Behaviour delta ────────────────────────────────────────────────────────
 *
 * The resolver normalizes every role to carry the PR-3 deny pattern
 * (`Task,Agent,WebFetch,WebSearch`) by default. Roles that previously
 * lacked one (wave-compile COMPILER, QA, PM) gain it — a tightening, not a
 * loosening. No agent loses tools.
 */

// ── Role enum ──────────────────────────────────────────────────────────────

export const RoleSchema = z.enum([
  'API_AUTHOR', // Reserved for Phase 2-A Story 2-A-3-1
  'TEST',
  'DEV',
  'REVIEWER',
  'COMPILER',
  'QA',
  'PM',
]);
export type Role = z.infer<typeof RoleSchema>;

// ── Rigor enum (re-exported as Zod) ────────────────────────────────────────
//
// `PlanRigor` already exists as a TypeScript union in `../types/plan`; we mirror
// it as a Zod enum here for `safeParse` use at the resolver boundary.

export const RigorSchema = z.enum(['prototype', 'mvp', 'production']);

// ── BoilerplateKind enum (Zod mirror) ──────────────────────────────────────
//
// Mirrors `BoilerplateType` from `../boilerplates/registry`. Kept in lock-step
// via the `boilerplateKindCoversRegistry` export-time check (see test).

export const BoilerplateKindSchema = z.enum([
  'nextjs-base',
  'nextjs-canvas-game',
  'nextjs-form-app',
  'nextjs-dashboard',
  'sst',
  'vite',
  'mobile',
]);

// ── RolePolicy schema ──────────────────────────────────────────────────────

export const RolePolicySchema = z.object({
  role: RoleSchema,
  /** Tool names the agent may invoke. Order is stable for snapshot tests. */
  allowedTools: z.array(z.string()),
  /** Tool names denied at the CLI layer (`--disallowedTools`). */
  disallowedTools: z.array(z.string()),
  /** Per-rigor turn cap; absent = no cap. v2.5 §17 matrix. */
  maxTurns: z.number().int().positive().optional(),
  /**
   * Reserved for Story 2-A-3-2: per-call cwd-relative path-glob form
   * (`Write(<glob>)`, `Edit(<glob>)`). Schema field exists; serializer
   * does not emit yet.
   */
  writePathGlobs: z.array(z.string()).optional(),
});
export type RolePolicy = z.infer<typeof RolePolicySchema>;

// ── Base allow/deny tables ─────────────────────────────────────────────────

/**
 * The PR-3 baseline deny pattern: subagent spawn (Task/Agent) and network
 * (WebFetch/WebSearch) have no place in any pipeline agent.
 */
const BASELINE_DENY = ['Task', 'Agent', 'WebFetch', 'WebSearch'] as const;

const ROLE_BASE: Record<Role, { allowed: readonly string[]; deniedExtras: readonly string[] }> = {
  // API-AUTHOR is reserved for Story 2-A-3-1. Until that story lands the
  // resolver returns a conservative default — no Edit, narrow Write — so
  // accidentally invoking the role in advance fails closed.
  API_AUTHOR: {
    allowed: ['Read', 'Write', 'Glob', 'Grep'],
    deniedExtras: ['Bash', 'Edit'],
  },
  TEST: {
    allowed: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    deniedExtras: [],
  },
  DEV: {
    allowed: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
    deniedExtras: [],
  },
  REVIEWER: {
    allowed: ['Read', 'Grep', 'Glob'],
    // Read-only: deny Bash + writes per v2.5 §10 ("Bash is the most
    // important deny — a Reviewer that can shell out can do anything").
    deniedExtras: ['Write', 'Edit', 'Bash'],
  },
  COMPILER: {
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    // Knowledge-graph ops are pure file IO; compiler never shells out.
    deniedExtras: ['Bash'],
  },
  QA: {
    allowed: ['Bash', 'Read', 'Write', 'Glob'],
    deniedExtras: [],
  },
  PM: {
    // PM only reads — output is the plan JSON in the prompt response.
    allowed: ['Read'],
    deniedExtras: ['Bash', 'Write', 'Edit'],
  },
};

// ── Turn caps per rigor (v2.5 §17 matrix) ──────────────────────────────────
//
// `null` = no cap; resolver emits `undefined`.

const TURN_CAPS: Record<PlanRigor, Partial<Record<Role, number | null>>> = {
  prototype: {
    API_AUTHOR: null, // skipped under prototype rigor
    TEST: 6,
    DEV: 8,
    REVIEWER: 4,
    COMPILER: null,
    QA: null,
    PM: null,
  },
  mvp: {
    API_AUTHOR: 2,
    TEST: 8,
    DEV: 10,
    REVIEWER: 6,
    COMPILER: null,
    QA: null,
    PM: null,
  },
  production: {
    API_AUTHOR: 2,
    TEST: 10,
    DEV: 12,
    REVIEWER: 8,
    COMPILER: null,
    QA: 8,
    PM: 6,
  },
};

// ── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve the policy for `(boilerplateKind, rigor, role)`. Pure function — no
 * side effects, no I/O. Output is a `RolePolicy` whose `allowedTools` and
 * `disallowedTools` are stable (sorted) for snapshot tests.
 *
 * `boilerplateKind` is currently unused by the resolver body but is kept in
 * the signature so Phase 2-D and beyond can branch on it (e.g. Vite vs
 * Next.js test runners) without changing every call site.
 */
export function resolveRolePolicy(
  boilerplateKind: BoilerplateType,
  rigor: PlanRigor,
  role: Role,
): RolePolicy {
  const base = ROLE_BASE[role];
  // Dedupe + stable order. Set preserves insertion order; we sort for
  // snapshot stability (the daemon doesn't care about order, but tests do).
  const allowed = Array.from(new Set(base.allowed)).sort();
  const disallowed = Array.from(new Set([...base.deniedExtras, ...BASELINE_DENY])).sort();

  const cap = TURN_CAPS[rigor][role];
  const maxTurns = typeof cap === 'number' ? cap : undefined;

  return {
    role,
    allowedTools: allowed,
    disallowedTools: disallowed,
    maxTurns,
  };
}

// ── AgentConfig serializer ─────────────────────────────────────────────────

/**
 * Bridge from `RolePolicy` to the existing `AgentConfig` string-shape that
 * the daemon's `agent-daemon.mjs:644-645` consumes via `--allowedTools` and
 * `--disallowedTools` CLI flags.
 *
 * The serializer is the only place the policy meets the daemon. Everywhere
 * else in the codebase should reason about `RolePolicy` directly.
 */
export function policyToAgentConfig(policy: RolePolicy, name: string, model?: string): AgentConfig {
  return {
    name,
    allowedTools: policy.allowedTools.join(','),
    disallowedTools: policy.disallowedTools.join(','),
    model,
  };
}

/**
 * Convenience: resolve + serialize in one call. Most call sites want this.
 */
export function buildAgentConfig(args: {
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  role: Role;
  name: string;
  model?: string;
}): AgentConfig {
  const policy = resolveRolePolicy(args.boilerplateKind, args.rigor, args.role);
  return policyToAgentConfig(policy, args.name, args.model);
}
