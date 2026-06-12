/**
 * reflector-runner.mjs — Pipeline v2 Phase 3 / Story 3-E-2-1 + 3-E-2-2.
 *
 * Daemon-side orchestration for REFLECTOR runs. Bridges the memory store
 * (PR-77) + git log slice + project CLAUDE.md into the pipeline args the
 * daemon spawn loop consumes, then handles output by appending to
 * `inbox/reflections.md` and rolling the `last-seen-sha` frontmatter
 * forward atomically.
 *
 * Triggers (per v2.5 §38.1 + Story 3-E-2-2; trigger-point wiring is
 * follow-on):
 *   - story  → done       (production rigor only — per-story light)
 *   - wave   → complete   (all rigors)
 *   - plan   → delivered  (all rigors, first time)
 *   - plan   → delivered  (all rigors, after `fixing` cycle = 'brownfield-cycle')
 *
 * Quiet-window scheduling (Story 3-E-2-2 AC #2) lives in agent-daemon.mjs's
 * future `reflection-scheduler.mjs`; this runner is the per-invocation
 * orchestrator and doesn't decide *when* to fire.
 *
 * Cost cap (v2.5 §38.3): the runner reads the inbox frontmatter
 * `last-seen-sha` + `last-reflection-at` and produces the new-commits
 * window so REFLECTOR's input scope stays bounded.
 */

import { execFileSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/**
 * Parse the `inbox/reflections.md` frontmatter cursor. Returns
 * `{ lastSeenSha, lastReflectionAt, body }`. Missing or malformed
 * frontmatter is treated as `{ null, null, raw }` — never throws.
 *
 * @param {string | null} raw  content of inbox/reflections.md (null = missing file)
 * @returns {{ lastSeenSha: string | null, lastReflectionAt: string | null, body: string }}
 */
export function parseInboxFrontmatter(raw) {
  if (raw == null || raw.length === 0) {
    return { lastSeenSha: null, lastReflectionAt: null, body: '' };
  }
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { lastSeenSha: null, lastReflectionAt: null, body: raw };
  }
  const [, yaml, body] = match;
  try {
    const meta = parseYaml(yaml) ?? {};
    const lastSeenSha = typeof meta['last-seen-sha'] === 'string' ? meta['last-seen-sha'] : null;
    const lastReflectionAt =
      typeof meta['last-reflection-at'] === 'string' ? meta['last-reflection-at'] : null;
    return { lastSeenSha, lastReflectionAt, body };
  } catch {
    return { lastSeenSha: null, lastReflectionAt: null, body: raw };
  }
}

/**
 * Serialize updated frontmatter + appended block. The runner produces a
 * NEW file body where:
 *  - The `---` frontmatter at top reflects the latest cursor
 *  - The previous body is preserved verbatim
 *  - The new REFLECTION block (raw, including markers) is appended
 *
 * Callers feed this to `memoryStore.writeAtomic('inbox', 'reflections.md', body)`.
 *
 * @param {{ lastSeenSha: string, lastReflectionAt: string, previousBody: string, newReflectionBlock: string }} args
 * @returns {string}
 */
export function renderInboxAfterReflection({
  lastSeenSha,
  lastReflectionAt,
  previousBody,
  newReflectionBlock,
}) {
  const head = `---\nlast-seen-sha: ${lastSeenSha}\nlast-reflection-at: ${lastReflectionAt}\n---\n`;
  const prev = previousBody.replace(/^[\r\n]+/, '');
  const block = newReflectionBlock.endsWith('\n')
    ? newReflectionBlock
    : newReflectionBlock + '\n';
  // Always include a separator between the previous body and the new block
  // so consecutive reflections don't run together.
  const separator = prev.length > 0 && !prev.endsWith('\n') ? '\n\n' : '\n';
  return head + prev + separator + block;
}

/**
 * Render the new-commits git log slice REFLECTOR consumes. Until the
 * `@futurator/mcp-git-readonly` MCP wrapper (Story 3-C-9) lands, this
 * shells out via `execFileSync` from the runner (NOT from the agent —
 * the agent has Bash denied). One-shot, short, no streaming.
 *
 * @param {{
 *   repoPath: string,
 *   lastSeenSha: string | null,
 *   limit?: number,
 *   gitFn?: (cwd: string, args: string[]) => string,
 * }} args
 * @returns {string} pre-rendered git log text
 */
