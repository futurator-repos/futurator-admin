/**
 * Daemon-side mirror of `functions/shared/pipelines/role-policy.ts` (PR-32).
 *
 * Pipeline v2 — Phase 2-A Story 2-A-1-1 follow-up (PR-32b).
 *
 * Why a mirror, not a shared module: the daemon is pure Node ESM (no
 * TypeScript build step), while the API Lambda's pipelines are `.ts`. Until
 * a shared JSON build emit is set up (deferred), the two sides keep
 * parallel data tables. A parity vitest (`role-policy-parity.test.mjs`)
 * asserts the shared roles produce byte-identical AgentConfig strings on
 * both sides; drift on either side fails CI.
 *
 * Pipeline-3: buildAgentConfig delegates model selection to model-router's
 * `selectModel` when no explicit model is passed. Routing is OFF by default
 * (P3_MODEL_ROUTING), so output is byte-identical to legacy unless opted in.
 *
 * ── Roles covered ──────────────────────────────────────────────────────────
 *
 * Shared with the TS resolver: TEST, DEV, REVIEWER, COMPILER, QA, PM,
 * API_AUTHOR.
 *
 * Daemon-only roles (the API Lambda never spawns these — they're created
 * by daemon-orchestrated background jobs): CONVERSATION, REFLECTION,
 * DEPLOY. These mirror the existing pre-PR-32b allowlists in
 * conversation-pipeline.mjs / self-reflection-pipeline.mjs /
 * deploy-compile-pipeline.mjs.
 *
 * ── Behaviour delta ────────────────────────────────────────────────────────
 *
 * Same tightening pattern as PR-32: every role gains the PR-3 baseline
 * deny (Task / Agent / WebFetch / WebSearch). Read-only-ish roles
 * (CONVERSATION / REFLECTION) gain Write/Edit deny. No agent loses tools.
 *
 * ── Out of scope ───────────────────────────────────────────────────────────
 *
 * - Rigor / boilerplate-kind awareness — the daemon's compile / deploy /
 *   reflection pipelines run as background jobs without explicit rigor.
 *   When daemon picks up rigor-aware policies, extend `buildAgentConfig`
 *   to take an options bag.
 * - `party-turn.mjs` and `touch-point-inference.mjs` use bespoke
 *   allowedTools shapes (per-project array, empty-string explicit no-tool)
 *   and stay out of scope here.
 */

import { selectModel } from '../../lib/model-router.mjs';

const BASELINE_DENY = ['Task', 'Agent', 'WebFetch', 'WebSearch'];

// PR-38 — per-rigor turn caps from v2.5 §17. `null` (or absent) → no cap.
// Mirrors functions/shared/pipelines/role-policy.ts TURN_CAPS exactly.
// The mvp matrix is the daemon's default since most daemon-spawned roles
// (CONVERSATION/REFLECTION/DEPLOY/COMPILER) run as background work without
// rigor context — they get null. Story-pipeline roles (TEST/DEV/REVIEWER/
// API_AUTHOR/QA/PM) DO receive rigor today via opts.rigor; for those the
// MJS resolver still returns the table value below.
const TURN_CAPS_BY_RIGOR = {
  prototype: {
    API_AUTHOR: null,
    TEST: 6,
    DEV: 8,
    REVIEWER: 4,
    COMPILER: null,
    QA: null,
    PM: null,
    SKILL_SCOUT: 4,
    REFLECTOR: 4,
    TRIAGE: 4,
    ARCHITECT: 4,
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
    SKILL_SCOUT: 8,
    REFLECTOR: 8,
    TRIAGE: 8,
    ARCHITECT: 8,
    CONVERSATION: null,
    REFLECTION: null,
    DEPLOY: null,
  },
};

