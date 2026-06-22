#!/usr/bin/env node
// hotspot-detect.mjs — L2→L3 bridge for the refactoring assessment pipeline.
//
// Fuses three deterministic feeds into ONE ranked, auto-generated hotspot list that feeds the
// L3 `/assess-codebase` dynamic workflow — replacing the human who used to read god-nodes and
// type the hypothesis. Makes "point it at any migrated app" true.
//
// FEEDS:
//   1. graphify graph.json      — ownership (method/contains out-edges), communities, cohesion
//   2. resolved-imports.json    — alias-resolved fan-in / hubs (from alias-resolve.mjs)
//   3. knip --reporter json     — dead files/exports (optional; TS-resolver-backed, reliable)
//
// HOTSPOT KINDS: god-object · duplicate-subsystem · design-system-consolidation ·
//                low-cohesion-split · dead-code
//
// USAGE:
//   node hotspot-detect.mjs <graphifyOutDir> [--repo <root>] [--knip <knip.json>] [--top N]

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const outDir = path.resolve(args[0] || '.')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const repo = flag('--repo') || path.dirname(outDir)
const knipPath = flag('--knip') || path.join(outDir, 'knip.json')
const TOP = parseInt(flag('--top') || '40', 10)

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// prefer the resolved graph (carries resolved_in_degree)
const graph = readJson(path.join(outDir, 'graph.resolved.json')) || readJson(path.join(outDir, 'graph.json'))
if (!graph) { console.error(`! no graph.json/graph.resolved.json in ${outDir}`); process.exit(1) }
const resolved = readJson(path.join(outDir, 'resolved-imports.json'))
const knip = readJson(knipPath)

const nodes = graph.nodes || []
const links = graph.links || []
const byId = new Map(nodes.map(n => [n.id, n]))
const isFileNode = (n) => /\.(tsx?|jsx?|mjs|cjs)$/.test(n.label || '')
const dirOf = (f) => f ? f.split('/').slice(0, -1).join('/') : '?'
const base = (f) => f ? f.split('/').pop() : '?'

// fan-in per file from the resolver (authoritative on alias-heavy code)
const inDegByFile = new Map((resolved?.hubs || []).map(h => [h.file, h.inDegree]))
const importersOf = (n) => inDegByFile.get(n.source_file) ?? n.resolved_in_degree ?? 0

// ownership out-degree per node
const methodsOut = new Map(), containsOut = new Map()
const STRUCT = new Set(['contains', 'method', 'imports', 'calls', 're_exports'])
for (const l of links) {
  if (l.relation === 'method') methodsOut.set(l.source, (methodsOut.get(l.source) || 0) + 1)
  if (l.relation === 'contains') containsOut.set(l.source, (containsOut.get(l.source) || 0) + 1)
}

const hotspots = []
const sev = (s) => s >= 80 ? 'critical' : s >= 55 ? 'high' : s >= 30 ? 'medium' : 'low'

// ---------- 1. GOD-OBJECTS (class with many methods + many importers) ----------
for (const n of nodes) {
  const methods = methodsOut.get(n.id) || 0
  if (methods < 12) continue
  const imp = importersOf(n)
  const score = Math.min(100, methods * 1.2 + imp)
  hotspots.push({
    kind: 'god-object', score, severity: sev(score),
    title: `God-object: ${n.label} (${methods} methods, ${imp} importers)`,
    files: [n.source_file], evidence: { methods, importers: imp, community: n.community },
    suggestedAction: `Split ${n.label} into ~${Math.max(2, Math.round(methods / 7))} domain repositories along its method seams; repoint importers per-domain.`,
  })
}

// ---------- 2. DUPLICATE SUBSYSTEMS (same basename across dirs + version markers) ----------
// Exclude framework-convention filenames — these are REQUIRED to repeat, not duplication.
const CONVENTION = new Set(['route.ts', 'route.tsx', 'route.js', 'page.tsx', 'page.jsx', 'layout.tsx',
  'loading.tsx', 'error.tsx', 'not-found.tsx', 'template.tsx', 'default.tsx', 'middleware.ts',
  'index.ts', 'index.tsx', 'index.js', 'opengraph-image.tsx', 'sitemap.ts', 'robots.ts'])
