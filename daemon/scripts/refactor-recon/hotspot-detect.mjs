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
//   node hotspot-detect.mjs <graphifyOutDir> [--repo <root>] [--knip <knip.json>] [--top N] [--calibration <path>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const outDir = path.resolve(args[0] || '.')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const repo = flag('--repo') || path.dirname(outDir)
const knipPath = flag('--knip') || path.join(outDir, 'knip.json')
const TOP = parseInt(flag('--top') || '40', 10)

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// ── A4: calibration config (externalized framework heuristics) ──
// --calibration <path> overrides the sibling recon-calibration.json default so
// other frameworks can tune CONVENTION filenames / UI-dir / thresholds.
const calibration = loadCalibration(flag('--calibration') || path.join(HERE, 'recon-calibration.json'))

function loadCalibration(p) {
  const DEFAULTS = {
    conventionFilenames: ['route.ts', 'route.tsx', 'route.js', 'page.tsx', 'page.jsx', 'layout.tsx',
      'loading.tsx', 'error.tsx', 'not-found.tsx', 'template.tsx', 'default.tsx', 'middleware.ts',
      'index.ts', 'index.tsx', 'index.js', 'opengraph-image.tsx', 'sitemap.ts', 'robots.ts'],
    uiDirPattern: 'components/(ui|primitives)/',
    versionMarkerPattern: '(-v[123]\\b|version[123]|enhanced|hierarchical|legacy|deprecated|-old\\b|-new\\b|copy|_bak)',
    thresholds: { godObjectMinMethods: 12, lowCohesionMinNodes: 25, lowCohesionMaxCohesion: 0.12, severityCritical: 80, severityHigh: 55, severityMedium: 30 },
  }
  const loaded = readJson(p)
  if (!loaded) { if (p) console.error(`  (calibration ${p} unreadable — using built-in defaults)`); return DEFAULTS }
  // shallow-merge so a partial config still gets every default key
  return { ...DEFAULTS, ...loaded, thresholds: { ...DEFAULTS.thresholds, ...(loaded.thresholds || {}) } }
}

const TH = calibration.thresholds

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
const sev = (s) => s >= TH.severityCritical ? 'critical' : s >= TH.severityHigh ? 'high' : s >= TH.severityMedium ? 'medium' : 'low'

