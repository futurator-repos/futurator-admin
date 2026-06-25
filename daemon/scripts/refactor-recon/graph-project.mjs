#!/usr/bin/env node
// graph-project.mjs — project the recon graph into a UI-renderable file-level graph.
//
// The raw graphify graph.resolved.json is symbol-level (~4307 nodes for applicator)
// and its import edges are alias-blind. This projects it to a FILE-level graph the
// UI can render: one node per source file, carrying graphify's community (Leiden)
// + the trustworthy alias-resolved fan-in, with edges = the alias-resolved file→file
// import graph (from alias-resolve.mjs `edges`). Each node is tagged with which
// hotspot kinds it belongs to so the UI can FILTER/highlight hotspots over the
// real code structure.
//
// Emits graph-ui.json (CanvasNode/CanvasLink-shaped) the daemon uploads to S3.
//
// USAGE: node graph-project.mjs <graphifyOutDir> [--repo <root>] [--max-nodes N]

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const outDir = path.resolve(args[0] || '.')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const MAX_NODES = parseInt(flag('--max-nodes') || '1500', 10)
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

const graph = readJson(path.join(outDir, 'graph.resolved.json')) || readJson(path.join(outDir, 'graph.json'))
if (!graph) { console.error(`! no graph.json in ${outDir}`); process.exit(1) }
const resolved = readJson(path.join(outDir, 'resolved-imports.json')) || {}
const hotspots = readJson(path.join(outDir, 'hotspots.json')) || { hotspots: [] }

const isFile = (s) => /\.(tsx?|jsx?|mjs|cjs)$/.test(s || '')
const base = (f) => (f ? f.split('/').pop() : f)

// ── 1. file nodes (one per source_file) with community + fan-in ──
const inDeg = new Map((resolved.hubs || []).map((h) => [h.file, h.inDegree]))
const fileNodes = new Map() // source_file -> { community, fanIn }
for (const n of graph.nodes || []) {
  const f = n.source_file
  if (!f || !isFile(f)) continue
  // a node IS the file when its label is the filename; else it's a symbol inside it.
  const isFileNode = isFile(n.label)
  const prev = fileNodes.get(f) || { community: null, fanIn: inDeg.get(f) ?? n.resolved_in_degree ?? 0 }
  if (isFileNode && n.community != null) prev.community = n.community
  if (prev.community == null && n.community != null) prev.community = n.community // fallback: any symbol's community
  fileNodes.set(f, prev)
}

// ── 2. hotspot membership per file (so the UI can filter/highlight) ──
const hotspotKindsByFile = new Map()
const addMember = (f, kind) => {
  const p = f.split('  (')[0] // strip "(N files)" version-root suffix
  if (!hotspotKindsByFile.has(p)) hotspotKindsByFile.set(p, new Set())
  hotspotKindsByFile.get(p).add(kind)
}
for (const h of hotspots.hotspots || []) {
  for (const f of h.files || []) addMember(f, h.kind)
  // version-root evidence carries dir roots, not files — tag the dir prefix too
  for (const r of h.evidence?.roots || []) if (r.root) addMember(r.root, h.kind)
}

// ── 3. edges = alias-resolved file→file import graph ──
let edges = (resolved.edges || []).filter((e) => fileNodes.has(e.source) && fileNodes.has(e.target))

// ── 4. cap for renderability: keep the most-connected + all hotspot files ──
const degree = new Map()
for (const e of edges) {
  degree.set(e.source, (degree.get(e.source) || 0) + 1)
  degree.set(e.target, (degree.get(e.target) || 0) + 1)
}
let files = [...fileNodes.keys()]
let capped = false
if (files.length > MAX_NODES) {
  capped = true
  const ranked = files.sort((a, b) => {
    const ah = hotspotKindsByFile.has(a) ? 1e6 : 0 // hotspot files always kept
    const bh = hotspotKindsByFile.has(b) ? 1e6 : 0
    return bh + (degree.get(b) || 0) - (ah + (degree.get(a) || 0))
  })
  files = ranked.slice(0, MAX_NODES)
  const keep = new Set(files)
  edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
}
const keep = new Set(files)

// ── 5. emit CanvasNode/CanvasLink shape (+ community/fanIn/hotspot/role metadata) ──
// fileRoles (from alias-resolve, via the shared privacy-detectors) tags WHERE infra
// is established / where 3rd-party services are called / which AI + db are used — so
// the graph (and the AI agent exploring it) can distinguish these node classes.
const fileRoles = resolved.fileRoles || {}
const nodes = files.map((f) => {
  const meta = fileNodes.get(f)
  const kinds = [...(hotspotKindsByFile.get(f) || [])]
  const fr = fileRoles[f]
  return {
    id: f,
    title: base(f),
    type: 'file',
    kind: 'file',
    community: meta.community,
    fanIn: meta.fanIn,
    hotspotKinds: kinds, // [] for non-hotspot files
    isHotspot: kinds.length > 0,
    // architecture/privacy role: 'infra' | 'db' | 'ai' | 'thirdParty' | null
    role: fr?.role ?? null,
    roleKinds: fr?.kinds ?? [],
    // concrete providers detected on this file (e.g. "Anthropic (Claude API)") —
    // the agent reads these to answer "what 3rd-party services / which AI".
    providers: fr ? fr.detections.map((d) => ({ provider: d.provider, kind: d.kind, residency: d.residency })) : [],
  }
})
const links = edges.map((e) => ({ source: e.source, target: e.target, type: 'IMPORTS' }))
const communities = new Set(nodes.map((n) => n.community).filter((c) => c != null)).size

const ui = {
  generatedAt: null,
  repo: graph.repo || resolved.repo || null,
  nodeCount: nodes.length,
  edgeCount: links.length,
  communities,
  capped,
  totalFiles: fileNodes.size,
  nodes,
  links,
}
fs.writeFileSync(path.join(outDir, 'graph-ui.json'), JSON.stringify(ui))
console.log(`graph-ui.json: ${nodes.length} file nodes · ${links.length} edges · ${communities} communities${capped ? ` (capped from ${fileNodes.size})` : ''}`)
