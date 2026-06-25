#!/usr/bin/env node
// alias-resolve.mjs — L2 post-processor for the refactoring assessment pipeline.
//
// WHY: graphify (and any naive AST extractor) does NOT resolve `@/…` tsconfig path-alias
// imports to their target, so inbound/usage/fan-in/dead-code/design-system-hub reads are
// false on alias-heavy TS codebases (applicator is ~77% aliased). Proof case: Button shows
// graph in-degree ~1 but is imported by ~115 files.
//
// WHAT: independently recompute the file-level import graph from SOURCE with alias +
// extension + index resolution, keyed by source_file (stable, present on every graph node).
// Emit trustworthy per-file in-degree, the hub list, and (optionally) merge `resolved_in_degree`
// onto graphify graph nodes.
//
// USAGE:
//   node alias-resolve.mjs <repoRoot> [--graph <graph.json>] [--benchmark <relPath>] [--src <subdir>]
//
// NOT a dependency-heavy tool: regex import extraction (good enough to count hubs). Hardening
// path = ts-morph / TS language service for exact symbol-level resolution.

import fs from 'node:fs'
import path from 'node:path'
import { classifyFile, primaryRole } from './privacy-detectors.mjs'

const args = process.argv.slice(2)
const repoRoot = path.resolve(args[0] || '.')
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const graphPath = flag('--graph')
const benchmark = flag('--benchmark') // e.g. src/components/ui/button.tsx
const srcSub = flag('--src') || 'src'
const srcRoot = path.join(repoRoot, srcSub)

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage'])

// --- JSONC: strip comments WITHOUT touching `//` or `/*` inside string literals ---
function stripJsonc(s) {
  let out = '', i = 0, inStr = false, q = ''
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1]
    if (inStr) {
      out += c
      if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue }
      if (c === q) inStr = false
      i++; continue
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue }
    if (c === '/' && c2 === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out
}

// --- tsconfig paths ---
function loadAliases() {
  const tsPath = path.join(repoRoot, 'tsconfig.json')
  let aliases = []
  let baseUrl = repoRoot
  try {
    const raw = fs.readFileSync(tsPath, 'utf8')
    let cfg
    try { cfg = JSON.parse(raw) }                                   // most tsconfigs are valid JSON
    catch { cfg = JSON.parse(stripJsonc(raw).replace(/,(\s*[}\]])/g, '$1')) } // JSONC fallback
    const co = cfg.compilerOptions || {}
    if (co.baseUrl) baseUrl = path.resolve(repoRoot, co.baseUrl)
    for (const [pattern, targets] of Object.entries(co.paths || {})) {
      // "@/*": ["./src/*"]
      const from = pattern.replace(/\*$/, '')
      const to = (targets[0] || '').replace(/\*$/, '')
      aliases.push({ from, to: path.resolve(baseUrl, to) })
    }
  } catch (e) {
    console.error(`! could not read tsconfig paths: ${e.message}`)
  }
  return { aliases, baseUrl }
}

