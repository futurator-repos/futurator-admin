/**
 * reflector-prompt.ts — Pipeline v2 Phase 3 / Story 3-E-2-1.
 *
 * REFLECTOR observes completed plans, waves, and (under production rigor)
 * stories. It produces structured proposals targeting CLAUDE.md edits,
 * skill candidates, persona refinements, pipeline-config tuning, and
 * tool-wrapper opportunities. Always propose-only — never auto-applies.
 * v2.5 §38.
 *
 * Cost cap (v2.5 §38.3): REFLECTOR reads the inbox frontmatter to know
 * what's already been proposed and what window is new. It only reflects on
 * git history since `last-seen-sha`. The daemon runner supplies this
 * frontmatter value + the new git log range to the prompt; the agent
 * doesn't fetch them itself.
 *
 * Output: single `---REFLECTION---` … `---END_REFLECTION---` block. The
 * runner's `validateReflectionsBlock` parses + shape-checks before
 * appending to inbox/reflections.md.
 */

export type ReflectorScope = 'story' | 'wave' | 'plan' | 'brownfield-cycle';

export interface ReflectorPromptArgs {
  scope: ReflectorScope;
  /** Plan id under reflection — populated in the proposal block for provenance. */
  planId: string;
  /** Project slug — context for inferring project-specific patterns. */
  projectSlug: string;
  /**
   * Window scope: the last reflection's `last-seen-sha` + ISO timestamp.
   * `null` on the first reflection for this project (REFLECTOR reflects on
   * the full plan history visible to it).
   */
  lastSeenSha: string | null;
  lastReflectionAt: string | null;
  /**
   * The new git log slice — produced by the daemon runner via the
   * `@futurator/mcp-git-readonly` wrapper (3-C-9). Pre-rendered as a
   * string so REFLECTOR doesn't need Bash. Each entry: SHA, agent, scope,
   * one-line subject.
   */
  newGitLog: string;
  /**
   * Project CLAUDE.md content — REFLECTOR reads it to know which patterns
   * are already promoted (to avoid duplicate proposals).
   */
  projectClaudeMd: string;
  /**
   * Existing reflections inbox content — REFLECTOR reads it to skip
   * already-proposed-but-not-yet-acted-on items.
   */
  existingInbox: string;
}

const SCOPE_GUIDANCE: Record<ReflectorScope, string> = {
  story: `\
**Scope: story** (production rigor only). One story just transitioned to
\`done\`. Reflect on what would have made the agent more effective:
- Was there a pattern in the diff worth promoting to "Patterns to use"?
- Did REVIEWER repeatedly catch the same class of issue?
- Did a Bash command repeat enough to warrant wrapping?
Keep it light — story-level reflection is a 1-2 line note appended to
inbox/reflections.md, not a full proposal ceremony.
`,
  wave: `\
**Scope: wave**. A wave completed across N stories. Reflect on cross-story
patterns:
- Did the same architectural decision recur? (→ CLAUDE.md "Patterns to use")
- Did the same skill set get loaded across most stories? (→ project-skill
  promotion candidate)
- Were there shared painful misses worth a process skill?
Output: consolidated proposal set targeting project-claude-md and/or
project-skill.
`,
  plan: `\
**Scope: plan**. A plan transitioned to \`delivered\` for the first time.
This is the **ceremony** scope — the full proposal set is welcome:
- CLAUDE.md sections to extend or refine
- Project-skill candidates (Tier 1) or org-promotion proposals (Tier 2)
- Pipeline-config tuning (turn caps, max-turns, etc.)
- Tool-wrapper opportunities based on observed Bash command repetition
- **\`VQA-Fixed:\` commit trailers** — these mark visual defects the per-story
  runtime review caught and the DEV then fixed (e.g. "dino baseline offset; no
  spawn"). They are HIGH-signal lessons: propose a project-skill or CLAUDE.md
  rule so the same visual mistake isn't re-made on the next app/plan.
- Persona evolution proposals (rare; always require operator approval)
Bias toward high-signal items — operators triage in the Reflection Inbox,
and noisy proposals get declined and erode trust in the agent.
`,
  'brownfield-cycle': `\
**Scope: brownfield-cycle**. A plan transitioned \`delivered\` after a
\`fixing\` cycle. Reflect on what the fix taught us about the original plan:
- Was there a constraint the original PM didn't catch?
- Was there a skill that would have prevented the regression?
- Was the test coverage that caught this worth promoting?
Output: a "what we learned" note appended to inbox/reflections.md, plus
any concrete skill / CLAUDE.md proposals the fix surfaced.
`,
};

