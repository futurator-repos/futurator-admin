#!/usr/bin/env node
/**
 * Agentic Document Center (E3.1 / E3.2) — the subsystem-shard extractor.
 *
 * Deterministic, zero-LLM. Sits ONE level above `doc-extract.mjs`: where that
 * extractor turns each concept artifact into document/docSection nodes, this one
 * partitions the CODE graph into module boundaries (subsystems) and emits, per
 * boundary, a single `docShard` descriptor:
 *
 *   { shardKey: '§sys:<path>', members: [code nodeIds], depends: ['§sys:*'] }
 *
 * Inputs (both read from `<root>/.mycelium/`, the same place graph-sync reads
 * its extractor envelopes from):
 *   • the containment backbone — every file path the AST scan saw, which gives
 *     us the canonical `dir → files` partition (`emitContainmentBackbone`'s
 *     domain). We read it from `ast-facts.json.files[].path` (the authoritative
 *     file set graph-sync grounds on), NOT a re-glob of disk.
 *   • the dependency map — file→file import edges, also from `ast-facts.json`
 *     (`files[].imports[].source`, resolved the SAME way graph-sync resolves
 *     IMPORTS). Cross-module imports become shard→shard `DEPENDS_ON` edges.
 *
 * A "module boundary" is the top-level directory segment under a configurable
 * source root (default: the first path segment, e.g. `src`, `functions`,
 * `daemon`). One docShard per boundary; its members are the code nodeIds for the
 * files under it; its `depends` are the OTHER shards any of its files import
 * from. Self-edges are dropped. A dependency CYCLE between shards is REPORTED in
 * the envelope's `cycles[]` (and on `ambiguous[]`), never crashed on — the graph
 * tolerates cycles, and the god-doc assembler orders deterministically anyway.
 *
 * shardKey encoding reuses the EXACT touchPoint→nodeId convention
 * (`ground-truth-injection.mjs:touchPointToNodeId`): `/`→`--`. So `src/auth`
 * becomes `§sys:src--auth`. A shard with no members is never emitted. An empty
 * project (no ast-facts / no files) → `emptyEnvelope` (nodeCount 0, exit 0),
 * exactly like the sibling extractors.
 *
 * The shardKey is the join key the rest of the Agentic Document Center keys on
 * (godDoc CONTAINS docShard, docShard GOVERNS its members) — it must be stable
 * and reproducible from the file partition alone.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnvelope, emptyEnvelope, writeEnvelope } from '../lib/extractor-envelope.mjs';
import { touchPointToNodeId } from '../ground-truth-injection.mjs';

/** Prefix for a subsystem-shard key. `src/auth` → `§sys:src--auth`. */
export const SHARD_KEY_PREFIX = '§sys:';

/**
 * Encode a module-boundary path as a shardKey, reusing the canonical
 * touchPoint encoding (`/`→`--`) so a shard's key is derivable from any member
 * file's nodeId and vice-versa. `code/`-prefixed inputs pass through their tail.
 */
