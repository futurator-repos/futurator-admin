/**
 * assert-skills-committed.mjs — Story F.4 (2026-05-30).
 *
 * Post-commit self-check: every skill pinned in `.claude/skills.manifest.yaml`
 * MUST have a git-tracked `SKILL.md`. This is the assertion that would have
 * caught the dino1 defect at the source — a green `vendor-skills` step
 * (SKILL.md written to disk) coexisted with a broken `.gitignore` that kept
 * those files OUT of git, so worktrees got zero skills and the failure was
 * invisible until a multi-hour runtime trace.
 *
 * Runs AFTER commit-and-push has committed the scaffold (so `git ls-files`
 * reflects what's actually tracked). On any pinned skill whose SKILL.md is not
 * tracked, it THROWS — the bootstrap saga then surfaces a recognizable
 * attention item instead of silently shipping a skill-less project.
 *
 * Idempotent + pure-ish: reads the manifest + queries git via the injected
 * `execGit`; no writes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const MANIFEST_REL_PATH = '.claude/skills.manifest.yaml';

/**
 * Collect every pinned skill name across the manifest's buckets
 * (core/stack/domain/vendor). Each entry is `{ source, skill, version }`.
 *
 * @param {any} manifest
 * @returns {string[]} unique skill names
 */
export function pinnedSkillNames(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const buckets = ['core', 'stack', 'domain', 'vendor'];
  const names = new Set();
  for (const b of buckets) {
    if (Array.isArray(manifest[b])) {
      for (const entry of manifest[b]) {
        if (entry && typeof entry.skill === 'string' && entry.skill.length > 0) {
          names.add(entry.skill);
        }
      }
    }
  }
  return [...names];
}

/**
 * Assert that every manifest-pinned skill has a git-tracked SKILL.md.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir
 * @param {function} args.execGit   — `(args[], { cwd }) => Promise<{stdout,stderr}>`
 * @param {function} [args.onOutput]
 * @returns {Promise<{ checked: number, tracked: number, skipped?: boolean, reason?: string }>}
 * @throws if any pinned skill's SKILL.md is not git-tracked.
 */
export async function assertSkillsCommitted({ worktreeDir, execGit, onOutput }) {
  if (!worktreeDir) throw new Error('assertSkillsCommitted: worktreeDir required');
  if (typeof execGit !== 'function') throw new Error('assertSkillsCommitted: execGit required');
  const log = (msg) => onOutput?.(msg + '\n');

  const manifestPath = join(worktreeDir, MANIFEST_REL_PATH);
  if (!existsSync(manifestPath)) {
    // Stub boilerplates (sst/vite/mobile) have no manifest — nothing to assert.
    log('assert-skills-committed: no manifest — skipping (stub boilerplate).');
    return { checked: 0, tracked: 0, skipped: true, reason: 'manifest-missing' };
  }

  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    throw new Error(`assert-skills-committed: manifest parse failed: ${e.message}`);
  }

  const names = pinnedSkillNames(manifest);
  if (names.length === 0) {
    log('assert-skills-committed: no pinned skills — skipping.');
    return { checked: 0, tracked: 0, skipped: true, reason: 'no-pinned-skills' };
  }

  const missing = [];
  let tracked = 0;
  for (const skill of names) {
    const rel = `.claude/skills/${skill}/SKILL.md`;
    // `git ls-files <path>` prints the path iff it is tracked; empty otherwise.
    const res = await execGit(['ls-files', rel], { cwd: worktreeDir });
    if ((res?.stdout ?? '').trim() === rel) {
      tracked += 1;
    } else {
      missing.push(rel);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `assert-skills-committed: ${missing.length} pinned skill(s) NOT git-tracked ` +
        `(the .claude/skills/.gitignore defect — Story F): ${missing.join(', ')}. ` +
        `Skills written to disk but never committed → worktrees get zero skills.`,
    );
  }

  log(`assert-skills-committed: all ${tracked} pinned skill SKILL.md file(s) are git-tracked.`);
  return { checked: names.length, tracked };
}
