/**
 * commit-metadata.test.mjs — Pipeline v2 Phase 3 / Story 3-C-4-1 (PR-73).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSkillsUsedLine,
  buildSkillsManifestShaLine,
  buildSkillsCommitFlags,
  quoteFlagsForShell,
  parseSkillsUsedLine,
  parseSkillsManifestShaLine,
  buildCommitMetadataFlags,
  composeFullCommitMessage,
  parseMetadataField,
  KNOWN_AGENT_LABELS,
} from '../commit-metadata.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'commit-meta-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildSkillsUsedLine', () => {
  it('renders alphabetical comma+space list of skill@source', () => {
    const line = buildSkillsUsedLine([
      { source: 'vercel-web', skill: 'vercel-react-best-practices' },
      { source: 'anthropic-official', skill: 'frontend-design' },
      { source: 'futurator-internal', skill: 'music-theory-engine' },
    ]);
    expect(line).toBe(
      'Skills-Used: frontend-design@anthropic-official, music-theory-engine@futurator-internal, vercel-react-best-practices@vercel-web',
    );
  });

  it('returns "Skills-Used:" (label only) when no skills loaded', () => {
    expect(buildSkillsUsedLine([])).toBe('Skills-Used:');
  });

  it('returns "Skills-Used:" for null/undefined input', () => {
    expect(buildSkillsUsedLine(null)).toBe('Skills-Used:');
    expect(buildSkillsUsedLine(undefined)).toBe('Skills-Used:');
  });

  it('dedupes identical entries', () => {
    const line = buildSkillsUsedLine([
      { source: 'a', skill: 'x' },
      { source: 'a', skill: 'x' },
      { source: 'b', skill: 'y' },
    ]);
    expect(line).toBe('Skills-Used: x@a, y@b');
  });
});

describe('buildSkillsManifestShaLine', () => {
  it('returns null when manifest missing', () => {
    expect(buildSkillsManifestShaLine(tmp)).toBeNull();
  });

  it('returns sha256 of the manifest file contents', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    const content = 'project: dino\nmanifest-version: 1\n';
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), content);
    const line = buildSkillsManifestShaLine(tmp);
    expect(line).toMatch(/^Skills-Manifest-Sha: [a-f0-9]{64}$/);
  });

  it('SHA changes when content changes', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), 'v1');
    const a = buildSkillsManifestShaLine(tmp);
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), 'v2');
    const b = buildSkillsManifestShaLine(tmp);
    expect(a).not.toBe(b);
  });

  it('honors custom manifest path', () => {
    mkdirSync(join(tmp, 'alt'), { recursive: true });
    writeFileSync(join(tmp, 'alt', 'manifest.yaml'), 'x');
    expect(buildSkillsManifestShaLine(tmp, 'alt/manifest.yaml')).toMatch(/^Skills-Manifest-Sha:/);
    expect(buildSkillsManifestShaLine(tmp, 'missing.yaml')).toBeNull();
  });
});

describe('buildSkillsCommitFlags', () => {
  it('returns empty array under prototype rigor', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), 'x');
    const flags = buildSkillsCommitFlags({
      rigor: 'prototype',
      workingDir: tmp,
      loadedSkills: [{ source: 's', skill: 'k' }],
    });
    expect(flags).toEqual([]);
  });

  it('mvp + no manifest → only Skills-Used: line', () => {
    const flags = buildSkillsCommitFlags({
      rigor: 'mvp',
      workingDir: tmp, // no manifest written
      loadedSkills: [],
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toBe('Skills-Used:');
  });

  it('mvp + manifest + loaded skills → both lines, alphabetical', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), 'content');
    const flags = buildSkillsCommitFlags({
      rigor: 'mvp',
      workingDir: tmp,
      loadedSkills: [
        { source: 'vercel-web', skill: 'best-practices' },
        { source: 'anthropic-official', skill: 'frontend-design' },
      ],
    });
    expect(flags).toHaveLength(2);
    expect(flags[0]).toBe('Skills-Used: best-practices@vercel-web, frontend-design@anthropic-official');
    expect(flags[1]).toMatch(/^Skills-Manifest-Sha: [a-f0-9]{64}$/);
  });

  it('production rigor also emits both lines', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'skills.manifest.yaml'), 'x');
    const flags = buildSkillsCommitFlags({
      rigor: 'production',
      workingDir: tmp,
      loadedSkills: [{ source: 'a', skill: 'k' }],
    });
    expect(flags).toHaveLength(2);
  });
});

describe('quoteFlagsForShell', () => {
  it('single-quotes flag bodies', () => {
    expect(quoteFlagsForShell(['Skills-Used: a, b'])).toEqual(["'Skills-Used: a, b'"]);
  });

  it("escapes embedded single quotes", () => {
    expect(quoteFlagsForShell(["it's a thing"])).toEqual(["'it'\\''s a thing'"]);
  });

  it('handles empty array', () => {
    expect(quoteFlagsForShell([])).toEqual([]);
  });
});

describe('parseSkillsUsedLine', () => {
  it('extracts comma-separated tokens', () => {
    const body = `subject\n\nSkills-Used: frontend-design@anthropic-official, music-theory-engine@futurator-internal\n`;
    expect(parseSkillsUsedLine(body)).toEqual([
      'frontend-design@anthropic-official',
      'music-theory-engine@futurator-internal',
    ]);
  });

  it('returns empty array when line absent', () => {
    expect(parseSkillsUsedLine('just a subject')).toEqual([]);
  });

  it('returns empty array when line present but empty', () => {
    expect(parseSkillsUsedLine('subject\n\nSkills-Used:')).toEqual([]);
    expect(parseSkillsUsedLine('subject\n\nSkills-Used:    ')).toEqual([]);
  });
});

describe('parseSkillsManifestShaLine', () => {
  it('extracts the hex SHA', () => {
    const sha = 'a'.repeat(64);
    const body = `subject\n\nSkills-Manifest-Sha: ${sha}\n`;
    expect(parseSkillsManifestShaLine(body)).toBe(sha);
  });

  it('returns null when line absent', () => {
    expect(parseSkillsManifestShaLine('subject')).toBeNull();
  });

  it('returns null when value isnt 64-char hex', () => {
    expect(parseSkillsManifestShaLine('Skills-Manifest-Sha: tooshort')).toBeNull();
    expect(parseSkillsManifestShaLine('Skills-Manifest-Sha: ' + 'g'.repeat(64))).toBeNull();
  });
});

// ── PR-85 (Story 2-B-1-1) — v2.5 §23 full commit metadata template ────────

describe('buildCommitMetadataFlags', () => {
  it('throws when agent missing', () => {
    expect(() => buildCommitMetadataFlags({})).toThrow(/agent is required/);
  });

  it('emits Agent line at minimum', () => {
    expect(buildCommitMetadataFlags({ agent: 'DEV' })).toEqual(['Agent: DEV']);
  });

  it('emits v2.5 §23 lines in canonical order', () => {
    const flags = buildCommitMetadataFlags({
      agent: 'DEV',
      planId: 'pln-1',
      plan: 'songster-v2-storyboard',
      epicId: 'epic-3',
      wave: 2,
      story: 'E3-S5',
    });
    expect(flags).toEqual([
      'Agent: DEV',
      'Plan-Id: pln-1',
      'Plan: songster-v2-storyboard',
      'Epic-Id: epic-3',
      'Wave: 2',
      'Story: E3-S5',
    ]);
  });

  it('emits Stream line when provided', () => {
    const flags = buildCommitMetadataFlags({
      agent: 'OPERATOR',
      stream: 'live-perf-teleprompter',
    });
    expect(flags).toContain('Stream: live-perf-teleprompter');
  });

  it('omits absent fields', () => {
    expect(buildCommitMetadataFlags({ agent: 'WAVE-MERGE' })).toEqual(['Agent: WAVE-MERGE']);
  });

  it('emits Reflection-Id for REFLECTOR-APPLY commits', () => {
    const flags = buildCommitMetadataFlags({
      agent: 'REFLECTOR-APPLY',
      reflectionId: 'ref-123',
    });
    expect(flags).toContain('Reflection-Id: ref-123');
  });
});

describe('KNOWN_AGENT_LABELS', () => {
  it('contains the Phase 2 + Phase 3 agent roster', () => {
    expect(KNOWN_AGENT_LABELS).toContain('PM');
    expect(KNOWN_AGENT_LABELS).toContain('DEV');
    expect(KNOWN_AGENT_LABELS).toContain('WAVE-MERGE');
    expect(KNOWN_AGENT_LABELS).toContain('REFLECTOR-APPLY');
    expect(KNOWN_AGENT_LABELS).toContain('SKILL-SCOUT');
    expect(KNOWN_AGENT_LABELS).toContain('ARCHITECT');
    expect(KNOWN_AGENT_LABELS).toContain('EVALUATOR');
  });
});

describe('composeFullCommitMessage', () => {
  it('combines §23 metadata + PR-73 skills flags', () => {
    const result = composeFullCommitMessage({
      subject: 'story: E3-S5 — chord overlay',
      agent: 'DEV',
      rigor: 'mvp',
      workingDir: '/no/manifest/here',
      planId: 'pln-1',
      story: 'E3-S5',
      wave: 2,
      loadedSkills: [{ source: 'anthropic-official', skill: 'frontend-design' }],
    });
    expect(result.subject).toContain('chord overlay');
    expect(result.flagBodies[0]).toBe('Agent: DEV');
    expect(result.flagBodies).toContain('Plan-Id: pln-1');
    expect(result.flagBodies).toContain('Wave: 2');
    // Skills lines appended after §23 lines
    const skillsLine = result.flagBodies.find((b) => b.startsWith('Skills-Used:'));
    expect(skillsLine).toBe('Skills-Used: frontend-design@anthropic-official');
  });

  it('omits skills flags under prototype rigor', () => {
    const result = composeFullCommitMessage({
      subject: 's',
      agent: 'DEV',
      rigor: 'prototype',
      workingDir: '/x',
      loadedSkills: [{ source: 'a', skill: 'b' }],
    });
    expect(result.flagBodies.find((b) => b.startsWith('Skills-Used:'))).toBeUndefined();
  });
});

describe('parseMetadataField', () => {
  const sample = `story: E3-S5 — chord overlay\n\nAgent: DEV\nPlan-Id: pln-1\nWave: 2\nStory: E3-S5\n`;

  it('extracts Plan-Id', () => {
    expect(parseMetadataField(sample, 'Plan-Id')).toBe('pln-1');
  });

  it('extracts Wave (numeric)', () => {
    expect(parseMetadataField(sample, 'Wave')).toBe('2');
  });

  it('extracts Agent', () => {
    expect(parseMetadataField(sample, 'Agent')).toBe('DEV');
  });

  it('returns null when field absent', () => {
    expect(parseMetadataField(sample, 'Stream')).toBeNull();
  });
});
