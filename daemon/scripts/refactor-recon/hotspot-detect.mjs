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
// Default high so the REPORT is complete (no silent truncation); L3 passes its
// own smaller --top for token-bounding. detectedCount/shownCount surface any cap.
const TOP = parseInt(flag('--top') || '500', 10)

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
// Role-aware advice: a Repository/Adapter with many methods is often legitimate
// (CRUD per table / per-provider), so "split into N domain repositories" is wrong
// advice. Tailor the suggestion to the class role and note when it may be by-design.
function classRole(label) {
  if (/Repository$/.test(label)) return 'repository'
  if (/Adapter$/.test(label)) return 'adapter'
  if (/(Service|Manager|Engine|Orchestrator)$/.test(label)) return 'service'
  return 'class'
}
function godAdvice(label, role, methods) {
  const n = Math.max(2, Math.round(methods / 7))
  switch (role) {
    case 'repository':
      return `${label} is already a repository (${methods} methods). A single-table repo with many CRUD/query methods is often legitimate — confirm it spans multiple aggregates before splitting; if so, split by bounded context (e.g. reads vs writes, or per-entity), NOT into more generic "repositories".`
    case 'adapter':
      return `${label} is an adapter (${methods} methods). Extract shared behavior into a thin base adapter and keep provider-specifics small; do NOT split into "repositories".`
    case 'service':
      return `Split ${label} along responsibility seams into ~${n} focused services; repoint callers per-responsibility.`
    default:
      return `Split ${label} along its method seams into ~${n} smaller units; repoint importers per-unit.`
  }
}
for (const n of nodes) {
  const methods = methodsOut.get(n.id) || 0
  if (methods < TH.godObjectMinMethods) continue
  const imp = importersOf(n)
  const role = classRole(n.label || '')
  // a low-fan-in repository/adapter is very likely by-design → soften the score a touch
  const score = Math.min(100, methods * 1.2 + imp) * (role === 'repository' || role === 'adapter' ? 0.85 : 1)
  hotspots.push({
    kind: 'god-object', score, severity: sev(score),
    title: `God-object: ${n.label} (${methods} methods, ${imp} importers)`,
    files: [n.source_file], evidence: { methods, importers: imp, community: n.community, role, file: n.source_file },
    suggestedAction: godAdvice(n.label, role, methods),
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
const DUP_EXCLUDE_DIRS = calibration.duplicateExcludeDirs || ['variants', '__mocks__', '__fixtures__']
const inDupExcludedDir = (f) => DUP_EXCLUDE_DIRS.some((d) => (f || '').includes(`/${d}/`)) // fix#2
const UI_DIR_RE = new RegExp(calibration.uiDirPattern)
const isUiFile = (f) => UI_DIR_RE.test(f || '')
const fileNodes = nodes.filter(isFileNode)
const IS_TEST = (f) => /(^|\/)__tests__\//.test(f) || /\.(test|spec)\.[tj]sx?$/.test(f)
// migration scripts describe moving TO the new model — not a legacy root (fix#1)
const IS_MIGRATION = (f) => /(^|\/)migrations?\//.test(f) || /(^|\/)migrate-/.test(f)

// --- 2a. VERSION ROOTS first (so dup detection can defer legacy copies to them) ---
// Cluster version-marked paths by their FIRST marked segment (the "version root"),
// so a whole versioned dir (onboarding-v2/**) collapses to ONE legacy-root candidate.
const VER = new RegExp(calibration.versionMarkerPattern, 'i')
const verRoots = new Map() // versionRoot -> Set(files)
for (const n of fileNodes) {
  const f = n.source_file
  if (!f || IS_TEST(f) || IS_MIGRATION(f)) continue
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
// A NUMERIC version (…-v2/version2) is legacy only if NOT the highest in its family
// (v2+v3 → v3 current, drop; lone -v2 stays). Non-numeric markers stay flagged.
function numericVersion(root) {
  const seg = root.split('/').pop() || ''
  const m = seg.match(/(?:-v|version)([0-9]+)\b/i)
  if (!m) return null
  // Family = the version-stripped basename (ext + dir-agnostic), so onboarding-v2/
  // (a dir) and types/onboarding-v3.ts (a file elsewhere) are the SAME family —
  // v3 is then recognized as current and onboarding-v3.ts isn't flagged legacy.
  const family = seg
    .replace(/(?:-v|version)[0-9]+\b/i, '')
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '')
    .toLowerCase()
  return { family, version: parseInt(m[1], 10) }
}
const maxByFamily = new Map()
const versionsByFamily = new Map()
for (const root of verRoots.keys()) {
  const v = numericVersion(root)
  if (!v) continue
  maxByFamily.set(v.family, Math.max(maxByFamily.get(v.family) ?? 0, v.version))
  if (!versionsByFamily.has(v.family)) versionsByFamily.set(v.family, new Set())
  versionsByFamily.get(v.family).add(v.version)
}
const legacyRoots = [...verRoots.entries()].filter(([root]) => {
  const v = numericVersion(root)
  const isCurrent = v && v.version === maxByFamily.get(v.family) && versionsByFamily.get(v.family).size >= 2
  return !isCurrent
})
const legacyPrefixes = legacyRoots.map(([root]) => root)
const inLegacyRoot = (f) => legacyPrefixes.some((p) => f === p || f.startsWith(p + '/')) // fix#3

// --- 2b. basename duplicate detection ---
const byBase = new Map()
for (const n of fileNodes) {
  const f = n.source_file
  const b = base(f)
  if (CONVENTION.has(b) || CO_LOCATED.has(b)) continue // recurs per-module, not duplication
  if (inDupExcludedDir(f)) continue // intentional sibling variants/mocks (fix#2)
  if (!byBase.has(b)) byBase.set(b, new Map())
  byBase.get(b).set(f, importersOf(n)) // dedupe per file
}
const dsComponentDups = [] // UI-component dups → rolled up under design-system-consolidation
for (const [b, files] of byBase) {
  if (files.size < 2) continue
  // fix#3: drop copies inside a flagged legacy root (retired wholesale by the
  // version-marker finding); if <2 remain it's not a standalone duplicate.
  const list = [...files.entries()]
    .map(([f, imp]) => ({ f, imp }))
    .filter((x) => !inLegacyRoot(x.f))
    .sort((a, z) => z.imp - a.imp)
  if (list.length < 2) continue
  const totalImp = list.reduce((s, x) => s + x.imp, 0)
  if (totalImp === 0) continue // both dead → handled by dead-code, not duplication
  if (list.every((x) => isUiFile(x.f))) { dsComponentDups.push({ name: b, copies: list.length, importers: totalImp }); continue }
  const score = Math.min(100, 25 + list.length * 8 + Math.min(40, totalImp / 3))
  hotspots.push({
    kind: 'duplicate-subsystem', score, severity: sev(score),
    title: `Duplicate "${b}" in ${list.length} locations (Σ${totalImp} importers)`,
    files: list.map((x) => x.f), evidence: { copies: list },
    suggestedAction: `Consolidate the ${list.length} "${b}" implementations onto the highest-fan-in one (${list[0].f}); repoint the rest, then delete after grep shows zero dependents.`,
  })
}

// --- 2c. emit the version-marker hotspot ---
if (legacyRoots.length) {
  const roots = legacyRoots
    .map(([root, files]) => ({ root, files: files.size }))
    .sort((a, z) => z.files - a.files)
  const totalFiles = roots.reduce((s, r) => s + r.files, 0)
  const score = Math.min(100, 30 + roots.length * 4)
  hotspots.push({
    kind: 'duplicate-subsystem', score, severity: sev(score),
    title: `Version-marked paths: ${roots.length} legacy root(s) (${totalFiles} files)`,
    files: roots.slice(0, 30).map((r) => `${r.root}  (${r.files} file${r.files === 1 ? '' : 's'})`),
    evidence: { count: roots.length, totalFiles, roots: roots.slice(0, 20) },
    suggestedAction: `Each is a legacy candidate (the current/highest version is excluded). Confirm it's superseded, prove the old root orphaned (resolved in-degree + grep), then retire the whole root via extract→repoint→delete.`,
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
let knipStatus = 'ok'
if (knip) {
  const deadFiles = parseKnipDeadFiles(knip)
  if (deadFiles.length === 0) knipStatus = 'empty'
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
  // knip unavailable (brownfield clone has no node_modules on the recon box, or
  // knip crashed). Fall back to a DEPS-FREE weak signal: alias-resolved zero-fan-in
  // files that aren't entrypoints/conventions/tests. Clearly labelled needs-review.
  knipStatus = 'unavailable'
  const EXCLUDE_DEAD = (f) =>
    CONVENTION.has(base(f)) ||
    CO_LOCATED.has(base(f)) ||
    IS_TEST(f) ||
    /\.d\.ts$/.test(f) ||
    /\.config\.[tj]s$/.test(f) ||
    /\.stories\.[tj]sx?$/.test(f) ||
    /(^|\/)(middleware|instrumentation)\.[tj]s$/.test(f)
  const orphans = fileNodes
    .map((n) => n.source_file)
    .filter(Boolean)
    .filter((f) => !inDegByFile.has(f) && !EXCLUDE_DEAD(f))
  if (orphans.length) {
    const score = Math.min(40, 12 + orphans.length / 4)
    hotspots.push({
      kind: 'dead-code', score, severity: sev(score),
      title: `Possible orphans: ${orphans.length} files with zero alias-resolved fan-in (no knip — needs-review)`,
      files: orphans.slice(0, 40),
      evidence: { confidence: 'needs-review', orphanCount: orphans.length, knip: 'unavailable' },
      suggestedAction: `knip was unavailable (the recon box has no node_modules for this clone), so this is the WEAKER alias-resolve-only signal: files nothing imports. Expect false positives (route entrypoints, dynamic imports, string registries). Adjudicate each; do NOT auto-delete. For a high-confidence pass, run recon with the project's deps installed so knip can cross-check.`,
    })
  }
  console.error(`! no/empty knip.json at ${knipPath} — using deps-free orphan fallback (${orphans.length} candidates).`)
}

// ---------- rank + emit ----------
hotspots.sort((a, z) => z.score - a.score)
const emitted = hotspots.slice(0, TOP)
const out = {
  generatedAt: null,
  repo,
  graphifyOutDir: outDir,
  // No silent truncation: counts are over the EMITTED set (match what's shown);
  // detectedCount vs shownCount surface any cap.
  detectedCount: hotspots.length,
  shownCount: emitted.length,
  toolStatus: { graphify: 'ok', knip: knipStatus },
  counts: {},
  hotspots: emitted,
}
for (const h of emitted) out.counts[h.kind] = (out.counts[h.kind] || 0) + 1
fs.writeFileSync(path.join(outDir, 'hotspots.json'), JSON.stringify(out, null, 2))

console.log(`HOTSPOTS for ${path.basename(repo)} — ${hotspots.length} detected, ${emitted.length} shown (knip:${knipStatus})\n`)
console.log(`by kind: ${Object.entries(out.counts).map(([k, v]) => `${k}=${v}`).join('  ')}\n`)
for (const h of emitted) {
  console.log(`[${h.severity.toUpperCase().padEnd(8)} ${String(Math.round(h.score)).padStart(3)}] ${h.title}`)
}
console.log(`\nwrote ${path.join(path.relative(repo, outDir) || outDir, 'hotspots.json')} (${emitted.length} of ${hotspots.length})`)
