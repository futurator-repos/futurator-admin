/**
 * import-resolver.mjs — G1 (pacman1 graph audit, 2026-06-12).
 *
 * Resolves an import source string to a project-relative file path, for the
 * AST → Memgraph edge translation in graph-sync.mjs.
 *
 * Extracted from graph-sync.mjs (whose module-load runs the CLI, making it
 * untestable by import) and upgraded to fix the two diseases behind the
 * "ring of unconnected dots" in the knowledge graph:
 *
 *   1. ALIAS BLINDNESS — only `./` / `../` imports resolved; the Next.js
 *      boilerplate imports via the `@/` tsconfig path alias everywhere, so
 *      most IMPORTS/DEPENDS_ON edges were silently dropped (pacman1:
 *      19 IMPORTS on a 49-file project). `loadAliasMap` reads
 *      tsconfig.json `compilerOptions.paths` (tolerant of JSONC comments
 *      and trailing commas) with a `@/*` → `src/*` fallback.
 *
 *   2. CHANGED-FILES-ONLY BLINDNESS — candidates were only accepted when
 *      present in THIS story's AST facts (`knownFiles` = the diff), so an
 *      import of any UNCHANGED file never produced an edge even with a
 *      relative path. Candidates now also accept files that exist on disk
 *      under the project root (the edge cypher MATCHes the target node,
 *      which bootstrap-ast / prior stories created).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXT_CANDIDATES = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const INDEX_CANDIDATES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Build the path-alias map from `<rootDir>/tsconfig.json`. Returns
 * `[{ prefix, targetPrefix }]` sorted longest-prefix-first. Falls back to
 * the boilerplate convention (`@/` → `src/`) when tsconfig is absent,
 * unparseable, or declares no paths.
 */
export function loadAliasMap(rootDir) {
  const fallback = [{ prefix: '@/', targetPrefix: 'src/' }];
  try {
    let raw = readFileSync(join(rootDir, 'tsconfig.json'), 'utf8');
    // tsconfig is JSONC in the wild: strip /* */ and // comments (the
    // latter only when not inside a string — good enough for tsconfig
    // shapes) and trailing commas.
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    raw = raw.replace(/^\s*\/\/.*$/gm, '');
    raw = raw.replace(/,\s*([}\]])/g, '$1');
    const ts = JSON.parse(raw);
    const paths = ts?.compilerOptions?.paths;
    if (!paths || typeof paths !== 'object') return fallback;
    const baseUrl = (ts.compilerOptions.baseUrl || '.').replace(/^\.\/?/, '');
    const map = [];
    for (const [alias, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || typeof targets[0] !== 'string') continue;
      const prefix = alias.replace(/\*$/, '');
      const targetRel = targets[0].replace(/\*$/, '').replace(/^\.\/?/, '');
      const targetPrefix = baseUrl ? `${baseUrl}/${targetRel}`.replace(/\/+/g, '/') : targetRel;
      if (prefix) map.push({ prefix, targetPrefix });
    }
    if (map.length === 0) return fallback;
    map.sort((a, b) => b.prefix.length - a.prefix.length);
    return map;
  } catch {
    return fallback;
  }
}

/** Normalize `a/./b/../c` → `a/c` without touching the filesystem. */
function normalizeSegments(path) {
  const segs = [];
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') segs.pop();
    else segs.push(p);
  }
  return segs.join('/');
}

/**
 * Resolve `importSource` (as written in the import statement of `fromFile`)
 * to a project-relative file path, or null when external/unresolvable.
 *
 * @param {string} fromFile      project-relative path of the importing file
 * @param {string} importSource  the import specifier (./x, ../y, @/z, lodash)
 * @param {Set<string>} knownFiles  paths in this sync's AST facts (preferred)
 * @param {{ aliasMap?: Array<{prefix: string, targetPrefix: string}>, rootDir?: string }} [opts]
 */
export function resolveImportSource(fromFile, importSource, knownFiles, opts = {}) {
  const { aliasMap = [], rootDir = null } = opts;

  let target = null;
  if (importSource.startsWith('.')) {
    const fromDir = fromFile.split('/').slice(0, -1).join('/');
    target = normalizeSegments((fromDir ? fromDir + '/' : '') + importSource);
  } else {
    for (const { prefix, targetPrefix } of aliasMap) {
      if (importSource.startsWith(prefix)) {
        target = normalizeSegments(targetPrefix + importSource.slice(prefix.length));
        break;
      }
    }
  }
  if (!target) return null; // external package (lodash, react, …)

  const candidates = [
    ...EXT_CANDIDATES.map((e) => target + e),
    ...INDEX_CANDIDATES.map((e) => target + e),
  ];
  // Exact-path import (already carries its extension).
  if (/\.[tj]sx?$|\.mjs$/.test(target)) candidates.unshift(target);

  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  // Changed-files blindness fix: accept any candidate that exists on disk —
  // the Memgraph MATCH on the target node decides whether an edge lands.
  if (rootDir) {
    for (const c of candidates) {
      if (existsSync(join(rootDir, c))) return c;
    }
  }
  return null;
}
