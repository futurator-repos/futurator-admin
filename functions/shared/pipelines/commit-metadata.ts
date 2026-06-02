/**
 * commit-metadata.ts — Pipeline v2 Phase 3 / Story 3-C-4-1 (PR-73) +
 * Story 2-B-1-1 (PR-85) wired into the LAMBDA-built shell.
 *
 * The daemon used to expose JS helpers
 * (daemon/pipelines/lib/commit-metadata.mjs) that read the manifest
 * synchronously from disk and returned pre-computed trailer strings. That
 * design assumed the pipeline steps were constructed at runtime on EC2.
 * In production today the Lambda builds the per-story pipeline JSON ahead
 * of time and persists it to DynamoDB — the daemon just polls and runs.
 * The Lambda has no access to the worktree's `.claude/skills.manifest.yaml`
 * (it lives on EC2), so trailers must be COMPUTED IN SHELL at execution
 * time.
 *
 * What this module emits:
 *
 *   git -c user.email=... -c user.name='Daemon' commit -m "$COMMIT_MSG"
 *
 * where $COMMIT_MSG is a single string with embedded newlines: the
 * subject, then (under mvp+) `Skills-Used:` and (when the manifest file
 * exists) `Skills-Manifest-Sha:`. Git treats `\n\n` inside `-m` as the
 * boundary between subject and body, and the body trailers stay grep-able:
 *
 *   git log --grep="Skills-Used:.*music-theory-engine"
 *   git log --grep="Skills-Manifest-Sha:.*a3f9c2e"
 *
 * Rigor matrix (v2.5 §42):
 *   prototype  → both lines omitted
 *   mvp        → both lines emitted (Skills-Used may be empty when no
 *                skills were loaded; Manifest-Sha emitted if manifest
 *                file exists)
 *   production → both lines emitted (manifest sha required)
 *
 * The Skills-Used contents come from `.context/loaded-skills.json` in the
 * working tree — a JSON array of `{source, skill}` objects the daemon
 * writes as agents load skills. When the file is missing/empty the
 * line emits as `Skills-Used:` (label only) — presence-for-grep still
 * holds, content fills in once the daemon's loaded-skills tracking lands.
 */

import type { PlanRigor } from '../types/plan';
import { buildPipelineStructuredTrailers } from '../lib/agent-commit-composer';

/**
 * Build the bash snippet that produces the per-story git commit message
 * and runs `git commit`. Inserts trailers under mvp+ rigor.
 *
 * The returned snippet expects to be concatenated INSIDE an existing
 * `cd <workingDir> && ...` chain — it does not change directories.
 *
 * 2026-05-19 — extended with the v2.5 §23 structured trailers (Plan-Id,
 * Plan, Agent, Story, Wave, Epic-Id). Pre-fix the Lambda-built shell only
 * emitted Skills-* lines, so the snake-4 forensic showed no Plan-Id on
 * any commit and the gitgraph couldn't tell which plan made what. With
 * trailers in place, future plan-delete cascades can grep main for
 * `Plan-Id: <deleted>` and report residual commits to the operator.
 *
 * @returns a single-line bash snippet (no leading/trailing whitespace,
 *          no `&&` prefix/suffix — caller decides chaining)
 */
