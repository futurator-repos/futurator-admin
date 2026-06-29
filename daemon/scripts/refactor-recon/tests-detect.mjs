#!/usr/bin/env node
// tests-detect.mjs — Refactoring Scan Engine v2, TDD-maturity detector.
//
// Deterministic, ~0 LLM, always runnable (pure file-walk). Counts test files vs
// source files + detects the test runner, so the Maturity Scorecard can report
// whether the codebase is test-mature. Emits tests.json.
//
// USAGE: node tests-detect.mjs <repo> [--src src] [--out file]

import fs from 'node:fs';
import path from 'node:path';

const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage']);
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;
const isTestPath = (rel) => TEST_RE.test(rel) || /(^|\/)(__tests__|__mocks__|e2e|tests?)\//.test(rel);

/** Analyze a flat list of relative file paths → test/source counts. Pure. */
export function analyzeTests(relFiles, { runner = null } = {}) {
  let testFiles = 0;
  let sourceFiles = 0;
  for (const rel of relFiles) {
    if (!SRC_EXTS.has(path.extname(rel))) continue;
    if (rel.endsWith('.d.ts')) continue;
    if (isTestPath(rel)) testFiles++;
    else sourceFiles++;
  }
  const ratio = sourceFiles ? testFiles / sourceFiles : 0;
  return { testFiles, sourceFiles, ratio, runner, hasTests: testFiles > 0 };
}

function walk(dir, root, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, acc);
    else acc.push(path.relative(root, full));
  }
  return acc;
}

/** Detect the test runner from config files / package.json. Pure-ish (reads fs). */
export function detectRunner(repo) {
  const has = (f) => fs.existsSync(path.join(repo, f));
  if (has('vitest.config.ts') || has('vitest.config.js') || has('vitest.config.mjs')) return 'vitest';
  if (has('jest.config.ts') || has('jest.config.js') || has('jest.config.json')) return 'jest';
  if (has('playwright.config.ts') || has('playwright.config.js')) return 'playwright';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const dev = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
    if (dev.vitest) return 'vitest';
    if (dev.jest) return 'jest';
    if (dev['@playwright/test']) return 'playwright';
    if (pkg.scripts?.test) return 'test-script';
  } catch {
    /* ignore */
  }
  return null;
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'tests.json');
  const files = walk(repo, repo);
  const res = analyzeTests(files, { runner: detectRunner(repo) });
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...res }, null, 2));
  console.error(`[tests-detect] ${res.testFiles} test / ${res.sourceFiles} source (${Math.round(res.ratio * 100)}%) · runner ${res.runner || 'none'} → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
