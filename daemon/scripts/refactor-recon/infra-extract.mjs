#!/usr/bin/env node
// infra-extract.mjs — Refactoring Scan Engine v2, the Infrastructure inventory.
//
// Deterministic, ~0 LLM, PROVIDER-AGNOSTIC, FILE-FIRST. Explains how an app's infra
// works and feeds the compliance / EU-AI-Act authorities a single source of truth.
//
// Detection strategy, strongest signal first (each detection records HOW it was
// found + a confidence, so codebases with different infra-expression maturity are
// scored honestly):
//   1. IaC / config FILES — declared, authoritative (high): schema.prisma,
//      *.tf (terraform), serverless.yml, docker-compose, Pulumi, platform configs
//      (vercel/netlify/fly/render/app.yaml), CI deploy workflows.
//   2. ENV-key names — declared intent (medium): parsed from .env.example/.sample
//      ONLY (never .env — no secrets), + value host hints (smtp.hostinger.com).
//   3. SDK / package imports — inferred (medium/low): @aws-sdk, @google-cloud,
//      @azure, @supabase, nodemailer, steamworks, + privacy-detectors (db/ai/3rd).
//
// USAGE: node infra-extract.mjs <repo> [--src src] [--out file]

import fs from 'node:fs';
import path from 'node:path';
import { classifyImport, classifyPath } from './privacy-detectors.mjs';