const isUiFile = (f) => /components\/(ui|primitives)\//.test(f || '')
const fileNodes = nodes.filter(isFileNode)
const byBase = new Map()
for (const n of fileNodes) {
  const b = base(n.source_file)
  if (CONVENTION.has(b)) continue // framework convention, not duplication
  if (!byBase.has(b)) byBase.set(b, new Map())
  byBase.get(b).set(n.source_file, importersOf(n)) // dedupe per file
}
const dsComponentDups = [] // UI-component dups → rolled up under design-system-consolidation
for (const [b, files] of byBase) {
  if (files.size < 2) continue
  const list = [...files.entries()].map(([f, imp]) => ({ f, imp })).sort((a, z) => z.imp - a.imp)
  const totalImp = list.reduce((s, x) => s + x.imp, 0)
  if (totalImp === 0) continue // both dead → handled by dead-code, not duplication
  if (list.every(x => isUiFile(x.f))) { dsComponentDups.push({ name: b, copies: list.length, importers: totalImp }); continue }
  const score = Math.min(100, 25 + list.length * 8 + Math.min(40, totalImp / 3))
  hotspots.push({
    kind: 'duplicate-subsystem', score, severity: sev(score),
    title: `Duplicate "${b}" in ${list.length} locations (Σ${totalImp} importers)`,
    files: list.map(x => x.f), evidence: { copies: list },
    suggestedAction: `Consolidate the ${list.length} "${b}" implementations onto the highest-fan-in one (${list[0].f}); repoint the rest, then delete after grep shows zero dependents.`,
  })
}
const VER = /(-v[123]\b|version[123]|enhanced|hierarchical|legacy|deprecated|-old\b|-new\b|copy|_bak)/i
const verFiles = [...new Set(fileNodes.map(n => n.source_file).filter(f => VER.test(f)))]
if (verFiles.length) {
  const score = Math.min(100, 30 + verFiles.length * 2)
  hotspots.push({
    kind: 'duplicate-subsystem', score, severity: sev(score),
    title: `Version-marker files (legacy candidates): ${verFiles.length}`,
    files: verFiles.slice(0, 30), evidence: { count: verFiles.length },
    suggestedAction: `Adjudicate each version-marked path: confirm the current version, prove the old one orphaned (resolved in-degree + grep), then retire via extract→repoint→delete.`,
  })
}

// ---------- 3. DESIGN-SYSTEM CONSOLIDATION (canonical UI hub vs duplicate UI dirs) ----------
const uiDirs = new Map()
for (const n of fileNodes) {
  const m = /(.*components\/(?:ui|primitives))\//.exec(n.source_file || '')
  if (!m) continue
  uiDirs.set(m[1], (uiDirs.get(m[1]) || 0) + importersOf(n))
}
if (uiDirs.size > 1) {
  const ranked = [...uiDirs.entries()].sort((a, z) => z[1] - a[1])
  const [canonical] = ranked[0]
  const dups = ranked.slice(1)
  const score = Math.min(100, 40 + dups.reduce((s, [, v]) => s + v, 0))
  const topDups = dsComponentDups.sort((a, z) => z.importers - a.importers).slice(0, 12)
  hotspots.push({
    kind: 'design-system-consolidation', score, severity: sev(score),
    title: `Duplicate design system: ${ranked.length} UI dirs, ${dsComponentDups.length} duplicated components (canonical: ${canonical})`,
    files: ranked.map(([d]) => d),
    evidence: { canonical, byDir: Object.fromEntries(ranked), duplicatedComponents: topDups },
    suggestedAction: `Adopt ${canonical} as the single design system; migrate the ${dsComponentDups.length} duplicated components (top: ${topDups.slice(0, 6).map(d => d.name).join(', ')}) in ${dups.map(d => d[0]).join(', ')} onto it, then delete the duplicates.`,
  })
}

