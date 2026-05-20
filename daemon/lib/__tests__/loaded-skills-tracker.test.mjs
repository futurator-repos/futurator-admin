/**
 * loaded-skills-tracker.test.mjs — Pipeline v2 Phase 3-C Epic 4
 * (2026-05-20).
 *
 * Tests the tracker that powers the populated `Skills-Used:` commit
 * trailer. Hermetic — all I/O against tmp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSkillSourceLookup,
  readLoadedSkills,
  recordSkillActivation,
  resetLoadedSkills,
} from '../loaded-skills-tracker.mjs';

const MANIFEST = `project: my-app
manifest-version: 1
core:
  - source: anthropic-official
    skill: canvas-design
    version: tag:v1
  - source: anthropic-official
    skill: frontend-design
    version: tag:v1
stack:
  - source: vercel-web
    skill: vercel-react-best-practices
    version: tag:v2.4.1
domain: []
vendor: []
plans: {}
gaps: []
`;

describe('buildSkillSourceLookup', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lst-lookup-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds a name → source map from all four buckets', () => {
    writeFileSync(join(dir, '.claude/skills.manifest.yaml'), MANIFEST, 'utf-8');
    const lookup = buildSkillSourceLookup(dir);
    expect(lookup.get('canvas-design')).toBe('anthropic-official');
    expect(lookup.get('frontend-design')).toBe('anthropic-official');
    expect(lookup.get('vercel-react-best-practices')).toBe('vercel-web');
  });

  it('returns empty map when manifest is missing', () => {
    const lookup = buildSkillSourceLookup(dir);
    expect(lookup.size).toBe(0);
  });

  it('returns empty map on malformed YAML', () => {
    writeFileSync(join(dir, '.claude/skills.manifest.yaml'), ': : : !!!', 'utf-8');
    const lookup = buildSkillSourceLookup(dir);
    expect(lookup.size).toBe(0);
  });

  it('ignores entries missing skill/source fields', () => {
    writeFileSync(
      join(dir, '.claude/skills.manifest.yaml'),
      `core:\n  - source: x\n  - skill: orphan\n`,
      'utf-8',
    );
    const lookup = buildSkillSourceLookup(dir);
    expect(lookup.size).toBe(0);
  });
});

describe('readLoadedSkills', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lst-read-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns empty array when file is missing', () => {
    expect(readLoadedSkills(dir)).toEqual([]);
  });

  it('returns parsed entries when file is well-formed', () => {
    mkdirSync(join(dir, '.context'), { recursive: true });
    writeFileSync(
      join(dir, '.context/loaded-skills.json'),
      JSON.stringify([{ skill: 'canvas-design', source: 'anthropic-official' }]),
      'utf-8',
    );
    expect(readLoadedSkills(dir)).toEqual([
      { skill: 'canvas-design', source: 'anthropic-official' },
    ]);
  });

  it('filters out malformed entries (missing skill or source)', () => {
    mkdirSync(join(dir, '.context'), { recursive: true });
    writeFileSync(
      join(dir, '.context/loaded-skills.json'),
      JSON.stringify([
        { skill: 'canvas-design', source: 'anthropic-official' },
        { skill: 'orphan' }, // missing source
        { source: 'x' }, // missing skill
        'string-junk',
        null,
      ]),
      'utf-8',
    );
    expect(readLoadedSkills(dir)).toEqual([
      { skill: 'canvas-design', source: 'anthropic-official' },
    ]);
  });

  it('returns empty on malformed JSON', () => {
    mkdirSync(join(dir, '.context'), { recursive: true });
    writeFileSync(join(dir, '.context/loaded-skills.json'), '{not json}', 'utf-8');
    expect(readLoadedSkills(dir)).toEqual([]);
  });
});

describe('recordSkillActivation', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lst-rec-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills.manifest.yaml'), MANIFEST, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a new entry with manifest-derived source', () => {
    const r = recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    expect(r.written).toBe(true);
    expect(r.source).toBe('anthropic-official');
    expect(r.total).toBe(1);
    expect(readLoadedSkills(dir)).toEqual([
      { skill: 'canvas-design', source: 'anthropic-official' },
    ]);
  });

  it('falls back to source=unknown when skill not in manifest', () => {
    const r = recordSkillActivation({ workingDir: dir, skillName: 'mystery-skill' });
    expect(r.written).toBe(true);
    expect(r.source).toBe('unknown');
  });

  it('is idempotent — second recording is a no-op', () => {
    recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    const r2 = recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    expect(r2.written).toBe(false);
    expect(r2.total).toBe(1);
    expect(readLoadedSkills(dir)).toHaveLength(1);
  });

  it('appends new skills across calls (cumulative set)', () => {
    recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    recordSkillActivation({ workingDir: dir, skillName: 'frontend-design' });
    recordSkillActivation({ workingDir: dir, skillName: 'vercel-react-best-practices' });
    const final = readLoadedSkills(dir);
    expect(final).toHaveLength(3);
    expect(final.map((e) => e.skill)).toContain('canvas-design');
    expect(final.map((e) => e.skill)).toContain('frontend-design');
    expect(final.map((e) => e.skill)).toContain('vercel-react-best-practices');
  });

  it('writes entries sorted alphabetically for deterministic commit shell output', () => {
    // Insert in reverse alphabetical order; expect alphabetical output.
    recordSkillActivation({ workingDir: dir, skillName: 'vercel-react-best-practices' });
    recordSkillActivation({ workingDir: dir, skillName: 'frontend-design' });
    recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    const final = readLoadedSkills(dir);
    const keys = final.map((e) => `${e.skill}@${e.source}`);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
  });

  it('creates .context/ directory if missing', () => {
    expect(existsSync(join(dir, '.context'))).toBe(false);
    recordSkillActivation({ workingDir: dir, skillName: 'canvas-design' });
    expect(existsSync(join(dir, '.context'))).toBe(true);
  });

  it('uses pre-built lookup when provided (perf)', () => {
    const lookup = new Map([['custom-skill', 'custom-source']]);
    const r = recordSkillActivation({
      workingDir: dir,
      skillName: 'custom-skill',
      sourceLookup: lookup,
    });
    expect(r.source).toBe('custom-source');
  });

  it('throws on missing workingDir', () => {
    expect(() => recordSkillActivation({ skillName: 'x' })).toThrow(/workingDir required/);
  });

  it('throws on missing skillName', () => {
    expect(() => recordSkillActivation({ workingDir: dir, skillName: '' })).toThrow(
      /skillName required/,
    );
  });
});

describe('resetLoadedSkills', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lst-reset-'));
    mkdirSync(join(dir, '.context'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('truncates the file to []', () => {
    writeFileSync(
      join(dir, '.context/loaded-skills.json'),
      '[{"skill":"x","source":"y"}]',
      'utf-8',
    );
    resetLoadedSkills(dir);
    expect(readLoadedSkills(dir)).toEqual([]);
  });

  it('is a no-op when the file is absent', () => {
    expect(() => resetLoadedSkills(dir)).not.toThrow();
  });

  it('is a no-op on undefined workingDir', () => {
    expect(() => resetLoadedSkills()).not.toThrow();
  });
});
