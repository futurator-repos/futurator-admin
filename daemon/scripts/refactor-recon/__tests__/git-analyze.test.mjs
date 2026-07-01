/**
 * git-analyze.test.mjs — Git & Evolution detector. Exercises the PURE parsers with
 * fixture strings (no real .git) + the buildGitReport assembler, and asserts the
 * hard privacy invariant: author EMAILS are never leaked into the report.
 */

import { describe, it, expect } from 'vitest';
import {
  parseBranches,
  parseCommits,
  parseChurn,
  parseShortlog,
  buildGitReport,
} from '../git-analyze.mjs';

const SEP = '\x1f';
const REC = '\x01';
const NOW = Date.parse('2026-07-01T00:00:00Z');
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

describe('parseBranches', () => {
  it('counts total, marks stale (>staleDays), reads current from the HEAD marker', () => {
    const raw = [
      `*${SEP}main${SEP}2026-06-30T12:00:00+00:00`,
      `${SEP}feat/old${SEP}2026-01-01T00:00:00+00:00`, // > 90d stale
      `${SEP}feat/recent${SEP}2026-06-20T00:00:00+00:00`,
      ``, // blank line ignored
    ].join('\n');
    const r = parseBranches(raw, { nowMs: NOW, staleDays: 90 });
    expect(r.total).toBe(3);
    expect(r.stale).toBe(1);
    expect(r.current).toBe('main');
  });

  it('empty input → zeros', () => {
    expect(parseBranches('', { nowMs: NOW })).toEqual({ total: 0, stale: 0, current: '' });
  });
});

describe('parseCommits', () => {
  it('computes total, last30d, and conventionalPct', () => {
    const raw = [
      `${sec('2026-06-25T00:00:00Z')}${SEP}feat: add x`, // recent + conventional
      `${sec('2026-06-20T00:00:00Z')}${SEP}update stuff`, // recent, not conventional
      `${sec('2026-01-01T00:00:00Z')}${SEP}chore: cleanup`, // old + conventional
    ].join('\n');
    const r = parseCommits(raw, { nowMs: NOW });
    expect(r.total).toBe(3);
    expect(r.last30d).toBe(2);
    expect(r.conventionalPct).toBe(67); // 2/3
  });

  it('matches scoped / breaking conventional subjects', () => {
    const raw = [
      `${sec('2026-06-25T00:00:00Z')}${SEP}fix(api): bug`,
      `${sec('2026-06-25T00:00:00Z')}${SEP}feat!: breaking`,
    ].join('\n');
    expect(parseCommits(raw, { nowMs: NOW }).conventionalPct).toBe(100);
  });
});

describe('parseChurn', () => {
  const raw = [
    `${REC}h1${SEP}Alice`,
    `src/a.ts`,
    `src/b.ts`,
    ``,
    `${REC}h2${SEP}Alice`,
    `src/a.ts`,
    `src/c.ts`,
    ``,
    `${REC}h3${SEP}Bob`,
    `src/a.ts`,
    `src/b.ts`,
  ].join('\n');

  it('builds churnByFile, hotFiles, avg commit size, single-author count', () => {
    const r = parseChurn(raw);
    expect(r.churnByFile).toEqual({ 'src/a.ts': 3, 'src/b.ts': 2, 'src/c.ts': 1 });
    expect(r.hotFiles[0]).toEqual({ file: 'src/a.ts', churn: 3 });
    expect(r.commitCount).toBe(3);
    expect(r.totalFiles).toBe(3);
    expect(r.avgSizeFiles).toBe(2); // 6 touches / 3 commits
    expect(r.singleAuthorFiles).toBe(1); // only src/c.ts (Alice only)
  });

  it('derives temporal coupling with confidence = together / min(churn)', () => {
    const r = parseChurn(raw);
    // a&b co-change in h1 + h3 → together 2; a&c only once → filtered (<2)
    expect(r.temporalCoupling).toEqual([
      { a: 'src/a.ts', b: 'src/b.ts', together: 2, confidence: 1 },
    ]);
  });

  it('excludes build artifacts / generated / vendor from churn + coupling', () => {
    const raw = [
      `${REC}h1${SEP}Alice`,
      `src/a.ts`,
      `.open-next/assets/BUILD_ID`,
      `.open-next/.build/open-next.config.mjs`,
      `node_modules/x/index.js`,
      `pnpm-lock.yaml`,
      `dist/bundle.min.js`,
      ``,
      `${REC}h2${SEP}Alice`,
      `src/a.ts`,
      `.open-next/assets/BUILD_ID`,
    ].join('\n');
    const r = parseChurn(raw);
    expect(r.churnByFile).toEqual({ 'src/a.ts': 2 }); // artifacts filtered out
    expect(Object.keys(r.churnByFile)).not.toContain('.open-next/assets/BUILD_ID');
    expect(r.temporalCoupling).toEqual([]); // no artifact co-change pairs
  });
});

