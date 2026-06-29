#!/usr/bin/env node
// eslint-detect.mjs — Refactoring Scan Engine v2, eslint-health detector.
//
// Best-effort, deterministic (~0 LLM). Runs the repo's OWN eslint (so its config
// + plugins apply) and summarizes the result, weighting REAL code over tests over
// libs (per the operator's priority: a tests-linting problem matters less than a
// production-code one). Requires node_modules — the scan-engine npm-installs the
// clone first. If eslint isn't installed or has no config, reports runnable:false
// (the maturity axis then shows 'unmeasured' rather than a fake score).
//
// USAGE: node eslint-detect.mjs <repo> [--out file]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isTestPath = (p) => /\.(test|spec)\.[tj]sx?$/.test(p) || /(^|\/)(__tests__|__mocks__|e2e|tests?)\//.test(p);

/**
 * Pure summarizer over eslint's JSON output. Weighting: code errors full, test
 * errors ×0.3, warnings ×0.25 (and tests' warnings ×0.075) — so the score floats
 * on production-code lint health, not test/lib noise. node_modules excluded.
 */
export function summarizeEslint(results) {
  let errors = 0;
  let warnings = 0;
  let weighted = 0;
  let codeErrors = 0;
  let testErrors = 0;
  let fileCount = 0;
  for (const r of results || []) {
    const p = r.filePath || r.file || '';
    if (/node_modules/.test(p)) continue;
    const ec = r.errorCount || 0;
    const wc = r.warningCount || 0;
    if (ec === 0 && wc === 0) continue;
    fileCount++;
    errors += ec;
    warnings += wc;
    const codeW = isTestPath(p) ? 0.3 : 1;
    if (isTestPath(p)) testErrors += ec; else codeErrors += ec;
    weighted += codeW * ec + 0.25 * codeW * wc;
  }
  return { errors, warnings, codeErrors, testErrors, weighted: Math.round(weighted), filesWithIssues: fileCount, runnable: true };
}

function runEslint(repo) {
  return new Promise((resolve) => {
    // --no-install: only use the repo's local eslint (don't download). flat config
    // (eslint.config.*) needs no --ext; legacy configs default to .js — pass --ext
    // for TS coverage (ignored/erroring harmlessly under flat config is tolerated).
    const proc = spawn('npx', ['--no-install', 'eslint', '.', '-f', 'json', '--ext', '.ts,.tsx,.js,.jsx'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-1000); });
    proc.on('error', () => resolve({ runnable: false, reason: 'eslint-spawn-failed' }));
    proc.on('close', () => {
      // eslint exits 1 when lint problems exist — that's a SUCCESSFUL run. Only a
      // non-JSON stdout (config error / not installed) means not-runnable.
      const trimmed = out.trim();
      if (!trimmed.startsWith('[')) return resolve({ runnable: false, reason: (err || 'no-json-output').slice(0, 200) });
      try { resolve({ runnable: true, results: JSON.parse(trimmed) }); }
      catch { resolve({ runnable: false, reason: 'eslint-json-parse-failed' }); }
    });
  });
}

async function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'eslint.json');
  const run = await runEslint(repo);
  const summary = run.runnable ? summarizeEslint(run.results) : { runnable: false, reason: run.reason };
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...summary }, null, 2));
  console.error(`[eslint-detect] ${summary.runnable ? `${summary.errors} errors · ${summary.warnings} warnings · weighted ${summary.weighted}` : `not runnable (${summary.reason})`} → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
