/**
 * graphify-import.mjs — map a refactoring-recon `graphify-out/` into the canonical
 * GraphStore envelope and land it under a registered app's `projectId`.
 *
 * Story S2.4 (EU-migration completion, `= A10 = F11`). The Assess/refactor recon
 * chain (`agent-daemon.mjs`) emits `graphify-out/` per scanned repo:
 *   - `graph.resolved.json`  — symbol-level graphify graph (nodes carry
 *       `{id,label,source_file,community,resolved_in_degree}`, links carry
 *       `{source,target,relation}`), with the alias-resolved fan-in merged on
 *       (`alias-resolve.mjs`). Falls back to `graph.json` when unresolved.
 *   - `resolved-imports.json` — the TRUSTWORTHY alias-resolved file→file import
 *       graph (`edges`), plus `fileRoles` (infra/db/ai/thirdParty detections) and
 *       `hubs` (fan-in) — `alias-resolve.mjs:225`.
 *   - `graph-ui.json` — the file-level projection the Assess Graph tab renders
 *       (`graph-project.mjs:124`): one node per source file carrying
 *       `community`/`fanIn`/`role`/`providers`/`hotspotKinds`.
 *
 * This module is the SCAN side of the graph write-path — the twin of
 * `graph-sync.mjs`'s dev-pipeline AST grounding. The correctness hinge is
 * **id-scheme parity with S1.1**: a file becomes `code/<path with '/' → '--'>`
 * (`fileToCodeNodeId`) and a symbol becomes `<fileNodeId>#<kind>:<name>`
 * (`subNodeId`) so a later `graph-sync` run on the same project MERGES onto the
 * same rows instead of forking a parallel node set. Those two derivations are
 * replicated verbatim below (graph-sync.mjs:712/717 — that module runs `main()`
 * on import so it cannot be imported for reuse).
 *
 * SCOPE: this writes to the GraphStore (agent-nav / dev Graph substrate). The
 * `_refactor/graph.json` UI projection + its S3 upload path (agent-daemon.mjs
 * :9762/:10042) are UNCHANGED — the Assess Graph tab keeps rendering from that
 * file, so this import is additive and invisible to it.
 *
 * REGISTERED APPS ONLY: an ephemeral per-story / wave-candidate worktree scan
 * (`isEphemeralScanRoot`) lands NOTHING — same F15 guard `graph-sync.mjs:32`
 * uses, so a partial worktree can never pollute a project's graph partition.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEphemeralScanRoot } from './ast-facts-reconcile.mjs';

// ── id-scheme parity with graph-sync.mjs (S1.1) — DO NOT diverge ────────────
// graph-sync.mjs:712 — file path → `code/<slug>` (matches the wiki article ids).
/** @param {string} relPath */
function fileToCodeNodeId(relPath) {
  return `code/${relPath.replace(/\//g, '--')}`;
}
// graph-sync.mjs:717 — composite id for a sub-file entity (`#function:`/`#class:`).
/** @param {string} fileNodeId @param {string} kind @param {string} name */
function subNodeId(fileNodeId, kind, name) {
  return `${fileNodeId}#${kind}:${name}`;
}

// Mirror graph-project.mjs's "is this a source file?" test so file nodes and
// symbol nodes split the same way graphify's own projection splits them.
const isFile = (s) => /\.(tsx?|jsx?|mjs|cjs)$/.test(s || '');
const basename = (f) => (f ? f.split('/').pop() : f);

// A graphify symbol is a CLASS (vs the default `function`) when it participates
// in a class-shaped relation: it inherits/implements/mixes-in/embeds something,
// it owns methods, or it is the parent of an `inherits` edge. graphify's AST
// symbol nodes carry no explicit function/class tag (`{id,label,source_file}`
// only — extract.py add_node), so edge topology is the only deterministic
// signal. Default → `function` (parity: subNodeId(kind='function')).
const CLASS_SOURCE_RELATIONS = new Set(['inherits', 'implements', 'mixes_in', 'embeds', 'method']);
const CLASS_TARGET_RELATIONS = new Set(['inherits']);

/**
 * Read the three graphify-out artifacts (best-effort — a missing/malformed file
 * degrades to null/{} rather than throwing, matching graph-project.mjs's readJson).
 * @param {string} graphifyOutDir
 */