describe('parseShortlog', () => {
  it('aggregates authors to names + pct, NEVER leaking emails', () => {
    const raw = [
      `    42\tAlice <alice@example.com>`,
      `    18\tBob <bob@corp.io>`,
    ].join('\n');
    const r = parseShortlog(raw);
    expect(r.totalCommits).toBe(60);
    expect(r.authorCount).toBe(2);
    expect(r.topAuthors).toEqual([
      { name: 'Alice', pct: 70 },
      { name: 'Bob', pct: 30 },
    ]);
    expect(JSON.stringify(r)).not.toContain('@');
    expect(JSON.stringify(r)).not.toContain('<');
  });
});

describe('buildGitReport', () => {
  it('non-git dir → isRepo:false + a single gentle finding', () => {
    const r = buildGitReport({ isRepo: false });
    expect(r.isRepo).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence.check).toBe('not-a-repo');
    expect(r.findings[0].dimension).toBe('code-quality-refactoring');
    expect(r.findings[0].source).toBe('deterministic');
  });

  it('assembles the full GitEvolution shape from raw strings (no emails leak)', () => {
    const raw = {
      isRepo: true,
      shallow: false,
      currentBranch: 'main',
      forEachRefRaw: [
        `*${SEP}main${SEP}2026-06-30T12:00:00+00:00`,
        `${SEP}feat/old${SEP}2026-01-01T00:00:00+00:00`,
      ].join('\n'),
      commitsRaw: [
        `${sec('2026-06-25T00:00:00Z')}${SEP}feat: add x`,
        `${sec('2026-06-20T00:00:00Z')}${SEP}update stuff`,
        `${sec('2026-01-01T00:00:00Z')}${SEP}chore: cleanup`,
      ].join('\n'),
      churnRaw: [
        `${REC}h1${SEP}Alice`, `src/a.ts`, `src/b.ts`, ``,
        `${REC}h2${SEP}Bob`, `src/a.ts`, `src/c.ts`,
      ].join('\n'),
      shortlogRaw: [`    5\tAlice <alice@example.com>`, `    1\tBob <bob@corp.io>`].join('\n'),
      tagsRaw: `v1.0.0\nv1.1.0\n`,
      revListCount: 42,
    };
    const r = buildGitReport(raw, { nowMs: NOW });
    expect(r.isRepo).toBe(true);
    expect(r.shallow).toBe(false);
    expect(r.branches).toEqual({ total: 2, stale: 1, current: 'main' });
    expect(r.commits.total).toBe(42); // from revListCount
    expect(r.commits.last30d).toBe(2);
    expect(r.commits.conventionalPct).toBe(67);
    expect(r.tags).toBe(2);
    expect(r.churnByFile['src/a.ts']).toBe(2);
    expect(r.busFactor.topAuthors[0]).toEqual({ name: 'Alice', pct: 83 });
    expect(typeof r.summary).toBe('string');
    expect(JSON.stringify(r)).not.toContain('@');
  });

  it('shallow clone → shallow:true + a degradation finding', () => {
    const r = buildGitReport({ isRepo: true, shallow: true, revListCount: 1 }, { nowMs: NOW });
    expect(r.shallow).toBe(true);
    expect(r.findings.some((f) => f.evidence.check === 'shallow-clone')).toBe(true);
  });
});
