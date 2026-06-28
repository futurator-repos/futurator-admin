#!/usr/bin/env node
// subsystem-decompose.mjs — Refactoring Scan Engine v2, B0.
//
// Derives NAMED, SCOPED subsystems from the deterministic recon outputs so the
// LLM swarm is steered at real module boundaries — replacing ultracode's
// hand-authored, drift-prone SPECS[] list. Sources from what recon ACTUALLY
// writes (graphify-out/): resolved-imports.json (edges + hubs + fileRoles),
// hotspots.json, graph.resolved.json. Boundaries = parent directory (the robust
// fallback the design flags when Leiden communities are degenerate); each shard
// carries members[] (scoped read-set), depends[] (cross-module edges), and a
// `focus` synthesized deterministically from that shard's hotspots + top hubs so
// each analyzer is pointed at the actually-hot files.
//
// USAGE: node subsystem-decompose.mjs <graphifyOutDir> [--repo <root>] [--cap N] [--out <file>]

import fs from 'node:fs';
import path from 'node:path';

const SHARD_PREFIX = '§sys:';
export function boundaryOf(rel) {
  const p = String(rel || '').replace(/^[./]+/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}
export const shardKeyForBoundary = (b) => `${SHARD_PREFIX}${String(b).replace(/\//g, '--')}`;
const fileBoundary = (f) => boundaryOf(f);

/**
 * Pure core: build subsystem shards from recon-derived structures.
 * @param {object} a
 *   - edges:   [{source,target}]   alias-resolved file→file imports
 *   - hubs:    [{file,inDegree}]   per-file fan-in
 *   - hotspots:[AuditHotspot]      ranked hotspots
 *   - fileRoles:{[file]:{role}}    privacy/arch role tags (optional)
 *   - files:   string[]            full file set (optional; derived from edges+hubs if absent)
 *   - cap:     number              max shards to give a dedicated analyzer (default 24)
 * @returns {{ shards, analyzedCount, sampledCount, lowConfidence, reason? }}
 */
export function buildSubsystems({ edges = [], hubs = [], hotspots = [], fileRoles = {}, files = [], cap = 24 } = {}) {
  const inDeg = new Map(hubs.map((h) => [h.file, h.inDegree]));
  // file universe
  const universe = new Set(files);
  for (const e of edges) { if (e.source) universe.add(e.source); if (e.target) universe.add(e.target); }
  for (const h of hubs) if (h.file) universe.add(h.file);

  // group files by boundary
  const shardOf = new Map(); // boundary -> { members:Set, depends:Set, fanIn, roles:Map }
  const ensure = (b) => {
    if (!shardOf.has(b)) shardOf.set(b, { members: new Set(), depends: new Set(), fanIn: 0, roles: new Map() });
    return shardOf.get(b);
  };
  for (const f of universe) {
    const b = fileBoundary(f);
    const s = ensure(b);
    s.members.add(f);
    s.fanIn += inDeg.get(f) || 0;
    const role = fileRoles[f]?.role;
    if (role) s.roles.set(role, (s.roles.get(role) || 0) + 1);
  }
  // cross-boundary dependency edges
  for (const e of edges) {
    const sb = fileBoundary(e.source);
    const tb = fileBoundary(e.target);
    if (sb !== tb && shardOf.has(sb) && tb) shardOf.get(sb).depends.add(shardKeyForBoundary(tb));
  }
  // hotspots per boundary (by any implicated file's boundary)
  const hotspotsByBoundary = new Map();
  for (const h of hotspots) {
    const fileList = [h.evidence?.file, ...(h.files || [])].filter(Boolean);
    const seen = new Set();
    for (const f of fileList) {
      const b = fileBoundary(f);
      if (seen.has(b)) continue;
      seen.add(b);
      if (!hotspotsByBoundary.has(b)) hotspotsByBoundary.set(b, []);
      hotspotsByBoundary.get(b).push(h);
    }
  }

  // assemble + rank
  let shards = [...shardOf.entries()].map(([boundary, s]) => {
    const members = [...s.members].sort();
    const hs = (hotspotsByBoundary.get(boundary) || []).sort((a, b) => (b.score || 0) - (a.score || 0));
    const topHubs = members
      .map((f) => ({ f, d: inDeg.get(f) || 0 }))
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .filter((x) => x.d > 0);
    const roleMix = [...s.roles.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`);
    return {
      shardKey: shardKeyForBoundary(boundary),
      name: boundary,
      members,
      memberCount: members.length,
      depends: [...s.depends].sort(),
      fanInTotal: s.fanIn,
      hotspotCount: hs.length,
      roleMix,
      focus: synthFocus(hs, topHubs, roleMix),
    };
  });

  // rank: hotspot-bearing first, then fan-in, then size
  shards.sort((a, b) =>
    (b.hotspotCount > 0) - (a.hotspotCount > 0) ||
    b.hotspotCount - a.hotspotCount ||
    b.fanInTotal - a.fanInTotal ||
    b.memberCount - a.memberCount,
  );
  let analyzedCount = 0;
  shards = shards.map((sh, i) => {
    const analyze = i < cap || sh.hotspotCount > 0; // every hotspot shard gets an agent
    if (analyze) analyzedCount++;
    return { ...sh, analyze };
  });
  const sampledCount = shards.length - analyzedCount;

  // low-confidence: one boundary swallows the repo, or there's effectively no structure
  const total = shards.reduce((n, s) => n + s.memberCount, 0) || 1;
  const biggest = Math.max(0, ...shards.map((s) => s.memberCount));
  let lowConfidence = false;
  let reason;
  if (shards.length <= 1) { lowConfidence = true; reason = 'single-boundary repo — no module structure to scope'; }
  else if (biggest / total > 0.7) { lowConfidence = true; reason = `one boundary holds ${Math.round((biggest / total) * 100)}% of files — flat structure`; }

  return { shards, analyzedCount, sampledCount, lowConfidence, ...(reason ? { reason } : {}) };
}

/** Deterministic focus line: the hot files + hubs an analyzer should fixate on. */
function synthFocus(hotspots, topHubs, roleMix) {
  const parts = [];
  if (hotspots.length) parts.push(`Hotspots: ${hotspots.slice(0, 3).map((h) => h.title).join(' · ')}`);
  if (topHubs.length) parts.push(`Hubs: ${topHubs.map((x) => `${x.f} (fan-in ${x.d})`).join(', ')}`);
  if (roleMix.length) parts.push(`Roles: ${roleMix.join(', ')}`);
  return parts.join('. ') || 'General subsystem review — no hotspots or hubs flagged.';
}

// ── CLI ──
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function main(argv) {
  const args = argv.slice(2);
  const outDir = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const cap = parseInt(flag('--cap') || '24', 10);
  const out = flag('--out') || path.join(outDir, 'subsystem-shards.json');

  const resolved = readJson(path.join(outDir, 'resolved-imports.json')) || {};
  const hotspotsDoc = readJson(path.join(outDir, 'hotspots.json')) || { hotspots: [] };
  const graph = readJson(path.join(outDir, 'graph.resolved.json')) || readJson(path.join(outDir, 'graph.json')) || { nodes: [] };
  const files = [...new Set((graph.nodes || []).map((n) => n.source_file).filter(Boolean))];

  const res = buildSubsystems({
    edges: resolved.edges || [],
    hubs: resolved.hubs || [],
    hotspots: hotspotsDoc.hotspots || [],
    fileRoles: resolved.fileRoles || {},
    files,
    cap,
  });

  const doc = {
    generatedAt: null,
    root: outDir,
    shardCount: res.shards.length,
    analyzedCount: res.analyzedCount,
    sampledCount: res.sampledCount,
    lowConfidence: res.lowConfidence,
    ...(res.reason ? { lowConfidenceReason: res.reason } : {}),
    shards: res.shards,
  };
  fs.writeFileSync(path.resolve(out), JSON.stringify(doc, null, 2));
  console.error(
    `[subsystem-decompose] ${res.shards.length} shards (${res.analyzedCount} analyzed, ${res.sampledCount} sampled)` +
    `${res.lowConfidence ? ` · LOW-CONFIDENCE: ${res.reason}` : ''} → ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
