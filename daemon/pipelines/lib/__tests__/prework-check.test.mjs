import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  collectRecentTouchPointWork,
  detectNoChangesRequired,
  renderRecentWorkBlock,
} from '../prework-check.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'prework-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), '// initial\n', 'utf8');
  writeFileSync(join(dir, 'src', 'dino.js'), 'export class Dino {}\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# Project\n', 'utf8');
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  execSync('git -c user.email=a@b.c -c user.name=A add -A', { cwd: dir, stdio: 'ignore' });
  // Backdate the init commit so tests that pass `sinceTime: planStart` (a
  // recent ISO) can scope the lookback past it. Without this the init
  // commit's "now" timestamp would always be inside the test window.
  const initTime = '2020-01-01T00:00:00Z';
  execSync(
    `GIT_AUTHOR_DATE='${initTime}' GIT_COMMITTER_DATE='${initTime}' git -c user.email=a@b.c -c user.name=A commit -q -m "init"`,
    { cwd: dir, stdio: 'ignore', shell: '/bin/bash' },
  );
  return dir;
}

/** ISO that's after the init commit but before any test-added commits. */
const PLAN_START = '2025-01-01T00:00:00Z';

function commit(dir, files, message) {
  for (const [path, body] of Object.entries(files)) {
    writeFileSync(join(dir, path), body, 'utf8');
  }
  execSync('git -c user.email=a@b.c -c user.name=A add -A', { cwd: dir, stdio: 'ignore' });
  execSync(
    `git -c user.email=a@b.c -c user.name=A commit -q -m ${JSON.stringify(message)}`,
    { cwd: dir, stdio: 'ignore' },
  );
  return execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

describe('collectRecentTouchPointWork', () => {
  let dir;

  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns matching commits when touchPoints intersect recent changes', () => {
    const sha = commit(dir, { 'src/main.js': '// updated\n' }, 'tweak main');
    const r = collectRecentTouchPointWork({
      projectDir: dir,
      touchPoints: ['src/main.js'],
      sinceTime: PLAN_START,
    });
    expect(r.skipped).toBe(false);
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].sha.startsWith(sha) || sha.startsWith(r.commits[0].sha)).toBe(true);
    expect(r.commits[0].files).toEqual(['src/main.js']);
  });

  it("returns empty commits when recent commits did NOT touch this story's touchPoints", () => {
    commit(dir, { 'README.md': '# Project (updated)\n' }, 'docs');
    const r = collectRecentTouchPointWork({
      projectDir: dir,
      touchPoints: ['src/main.js'],
      sinceTime: PLAN_START,
    });
    expect(r.skipped).toBe(false);
    expect(r.commits).toEqual([]);
  });

  it('respects glob touchPoints (src/**)', () => {
    commit(dir, { 'src/dino.js': 'export class Dino { jump() {} }\n' }, 'add jump');
    const r = collectRecentTouchPointWork({
      projectDir: dir,
      touchPoints: ['src/**'],
      sinceTime: PLAN_START,
    });
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].files).toEqual(['src/dino.js']);
  });

  it('skips when projectDir is missing', () => {
    const r = collectRecentTouchPointWork({ touchPoints: ['src/main.js'] });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/projectDir/);
  });

  it('skips when touchPoints is empty', () => {
    const r = collectRecentTouchPointWork({ projectDir: dir, touchPoints: [] });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/no touchPoints/);
  });

  it('skips for <UNKNOWN> sentinel', () => {
    const r = collectRecentTouchPointWork({ projectDir: dir, touchPoints: ['<UNKNOWN>'] });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/sentinel/);
  });

  it('skips for <EPIC_WIDE> sentinel', () => {
    const r = collectRecentTouchPointWork({ projectDir: dir, touchPoints: ['<EPIC_WIDE>'] });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/sentinel/);
  });

  it('returns skipped+reason when git command fails (e.g. not a repo)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'no-git-'));
    const r = collectRecentTouchPointWork({
      projectDir: tmp,
      touchPoints: ['src/main.js'],
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/git log failed/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('honours --since when sinceTime is provided', () => {
    const past = commit(dir, { 'src/main.js': '// past\n' }, 'past edit');
    // Sleep is not available in unit tests; instead use a future ISO that
    // excludes the prior commit.
    const r = collectRecentTouchPointWork({
      projectDir: dir,
      touchPoints: ['src/main.js'],
      sinceTime: '2099-01-01T00:00:00Z',
    });
    expect(r.skipped).toBe(false);
    expect(r.commits).toEqual([]);
    // Sanity: without sinceTime, the past commit IS captured.
    const r2 = collectRecentTouchPointWork({
      projectDir: dir,
      touchPoints: ['src/main.js'],
    });
    expect(r2.commits.some((c) => past.startsWith(c.sha) || c.sha.startsWith(past))).toBe(true);
  });
});

describe('detectNoChangesRequired', () => {
  it('detects the canonical sentinel + cited shas', () => {
    const summary = `---WORK_SUMMARY---
No changes required — AC already satisfied by abc1234, def5678
The integration tests pass against the existing implementation.
---END_WORK_SUMMARY---`;
    const r = detectNoChangesRequired(summary);
    expect(r.noChangesRequired).toBe(true);
    expect(r.citedShas.sort()).toEqual(['abc1234', 'def5678']);
  });

  it('tolerates markdown bold + colon styling', () => {
    const summary = `**No changes required:** AC already satisfied by [aaa1111][bbb2222]`;
    const r = detectNoChangesRequired(summary);
    expect(r.noChangesRequired).toBe(true);
    expect(r.citedShas.sort()).toEqual(['aaa1111', 'bbb2222']);
  });

  it('returns false when sentinel is absent', () => {
    const r = detectNoChangesRequired('Implemented the feature in src/main.js.');
    expect(r.noChangesRequired).toBe(false);
    expect(r.citedShas).toEqual([]);
  });

  it('returns false on empty / non-string input', () => {
    expect(detectNoChangesRequired('').noChangesRequired).toBe(false);
    expect(detectNoChangesRequired(null).noChangesRequired).toBe(false);
    expect(detectNoChangesRequired(undefined).noChangesRequired).toBe(false);
  });

  it('only collects shas from the sentinel paragraph (no false positives elsewhere)', () => {
    const summary = `Implemented foo. Reviewed in commit deadbeef.

No changes required for AC-3 — already satisfied by 1234abc.`;
    const r = detectNoChangesRequired(summary);
    expect(r.noChangesRequired).toBe(true);
    // Picked from the sentinel paragraph only — `deadbeef` is from an earlier
    // unrelated paragraph and must not leak in.
    expect(r.citedShas).toEqual(['1234abc']);
    expect(r.citedShas).not.toContain('deadbeef');
  });

  it('deduplicates when the same sha appears multiple times', () => {
    const summary = 'No changes required — AC already satisfied by abc1234 and abc1234.';
    expect(detectNoChangesRequired(summary).citedShas).toEqual(['abc1234']);
  });
});

describe('renderRecentWorkBlock', () => {
  it('emits a deterministic block when commits are present', () => {
    const block = renderRecentWorkBlock({
      skipped: false,
      commits: [
        { sha: 'abc1234', subject: 'tweak main', files: ['src/main.js'] },
        { sha: 'def5678', subject: 'add helper', files: ['src/helper.js'] },
      ],
    });
    expect(block).toContain('### abc1234 — tweak main');
    expect(block).toContain('- src/main.js');
    expect(block).toContain('### def5678 — add helper');
    expect(block).toContain('- src/helper.js');
  });

  it('returns empty string when skipped or no commits', () => {
    expect(renderRecentWorkBlock({ skipped: true })).toBe('');
    expect(renderRecentWorkBlock({ skipped: false, commits: [] })).toBe('');
    expect(renderRecentWorkBlock(null)).toBe('');
  });
});
