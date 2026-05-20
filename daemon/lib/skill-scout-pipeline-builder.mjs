/**
 * skill-scout-pipeline-builder.mjs — Pipeline v2 Phase 3-C Epic 3
 * (Story 3.3, 2026-05-20).
 *
 * Daemon-side builder that mirrors
 * `functions/shared/pipelines/skill-scout-pipeline.ts::generateSkillScoutPipeline`.
 * The TS module is the source of truth — keep this file in sync when
 * the schema or prompt changes. Same daemon-side-mirror pattern used by
 * `federation-loader.mjs` (Zod schema mirror) and `role-policy.mjs`
 * (allowlist mirror).
 *
 * Used by `daemon/pipelines/app-bootstrap.mjs` when it enqueues the T1
 * SKILL-SCOUT job at the end of bootstrap. The T2 path (Story 3.4)
 * uses the canonical TS builder via the API Lambda.
 *
 * Prompt uses `{{currentManifestYaml}}` / `{{federationYaml}}` /
 * `{{planIntent}}` placeholders so the runner can substitute them at
 * job-execution time with the most-current on-disk content (rather
 * than a stale snapshot from job-create time).
 */

import { buildAgentConfig } from '../pipelines/lib/role-policy.mjs';

// ── Trigger guidance (mirror of TS TRIGGER_GUIDANCE) ──

const TRIGGER_GUIDANCE = {
  T1: `\
**Trigger T1 — Project init.** This is the project's first encounter with the
skill federation. Propose the **core set** every project of this boilerplate
kind needs: format primitives (frontend-design, skill-creator), stack-
specific best-practices (vercel-react-best-practices for Next.js, etc.),
plus any obvious vendor skills implied by the boilerplate.

Bias toward a tight initial set — operators tune via T2 after the first plan
runs. Better to propose 4 strong matches than 8 mediocre ones.
`,
  T2: `\
**Trigger T2 — Plan intent submitted.** A plan is about to start; resolve
skills that would help DEV / TEST / REVIEWER complete this specific intent.
Read the intent carefully — propose skills that materially address it, not
generic "might be useful" items.

Examples:
  intent="add Stripe checkout" → vendor skill stripe-checkout
  intent="add chord overlay"   → domain skill music-theory-engine (if exists)
  intent="refactor render"     → process skill react-hooks-discipline

Do NOT re-propose skills already in the current manifest. Inspect
\`currentManifestYaml\` first.
`,
  T3: `\
**Trigger T3 — Brownfield audit.** This is an existing project receiving
its first manifest. Scan the project's code (file patterns, imports,
package.json deps) for evidence of skills already implicitly in use.
**Never auto-install under T3** — every proposal requires operator
confirmation regardless of confidence.
`,
};

/**
 * Build the SKILL-SCOUT prompt for a given trigger + context. Pure
 * string builder. Prompt body uses {{placeholder}} substitution for
 * the YAML blocks so the daemon's executeStep can fill them in at run
 * time from the project's current on-disk state.
 *
 * @param {{
 *   trigger: 'T1' | 'T2' | 'T3',
 *   projectSlug: string,
 *   boilerplateKind: string,
 * }} args
 * @returns {string}
 */
export function buildSkillScoutPromptDaemon(args) {
  const triggerGuidance = TRIGGER_GUIDANCE[args.trigger] || '';
  const intentBlock = args.trigger === 'T2'
    ? '\nPLAN INTENT (T2):\n{{planIntent}}\n'
    : '';

  return `\
You are SKILL-SCOUT — the resolver agent that proposes skill manifest edits
for a Futurator project. v2.5 §37.

PROJECT: ${args.projectSlug}
BOILERPLATE: ${args.boilerplateKind}
TRIGGER: ${args.trigger}
${intentBlock}
${triggerGuidance}

CURRENT PROJECT SKILL MANIFEST (\`.claude/skills.manifest.yaml\`):
\`\`\`yaml
{{currentManifestYaml}}
\`\`\`

FEDERATION SOURCES (\`~/.futurator/skill-federation.yaml\`):
\`\`\`yaml
{{federationYaml}}
\`\`\`

YOUR JOB
========
1. Identify candidate skills from the federation sources that materially
   help this project's needs (T1/T2) or that the code already implies
   (T3). Walk sources in priority order — lower priority wins by default.
2. For each candidate, propose a manifest action: add | remove | upgrade.
3. Verify each candidate per v2.5 §37.1: license header is permissive
   (MIT / Apache-2.0 / similar), description is concrete, no name
   collision with an existing manifest entry.
4. Score confidence 0.0 – 1.0. ≥ 0.9 may auto-confirm under prototype
   rigor only.
5. Skip candidates from non-auto-trust sources without explicit
   rationale.

YOU MUST NOT
============
- Write or modify the manifest yourself. The decision card + operator
  confirm + daemon skill-installer is the only write path.
- Re-propose anything already in the current manifest (T2/T3).
- Invent skills not in the federation.
- Use Bash for anything other than git log / grep against the local repo.

OUTPUT CONTRACT
===============
Emit ONE block between markers, containing a JSON object matching
\`SkillScoutOutputSchema\` (TS-side validator). Schema:

  {
    "trigger": "T1" | "T2" | ... | "T8",
    "projectSlug": "<slug>",
    "proposals": [
      {
        "kind": "add" | "remove" | "upgrade",
        "source": "<federation-source-id>",
        "skill": "<skill-name>",
        "manifestBucket": "core" | "stack" | "domain" | "vendor",
        "version": "sha:<40-hex>" | "tag:<semver-or-name>",
        "rationale": "<one-sentence>",
        "verifyNotes": "<one-sentence on license + freshness checks>",
        "confidence": 0.0..1.0
      }
    ]
  }

Emit empty \`proposals: []\` when no candidate meets the bar — DO NOT
fabricate proposals to be seen as helpful.

---SKILL_PROPOSALS---
{ "trigger": "...", "projectSlug": "...", "proposals": [] }
---END_SKILL_PROPOSALS---
`;
}

/**
 * Build the SKILL-SCOUT pipeline definition (mirror of TS
 * `generateSkillScoutPipeline`). Single agent, single step.
 *
 * @param {{
 *   trigger: 'T1' | 'T2' | 'T3',
 *   projectSlug: string,
 *   boilerplateKind: string,
 *   rigor: 'prototype' | 'mvp' | 'production',
 *   model?: string,
 * }} args
 * @returns {object} PipelineDefinition-shaped object
 */
export function buildSkillScoutPipelineDaemon(args) {
  const prompt = buildSkillScoutPromptDaemon({
    trigger: args.trigger,
    projectSlug: args.projectSlug,
    boilerplateKind: args.boilerplateKind,
  });

  return {
    maxIterations: 2,
    agents: {
      SKILL_SCOUT: buildAgentConfig({
        role: 'SKILL_SCOUT',
        name: 'Skill Scout',
        model: args.model || 'sonnet',
        rigor: args.rigor,
      }),
    },
    steps: [
      {
        id: 'skill-scout-resolve',
        agentId: 'SKILL_SCOUT',
        prompt,
        extractors: {
          SKILL_PROPOSALS_JSON: {
            type: 'between',
            startDelimiter: '---SKILL_PROPOSALS---',
            endDelimiter: '---END_SKILL_PROPOSALS---',
          },
        },
        validations: [],
      },
    ],
  };
}
