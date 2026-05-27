/**
 * agent-risk-classifier.ts — 2026-05-27 PR B.d (Lambda-side mirror).
 *
 * The canonical pure implementation lives at
 * `daemon/pipelines/lib/agent-risk-classifier.mjs` — both modules consume
 * the same JSON config at `daemon/lib/agent-danger-paths.json`. The Lambda
 * needs its own copy because the daemon's `.mjs` file isn't bundled into
 * the Lambda artifact (separate build trees).
 *
 * Keep behavior IDENTICAL to the .mjs version. The risk_classifier.test.mjs
 * is the canonical test surface; this TS mirror is exercised end-to-end via
 * the open-pr integration test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RiskClass = 'red' | 'yellow' | 'green';

export interface RiskClassification {
  class: RiskClass;
  reasons: string[];
}

interface DangerConfig {
  redPatterns: string[];
  yellowPathPatterns: string[];
  yellowLineThreshold: number;
}

let _cached: { config: DangerConfig; path: string } | null = null;

function defaultConfigPath(): string {
  // The JSON ships next to daemon/lib/ in the repo. In the Lambda bundle
  // we read it relative to the working directory at deploy time. Allow
  // override via env so tests + alternate deploy layouts work.
  return (
    process.env.AGENT_DANGER_PATHS_FILE || join(process.cwd(), 'daemon/lib/agent-danger-paths.json')
  );
}

export function loadDangerConfig(configPath = defaultConfigPath()): DangerConfig {
  if (_cached && _cached.path === configPath) return _cached.config;
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    red_patterns?: string[];
    yellow_path_patterns?: string[];
    yellow_line_threshold?: number;
  };
  const config: DangerConfig = {
    redPatterns: parsed.red_patterns ?? [],
    yellowPathPatterns: parsed.yellow_path_patterns ?? [],
    yellowLineThreshold: parsed.yellow_line_threshold ?? 50,
  };
  _cached = { config, path: configPath };
  return config;
}

/** Exposed for tests so a fresh config can be read after fixture changes. */
export function _resetDangerConfigCache(): void {
  _cached = null;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') i += 1;
      re += '.*';
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if ('.+?^$()|[]\\{}'.includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

function matchAny(path: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return p;
  }
  return null;
}

function isTestPath(p: string): boolean {
  return (
    p.includes('__tests__/') ||
    p.includes('/tests/') ||
    p.endsWith('.test.ts') ||
    p.endsWith('.test.tsx') ||
    p.endsWith('.test.mjs') ||
    p.endsWith('.test.js') ||
    p.endsWith('.spec.ts') ||
    p.endsWith('.spec.tsx')
  );
}

export interface ClassifyDiffInput {
  touchedPaths: string[];
  additions: number;
  deletions: number;
}

export function classifyDiff(input: ClassifyDiffInput, configPath?: string): RiskClassification {
  const { touchedPaths, additions = 0, deletions = 0 } = input;
  if (!Array.isArray(touchedPaths) || touchedPaths.length === 0) {
    return { class: 'green', reasons: ['no touched paths'] };
  }
  const config = loadDangerConfig(configPath);

  const redHits: { path: string; pattern: string }[] = [];
  for (const p of touchedPaths) {
    const matched = matchAny(p, config.redPatterns);
    if (matched) redHits.push({ path: p, pattern: matched });
  }
  if (redHits.length > 0) {
    return {
      class: 'red',
      reasons: redHits.map((h) => `touched ${h.path} (matches red pattern ${h.pattern})`),
    };
  }

  const yellowHits: string[] = [];
  for (const p of touchedPaths) {
    const matched = matchAny(p, config.yellowPathPatterns);
    if (matched) yellowHits.push(`touched ${p} (matches yellow pattern ${matched})`);
  }
  const totalLines = additions + deletions;
  const hasNonTestFile = touchedPaths.some((p) => !isTestPath(p));
  if (totalLines > config.yellowLineThreshold && hasNonTestFile) {
    yellowHits.push(
      `total non-test diff ${totalLines} lines exceeds yellow threshold ${config.yellowLineThreshold}`,
    );
  }
  if (yellowHits.length > 0) return { class: 'yellow', reasons: yellowHits };

  return { class: 'green', reasons: [] };
}