export function renderNewGitLog({ repoPath, lastSeenSha, limit = 100, gitFn }) {
  const runGit =
    gitFn ||
    ((cwd, args) =>
      execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }));

  // Pretty: <short-sha> <subject> — keep it line-oriented for the prompt.
  // We don't include the full body — REFLECTOR has Read tool access to
  // pull individual commits if it needs detail (within the diff window).
  const pretty = ['--pretty=format:%h %s'];
  const range = lastSeenSha ? [`${lastSeenSha}..HEAD`] : ['HEAD'];
  const limitFlag = [`-n`, String(limit)];

  try {
    const args = ['log', ...limitFlag, ...pretty, ...range];
    return runGit(repoPath, args).trim();
  } catch {
    // Cursor SHA may not exist (e.g. branch deletion, force-push). Fall
    // back to the most recent N commits.
    if (lastSeenSha) {
      try {
        return runGit(repoPath, ['log', ...limitFlag, ...pretty, 'HEAD']).trim();
      } catch {
        return '';
      }
    }
    return '';
  }
}

/**
 * Build the inputs the TS pipeline definition `generateReflectorPipeline`
 * expects. Pure assembly — no I/O of its own; callers supply the inbox +
 * git slice + claude-md content.
 *
 * Returns `{ scope, planId, projectSlug, boilerplateKind, rigor,
 * lastSeenSha, lastReflectionAt, newGitLog, projectClaudeMd, existingInbox }`
 * — the shape `ReflectorPipelineArgs` declares in
 * `functions/shared/pipelines/reflector-pipeline.ts`.
 */
export function buildPipelineArgs({
  scope,
  planId,
  projectSlug,
  boilerplateKind,
  rigor,
  inboxRaw,
  newGitLog,
  projectClaudeMd,
}) {
  const { lastSeenSha, lastReflectionAt, body } = parseInboxFrontmatter(inboxRaw);
  return {
    scope,
    planId,
    projectSlug,
    boilerplateKind,
    rigor,
    lastSeenSha,
    lastReflectionAt,
    newGitLog,
    projectClaudeMd: projectClaudeMd ?? '',
    existingInbox: body,
  };
}

/**
 * Decide whether REFLECTOR should fire for the given (rigor, scope) pair.
 * Per v2.5 §38.1: light story-scope reflection is production rigor only;
 * everything else fires regardless of rigor.
 *
 * @param {{ rigor: 'prototype' | 'mvp' | 'production', scope: 'story' | 'wave' | 'plan' | 'brownfield-cycle' }} args
 * @returns {{ shouldFire: boolean, reason: string }}
 */
export function shouldFireReflection({ rigor, scope }) {
  if (scope === 'story' && rigor !== 'production') {
    return {
      shouldFire: false,
      reason: 'story-scope reflection is production-rigor only (v2.5 §38.1)',
    };
  }
  return { shouldFire: true, reason: `${scope}-scope fires under ${rigor}` };
}

/**
 * Forensic event factory. The daemon emits this via its forwarder so
 * Timer Intelligence picks up REFLECTOR activity.
 *
 * @param {{ scope: string, output: { proposals: Array<unknown>, planId: string } | null, durationMs?: number, tokensConsumed?: number, error?: string }} args
 */
export function buildForensicEvent({ scope, output, durationMs, tokensConsumed, error }) {
  return {
    eventType: `step.reflector.${scope}`,
    payload: {
      scope,
      planId: output?.planId,
      proposalCount: output?.proposals?.length ?? 0,
      durationMs,
      tokensConsumed,
      error,
    },
  };
}

// ── R1 (pacman1 audit, 2026-06-12) — the real REFLECTOR brain ──────────────
//
// Until this commit, executeReflectorJob's agent step was a v1 SCAFFOLD
// returning empty proposals: 9 reflector jobs COMPLETED with zero rows in
// futurator-reflections, ever — the inbox→approve→CLAUDE.md/skill loop was
// fully wired and starved. These two helpers are the missing organ: the
// prompt the daemon spawns, and the parser that turns the agent's output
// into ReflectionRow-shaped proposals.

/**
 * Build the REFLECTOR agent prompt. All evidence arrives as pre-gathered
 * text blocks (the daemon reads DDB; the agent reads the repo) — the agent
 * proposes, never applies.
 *
 * NO domain examples are baked in (no game/app specifics): categories are
 * described generically so the same prompt serves every project.
 */
