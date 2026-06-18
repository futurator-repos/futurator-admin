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
  // ── Phase 3 roles (PR-72 / Story 3-C-3-1) ─────────────────────────────
  // SKILL-SCOUT resolves the federation manifest against plan intent and
  // proposes manifest edits via the decision card. Read-only on the
  // filesystem (Write/Edit denied); Bash is allowed for license-header,
  // freshness, and description-collision verification.
  'SKILL_SCOUT',
  // ── Phase 3 (PR-74/75 / Story 3-E-2-1) ────────────────────────────────
  // REFLECTOR observes completed plans / waves / stories and emits
  // structured proposals to inbox/reflections.md. Bash is denied at the
  // CLI layer (v2.5 §38.2 propose-only invariant) — git read verbs are
  // exposed via the @futurator/mcp-git-readonly MCP wrapper (3-C-9),
  // never via raw shell. Distinct from the existing REFLECTION role
  // which is the v1 daemon self-health-analyst.
  'REFLECTOR',
  // ── Phase 3 (PR-81 / Story 3-E-6-1) ───────────────────────────────────
  // TRIAGE consumes a feedback item + cross-plan history (with project-
  // match weighting per v2.5 §43) and proposes a bugfix plan. Same
  // propose-only invariant as REFLECTOR — output is a decision card,
  // not a manifest edit.
  'TRIAGE',
  // ── Phase 2-D (PR-90 / Story 2-D-6-1) ─────────────────────────────────
  // ARCHITECT resolves plan intent against the project's aws.manifest.yaml
  // and integrations.manifest.yaml. Same role-shape as SKILL-SCOUT:
  // read-mostly + Bash for `cdk diff` / `cdk synth` / aws cli (via the
  // future MCP wrappers from Phase 3-C-9). Manifest writes flow through
  // the daemon's manifest-applier — never the agent's own Edit/Write.
  'ARCHITECT',
  // ── Concept v2 doc-engine (E2 / Story 2.3) ────────────────────────────
  // DOC_GEN is the capability bucket for the upstream document AUTHORS —
  // the prd-gen / ux-gen / arch-gen one-shot generators (PM John / UX Sally
  // / Architect Winston). Distinct from the read-only PM bucket (which the
  // Concept Router classifier and the pm-plan author use): a doc author is
  // the ONE pipeline role granted WebSearch, because the BMAD architecture
  // contract forbids hardcoding stale tech versions — the architect must be
  // able to verify "latest stable X" rather than pin a number that rots.
  // Output is the markdown in the response (captured by the step extractor);
  // the daemon write-back (E1.2) persists it, so Write/Edit/Bash stay denied.
  'DOC_GEN',
  // ── Daemon-only roles (PR-32b) ────────────────────────────────────────
  // The API Lambda never spawns these — they're created by daemon-
  // orchestrated background jobs (knowledge compile, deploy compile,
  // conversational agent, self-reflection). Defined here so the schema
  // covers the full role surface; the daemon mirrors them in
  // `daemon/pipelines/lib/role-policy.mjs` with byte-identical output
  // (parity test enforces).
  'CONVERSATION',
  'REFLECTION',
  'DEPLOY',
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
  // Step-0.9b (2026-06-05) — 'Skill' is allowlisted for the per-story
  // pipeline roles. The CLI loads project skills into every session
  // (skills_available: 66) but `--allowedTools` gates USE: with no role
  // permitting the Skill tool, zero activations were possible — table-wide
  // skill_activated count was 0. Skill is a read-only context injection
  // (loads a vendored SKILL.md), safe even for read-only judges.
  //
  // API-AUTHOR is reserved for Story 2-A-3-1. Until that story lands the
  // resolver returns a conservative default — no Edit, narrow Write — so
  // accidentally invoking the role in advance fails closed.
  API_AUTHOR: {
    allowed: ['Read', 'Write', 'Glob', 'Grep', 'Skill'],
    deniedExtras: ['Bash', 'Edit'],
  },
  TEST: {
    allowed: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'],
    deniedExtras: [],
  },
  DEV: {
    allowed: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill'],
    deniedExtras: [],
  },
  REVIEWER: {
    allowed: ['Read', 'Grep', 'Glob', 'Skill'],
    // Read-only: deny Bash + writes per v2.5 §10 ("Bash is the most
    // important deny — a Reviewer that can shell out can do anything").
    deniedExtras: ['Write', 'Edit', 'Bash'],
  },
  COMPILER: {
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'],
    // Knowledge-graph ops are pure file IO; compiler never shells out.
    deniedExtras: ['Bash'],
  },
  QA: {
    allowed: ['Bash', 'Read', 'Write', 'Glob', 'Skill'],
    deniedExtras: [],
  },
  PM: {
    // PM only reads — output is the plan JSON in the prompt response.
    allowed: ['Read'],
    deniedExtras: ['Bash', 'Write', 'Edit'],
  },

  // ── Phase 3 (PR-72 / Story 3-C-3-1) ─────────────────────────────────────
  SKILL_SCOUT: {
    // Read-mostly + Bash for license/freshness/collision verification of
    // candidate skills. Write/Edit denied — manifest writes flow through
    // the daemon's skill-installer helper (Agent: SKILL-SCOUT commit
    // metadata), not the agent's own tool calls. NotebookEdit also denied.
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit'],
  },

  // ── Phase 3 (PR-74/75 / Story 3-E-2-1) ──────────────────────────────────
  REFLECTOR: {
    // Strictly propose-only per v2.5 §38.2. Bash is denied at the CLI
    // layer — git read verbs come from the @futurator/mcp-git-readonly
    // MCP wrapper (3-C-9). Write / Edit / NotebookEdit all denied because
    // REFLECTOR's only output channel is the structured proposal block
    // appended to inbox/reflections.md by the daemon runner (not by the
    // agent itself).
    allowed: ['Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
  },

  // ── Phase 3 (PR-81 / Story 3-E-6-1) ─────────────────────────────────────
  TRIAGE: {
    // Read-only like REFLECTOR. Triage agent reads cross-project history +
    // current feedback item; output is a proposed bugfix plan card the
    // operator confirms. No write tools — plan creation flows through the
    // existing API surface, not this agent's tool calls.
    allowed: ['Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
  },

  // ── Phase 2-D (PR-90 / Story 2-D-6-1) ───────────────────────────────────
  ARCHITECT: {
    // Read-mostly + Bash for cdk diff / cdk synth / aws CLI verification.
    // Manifest writes are NOT through the agent's Edit/Write — the daemon's
    // manifest-applier handles them after the operator confirms the
    // decision card. Same pattern as SKILL-SCOUT (PR-72).
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit'],
  },

  // ── Concept v2 doc-engine (E2 / Story 2.3) ──────────────────────────────
  DOC_GEN: {
    // Read + WebSearch only. WebSearch is the one baseline-denied tool a
    // pipeline role opts back into (the `allowed`-wins rule in
    // resolveRolePolicy lifts it out of BASELINE_DENY). Bash/Write/Edit are
    // explicitly denied — the generator authors prose into its response, not
    // the filesystem (the daemon write-back owns disk).
    allowed: ['Read', 'WebSearch'],
    deniedExtras: ['Bash', 'Write', 'Edit'],
  },

  // ── Daemon-only roles (PR-32b — see RoleSchema comment) ─────────────────
  CONVERSATION: {
    // Read-mostly + Bash for context-gathering shells. No Write/Edit.
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit'],
  },
  REFLECTION: {
    // Health analyst — same shape as CONVERSATION.
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit'],
  },
  DEPLOY: {
    // Deploy compile mutates a small set of knowledge files. Same
    // allowlist as COMPILER; the prompt is what differs.
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    deniedExtras: ['Bash'],
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
    // PR-72 (Story 3-C-3-1) — read-mostly resolver, single-pass.
    SKILL_SCOUT: 4,
    // PR-74 (Story 3-E-2-1) — REFLECTOR scoped by inbox frontmatter
    // diff window per v2.5 §38.3; tight cap holds even in production.
    REFLECTOR: 4,
    // PR-81 (Story 3-E-6-1) — TRIAGE is a single-shot relevance ranker.
    TRIAGE: 4,
    // PR-90 (Story 2-D-6-1) — ARCHITECT bounded by manifest size; tight cap.
    ARCHITECT: 4,
    // E2 — single-shot doc generators; pipeline maxIterations already bounds them.
    DOC_GEN: null,
    // Daemon-only roles — no caps (background jobs, single-pass agents)
    CONVERSATION: null,
    REFLECTION: null,
    DEPLOY: null,
  },
  mvp: {
    API_AUTHOR: 2,
    TEST: 8,
    DEV: 10,
    REVIEWER: 6,
    COMPILER: null,
    QA: null,
    PM: null,
    SKILL_SCOUT: 6,
    REFLECTOR: 6,
    TRIAGE: 6,
    ARCHITECT: 6,
    DOC_GEN: null,
    CONVERSATION: null,
    REFLECTION: null,
    DEPLOY: null,
  },
  production: {
    API_AUTHOR: 2,
    TEST: 10,
    DEV: 12,
    REVIEWER: 8,
    COMPILER: null,
    QA: 8,
    PM: 6,
    // Opus when authoring per PR-72; cap larger to allow license-review
    // depth under production rigor.
    SKILL_SCOUT: 8,
    REFLECTOR: 8,
    TRIAGE: 8,
    ARCHITECT: 8,
    // Production arch-gen may need a couple WebSearch turns for version checks.
    DOC_GEN: 6,
    CONVERSATION: null,
    REFLECTION: null,
    DEPLOY: null,
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
  // `allowed` wins over the baseline deny: a role may opt back into a
  // baseline-denied tool by listing it in `allowed` (E2 — DOC_GEN does this
  // for WebSearch). A tool can never be both allowed and disallowed. For every
  // pre-E2 role this subtraction is a no-op (none list a baseline-denied tool),
  // so all existing snapshots are byte-identical.
  const allowedSet = new Set(allowed);
  const disallowed = Array.from(new Set([...base.deniedExtras, ...BASELINE_DENY]))
    .filter((t) => !allowedSet.has(t))
    .sort();

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
  const cfg: AgentConfig = {
    name,
    allowedTools: policy.allowedTools.join(','),
    disallowedTools: policy.disallowedTools.join(','),
    model,
  };
  // PR-38 — propagate the rigor-derived turn cap. Daemon emits `--max-turns`
  // when set; the Claude CLI defaults to no cap when absent.
  if (typeof policy.maxTurns === 'number' && policy.maxTurns > 0) {
    cfg.maxTurns = policy.maxTurns;
  }
  return cfg;
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
