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
