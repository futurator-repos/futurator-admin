/**
 * gen-skill-index.test.mjs — Skills Management Phase 0, Story 0.1 (2026-06-13).
 *
 * Hermetic Vitest run against the skill-index generator. Builds a tmp skills
 * dir mirroring the real on-disk shape (anthropic skill with frontmatter
 * license + LICENSE.txt; bmad skill with no license; a malformed-frontmatter
 * skill; a non-skill dir) and asserts the emitted index satisfies the resolver
 * contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillIndex,
  parseFrontmatter,
  inferKind,
  resolveLicense,
  parseArgs,
} from '../gen-skill-index.mjs';

let root;

function makeSkill(name, { skillMd, license } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (skillMd !== null) {
    writeFileSync(join(dir, 'SKILL.md'), skillMd ?? `---\nname: ${name}\ndescription: desc for ${name}\n---\n\nbody`);
  }
  if (license) writeFileSync(join(dir, 'LICENSE.txt'), 'MIT-ish text');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gen-skill-index-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('parses a valid frontmatter block', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: bar\n---\nbody');
    expect(fm).toEqual({ name: 'foo', description: 'bar' });
  });
  it('returns {} for missing or malformed frontmatter', () => {
    expect(parseFrontmatter('no frontmatter here')).toEqual({});
    expect(parseFrontmatter('---\n: : : broken\n  bad: [\n---')).toEqual({});
  });
});

describe('inferKind', () => {
  it('flags bmad-* as framework, keeps kind=core', () => {
    expect(inferKind('bmad-create-prd')).toEqual({ kind: 'core', framework: true });
    expect(inferKind('frontend-design')).toEqual({ kind: 'core', framework: false });
  });
});

describe('resolveLicense', () => {
  it('prefers frontmatter license', () => {
    expect(resolveLicense(root, { license: 'Apache-2.0' })).toBe('Apache-2.0');
  });
  it('falls back to LICENSE file presence then UNKNOWN', () => {
    const dir = makeSkill('has-license', { license: true });
    expect(resolveLicense(dir, {})).toBe('See LICENSE.txt');
    expect(resolveLicense(join(root, 'nope'), {})).toBe('UNKNOWN');
  });
});

describe('buildSkillIndex', () => {
  it('emits a resolver-shaped index keyed-able by name, sorted', () => {
    makeSkill('frontend-design', {
      skillMd:
        '---\nname: frontend-design\ndescription: Distinctive UI design.\nlicense: Complete terms in LICENSE.txt\n---\nbody',
      license: true,
    });
    makeSkill('bmad-create-prd', {
      skillMd: "---\nname: bmad-create-prd\ndescription: 'Create a PRD.'\n---\nbody",
    });
    makeSkill('not-a-skill', { skillMd: null }); // no SKILL.md → skipped

    const index = buildSkillIndex(root);

    // contract: { skills: [...] } and every entry has a string name (the Map key)
    expect(Array.isArray(index.skills)).toBe(true);
    expect(index.skills.every((s) => typeof s.name === 'string' && s.name)).toBe(true);

    const names = index.skills.map((s) => s.name);
    expect(names).toEqual(['bmad-create-prd', 'frontend-design']); // sorted, non-skill dropped

    const bmad = index.skills.find((s) => s.name === 'bmad-create-prd');
    expect(bmad).toMatchObject({
      kind: 'core',
      framework: true,
      version: 'sha:HEAD',
      license: 'UNKNOWN',
      description: 'Create a PRD.',
    });

    const fe = index.skills.find((s) => s.name === 'frontend-design');
    expect(fe).toMatchObject({
      kind: 'core',
      framework: false,
      license: 'Complete terms in LICENSE.txt',
    });
  });

  it('indexes a skill with no frontmatter by its directory name', () => {
    makeSkill('orphan', { skillMd: '# no frontmatter\n' });
    const index = buildSkillIndex(root);
    expect(index.skills).toHaveLength(1);
    expect(index.skills[0]).toMatchObject({ name: 'orphan', description: '' });
  });

  it('throws on a non-directory path', () => {
    expect(() => buildSkillIndex(join(root, 'does-not-exist'))).toThrow(/not a directory/);
  });
});

describe('parseArgs', () => {
  it('parses --dir and --out', () => {
    expect(parseArgs(['--dir', 'a', '--out', 'b'])).toEqual({ dir: 'a', out: 'b' });
    expect(parseArgs(['--dir', 'a'])).toEqual({ dir: 'a', out: null });
  });
});
