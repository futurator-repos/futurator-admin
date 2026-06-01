/**
 * Tests for assert-skills-committed.mjs (Story F.4).
 *
 * The post-commit self-check that would have caught dino1's skills-never-
 * committed defect. Uses a real git repo so the `git ls-files` tracked-vs-
 * untracked distinction is exercised for real — the exact thing the original
 * /tmp probe never tested.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertSkillsCommitted,
  pinnedSkillNames,
} from '../assert-skills-committed.mjs';

const tmps = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const execGit = (args, { cwd }) =>
  Promise.resolve({ stdout: execFileSync('git', args, { cwd, encoding: 'utf8' }), stderr: '' });

/**
 * Build a repo with a skills manifest pinning `skillNames`, vendored SKILL.md
 * files, and the given `.claude/skills/.gitignore` content. Commits, returns dir.
 */
function buildRepo({ skillNames, gitignore }) {
  const dir = mkdtempSync(join(tmpdir(), 'assert-skills-'));
  tmps.push(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');

  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  const manifest =
    'core:\n' + skillNames.map((s) => `  - { source: anthropic-official, skill: ${s}, version: sha:HEAD }`).join('\n') + '\n';
  writeFileSync(join(dir, '.claude', 'skills.manifest.yaml'), manifest);
  writeFileSync(join(dir, '.claude', 'skills', '.gitignore'), gitignore);
  for (const s of skillNames) {
    mkdirSync(join(dir, '.claude', 'skills', s), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', s, 'SKILL.md'), `# ${s}\n`);
    writeFileSync(join(dir, '.claude', 'skills', s, 'meta.json'), '{"v":1}\n');
  }
  g('add', '-A');
  g('commit', '-qm', 'scaffold');
  return dir;
}

const FIXED_GI = ['*', '!*/', '!.gitignore', '!*/SKILL.md', '!*/meta.json', ''].join('\n');
const BROKEN_GI = ['*', '!.gitignore', '!*/SKILL.md', '!*/meta.json', ''].join('\n');

describe('pinnedSkillNames', () => {
  it('collects skill names across all buckets, deduped', () => {
    const m = {
      core: [{ skill: 'a' }, { skill: 'b' }],
      stack: [{ skill: 'b' }],
      domain: [{ skill: 'c' }],
      vendor: [],
    };
    expect(pinnedSkillNames(m).sort()).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for empty/garbage manifest', () => {
    expect(pinnedSkillNames(null)).toEqual([]);
    expect(pinnedSkillNames({})).toEqual([]);
  });
});

describe('assertSkillsCommitted', () => {
  it('passes when the FIXED gitignore committed every pinned SKILL.md', async () => {
    const dir = buildRepo({ skillNames: ['canvas-design', 'frontend-design'], gitignore: FIXED_GI });
    const res = await assertSkillsCommitted({ worktreeDir: dir, execGit });
    expect(res).toEqual({ checked: 2, tracked: 2, missing: [] });
  });

  it('WARNS (non-blocking, no throw) when SKILL.md is untracked — returns missing[]', async () => {
    // 2026-06-01 — softened from a throw: a missing skill must never brick the
    // bootstrap (it did — dino2 retry loop). Returns the missing list instead.
    const dir = buildRepo({ skillNames: ['canvas-design'], gitignore: BROKEN_GI });
    const res = await assertSkillsCommitted({ worktreeDir: dir, execGit });
    expect(res.missing).toEqual(['.claude/skills/canvas-design/SKILL.md']);
    expect(res.tracked).toBe(0);
  });

  it('skips cleanly when there is no manifest (stub boilerplate)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assert-skills-none-'));
    tmps.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const res = await assertSkillsCommitted({ worktreeDir: dir, execGit });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('manifest-missing');
  });
});
