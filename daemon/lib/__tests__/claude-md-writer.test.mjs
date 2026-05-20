/**
 * claude-md-writer.test.mjs — Pipeline v2 Phase 3-C Epic 5 (2026-05-20).
 *
 * Hermetic tests against a tmp-dir CLAUDE.md that mirrors the boilerplate
 * template's section structure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  locateSection,
  sectionBody,
  seedWhatThisIs,
  appendArchitectureDecision,
} from '../claude-md-writer.mjs';

const TEMPLATE = `# Project: __APP_DISPLAY_NAME__

## What this is

<!-- PM agent populates from project intent at init -->

## Architecture decisions

<!-- Append-only. Each entry: date — decision — rationale — proposed by. -->

## Constraints discovered

<!-- REFLECTOR promotes things like… -->

## Patterns to use

<!-- Project-specific patterns. -->

## Domain glossary

<!-- PM seeds at init from operator-named terms. -->
`;

describe('locateSection + sectionBody', () => {
  it('finds a section by exact match and returns the body range', () => {
    const lines = TEMPLATE.split('\n');
    const r = locateSection(lines, 'Architecture decisions');
    expect(r).not.toBeNull();
    expect(lines[r.headerLine]).toBe('## Architecture decisions');
  });

  it('is case-insensitive', () => {
    const lines = TEMPLATE.split('\n');
    expect(locateSection(lines, 'architecture DECISIONS')).not.toBeNull();
  });

  it('returns null when section is missing', () => {
    const lines = TEMPLATE.split('\n');
    expect(locateSection(lines, 'Nonexistent')).toBeNull();
  });

  it('returns empty body string for sections with only HTML-comment placeholders', () => {
    const lines = TEMPLATE.split('\n');
    const r = locateSection(lines, 'What this is');
    expect(sectionBody(lines, r)).toBe('');
  });

  it('returns body text when the section has prose', () => {
    const populated = TEMPLATE.replace(
      '<!-- PM agent populates from project intent at init -->',
      'A pixel-art snake game using Next.js + Canvas2D.',
    );
    const lines = populated.split('\n');
    const r = locateSection(lines, 'What this is');
    expect(sectionBody(lines, r)).toContain('pixel-art snake game');
  });
});

describe('seedWhatThisIs', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmd-w-'));
    writeFileSync(join(dir, 'CLAUDE.md'), TEMPLATE, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the purpose into an empty What-this-is section', async () => {
    const result = await seedWhatThisIs({
      workingDir: dir,
      purpose: 'A pixel-art snake game using Next.js + Canvas2D.',
    });
    expect(result.written).toBe(true);
    expect(result.newSha).toBeTruthy();
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('A pixel-art snake game using Next.js + Canvas2D.');
  });

  it('is idempotent — second call with same purpose is no-op', async () => {
    await seedWhatThisIs({ workingDir: dir, purpose: 'first' });
    const r2 = await seedWhatThisIs({ workingDir: dir, purpose: 'second' });
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe('already-populated');
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('first');
    expect(after).not.toContain('second');
  });

  it('fails soft when CLAUDE.md is absent', async () => {
    rmSync(join(dir, 'CLAUDE.md'));
    const r = await seedWhatThisIs({ workingDir: dir, purpose: 'x' });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('claude-md-missing');
  });

  it('fails soft when the section heading is missing', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Title\n\n## Other\n\nbody\n', 'utf-8');
    const r = await seedWhatThisIs({ workingDir: dir, purpose: 'x' });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('section-missing');
  });

  it('emits a claude_md_updated event with the new sha on success', async () => {
    const events = [];
    await seedWhatThisIs({
      workingDir: dir,
      purpose: 'x',
      onEvent: async (type, payload) => events.push({ type, payload }),
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claude_md_updated');
    expect(events[0].payload.section).toBe('What this is');
    expect(events[0].payload.writer).toBe('PM');
    expect(events[0].payload.newSha).toBeTruthy();
  });

  it('throws on missing args', async () => {
    await expect(seedWhatThisIs({ workingDir: dir })).rejects.toThrow(/purpose required/);
    await expect(seedWhatThisIs({ purpose: 'x' })).rejects.toThrow(/workingDir required/);
  });
});

describe('appendArchitectureDecision', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmd-arch-'));
    writeFileSync(join(dir, 'CLAUDE.md'), TEMPLATE, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends a dated entry under Architecture decisions', async () => {
    const result = await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-1',
      decision: 'Use canvas-design skill for sprite rendering',
      rationale: 'pixel-art ergonomics + recommended by SKILL-SCOUT',
      isoDate: '2026-05-20',
    });
    expect(result.written).toBe(true);
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('**2026-05-20**');
    expect(after).toContain('Use canvas-design skill');
    expect(after).toContain('DEV @story `story-1`');
    expect(after).toContain('<!-- story:story-1 date:2026-05-20 -->');
  });

  it('preserves prior decisions and appends new ones below', async () => {
    await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-1',
      decision: 'first',
      rationale: 'r1',
      isoDate: '2026-05-20',
    });
    await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-2',
      decision: 'second',
      rationale: 'r2',
      isoDate: '2026-05-21',
    });
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after.indexOf('first')).toBeLessThan(after.indexOf('second'));
    expect(after).toContain('story:story-1');
    expect(after).toContain('story:story-2');
  });

  it('is idempotent on re-run of same (storyId, date)', async () => {
    await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-1',
      decision: 'first',
      rationale: 'r1',
      isoDate: '2026-05-20',
    });
    const r2 = await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-1',
      decision: 'second',
      rationale: 'r2',
      isoDate: '2026-05-20',
    });
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe('idempotent-dup');
    const after = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('first');
    expect(after).not.toContain('second');
  });

  it('fails soft when CLAUDE.md missing', async () => {
    rmSync(join(dir, 'CLAUDE.md'));
    const r = await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'x',
      decision: 'd',
      rationale: 'r',
    });
    expect(r.written).toBe(false);
    expect(r.reason).toBe('claude-md-missing');
  });

  it('emits a claude_md_updated event with section + writer + storyId', async () => {
    const events = [];
    await appendArchitectureDecision({
      workingDir: dir,
      storyId: 'story-abc',
      decision: 'd',
      rationale: 'r',
      onEvent: async (type, payload) => events.push({ type, payload }),
    });
    expect(events[0].payload.section).toBe('Architecture decisions');
    expect(events[0].payload.writer).toBe('DEV');
    expect(events[0].payload.storyId).toBe('story-abc');
  });

  it('throws on missing args', async () => {
    await expect(appendArchitectureDecision({ storyId: 'x', decision: 'd', rationale: 'r' })).rejects.toThrow(
      /workingDir required/,
    );
    await expect(
      appendArchitectureDecision({ workingDir: dir, storyId: '', decision: 'd', rationale: 'r' }),
    ).rejects.toThrow(/storyId required/);
    await expect(
      appendArchitectureDecision({ workingDir: dir, storyId: 'x', decision: '', rationale: 'r' }),
    ).rejects.toThrow(/decision required/);
    await expect(
      appendArchitectureDecision({ workingDir: dir, storyId: 'x', decision: 'd', rationale: '' }),
    ).rejects.toThrow(/rationale required/);
  });
});
