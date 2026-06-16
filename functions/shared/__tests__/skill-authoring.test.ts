/**
 * skill-authoring.test.ts — Skills Management Phase 2, Story 2.2 (2026-06-15).
 *
 * Unit tests for the pure authoring helpers (buildSkillMd / upsertIndexEntry /
 * removeIndexEntry) and the name guard. The GitHub-I/O orchestration
 * (putSkill/deleteSkill) is exercised at the endpoint layer; here we lock the
 * deterministic pieces.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSkillMd,
  parseSkillMd,
  upsertIndexEntry,
  removeIndexEntry,
  SKILL_NAME_RE,
  type SkillIndex,
} from '../skill-authoring';

describe('parseSkillMd', () => {
  it('is the inverse of buildSkillMd (round-trips name/description/body)', () => {
    const input = {
      name: 'my-skill',
      description: 'Does a thing: well',
      body: '# Body\n\nLine two.',
    };
    const md = buildSkillMd(input);
    const parsed = parseSkillMd(md);
    expect(parsed.name).toBe('my-skill');
    expect(parsed.description).toBe('Does a thing: well');
    expect(parsed.body).toBe('# Body\n\nLine two.');
  });

  it('round-trips descriptions with quotes and backslashes without accumulating escapes', () => {
    const description = 'He said "hi" and used a back\\slash';
    const md = buildSkillMd({ name: 'q', description, body: 'b' });
    expect(parseSkillMd(md).description).toBe(description);
    // edit→save→re-read must be stable (no escape accumulation)
    const rebuilt = buildSkillMd({
      name: 'q',
      description: parseSkillMd(md).description!,
      body: 'b',
    });
    expect(rebuilt).toBe(md);
  });

  it('treats a body-only string (no frontmatter) as all body', () => {
    const parsed = parseSkillMd('just prose, no fence');
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.body).toBe('just prose, no fence');
  });

  it('tolerates an unquoted description (skills not authored here)', () => {
    const md = '---\nname: x\ndescription: plain text\n---\n\nbody';
    const parsed = parseSkillMd(md);
    expect(parsed.description).toBe('plain text');
    expect(parsed.body).toBe('body');
  });
});

describe('buildSkillMd', () => {
  it('emits frontmatter with quoted description + trimmed body', () => {
    const md = buildSkillMd({
      name: 'my-skill',
      description: 'Does a thing: well',
      body: '  # Body\n',
    });
    expect(md).toContain('name: my-skill');
    expect(md).toContain('description: "Does a thing: well"'); // colon-safe via quoting
    expect(md.endsWith('# Body\n')).toBe(true);
  });
  it('escapes quotes and backslashes in description', () => {
    const md = buildSkillMd({ name: 'x', description: 'a "q" and \\ slash', body: 'b' });
    expect(md).toContain('description: "a \\"q\\" and \\\\ slash"');
  });
});

describe('SKILL_NAME_RE', () => {
  it('accepts slugs, rejects junk', () => {
    expect(SKILL_NAME_RE.test('my-skill-1')).toBe(true);
    expect(SKILL_NAME_RE.test('Bad Name')).toBe(false);
    expect(SKILL_NAME_RE.test('a')).toBe(false); // too short (min 2)
    expect(SKILL_NAME_RE.test('UPPER')).toBe(false);
    expect(SKILL_NAME_RE.test('../escape')).toBe(false);
  });
});

describe('upsertIndexEntry', () => {
  const base: SkillIndex = {
    skills: [
      {
        name: 'beta',
        kind: 'core',
        framework: false,
        version: 'sha:HEAD',
        license: 'MIT',
        description: 'b',
      },
    ],
  };
  const entry = {
    name: 'alpha',
    kind: 'core',
    framework: false,
    version: 'sha:HEAD',
    license: 'MIT',
    description: 'a',
  };

  it('appends and keeps name-sorted', () => {
    const next = upsertIndexEntry(base, entry);
    expect(next.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });
  it('replaces an existing entry by name (no dupes)', () => {
    const next = upsertIndexEntry(base, { ...entry, name: 'beta', description: 'updated' });
    expect(next.skills).toHaveLength(1);
    expect(next.skills[0].description).toBe('updated');
  });
  it('does not mutate the input', () => {
    upsertIndexEntry(base, entry);
    expect(base.skills).toHaveLength(1);
  });
});

describe('removeIndexEntry', () => {
  const base: SkillIndex = {
    skills: [
      {
        name: 'a',
        kind: 'core',
        framework: false,
        version: 'sha:HEAD',
        license: 'MIT',
        description: '',
      },
      {
        name: 'b',
        kind: 'core',
        framework: false,
        version: 'sha:HEAD',
        license: 'MIT',
        description: '',
      },
    ],
  };
  it('removes by name', () => {
    expect(removeIndexEntry(base, 'a').skills.map((s) => s.name)).toEqual(['b']);
  });
  it('no-op when absent', () => {
    expect(removeIndexEntry(base, 'zzz').skills).toHaveLength(2);
  });
});
