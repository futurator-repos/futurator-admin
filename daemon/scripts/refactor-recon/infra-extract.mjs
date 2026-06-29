#!/usr/bin/env node
// infra-extract.mjs — Refactoring Scan Engine v2, the Infrastructure inventory.
//
// Deterministic, ~0 LLM. Builds a structured map of HOW the app's infra works:
// which AWS services (Lambda/DynamoDB/S3/CloudFront/ALB/…), databases, AI
// providers, and 3rd-party services it uses, with residency (in-account vs leaves
// to an external processor) and which files touch each. This is the SOURCE OF
// TRUTH the other scan authorities consume — GDPR (where personal data is stored),
// EU AI Act (which AI + is data sent as-is to an external provider), and the
// front-end↔infra security boundary. Layered ON TOP of privacy-detectors so the
// role/residency taxonomy stays consistent across the scanner, the graph, and here.
//
// USAGE: node infra-extract.mjs <repo> [--src src] [--out file]

import fs from 'node:fs';
import path from 'node:path';
import { classifyImport, classifyPath } from './privacy-detectors.mjs';

// AWS service catalog (by @aws-sdk/client-* specifier). category drives grouping;
// dataStore flags services that hold personal data (→ GDPR Art. 32).
export const AWS_SERVICES = [
  { re: /^@aws-sdk\/(client|lib)-dynamodb/, service: 'DynamoDB', category: 'database', dataStore: true },
  { re: /^@aws-sdk\/client-rds|^@aws-sdk\/client-rds-data/, service: 'RDS', category: 'database', dataStore: true },
  { re: /^@aws-sdk\/client-s3|^@aws-sdk\/lib-storage/, service: 'S3', category: 'storage', dataStore: true },
  { re: /^@aws-sdk\/client-lambda/, service: 'Lambda', category: 'compute' },
  { re: /^@aws-sdk\/client-cloudfront/, service: 'CloudFront', category: 'network/cdn' },
  { re: /^@aws-sdk\/client-elastic-load-balancing/, service: 'ALB/ELB', category: 'network' },
  { re: /^@aws-sdk\/client-api-gateway|^@aws-sdk\/client-apigatewayv2/, service: 'API Gateway', category: 'network' },
  { re: /^@aws-sdk\/client-cognito/, service: 'Cognito', category: 'auth', dataStore: true },
  { re: /^@aws-sdk\/client-ses|^@aws-sdk\/client-sesv2/, service: 'SES', category: 'email' },
  { re: /^@aws-sdk\/client-sns/, service: 'SNS', category: 'messaging' },
  { re: /^@aws-sdk\/client-sqs/, service: 'SQS', category: 'messaging' },
  { re: /^@aws-sdk\/client-eventbridge|^@aws-sdk\/client-cloudwatch-events/, service: 'EventBridge', category: 'messaging' },
  { re: /^@aws-sdk\/client-sfn|^@aws-sdk\/client-step-functions/, service: 'Step Functions', category: 'orchestration' },
  { re: /^@aws-sdk\/client-secrets-manager/, service: 'Secrets Manager', category: 'secrets' },
  { re: /^@aws-sdk\/client-ssm/, service: 'SSM Parameter Store', category: 'config' },
  { re: /^@aws-sdk\/client-kms/, service: 'KMS', category: 'security' },
  { re: /^@aws-sdk\/client-cloudwatch|^@aws-sdk\/client-cloudwatch-logs/, service: 'CloudWatch', category: 'observability' },
  { re: /^@aws-sdk\/client-bedrock/, service: 'Bedrock', category: 'ai' },
  { re: /^@aws-sdk\/client-(textract|rekognition|comprehend|transcribe|polly)/, service: 'AWS AI service', category: 'ai' },
  { re: /^@aws-sdk\/client-(ecs|ec2|ecr)/, service: 'ECS/EC2', category: 'compute' },
  { re: /^@aws-amplify\//, service: 'Amplify', category: 'platform' },
];

export function detectAwsService(spec) {
  for (const s of AWS_SERVICES) if (s.re.test(spec)) return { service: s.service, category: s.category, dataStore: !!s.dataStore };
  return null;
}

// IaC / deploy-config file detection (path-based), beyond privacy's PATH_DETECTORS.
const IAC_PATHS = [
  { re: /(^|\/)sst\.config\.[tj]s$/, provider: 'SST' },
  { re: /\.tf$|\.tf\.json$/, provider: 'Terraform' },
  { re: /(^|\/)Pulumi\.[^/]*\.?ya?ml$/, provider: 'Pulumi' },
  { re: /(^|\/)serverless\.ya?ml$/, provider: 'Serverless Framework' },
  { re: /(^|\/)(template|cloudformation)\.ya?ml$/, provider: 'CloudFormation/SAM' },
  { re: /(^|\/)cdk\.json$/, provider: 'AWS CDK' },
  { re: /(^|\/)amplify\//, provider: 'Amplify' },
  { re: /(^|\/)vercel\.json$/, provider: 'Vercel' },
  { re: /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/, provider: 'Docker' },
];
function detectIac(rel) {
  for (const d of IAC_PATHS) if (d.re.test(rel)) return d.provider;
  return null;
}

/**
 * Pure inventory builder.
 * @param {Array<{rel:string, specifiers:string[], isClient?:boolean}>} files
 * @returns the infra inventory (see fields below).
 */
export function buildInfraInventory(files = []) {
  const aws = new Map(); // service -> {service,category,dataStore,residency,files:Set}
  const db = new Map();
  const ai = new Map();
  const thirdParty = new Map();
  const iac = [];
  let clientFiles = 0;
  let serverFiles = 0;
  const externalTouchedBy = new Set(); // files that import an external (data-leaving) provider

  const bump = (map, key, base, rel) => {
    if (!map.has(key)) map.set(key, { ...base, files: new Set() });
    map.get(key).files.add(rel);
  };

  for (const f of files) {
    const rel = f.rel;
    if (f.isClient) clientFiles++;
    else serverFiles++;
    const iacP = detectIac(rel) || (classifyPath(rel)?.kind === 'infra' ? classifyPath(rel).provider : null);
    if (iacP) iac.push({ provider: iacP, file: rel });

    for (const spec of f.specifiers || []) {
      const a = detectAwsService(spec);
      if (a) {
        bump(aws, a.service, { service: a.service, category: a.category, dataStore: a.dataStore, residency: 'in-account' }, rel);
        continue;
      }
      const d = classifyImport(spec);
      if (!d) continue;
      const entry = { provider: d.provider, residency: d.residency };
      if (d.residency === 'external') externalTouchedBy.add(rel);
      if (d.kind === 'db') bump(db, d.provider, entry, rel);
      else if (d.kind === 'ai') bump(ai, d.provider, { ...entry, external: d.residency !== 'in-account' }, rel);
      else if (d.kind === 'thirdParty') bump(thirdParty, d.provider, entry, rel);
      // infra-kind packages (pulumi/cdk/sst as deps) → treat as IaC signal
      else if (d.kind === 'infra') iac.push({ provider: d.provider, file: rel });
    }
  }

  const finalize = (map) =>
    [...map.values()]
      .map((v) => ({ ...v, fileCount: v.files.size, files: [...v.files].sort().slice(0, 10) }))
      .sort((a, b) => b.fileCount - a.fileCount);

  const awsList = finalize(aws);
  const dbList = finalize(db);
  const aiList = finalize(ai);
  const tpList = finalize(thirdParty);

  // What the compliance/AI-Act authorities care about: providers data LEAVES to.
  const external = [
    ...aiList.filter((x) => x.external).map((x) => ({ provider: x.provider, kind: 'ai', fileCount: x.fileCount })),
    ...dbList.filter((x) => x.residency === 'external').map((x) => ({ provider: x.provider, kind: 'db', fileCount: x.fileCount })),
    ...tpList.filter((x) => x.residency === 'external').map((x) => ({ provider: x.provider, kind: 'thirdParty', fileCount: x.fileCount })),
  ];

  // dedupe IaC by provider
  const iacByProvider = new Map();
  for (const i of iac) {
    if (!iacByProvider.has(i.provider)) iacByProvider.set(i.provider, { provider: i.provider, files: new Set() });
    iacByProvider.get(i.provider).files.add(i.file);
  }
  const iacList = [...iacByProvider.values()].map((v) => ({ provider: v.provider, fileCount: v.files.size, files: [...v.files].sort().slice(0, 8) }));

  return {
    aws: awsList,
    databases: dbList,
    ai: aiList,
    thirdParty: tpList,
    iac: iacList,
    boundaries: { clientFiles, serverFiles, externalTouchingFiles: externalTouchedBy.size },
    external, // → feeds GDPR Art. 44 (transfers) + EU AI Act
    summary: {
      awsServiceCount: awsList.length,
      dataStoreCount: awsList.filter((x) => x.dataStore).length + dbList.length,
      aiCount: aiList.length,
      externalProcessorCount: external.length,
      iacProviders: iacList.map((x) => x.provider),
    },
  };
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
    if (e.name.startsWith('.') && e.name !== '.') continue;
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
    const isIac = detectIac(rel);
    if (!EXTS.includes(path.extname(full)) && !isIac) continue;
    let code = '';
    try { code = fs.readFileSync(full, 'utf8'); } catch { continue; }
    files.push({ rel, specifiers: EXTS.includes(path.extname(full)) ? specifiers(code) : [], isClient: /^\s*['"]use client['"]/m.test(code) });
  }
  const inv = buildInfraInventory(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...inv }, null, 2));
  console.error(
    `[infra-extract] AWS:${inv.summary.awsServiceCount} stores:${inv.summary.dataStoreCount} AI:${inv.summary.aiCount} external:${inv.summary.externalProcessorCount} IaC:${inv.summary.iacProviders.join(',') || 'none'} → ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
