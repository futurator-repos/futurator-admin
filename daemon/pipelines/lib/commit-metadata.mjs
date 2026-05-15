/**
 * commit-metadata.mjs — Pipeline v2 Phase 3 / Story 3-C-4-1 (PR-73).
 *
 * Builds the additional commit-message lines the compile-pipeline appends
 * to per-story commits under mvp+ rigor:
 *
 *   Skills-Used: <skill>@<source>, <skill>@<source>     (PR-73, this PR)
 *   Skills-Manifest-Sha: <40-char-sha>                  (PR-73, this PR)
 *
 * Both lines are queryable via `git log --grep`:
 *
 *   git log --grep="Skills-Used:.*music-theory-engine"
 *   git log --grep="Skills-Manifest-Sha:.*a3f9c2e"
 *
 * The Phase 2-B.1 full commit-metadata template (Plan / Wave / Story /
 * Agent / Plan-Id) absorbs these lines when it ships — until then this
 * helper is a stand-alone, mvp+-gated, append-only extension of the
 * existing `'story: <id> — <title>'` subject.
 *
 * Rigor matrix (v2.5 §42):
 *   prototype  → both lines omitted
 *   mvp        → both lines emitted (Skills-Used may be empty string when
 *                no skills loaded; Manifest-Sha always emitted if manifest
 *                file exists)
 *   production → both lines emitted (manifest sha required for hotfix
 *                reproduction)
 */

import { existsSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';

const MVP_PLUS_RIGORS = new Set(['mvp', 'production']);

/**
 * Format the `Skills-Used:` line per v2.5 §40 — comma+space separator,
 * alphabetical by `<skill>@<source>` for deterministic diff-friendly
 * commit messages.
 *
 * @param {Array<{ source: string, skill: string }>} loadedSkills
 * @returns {string} the rendered line (without trailing newline)
 */
export function buildSkillsUsedLine(loadedSkills) {
  if (!Array.isArray(loadedSkills) || loadedSkills.length === 0) {
    return 'Skills-Used:';
  }
  const dedupedSorted = Array.from(
    new Set(loadedSkills.map((s) => `${s.skill}@${s.source}`)),
  ).sort((a, b) => a.localeCompare(b));
  return `Skills-Used: ${dedupedSorted.join(', ')}`;
}

/**
 * Compute the SHA-256 of the project's skill manifest file. Returns the
 * `Skills-Manifest-Sha:` line, or `null` if the manifest file doesn't
 * exist (which happens for stub boilerplates + brownfield projects pre-
 * audit).
 *
 * @param {string} workingDir absolute path to the project's working tree
 * @param {string} [manifestPath] relative path; defaults to
 *                                `.claude/skills.manifest.yaml`
 * @returns {string | null}
 */
export function buildSkillsManifestShaLine(
  workingDir,
  manifestPath = '.claude/skills.manifest.yaml',
) {
  const abs = join(workingDir, manifestPath);
  if (!existsSync(abs)) return null;
  let raw;
  try {
    raw = readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
  const sha = createHash('sha256').update(raw).digest('hex');
  return `Skills-Manifest-Sha: ${sha}`;
}

/**
 * Produce the array of metadata flags to append to `git commit`. Each
 * entry is the BODY of a `-m` flag (no quoting; callers wrap with their
 * own shell-quoting). Empty array under prototype rigor + when no
 * manifest exists.
 *
 * Pattern: chain multiple `-m` flags. Git auto-joins them with blank
 * lines, producing a commit message like:
 *
 *   story: ABC-123 — wire chord overlay
 *
 *   Skills-Used: music-theory-engine@futurator-internal, ...
 *
 *   Skills-Manifest-Sha: a3f9c2e...
 *
 * @param {{
 *   rigor: 'prototype' | 'mvp' | 'production',
 *   workingDir: string,
 *   loadedSkills?: Array<{ source: string, skill: string }>,
 *   manifestPath?: string,
 * }} args
 * @returns {string[]} array of -m flag bodies (empty when rigor === 'prototype')
 */
export function buildSkillsCommitFlags({
  rigor,
  workingDir,
  loadedSkills = [],
  manifestPath = '.claude/skills.manifest.yaml',
}) {
  if (!MVP_PLUS_RIGORS.has(rigor)) return [];
  const flags = [];
  flags.push(buildSkillsUsedLine(loadedSkills));
  const shaLine = buildSkillsManifestShaLine(workingDir, manifestPath);
  if (shaLine) flags.push(shaLine);
  return flags;
}

/**
 * Shell-quote each flag body for inline `git commit -m '<body>' -m '<body>'`
 * use. Single-quoted with embedded-single-quote escape `'\''`.
 */
export function quoteFlagsForShell(flagBodies) {
  return flagBodies.map((body) => `'${String(body).replace(/'/g, "'\\''")}'`);
}

/**
 * Parse the `Skills-Used:` value out of a commit message body. Returns
 * the array of `<skill>@<source>` tokens, or empty when the line is
 * absent / empty. Used by the future cohort-tracker + REFLECTOR's
 * skill-usage query helpers.
 */
export function parseSkillsUsedLine(commitMessage) {
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
 * Returns the SHA-256 hex string, or null when absent.
 */
export function parseSkillsManifestShaLine(commitMessage) {
  const m = String(commitMessage).match(/^Skills-Manifest-Sha:\s*([a-f0-9]{64})\s*$/m);
  return m ? m[1] : null;
}

// ── PR-85 (Story 2-B-1-1) — v2.5 §23 full commit-metadata template ────────
//
// Every pipeline-emitted commit carries a structured metadata block after
// the subject line. The block is grep-able for reconstruction queries
// (v2.5 §23.1):
//
//   git log --grep="Plan-Id: <id>"           — all work on a plan
//   git log --grep="Agent: WAVE-MERGE"       — every wave-merge commit
//   git log --grep="Agent: REFLECTOR-APPLY"  — knowledge-ratchet history
//   git log --grep="Story: <id>"             — all commits for a story
//   git log --grep="Stream: <name>"          — all stream-branch commits
//
// The skills metadata (PR-73) is appended after the v2.5 §23 fields;
// both flavors coexist cleanly because git's multi-`-m` form joins
// bodies with blank lines.

const KNOWN_AGENTS = Object.freeze([
  'PM',
  'API-AUTHOR',
  'TEST',
  'DEV',
  'REVIEWER',
  'COMPILER',
  'QA',
  'PO',
  'ARCHITECT',
  'SKILL-SCOUT',
  'REFLECTOR',
  'TRIAGE',
  'EVALUATOR',
  'WAVE-MERGE',
  'REFLECTOR-APPLY',
  'SKILL-SCOUT-APPLY',
  'ARCHITECT-APPLY',
  'DAEMON',
  'OPERATOR',
]);

/**
 * Build the v2.5 §23 metadata flags. Each entry is a `-m` flag body
 * (no shell quoting; callers wrap with `quoteFlagsForShell`).
 *
 * Required: `agent`. Everything else is conditional on presence.
 *
 * @param {{
 *   agent: string,
 *   planId?: string,
 *   plan?: string,
 *   wave?: string | number,
 *   story?: string,
 *   stream?: string,
 *   epicId?: string,
 *   reflectionId?: string,
 * }} args
 * @returns {string[]} array of -m flag bodies
 */
export function buildCommitMetadataFlags(args) {
  if (!args || !args.agent) {
    throw new Error('commit-metadata: agent is required');
  }
  if (!KNOWN_AGENTS.includes(args.agent)) {
    // Don't throw — log indication that the agent is unknown. Permissive
    // because daemon-spawned shell scripts may use ad-hoc agent labels.
    // The forensic JSON has the real role; this is just commit-grep bait.
  }
  const flags = [];
  flags.push(`Agent: ${args.agent}`);
  if (args.planId) flags.push(`Plan-Id: ${args.planId}`);
  if (args.plan) flags.push(`Plan: ${args.plan}`);
  if (args.epicId) flags.push(`Epic-Id: ${args.epicId}`);
  if (args.wave !== undefined && args.wave !== null && args.wave !== '') {
    flags.push(`Wave: ${args.wave}`);
  }
  if (args.story) flags.push(`Story: ${args.story}`);
  if (args.stream) flags.push(`Stream: ${args.stream}`);
  if (args.reflectionId) flags.push(`Reflection-Id: ${args.reflectionId}`);
  return flags;
}

/**
 * Compose the full commit-metadata flag set: v2.5 §23 fields + PR-73
 * skills lines. This is the single helper most callers want.
 *
 * @param {{
 *   subject: string,
 *   agent: string,
 *   rigor: 'prototype' | 'mvp' | 'production',
 *   workingDir: string,
 *   planId?: string,
 *   plan?: string,
 *   wave?: string | number,
 *   story?: string,
 *   stream?: string,
 *   epicId?: string,
 *   reflectionId?: string,
 *   loadedSkills?: Array<{ source: string, skill: string }>,
 *   manifestPath?: string,
 * }} args
 * @returns {{ subject: string, flagBodies: string[] }}
 */
export function composeFullCommitMessage(args) {
  const metadataFlags = buildCommitMetadataFlags(args);
  const skillFlags = buildSkillsCommitFlags({
    rigor: args.rigor,
    workingDir: args.workingDir,
    loadedSkills: args.loadedSkills ?? [],
    manifestPath: args.manifestPath,
  });
  return {
    subject: args.subject,
    flagBodies: [...metadataFlags, ...skillFlags],
  };
}

/**
 * Parse a structured metadata field out of a commit message. Returns
 * the value string or null. Supports any v2.5 §23 field name.
 */
export function parseMetadataField(commitMessage, fieldName) {
  const re = new RegExp(`^${fieldName}:\\s*(.+?)\\s*$`, 'm');
  const m = String(commitMessage).match(re);
  return m ? m[1] : null;
}

export const KNOWN_AGENT_LABELS = KNOWN_AGENTS;