export function buildCommitShellSnippet(args: {
  storyId: string;
  storyTitle: string;
  rigor: PlanRigor;
  /** Stable DDB-row identifier for the Plan. Used for forensic queries. */
  planId?: string;
  /** Kebab-case Plan slug (also the per-plan branch name). */
  planSlug?: string;
  epicId?: string;
  /** Story-wave index within the epic. */
  wave?: number;
  /**
   * 2026-06-02 — when the story legitimately produces no source (a
   * verification-only story whose ACs are all browser-checks), commit with
   * `--allow-empty` so the story is recorded as done instead of the commit
   * failing on "nothing to commit". The caller (story-pipeline) sets this
   * only for verification-only stories; normal code stories still hard-fail
   * on an empty commit (the sibling-sweep / dead-DEV guard).
   */
  allowEmpty?: boolean;
}): string {
  const escapedTitle = args.storyTitle.replace(/'/g, "'\\''");
  const subject = `story: ${args.storyId} — ${escapedTitle}`;

  const COMMIT = args.allowEmpty ? 'commit --allow-empty' : 'commit';
  const GIT_PREFIX = `git -c user.email=daemon@futurator.local -c user.name='Daemon'`;

  // Story 20.13 — v2.5 §23 structured trailers are now sourced from the
  // shared `agent-commit-composer`. Same trailer ORDER (Agent, Plan-Id,
  // Plan, Epic-Id, Wave, Story) the composer's `kind: 'pipeline'` branch
  // produces, so pipeline-v2 commits stay byte-identical with party-push
  // commits when grepped by v2.5 §23 keys. Skills-Used + Skills-Manifest-Sha
  // remain shell-time computations (see below) — they can't be known at
  // Lambda-snippet-build time.
  const structuredBlock = buildPipelineStructuredTrailers({
    storyId: args.storyId,
    agent: 'DEV',
    planId: args.planId,
    plan: args.planSlug,
    epicId: args.epicId,
    wave: typeof args.wave === 'number' ? args.wave : undefined,
  });

  if (args.rigor === 'prototype') {
    // Single-line subject + structured trailers via one -m. Each trailer
    // on its own line (separated by blank line from subject per v2.5 §23).
    const body = [subject, '', structuredBlock].join('\n');
    const escaped = body.replace(/'/g, "'\\''");
    return `${GIT_PREFIX} ${COMMIT} -m '${escaped}'`;
  }

  // mvp+: compute trailers in shell and concatenate into a single -m
  // payload with embedded blank lines. Newlines inside double-quoted
  // bash strings survive into `git commit -m`, so we don't need the
  // multi-`-m` form.
  //
  // We wrap the whole thing in a subshell `( ... )` and separate
  // statements with `;` so the if/then/fi control flow parses correctly
  // (joining with `&&` between `then` and the body is invalid bash).
  // The subshell's exit code is its last command's — `git commit` —
  // so an outer `&&`-chain failure still propagates cleanly.
  //
  // The Skills-Used reader is intentionally defensive — if node is
  // unavailable, the JSON malformed, or any step throws, SKILLS_CSV ends
  // up empty and we still emit the label-only line (presence for grep).
  const nodeReader =
    `node -e ` +
    `"try { const a = require('./.context/loaded-skills.json'); ` +
    `const items = Array.isArray(a) ? a : []; ` +
    `const set = new Set(items.filter(s => s && s.skill && s.source).map(s => s.skill + '@' + s.source)); ` +
    `console.log([...set].sort((x,y) => x.localeCompare(y)).join(', ')); ` +
    `} catch (e) { process.exit(0); }" 2>/dev/null || true`;

  // Structured trailers block (v2.5 §23) — sourced from
  // `buildPipelineStructuredTrailers` above (Story 20.13 delegates trailer
  // assembly to the shared composer). Always present under mvp+.
  const statements = [
    `SKILLS_CSV=""`,
    `if [ -f .context/loaded-skills.json ] && [ -s .context/loaded-skills.json ]; then SKILLS_CSV=$(${nodeReader}); fi`,
    `MANIFEST_SHA=""`,
    `if [ -f .claude/skills.manifest.yaml ]; then MANIFEST_SHA=$(sha256sum .claude/skills.manifest.yaml 2>/dev/null | awk '{print $1}'); fi`,
    `COMMIT_MSG='${subject}'`,
    // v2.5 §23 trailers come BEFORE Skills lines so a `git log --grep`
    // for Plan-Id / Story / Wave is cheaper than a full message scan.
    `COMMIT_MSG=$(printf '%s\\n\\n%s' "$COMMIT_MSG" '${structuredBlock.replace(/'/g, "'\\''")}')`,
    `if [ -n "$SKILLS_CSV" ]; then COMMIT_MSG=$(printf '%s\\n\\nSkills-Used: %s' "$COMMIT_MSG" "$SKILLS_CSV"); else COMMIT_MSG=$(printf '%s\\n\\nSkills-Used:' "$COMMIT_MSG"); fi`,
    `if [ -n "$MANIFEST_SHA" ]; then COMMIT_MSG=$(printf '%s\\n\\nSkills-Manifest-Sha: %s' "$COMMIT_MSG" "$MANIFEST_SHA"); fi`,
    // S5 (2026-06-02) — when the per-story runtime VQA caught a visual defect
    // and the DEV fixed it across the retry loop, review-runtime persists the
    // failing observations to `.context/vqa-observations.txt`. Emit them as a
    // grep-able `VQA-Fixed:` trailer so the plan-delivery REFLECTOR (which
    // mines the commit log) turns the failure→fix into a durable skill/CLAUDE.md
    // lesson. Absent on stories that passed visual review first try.
    `VQA_FIX=""`,
    `if [ -f .context/vqa-observations.txt ] && [ -s .context/vqa-observations.txt ]; then VQA_FIX=$(tr '\\n' ';' < .context/vqa-observations.txt | cut -c1-400); fi`,
    `if [ -n "$VQA_FIX" ]; then COMMIT_MSG=$(printf '%s\\n\\nVQA-Fixed: %s' "$COMMIT_MSG" "$VQA_FIX"); fi`,
    `${GIT_PREFIX} ${COMMIT} -m "$COMMIT_MSG"`,
  ];
  return `( ${statements.join('; ')} )`;
}

/**
 * Parse the `Skills-Used:` value out of a commit message body. Returns
 * the array of `<skill>@<source>` tokens, or empty when the line is
 * absent / empty. Mirrors the daemon's parser so analytics consumers can
 * agree on the format.
 */
export function parseSkillsUsedLine(commitMessage: string): string[] {
  const m = String(commitMessage).match(/^Skills-Used:\s*(.*?)\s*$/m);
  if (!m) return [];
  const body = m[1];
  if (!body) return [];
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the `Skills-Manifest-Sha:` value out of a commit message body.
 * Returns the SHA-256 hex string (lowercase 64 chars), or null when
 * absent or malformed.
 */
export function parseSkillsManifestShaLine(commitMessage: string): string | null {
  const m = String(commitMessage).match(/^Skills-Manifest-Sha:\s*([a-f0-9]{64})\s*$/m);
  return m ? m[1] : null;
}
