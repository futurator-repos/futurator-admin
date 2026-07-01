#!/usr/bin/env node
// git-analyze.mjs — Refactoring Scan Engine v2, the Git & Evolution detector.
//
// Deterministic, ~0 LLM. Reads the repo's own .git via child_process git commands to
// recover the TIME axis the rest of the scan is blind to: change frequency (churn),
// temporal coupling (files that keep changing together), branch/commit hygiene, and
// authorship spread (bus-factor). For a migration/refactor target these are the
// highest-signal, cheapest facts we have — a high-churn × single-author file is the
// riskiest thing to touch, and coupling reveals de-facto modules the static graph
// can't see.
//
// PURE parse functions (parseBranches / parseCommits / parseChurn / parseShortlog /
// buildGitReport) are separated from the thin git runner so they're unit-testable
// with fixture strings. Handles a non-git dir (isRepo:false) and a SHALLOW clone
// (shallow:true, degraded churn/coupling) gracefully. Git is invoked with
// `-c safe.directory=*` to dodge dubious-ownership refusals. Author emails are NEVER
// leaked — authorship is aggregated to NAMES + counts only.
//
// USAGE: node git-analyze.mjs <repo> [--out file]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const SEP = '\x1f'; // field sep inside a line
const REC = '\x01'; // commit-header marker (churn stream)

// share of subjects matching Conventional Commits
const CONVENTIONAL_RE = /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style)(\(.+\))?!?:/;

const finding = (o) => ({
  id: o.id,
  dimension: o.dimension || 'code-quality-refactoring',
  area: 'git',
  severity: o.severity || 'Low',
  effort: o.effort || 'Small',
  location: o.location || '.git:1',
  issue: o.issue,
  suggestion: o.suggestion,
  evidence: { git: true, check: o.check, ...(o.evidence || {}) },
  source: 'deterministic',
  dependsOn: [],
});

// ── pure parsers ────────────────────────────────────────────────────────────

/**
 * @param raw `git for-each-ref` lines: `%(HEAD)\x1f%(refname:short)\x1f%(committerdate:iso8601-strict)`
 * @returns { total, stale, current } — stale = last commit older than staleDays.
 */
export function parseBranches(raw, { nowMs = Date.now(), staleDays = 90 } = {}) {
  const cutoff = nowMs - staleDays * DAY;
  let total = 0;
  let stale = 0;
  let current = '';
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const [head, name, date] = line.split(SEP);
    if (!name) continue;
    total++;
    if (head === '*') current = name;
    const t = Date.parse(date || '');
    if (!Number.isNaN(t) && t < cutoff) stale++;
  }
  return { total, stale, current };
}

/**
 * @param raw `git log` lines: `%ct\x1f%s` (one per commit).
 * @returns { total, last30d, conventionalPct }
 */
export function parseCommits(raw, { nowMs = Date.now() } = {}) {
  const cutoff = nowMs - 30 * DAY;
  let total = 0;
  let last30d = 0;
  let conventional = 0;
  for (const line of String(raw || '').split('\n')) {
    if (!line) continue;
    const i = line.indexOf(SEP);
    if (i < 0) continue;
    const ts = parseInt(line.slice(0, i), 10);
    const subject = line.slice(i + 1);
    total++;
    if (!Number.isNaN(ts) && ts * 1000 >= cutoff) last30d++;
    if (CONVENTIONAL_RE.test(subject)) conventional++;
  }
  const conventionalPct = total ? Math.round((conventional / total) * 100) : 0;
  return { total, last30d, conventionalPct };
}

/**
 * @param raw `git log --name-only` stream: a header line `\x01%H\x1f%an` per commit,
 *   then the file paths it touched, blank-line separated.
 * @returns churn frequency per file, hot files, temporal-coupling pairs, per-file
 *   authorship (→ singleAuthorFiles), and average commit size in files.
 */