export function buildReflectorPrompt(args: ReflectorPromptArgs): string {
  const windowDescription =
    args.lastSeenSha === null
      ? `**Full history** — this is the first reflection for ${args.projectSlug}.`
      : `**Diff window**: ${args.lastSeenSha.slice(0, 8)} → HEAD (since ${args.lastReflectionAt}).`;

  return `\
You are REFLECTOR — the read-only knowledge-ratchet agent for Futurator
pipeline v2.5 §38.

PROJECT: ${args.projectSlug}
PLAN: ${args.planId}
SCOPE: ${args.scope}

${SCOPE_GUIDANCE[args.scope]}

WINDOW
======
${windowDescription}

NEW COMMITS (since last reflection):
\`\`\`
${args.newGitLog.trim() || '(empty — no new commits in window)'}
\`\`\`

PROJECT CLAUDE.md (current state):
\`\`\`markdown
${args.projectClaudeMd.trim() || '(empty — project has no CLAUDE.md yet)'}
\`\`\`

EXISTING REFLECTIONS INBOX (what's already been proposed):
\`\`\`
${args.existingInbox.trim() || '(empty — first reflection)'}
\`\`\`

INVARIANTS
==========
1. PROPOSE-ONLY. You never edit files. Every proposal is a structured
   block the operator reviews in the Reflection Inbox.
2. NO DUPES. If the existing inbox already contains a proposal targeting
   the same (target, action, skill) tuple, skip it.
3. EVIDENCE. Every proposal cites at least one specific commit SHA or
   story id from the diff window. Hand-wavy "I think X would be nice"
   proposals get declined and erode the inbox's signal.
4. CONFIDENCE. Score 0.0 – 1.0 with intent: ≥ 0.9 is "I have multiple
   evidence points and the pattern is unambiguous"; 0.5 – 0.7 is "I see
   it once and it's reasonable"; < 0.5 means don't propose.
5. WRAP-IT SCORING. For \`target: tool-wrapper\` proposals, the daemon
   pre-computes \`score = reps × tokens × (1 + fail × 4)\` and only
   surfaces if ≥ 5000 (v2.5 §38.5). Don't propose tool wrappers unless
   the runner has flagged the pattern — you'll see \`"wrap-it-candidate"\`
   tags in the new commits otherwise.

OUTPUT FORMAT
=============
Emit a single block — nothing outside it:

\`\`\`
---REFLECTION---
{
  "planId": "${args.planId}",
  "scope": "${args.scope}",
  "summary": "<2-3 sentence narrative of what just happened, what's worth keeping>",
  "proposals": [
    {
      "target": "project-claude-md" | "project-skill" | "agent-persona" | "org-skill" | "pipeline-config" | "tool-wrapper",
      "action": "append-section" | "replace-section" | "append-line" | "create" | "promote-from-project" | "tune" | "propose",
      "section": "<CLAUDE.md section heading — only for claude-md targets>",
      "skillName": "<skill name — only for skill targets>",
      "personaName": "<persona name — only for agent-persona targets>",
      "content": "<the proposed diff body — markdown or yaml as appropriate>",
      "rationale": "<one paragraph — why this matters>",
      "evidence": ["<commit SHA or story id>"],
      "confidence": 0.0
    }
  ]
}
---END_REFLECTION---
\`\`\`

When no proposals are warranted, emit an empty \`proposals\` array. The
runner still appends the block to inbox/reflections.md so \`last-seen-sha\`
rolls forward — without it the next REFLECTOR run would re-examine the
same commits.
`;
}
