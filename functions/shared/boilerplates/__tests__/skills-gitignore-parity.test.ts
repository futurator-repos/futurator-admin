/**
 * Skills .gitignore parity test (Story F — 2026-05-30).
 *
 * THE REGRESSION THIS GUARDS: the shipped `.claude/skills/.gitignore` augment
 * must commit each skill's SKILL.md + meta.json while keeping the heavy bodies
 * (examples/, templates/, etc.) out of git. The original pattern led with a
 * bare star, which ignores the skill SUBDIRECTORIES — and git never descends
 * into an ignored directory, so the deeper un-ignore rule for SKILL.md was
 * dead and SKILL.md was NEVER committed. Per-story worktrees (created from
 * committed content only) then had zero skills, so zero activation fired
 * (dino1 forensic: skills:null).
 *
 * The 2026-05-19 probe missed this because it hand-placed a SKILL.md in /tmp
 * and never exercised the real vendored→committed→worktree path. THIS test
 * exercises exactly that path with real git: write the SHIPPED augment content,
 * vendor fixture skill files, `git add -A`, and assert what actually stages.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BOILERPLATE_REGISTRY } from '../registry';

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The exact `.claude/skills/.gitignore` content the scaffold ships. */
function shippedSkillsGitignore(): string {
  const aug = BOILERPLATE_REGISTRY['nextjs-base'].augmentFiles?.find(
    (f) => f.path === '.claude/skills/.gitignore',
  );
  if (!aug) throw new Error('nextjs-base is missing the .claude/skills/.gitignore augment');
  return aug.content;
}

/**
 * Build a repo with the given skills gitignore + a vendored skill, run
 * `git add -A`, and return the staged paths under `.claude/skills/`.
 */
function stagedSkillPaths(gitignore: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'skills-gi-'));
  tmps.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');

  mkdirSync(join(dir, '.claude', 'skills', 'canvas-design', 'examples'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', '.gitignore'), gitignore);
  writeFileSync(join(dir, '.claude', 'skills', 'canvas-design', 'SKILL.md'), '# canvas-design\n');
  writeFileSync(join(dir, '.claude', 'skills', 'canvas-design', 'meta.json'), '{"v":1}\n');
  writeFileSync(join(dir, '.claude', 'skills', 'canvas-design', 'examples', 'demo.png'), 'BODY');

  git('add', '-A');
  return git('diff', '--cached', '--name-only')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('.claude/skills/'));
}

describe('skills .gitignore — vendored→committed parity', () => {
  it('the SHIPPED augment commits SKILL.md + meta.json and ignores bodies', () => {
    const staged = stagedSkillPaths(shippedSkillsGitignore());
    expect(staged).toContain('.claude/skills/canvas-design/SKILL.md');
    expect(staged).toContain('.claude/skills/canvas-design/meta.json');
    // Heavy bodies must stay out of git (vendored on demand).
    expect(staged).not.toContain('.claude/skills/canvas-design/examples/demo.png');
  });

  it('the shipped augment contains the directory re-include rule', () => {
    // The one-line fix. Without it the rules below are unreachable.
    expect(shippedSkillsGitignore()).toMatch(/^\s*!\*\/\s*$/m);
  });

  it('REGRESSION: the old `*`-first pattern would NOT commit SKILL.md', () => {
    // Documents the exact bug — a tripwire if anyone "simplifies" the augment
    // back to the broken shape.
    const broken = ['*', '!.gitignore', '!*/SKILL.md', '!*/meta.json', ''].join('\n');
    const staged = stagedSkillPaths(broken);
    expect(staged).not.toContain('.claude/skills/canvas-design/SKILL.md');
    expect(staged).toEqual(['.claude/skills/.gitignore']);
  });
});