export function parseChurn(raw, { topN = 25, maxPairFiles = 40 } = {}) {
  const churnByFile = {};
  const fileAuthors = {}; // file -> Set(author)
  const pairs = new Map(); // "a\0b" -> together count
  let commitCount = 0;
  let totalTouches = 0;
  let curAuthor = '';
  let curFiles = null; // Set

  const flush = () => {
    if (!curFiles) return;
    const files = [...curFiles];
    totalTouches += files.length;
    for (const f of files) {
      churnByFile[f] = (churnByFile[f] || 0) + 1;
      (fileAuthors[f] ||= new Set()).add(curAuthor);
    }
    // co-change pairs (cap per-commit fan-out so a mega-commit can't blow up O(n²))
    const cap = files.slice(0, maxPairFiles);
    for (let i = 0; i < cap.length; i++) {
      for (let j = i + 1; j < cap.length; j++) {
        const a = cap[i];
        const b = cap[j];
        const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  };

  for (const line of String(raw || '').split('\n')) {
    if (line.startsWith(REC)) {
      flush();
      commitCount++;
      curAuthor = line.slice(1).split(SEP)[1] || '';
      curFiles = new Set();
    } else if (line.trim() && curFiles) {
      curFiles.add(line.trim());
    }
  }
  flush();

  const hotFiles = Object.entries(churnByFile)
    .map(([file, churn]) => ({ file, churn }))
    .sort((a, b) => b.churn - a.churn || a.file.localeCompare(b.file))
    .slice(0, topN);

  const temporalCoupling = [...pairs.entries()]
    .map(([key, together]) => {
      const [a, b] = key.split('\0');
      const denom = Math.min(churnByFile[a] || 1, churnByFile[b] || 1);
      return { a, b, together, confidence: denom ? Math.round((together / denom) * 100) / 100 : 0 };
    })
    .filter((p) => p.together >= 2)
    .sort((x, y) => y.together - x.together || y.confidence - x.confidence || `${x.a}${x.b}`.localeCompare(`${y.a}${y.b}`))
    .slice(0, topN);

  const singleAuthorFiles = Object.values(fileAuthors).filter((s) => s.size === 1).length;
  const totalFiles = Object.keys(churnByFile).length;
  const avgSizeFiles = commitCount ? Math.round((totalTouches / commitCount) * 10) / 10 : 0;

  return { churnByFile, hotFiles, temporalCoupling, singleAuthorFiles, totalFiles, avgSizeFiles, commitCount };
}

/**
 * @param raw `git shortlog -sne` lines: `  <count>\t<Name> <email>`.
 * @returns { topAuthors:[{name,pct}], authorCount, totalCommits } — NAMES ONLY.
 */
export function parseShortlog(raw) {
  const authors = new Map();
  let total = 0;
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\t(.+?)(?:\s*<[^>]*>)?\s*$/);
    if (!m) continue;
    const count = parseInt(m[1], 10);
    const name = m[2].trim();
    if (!name) continue;
    total += count;
    authors.set(name, (authors.get(name) || 0) + count);
  }
  const topAuthors = [...authors.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ name, pct: total ? Math.round((count / total) * 100) : 0 }));
  return { topAuthors, authorCount: authors.size, totalCommits: total };
}

/**
 * Pure report builder over raw git output strings. `raw` = {
 *   isRepo, shallow, forEachRefRaw, commitsRaw, churnRaw, shortlogRaw, tagsRaw,
 *   revListCount, currentBranch }. Returns the C-GIT GitEvolution shape + findings.
 */
