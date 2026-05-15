/**
 * skill-promoter.mjs — Pipeline v2 Phase 3 / Story 3-E-5-1 (PR-83).
 *
 * Handles the project-local → org-wide skill promotion flow that fires
 * when an operator confirms a REFLECTOR proposal with:
 *
 *   { target: 'org-skill', action: 'promote-from-project', sourceSkill, sourceProject }
 *
 * Per v2.5 §44 the promotion path is two-tier:
 *
 *   Tier 1 — project skill (`.claude/skills/<n>/`)
 *   Tier 2 — org-wide skill in the `futurator-skills` repo, distributed via federation
 *
 * Promotion mechanics:
 *   1. Copy project-local skill folder → futurator-skills/<n>/
 *   2. Open a PR against futurator-skills with `Agent: REFLECTOR-APPLY` commit
 *   3. On PR merge — remove project-local copy
 *   4. Update the project's manifest to reference the org skill
 *   5. Weekly federation refresh (3-C-5 T8) proposes the org skill to other
 *      Futurator projects whose stack fingerprint matches (3-C-8)
 *
 * This module ships the **deterministic** parts: file copy + manifest
 * shape transformation + demotion eligibility. The PR-open + merge-hook
 * pieces depend on the `futurator-skills` org repo existing — they're
 * Story 3-E-5 follow-ons when the operator provisions the repo.
 */

import { existsSync, mkdirSync, readdirSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

/**
 * Copy a project-local skill folder into a target org-skills directory.
 * Source: `<projectPath>/.claude/skills/<skillName>/`
 * Target: `<orgSkillsRoot>/<skillName>/`
 *
 * Pure file operation — does NOT open the PR / mutate the manifest.
 *
 * @param {{
 *   projectPath: string,
 *   orgSkillsRoot: string,
 *   skillName: string,
 * }} args
 * @returns {{ copied: boolean, source: string, target: string, fileCount?: number, reason?: string }}
 */
export function copyProjectSkillToOrg({ projectPath, orgSkillsRoot, skillName }) {
  if (!skillName || skillName.includes('..') || skillName.includes('/')) {
    return { copied: false, source: '', target: '', reason: 'invalid skill name' };
  }
  const source = join(projectPath, '.claude', 'skills', skillName);
  const target = join(orgSkillsRoot, skillName);
  if (!existsSync(source)) {
    return { copied: false, source, target, reason: 'source skill missing' };
  }
  if (existsSync(target)) {
    return { copied: false, source, target, reason: 'target already exists' };
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return {
    copied: true,
    source,
    target,
    fileCount: countFilesRecursive(target),
  };
}

function countFilesRecursive(dir) {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) count += countFilesRecursive(path);
      else if (entry.isFile()) count++;
    }
  } catch {
    /* swallow — best-effort */
  }
  return count;
}

/**
 * Update the project's skill manifest: move a skill entry from one of
 * the four kind buckets (core/stack/domain/vendor) so its `source`
 * points at the org-wide source instead of `<source-id>` (or remove
 * entirely if the operator's policy is "promoted = no longer pinned in
 * this project's manifest").
 *
 * Returns the new yaml string + the action taken. Pure — does NOT write
 * to disk. Caller writes via memory-store's writeAtomic.
 *
 * @param {{
 *   manifestYaml: string,
 *   skillName: string,
 *   newSource: string,           // typically 'futurator-internal'
 *   newVersion?: string,         // optional new version pin
 *   action?: 'rebase-source' | 'remove',  // default 'rebase-source'
 * }} args
 * @returns {{ yaml: string, action: string, bucket?: string }}
 */
