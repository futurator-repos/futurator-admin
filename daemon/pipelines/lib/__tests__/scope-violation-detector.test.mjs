import { describe, it, expect } from 'vitest';
import {
  parseDiffFiles,
  detectScopeViolations,
  renderScopeViolationsAsCriteria,
} from '../scope-violation-detector.mjs';

describe('parseDiffFiles', () => {
  it('parses A/M/D status entries', () => {
    const diff = `M\tsrc/main.js
A\tsrc/dino.js
D\tsrc/legacy.js`;
    expect(parseDiffFiles(diff)).toEqual(['src/dino.js', 'src/legacy.js', 'src/main.js']);
  });

  it('captures both old and new paths for renames', () => {
    const diff = 'R100\tsrc/old.js\tsrc/new.js';
    expect(parseDiffFiles(diff)).toEqual(['src/new.js', 'src/old.js']);
  });

  it('returns [] for empty / non-string input', () => {
    expect(parseDiffFiles('')).toEqual([]);
    expect(parseDiffFiles(null)).toEqual([]);
    expect(parseDiffFiles(undefined)).toEqual([]);
  });

  it('tolerates name-only diffs (no status column)', () => {
    expect(parseDiffFiles('src/foo.js\nsrc/bar.js')).toEqual(['src/bar.js', 'src/foo.js']);
  });
});

describe('detectScopeViolations — touchPoints', () => {
  it('flags files modified outside touchPoints', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/main.js', 'src/obstacle.js'],
      touchPoints: ['src/main.js'],
    });
    expect(r.touchPointsViolations).toEqual([{ file: 'src/obstacle.js' }]);
    expect(r.skipped.touchPointsCheck).toBe(false);
  });

  it('passes when all modified files are inside touchPoints', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/main.js'],
      touchPoints: ['src/main.js'],
    });
    expect(r.touchPointsViolations).toEqual([]);
  });

  it('respects glob touchPoints (src/components/**)', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/components/auth.tsx', 'src/components/sub/page.tsx', 'src/utils/helper.ts'],
      touchPoints: ['src/components/**'],
    });
    expect(r.touchPointsViolations).toEqual([{ file: 'src/utils/helper.ts' }]);
  });

  it('skips touchPoints check for <UNKNOWN> sentinel (legacy story)', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/main.js', 'src/obstacle.js'],
      touchPoints: ['<UNKNOWN>'],
    });
    expect(r.touchPointsViolations).toEqual([]);
    expect(r.skipped.touchPointsCheck).toBe(true);
    expect(r.skipped.reason).toMatch(/UNKNOWN/);
  });

  it('skips touchPoints check for <EPIC_WIDE> sentinel', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/main.js', 'src/utils/auth.ts'],
      touchPoints: ['<EPIC_WIDE>'],
    });
    expect(r.touchPointsViolations).toEqual([]);
    expect(r.skipped.touchPointsCheck).toBe(true);
    expect(r.skipped.reason).toMatch(/EPIC_WIDE/);
  });

  it('skips touchPoints check when array is empty/missing', () => {
    const r = detectScopeViolations({ modifiedFiles: ['src/main.js'], touchPoints: [] });
    expect(r.skipped.touchPointsCheck).toBe(true);
  });
});

describe('detectScopeViolations — forbiddenAreas', () => {
  it('always flags files matching forbiddenAreas, regardless of touchPoints', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/main.js', 'src/utils/auth.ts'],
      touchPoints: ['src/**'],
      forbiddenAreas: ['src/utils/auth.ts'],
    });
    expect(r.forbiddenViolations).toEqual([
      { file: 'src/utils/auth.ts', area: 'src/utils/auth.ts' },
    ]);
  });

  it('forbiddenAreas applies even when touchPoints is <EPIC_WIDE>', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/utils/auth.ts'],
      touchPoints: ['<EPIC_WIDE>'],
      forbiddenAreas: ['src/utils/auth.ts'],
    });
    // touchPoints check skipped
    expect(r.skipped.touchPointsCheck).toBe(true);
    // forbidden check still fires
    expect(r.forbiddenViolations).toHaveLength(1);
  });

  it('respects glob forbiddenAreas (src/utils/**)', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/utils/auth.ts', 'src/utils/sub/db.ts', 'src/main.js'],
      touchPoints: ['src/**'],
      forbiddenAreas: ['src/utils/**'],
    });
    expect(r.forbiddenViolations.map((v) => v.file)).toEqual([
      'src/utils/auth.ts',
      'src/utils/sub/db.ts',
    ]);
  });

  it('only counts each violation once even if multiple areas match', () => {
    const r = detectScopeViolations({
      modifiedFiles: ['src/utils/auth.ts'],
      forbiddenAreas: ['src/utils/auth.ts', 'src/utils/**', 'src/**'],
    });
    expect(r.forbiddenViolations).toHaveLength(1);
  });
});

describe('renderScopeViolationsAsCriteria', () => {
  it('emits one fail line per touchPoints violation', () => {
    const report = detectScopeViolations({
      modifiedFiles: ['src/main.js', 'src/obstacle.js'],
      touchPoints: ['src/main.js'],
    });
    const lines = renderScopeViolationsAsCriteria(report, { touchPoints: ['src/main.js'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^scope-touchpoints-1: fail — modified src\/obstacle\.js/);
    expect(lines[0]).toContain('not in touchPoints: src/main.js');
  });

  it('emits one fail line per forbidden violation, with the matching area', () => {
    const report = detectScopeViolations({
      modifiedFiles: ['src/utils/auth.ts'],
      touchPoints: ['src/**'],
      forbiddenAreas: ['src/utils/auth.ts'],
    });
    const lines = renderScopeViolationsAsCriteria(report, {
      touchPoints: ['src/**'],
      forbiddenAreas: ['src/utils/auth.ts'],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^scope-forbidden-1: fail — modified src\/utils\/auth\.ts/);
    expect(lines[0]).toContain('matches forbiddenArea: src/utils/auth.ts');
  });

  it('returns [] when there are no violations', () => {
    const report = detectScopeViolations({
      modifiedFiles: ['src/main.js'],
      touchPoints: ['src/main.js'],
    });
    expect(renderScopeViolationsAsCriteria(report, {})).toEqual([]);
  });
});
