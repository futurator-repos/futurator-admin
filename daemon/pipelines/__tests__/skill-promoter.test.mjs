/**
 * skill-promoter.test.mjs — Pipeline v2 Phase 3 / Story 3-E-5-1 (PR-83).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  copyProjectSkillToOrg,
  rewriteManifestForPromotion,
  checkDemotionEligibility,
  buildPromotionCommitFlags,
  computeStackFingerprint,
  cleanupProjectLocalCopy,
} from '../skill-promoter.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-promoter-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('copyProjectSkillToOrg', () => {
  it('copies skill folder with subfiles', () => {
    const projectPath = join(tmp, 'proj');
    const orgRoot = join(tmp, 'org');
    mkdirSync(join(projectPath, '.claude', 'skills', 'demo', 'examples'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo');
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'meta.json'), '{}');
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'examples', 'a.md'), 'x');

    const result = copyProjectSkillToOrg({ projectPath, orgSkillsRoot: orgRoot, skillName: 'demo' });
    expect(result.copied).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(existsSync(join(orgRoot, 'demo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(orgRoot, 'demo', 'examples', 'a.md'))).toBe(true);
  });

  it('refuses copy when source missing', () => {
    const result = copyProjectSkillToOrg({
      projectPath: tmp,
      orgSkillsRoot: tmp,
      skillName: 'absent',
    });
    expect(result.copied).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it('refuses copy when target exists', () => {
    const projectPath = join(tmp, 'p');
    const orgRoot = join(tmp, 'o');
    mkdirSync(join(projectPath, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'SKILL.md'), 'x');
    mkdirSync(join(orgRoot, 'demo'), { recursive: true });

    const result = copyProjectSkillToOrg({ projectPath, orgSkillsRoot: orgRoot, skillName: 'demo' });
    expect(result.copied).toBe(false);
    expect(result.reason).toMatch(/already exists/);
  });

  it('rejects path-traversal skill names', () => {
    expect(copyProjectSkillToOrg({ projectPath: tmp, orgSkillsRoot: tmp, skillName: '../etc' }).copied).toBe(false);
    expect(copyProjectSkillToOrg({ projectPath: tmp, orgSkillsRoot: tmp, skillName: 'a/b' }).copied).toBe(false);
    expect(copyProjectSkillToOrg({ projectPath: tmp, orgSkillsRoot: tmp, skillName: '' }).copied).toBe(false);
  });
});

describe('rewriteManifestForPromotion', () => {
  const BASE_MANIFEST = `project: dino
manifest-version: 1
generated-by: skill-scout@v2.5
core: []
stack:
  - source: project-local
    skill: demo-helper
    version: sha:${'a'.repeat(40)}
domain: []
vendor: []
plans: {}
gaps: []
`;

  it('rebases source to org-wide by default', () => {
    const result = rewriteManifestForPromotion({
      manifestYaml: BASE_MANIFEST,
      skillName: 'demo-helper',
      newSource: 'futurator-internal',
    });
    expect(result.action).toBe('rebase-source');
    expect(result.bucket).toBe('stack');
    expect(result.yaml).toContain('source: futurator-internal');
    expect(result.yaml).toContain('skill: demo-helper');
  });

  it('honors newVersion when provided', () => {
    const result = rewriteManifestForPromotion({
      manifestYaml: BASE_MANIFEST,
      skillName: 'demo-helper',
      newSource: 'futurator-internal',
      newVersion: 'tag:v1.0.0',
    });
    expect(result.yaml).toContain('version: tag:v1.0.0');
  });

  it('action=remove drops the entry entirely', () => {
    const result = rewriteManifestForPromotion({
      manifestYaml: BASE_MANIFEST,
      skillName: 'demo-helper',
      newSource: 'futurator-internal',
      action: 'remove',
    });
    expect(result.action).toBe('remove');
    expect(result.yaml).not.toContain('demo-helper');
  });

  it('returns noop when skill not in manifest', () => {
    const result = rewriteManifestForPromotion({
      manifestYaml: BASE_MANIFEST,
      skillName: 'nonexistent',
      newSource: 'futurator-internal',
    });
    expect(result.action).toBe('noop');
    expect(result.yaml).toBe(BASE_MANIFEST);
  });
});

describe('checkDemotionEligibility', () => {
  it('flags as eligible when never used', () => {
    const result = checkDemotionEligibility({ lastUsedAt: null });
    expect(result.demote).toBe(true);
    expect(result.reason).toMatch(/never used/);
  });

  it('flags as eligible after 90+ days', () => {
    const lastUsedAt = '2026-01-01T00:00:00Z';
    const now = () => Date.parse('2026-05-15T00:00:00Z'); // ~134 days later
    const result = checkDemotionEligibility({ lastUsedAt, now });
    expect(result.demote).toBe(true);
    expect(result.ageDays).toBeGreaterThan(90);
  });

  it('keeps under threshold', () => {
    const lastUsedAt = '2026-04-01T00:00:00Z';
    const now = () => Date.parse('2026-05-15T00:00:00Z'); // ~44 days
    const result = checkDemotionEligibility({ lastUsedAt, now });
    expect(result.demote).toBe(false);
    expect(result.ageDays).toBeLessThan(90);
  });

  it('returns no-demote on unparseable date', () => {
    const result = checkDemotionEligibility({ lastUsedAt: 'not a date' });
    expect(result.demote).toBe(false);
    expect(result.reason).toMatch(/unparseable/);
  });

  it('respects custom threshold', () => {
    const lastUsedAt = '2026-04-01T00:00:00Z';
    const now = () => Date.parse('2026-05-15T00:00:00Z'); // ~44 days
    const result = checkDemotionEligibility({ lastUsedAt, now, thresholdDays: 30 });
    expect(result.demote).toBe(true);
  });
});

describe('buildPromotionCommitFlags', () => {
  it('emits the expected metadata lines', () => {
    const flags = buildPromotionCommitFlags({
      skillName: 'react-hooks-discipline',
      sourceProject: 'dino-runner-1',
      reflectionId: 'ref-123',
    });
    expect(flags[0]).toContain('Promote react-hooks-discipline');
    expect(flags[1]).toBe('Source-Project: dino-runner-1');
    expect(flags[2]).toBe('Agent: REFLECTOR-APPLY');
    expect(flags[3]).toBe('Reflection-Id: ref-123');
  });
});

describe('computeStackFingerprint', () => {
  it('is deterministic for same inputs', () => {
    const a = computeStackFingerprint({
      boilerplateKind: 'nextjs-canvas-game',
      primaryFramework: 'next.js',
      awsServices: ['s3', 'cloudfront'],
    });
    const b = computeStackFingerprint({
      boilerplateKind: 'nextjs-canvas-game',
      primaryFramework: 'next.js',
      awsServices: ['cloudfront', 's3'], // different order — should match
    });
    expect(a).toBe(b);
  });

  it('differs when boilerplate changes', () => {
    const a = computeStackFingerprint({ boilerplateKind: 'nextjs-base' });
    const b = computeStackFingerprint({ boilerplateKind: 'vite' });
    expect(a).not.toBe(b);
  });

  it('returns 16-char hex', () => {
    const fp = computeStackFingerprint({ boilerplateKind: 'x' });
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('cleanupProjectLocalCopy', () => {
  it('removes the project skill folder', () => {
    const projectPath = join(tmp, 'p');
    mkdirSync(join(projectPath, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'SKILL.md'), 'x');
    const result = cleanupProjectLocalCopy({ projectPath, skillName: 'demo' });
    expect(result.removed).toBe(true);
    expect(existsSync(result.path)).toBe(false);
  });

  it('is idempotent (no-op on second call)', () => {
    const projectPath = join(tmp, 'p2');
    mkdirSync(join(projectPath, '.claude', 'skills', 'demo'), { recursive: true });
    writeFileSync(join(projectPath, '.claude', 'skills', 'demo', 'SKILL.md'), 'x');
    cleanupProjectLocalCopy({ projectPath, skillName: 'demo' });
    const second = cleanupProjectLocalCopy({ projectPath, skillName: 'demo' });
    expect(second.removed).toBe(false);
  });

  it('rejects path-traversal skill names', () => {
    expect(cleanupProjectLocalCopy({ projectPath: tmp, skillName: '..' }).removed).toBe(false);
  });
});