export function rewriteManifestForPromotion({
  manifestYaml,
  skillName,
  newSource,
  newVersion,
  action = 'rebase-source',
}) {
  const parsed = parseYaml(manifestYaml) ?? {};
  const BUCKETS = ['core', 'stack', 'domain', 'vendor'];

  for (const bucket of BUCKETS) {
    const arr = parsed[bucket];
    if (!Array.isArray(arr)) continue;
    const idx = arr.findIndex((entry) => entry?.skill === skillName);
    if (idx < 0) continue;

    if (action === 'remove') {
      arr.splice(idx, 1);
    } else {
      const existing = arr[idx];
      arr[idx] = {
        source: newSource,
        skill: skillName,
        version: newVersion ?? existing.version,
      };
    }
    return { yaml: yamlStringify(parsed), action, bucket };
  }

  // Skill not in any bucket — no-op rewrite, return original.
  return { yaml: manifestYaml, action: 'noop' };
}

/**
 * Compute eligibility for demotion of an org-wide skill back to project-
 * local. v2.5 §44: "if an org skill hasn't been used in any new plan in
 * 90 days, REFLECTOR flags it for review."
 *
 * The runner supplies usage stats from `meta.json` (`evidenceJobIds`
 * timestamps) — this helper applies the policy.
 *
 * @param {{
 *   lastUsedAt: string | null,
 *   now?: () => number,
 *   thresholdDays?: number,
 * }} args
 * @returns {{ demote: boolean, reason: string, ageDays?: number }}
 */
export function checkDemotionEligibility({ lastUsedAt, now = () => Date.now(), thresholdDays = 90 }) {
  if (!lastUsedAt) {
    return { demote: true, reason: 'never used since installation' };
  }
  const last = Date.parse(lastUsedAt);
  if (Number.isNaN(last)) {
    return { demote: false, reason: 'unparseable lastUsedAt' };
  }
  const ageMs = now() - last;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageDays >= thresholdDays) {
    return { demote: true, reason: `unused for ${ageDays} days (threshold ${thresholdDays})`, ageDays };
  }
  return { demote: false, reason: `last used ${ageDays} days ago (under threshold)`, ageDays };
}

/**
 * Build the REFLECTOR-APPLY commit message for the futurator-skills PR.
 * The actual `gh pr create` call lives in the (deferred) PR-open helper;
 * this builder is testable today.
 *
 * @param {{ skillName: string, sourceProject: string, reflectionId: string }} args
 * @returns {string[]} array of -m flag bodies for `git commit`
 */
export function buildPromotionCommitFlags({ skillName, sourceProject, reflectionId }) {
  return [
    `Promote ${skillName} from project-local to org-wide`,
    `Source-Project: ${sourceProject}`,
    `Agent: REFLECTOR-APPLY`,
    `Reflection-Id: ${reflectionId}`,
  ];
}

/**
 * Compute a stack-fingerprint hash from a project manifest. Used by
 * 3-C-8 cross-project propagation: the weekly refresh proposes a
 * newly-promoted org skill to projects whose stack fingerprint Jaccard-
 * matches the source project by ≥ 70%.
 *
 * Fingerprint = sorted set of {boilerplateKind, primaryFramework, awsServices}
 * encoded as JSON; SHA-256 for compactness.
 */
export function computeStackFingerprint({
  boilerplateKind,
  primaryFramework,
  awsServices = [],
}) {
  const body = JSON.stringify({
    boilerplate: boilerplateKind ?? null,
    framework: primaryFramework ?? null,
    aws: [...awsServices].map(String).sort(),
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Cleanup project-local copy after the org PR merges. v2.5 §44 — the
 * project's manifest now references the org-wide source; the local
 * copy is redundant.
 *
 * Idempotent (no-op when already removed).
 *
 * @param {{ projectPath: string, skillName: string }} args
 * @returns {{ removed: boolean, path: string }}
 */
export function cleanupProjectLocalCopy({ projectPath, skillName }) {
  if (!skillName || skillName.includes('..') || skillName.includes('/')) {
    return { removed: false, path: '' };
  }
  const path = join(projectPath, '.claude', 'skills', skillName);
  if (!existsSync(path)) return { removed: false, path };
  try {
    rmSync(path, { recursive: true, force: true });
    return { removed: true, path };
  } catch {
    return { removed: false, path };
  }
}
