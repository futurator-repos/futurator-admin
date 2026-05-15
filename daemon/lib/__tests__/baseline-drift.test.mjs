/**
 * baseline-drift.test.mjs — Pipeline v2 Phase 2-A / Story 2-A-4-4 (PR-92).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ACCEPT_LABEL,
  isLabelAccepted,
  decideBaselineRegression,
  rollBaselineForward,
  readBaselinePassing,
  readAfterPassing,
  diffBaseline,
} from '../baseline-drift.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baseline-drift-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isLabelAccepted', () => {
  it('detects label as gh-api object', () => {
    expect(isLabelAccepted([{ name: ACCEPT_LABEL }])).toBe(true);
    expect(isLabelAccepted([{ name: 'unrelated' }, { name: ACCEPT_LABEL }])).toBe(true);
  });

  it('detects label as plain string', () => {
    expect(isLabelAccepted([ACCEPT_LABEL])).toBe(true);
  });

  it('returns false on absence', () => {
    expect(isLabelAccepted([])).toBe(false);
    expect(isLabelAccepted([{ name: 'other' }])).toBe(false);
    expect(isLabelAccepted(null)).toBe(false);
    expect(isLabelAccepted(undefined)).toBe(false);
  });

  it('exports the canonical label string', () => {
    expect(ACCEPT_LABEL).toBe('futurator:accept-baseline-drift');
  });
});

describe('decideBaselineRegression', () => {
  it('prototype always warns', () => {
    const d = decideBaselineRegression({ rigor: 'prototype' });
    expect(d.disposition).toBe('warn');
  });

  it('production requires PR label', () => {
    expect(decideBaselineRegression({ rigor: 'production' }).disposition).toBe('block');
    expect(decideBaselineRegression({ rigor: 'production', labels: [ACCEPT_LABEL] }).disposition).toBe(
      'proceed-accepted',
    );
  });

  it('mvp requires operator-confirmed decision card', () => {
    expect(decideBaselineRegression({ rigor: 'mvp' }).disposition).toBe('block');
    expect(decideBaselineRegression({ rigor: 'mvp', operatorConfirmed: true }).disposition).toBe(
      'proceed-accepted',
    );
  });

  it('mvp ignores PR label (label path is production-only)', () => {
    expect(
      decideBaselineRegression({ rigor: 'mvp', labels: [ACCEPT_LABEL] }).disposition,
    ).toBe('block');
  });
});

describe('rollBaselineForward', () => {
  it('renames after-passing.txt to baseline-passing.txt', () => {
    mkdirSync(join(tmp, '.pipeline'), { recursive: true });
    writeFileSync(join(tmp, '.pipeline', 'after-passing.txt'), 'test1\ntest2\n');
    const result = rollBaselineForward(tmp);
    expect(result.rolled).toBe(true);
    expect(existsSync(join(tmp, '.pipeline', 'baseline-passing.txt'))).toBe(true);
    expect(existsSync(join(tmp, '.pipeline', 'after-passing.txt'))).toBe(false);
  });

  it('no-ops when after-passing.txt missing', () => {
    const result = rollBaselineForward(tmp);
    expect(result.rolled).toBe(false);
  });

  it('overwrites existing baseline', () => {
    mkdirSync(join(tmp, '.pipeline'), { recursive: true });
    writeFileSync(join(tmp, '.pipeline', 'baseline-passing.txt'), 'old1\nold2\n');
    writeFileSync(join(tmp, '.pipeline', 'after-passing.txt'), 'new1\nnew2\nnew3\n');
    rollBaselineForward(tmp);
    expect(readFileSync(join(tmp, '.pipeline', 'baseline-passing.txt'), 'utf-8')).toBe(
      'new1\nnew2\nnew3\n',
    );
  });
});

describe('readBaselinePassing / readAfterPassing', () => {
  it('returns empty array when file missing', () => {
    expect(readBaselinePassing(tmp)).toEqual([]);
    expect(readAfterPassing(tmp)).toEqual([]);
  });

  it('parses one-test-per-line + skips blank lines', () => {
    mkdirSync(join(tmp, '.pipeline'), { recursive: true });
    writeFileSync(join(tmp, '.pipeline', 'baseline-passing.txt'), 'test1\n\ntest2\n  \n');
    expect(readBaselinePassing(tmp)).toEqual(['test1', 'test2']);
  });
});

describe('diffBaseline', () => {
  it('reports added + removed tests sorted', () => {
    mkdirSync(join(tmp, '.pipeline'), { recursive: true });
    writeFileSync(join(tmp, '.pipeline', 'baseline-passing.txt'), 'a\nb\nc\n');
    writeFileSync(join(tmp, '.pipeline', 'after-passing.txt'), 'b\nd\ne\n');
    const { added, removed } = diffBaseline(tmp);
    expect(added).toEqual(['d', 'e']);
    expect(removed).toEqual(['a', 'c']);
  });

  it('handles missing files (treats as empty)', () => {
    const result = diffBaseline(tmp);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('handles all-added case (first wave)', () => {
    mkdirSync(join(tmp, '.pipeline'), { recursive: true });
    writeFileSync(join(tmp, '.pipeline', 'after-passing.txt'), 'a\nb\n');
    const result = diffBaseline(tmp);
    expect(result.added).toEqual(['a', 'b']);
    expect(result.removed).toEqual([]);
  });
});
