#!/usr/bin/env node
// security-scan.mjs — Refactoring Scan Engine v2, the Security & Secrets/Env-hygiene
// detector. Deterministic, ~0 LLM, provider-agnostic, FILE-FIRST.
//
// Catches the things an LLM swarm misses SYSTEMATICALLY — hardcoded credentials,
// committed .env files, secrets shipped to the browser via public-prefixed env vars,
// dangerous sinks, insecure transport, and env-config hygiene. Every issue is emitted
// as a canonical deterministic ScanFinding (dimension safety-security / compliance /
// code-quality-refactoring) + a rolled-up summary for the "Secrets & config hygiene"
// maturity axis.
//
// A leaked key is three problems at once: a vulnerability (safety-security), a GDPR
// Art. 32 control failure (compliance), AND an uncontrolled COST surface (anyone can
// spend your Anthropic/Stripe credits) — so these findings cross-link cost + privacy.
//
// USAGE: node security-scan.mjs <repo> [--src src] [--out file]

import fs from 'node:fs';
import path from 'node:path';

const slug = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);

// ── 1. Hardcoded-secret patterns (provider tokens, private keys, conn strings) ──
const SECRET_PATTERNS = [
  { id: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key ID' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'Private key block' },
  { id: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, label: 'Anthropic API key' },
  { id: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/, label: 'OpenAI API key' },
  { id: 'github-pat', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, label: 'GitHub token' },
  { id: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { id: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { id: 'stripe-live', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, label: 'Stripe live secret key' },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}/, label: 'GitLab token' },
  { id: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, label: 'SendGrid API key' },
  { id: 'conn-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:'"@/]+:[^\s:'"@/]+@/, label: 'Connection string with embedded credentials' },
];