export function buildReflectorAgentPrompt({ scope, projectSlug, planSummary, evidenceBlocks }) {
  const blocks = (evidenceBlocks || [])
    .filter((b) => b && b.title && b.body)
    .map((b) => `## ${b.title}\n${String(b.body).slice(0, 6000)}`)
    .join('\n\n');
  return `You are the REFLECTOR for the "${projectSlug}" project. A ${scope} just completed. Your job: distill what this run TAUGHT US into a small number of durable, reusable proposals so future agent runs do not repeat the same mistakes or rediscover the same techniques.

You are in the project working directory. You may Read/Grep/Glob the repo (e.g. CLAUDE.md to avoid duplicate rules, source files referenced by the evidence) but you must NOT modify anything — you only PROPOSE.

<plan_summary>
${String(planSummary || '').slice(0, 4000)}
</plan_summary>

<evidence>
${blocks || '(no structured evidence was collected for this run)'}
</evidence>

What makes a GOOD proposal (quality bar — fewer, better):
- It generalizes: a rule/technique that will apply to FUTURE stories or plans, not a description of a one-off event.
- It is grounded: cite the specific evidence items (failure ids, stage names, AC ids) that taught it.
- It is non-duplicative: if CLAUDE.md already says it, do not re-propose it.
- Skip it if unsure: an empty list is a valid, honest answer.

Targets you may propose (choose per proposal):
- target "project-claude-md", action "append-line": one concise imperative rule line for this project's CLAUDE.md (conventions, pitfalls to avoid, environment quirks proven by this run).
- target "project-skill", action "propose": a reusable technique worth packaging as a skill for this project's agents (set "skillName" in kebab-case).
- target "org-skill", action "propose": only if the technique is clearly project-agnostic.

Emit AT MOST 5 proposals. End your reply with EXACTLY this block:

---REFLECTIONS---
[
  {
    "target": "project-claude-md",
    "action": "append-line",
    "content": "<the exact line or content to add>",
    "rationale": "<why, in one or two sentences>",
    "evidence": ["<evidence ref 1>", "<evidence ref 2>"],
    "confidence": 0.0
  }
]
---END_REFLECTIONS---

The JSON array may be empty ([]). "confidence" is 0..1. Include "skillName" for skill targets and optionally "section" for claude-md targets.`;
}

const REFLECTION_TARGETS = new Set([
  'project-claude-md',
  'project-skill',
  'agent-persona',
  'org-skill',
  'pipeline-config',
  'tool-wrapper',
]);
const REFLECTION_ACTIONS = new Set([
  'append-section',
  'replace-section',
  'append-line',
  'create',
  'promote-from-project',
  'tune',
  'propose',
]);

/**
 * Parse the agent's output into validated proposal objects (the body of a
 * ReflectionRow — provenance/lifecycle fields are added by the job runner).
 * Tolerant: finds the ---REFLECTIONS--- block, else the first JSON array in
 * the text. Invalid entries are dropped, the list is capped at 5.
 */
export function parseReflectorOutput(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let jsonText = null;
  const fenced = raw.match(/---REFLECTIONS---\s*([\s\S]*?)\s*---END_REFLECTIONS---/);
  if (fenced) {
    jsonText = fenced[1];
  } else {
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) jsonText = arr[0];
  }
  if (!jsonText) return [];
  // Strip a stray markdown code fence the model may have added.
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const p of parsed) {
    if (!p || typeof p !== 'object') continue;
    if (!REFLECTION_TARGETS.has(p.target)) continue;
    if (!REFLECTION_ACTIONS.has(p.action)) continue;
    if (typeof p.content !== 'string' || p.content.trim().length === 0) continue;
    if (typeof p.rationale !== 'string' || p.rationale.trim().length === 0) continue;
    const confidence =
      typeof p.confidence === 'number' && Number.isFinite(p.confidence)
        ? Math.min(1, Math.max(0, p.confidence))
        : 0.5;
    out.push({
      target: p.target,
      action: p.action,
      section: typeof p.section === 'string' ? p.section : undefined,
      skillName: typeof p.skillName === 'string' ? p.skillName : undefined,
      content: p.content.trim().slice(0, 2000),
      rationale: p.rationale.trim().slice(0, 1000),
      evidence: Array.isArray(p.evidence)
        ? p.evidence.filter((e) => typeof e === 'string').slice(0, 10)
        : [],
      confidence,
    });
    if (out.length >= 5) break;
  }
  return out;
}