export function readGraphifyOut(graphifyOutDir) {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(graphifyOutDir, name), 'utf8'));
    } catch {
      return null;
    }
  };
  const graph = read('graph.resolved.json') || read('graph.json');
  const resolvedImports = read('resolved-imports.json') || {};
  const graphUi = read('graph-ui.json') || null;
  return { graph, resolvedImports, graphUi };
}

/** Normalize a provider detection (either projection's shape) to one shape. */
function normProviders(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => ({ provider: d.provider, kind: d.kind, residency: d.residency }))
    .filter((d) => d.provider);
}

/**
 * Pure mapping: graphify-out artifacts → canonical GraphStore envelope
 * (`{ nodes, edges, stats }`, public node/edge shapes per graph-store.mjs).
 *
 * `community`/`fanIn` ride as first-class node attrs (buildNodeItem persists
 * them); `role`/`roleKinds`/`providers`/`hotspotKinds`/`isHotspot` ride under
 * `props` (the natural home for the recon file-class metadata). NOTE: the store
 * filters `props` to the `SYSTEM_GRAPH_NODE_PROPS` allowlist (S0.2), which does
 * not yet carry `role`/`providers` — see the module report; the mapping stays
 * faithful so they flow through once the allowlist is extended.
 *
 * @param {{graph:object|null, resolvedImports:object, graphUi:object|null}} artifacts
 */
export function mapGraphifyToEnvelope({ graph, resolvedImports = {}, graphUi = null } = {}) {
  const stats = { files: 0, symbols: 0, functions: 0, classes: 0, imports: 0, defines: 0 };
  if (!graph || !Array.isArray(graph.nodes)) {
    return { nodes: [], edges: [], stats };
  }

  const fileRoles = resolvedImports.fileRoles || {};
  const hubFanIn = new Map((resolvedImports.hubs || []).map((h) => [h.file, h.inDegree]));

  // ── file metadata, richest-source-first (graph-ui > resolved > graph) ──────
  /** @type {Map<string, {community:*, fanIn:number, role:*, roleKinds:*, providers:Array, hotspotKinds:Array, isHotspot:boolean, title:*}>} */
  const fileMeta = new Map();
  const ensureFile = (f) => {
    if (!f || !isFile(f)) return null;
    let m = fileMeta.get(f);
    if (!m) {
      const fr = fileRoles[f];
      m = {
        community: null,
        fanIn: hubFanIn.get(f) ?? null,
        role: fr?.role ?? null,
        roleKinds: fr?.kinds ?? [],
        providers: normProviders(fr?.detections),
        hotspotKinds: [],
        isHotspot: false,
        title: basename(f),
      };
      fileMeta.set(f, m);
    }
    return m;
  };

  // 1. graph-ui.json — the render-ready file projection (authoritative attrs).
  for (const n of (graphUi && Array.isArray(graphUi.nodes) ? graphUi.nodes : [])) {
    const m = ensureFile(n.id);
    if (!m) continue;
    if (n.community != null) m.community = n.community;
    if (typeof n.fanIn === 'number') m.fanIn = n.fanIn;
    if (n.role != null) m.role = n.role;
    if (Array.isArray(n.roleKinds) && n.roleKinds.length) m.roleKinds = n.roleKinds;
    if (Array.isArray(n.providers) && n.providers.length) m.providers = normProviders(n.providers);
    if (Array.isArray(n.hotspotKinds)) m.hotspotKinds = n.hotspotKinds;
    if (n.isHotspot != null) m.isHotspot = !!n.isHotspot;
    if (n.title) m.title = n.title;
  }

  // 2. graph.resolved.json file nodes — community + resolved fan-in fallbacks.
  for (const n of graph.nodes) {
    if (!n || !isFile(n.source_file) || !isFile(n.label)) continue; // symbol handled below
    const m = ensureFile(n.source_file);
    if (!m) continue;
    if (m.community == null && n.community != null) m.community = n.community;
    if (m.fanIn == null && typeof n.resolved_in_degree === 'number') m.fanIn = n.resolved_in_degree;
  }

  // ── symbol classification: build the class-id set from edge topology ───────
  const classIds = new Set();
  for (const e of (Array.isArray(graph.links) ? graph.links : [])) {
    if (!e || !e.relation) continue;
    if (CLASS_SOURCE_RELATIONS.has(e.relation) && e.source) classIds.add(e.source);
    if (CLASS_TARGET_RELATIONS.has(e.relation) && e.target) classIds.add(e.target);
  }

  // ── symbol nodes + DEFINES edges (file → symbol) ──────────────────────────
  const nodes = [];
  const edges = [];
  for (const n of graph.nodes) {
    if (!n || !isFile(n.source_file) || isFile(n.label)) continue; // file nodes emitted below
    const fileM = ensureFile(n.source_file);
    if (!fileM) continue;
    const fileNodeId = fileToCodeNodeId(n.source_file);
    const kind = classIds.has(n.id) ? 'class' : 'function';
    const name = n.label;
    if (!name) continue;
    const nodeId = subNodeId(fileNodeId, kind, name);
    nodes.push({
      nodeId,
      kind,
      file: n.source_file,
      title: kind === 'class' ? `class ${name}` : `${name}()`,
      status: 'active',
      community: n.community ?? fileM.community ?? undefined,
      props: { name, parentFile: fileNodeId, type: 'code', phase: 'implementation' },
    });
    edges.push({ type: 'DEFINES', from: fileNodeId, to: nodeId });
    stats.symbols++;
    stats.defines++;
    if (kind === 'class') stats.classes++;
    else stats.functions++;
  }

  // ── file nodes (emit after symbols so every symbol's parent file exists) ───
  for (const [f, m] of fileMeta) {
    nodes.push({
      nodeId: fileToCodeNodeId(f),
      kind: 'file',
      file: f,
      title: m.title || basename(f),
      status: 'active',
      community: m.community ?? undefined,
      fanIn: typeof m.fanIn === 'number' ? m.fanIn : undefined,
      props: {
        type: 'code',
        phase: 'implementation',
        // recon file-class metadata (allowlist-gated at the store, see note above)
        role: m.role ?? undefined,
        roleKinds: m.roleKinds && m.roleKinds.length ? m.roleKinds : undefined,
        providers: m.providers && m.providers.length ? m.providers : undefined,
        hotspotKinds: m.hotspotKinds && m.hotspotKinds.length ? m.hotspotKinds : undefined,
        isHotspot: m.isHotspot || undefined,
      },
    });
    stats.files++;
  }

  // ── IMPORTS edges — the trustworthy alias-resolved file→file graph ─────────
  // (resolved-imports.json.edges, NOT graphify's alias-blind links). Both
  // endpoints must be known file nodes (heir of graph-sync's both-endpoints rule).
  for (const e of (Array.isArray(resolvedImports.edges) ? resolvedImports.edges : [])) {
    if (!e || !fileMeta.has(e.source) || !fileMeta.has(e.target)) continue;
    edges.push({
      type: 'IMPORTS',
      from: fileToCodeNodeId(e.source),
      to: fileToCodeNodeId(e.target),
    });
    stats.imports++;
  }

  return { nodes, edges, stats };
}