// ── 1. SDK/package catalog (provider-agnostic cloud + service SDKs) ──
// residency: in-account = stays in the operator's own cloud · external = leaves.
export const CLOUD_SDK = [
  // AWS
  { re: /^@aws-sdk\/(client|lib)-dynamodb/, name: 'DynamoDB', kind: 'database', cloud: 'AWS', residency: 'in-account', dataStore: true },
  { re: /^@aws-sdk\/client-rds/, name: 'RDS', kind: 'database', cloud: 'AWS', residency: 'in-account', dataStore: true },
  { re: /^@aws-sdk\/client-s3|^@aws-sdk\/lib-storage/, name: 'S3', kind: 'storage', cloud: 'AWS', residency: 'in-account', dataStore: true },
  { re: /^@aws-sdk\/client-lambda/, name: 'Lambda', kind: 'compute', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-sdk\/client-cloudfront/, name: 'CloudFront', kind: 'network', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-sdk\/client-elastic-load-balancing/, name: 'ALB/ELB', kind: 'network', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-sdk\/client-cognito/, name: 'Cognito', kind: 'auth', cloud: 'AWS', residency: 'in-account', dataStore: true },
  { re: /^@aws-sdk\/client-ses|^@aws-sdk\/client-sesv2/, name: 'SES', kind: 'email', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-sdk\/client-(sns|sqs|eventbridge)/, name: 'SNS/SQS/EventBridge', kind: 'messaging', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-sdk\/client-bedrock/, name: 'Bedrock', kind: 'ai', cloud: 'AWS', residency: 'in-account' },
  { re: /^@aws-amplify\//, name: 'Amplify', kind: 'platform', cloud: 'AWS', residency: 'in-account' },
  // GCP
  { re: /^@google-cloud\/firestore|^firebase-admin\/firestore/, name: 'Firestore', kind: 'database', cloud: 'GCP', residency: 'in-account', dataStore: true },
  { re: /^@google-cloud\/storage/, name: 'Cloud Storage', kind: 'storage', cloud: 'GCP', residency: 'in-account', dataStore: true },
  { re: /^@google-cloud\/bigquery/, name: 'BigQuery', kind: 'database', cloud: 'GCP', residency: 'in-account', dataStore: true },
  { re: /^@google-cloud\/pubsub/, name: 'Pub/Sub', kind: 'messaging', cloud: 'GCP', residency: 'in-account' },
  { re: /^@google-cloud\/run|^@google-cloud\/functions/, name: 'Cloud Run/Functions', kind: 'compute', cloud: 'GCP', residency: 'in-account' },
  { re: /^@google-cloud\/secret-manager/, name: 'Secret Manager', kind: 'secrets', cloud: 'GCP', residency: 'in-account' },
  { re: /^firebase(\/|$)|^firebase-admin(\/|$)/, name: 'Firebase', kind: 'platform', cloud: 'GCP', residency: 'in-account', dataStore: true },
  { re: /^@google-cloud\/aiplatform|^@google\/generative-ai/, name: 'Vertex AI / Gemini', kind: 'ai', cloud: 'GCP', residency: 'external' },
  // Azure
  { re: /^@azure\/cosmos/, name: 'Cosmos DB', kind: 'database', cloud: 'Azure', residency: 'in-account', dataStore: true },
  { re: /^@azure\/storage-blob/, name: 'Blob Storage', kind: 'storage', cloud: 'Azure', residency: 'in-account', dataStore: true },
  { re: /^@azure\/service-bus/, name: 'Service Bus', kind: 'messaging', cloud: 'Azure', residency: 'in-account' },
  { re: /^@azure\/keyvault/, name: 'Key Vault', kind: 'secrets', cloud: 'Azure', residency: 'in-account' },
  { re: /^@azure\/identity|^@azure\/functions|^@azure\//, name: 'Azure SDK', kind: 'platform', cloud: 'Azure', residency: 'in-account' },
  // Supabase (managed Postgres + auth + storage)
  { re: /^@supabase\//, name: 'Supabase', kind: 'database', cloud: 'Supabase', residency: 'external', dataStore: true },
  // Email / messaging 3rd-party
  { re: /^nodemailer/, name: 'SMTP (nodemailer)', kind: 'email', cloud: '3rd-party', residency: 'external' },
  { re: /^resend/, name: 'Resend', kind: 'email', cloud: '3rd-party', residency: 'external' },
  { re: /^postmark/, name: 'Postmark', kind: 'email', cloud: '3rd-party', residency: 'external' },
  { re: /^mailgun/, name: 'Mailgun', kind: 'email', cloud: '3rd-party', residency: 'external' },
  // Gaming / distribution
  { re: /^steamworks(\.js)?$|^greenworks/, name: 'Steam', kind: 'gaming', cloud: '3rd-party', residency: 'external' },
];

export function detectCloudSdk(spec) {
  for (const s of CLOUD_SDK) if (s.re.test(spec)) return { name: s.name, kind: s.kind, cloud: s.cloud, residency: s.residency, dataStore: !!s.dataStore };
  return null;
}

// ── Config / IaC file recognition (by name) ──
export function configFileType(rel) {
  const base = rel.split('/').pop();
  if (/(^|\/)schema\.prisma$/.test(rel)) return 'prisma';
  if (/\.tf$|\.tf\.json$/.test(rel)) return 'terraform';
  if (/(^|\/)serverless\.ya?ml$/.test(rel)) return 'serverless';
  if (/(^|\/)docker-compose\.ya?ml$/.test(rel)) return 'docker-compose';
  if (/(^|\/)Pulumi\.[^/]*\.?ya?ml$/.test(rel)) return 'pulumi';
  if (/(^|\/)(template|cloudformation)\.ya?ml$/.test(rel)) return 'cloudformation';
  if (base === 'vercel.json') return 'platform:Vercel';
  if (base === 'netlify.toml') return 'platform:Netlify';
  if (base === 'fly.toml') return 'platform:Fly.io';
  if (base === 'render.yaml') return 'platform:Render';
  if (base === 'app.yaml' || base === 'app.yml') return 'platform:GCP App Engine';
  if (base === 'Procfile') return 'platform:Heroku';
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return 'gh-workflow';
  if (/(^|\/)\.env\.(example|sample|template)$/.test(rel)) return 'env-example';
  return null;
}

// terraform resource-type → friendly service (best-effort; unknown types kept raw)
const TF_RESOURCE = [
  [/^aws_lambda_function/, 'Lambda', 'AWS', 'compute'],
  [/^aws_dynamodb_table/, 'DynamoDB', 'AWS', 'database'],
  [/^aws_s3_bucket/, 'S3', 'AWS', 'storage'],
  [/^aws_cloudfront/, 'CloudFront', 'AWS', 'network'],
  [/^aws_(lb|alb|elb)/, 'ALB/ELB', 'AWS', 'network'],
  [/^aws_(rds|db_instance)/, 'RDS', 'AWS', 'database'],
  [/^aws_cognito/, 'Cognito', 'AWS', 'auth'],
  [/^google_cloud_run/, 'Cloud Run', 'GCP', 'compute'],
  [/^google_(firestore|datastore)/, 'Firestore', 'GCP', 'database'],
  [/^google_storage_bucket/, 'Cloud Storage', 'GCP', 'storage'],
  [/^google_sql/, 'Cloud SQL', 'GCP', 'database'],
  [/^google_pubsub/, 'Pub/Sub', 'GCP', 'messaging'],
  [/^azurerm_(linux_web_app|app_service|windows_web_app)/, 'App Service', 'Azure', 'compute'],
  [/^azurerm_cosmosdb/, 'Cosmos DB', 'Azure', 'database'],
  [/^azurerm_storage/, 'Blob Storage', 'Azure', 'storage'],
  [/^azurerm_servicebus/, 'Service Bus', 'Azure', 'messaging'],
  [/^azurerm_(function_app|linux_function_app)/, 'Azure Functions', 'Azure', 'compute'],
];
const tfCloud = (rt) => (/^aws_/.test(rt) ? 'AWS' : /^google_/.test(rt) ? 'GCP' : /^azurerm_|^azuread_/.test(rt) ? 'Azure' : 'unknown');

// env-key name → provider (the KEY, never the value)
const ENV_KEY = [
  [/^(NEXT_PUBLIC_)?SUPABASE_/i, { name: 'Supabase', kind: 'database', cloud: 'Supabase', residency: 'external', dataStore: true }],
  [/^(GCP_|GOOGLE_CLOUD_|GCLOUD_|GOOGLE_APPLICATION_CREDENTIALS)/i, { name: 'GCP', kind: 'platform', cloud: 'GCP', residency: 'in-account' }],
  [/^(FIREBASE_)/i, { name: 'Firebase', kind: 'platform', cloud: 'GCP', residency: 'in-account', dataStore: true }],
  [/^AZURE_/i, { name: 'Azure', kind: 'platform', cloud: 'Azure', residency: 'in-account' }],
  [/^AWS_/i, { name: 'AWS', kind: 'platform', cloud: 'AWS', residency: 'in-account' }],
  [/^STEAM_/i, { name: 'Steam', kind: 'gaming', cloud: '3rd-party', residency: 'external' }],
  [/^RESEND_/i, { name: 'Resend', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^POSTMARK_/i, { name: 'Postmark', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^MAILGUN_/i, { name: 'Mailgun', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^SENDGRID_/i, { name: 'SendGrid', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^STRIPE_/i, { name: 'Stripe', kind: 'payment', cloud: '3rd-party', residency: 'external' }],
  [/^OPENAI_/i, { name: 'OpenAI', kind: 'ai', cloud: '3rd-party', residency: 'external' }],
  [/^ANTHROPIC_/i, { name: 'Anthropic (Claude API)', kind: 'ai', cloud: '3rd-party', residency: 'external' }],
];

const CONF_RANK = { high: 3, medium: 2, low: 1 };

/** Parse a config/IaC file's content into declared detections (high confidence). */
export function parseConfig(type, content, rel) {
  const out = [];
  const push = (d) => out.push({ ...d, detectedBy: d.detectedBy || 'iac-declared', confidence: d.confidence || 'high', file: rel });
  if (type === 'prisma') {
    const m = content.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s);
    if (m) push({ name: `Prisma → ${m[1]}`, kind: 'database', cloud: 'managed', residency: 'varies', dataStore: true, declares: [m[1]] });
  } else if (type === 'terraform') {
    const providers = [...content.matchAll(/provider\s+"([a-z0-9_]+)"/gi)].map((x) => x[1]);
    const resources = [...content.matchAll(/resource\s+"([a-z0-9_]+)"/gi)].map((x) => x[1]);
    const seen = new Set();
    for (const rt of resources) {
      const hit = TF_RESOURCE.find(([re]) => re.test(rt));
      const name = hit ? hit[1] : rt;
      const cloud = hit ? hit[2] : tfCloud(rt);
      const kind = hit ? hit[3] : 'other';
      const key = `${cloud}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      push({ name, kind, cloud, residency: 'in-account', dataStore: kind === 'database' || kind === 'storage', declares: [rt] });
    }
    for (const p of providers) {
      const cloud = p === 'aws' ? 'AWS' : p === 'google' ? 'GCP' : /azurerm|azuread/.test(p) ? 'Azure' : p;
      push({ name: `Terraform provider: ${cloud}`, kind: 'iac', cloud, residency: 'in-account', declares: [p] });
    }
  } else if (type === 'serverless') {
    const m = content.match(/provider:\s*[\s\S]*?name:\s*(aws|google|azure)/i);
    if (m) { const cloud = m[1] === 'aws' ? 'AWS' : m[1] === 'google' ? 'GCP' : 'Azure'; push({ name: `Serverless → ${cloud}`, kind: 'iac', cloud, residency: 'in-account' }); }
  } else if (type === 'docker-compose') {
    for (const m of content.matchAll(/image:\s*['"]?([a-z0-9._/-]+)/gi)) {
      const img = m[1].toLowerCase();
      const svc = /postgres/.test(img) ? 'Postgres' : /mysql|mariadb/.test(img) ? 'MySQL' : /mongo/.test(img) ? 'MongoDB' : /redis/.test(img) ? 'Redis' : null;
      if (svc) push({ name: `${svc} (self-hosted)`, kind: 'database', cloud: 'self-hosted', residency: 'in-account', dataStore: true, declares: [img] });
    }
  } else if (type === 'pulumi' || type === 'cloudformation') {
    push({ name: type === 'pulumi' ? 'Pulumi' : 'CloudFormation/SAM', kind: 'iac', cloud: 'unknown', residency: 'in-account' });
  } else if (type && type.startsWith('platform:')) {
    push({ name: type.slice('platform:'.length), kind: 'platform', cloud: 'platform', residency: 'varies', detectedBy: 'platform-config' });
  } else if (type === 'gh-workflow') {
    if (/aws-actions\//.test(content)) push({ name: 'AWS (CI deploy)', kind: 'iac', cloud: 'AWS', residency: 'in-account', detectedBy: 'platform-config' });
    if (/google-github-actions\//.test(content)) push({ name: 'GCP (CI deploy)', kind: 'iac', cloud: 'GCP', residency: 'in-account', detectedBy: 'platform-config' });
    if (/azure\/login/.test(content)) push({ name: 'Azure (CI deploy)', kind: 'iac', cloud: 'Azure', residency: 'in-account', detectedBy: 'platform-config' });
  } else if (type === 'env-example') {
    for (const line of content.split('\n')) {
      const km = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=(.*)$/);
      if (!km) continue;
      const [, key, rawVal] = km;
      const val = (rawVal || '').trim().replace(/^["']|["']$/g, '');
      const hit = ENV_KEY.find(([re]) => re.test(key));
      if (hit) push({ ...hit[1], detectedBy: 'env-key', confidence: 'medium', declares: [key] });
      // value host hint (safe in .env.example): SMTP host → provider
      if (/smtp\.hostinger\.com/i.test(val)) push({ name: 'Hostinger (email/SMTP)', kind: 'email', cloud: '3rd-party', residency: 'external', detectedBy: 'env-key', confidence: 'medium', declares: [key] });
      else if (/^SMTP_HOST$/i.test(key) && val && !/your|example|changeme|<|placeholder/i.test(val)) push({ name: `SMTP: ${val}`, kind: 'email', cloud: '3rd-party', residency: 'external', detectedBy: 'env-key', confidence: 'medium', declares: [key] });
      if (/^DATABASE_URL$/i.test(key)) { const scheme = (val.match(/^(\w+):\/\//) || [])[1]; if (scheme) push({ name: `DB via DATABASE_URL (${scheme})`, kind: 'database', cloud: 'managed', residency: 'varies', dataStore: true, detectedBy: 'env-key', confidence: 'medium' }); }
    }
  }
  return out;
}

/**
 * Pure inventory builder.
 * @param {Array<{rel,isClient?,specifiers?,content?}>} files — content set for config files
 */
export function buildInfraInventory(files = []) {
  const merged = new Map(); // name -> service
  const iac = [];
  let clientFiles = 0;
  let serverFiles = 0;
  const externalTouchedBy = new Set();
  let iacDeclared = false;
  let hasEnvExample = false;

  const record = (d, rel) => {
    const key = d.name;
    if (!merged.has(key)) merged.set(key, { name: d.name, kind: d.kind, cloud: d.cloud || 'unknown', residency: d.residency || null, dataStore: !!d.dataStore, detectedBy: new Set(), confidence: 'low', files: new Set(), declares: new Set() });
    const e = merged.get(key);
    if (d.detectedBy) e.detectedBy.add(d.detectedBy);
    if (CONF_RANK[d.confidence] > CONF_RANK[e.confidence]) e.confidence = d.confidence;
    // declared cloud/residency wins over inferred 'unknown'
    if (d.cloud && d.cloud !== 'unknown' && (e.cloud === 'unknown' || d.detectedBy === 'iac-declared')) e.cloud = d.cloud;
    if (d.residency && !e.residency) e.residency = d.residency;
    if (d.dataStore) e.dataStore = true;
    if (rel) e.files.add(rel);
    for (const x of d.declares || []) e.declares.add(x);
    if (d.residency === 'external' && rel) externalTouchedBy.add(rel);
  };

  for (const f of files) {
    if (f.isClient) clientFiles++;
    else serverFiles++;
    const ctype = configFileType(f.rel);
    if (ctype && typeof f.content === 'string') {
      if (ctype !== 'env-example' && ctype !== 'gh-workflow' && !ctype.startsWith('platform:')) iacDeclared = true;
      if (ctype === 'env-example') hasEnvExample = true;
      const dets = parseConfig(ctype, f.content, f.rel);
      if (dets.length) { for (const d of dets) record(d, f.rel); if (d_isIacKind(dets)) iacDeclared = true; }
      // record the raw IaC file presence
      if (ctype !== 'env-example') iac.push({ provider: prettyConfigType(ctype), file: f.rel });
      continue;
    }
    // code file → SDK/import inference
    for (const spec of f.specifiers || []) {
      const c = detectCloudSdk(spec);
      if (c) { record({ ...c, detectedBy: 'sdk-import', confidence: 'medium' }, f.rel); continue; }
      const d = classifyImport(spec);
      if (d) record({ name: d.provider, kind: mapPrivacyKind(d.kind), cloud: cloudForProvider(d), residency: d.residency, dataStore: d.kind === 'db', detectedBy: 'sdk-import', confidence: 'medium' }, f.rel);
      else if (classifyPath(f.rel)?.kind === 'infra') { /* handled by config path */ }
    }
  }

  const services = [...merged.values()]
    .map((e) => ({ name: e.name, kind: e.kind, cloud: e.cloud, residency: e.residency, dataStore: e.dataStore, detectedBy: [...e.detectedBy], confidence: e.confidence, declares: [...e.declares].slice(0, 6), fileCount: e.files.size, files: [...e.files].sort().slice(0, 8) }))
    .sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || b.fileCount - a.fileCount);

  const external = services.filter((s) => s.residency === 'external').map((s) => ({ provider: s.name, kind: s.kind, fileCount: s.fileCount, detectedBy: s.detectedBy }));
  const clouds = [...new Set(services.map((s) => s.cloud))].filter((c) => c && c !== 'unknown');
  const dataStoreCount = services.filter((s) => s.dataStore).length;

  // infra signal quality — the "how well does this codebase express its infra" rating.
  const iacFiles = iac.length;
  const level = iacDeclared ? 'high' : services.some((s) => [...s.detectedBy].includes('env-key')) || services.length ? 'medium' : 'low';
  const signalQuality = {
    level,
    iacDeclared,
    iacFiles,
    hasEnvExample,
    detail:
      level === 'high'
        ? `infra declared in ${iacFiles} IaC/config file(s) — high confidence`
        : level === 'medium'
          ? 'no IaC declared; inferred from SDK imports + env keys — medium confidence'
          : 'sparse infra signal — manual review recommended',
  };

  return {
    services,
    iac,
    external,
    clouds,
    boundaries: { clientFiles, serverFiles, externalTouchingFiles: externalTouchedBy.size },
    signalQuality,
    summary: {
      serviceCount: services.length,
      dataStoreCount,
      aiCount: services.filter((s) => s.kind === 'ai').length,
      externalProcessorCount: external.length,
      clouds,
      iacProviders: [...new Set(iac.map((i) => i.provider))],
    },
  };
}

function d_isIacKind(dets) { return dets.some((d) => d.kind === 'iac'); }
function prettyConfigType(t) {
  if (t.startsWith('platform:')) return t.slice('platform:'.length);
  return { prisma: 'Prisma', terraform: 'Terraform', serverless: 'Serverless', 'docker-compose': 'Docker Compose', pulumi: 'Pulumi', cloudformation: 'CloudFormation', 'gh-workflow': 'CI workflow' }[t] || t;
}
function mapPrivacyKind(k) { return k === 'thirdParty' ? 'third-party' : k; }
function cloudForProvider(d) {
  if (d.kind === 'db') return d.provider === 'DynamoDB' ? 'AWS' : d.provider === 'Supabase' ? 'Supabase' : 'managed';
  if (d.kind === 'ai') return '3rd-party';
  return '3rd-party';
}

// ── CLI ──
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage']);
const SPEC_RE = [
  /(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
function specifiers(code) {
  const set = new Set();
  for (const re of SPEC_RE) { let m; re.lastIndex = 0; while ((m = re.exec(code))) set.add(m[1]); }
  return [...set];
}
function walk(dir, root, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.' && e.name !== '.github' && !/^\.env\.(example|sample|template)$/.test(e.name)) continue;
    if (IGNORE.has(e.name)) continue;
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
  const out = flag('--out') || path.join(repo, 'graphify-out', 'infra.json');
  const all = walk(repo, repo);
  const files = [];
  for (const full of all) {
    const rel = path.relative(repo, full);
    const ctype = configFileType(rel);
    const isCode = EXTS.includes(path.extname(full));
    if (!ctype && !isCode) continue;
    let code = '';
    try { code = fs.readFileSync(full, 'utf8'); } catch { continue; }
    files.push({ rel, specifiers: isCode ? specifiers(code) : [], content: ctype ? code : undefined, isClient: isCode && /^\s*['"]use client['"]/m.test(code) });
  }
  const inv = buildInfraInventory(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...inv }, null, 2));
  console.error(
    `[infra-extract] signal:${inv.signalQuality.level} clouds:${inv.clouds.join('/') || 'none'} services:${inv.summary.serviceCount} stores:${inv.summary.dataStoreCount} external:${inv.summary.externalProcessorCount} → ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
