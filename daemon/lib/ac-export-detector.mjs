// Pipeline v2.0 efficiency fix T0.2.
//
// Heuristic extractor: pull candidate "named exports" from a story's
// acceptance-criteria text, then check whether those exports exist in the
// declared touchPoint files. Pure functions; injectable shell + fs for tests.
//
// Used by daemon/lib/prework-gate.mjs as one of three signals (commits +
// exports + tsc) that decide whether to skip DEV entirely. False-negatives
// are cheap (gate falls through, DEV runs); false-positives are dangerous
// (DEV would be skipped when work is needed) — so the matching is
// conservative and only counts an AC as "satisfied by exports" when ALL
// extracted candidates are present.

import { readFile as fsReadFile } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pull candidate named-export identifiers out of an AC text. The heuristic
 * looks for camelCase / PascalCase identifiers that appear in patterns the
 * planner typically uses:
 *
 *   - `applyGravity(dino)` — function call shape
 *   - `function applyGravity` / `const applyGravity =` — declaration shape
 *   - `export function applyGravity` — explicit export shape
 *   - backticked identifiers: `applyGravity`
 *   - "Implements `startJump`, `endDuck`" — list shape
 *
 * Excludes common English words that match the camelCase regex by accident
 * (e.g. "isJumping" alone in prose is fine; "and" is filtered).
 *
 * @param {string} acText - the bulleted AC text or a single AC line
 * @returns {string[]} - deduplicated candidate identifiers, longest first
 */
export function extractCandidateExports(acText) {
  if (typeof acText !== 'string' || acText.length === 0) return [];

  const candidates = new Set();

  // Pattern 1: backticked identifiers — `applyGravity`, `Dino`
  const backticked = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;
  let m;
  while ((m = backticked.exec(acText)) !== null) candidates.add(m[1]);

  // Pattern 2: function call shape — applyGravity(...)
  const callShape = /\b([a-z][A-Za-z0-9_$]+)\s*\(/g;
  while ((m = callShape.exec(acText)) !== null) candidates.add(m[1]);

  // Pattern 3: declaration shape — function applyGravity / const applyGravity / class Dino
  const declShape = /\b(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]+)/g;
  while ((m = declShape.exec(acText)) !== null) candidates.add(m[1]);

  // Pattern 4: explicit export — export function/const/class
  const exportShape =
    /\bexport\s+(?:default\s+)?(?:function|const|let|class|interface|type|enum)?\s*([A-Za-z_$][A-Za-z0-9_$]+)/g;
  while ((m = exportShape.exec(acText)) !== null) candidates.add(m[1]);

  // Pattern 5: type annotations — `: PascalCase` and `): PascalCase` shapes
  // Catches return-type and parameter-type references that planners commonly
  // include in AC bullets (e.g. `applyGravity(dino: Dino): Dino`). Restricted
  // to PascalCase to avoid matching prose colons before lowercase words.
  const typeAnnotation = /:\s*([A-Z][A-Za-z0-9_$]+)/g;
  while ((m = typeAnnotation.exec(acText)) !== null) candidates.add(m[1]);

  // Filter: must contain at least one camelCase or PascalCase signal.
  // Pure-lowercase short words (and, the, with, etc.) and pure single-letter
  // identifiers are dropped to reduce false matches in prose.
  const filtered = [...candidates].filter(isPlausibleIdentifier);

  // Longest first — more specific identifiers grep-match more reliably.
  filtered.sort((a, b) => b.length - a.length);
  return filtered;
}

/**
 * Check whether each candidate identifier appears in the declared
 * touchPoint files as an exported declaration. Conservative: requires the
 * identifier to follow `export ` (with or without `default`/qualifier) on
 * its own line, OR be re-exported from `index.ts`-style barrel files.
 *
 * @param {object} input
 * @param {string[]} input.candidates - from extractCandidateExports
 * @param {string[]} input.touchPoints - file paths (relative to projectDir)
 * @param {string} input.projectDir - absolute path to project root
 * @param {object} [input.fs] - injectable for tests
 * @returns {Promise<{
 *   allPresent: boolean,
 *   present: string[],
 *   missing: string[],
 *   filesScanned: string[],
 * }>}
 */
export async function checkExportsPresent(input) {
  const {
    candidates,
    touchPoints,
    projectDir,
    fs = { readFile: fsReadFile, exists: (p) => Promise.resolve(fsExistsSync(p)) },
  } = input || {};

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { allPresent: false, present: [], missing: [], filesScanned: [] };
  }
  if (!Array.isArray(touchPoints) || touchPoints.length === 0) {
    return { allPresent: false, present: [], missing: candidates.slice(), filesScanned: [] };
  }
  if (!projectDir) {
    return { allPresent: false, present: [], missing: candidates.slice(), filesScanned: [] };
  }

  // Resolve glob-y touchPoints to concrete files. For T0.2 we only handle
  // direct file references and `dir/*.ts` style; deep globs are conservatively
  // treated as "we don't know what's there" → fall through.
  const filesScanned = [];
  const aggregateContent = [];

  for (const tp of touchPoints) {
    if (typeof tp !== 'string' || tp.length === 0) continue;
    if (tp.includes('**')) continue; // deep glob — let DEV run
    const abs = join(projectDir, tp);
    if (!(await fs.exists(abs))) continue;
    try {
      const content = await fs.readFile(abs, 'utf8');
      filesScanned.push(tp);
      aggregateContent.push(content);
    } catch {
      // unreadable file — skip
    }
  }

  if (filesScanned.length === 0) {
    return { allPresent: false, present: [], missing: candidates.slice(), filesScanned: [] };
  }

  const haystack = aggregateContent.join('\n');
  const present = [];
  const missing = [];

  for (const id of candidates) {
    if (matchesExport(haystack, id)) {
      present.push(id);
    } else {
      missing.push(id);
    }
  }

  return {
    allPresent: missing.length === 0 && present.length > 0,
    present,
    missing,
    filesScanned,
  };
}

// ── internals ────────────────────────────────────────────────────────────

const PLAUSIBLE_IDENTIFIER_BLOCKLIST = new Set([
  'and',
  'or',
  'the',
  'a',
  'an',
  'is',
  'be',
  'to',
  'in',
  'of',
  'for',
  'with',
  'when',
  'then',
  'this',
  'that',
  'on',
  'as',
  'by',
  'it',
  'if',
  'so',
  'do',
  'no',
  'yes',
  'true',
  'false',
  'null',
  'undefined',
]);

function isPlausibleIdentifier(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 3) return false;
  if (PLAUSIBLE_IDENTIFIER_BLOCKLIST.has(name.toLowerCase())) return false;
  // Must contain at least one capital letter (PascalCase / camelCase).
  if (!/[A-Z]/.test(name)) return false;
  return true;
}

function matchesExport(haystack, id) {
  // Escape any regex metachars in the identifier (defensive — id should be
  // a plain JS identifier, but extracted text may contain $ etc.).
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match shapes that imply an export of this identifier:
  //   export function|const|let|class|interface|type|enum <id>
  //   export default function <id>
  //   export { <id> }
  //   export { <id> as ... }
  //   export * as <id>
  const patterns = [
    new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${escaped}\\b`, 'm'),
    new RegExp(`^\\s*export\\s+\\{[^}]*\\b${escaped}\\b[^}]*\\}`, 'm'),
    new RegExp(`^\\s*export\\s+\\*\\s+as\\s+${escaped}\\b`, 'm'),
  ];
  return patterns.some((re) => re.test(haystack));
}