// generic `name = "literal"` for a secret-ish key (value not a placeholder / env-ref)
const GENERIC_ASSIGN = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|encryption[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{6,})\2/gi;
const PLACEHOLDER = /^(process\.env|import\.meta|\$\{|<|your[-_ ]|example|changeme|xxx+|placeholder|todo|dummy|sample|test|fake|none|null|undefined|\*+|\.\.\.|\$\(|env\.|secret_|my_)/i;
const isPlaceholder = (v) => !v || PLACEHOLDER.test(v) || /^[*x.\s-]+$/i.test(v) || new Set(v).size <= 2;

// env vars that ship to the client bundle (must never hold a secret)
const PUBLIC_PREFIX = /\b((?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|GATSBY|NUXT_PUBLIC|PUBLIC)_[A-Z0-9_]*?(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL)[A-Z0-9_]*)/g;
// hardcoded fallback for a secret: process.env.X_SECRET || 'literal'
const WEAK_FALLBACK = /\bprocess\.env\.([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*\|\|\s*(['"`])([^'"`\n]+)\2/g;

// ── 2. Dangerous sinks + insecure config ──
const SINKS = [
  { id: 'eval', re: /(?:^|[^.\w])eval\s*\(/, severity: 'High', dimension: 'safety-security', issue: 'eval() — arbitrary code execution risk', suggestion: 'Remove eval; use JSON.parse or an explicit dispatch table' },
  { id: 'new-function', re: /\bnew\s+Function\s*\(/, severity: 'High', dimension: 'safety-security', issue: 'new Function() builds code from strings — RCE risk', suggestion: 'Replace with a static function or a lookup table' },
  { id: 'exec-interp', re: /\bexec(?:Sync)?\s*\(\s*[`'"][^`'"]*\$\{/, severity: 'High', dimension: 'safety-security', issue: 'Shell exec with interpolated input — command injection', suggestion: 'Use execFile with an args array; never interpolate into a shell string' },
  { id: 'inner-html', re: /dangerouslySetInnerHTML|\.innerHTML\s*=/, severity: 'Medium', dimension: 'safety-security', issue: 'innerHTML sink — XSS if the value is untrusted', suggestion: 'Render as text, or sanitize with DOMPurify before injecting' },
  { id: 'sql-concat', re: /\b(?:query|execute|raw)\s*\(\s*[`'"][^`'"]*(?:SELECT|INSERT|UPDATE|DELETE)[^`'"]*['"`]\s*\+/i, severity: 'High', dimension: 'safety-security', issue: 'SQL built by string concatenation — injection risk', suggestion: 'Use parameterized queries / prepared statements' },
  { id: 'tls-off', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0/, severity: 'High', dimension: 'safety-security', issue: 'TLS certificate verification disabled', suggestion: 'Remove rejectUnauthorized:false / NODE_TLS_REJECT_UNAUTHORIZED=0; fix the cert chain instead' },
  { id: 'cors-star', re: /origin\s*:\s*['"]\*['"]|['"]Access-Control-Allow-Origin['"]\s*[:,]\s*['"]\*['"]/, severity: 'Medium', dimension: 'safety-security', issue: 'CORS allows any origin (*)', suggestion: 'Restrict origin to an allow-list; never combine * with credentials' },
  { id: 'weak-rng', re: /\b(?:token|secret|nonce|salt|otp|sessionid|session_id|apikey)\b[\w.]*\s*=\s*[^;\n]*Math\.random\s*\(/i, severity: 'Low–Med', dimension: 'safety-security', issue: 'Security token generated with Math.random() (not cryptographically secure)', suggestion: 'Use crypto.randomUUID() / crypto.randomBytes()' },
];

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.java', '.php']);
const SECRET_FILE_RE = /(^|\/)(\.env(\.[\w.-]+)?|id_rsa|id_dsa|id_ecdsa|.*\.pem|.*\.p12|.*\.pfx|.*\.key|.*service[-_]?account.*\.json|.*credentials.*\.json|\.npmrc|\.pgpass)$/i;
// a template is any .env file ENDING in .example/.sample/.template/.dist —
// including multi-part names like .env.local.example.
const ENV_TEMPLATE_RE = /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template|dist)$/i;
const REAL_ENV_RE = /(^|\/)\.env(\.(local|development|dev|production|prod|staging|test))?$/i;

/** line number of the first match of `re` in `content` (1-based). */
function lineOf(content, re) {
  const idx = content.search(re);
  if (idx < 0) return 1;
  return content.slice(0, idx).split('\n').length;
}

const finding = (o) => ({
  id: o.id,
  dimension: o.dimension || 'safety-security',
  area: 'security',
  severity: o.severity || 'Medium',
  effort: o.effort || 'Small',
  location: o.location,
  issue: o.issue,
  suggestion: o.suggestion,
  evidence: { security: true, check: o.check, ...(o.evidence || {}) },
  source: 'deterministic',
  dependsOn: [],
});

/** Scan one file's content for secrets, public-prefix leaks, weak fallbacks, sinks. */
export function scanContent(rel, content, { isTemplate = false } = {}) {
  const out = [];
  // Hardcoded secrets — skip env TEMPLATES (placeholders by definition).
  if (!isTemplate) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(content)) {
        out.push(finding({
          id: `sec:secret:${p.id}:${slug(rel)}`, check: 'hardcoded-secret', severity: 'High', dimension: 'safety-security',
          location: `${rel}:${lineOf(content, p.re)}`,
          issue: `Hardcoded ${p.label} in source`,
          suggestion: 'Move to an environment variable / secret manager and rotate the exposed credential',
          evidence: { kind: p.id, cost: true, compliance: true },
        }));
      }
    }
    GENERIC_ASSIGN.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = GENERIC_ASSIGN.exec(content))) {
      const [, key, , val] = m;
      if (isPlaceholder(val) || seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());
      out.push(finding({
        id: `sec:assign:${slug(key)}:${slug(rel)}`, check: 'hardcoded-secret', severity: 'High', dimension: 'safety-security',
        location: `${rel}:${content.slice(0, m.index).split('\n').length}`,
        issue: `Hardcoded ${key} assigned a literal value`,
        suggestion: 'Read from process.env / a secret store; never commit the literal',
        evidence: { key, cost: true },
      }));
    }
  }
  // Public-prefix secret leak (ships to the browser bundle) — even templates count.
  PUBLIC_PREFIX.lastIndex = 0;
  let pm;
  const pseen = new Set();
  while ((pm = PUBLIC_PREFIX.exec(content))) {
    const name = pm[1];
    if (pseen.has(name)) continue;
    pseen.add(name);
    out.push(finding({
      id: `sec:public-secret:${slug(name)}`, check: 'public-prefix-secret', severity: 'High', dimension: 'safety-security',
      location: `${rel}:${content.slice(0, pm.index).split('\n').length}`,
      issue: `${name} — a public/client-exposed env var holding a secret`,
      suggestion: 'Public-prefixed vars are inlined into the client bundle; move secrets to a server-only var (no public prefix)',
      evidence: { envVar: name, clientExposed: true, cost: true },
    }));
  }
  if (!isTemplate) {
    WEAK_FALLBACK.lastIndex = 0;
    let wm;
    while ((wm = WEAK_FALLBACK.exec(content))) {
      out.push(finding({
        id: `sec:weak-fallback:${slug(wm[1])}:${slug(rel)}`, check: 'weak-fallback-secret', severity: 'High', dimension: 'safety-security',
        location: `${rel}:${content.slice(0, wm.index).split('\n').length}`,
        issue: `Hardcoded fallback secret for ${wm[1]} (process.env.${wm[1]} || '…')`,
        suggestion: 'Fail fast when the env var is missing; never fall back to a baked-in secret',
        evidence: { envVar: wm[1] },
      }));
    }
    for (const s of SINKS) {
      if (s.re.test(content)) {
        out.push(finding({
          id: `sec:${s.id}:${slug(rel)}`, check: s.id, severity: s.severity, dimension: s.dimension,
          location: `${rel}:${lineOf(content, s.re)}`, issue: s.issue, suggestion: s.suggestion,
        }));
      }
    }
  }
  return out;
}

/** All env keys declared in a .env-template file (names only — never values). */
export function envTemplateKeys(content) {
  const keys = new Set();
  for (const line of String(content || '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const ENV_USE_RE = /\bprocess\.env\.([A-Z][A-Z0-9_]+)|\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]|\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g;

/**
 * Pure builder. @param files [{rel, content, isClient}] — content set for code +
 * config + dotfiles. Returns { findings, summary }.
 */
export function buildSecurityReport(files = []) {
  const findings = [];
  const usedKeys = new Set();
  let exampleKeys = new Set();
  let hasExample = false;
  let gitignore = '';
  const committedEnvFiles = [];
  let hasLockfile = false;
  let hasPackageJson = false;
  let hasEnvValidation = false;
  let envUseFiles = 0;

  for (const f of files) {
    const rel = f.rel;
    const content = typeof f.content === 'string' ? f.content : '';
    const base = rel.split('/').pop();
    if (base === 'package.json') hasPackageJson = true;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(rel)) hasLockfile = true;
    if (/(^|\/)\.gitignore$/.test(rel)) { gitignore = content; continue; }
    if (ENV_TEMPLATE_RE.test(rel)) { hasExample = true; exampleKeys = new Set([...exampleKeys, ...envTemplateKeys(content)]); continue; }
    if (REAL_ENV_RE.test(rel)) committedEnvFiles.push(rel);
    if (SECRET_FILE_RE.test(rel) && !ENV_TEMPLATE_RE.test(rel)) {
      findings.push(finding({
        id: `sec:cred-file:${slug(rel)}`, check: 'committed-secret-file', severity: 'High', dimension: 'safety-security',
        location: `${rel}:1`,
        issue: `Credential-bearing file committed to the repo: ${base}`,
        suggestion: 'Remove from version control, add to .gitignore, rotate any exposed secret',
        evidence: { compliance: true, cost: true },
      }));
    }
    // env-validation module heuristic
    if (/(^|\/)(env|config)\.(ts|js|mjs)$/.test(rel) && /\bz\.(object|string|enum)\b|createEnv|@t3-oss\/env/.test(content)) hasEnvValidation = true;
    // env usage
    if (content) {
      ENV_USE_RE.lastIndex = 0;
      let em; let used = false;
      while ((em = ENV_USE_RE.exec(content))) { usedKeys.add(em[1] || em[2] || em[3]); used = true; }
      if (used) envUseFiles++;
    }
    // content checks on code + env templates (templates: public-prefix only)
    const isTemplate = ENV_TEMPLATE_RE.test(rel);
    const isScannable = isTemplate || REAL_ENV_RE.test(rel) || CODE_EXT.has(path.extname(rel));
    if (content && isScannable) findings.push(...scanContent(rel, content, { isTemplate }));
  }

  // ── Repo-level env-hygiene findings ──
  const gi = gitignore.toLowerCase();
  const gitignoreCoversEnv = /(^|\n)\s*\*?\.env|(^|\n)\s*\.env\*/.test(gi);
  for (const ef of committedEnvFiles) {
    findings.push(finding({
      id: `sec:committed-env:${slug(ef)}`, check: 'committed-env', severity: 'High', dimension: 'safety-security',
      location: `${ef}:1`,
      issue: `Real .env file committed to the repo (${ef.split('/').pop()})`,
      suggestion: 'Move secrets to .env.local (gitignored), keep only a .env.example template in git, and rotate anything exposed',
      evidence: { compliance: true, cost: true, gitignored: gitignoreCoversEnv },
    }));
  }
  if (committedEnvFiles.length && !gitignoreCoversEnv) {
    findings.push(finding({
      id: 'sec:gitignore-env', check: 'gitignore-env', severity: 'High', dimension: 'safety-security',
      location: '.gitignore:1',
      issue: '.env files are not covered by .gitignore',
      suggestion: 'Add `.env*` (keeping `!.env.example`) to .gitignore so secrets can never be committed',
    }));
  }
  if (usedKeys.size > 0 && !hasExample) {
    findings.push(finding({
      id: 'sec:no-env-example', check: 'no-env-example', severity: 'Medium', dimension: 'code-quality-refactoring',
      location: '.env.example:1', effort: 'Trivial',
      issue: `${usedKeys.size} env var(s) read in code but no .env.example template exists`,
      suggestion: 'Add a committed .env.example documenting every required key (names only, no values)',
      evidence: { usedKeys: usedKeys.size },
    }));
  }
  if (hasExample) {
    const undocumented = [...usedKeys].filter((k) => !exampleKeys.has(k) && !/^(NODE_ENV|npm_|VERCEL|CI|PWD|HOME|PATH)/.test(k));
    if (undocumented.length) {
      findings.push(finding({
        id: 'sec:undocumented-env', check: 'undocumented-env', severity: 'Low–Med', dimension: 'code-quality-refactoring',
        location: '.env.example:1', effort: 'Trivial',
        issue: `${undocumented.length} env var(s) used in code but missing from .env.example`,
        suggestion: `Document them in .env.example: ${undocumented.slice(0, 8).join(', ')}${undocumented.length > 8 ? '…' : ''}`,
        evidence: { undocumented: undocumented.slice(0, 20) },
      }));
    }
  }
  if (usedKeys.size >= 8 && !hasEnvValidation) {
    findings.push(finding({
      id: 'sec:no-env-validation', check: 'no-env-validation', severity: 'Low–Med', dimension: 'code-quality-refactoring',
      location: 'src/env.ts:1', effort: 'Small',
      issue: `${usedKeys.size} env vars read ad-hoc via process.env with no centralized validation`,
      suggestion: 'Centralize + validate env at startup (a zod schema / @t3-oss/env) so missing/misconfigured vars fail fast',
    }));
  }
  if (hasPackageJson && !hasLockfile) {
    findings.push(finding({
      id: 'sec:no-lockfile', check: 'no-lockfile', severity: 'Medium', dimension: 'safety-security',
      location: 'package.json:1', effort: 'Trivial',
      issue: 'No dependency lockfile — dependency versions are unpinned (supply-chain risk)',
      suggestion: 'Commit package-lock.json / pnpm-lock.yaml / yarn.lock so installs are reproducible',
    }));
  }

  const byCheck = (c) => findings.filter((f) => f.evidence?.check === c).length;
  const summary = {
    totalFindings: findings.length,
    highCount: findings.filter((f) => f.severity === 'High').length,
    secrets: byCheck('hardcoded-secret'),
    secretFiles: byCheck('committed-secret-file'),
    publicSecrets: byCheck('public-prefix-secret'),
    weakFallbacks: byCheck('weak-fallback-secret'),
    dangerousSinks: findings.filter((f) => ['eval', 'new-function', 'exec-interp', 'inner-html', 'sql-concat'].includes(f.evidence?.check)).length,
    insecureConfig: findings.filter((f) => ['tls-off', 'cors-star', 'weak-rng'].includes(f.evidence?.check)).length,
    env: {
      hasExample,
      committedEnvFiles: committedEnvFiles.length,
      gitignoreCoversEnv,
      usedKeys: usedKeys.size,
      documentedKeys: exampleKeys.size,
      hasValidation: hasEnvValidation,
    },
    supplyChain: { hasLockfile, hasPackageJson },
  };
  return { findings, summary };
}

// ── CLI ──
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage', 'graphify-out']);
const READ_EXT = new Set([...CODE_EXT, '.json', '.yaml', '.yml']);
function walk(dir, root, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    // keep dotfiles we care about (.env*, .gitignore, .npmrc); skip other dot dirs
    if (e.name.startsWith('.') && e.isDirectory() && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, acc);
    else acc.push(full);
  }
  return acc;
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'security.json');
  const files = [];
  for (const full of walk(repo, repo)) {
    const rel = path.relative(repo, full);
    const base = rel.split('/').pop();
    const wanted = READ_EXT.has(path.extname(full)) || base === '.gitignore' || base === '.npmrc' || /^\.env/.test(base) || SECRET_FILE_RE.test(rel) || base === 'package.json';
    if (!wanted) continue;
    let content = '';
    try { if (fs.statSync(full).size < 512 * 1024) content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    files.push({ rel, content });
  }
  const report = buildSecurityReport(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...report }, null, 2));
  const s = report.summary;
  console.error(`[security-scan] findings:${s.totalFindings} secrets:${s.secrets} public:${s.publicSecrets} env(committed:${s.env.committedEnvFiles} example:${s.env.hasExample}) sinks:${s.dangerousSinks} → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
