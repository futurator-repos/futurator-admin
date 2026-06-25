#!/usr/bin/env node
// privacy-scan-internal.mjs — Futurator's OWN data-privacy scanner (the "internal"
// mode, vs the external GDPR service). Deterministic, ~0 LLM, fully local — the
// SOURCE NEVER LEAVES THE BOX (no network at all). Reuses the shared detectors
// (privacy-detectors.mjs) so it stays in lockstep with the graph's role-tagging.
//
// It answers the operator's questions structurally:
//   • which AI is used + how (Claude API vs Bedrock vs OpenAI…) — residency-aware
//   • where personal data is stored (db clients) + cross-border exposure
//   • where infrastructure is established (terraform/pulumi/sst/cdk/prisma)
//   • what 3rd-party services receive personal data (analytics, auth, email…)
//   • PII written to logs
//
// Emits the SAME report shape the external scanner produces, so the daemon's
// summarizePrivacyReport() + the dashboard render it unchanged.
//
// USAGE: node privacy-scan-internal.mjs <repo> [--src src] --out <file>

import fs from 'node:fs'
import path from 'node:path'
import { IMPORT_DETECTORS, classifyFile } from './privacy-detectors.mjs'

const args = process.argv.slice(2)
const repo = path.resolve(args[0] || '.')
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const src = flag('--src') || 'src'
const out = flag('--out')

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage'])
// Scope: skip docs/agent-prompt/test noise (the external scanner's biggest FP source).
const SKIP_PATH = (rel) =>
  /(^|\/)(docs|_bmad|__tests__|__mocks__|__fixtures__|\.agents)\//.test(rel) ||
  /\.(test|spec)\.[tj]sx?$/.test(rel) ||
  /\.d\.ts$/.test(rel)

const GDPR = 'https://eur-lex.europa.eu/eli/reg/2016/679/oj'
const AIACT = 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj'