const ROLE_BASE = {
  // ── Shared roles (mirror the TS resolver exactly) ─────────────────────
  // Step-0.9b (2026-06-05) — 'Skill' allowlisted for per-story pipeline
  // roles: skills loaded in every session but no role permitted the Skill
  // tool, so activation was structurally impossible (skill_activated = 0
  // table-wide). Read-only context injection; safe for read-only judges.
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
    deniedExtras: ['Write', 'Edit', 'Bash'],
  },
  COMPILER: {
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill'],
    deniedExtras: ['Bash'],
  },
  QA: {
    allowed: ['Bash', 'Read', 'Write', 'Glob', 'Skill'],
    deniedExtras: [],
  },
  PM: {
    allowed: ['Read'],
    deniedExtras: ['Bash', 'Write', 'Edit'],
  },

  // ── Phase 3 (PR-72 / Story 3-C-3-1) ─────────────────────────────────────
  // SKILL-SCOUT: read-mostly resolver, Bash for license/freshness checks.
  // Manifest writes flow through the daemon's skill-installer helper, not
  // the agent's own tool calls — Write/Edit/NotebookEdit denied.
  SKILL_SCOUT: {
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit'],
  },

  // ── Phase 3 (PR-74/75 / Story 3-E-2-1) ──────────────────────────────────
  // REFLECTOR: strictly propose-only per v2.5 §38.2. Bash denied at the
  // CLI layer — git read verbs flow through @futurator/mcp-git-readonly
  // (3-C-9). Distinct from REFLECTION (daemon v1 health analyst).
  REFLECTOR: {
    allowed: ['Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
  },

  // ── Phase 3 (PR-81 / Story 3-E-6-1) ─────────────────────────────────────
  // TRIAGE: relevance-ranker for cross-plan feedback. Read-only.
  TRIAGE: {
    allowed: ['Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
  },

  // ── Phase 2-D (PR-90 / Story 2-D-6-1) ───────────────────────────────────
  // ARCHITECT: AWS/integrations manifest resolver. Bash allowed for
  // `cdk diff` / `cdk synth` / aws CLI verification.
  ARCHITECT: {
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit', 'NotebookEdit'],
  },

  // ── Daemon-only roles (no API Lambda equivalent) ──────────────────────
  CONVERSATION: {
    // Read-mostly + Bash for context-gathering shells. No Write/Edit —
    // the conversation agent doesn't modify the tree.
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit'],
  },
  REFLECTION: {
    // Same shape as CONVERSATION — health analyst reads + grep, no edits.
    allowed: ['Bash', 'Read', 'Grep', 'Glob'],
    deniedExtras: ['Write', 'Edit'],
  },
  DEPLOY: {
    // Deploy compile mutates a small set of knowledge files. Same allowlist
    // as COMPILER; the prompt is what differs.
    allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    deniedExtras: ['Bash'],
  },
};

/**
 * Resolve and serialize an AgentConfig for the daemon's spawn loop.
 *
 * @param {{
 *   role: keyof typeof ROLE_BASE,
 *   name: string,
 *   model?: string,
 *   rigor?: 'prototype' | 'mvp' | 'production',
 * }} args
 * @returns {{
 *   name: string,
 *   allowedTools: string,
 *   disallowedTools: string,
 *   model?: string,
 *   maxTurns?: number,
 * }}
 */
export function buildAgentConfig({ role, name, model, rigor, complexity, chars, items, env }) {
  const base = ROLE_BASE[role];
  if (!base) {
    throw new Error(`role-policy: unknown role "${role}". Known: ${Object.keys(ROLE_BASE).join(', ')}`);
  }
  const allowed = Array.from(new Set(base.allowed)).sort();
  const disallowed = Array.from(new Set([...base.deniedExtras, ...BASELINE_DENY])).sort();
  const out = {
    name,
    allowedTools: allowed.join(','),
    disallowedTools: disallowed.join(','),
  };
  // Pipeline-3 model routing (development-plan §5.4): when no explicit model is
  // given, ask the router. It returns the (undefined) default unless
  // P3_MODEL_ROUTING=on, so legacy output is byte-identical — the parity test
  // and every existing caller are unaffected.
  let resolvedModel = model;
  if (resolvedModel === undefined) {
    resolvedModel = selectModel({ role, complexity, rigor, chars, items, defaultModel: undefined, env });
  }
  if (resolvedModel !== undefined) out.model = resolvedModel;
  // PR-38 — apply per-rigor turn cap when rigor is provided. Daemon-only
  // roles + missing rigor → no cap. The Claude CLI treats missing
  // `--max-turns` as no cap.
  if (rigor && TURN_CAPS_BY_RIGOR[rigor]) {
    const cap = TURN_CAPS_BY_RIGOR[rigor][role];
    if (typeof cap === 'number' && cap > 0) {
      out.maxTurns = cap;
    }
  }
  return out;
}

/**
 * Resolve just the comma-joined allowedTools string for callers that put
 * `allowedTools` on the step directly (epic-compile-pipeline,
 * deploy-compile-pipeline) rather than on the agent definition.
 *
 * @param {keyof typeof ROLE_BASE} role
 * @returns {string}
 */
export function buildAllowedToolsString(role) {
  const cfg = buildAgentConfig({ role, name: '_' });
  return cfg.allowedTools;
}

/**
 * Resolve just the comma-joined disallowedTools string for the symmetric
 * case (step-level disallowedTools).
 *
 * @param {keyof typeof ROLE_BASE} role
 * @returns {string}
 */
export function buildDisallowedToolsString(role) {
  const cfg = buildAgentConfig({ role, name: '_' });
  return cfg.disallowedTools;
}

/** All roles known to this resolver. */
export const KNOWN_ROLES = Object.keys(ROLE_BASE);

/**
 * The roles this resolver shares with `functions/shared/pipelines/role-policy.ts`.
 * Used by the parity test to know which roles to cross-validate.
 */
export const SHARED_ROLES = [
  'API_AUTHOR',
  'TEST',
  'DEV',
  'REVIEWER',
  'COMPILER',
  'QA',
  'PM',
  // PR-72 (Story 3-C-3-1) — SKILL-SCOUT spawned both from daemon
  // (T1 app-bootstrap, T2 plan pipeline) and from API Lambda
  // (T3 brownfield audit via POST /api/skills/audit). Parity test
  // cross-validates both sides.
  'SKILL_SCOUT',
  // PR-74 (Story 3-E-2-1) — REFLECTOR spawned from the daemon's
  // low-priority slot on wave/plan close. TS definition is the
  // pipeline definition source of truth; MJS mirror handles spawn.
  'REFLECTOR',
  // PR-81 (Story 3-E-6-1) — TRIAGE spawned on feedback-item arrival.
  // Cross-validated TS↔MJS parity at the role-policy level.
  'TRIAGE',
  // PR-90 (Story 2-D-6-1) — ARCHITECT spawned at T1/T2/T3 manifest-
  // resolution moments. Cross-validated TS↔MJS parity.
  'ARCHITECT',
];
