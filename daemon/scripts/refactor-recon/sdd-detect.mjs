#!/usr/bin/env node
// sdd-detect.mjs — Refactoring Scan Engine v2, the SDD-readiness detector.
//
// Deterministic, ~0 LLM, CONTENT-SIGNAL based (NOT folder-based) so it works on
// cluttered brownfield repos with no docs/ or specs/ convention. Answers: does this
// codebase capture any DESIGN INTENT (ADRs, PRDs, design docs, user stories, API
// contracts), or is it just code? For a migration target, low SDD is the actionable
// signal — "no captured intent → characterize behavior before refactoring".
//
// Finds spec artifacts ANYWHERE by content: ADR templates, requirement language,
// Gherkin, architecture sections, mermaid, OpenAPI/GraphQL/protobuf/JSON-Schema.
//
// USAGE: node sdd-detect.mjs <repo> [--out file]

import fs from 'node:fs';
import path from 'node:path';

const slug = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);

const DOC_EXT = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const SPEC_EXT = /\.(ya?ml|json|graphql|gql|proto)$/i;

/** Classify a doc file by content signal → adr | prd | story | design | null. */
export function classifyDoc(rel, content) {
  const c = String(content || '');
  const low = rel.toLowerCase();
  const base = low.split('/').pop() || '';
  // ADR / decision record — by path, numbered filename, or the ADR template shape.
  if (
    /(^|\/)(adrs?|decisions?|rfcs?)\//.test(low) ||
    /^\d{3,4}[-_]/.test(base) ||
    /\b(adr|rfc)[-_ ]?\d/.test(base) ||
    (/^#{1,3}\s*status\b/im.test(c) && /^#{1,3}\s*(context|decision|consequences)\b/im.test(c))
  )
    return 'adr';
  // PRD / requirements — filename or requirement language.
  if (/\b(prd|product[-_ ]?requirement|requirements?)\b/i.test(base) || /\bacceptance criteria\b|\bfunctional requirements?\b|\bproduct requirements?\b|\bnon-functional requirements?\b/i.test(c))
    return 'prd';
  // user stories / epics / Gherkin.
  if (/\b(stor(y|ies)|epics?|user-stor)\b/i.test(base) || /\bas an?\s+.{1,40}?\s+i want\b/i.test(c) || /^\s*(Feature|Scenario|Given|When|Then)\s*:/m.test(c))
    return 'story';
  // design / architecture docs — filename or architecture sections / diagrams.
  if (/\b(architecture|design|spec|specification|hld|lld|tech-?spec|system-?design)\b/i.test(base) || /^#{1,3}\s*(architecture|system design|data model|high-level design|technical design)\b/im.test(c) || /```mermaid/i.test(c))
    return 'design';
  // a README with an architecture section counts as (light) design intent.
  if (/(^|\/)readme\.\w+$/i.test(rel) && /^#{1,3}\s*architecture\b/im.test(c)) return 'design';
  return null;
}

/** Detect an API/data contract (executable spec) → openapi | graphql | protobuf | asyncapi | jsonschema | null. */
export function detectApiContract(rel, content) {
  const c = String(content || '');
  if (/\.(graphql|gql)$/i.test(rel) || /\btype\s+(Query|Mutation|Subscription)\b/.test(c)) return 'graphql';
  if (/\.proto$/i.test(rel) || /^\s*syntax\s*=\s*["']proto[23]?["']/m.test(c)) return 'protobuf';
  if (/^\s*openapi\s*:\s*["']?\d/im.test(c) || /["']openapi["']\s*:\s*["']\d/.test(c) || /^\s*swagger\s*:\s*["']?\d/im.test(c) || /["']swagger["']\s*:\s*["']\d/.test(c)) return 'openapi';
  if (/^\s*asyncapi\s*:/im.test(c)) return 'asyncapi';
  if (/["']\$schema["']\s*:\s*["']https?:\/\/json-schema\.org/.test(c)) return 'jsonschema';
  return null;
}

const finding = (o) => ({
  id: o.id,
  dimension: 'architecture',
  area: 'sdd',
  severity: o.severity || 'Medium',
  effort: o.effort || 'Medium',
  location: o.location || 'multiple',
  issue: o.issue,
  suggestion: o.suggestion,
  evidence: { sdd: true, check: o.check, ...(o.evidence || {}) },
  source: 'deterministic',
  dependsOn: [],
});

const TYPES = ['adr', 'prd', 'story', 'design', 'apiContract'];

/**
 * Pure builder. @param files [{rel, content}] — docs + spec/contract files.
 * @returns { specs, summary, findings }
 */
export function buildSddReport(files = []) {
  const specs = [];
  const counts = { adr: 0, prd: 0, story: 0, design: 0, apiContract: 0 };
  for (const f of files) {
    const rel = f.rel;
    const content = typeof f.content === 'string' ? f.content : '';
    if (SPEC_EXT.test(rel)) {
      const api = detectApiContract(rel, content);
      if (api) { specs.push({ type: 'apiContract', subtype: api, file: rel }); counts.apiContract++; continue; }
    }
    if (DOC_EXT.test(rel)) {
      const t = classifyDoc(rel, content);
      if (t) { specs.push({ type: t, file: rel }); counts[t]++; }
    }
  }
  const specCount = specs.length;
  const signals = TYPES.filter((k) => counts[k] > 0).length;

  const findings = [];
  if (specCount === 0) {
    findings.push(finding({
      id: 'sdd:no-design-intent', check: 'no-design-intent', severity: 'Medium',
      issue: 'No captured design intent — no ADRs, PRDs, design docs, user stories, or API contracts found',
      suggestion: 'Before refactoring, capture behavior as characterization tests + a short design/ADR; a spec-less codebase cannot be changed safely or reasoned about by agents',
      evidence: { migrationRisk: true },
    }));
  } else if (counts.design > 0 && counts.adr === 0) {
    findings.push(finding({
      id: 'sdd:no-adrs', check: 'no-adrs', severity: 'Low', effort: 'Small',
      issue: `Design docs exist (${counts.design}) but no decision records (ADRs)`,
      suggestion: 'Record architectural decisions as ADRs (Status/Context/Decision/Consequences) so the "why" survives refactors',
    }));
  }
  if (counts.apiContract === 0 && specCount > 0) {
    findings.push(finding({
      id: 'sdd:no-api-contract', check: 'no-api-contract', severity: 'Low–Med', effort: 'Medium',
      issue: 'No machine-readable API contract (OpenAPI / GraphQL / protobuf) found',
      suggestion: 'Publish an API contract so consumers + tests + agents share one source of truth for the interface',
    }));
  }

  const summary = {
    hasSpecs: specCount > 0,
    specCount,
    signals,
    adrCount: counts.adr,
    prdCount: counts.prd,
    storyCount: counts.story,
    designDocCount: counts.design,
    apiContractCount: counts.apiContract,
    byType: counts,
  };
  return { specs: specs.slice(0, 200), summary, findings };
}

// ── CLI ──
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage', 'graphify-out', 'vendor']);
const READ = new RegExp(`${DOC_EXT.source}|${SPEC_EXT.source}`, 'i');
function walk(dir, root, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, acc);
    else if (READ.test(e.name)) acc.push(full);
  }
  return acc;
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'sdd.json');
  const files = [];
  for (const full of walk(repo, repo)) {
    const rel = path.relative(repo, full);
    let content = '';
    try { if (fs.statSync(full).size < 512 * 1024) content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    files.push({ rel, content });
  }
  const report = buildSddReport(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...report }, null, 2));
  const s = report.summary;
  console.error(`[sdd-detect] specs:${s.specCount} (adr:${s.adrCount} prd:${s.prdCount} design:${s.designDocCount} story:${s.storyCount} api:${s.apiContractCount}) signals:${s.signals}/5 → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