const SPEC_RE = [
  /(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
]
function specifiers(code) {
  const set = new Set()
  for (const re of SPEC_RE) { let m; re.lastIndex = 0; while ((m = re.exec(code))) set.add(m[1]) }
  return [...set]
}

// PII-in-logs: a logging call on a line that also names a person-identifier.
const LOG_RE = /\b(console\.(log|info|warn|error|debug)|logger\.(log|info|warn|error|debug)|console\.dir)\s*\(/
const PII_RE = /\b(email|e-mail|password|passwd|ssn|phone|address|firstName|lastName|fullName|dateOfBirth|dob|creditCard|token|apiKey|api_key|secret)\b/i

function walk(dir, acc = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    if (IGNORE.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, acc)
    else if (EXTS.includes(path.extname(e.name)) || /\.(tf|prisma)$/.test(e.name) || /(^|\/)(serverless|template|cloudformation)\.ya?ml$/.test(full)) acc.push(full)
  }
  return acc
}

// ── category mapping: a detection → one or more privacy findings ──
function findingsFor(detection, file) {
  const { kind, provider, residency } = detection
  const base = { file, card: `[[${provider}]]`, confidence: 0.9 }
  const out = []
  if (kind === 'ai') {
    const external = residency === 'external' || residency === 'varies'
    out.push({
      ...base, regulation: 'EU AI Act', category: 'AI System In Use', score: external ? 85 : 55,
      severity: external ? 'high' : 'medium',
      title: `AI provider in use: ${provider}${residency === 'in-account' ? ' (in-account)' : ''}`,
      snippet: `import ${provider}`,
      remediation: 'Document the AI system (EU AI Act transparency); confirm a DPA with the provider; ensure no special-category personal data is sent without a lawful basis.',
      solution_ceiling: 'conditional', citation: [AIACT],
    })
    if (external) out.push({
      ...base, regulation: 'GDPR — Article 44 (Transfers)', category: 'Cross-border AI Data Transfer', score: 80, severity: 'high',
      title: `Personal data may be sent to a 3rd-party AI processor: ${provider}`,
      snippet: `import ${provider}`,
      remediation: 'Verify the processor location + transfer safeguards (SCCs/adequacy); minimize PII in prompts; log what is sent.',
      solution_ceiling: 'conditional', citation: [GDPR],
    })
  } else if (kind === 'db') {
    out.push({
      ...base, regulation: 'GDPR — Article 32 (Security)', category: 'Personal Data Store', score: residency === 'external' ? 75 : 65, severity: 'high',
      title: `Data store: ${provider} — verify encryption + access control`,
      snippet: `import ${provider}`,
      remediation: 'Confirm encryption at rest, least-privilege access, and an erasure/retention path (Art. 17). Map which personal-data fields are stored.',
      solution_ceiling: 'conditional', citation: [GDPR],
    })
  } else if (kind === 'infra') {
    out.push({
      ...base, regulation: 'GDPR — Data Residency', category: 'Infrastructure & Data Residency', score: 45, severity: 'medium',
      title: `Infrastructure defined via ${provider} — confirm region/residency`,
      snippet: provider, confidence: 0.95,
      remediation: 'Confirm the region(s) where personal data physically lives; assess CLOUD Act / cross-border exposure for non-EU regions.',
      solution_ceiling: 'conditional', citation: [GDPR],
    })
  } else if (kind === 'thirdParty') {
    const analytics = /analytics|telemetry|posthog|mixpanel|segment|sentry/i.test(provider)
    out.push({
      ...base, regulation: 'GDPR — Article 28 (Processor)', category: analytics ? '3rd-party Tracking — Consent' : '3rd-party Data Sharing',
      score: analytics ? 70 : 50, severity: analytics ? 'high' : 'medium',
      title: `${analytics ? 'Tracking/analytics' : '3rd-party service'}: ${provider}`,
      snippet: `import ${provider}`,
      remediation: analytics
        ? 'Gate behind explicit consent (Art. 6/7); disclose in the privacy notice; verify a DPA.'
        : 'Verify a signed DPA; minimize the personal data shared with the processor.',
      solution_ceiling: 'conditional', citation: [GDPR],
    })
  }
  return out
}

// ── scan ──
const t0 = Date.now()
const files = walk(path.join(repo, src)).concat(walk(path.join(repo, 'infra'))).filter((f, i, a) => a.indexOf(f) === i)
const allFindings = []
let scanned = 0
for (const f of files) {
  const rel = path.relative(repo, f)
  if (SKIP_PATH(rel)) continue
  scanned++
  let code = ''
  try { code = fs.readFileSync(f, 'utf8') } catch { continue }
  const { detections } = classifyFile(rel, EXTS.includes(path.extname(f)) ? specifiers(code) : [])
  for (const d of detections) for (const fnd of findingsFor(d, rel)) allFindings.push(fnd)
  // PII-in-logs (line-wise)
  let piiLogHit = false
  for (const line of code.split('\n')) { if (LOG_RE.test(line) && PII_RE.test(line)) { piiLogHit = true; break } }
  if (piiLogHit) allFindings.push({
    file: rel, regulation: 'GDPR — Article 32 (Security)', category: 'PII in Logs', score: 60, severity: 'high', confidence: 0.6,
    title: 'Possible personal data written to logs', snippet: 'logger/console call near a PII identifier',
    remediation: 'Redact or hash personal-data fields before logging; avoid logging tokens/credentials.',
    solution_ceiling: 'mechanical', card: '[[PII in Logs]]', citation: [GDPR],
  })
}

// ── group into by_regulation (regulation family from the finding's regulation string) ──
const regFamily = (r) => (/AI Act/i.test(r) ? 'eu-ai-act' : 'gdpr')
const by_regulation = {}
for (const fnd of allFindings) {
  const reg = regFamily(fnd.regulation)
  const slice = (by_regulation[reg] ??= { root: repo, regulation: reg, scanned_files: scanned, skipped_files: 0, summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 }, hotspots: [] })
  slice.hotspots.push(fnd)
  slice.summary[fnd.severity] = (slice.summary[fnd.severity] || 0) + 1
  slice.summary.total++
}
const regulations = Object.keys(by_regulation)

const report = {
  assessment: 'privacy-compliance',
  finding_contract_version: '1.0.0',
  scanner: 'internal',
  tier: 'internal',
  rulepack_source: 'internal:privacy-detectors.mjs',
  rulepack_version: null,
  cards_loaded: IMPORT_DETECTORS.length,
  root: repo,
  regulations,
  generated_at: null,
  duration_ms: Date.now() - t0,
  by_regulation,
}

const json = JSON.stringify(report, null, 2)
if (out) {
  fs.writeFileSync(path.resolve(out), json)
  console.error(`[privacy-scan-internal] ${scanned} files · ${allFindings.length} findings · ${regulations.join(',')} → ${out}`)
} else {
  process.stdout.write(json + '\n')
}
