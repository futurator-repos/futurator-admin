/**
 * agent-risk-classifier.mjs — 2026-05-27 PR B.b.
 *
 * Pure function that classifies a diff into one of three risk classes.
 * Source of truth for what counts as `red` lives in
 * `daemon/lib/agent-danger-paths.json`; this module just consumes it.
 *
 * Self-referential: this file's path AND the JSON file's path are
 * both in `red_patterns`. Any agent-authored change to either is
 * automatically red-class, foreclosing the "agent disables its own
 * gate" attack (§9.10).
 *
 * Usage:
 *   classifyDiff({
 *     touchedPaths: ['daemon/agent-daemon.mjs'],
 *     additions: 12,
 *     deletions: 3,
 *   }) → { class: 'red', reasons: [...] }
 *
 *   classifyDiff({
 *     touchedPaths: ['src/components/free-agent/widget.tsx'],
 *     additions: 80,
 *     deletions: 20,
 *   }) → { class: 'yellow', reasons: [...] }
 *
 *   classifyDiff({
 *     touchedPaths: ['docs/concepts/foo.md'],
 *     additions: 3,
 *     deletions: 0,
 *   }) → { class: 'green', reasons: [] }
 *
 * The classifier is pure: no I/O, no time, no randomness. Tested
 * exhaustively in agent-risk-classifier.test.mjs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const _THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DANGER_PATHS_FILE = join(_THIS_DIR, '../../lib/agent-danger-paths.json');

let _cachedConfig = null;

/**
 * Read + cache the danger-paths config. Re-reads when the path changes
 * (test injection); otherwise returns the cached parse.
 */
export function loadDangerConfig(configPath = DANGER_PATHS_FILE) {
  if (_cachedConfig && _cachedConfig.__path === configPath) return _cachedConfig;
  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  _cachedConfig = {
    __path: configPath,
    redPatterns: parsed.red_patterns ?? [],
    yellowPathPatterns: parsed.yellow_path_patterns ?? [],
    yellowLineThreshold: parsed.yellow_line_threshold ?? 50,
    version: parsed.version ?? 1,
  };
  return _cachedConfig;
}

/** Reset cache (tests). */
export function _resetDangerConfigCache() {
  _cachedConfig = null;
}

/**
 * Glob → RegExp converter. Supports:
 *   - `**` matches any path segments (including zero)
 *   - `*`  matches any single path segment, no slashes
 *   - everything else literal
 *
 * Keeps the implementation tiny on purpose — we don't need minimatch's
 * full glob grammar for our handful of patterns.
 */
function globToRegExp(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**` — any number of path segments
      // Optionally followed by `/`; consume it so `daemon/**` matches
      // both `daemon/foo` and the literal `daemon/`.
      i += 2;
      if (glob[i] === '/') i += 1;
      re += '.*';
    } else if (c === '*') {
      // `*` — single segment, no slashes
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

function matchAny(path, patterns) {
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return p;
  }
  return null;
}

function isTestPath(p) {
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

/**
 * Classify a diff. Returns `{ class: 'red'|'yellow'|'green', reasons: string[] }`.
 *
 * Rules (first match wins):
 *   1. Any touched path matches red_patterns → `red`
 *   2. yellow_path_patterns hit, OR (additions+deletions in non-test files) > yellow_line_threshold → `yellow`
 *   3. otherwise → `green`
 *
 * @param {object} diff
 * @param {string[]} diff.touchedPaths
 * @param {number} diff.additions
 * @param {number} diff.deletions
 * @param {string} [configPath] — override for tests
 */
export function classifyDiff({ touchedPaths, additions = 0, deletions = 0 }, configPath) {
  if (!Array.isArray(touchedPaths) || touchedPaths.length === 0) {
    return { class: 'green', reasons: ['no touched paths'] };
  }
  const config = loadDangerConfig(configPath);

  // ── Rule 1: red — any path hits a red pattern ─────────────────────────
  const redHits = [];
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

  // ── Rule 2: yellow ────────────────────────────────────────────────────
  const yellowHits = [];

  // 2a — explicit yellow path patterns
  for (const p of touchedPaths) {
    const matched = matchAny(p, config.yellowPathPatterns);
    if (matched) yellowHits.push(`touched ${p} (matches yellow pattern ${matched})`);
  }

  // 2b — line-threshold over non-test files
  const totalLines = (additions ?? 0) + (deletions ?? 0);
  const hasNonTestFile = touchedPaths.some((p) => !isTestPath(p));
  if (totalLines > config.yellowLineThreshold && hasNonTestFile) {
    yellowHits.push(
      `total non-test diff ${totalLines} lines exceeds yellow threshold ${config.yellowLineThreshold}`,
    );
  }

  if (yellowHits.length > 0) return { class: 'yellow', reasons: yellowHits };

  return { class: 'green', reasons: [] };
}

/** Exposed for diagnostics + UI labels. */
export const RISK_CLASSES = ['red', 'yellow', 'green'];
