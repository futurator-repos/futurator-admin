#!/usr/bin/env node
/**
 * Pipeline v2.0 PR-8f #3 — qa-execute smoke-test.
 *
 * Validates the qa-aggregate + qa-execute pipeline locally without
 * needing a full daemon + plan + dev round-trip. Catches the failure
 * classes the redesign's bash-heavy approach exposes:
 *
 *   • esbuild bundle resolves at the daemon path
 *   • node -e heredoc escape-quoting actually parses (the JSON.stringify
 *     output that gets inlined into the shell command must round-trip)
 *   • the classifier's bundle-side require returns the same shape as
 *     the in-process function
 *   • viewport parser rejects legacy WxH form (Q2.2)
 *   • rigor-floor logic produces L0 for prototype with multi-step flows
 *   • playwright + claude CLI are reachable from the parent shell
 *
 * Use:
 *   node scripts/qa-smoke-test.mjs               # local-only checks (always)
 *   node scripts/qa-smoke-test.mjs --with-cli    # also probes claude + playwright
 *
 * Exit code 0 = all green; non-zero = the printed phase failed and
 * shipping the QA stage to EC2 will likely break in the same way.
 *
 * What this DOES NOT cover:
 *   • A real plan with real visual-tests (operator workflow)
 *   • The contract approval API endpoint (use curl + a seeded plan for that)
 *   • The dashboard UI render path (frontend smoke; not in scope)
 *
 * Run this before every `scripts/rsync-daemon.sh` push of QA changes.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE_PATH = resolve(REPO_ROOT, 'daemon/lib/visual-test-classifier-bundle.cjs');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const PROBE_CLI = args.includes('--with-cli');

let failed = false;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ── Phase 1: bundle exists + requires + classifies ──────────────────

check('classifier bundle exists at daemon path', () => {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `bundle missing at ${BUNDLE_PATH}; run \`node scripts/build-daemon-bundles.mjs\` first`,
    );
  }
});

check('bundle exports the expected API', () => {
  const m = require(BUNDLE_PATH);
  for (const fn of [
    'classifyVisualTest',
    'aggregateVisualTests',
    'parseVisualTestViewport',
    'isVagueExpect',
    'formatViewport',
  ]) {
    if (typeof m[fn] !== 'function') {
      throw new Error(`bundle missing export: ${fn}`);
    }
  }
});

check('bundle classifies a multi-step flow as L2 in production rigor', () => {
  const m = require(BUNDLE_PATH);
  const r = m.classifyVisualTest(
    {
      id: 't',
      criteriaRef: 'AC-1',
      description: 'x',
      setup: '',
      expect: 'navigation completes after click and reaches the next page',
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#go' },
        { action: 'screenshot', label: 'after' },
      ],
    },
    'production',
  );
  if (r.level !== 'L2') throw new Error(`expected L2, got ${r.level}`);
});

check('bundle floors L2 to L0 in prototype rigor', () => {
  const m = require(BUNDLE_PATH);
  const r = m.classifyVisualTest(
    {
      id: 't',
      criteriaRef: 'AC-1',
      description: 'x',
      setup: '',
      expect: 'navigation completes after click and reaches the next page',
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#go' },
        { action: 'screenshot', label: 'after' },
      ],
    },
    'prototype',
  );
  if (r.level !== 'L0') throw new Error(`expected L0 floor, got ${r.level}`);
  if (!r.rigorFloored) throw new Error(`expected rigorFloored=true`);
});

check('viewport parser rejects legacy WxH', () => {
  const m = require(BUNDLE_PATH);
  let threw = false;
  try {
    m.parseVisualTestViewport('1280x720');
  } catch (err) {
    threw = /legacy WxH form/.test(err.message);
  }
  if (!threw) throw new Error('expected throw on "1280x720"');
});

// ── Phase 2: heredoc round-trip (the dangerous one) ─────────────────
//
// The qa-aggregate shell step inlines the test list as JSON.stringify(...)
// inside a `node -e "$(cat <<'NODE_EOF' ... NODE_EOF\n)"` heredoc. Edge
// cases that break this:
//   • Tests with `'` in expect text → bash's heredoc-with-singles tolerates
//     it because we use 'NODE_EOF' (no expansion), but we still need the
//     JSON-embedded quotes to survive the node -e string parse.
//   • Tests with backticks or `${...}` → only break if heredoc isn't
//     quoted; we ARE quoted, so no expansion.
//
// Smoke test by replicating the exact `node -e` invocation pattern with
// a hostile test fixture.

check('node -e heredoc survives apostrophes + backticks + newlines in test data', () => {
  const tmp = mkdtempSync(`${tmpdir()}/qa-smoke-`);
  const fixture = [
    {
      id: 'vt-tricky',
      criteriaRef: 'AC-1',
      description: "Description with 'apostrophes' and `backticks`",
      setup: 'Multi\nline\nsetup',
      expect: "Don't break parsing; ${notExpanded}; OK?",
      url: '/',
      expectText: ['hello'],
    },
  ];
  const acs = [{ id: 'AC-1', needsBrowser: true }];
  const heredoc = [
    `node -e "$(cat <<'NODE_EOF'`,
    `const m = require('${BUNDLE_PATH}');`,
    `const tests = ${JSON.stringify(fixture)};`,
    `const acs = ${JSON.stringify(acs)};`,
    `const r = m.aggregateVisualTests(tests, acs, 'prototype');`,
    `console.log('TOTAL:' + r.totalTests);`,
    `console.log('L0:' + r.byLevel.L0);`,
    `NODE_EOF`,
    `)"`,
  ].join('\n');
  const result = spawnSync('bash', ['-c', heredoc], {
    encoding: 'utf8',
    cwd: tmp,
    timeout: 10000,
  });
  if (result.status !== 0) {
    throw new Error(
      `bash heredoc exited ${result.status}: stderr=${(result.stderr || '').slice(0, 200)}`,
    );
  }
  if (!/TOTAL:1/.test(result.stdout) || !/L0:1/.test(result.stdout)) {
    throw new Error(`heredoc output unexpected: ${result.stdout}`);
  }
});

check('aggregate shell-step output emits the expected variable markers', () => {
  // Mimic the qa-aggregate command structure: emit
  // `---QA_AGGREGATE_REPORT---` block with KEY: VALUE lines that the
  // pipeline's regex extractors capture.
  const tmp = mkdtempSync(`${tmpdir()}/qa-smoke-`);
  const fixture = [
    {
      id: 'vt-1',
      criteriaRef: 'AC-1',
      description: 'first',
      setup: '',
      expect: 'specific testable claim that has substance',
      url: '/',
      expectText: ['hi'],
    },
  ];
  const heredoc = [
    `node -e "$(cat <<'NODE_EOF'`,
    `const m = require('${BUNDLE_PATH}');`,
    `const tests = ${JSON.stringify(fixture)};`,
    `const r = m.aggregateVisualTests(tests, [], 'mvp');`,
    `console.log('---QA_AGGREGATE_REPORT---');`,
    `console.log('OVERALL_VERDICT: PENDING_APPROVAL');`,
    `console.log('TOTAL_TESTS: ' + r.totalTests);`,
    `console.log('L0_COUNT: ' + r.byLevel.L0);`,
    `console.log('---END_QA_AGGREGATE_REPORT---');`,
    `NODE_EOF`,
    `)"`,
  ].join('\n');
  const result = spawnSync('bash', ['-c', heredoc], { encoding: 'utf8', cwd: tmp, timeout: 10000 });
  if (result.status !== 0) {
    throw new Error(`exit ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  }
  for (const marker of [
    '---QA_AGGREGATE_REPORT---',
    'OVERALL_VERDICT: PENDING_APPROVAL',
    'TOTAL_TESTS: 1',
    '---END_QA_AGGREGATE_REPORT---',
  ]) {
    if (!result.stdout.includes(marker)) {
      throw new Error(`missing marker "${marker}" in output:\n${result.stdout}`);
    }
  }
});

// ── Phase 3: optional CLI probes ────────────────────────────────────

if (PROBE_CLI) {
  check('claude CLI is on PATH', () => {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
      throw new Error(
        `claude CLI not reachable (status ${r.status}). qa-judge-l1/l2 will fail.`,
      );
    }
  });

  check('playwright CLI is on PATH', () => {
    const r = spawnSync('npx', ['playwright', '--version'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (r.status !== 0) {
      throw new Error(`npx playwright not reachable (status ${r.status})`);
    }
  });

  check('aws CLI is on PATH (for S3 cp)', () => {
    const r = spawnSync('aws', ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) {
      throw new Error(`aws CLI not reachable; qa-prepare can't upload screenshots`);
    }
  });
}

// ── Summary ────────────────────────────────────────────────────────

if (failed) {
  console.error('\n✗ qa-smoke-test FAILED — fix the failures above before pushing daemon changes');
  process.exit(1);
}
console.log(
  `\n✓ qa-smoke-test passed${PROBE_CLI ? ' (with CLI probes)' : ' — re-run with --with-cli on EC2 to validate claude/playwright/aws'}`,
);