export function shardKeyFor(boundaryPath) {
  const tail = touchPointToNodeId(boundaryPath).replace(/^code\//, '');
  return `${SHARD_KEY_PREFIX}${tail}`;
}

/**
 * The module boundary a file belongs to: its PARENT DIRECTORY — the same notion
 * the containment backbone uses (`graph-integrity.parentDir`). A directory is the
 * natural module unit (`src/auth/login.ts` and `src/auth/token.ts` share the
 * `src/auth` subsystem; `src/ui/button.tsx` is a distinct `src/ui` subsystem).
 * A root-level file (no `/`) folds under the single `.` boundary so root files
 * still get a shard rather than vanishing.
 */
export function boundaryOf(relPath) {
  const norm = String(relPath).replace(/^\.?\//, '');
  const i = norm.lastIndexOf('/');
  return i === -1 ? '.' : norm.slice(0, i);
}

/**
 * Read the authoritative file set + import edges from an ast-facts doc. Mirrors
 * graph-sync's own read of `ast-facts.json` (`files[].path`, `files[].imports`)
 * so the partition is identical to the one the containment backbone produced.
 *
 * Returns `{ files: string[], imports: Array<{from, source}> }`. A malformed or
 * absent doc yields empty arrays (caller emits emptyEnvelope).
 */
export function readAstFacts(root) {
  const p = join(root, '.mycelium', 'ast-facts.json');
  if (!existsSync(p)) return { files: [], imports: [] };
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { files: [], imports: [] };
  }
  if (!doc || !Array.isArray(doc.files)) return { files: [], imports: [] };
  const files = [];
  const imports = [];
  for (const f of doc.files) {
    if (!f || typeof f.path !== 'string' || f.parseError) continue;
    files.push(f.path);
    for (const imp of f.imports || []) {
      if (imp && typeof imp.source === 'string') {
        imports.push({ from: f.path, source: imp.source });
      }
    }
  }
  return { files, imports };
}

/**
 * Resolve a relative import `source` from `fromPath` to a project-relative file
 * path within the known set, matching graph-sync's IMPORTS semantics closely
 * enough for module-boundary attribution: only relative (`.`/`..`) specifiers
 * are resolvable here (alias/external imports stay cross-module-invisible, which
 * is the conservative, no-false-edge choice). Returns null when unresolvable.
 *
 * We don't reach for the full import-resolver lib (it needs a live tsconfig +
 * disk); module boundaries only need same-/sibling-dir relative edges, which is
 * what crosses subsystem lines in practice. Unresolved imports are surfaced via
 * `ambiguous[]`, never invented.
 */
export function resolveRelativeImport(fromPath, source, knownFiles) {
  if (typeof source !== 'string' || !source.startsWith('.')) return null;
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '.';
  const segs = (fromDir === '.' ? [] : fromDir.split('/')).concat(source.split('/'));
  const stack = [];
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  const base = stack.join('/');
  // Try the literal path, then common TS/JS resolutions + index files.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

/**
 * Detect dependency cycles among shards (Tarjan-free DFS — we only need the
 * member edges of each cycle, not SCCs). Pure; returns an array of cycles, each
 * a list of shardKeys in the order they close the loop. Deterministic: sources
 * and successors are iterated in sorted order.
 */
export function detectShardCycles(depEdges) {
  const adj = new Map();
  for (const { source, target } of depEdges) {
    if (!adj.has(source)) adj.set(source, new Set());
    adj.get(source).add(target);
  }
  const cycles = [];
  const seen = new Set();
  const onStack = new Set();
  const stack = [];

  function dfs(node) {
    onStack.add(node);
    stack.push(node);
    const succ = [...(adj.get(node) || [])].sort();
    for (const nxt of succ) {
      if (onStack.has(nxt)) {
        // Found a back-edge — slice the cycle out of the current stack.
        const idx = stack.indexOf(nxt);
        if (idx !== -1) cycles.push(stack.slice(idx).concat(nxt));
      } else if (!seen.has(nxt)) {
        dfs(nxt);
      }
    }
    onStack.delete(node);
    stack.pop();
    seen.add(node);
  }

  for (const node of [...adj.keys()].sort()) {
    if (!seen.has(node)) dfs(node);
  }
  return cycles;
}

/**
 * Build the docShard descriptors + shard→shard DEPENDS_ON edges from the file
 * set + import edges. Pure; the unit of the determinism + cycle tests.
 *
 * @param {string[]} files                  project-relative file paths
 * @param {Array<{from,source}>} imports    raw import edges (from, source)
 * @returns {{
 *   shards: Array<{ shardKey, boundary, members: string[], depends: string[] }>,
 *   depEdges: Array<{ source, target }>,
 *   cycles: string[][],
 *   ambiguous: Array<object>,
 * }}
 */
export function buildShards(files, imports) {
  const knownFiles = new Set(files);

  // Partition files into boundaries → members (deterministic, sorted).
  const byBoundary = new Map(); // boundary → Set<relPath>
  const boundaryOfFile = new Map(); // relPath → boundary
  for (const rel of files) {
    const b = boundaryOf(rel);
    boundaryOfFile.set(rel, b);
    if (!byBoundary.has(b)) byBoundary.set(b, new Set());
    byBoundary.get(b).add(rel);
  }

  // Resolve imports into cross-boundary shard→shard dependency edges.
  const depPairs = new Set(); // `${srcKey} ${tgtKey}` (skip self)
  const ambiguous = [];
  for (const { from, source } of imports) {
    const resolved = resolveRelativeImport(from, source, knownFiles);
    if (!resolved) {
      // Only relative imports are resolvable here; non-relative (alias/external)
      // are intentionally out of module-boundary scope, not a bug. Record the
      // genuinely-relative-but-unresolved ones as ambiguous (never invented).
      if (typeof source === 'string' && source.startsWith('.')) {
        ambiguous.push({ from, source, reason: 'unresolved-relative-import' });
      }
      continue;
    }
    const srcB = boundaryOfFile.get(from);
    const tgtB = boundaryOfFile.get(resolved);
    if (srcB == null || tgtB == null || srcB === tgtB) continue; // intra-module
    depPairs.add(`${shardKeyFor(srcB)} ${shardKeyFor(tgtB)}`);
  }

  const depEdges = [...depPairs]
    .map((k) => {
      const [source, target] = k.split(' ');
      return { source, target };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  // depends[] per shard (sorted, deduped).
  const dependsByShard = new Map();
  for (const { source, target } of depEdges) {
    if (!dependsByShard.has(source)) dependsByShard.set(source, new Set());
    dependsByShard.get(source).add(target);
  }

  const shards = [...byBoundary.keys()]
    .sort()
    .map((boundary) => {
      const shardKey = shardKeyFor(boundary);
      const members = [...byBoundary.get(boundary)]
        .sort()
        .map((rel) => touchPointToNodeId(rel));
      const depends = [...(dependsByShard.get(shardKey) || [])].sort();
      return { shardKey, boundary, members, depends };
    })
    .filter((s) => s.members.length > 0);

  const cycles = detectShardCycles(depEdges);

  return { shards, depEdges, cycles, ambiguous };
}

/**
 * Build the extractor envelope: one `docShard` node per shard (carrying its
 * boundary + member list), plus shard→shard `DEPENDS_ON` edges. The
 * shard→member GOVERNS edges and the godDoc CONTAINS edges are derived where a
 * graph session exists (`processDocumentFacts`), not in this stateless pass —
 * same split as doc-extract leaving GOVERNS to graph-sync.
 *
 * @param {string} root
 * @returns {object} extractor envelope
 */
export function extractSubsystems(root) {
  const { files, imports } = readAstFacts(root);
  if (files.length === 0) {
    return emptyEnvelope({
      root,
      extra: { extractor: 'subsystem-extract', skipped: 'no ast-facts files' },
    });
  }

  const { shards, depEdges, cycles, ambiguous } = buildShards(files, imports);

  const nodes = shards.map((s) => ({
    nodeId: s.shardKey,
    kind: 'docShard',
    label: s.boundary,
    boundary: s.boundary,
    // Member nodeIds + depends as stringified arrays so the closed-set graph
    // ingest (Memgraph primitives only) can persist them without nested maps.
    members: s.members,
    depends: s.depends,
    memberCount: s.members.length,
  }));

  const edges = depEdges.map((e) => ({
    type: 'DEPENDS_ON',
    source: e.source,
    target: e.target,
    provenance: 'EXTRACTED',
  }));

  // A cycle is a reportable fact, never a crash — surface it on ambiguous[] too
  // so graph-sync's "ambiguous → Compiler work" convention picks it up.
  const ambiguousOut = ambiguous.slice();
  for (const cycle of cycles) {
    ambiguousOut.push({ reason: 'shard-dependency-cycle', cycle });
  }

  return buildEnvelope({
    root,
    nodes,
    edges,
    ambiguous: ambiguousOut,
    extra: { extractor: 'subsystem-extract', shards, cycles },
  });
}

export async function main(argv = process.argv) {
  const root = argv[2] || process.cwd();
  writeEnvelope(extractSubsystems(root));
}

// Run as a CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[subsystem-extract] ${err.message}`);
    process.exit(1);
  });
}