export function buildGitReport(raw = {}, opts = {}) {
  const {
    nowMs = Date.now(),
    staleDays = 90,
    staleBranchThreshold = 5,
    conventionalMin = 50,
    topN = 25,
  } = opts;

  if (!raw.isRepo) {
    return {
      isRepo: false,
      shallow: false,
      branches: { total: 0, stale: 0, current: '' },
      commits: { total: 0, last30d: 0, avgSizeFiles: 0, conventionalPct: 0 },
      tags: 0,
      churnByFile: {},
      hotFiles: [],
      temporalCoupling: [],
      busFactor: { singleAuthorFiles: 0, topAuthors: [] },
      summary: 'not a git repository — no history/provenance signal',
      findings: [
        finding({
          id: 'git:not-a-repo', check: 'not-a-repo', severity: 'Low', effort: 'Trivial',
          dimension: 'code-quality-refactoring', location: '.:1',
          issue: 'Not a git repository — no version history or provenance signal',
          suggestion: 'Initialize git (git init) and commit regularly so churn, authorship, and evolution can inform refactoring',
        }),
      ],
    };
  }

  const shallow = !!raw.shallow;
  const branches = parseBranches(raw.forEachRefRaw, { nowMs, staleDays });
  if (raw.currentBranch && raw.currentBranch !== 'HEAD') branches.current = raw.currentBranch;
  const cm = parseCommits(raw.commitsRaw, { nowMs });
  const churn = parseChurn(raw.churnRaw, { topN });
  const sl = parseShortlog(raw.shortlogRaw);
  const tags = String(raw.tagsRaw || '').split('\n').filter((l) => l.trim()).length;
  const total = raw.revListCount || cm.total;

  const commits = { total, last30d: cm.last30d, avgSizeFiles: churn.avgSizeFiles, conventionalPct: cm.conventionalPct };
  const busFactor = { singleAuthorFiles: churn.singleAuthorFiles, topAuthors: sl.topAuthors };

  // ── findings (gentle) ──
  const findings = [];
  if (branches.stale >= staleBranchThreshold) {
    findings.push(finding({
      id: 'git:stale-branches', check: 'stale-branches', severity: 'Low', effort: 'Trivial',
      issue: `${branches.stale} stale branches (no commits in ${staleDays}+ days)`,
      suggestion: 'Prune merged/abandoned branches so the branch list reflects active work, not history',
      evidence: { stale: branches.stale, total: branches.total },
    }));
  }
  if (total >= 20 && cm.conventionalPct < conventionalMin) {
    findings.push(finding({
      id: 'git:low-conventional', check: 'low-conventional', severity: 'Low', effort: 'Small',
      issue: `Only ${cm.conventionalPct}% of commits follow Conventional Commits`,
      suggestion: 'Adopt Conventional Commit messages (feat/fix/chore…) so history, changelogs, and release automation are machine-readable',
      evidence: { conventionalPct: cm.conventionalPct, total },
    }));
  }
  if (churn.totalFiles >= 10) {
    const ratio = churn.singleAuthorFiles / churn.totalFiles;
    if (ratio >= 0.5) {
      findings.push(finding({
        id: 'git:bus-factor', check: 'bus-factor', severity: 'Low–Med', effort: 'Medium', dimension: 'architecture',
        issue: `${Math.round(ratio * 100)}% of files have a single author (bus-factor risk)`,
        suggestion: 'Spread ownership via pairing/review; single-author modules are the riskiest to refactor and the easiest to lose',
        evidence: { singleAuthorFiles: churn.singleAuthorFiles, totalFiles: churn.totalFiles, ratio: Math.round(ratio * 100) / 100 },
      }));
    }
  }
  if (churn.hotFiles.length && churn.hotFiles[0].churn >= 10) {
    const top = churn.hotFiles.slice(0, 3);
    findings.push(finding({
      id: 'git:churn-hotspots', check: 'churn-hotspots', severity: 'Low–Med', effort: 'Medium', dimension: 'code-quality-refactoring',
      location: `${top[0].file}:1`,
      issue: `High-churn hotspots: ${top.map((h) => `${h.file} (${h.churn})`).join(', ')}`,
      suggestion: 'High-churn files are change magnets — prioritize them for refactoring, added tests, and clearer boundaries',
      evidence: { hotFiles: top },
    }));
  }
  if (shallow) {
    findings.push(finding({
      id: 'git:shallow-clone', check: 'shallow-clone', severity: 'Low', effort: 'Trivial',
      issue: 'Shallow clone — history is truncated, so churn/coupling/bus-factor are partial',
      suggestion: 'Fetch full history (git fetch --unshallow) before relying on evolution metrics',
      evidence: { shallow: true },
    }));
  }

  const parts = [
    `${total} commits`,
    `${branches.total} branches (${branches.stale} stale)`,
    `${tags} tags`,
    `conventional ${cm.conventionalPct}%`,
  ];
  if (churn.hotFiles[0]) parts.push(`top churn ${churn.hotFiles[0].file} (${churn.hotFiles[0].churn})`);
  if (shallow) parts.push('shallow');
  const summary = parts.join(' · ');

  return {
    isRepo: true,
    shallow,
    branches,
    commits,
    tags,
    churnByFile: churn.churnByFile,
    hotFiles: churn.hotFiles,
    temporalCoupling: churn.temporalCoupling,
    busFactor,
    summary,
    findings,
  };
}

// ── thin git runner ──────────────────────────────────────────────────────────

function runGit(cwd, args) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    encoding: 'utf8',
    input: '', // never block on stdin (shortlog reads it when no rev given)
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}

/** Collect all raw git output for a repo dir (or {isRepo:false} if not a repo). */
export function collectGitRaw(cwd) {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false };
  const shallow = runGit(cwd, ['rev-parse', '--is-shallow-repository']).out.trim() === 'true';
  return {
    isRepo: true,
    shallow,
    currentBranch: runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim(),
    forEachRefRaw: runGit(cwd, ['for-each-ref', `--format=%(HEAD)${SEP}%(refname:short)${SEP}%(committerdate:iso8601-strict)`, 'refs/heads']).out,
    commitsRaw: runGit(cwd, ['log', '--no-merges', `--format=%ct${SEP}%s`]).out,
    churnRaw: runGit(cwd, ['log', '--no-merges', '--name-only', `--format=${REC}%H${SEP}%an`]).out,
    shortlogRaw: runGit(cwd, ['shortlog', '-sne', 'HEAD']).out,
    tagsRaw: runGit(cwd, ['tag', '-l']).out,
    revListCount: parseInt(runGit(cwd, ['rev-list', '--count', 'HEAD']).out.trim(), 10) || 0,
  };
}

/** Analyze a repo dir end-to-end (runner + pure builder). */
export function analyzeGit(cwd, opts = {}) {
  return buildGitReport(collectGitRaw(cwd), opts);
}

// ── CLI ──
function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'git-evolution.json');
  const report = analyzeGit(repo);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...report }, null, 2));
  if (!report.isRepo) {
    console.error(`[git-analyze] not a git repository → ${out}`);
  } else {
    const c = report.commits;
    console.error(`[git-analyze] ${report.summary} | files:${Object.keys(report.churnByFile).length} coupled-pairs:${report.temporalCoupling.length} single-author:${report.busFactor.singleAuthorFiles} avg-size:${c.avgSizeFiles}${report.shallow ? ' (shallow)' : ''} → ${out}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
