/**
 * skill-scout-prompt.ts — Pipeline v2 Phase 3 / Story 3-C-3-1.
 *
 * The SKILL-SCOUT agent resolves the project skill manifest against plan
 * intent + the operator's federation. v2.5 §37 — read, verify, surface.
 *
 * Three trigger entry points (Story 3-C-3-2 wires them):
 *
 *   T1: project init                 (full federation sweep, all kinds)
 *   T2: plan intent submitted        (targeted resolve against intent)
 *   T3: brownfield audit             (reports against current code only)
 *
 * The agent NEVER installs unilaterally — every proposal renders as a
 * decision card and operator confirmation is required for mvp+ rigor.
 * Prototype rigor auto-confirms when confidence ≥ 0.9. v2.5 §37.2.
 *
 * Output contract: a single `---SKILL_PROPOSALS---` … `---END_SKILL_PROPOSALS---`
 * block containing a JSON array of `SkillProposal` objects. The pipeline's
 * `between` extractor captures it for `validateSkillProposals()` to parse +
 * shape-check before the decision card surfaces.
 */

export type SkillScoutTrigger = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';

export interface SkillScoutPromptArgs {
  trigger: SkillScoutTrigger;
  projectSlug: string;
  /** Plan intent text — required for T2; absent for T1/T3. */
  planIntent?: string;
  /** Boilerplate kind from registry — drives default stack inference. */
  boilerplateKind: string;
  /**
   * Current project manifest serialized as YAML. Empty / minimal for T1
   * (first run); populated for T2 + T3 so SCOUT can detect duplicates.
   */
  currentManifestYaml: string;
  /**
   * Federation sources visible to the resolver, serialized as YAML. Read-
   * only context — SCOUT references source IDs in its proposals.
   */
  federationYaml: string;
}

const TRIGGER_GUIDANCE: Record<SkillScoutTrigger, string> = {
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

Pay particular attention to:
  - package.json dependencies → vendor skill candidates
  - src/ file structure       → stack skill matches
  - test patterns             → process skill candidates
`,
  T4: `\
**Trigger T4 — PM speculation marker.** PM has emitted a speculation
block in the plan (v2.5 §28). For each \`explore/<plan-id>-<approach>\`
branch's intended approach, propose skills that materially differ
between the candidates. The runner threads which branch each proposal
belongs to in the \`Plan intent\` block above; respect the implicit
constraint that proposals for the same skill across branches should
*meaningfully differ* (different version, different source, different
auto-trust posture) — duplicate proposals across branches add no value.

Production rigor only. Always surface card.
`,
  T5: `\
**Trigger T5 — New dependency added.** A commit just landed a new
\`package.json\` entry (top-level dependencies or devDependencies — not
transitive lockfile changes). The plan intent text above reads
"\\<dep-name\\> added to dependencies"; the right move is usually a single
\`vendor\` skill proposing \`<dep>-best-practices\` if the federation
carries it.

Noise control: skip if no federation source carries a matching skill.
Skip if a manifest entry already references this dependency.
`,
  T6: `\
**Trigger T6 — REVIEWER repeats failure.** COMPILER has observed
REVIEWER rejecting ≥ 3 stories in the same wave for the same file-
cluster. Look for a \`process\` skill that addresses the cluster — e.g.
recurring React hooks misuse → \`react-hooks-discipline\`; recurring
state-shape drift → \`zod-schema-first\`. Bias toward known process
skills in the federation rather than authoring a new one.

If no fit exists, do not propose — the gap is recorded for distillation
(3-C-6) which spawns skill-creator under production rigor.
`,
  T7: `\
**Trigger T7 — Stream graduates to plan.** A \`stream/<n>\` branch is
becoming a Labs plan. The stream's commits inform the proposal — recurring
patterns in stream commits often crystallize into stack skills the
plan should adopt before its first wave.

Treat the stream's commit history (in the diff above) as evidence; the
typical resolution is 1-2 stack skills, occasionally a domain skill.
`,
  T8: `\
**Trigger T8 — Weekly refresh.** The federation's weekly cron fired and
detected new skill versions / new skills / deprecation warnings. For
each delta the refresh runner flagged in the plan-intent block:

  - new version of an installed skill → \`upgrade\` action
  - deprecation past \`deprecate-by\` → \`upgrade\` or \`remove\` action
  - new popular skill in a relevant source → \`add\` action if stack matches

Always surface card under any rigor — operator decides whether to
disrupt running projects with upgrades.
`,
};

/**
 * Build the SKILL-SCOUT prompt for a given trigger + context. Pure string
 * builder — no I/O.
 */
export function buildSkillScoutPrompt(args: SkillScoutPromptArgs): string {
  const triggerGuidance = TRIGGER_GUIDANCE[args.trigger];
  const intentBlock = args.planIntent ? `\nPLAN INTENT (T2):\n${args.planIntent.trim()}\n` : '';

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
${args.currentManifestYaml.trim()}
\`\`\`

FEDERATION SOURCES (\`~/.futurator/skill-federation.yaml\`):
\`\`\`yaml
${args.federationYaml.trim()}
\`\`\`

YOUR JOB
========
1. Identify candidate skills from the federation sources that materially
   help this project's needs (T1/T2) or that the code already implies
   (T3). Walk sources in priority order — lower priority wins by default.
2. For each candidate, propose a manifest action: add | remove | upgrade.
3. Verify each candidate per v2.5 §37.1: license header is permissive
   (MIT / Apache-2.0 / similar), description is concrete (not "AI-powered"
   marketing prose), no name collision with an existing manifest entry.
4. Score confidence 0.0 – 1.0. Production rigor verification depth scales
   with this score; ≥ 0.9 may auto-confirm under prototype rigor only.
5. Skip candidates from non-auto-trust sources without explicit rationale
   for why operator should accept the trust expansion.

YOU MUST NOT
============
- Write or modify the manifest yourself. The decision card + operator
  confirm + daemon skill-installer is the only write path.
- Re-propose anything already in the current manifest (T2/T3).
- Invent skills not in the federation. The skill-creator sub-plan handles
  authoring; that's a separate flow.
- Use Bash for anything other than git log / grep against the local repo
  (license header inspection, freshness checks). No network shell-outs.

OUTPUT FORMAT
=============
Emit a single block — nothing outside it:

\`\`\`
---SKILL_PROPOSALS---
{
  "trigger": "${args.trigger}",
  "projectSlug": "${args.projectSlug}",
  "proposals": [
    {
      "kind": "add",
      "source": "<federation source id>",
      "skill": "<skill name>",
      "manifestBucket": "core" | "stack" | "domain" | "vendor",
      "version": "sha:<40-char>" | "tag:<semver>",
      "rationale": "<one sentence — why this project benefits>",
      "verifyNotes": "<license / freshness / collision check result>",
      "confidence": 0.0
    }
  ]
}
---END_SKILL_PROPOSALS---
\`\`\`

When no proposals are warranted, emit an empty \`proposals\` array. Do not
omit the block — the daemon depends on the marker to confirm SKILL-SCOUT
ran (vs. crashed silently). Empty array → no operator card surfaces.
`;
}