/**
 * Import a registered app's graphify-out into its GraphStore partition.
 * Ephemeral worktree scans (per-story / wave-candidate) land NOTHING.
 *
 * @param {object}  args
 * @param {string}  args.graphifyOutDir  the `graphify-out/` dir for this scan
 * @param {string}  args.projectId       the registered app's projectId (store partition)
 * @param {string}  [args.scanRoot]      the scanned repo root (ephemeral guard)
 * @param {object}  args.store           a GraphStore (createGraphStore, S0.2)
 * @returns {Promise<{skipped:boolean, reason?:string, projectId?:string, nodes:number, edges:number, stats?:object}>}
 */
export async function importGraphifyOut({ graphifyOutDir, projectId, scanRoot, store } = {}) {
  if (!projectId) throw new Error('graphify-import: projectId is required');
  if (!store) throw new Error('graphify-import: store is required');
  if (!graphifyOutDir) throw new Error('graphify-import: graphifyOutDir is required');

  // Registered apps only — a partial worktree scan is not authoritative for a
  // project's graph and must never write (F15 parity, graph-sync.mjs:32).
  if (isEphemeralScanRoot(scanRoot)) {
    return { skipped: true, reason: 'ephemeral-scan-root', nodes: 0, edges: 0 };
  }

  const artifacts = readGraphifyOut(graphifyOutDir);
  if (!artifacts.graph) {
    return { skipped: true, reason: 'no-graph', nodes: 0, edges: 0 };
  }

  const { nodes, edges, stats } = mapGraphifyToEnvelope(artifacts);
  const nodesWritten = await store.putNodes(projectId, nodes);
  const edgesWritten = await store.putEdges(projectId, edges);
  return { skipped: false, projectId, nodes: nodesWritten, edges: edgesWritten, stats };
}