// strip a leading "./" / repo-abs prefix so knip paths and resolved-import keys compare
function normalizeRel(f) {
  if (!f) return f
  let r = String(f).replace(/^\.\//, '')
  if (path.isAbsolute(r)) { const rel = path.relative(repo, r); if (rel && !rel.startsWith('..')) r = rel }
  return r
}

// A2: parse `knip --reporter json` across versions. Known shapes:
//   v5+ object map:   { "files": ["a.ts", ...], "issues": [{ file, exports, ... }] }
//   older/array form: [{ file, ... }]  OR  { files: [{name|file}], ... }
//   "unused files" may live under .files (string[]), .issues[].file with a
//   files-type flag, or per-file issue objects with no exports. Be liberal.
function parseKnipDeadFiles(k) {
  const out = new Set()
  const add = (v) => { const r = normalizeRel(typeof v === 'string' ? v : (v?.file || v?.name)); if (r) out.add(r) }
  if (Array.isArray(k)) { for (const it of k) add(it); return [...out] }
  if (k && typeof k === 'object') {
    // top-level unused-files list (most common: string[])
    if (Array.isArray(k.files)) for (const f of k.files) add(f)
    // some versions nest unused files under issues with a type/marker
    if (Array.isArray(k.issues)) {
      for (const i of k.issues) {
        if (!i) continue
        // a whole-file issue: unused/isUnused flag, OR an issue with no symbol-level detail
        if (i.unused === true || i.isUnused === true || i.type === 'files') add(i.file || i.name)
        // some shapes carry { files: { 'path': true } } per issue
        if (i.files && typeof i.files === 'object' && !Array.isArray(i.files)) for (const f of Object.keys(i.files)) add(f)
      }
    }
    // object-map form { 'path/to/file.ts': { ... } } where the value flags a file
    for (const [key, val] of Object.entries(k)) {
      if (key === 'files' || key === 'issues') continue
      if (/\.(tsx?|jsx?|mjs|cjs)$/.test(key) && val) add(key)
    }
  }
  return [...out]
}

// ---------- 1. GOD-OBJECTS (class with many methods + many importers) ----------
for (const n of nodes) {
  const methods = methodsOut.get(n.id) || 0
  if (methods < TH.godObjectMinMethods) continue
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
// Exclude framework-convention filenames (route.ts ×N) AND generic co-located
// per-module files (types.ts/utils.ts/errors.ts …) — both legitimately recur
// once per module and are NOT a duplicated subsystem. Flagging "consolidate the
// 10 types.ts onto one" is wrong advice; genuine copy-paste dupes of these are
// left to L3 adjudication / manual review.
const CONVENTION = new Set(calibration.conventionFilenames)
const CO_LOCATED = new Set(calibration.coLocatedConventionFilenames || [])
const UI_DIR_RE = new RegExp(calibration.uiDirPattern)
const isUiFile = (f) => UI_DIR_RE.test(f || '')
const fileNodes = nodes.filter(isFileNode)
const byBase = new Map()
for (const n of fileNodes) {
  const b = base(n.source_file)
  if (CONVENTION.has(b) || CO_LOCATED.has(b)) continue // recurs per-module, not duplication
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
// Cluster version-marked paths by their FIRST version-marked path segment (the
// "version root"), so a whole versioned dir (onboarding-v2/**) collapses to ONE
// legacy-root candidate instead of flagging every file inside it (the inflated
// "135 version-marker files" bug). A file-level marker (draft-editor-v2.tsx)
// stays its own root.
const VER = new RegExp(calibration.versionMarkerPattern, 'i')
const verRoots = new Map() // versionRoot -> Set(files)
for (const n of fileNodes) {
  const f = n.source_file
  if (!f) continue
  const segs = f.split('/')
  let root = null
  const acc = []
  for (const seg of segs) {
    acc.push(seg)
    if (VER.test(seg)) { root = acc.join('/'); break }
  }
  if (!root) continue
  if (!verRoots.has(root)) verRoots.set(root, new Set())
  verRoots.get(root).add(f)
}
if (verRoots.size) {
  const roots = [...verRoots.entries()]
    .map(([root, files]) => ({ root, files: files.size }))
    .sort((a, z) => z.files - a.files)
  const totalFiles = roots.reduce((s, r) => s + r.files, 0)
  const score = Math.min(100, 30 + roots.length * 4)
  hotspots.push({
    kind: 'duplicate-subsystem', score, severity: sev(score),
    title: `Version-marked paths: ${roots.length} legacy root(s) (${totalFiles} files)`,
    files: roots.slice(0, 30).map(r => `${r.root}  (${r.files} file${r.files === 1 ? '' : 's'})`),
    evidence: { count: roots.length, totalFiles, roots: roots.slice(0, 20) },
    suggestedAction: `Each version-marked root is a legacy candidate. Confirm the current version, prove the old root orphaned (resolved in-degree + grep), then retire the whole root via extract→repoint→delete.`,
  })
}

// ---------- 3. DESIGN-SYSTEM CONSOLIDATION (canonical UI hub vs duplicate UI dirs) ----------
const uiDirs = new Map()
// derive the dir-capture from the calibrated UI pattern: capture everything up
// to and including the ui|primitives segment (drop the trailing slash group).
const UI_DIR_CAPTURE = new RegExp(`(.*${calibration.uiDirPattern.replace(/\/$/, '').replace('(ui|primitives)', '(?:ui|primitives)')})\\/`)
for (const n of fileNodes) {
  const m = UI_DIR_CAPTURE.exec(n.source_file || '')
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
  if (ns.length < TH.lowCohesionMinNodes) continue
  const inE = internal.get(c) || 0, bE = boundary.get(c) || 0
  const cohesion = inE + bE === 0 ? 0 : inE / (inE + bE)
  if (cohesion > TH.lowCohesionMaxCohesion) continue
  const score = Math.min(100, 30 + ns.length / 2 + (TH.lowCohesionMaxCohesion - cohesion) * 200)
  hotspots.push({
    kind: 'low-cohesion-split', score, severity: sev(score),
    title: `Low-cohesion module (${ns.length} nodes, cohesion ${cohesion.toFixed(3)}): ${labelComm(c)}`,
    files: [...new Set(ns.map(n => n.source_file))].slice(0, 12),
    evidence: { size: ns.length, cohesion: +cohesion.toFixed(3), community: c },
    suggestedAction: `Grab-bag module — re-cluster by responsibility and split along the internal seams.`,
  })
}

// ---------- 5. DEAD-CODE (knip ∩ resolved fan-in = confidence labels) ----------
// A2: robustly parse knip --reporter json ACROSS VERSIONS, then split the dead
// files into safe-candidate (knip says unused AND resolved fan-in 0 — two methods
// agree) vs needs-review (knip says unused but the resolver found importers — a
// likely knip miss on dynamic import / alias / string registry). Never blind-delete.
if (knip) {
  const deadFiles = parseKnipDeadFiles(knip)
  const safe = [], review = []
  for (const f of deadFiles) {
    const fanIn = inDegByFile.get(f) ?? inDegByFile.get(normalizeRel(f)) ?? 0
    ;(fanIn === 0 ? safe : review).push({ f, fanIn })
  }
  if (safe.length) {
    const score = Math.min(70, 20 + safe.length)
    hotspots.push({
      kind: 'dead-code', score, severity: sev(score),
      title: `Dead files: ${safe.length} safe-candidate (knip-unused AND zero resolved fan-in)`,
      files: safe.map(x => x.f).slice(0, 40),
      evidence: { knipFlagged: deadFiles.length, confirmedZeroFanIn: safe.length, needsReview: review.length, confidence: 'safe-candidate' },
      suggestedAction: `Safe-delete candidates (two methods agree). Still gate behind a behavioral net; verify no dynamic import via grep before deleting.`,
    })
  }
  if (review.length) {
    const score = Math.min(45, 15 + review.length)
    hotspots.push({
      kind: 'dead-code', score, severity: sev(score),
      title: `Possibly-dead files: ${review.length} knip-unused BUT resolver found importers (needs-review)`,
      files: review.map(x => x.f).slice(0, 40),
      evidence: { knipFlagged: deadFiles.length, needsReview: review.length, confidence: 'needs-review' },
      suggestedAction: `knip flagged these unused, but alias-resolution found importers — likely a knip miss (dynamic import / string registry / re-export). Adjudicate each before any delete; do NOT auto-remove.`,
    })
  }
  if (!deadFiles.length) console.error('  (knip.json parsed but reported no unused files)')
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