// ---------- 4. LOW-COHESION SPLIT CANDIDATES ----------
const commNodes = new Map(), internal = new Map(), boundary = new Map()
for (const n of nodes) { const c = n.community; if (c == null) continue; commNodes.set(c, (commNodes.get(c) || []).concat(n)) }
for (const l of links) {
  if (!STRUCT.has(l.relation)) continue
  const s = byId.get(l.source), t = byId.get(l.target)
  if (!s || !t || s.community == null || t.community == null) continue
  if (s.community === t.community) internal.set(s.community, (internal.get(s.community) || 0) + 1)
  else { boundary.set(s.community, (boundary.get(s.community) || 0) + 1); boundary.set(t.community, (boundary.get(t.community) || 0) + 1) }
}
const labelComm = (c) => {
  const ns = commNodes.get(c) || []
  const top = [...ns].sort((a, z) => importersOf(z) - importersOf(a))[0]
  return top ? `${base(dirOf(top.source_file))}/… (${top.label})` : `community ${c}`
}
for (const [c, ns] of commNodes) {
  if (ns.length < 25) continue
  const inE = internal.get(c) || 0, bE = boundary.get(c) || 0
  const cohesion = inE + bE === 0 ? 0 : inE / (inE + bE)
  if (cohesion > 0.12) continue
  const score = Math.min(100, 30 + ns.length / 2 + (0.12 - cohesion) * 200)
  hotspots.push({
    kind: 'low-cohesion-split', score, severity: sev(score),
    title: `Low-cohesion module (${ns.length} nodes, cohesion ${cohesion.toFixed(3)}): ${labelComm(c)}`,
    files: [...new Set(ns.map(n => n.source_file))].slice(0, 12),
    evidence: { size: ns.length, cohesion: +cohesion.toFixed(3), community: c },
    suggestedAction: `Grab-bag module — re-cluster by responsibility and split along the internal seams.`,
  })
}

// ---------- 5. DEAD-CODE (knip ∩ zero resolved fan-in = high confidence) ----------
if (knip) {
  // knip --reporter json shape: { files: [...], issues: [{file, exports, ...}] } (version-dependent)
  const deadFiles = new Set([...(knip.files || []), ...((knip.issues || []).filter(i => i.unused || i.isUnused).map(i => i.file))].filter(Boolean))
  const confirmed = [...deadFiles].filter(f => (inDegByFile.get(f) ?? 0) === 0)
  if (confirmed.length) {
    const score = Math.min(70, 20 + confirmed.length)
    hotspots.push({
      kind: 'dead-code', score, severity: sev(score),
      title: `Dead files: ${confirmed.length} knip-flagged AND zero resolved fan-in`,
      files: confirmed.slice(0, 40), evidence: { knipFlagged: deadFiles.size, confirmedZeroFanIn: confirmed.length },
      suggestedAction: `Safe-delete candidates (two methods agree). Still gate behind a behavioral net; verify no dynamic import via grep.`,
    })
  }
} else {
  console.error(`! no knip.json at ${knipPath} — dead-code category skipped. Generate: cd ${repo} && npx knip --reporter json > ${path.join(outDir, 'knip.json')}`)
}

// ---------- rank + emit ----------
hotspots.sort((a, z) => z.score - a.score)
const out = { generatedAt: null, repo, graphifyOutDir: outDir, counts: {}, hotspots: hotspots.slice(0, TOP) }
for (const h of hotspots) out.counts[h.kind] = (out.counts[h.kind] || 0) + 1
fs.writeFileSync(path.join(outDir, 'hotspots.json'), JSON.stringify(out, null, 2))

console.log(`HOTSPOTS for ${path.basename(repo)} — ${hotspots.length} found\n`)
console.log(`by kind: ${Object.entries(out.counts).map(([k, v]) => `${k}=${v}`).join('  ')}\n`)
for (const h of hotspots.slice(0, TOP)) {
  console.log(`[${h.severity.toUpperCase().padEnd(8)} ${String(Math.round(h.score)).padStart(3)}] ${h.title}`)
}
console.log(`\nwrote ${path.join(path.relative(repo, outDir) || outDir, 'hotspots.json')} (top ${Math.min(TOP, hotspots.length)})`)