// --- walk source files ---
function walk(dir, acc = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (IGNORE.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, acc)
    else if (EXTS.includes(path.extname(e.name)) && !e.name.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

// --- extract import specifiers ---
const RE = [
  /(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, // import/export ... from '...'
  /\bimport\s*['"]([^'"]+)['"]/g,                            // side-effect import '...'
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,                      // dynamic import('...')
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,                     // require('...')
]
function specifiers(code) {
  const out = new Set()
  for (const re of RE) { let m; re.lastIndex = 0; while ((m = re.exec(code))) out.add(m[1]) }
  return [...out]
}

// --- resolve a specifier to an on-disk file ---
function resolveFile(p) {
  // exact file
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  for (const ext of EXTS) if (fs.existsSync(p + ext)) return p + ext
  // directory index
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    for (const ext of EXTS) { const idx = path.join(p, 'index' + ext); if (fs.existsSync(idx)) return idx }
  }
  return null
}
function resolveSpec(spec, importerDir, aliases) {
  if (spec.startsWith('.')) return resolveFile(path.resolve(importerDir, spec))
  for (const a of aliases) {
    if (spec === a.from.replace(/\/$/, '') || spec.startsWith(a.from)) {
      const rest = spec.slice(a.from.length)
      return resolveFile(path.join(a.to, rest))
    }
  }
  return null // bare/external
}

// --- main ---
const { aliases } = loadAliases()
console.log(`repo: ${repoRoot}`)
console.log(`aliases: ${aliases.map(a => `${a.from}* -> ${path.relative(repoRoot, a.to)}/*`).join(', ') || '(none)'}`)

const files = walk(srcRoot)
const rel = (f) => path.relative(repoRoot, f)

const inDeg = new Map()       // targetRel -> Set(importerRel)
const outDeg = new Map()      // importerRel -> Set(targetRel)
// per-file privacy/architecture role (infra/db/ai/thirdParty) for the graph view —
// SAME shared detectors the internal privacy scanner uses, so "the graph distinguishes
// where infra is established vs where 3rd-party services are called" stays in lockstep.
const fileRoles = {}          // relFile -> { role, kinds, detections:[{kind,provider,residency}] }
let total = 0, resolvedAlias = 0, unresolvedAlias = 0, external = 0

for (const f of files) {
  const code = fs.readFileSync(f, 'utf8')
  const dir = path.dirname(f)
  const fr = rel(f)
  const specs = specifiers(code)
  const { kinds, detections } = classifyFile(fr, specs)
  if (detections.length) fileRoles[fr] = { role: primaryRole(kinds), kinds, detections }
  for (const spec of specs) {
    total++
    const isAlias = aliases.some(a => spec === a.from.replace(/\/$/, '') || spec.startsWith(a.from))
    const target = resolveSpec(spec, dir, aliases)
    if (!target) {
      if (isAlias) unresolvedAlias++
      else if (!spec.startsWith('.')) external++
      continue
    }
    if (isAlias) resolvedAlias++
    const tr = rel(target)
    if (tr === fr) continue
    if (!inDeg.has(tr)) inDeg.set(tr, new Set())
    inDeg.get(tr).add(fr)
    if (!outDeg.has(fr)) outDeg.set(fr, new Set())
    outDeg.get(fr).add(tr)
  }
}

const rank = [...inDeg.entries()].map(([t, s]) => ({ file: t, inDegree: s.size })).sort((a, b) => b.inDegree - a.inDegree)

console.log(`\nfiles scanned: ${files.length}`)
console.log(`import specifiers: ${total} | alias resolved: ${resolvedAlias} | alias UNresolved: ${unresolvedAlias} | external: ${external}`)
console.log(`resolved internal edges: ${[...outDeg.values()].reduce((n, s) => n + s.size, 0)}`)

console.log(`\n=== TOP 25 HUBS by resolved file in-degree ===`)
for (const r of rank.slice(0, 25)) console.log(`  in=${String(r.inDegree).padStart(3)}  ${r.file}`)

if (benchmark) {
  const b = rank.find(r => r.file === benchmark || r.file.endsWith(benchmark))
  console.log(`\n=== BENCHMARK: ${benchmark} ===`)
  console.log(`  resolved in-degree: ${b ? b.inDegree : 0}`)
}

// design-system hub signal: distribution over src/components/ui
const ui = rank.filter(r => /components\/(ui|primitives)\//.test(r.file))
if (ui.length) {
  const max = ui[0].inDegree
  const med = ui[Math.floor(ui.length / 2)].inDegree
  console.log(`\n=== DESIGN-SYSTEM signal (components/ui|primitives) ===`)
  console.log(`  ${ui.length} primitive files | max in-degree ${max} | median ${med}`)
  console.log(`  verdict: ${max >= 20 ? 'HUB PRESENT (real design system) ✓' : 'flat/low — scattered, no hub'}`)
  for (const r of ui.slice(0, 8)) console.log(`     in=${String(r.inDegree).padStart(3)}  ${r.file}`)
}

// optional: merge resolved_in_degree onto graph nodes by source_file
if (graphPath && fs.existsSync(graphPath)) {
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  const byFile = new Map(rank.map(r => [r.file, r.inDegree]))
  let touched = 0
  for (const n of g.nodes || []) {
    if (n.source_file && byFile.has(n.source_file)) { n.resolved_in_degree = byFile.get(n.source_file); touched++ }
  }
  const outPath = graphPath.replace(/\.json$/, '.resolved.json')
  fs.writeFileSync(outPath, JSON.stringify(g))
  console.log(`\nmerged resolved_in_degree onto ${touched} graph nodes -> ${path.relative(repoRoot, outPath) || outPath}`)
}

// persist the resolved import map for the hotspot detector + the graph projection.
// edges = the trustworthy alias-resolved file→file import graph (graphify's own
// edges are alias-blind); the graph view renders these.
const edges = []
for (const [src, tset] of outDeg) for (const t of tset) edges.push({ source: src, target: t })
const outJson = {
  generatedAt: null,
  repo: repoRoot,
  filesScanned: files.length,
  aliasResolved: resolvedAlias,
  aliasUnresolved: unresolvedAlias,
  hubs: rank,
  edges,
  fileRoles,
}
const reconDir = graphPath ? path.dirname(graphPath) : path.join(repoRoot, 'graphify-out')
try { fs.mkdirSync(reconDir, { recursive: true }) } catch {}
fs.writeFileSync(path.join(reconDir, 'resolved-imports.json'), JSON.stringify(outJson, null, 2))
console.log(`wrote ${path.join(path.relative(repoRoot, reconDir) || reconDir, 'resolved-imports.json')}`)
