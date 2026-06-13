/**
 * reconcile-skills-manifest.mjs — Skills Management Phase 0, Story 0.3
 * (2026-06-13).
 *
 * Closes the on-disk ↔ manifest gap. After `bmad-bootstrap` materializes the
 * BMAD skill set into `.claude/skills/`, the project has ~59 skills on disk but
 * `skills.manifest.yaml` only pins the 3 prepin-default skills (the 56 bmad
 * skills arrive via `npx bmad-method install`, outside the federation/manifest
 * path). The agent's `skills_available` count, SKILL-SCOUT collision checks,
 * and the `Skills-Used:` commit-trailer source attribution all read the
 * manifest — so a manifest missing 95% of the real skills is a latent
 * correctness gap (see docs/concepts/skills-management/skills-management-plan.md
 * §1.2).
 *
 * This step reads every materialized skill dir (`.claude/skills/<name>/SKILL.md`)
 * and pins any not-already-pinned skill into the manifest's `core[]` bucket,
 * sourced to the canonical federation source (`futurator-skills`). It runs
 * AFTER `bmad-bootstrap` (so all skills are on disk) and BEFORE
 * `commit-and-push` (so the reconciled manifest is committed with the app).
 *
 * Idempotent: a second run with nothing new on disk is a no-op. Existing
 * entries (e.g. the 3 prepin-pinned anthropic skills) are preserved verbatim —
 * we only ADD, never rewrite or reorder.
 *
 * Re-vendor safety: reconciled entries point at `futurator-skills`, which is an
 * index-only registry (no skill bodies). vendor-skills would 404 on them — so
 * vendor-skills skips any skill already present on disk (its on-disk guard,
 * added alongside this step). Within bootstrap this step runs after
 * vendor-skills, so no re-vendor happens in-chain regardless.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

const MANIFEST_REL_PATH = '.claude/skills.manifest.yaml';
const SKILLS_DIR_REL = '.claude/skills';
const DEFAULT_SOURCE = 'futurator-skills';
const BUCKETS = ['core', 'stack', 'domain', 'vendor'];

/**
 * List skill directory names under `.claude/skills/` that actually carry a
 * SKILL.md (mirrors what Claude Code's `system/init` counts as "available").
 *
 * @param {string} worktreeDir
 * @returns {string[]} sorted skill names
 */
export function listOnDiskSkills(worktreeDir) {
  const skillsDir = join(worktreeDir, SKILLS_DIR_REL);
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  const names = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(skillsDir, entry.name, 'SKILL.md'))) names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Collect the set of skill names already pinned across all manifest buckets.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {Set<string>}
 */
export function pinnedSkillNames(manifest) {
  const names = new Set();
  for (const bucket of BUCKETS) {
    const arr = manifest[bucket];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (entry && typeof entry.skill === 'string') names.add(entry.skill);
    }
  }
  return names;
}

/**
 * Run the reconcile step.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir         — absolute path to the project worktree
 * @param {string}   [args.source]            — federation source id to attribute added skills to
 * @param {function} [args.onOutput]          — `(text) => void` log sink
 * @returns {Promise<{
 *   skipped: boolean,
 *   reason?: string,
 *   reconciledCount: number,
 *   added: string[],
 *   onDiskCount: number,
 *   manifestCount: number,
 * }>}
 */
export async function runReconcileSkillsManifest({ worktreeDir, source = DEFAULT_SOURCE, onOutput }) {
  if (!worktreeDir) throw new Error('runReconcileSkillsManifest: worktreeDir required');
  const log = (msg) => {
    if (typeof onOutput === 'function') onOutput(msg + '\n');
  };

  const manifestPath = join(worktreeDir, MANIFEST_REL_PATH);
  if (!existsSync(manifestPath)) {
    log(`reconcile-skills-manifest: no manifest at ${MANIFEST_REL_PATH} — skipping.`);
    return { skipped: true, reason: 'manifest-missing', reconciledCount: 0, added: [], onDiskCount: 0, manifestCount: 0 };
  }

  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    throw new Error(`reconcile: manifest parse failed at ${MANIFEST_REL_PATH}: ${e.message}`);
  }
  if (manifest === null || typeof manifest !== 'object') {
    throw new Error(`reconcile: manifest is not an object at ${MANIFEST_REL_PATH}`);
  }

  const onDisk = listOnDiskSkills(worktreeDir);
  if (onDisk.length === 0) {
    log('reconcile-skills-manifest: no on-disk skills found — skipping.');
    return { skipped: true, reason: 'no-on-disk-skills', reconciledCount: 0, added: [], onDiskCount: 0, manifestCount: 0 };
  }

  const pinned = pinnedSkillNames(manifest);
  const toAdd = onDisk.filter((name) => !pinned.has(name));

  const manifestCountBefore = pinned.size;
  if (toAdd.length === 0) {
    log(`reconcile-skills-manifest: all ${onDisk.length} on-disk skill(s) already pinned — no-op.`);
    return {
      skipped: true,
      reason: 'already-reconciled',
      reconciledCount: 0,
      added: [],
      onDiskCount: onDisk.length,
      manifestCount: manifestCountBefore,
    };
  }

  // Append to core[] — every materialized skill is a capability the project
  // always carries. We attribute to the canonical source; version `sha:HEAD`
  // matches the prepin-default-skills placeholder convention. We never touch
  // existing entries (idempotency + respect SKILL-SCOUT decisions).
  if (!Array.isArray(manifest.core)) manifest.core = [];
  for (const skill of toAdd) {
    manifest.core.push({ source, skill, version: 'sha:HEAD' });
  }

  // Stamp provenance: append our marker so forensic readers can see the
  // manifest was reconciled (without clobbering the prepin/scout origin).
  const prev = typeof manifest['generated-by'] === 'string' ? manifest['generated-by'] : '';
  const marker = 'reconcile-skills-manifest@v1';
  manifest['generated-by'] = prev && !prev.includes(marker) ? `${prev}+${marker}` : prev || marker;

  try {
    writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');
  } catch (e) {
    throw new Error(`reconcile: manifest write failed at ${MANIFEST_REL_PATH}: ${e.message}`);
  }

  log(`reconcile-skills-manifest: pinned ${toAdd.length} previously-unmanaged skill(s) to core[].`);
  return {
    skipped: false,
    reconciledCount: toAdd.length,
    added: toAdd,
    onDiskCount: onDisk.length,
    manifestCount: manifestCountBefore + toAdd.length,
  };
}
