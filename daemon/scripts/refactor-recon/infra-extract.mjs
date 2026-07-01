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

// ── Config / IaC file recognition (by NAME). Ambiguous .yaml/.json (k8s, CFN, SAM,
// ArgoCD, Crossplane, ARM) need content — see classifyConfigByContent. ──
export function configFileType(rel) {
  const base = rel.split('/').pop();
  if (/(^|\/)schema\.prisma$/.test(rel)) return 'prisma';
  if (/(^|\/)sst\.config\.(ts|mjs|js)$/.test(rel)) return 'sst';
  if (/(^|\/)cdk\.json$/.test(rel)) return 'cdk';
  if (/(^|\/)cdktf\.json$/.test(rel)) return 'cdktf';
  if (/(^|\/)drizzle\.config\.(ts|mjs|js)$/.test(rel)) return 'drizzle';
  if (/\.tf$|\.tf\.json$|\.tofu$/.test(rel)) return 'terraform';
  if (/(^|\/)terragrunt\.hcl$/.test(rel)) return 'terragrunt';
  if (/\.bicep$/.test(rel)) return 'bicep';
  if (/(^|\/)azuredeploy\.json$/.test(rel)) return 'arm';
  if (/(^|\/)serverless\.ya?ml$/.test(rel)) return 'serverless';
  if (/(^|\/)(docker-compose|compose)\.ya?ml$/.test(rel)) return 'docker-compose';
  if (/(^|\/)Dockerfile(\.[\w-]+)?$/.test(rel)) return 'docker';
  if (/\.pkr\.hcl$|(^|\/)packer\.json$/.test(rel)) return 'packer';
  if (/(^|\/)Vagrantfile$/.test(rel)) return 'vagrant';
  if (/(^|\/)(flake|default|shell)\.nix$/.test(rel)) return 'nix';
  if (/(^|\/)Pulumi\.[^/]*\.?ya?ml$/.test(rel)) return 'pulumi';
  if (/(^|\/)Chart\.ya?ml$/.test(rel)) return 'helm';
  if (/(^|\/)kustomization\.ya?ml$/.test(rel)) return 'kustomize';
  // config management
  if (/(^|\/)(playbook|site)\.ya?ml$|(^|\/)ansible\.cfg$|(^|\/)(roles|playbooks)\//.test(rel)) return 'ansible';
  if (/(^|\/)(metadata\.rb|Berksfile)$|(^|\/)(recipes|cookbooks)\/.*\.rb$/.test(rel)) return 'chef';
  if (/\.pp$|(^|\/)Puppetfile$/.test(rel)) return 'puppet';
  if (/\.sls$/.test(rel)) return 'salt';
  // migrations
  if (/(^|\/)(flyway\.conf|flyway\.toml)$|(^|\/)db\/migration\//.test(rel)) return 'flyway';
  if (/(^|\/)(liquibase\.properties|changelog.*\.xml)$/.test(rel)) return 'liquibase';
  if (/(^|\/)alembic\.ini$|(^|\/)alembic\/versions\//.test(rel)) return 'alembic';
  // platform
  if (base === 'vercel.json') return 'platform:Vercel';
  if (base === 'netlify.toml') return 'platform:Netlify';
  if (base === 'fly.toml') return 'platform:Fly.io';
  if (base === 'render.yaml') return 'platform:Render';
  if (base === 'app.yaml' || base === 'app.yml') return 'platform:GCP App Engine';
  if (base === 'Procfile') return 'platform:Heroku';
  // CI deploy
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return 'gh-workflow';
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(rel)) return 'gitlab-ci';
  if (/(^|\/)\.circleci\/config\.ya?ml$/.test(rel)) return 'circleci';
  if (/(^|\/)\.env\.(example|sample|template|dist)$/.test(rel)) return 'env-example';
  return null;
}

// Content-based classifier for ambiguous .yaml/.yml/.json that the name didn't decide
// (K8s/CFN/SAM/ArgoCD/Flux/Crossplane/ARM all look alike by extension). Order matters:
// the most specific apiGroups (crossplane/argo/flux) are checked before generic K8s.
export function classifyConfigByContent(rel, content) {
  if (configFileType(rel)) return null;
  if (!/\.(ya?ml|json)$/.test(rel)) return null;
  const c = String(content || '');
  if (/Transform:\s*AWS::Serverless/m.test(c)) return 'sam';
  if (/AWSTemplateFormatVersion/.test(c) || /Type:\s*['"]?AWS::[A-Za-z0-9]+::/m.test(c)) return 'cloudformation';
  if (/Microsoft\.[A-Za-z]+\//.test(c) && /(deploymentTemplate\.json|"resources"\s*:)/.test(c)) return 'arm';
  if (/\.crossplane\.io\//.test(c)) return 'crossplane';
  if (/argoproj\.io\//.test(c)) return 'argocd';
  if (/toolkit\.fluxcd\.io\//.test(c)) return 'flux';
  if (/^apiVersion:\s*\S/m.test(c) && /^kind:\s*(Deployment|Service|StatefulSet|DaemonSet|ReplicaSet|Ingress|ConfigMap|Pod|Job|CronJob|Namespace|PersistentVolumeClaim|Secret|ServiceAccount|Role|RoleBinding|HorizontalPodAutoscaler|NetworkPolicy)\b/m.test(c)) return 'kubernetes';
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

// ── IaC tooling imported in CODE (aws-cdk-lib, sst, pulumi, cdktf) — this IS infra
// declared in version-controlled code, so it counts toward the IaC property. (Without
// this they fall through to classifyImport and get mislabeled 3rd-party/inferred.) ──
const IAC_IMPORT = [
  { re: /^aws-cdk-lib(\/|$)|^@aws-cdk\//, name: 'AWS CDK', cloud: 'AWS' },
  { re: /^cdktf(\/|$)|^@cdktf\//, name: 'Terraform CDK', cloud: 'multi' },
  { re: /^sst(\/|$)|^@serverless-stack\//, name: 'SST', cloud: 'AWS' },
  { re: /^@pulumi\//, name: 'Pulumi', cloud: 'multi' },
];
function detectIacImport(spec) {
  for (const s of IAC_IMPORT) if (s.re.test(spec)) return { name: s.name, cloud: s.cloud };
  return null;
}

// ── Cost surface (Inform-phase): every detected service is a billable RELATIONSHIP
// ("cost surface opened"), even at $0. Classify the cost MODEL so the report can list
// potential cost sources without claiming dollars (live rates are not probed):
//   standing    — bills even idle (RDS, Fargate/ECS, NAT, ALB, EC2)
//   metered     — pay-per-use (S3, on-demand DynamoDB, Lambda, CloudFront, SES, tokens)
//   subscription— SaaS tier (Vercel, Supabase, Auth0, email providers)
//   connectivity— a 3rd-party API you call, billed by THEM (OpenAI, Anthropic, Stripe)
//   none        — not itself billable (IaC tooling, secrets managers)
const STANDING_RE = /\bRDS\b|Aurora|Cosmos|Cloud SQL|App Service|Service Bus|ALB|ELB|NAT|EC2|Fargate|ECS|\(self-hosted\)/i;
export function costModelFor(s) {
  if (s.kind === 'iac' || s.kind === 'secrets') return 'none';
  // bare hyperscaler catch-all (from AWS_/GCP_/AZURE_ env keys) = credentials, not a
  // specific billable service → not a cost source.
  if (s.kind === 'platform' && ['AWS', 'GCP', 'Azure'].includes(s.cloud)) return 'none';
  const ownCloud = s.residency === 'in-account' || ['AWS', 'GCP', 'Azure', 'self-hosted'].includes(s.cloud);
  if (ownCloud) return STANDING_RE.test(s.name) ? 'standing' : 'metered';
  if (s.cloud === 'platform' || s.cloud === 'Supabase' || s.cloud === 'managed') return 'subscription';
  if (s.cloud === '3rd-party') return s.kind === 'ai' || s.kind === 'payment' ? 'connectivity' : 'subscription';
  return 'unknown';
}

// IaC strength tier per config kind: resource-declaring ≫ schema/migrations >
// platform-config > deploy-automation. The maturity axis weights these.
export function iacTier(ctype) {
  if (['terraform', 'terragrunt', 'sst', 'pulumi', 'cloudformation', 'sam', 'bicep', 'arm', 'serverless', 'cdk', 'cdktf'].includes(ctype)) return 'resource';
  if (['prisma', 'drizzle', 'flyway', 'liquibase', 'alembic'].includes(ctype)) return 'migrations';
  if (['kubernetes', 'helm', 'kustomize', 'crossplane', 'argocd', 'flux'].includes(ctype)) return 'orchestration';
  if (['ansible', 'chef', 'puppet', 'salt'].includes(ctype)) return 'config-mgmt';
  if (['docker', 'docker-compose', 'packer', 'vagrant', 'nix'].includes(ctype)) return 'container';
  if (ctype && ctype.startsWith('platform:')) return 'platform';
  if (['gh-workflow', 'gitlab-ci', 'circleci'].includes(ctype)) return 'ci';
  return 'other';
}

// ── Resource extraction from general-purpose-language IaC (SST/CDK/Pulumi) ──
// These split resources across infra/*.ts modules, NOT just the entry config — so
// extraction must run on every IaC-importing file, else real tables/buckets look
// "inferred" (the click-ops false alarm). Each entry: [regex, friendlyName, kind].
const SST_RES = [
  [/\bsst\.aws\.Function\b|\bnew\s+Function\b/, 'Lambda', 'compute'],
  [/\bsst\.aws\.(Dynamo|Table)\b|\bnew\s+Table\b/, 'DynamoDB', 'database'],
  [/\bsst\.aws\.Bucket\b|\bnew\s+Bucket\b/, 'S3', 'storage'],
  [/\bsst\.aws\.Postgres\b|\bsst\.aws\.Aurora\b|\bnew\s+RDS\b/, 'RDS/Aurora', 'database'],
  [/\bsst\.aws\.Queue\b|\bnew\s+Queue\b/, 'SQS', 'messaging'],
  [/\bsst\.aws\.Topic\b|\bnew\s+Topic\b/, 'SNS', 'messaging'],
  [/\bsst\.aws\.Cron\b|\bnew\s+Cron\b/, 'EventBridge (cron)', 'messaging'],
  [/\bsst\.aws\.Cdn\b|\bnew\s+(StaticSite|NextjsSite|SvelteKitSite|AstroSite)\b|\bsst\.aws\.(Nextjs|StaticSite|SvelteKit|Astro|React)\b/, 'CloudFront', 'network'],
  [/\bsst\.aws\.ApiGatewayV2\b|\bsst\.aws\.Api\b|\bnew\s+Api\b/, 'API Gateway', 'network'],
];
const CDK_RES = [
  [/\bnew\s+(?:s3\.)?Bucket\b/, 'S3', 'storage'],
  [/\bnew\s+(?:dynamodb\.)?Table\b/, 'DynamoDB', 'database'],
  [/\bnew\s+(?:lambda(?:_nodejs|\.)?\.?)?(?:NodejsFunction|Function)\b/, 'Lambda', 'compute'],
  [/\bnew\s+(?:rds\.)?(?:DatabaseInstance|DatabaseCluster|ServerlessCluster)\b/, 'RDS', 'database'],
  [/\bnew\s+(?:sqs\.)?Queue\b/, 'SQS', 'messaging'],
  [/\bnew\s+(?:sns\.)?Topic\b/, 'SNS', 'messaging'],
  [/\bnew\s+(?:cloudfront\.)?Distribution\b/, 'CloudFront', 'network'],
  [/\bnew\s+(?:apigateway\w*\.)?(?:RestApi|HttpApi|LambdaRestApi)\b/, 'API Gateway', 'network'],
];
const PULUMI_RES = [
  [/\bnew\s+aws\.s3\.Bucket(?:V2)?\b/, 'S3', 'storage', 'AWS'],
  [/\bnew\s+aws\.dynamodb\.Table\b/, 'DynamoDB', 'database', 'AWS'],
  [/\bnew\s+aws\.lambda\.(?:Function|CallbackFunction)\b/, 'Lambda', 'compute', 'AWS'],
  [/\bnew\s+aws\.rds\.\w+/, 'RDS', 'database', 'AWS'],
  [/\bnew\s+gcp\.storage\.Bucket\b/, 'Cloud Storage', 'storage', 'GCP'],
  [/\bnew\s+gcp\.\w+/, 'GCP resource', 'compute', 'GCP'],
  [/\bnew\s+azure(?:-native|nm)?\.\w+/, 'Azure resource', 'compute', 'Azure'],
];

/** Extract declared cloud resources from a general-purpose IaC file's content. */
export function extractIacResources(content, tool) {
  const out = [];
  const seen = new Set();
  const add = (name, kind, cloud) => { const k = `${cloud}:${name}`; if (seen.has(k)) return; seen.add(k); out.push({ name, kind, cloud, residency: 'in-account', dataStore: kind === 'database' || kind === 'storage' }); };
  if (tool === 'SST') for (const [re, name, kind] of SST_RES) { if (re.test(content)) add(name, kind, 'AWS'); }
  else if (tool === 'AWS CDK') for (const [re, name, kind] of CDK_RES) { if (re.test(content)) add(name, kind, 'AWS'); }
  else if (tool === 'Pulumi') for (const [re, name, kind, cloud] of PULUMI_RES) { if (re.test(content)) add(name, kind, cloud); }
  return out;
}

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
  } else if (type === 'sst') {
    // SST v3 (sst.aws.*) + v2 (new Bucket/Table/Function). Resources often live in
    // infra/*.ts modules too — those are caught in the code-file pass (extractIacResources).
    push({ name: 'SST', kind: 'iac', cloud: 'AWS', residency: 'in-account' });
    for (const r of extractIacResources(content, 'SST')) push(r);
  } else if (type === 'cdk') {
    push({ name: 'AWS CDK', kind: 'iac', cloud: 'AWS', residency: 'in-account' });
  } else if (type === 'cdktf') {
    push({ name: 'Terraform CDK', kind: 'iac', cloud: 'multi', residency: 'in-account' });
  } else if (type === 'bicep') {
    push({ name: 'Bicep', kind: 'iac', cloud: 'Azure', residency: 'in-account' });
    const BICEP_RES = [[/Microsoft\.Web\/sites/i, 'App Service', 'compute'], [/Microsoft\.Sql/i, 'Azure SQL', 'database'], [/Microsoft\.Storage/i, 'Blob Storage', 'storage'], [/Microsoft\.DocumentDB|Microsoft\.DBforPostgreSQL/i, 'Cosmos/Postgres', 'database'], [/Microsoft\.ServiceBus/i, 'Service Bus', 'messaging']];
    for (const [re, name, kind] of BICEP_RES) if (re.test(content)) push({ name, kind, cloud: 'Azure', residency: 'in-account', dataStore: kind === 'database' || kind === 'storage' });
  } else if (type === 'arm') {
    push({ name: 'ARM template', kind: 'iac', cloud: 'Azure', residency: 'in-account' });
  } else if (type === 'sam') {
    push({ name: 'AWS SAM', kind: 'iac', cloud: 'AWS', residency: 'in-account' });
  } else if (type === 'kubernetes' || type === 'helm' || type === 'kustomize' || type === 'crossplane') {
    push({ name: { kubernetes: 'Kubernetes', helm: 'Helm', kustomize: 'Kustomize', crossplane: 'Crossplane' }[type], kind: 'iac', cloud: 'k8s', residency: 'in-account' });
  } else if (type === 'argocd' || type === 'flux') {
    push({ name: type === 'argocd' ? 'ArgoCD' : 'Flux', kind: 'iac', cloud: 'k8s', residency: 'in-account' });
  } else if (type === 'ansible' || type === 'chef' || type === 'puppet' || type === 'salt') {
    push({ name: { ansible: 'Ansible', chef: 'Chef', puppet: 'Puppet', salt: 'Salt' }[type], kind: 'iac', cloud: 'multi', residency: 'in-account' });
  } else if (type === 'docker' || type === 'packer' || type === 'vagrant' || type === 'nix') {
    push({ name: { docker: 'Docker', packer: 'Packer', vagrant: 'Vagrant', nix: 'Nix' }[type], kind: 'iac', cloud: 'any', residency: 'in-account' });
  } else if (type === 'terragrunt') {
    push({ name: 'Terragrunt', kind: 'iac', cloud: 'multi', residency: 'in-account' });
  } else if (type === 'gitlab-ci' || type === 'circleci') {
    push({ name: type === 'gitlab-ci' ? 'GitLab CI' : 'CircleCI', kind: 'iac', cloud: 'unknown', residency: 'in-account', detectedBy: 'platform-config' });
  } else if (type === 'flyway' || type === 'liquibase' || type === 'alembic') {
    push({ name: { flyway: 'Flyway', liquibase: 'Liquibase', alembic: 'Alembic' }[type] + ' (migrations)', kind: 'database', cloud: 'managed', residency: 'varies', dataStore: true });
  } else if (type === 'drizzle') {
    push({ name: 'Drizzle (migrations)', kind: 'database', cloud: 'managed', residency: 'varies', dataStore: true, declares: ['drizzle.config'] });
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

// Hand-rolled deploy detection — the OPPOSITE of IaC. A deploy.sh that shells out to
// the cloud CLI, or an inline IAM policy JSON committed beside it, means resources are
// provisioned OUT of code review / drift-detection (click-ops via script). Makes the
// IaC-coverage finding precise: "declared nowhere" → "deployed by this shell script".
export function detectDeployScript(rel, content) {
  const base = rel.split('/').pop() || '';
  const c = String(content || '');
  if (/(^|\/)deploy[\w.-]*\.sh$/i.test(rel) || (/\.sh$/.test(rel) && /\b(aws|gcloud|az|kubectl|serverless)\s+\w/.test(c))) {
    const provisions = [];
    if (/aws\s+lambda/i.test(c)) provisions.push('Lambda');
    if (/aws\s+iam/i.test(c)) provisions.push('IAM');
    if (/aws\s+s3/i.test(c)) provisions.push('S3');
    if (/aws\s+dynamodb/i.test(c)) provisions.push('DynamoDB');
    if (/aws\s+(ecs|ec2|cloudfront|apigateway)/i.test(c)) provisions.push('other-AWS');
    return { kind: 'shell-deploy', provisions };
  }
  if (/(^|\/)([\w-]*[-.])?(trust-)?policy\.json$/i.test(base) || (/\.json$/.test(rel) && /"Effect"\s*:/.test(c) && /"Action"\s*:/.test(c) && /"Statement"\s*:/.test(c))) {
    return { kind: 'iam-policy', provisions: [] };
  }
  return null;
}

/**
 * Pure inventory builder.
 * @param {Array<{rel,isClient?,specifiers?,content?}>} files — content set for config files
 */
export function buildInfraInventory(files = []) {
  const merged = new Map(); // name -> service
  const iac = [];
  const deployScripts = [];
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

  // tiers that count as genuine infra-as-code (drive the HIGH signal); platform-config
  // + CI-deploy are weaker (medium).
  const GENUINE_IAC = new Set(['resource', 'migrations', 'orchestration', 'config-mgmt', 'container']);
  for (const f of files) {
    if (f.isClient) clientFiles++;
    else serverFiles++;
    // hand-rolled deploy (non-IaC) — capture + skip further processing.
    const ds = detectDeployScript(f.rel, f.content);
    if (ds) { deployScripts.push({ file: f.rel, kind: ds.kind, provisions: ds.provisions }); continue; }
    // name first; fall back to content sniffing for ambiguous yaml/json.
    const ctype = configFileType(f.rel) || (typeof f.content === 'string' ? classifyConfigByContent(f.rel, f.content) : null);
    if (ctype) {
      if (ctype === 'env-example') hasEnvExample = true;
      const dets = parseConfig(ctype, f.content || '', f.rel);
      if (dets.length) { for (const d of dets) record(d, f.rel); if (d_isIacKind(dets)) iacDeclared = true; }
      const tier = iacTier(ctype);
      if (ctype !== 'env-example') iac.push({ provider: prettyConfigType(ctype), file: f.rel, tier });
      if (GENUINE_IAC.has(tier)) iacDeclared = true;
      // a config file isn't ALSO a code file — don't fall through to import scanning.
      if (configFileType(f.rel)) continue;
    }
    // code file → IaC tooling import (declared infra; extract resources from the
    // module — SST/CDK/Pulumi split resources across infra/*.ts) → SDK → import infer
    const fileIac = (f.specifiers || []).reduce((acc, s) => acc || detectIacImport(s), null);
    if (fileIac) {
      record({ name: fileIac.name, kind: 'iac', cloud: fileIac.cloud, residency: 'in-account', detectedBy: 'iac-import', confidence: 'high' }, f.rel);
      iacDeclared = true;
      if (typeof f.content === 'string') for (const r of extractIacResources(f.content, fileIac.name)) record({ ...r, detectedBy: 'iac-declared', confidence: 'high' }, f.rel);
    }
    // Content-based IaC extraction — declared infra with NO re-detectable import.
    // SST v3 uses the ambient `sst.aws.*` global (no import at all); Pulumi/CDK
    // constructs may also appear in modules whose import wasn't matched. Run the
    // construct extractor by content signature regardless of import; record() dedupes
    // by name so the import-based path above is not double-counted.
    if (typeof f.content === 'string') {
      const contentTool =
        /\bsst\.aws\./.test(f.content) ? 'SST' :
        /\bnew\s+aws\.\w+\./.test(f.content) ? 'Pulumi' :
        /aws-cdk-lib|@aws-cdk\//.test(f.content) || /\bcdk\.(App|Stack)\b/.test(f.content) ? 'AWS CDK' :
        null;
      if (contentTool) {
        for (const r of extractIacResources(f.content, contentTool)) record({ ...r, detectedBy: 'iac-declared', confidence: 'high' }, f.rel);
        iacDeclared = true;
      }
    }
    for (const spec of f.specifiers || []) {
      if (detectIacImport(spec)) continue; // handled above
      const c = detectCloudSdk(spec);
      if (c) { record({ ...c, detectedBy: 'sdk-import', confidence: 'medium' }, f.rel); continue; }
      const d = classifyImport(spec);
      if (d) record({ name: d.provider, kind: mapPrivacyKind(d.kind), cloud: cloudForProvider(d), residency: d.residency, dataStore: d.kind === 'db', detectedBy: 'sdk-import', confidence: 'medium' }, f.rel);
      else if (classifyPath(f.rel)?.kind === 'infra') { /* handled by config path */ }
    }
  }

  const services = [...merged.values()]
    .map((e) => {
      const s = { name: e.name, kind: e.kind, cloud: e.cloud, residency: e.residency, dataStore: e.dataStore, detectedBy: [...e.detectedBy], confidence: e.confidence, declares: [...e.declares].slice(0, 6), fileCount: e.files.size, files: [...e.files].sort().slice(0, 8) };
      return { ...s, costModel: costModelFor(s) };
    })
    .sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || b.fileCount - a.fileCount);

  const external = services.filter((s) => s.residency === 'external').map((s) => ({ provider: s.name, kind: s.kind, fileCount: s.fileCount, detectedBy: s.detectedBy }));
  const clouds = [...new Set(services.map((s) => s.cloud))].filter((c) => c && c !== 'unknown');
  const dataStoreCount = services.filter((s) => s.dataStore).length;

  // ── Cost surface: potential cost sources grouped by model (no dollars — see above) ──
  const costSurface = { standing: 0, metered: 0, subscription: 0, connectivity: 0 };
  for (const s of services) if (costSurface[s.costModel] != null) costSurface[s.costModel]++;

  // ── IaC coverage: of the OWN-CLOUD resources you provision (standing/metered), how
  // many are DECLARED in code vs only inferred-from-usage? Low ratio = the click-ops
  // smell (resources used but declared nowhere — invisible to cost/audit/repro). ──
  const DECLARED_BY = new Set(['iac-declared', 'iac-import', 'platform-config']);
  const provisionable = services.filter((s) => (s.costModel === 'standing' || s.costModel === 'metered') && ['AWS', 'GCP', 'Azure', 'self-hosted'].includes(s.cloud) && !['platform', 'iac', 'secrets'].includes(s.kind));
  const declaredProvisionable = provisionable.filter((s) => s.detectedBy.some((d) => DECLARED_BY.has(d)));
  const iacCoverage = {
    provisionable: provisionable.length,
    declared: declaredProvisionable.length,
    ratio: provisionable.length ? declaredProvisionable.length / provisionable.length : null,
    undeclared: provisionable.filter((s) => !s.detectedBy.some((d) => DECLARED_BY.has(d))).map((s) => s.name).slice(0, 12),
  };
  const resourceIacFiles = iac.filter((i) => ['resource', 'migrations', 'orchestration', 'config-mgmt', 'container'].includes(i.tier)).length;
  // IaC files grouped by family/tier (for the report's tiered display).
  const iacByTier = {};
  for (const i of iac) (iacByTier[i.tier || 'other'] ||= []).push(i.provider);

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
    deployScripts,
    external,
    clouds,
    boundaries: { clientFiles, serverFiles, externalTouchingFiles: externalTouchedBy.size },
    signalQuality,
    costSurface,
    iacCoverage,
    summary: {
      serviceCount: services.length,
      dataStoreCount,
      aiCount: services.filter((s) => s.kind === 'ai').length,
      externalProcessorCount: external.length,
      clouds,
      iacProviders: [...new Set(iac.map((i) => i.provider))],
      resourceIacFiles,
      iacByTier,
      deployScriptCount: deployScripts.length,
      costSurface,
      iacCoverage,
    },
  };
}

/**
 * Pass 2 — graph-informed IaC enrichment. Given the inventory from
 * buildInfraInventory plus a knowledge graph ({nodes:[{source_file}]}) and its
 * resolved import topology ({hubs:[{file,inDegree}]} and/or an importsByFile map),
 * annotate each service with:
 *   - fanIn: how many distinct files reach this service. Precise when an import
 *     graph is available (sum of hub in-degrees for the service's files); otherwise
 *     approximated by the service's own file count.
 *   - centralized: true when usage is concentrated in <=3 files OR sits behind a
 *     single directory (a single, swappable seam vs. sprawled coupling).
 * Pure: returns a NEW inventory, never mutates. Defensive: null graph/resolved →
 * inventory returned unchanged.
 * @param {object} inventory — output of buildInfraInventory
 * @param {{nodes?:Array<{source_file?:string}>}|null} graph
 * @param {{hubs?:Array<{file:string,inDegree?:number}>, importsByFile?:Record<string,string[]>}|null} resolved
 */
export function enrichInfraWithGraph(inventory, graph, resolved) {
  if (!inventory || !graph || !resolved) return inventory;
  const hubsByFile = new Map();
  if (Array.isArray(resolved.hubs)) for (const h of resolved.hubs) if (h && h.file) hubsByFile.set(h.file, Number(h.inDegree) || 0);
  const importsByFile = resolved.importsByFile && typeof resolved.importsByFile === 'object' ? resolved.importsByFile : null;

  const services = (inventory.services || []).map((s) => {
    const files = Array.isArray(s.files) ? s.files : [];
    const base = typeof s.fileCount === 'number' ? s.fileCount : files.length;
    // fanIn — prefer precise import-graph in-degree summed over the service's files.
    let fanIn = base;
    if (hubsByFile.size) {
      const summed = files.reduce((acc, f) => acc + (hubsByFile.get(f) || 0), 0);
      if (summed > 0) fanIn = summed;
    } else if (importsByFile) {
      const fileSet = new Set(files);
      let count = 0;
      for (const [, imports] of Object.entries(importsByFile)) if (Array.isArray(imports) && imports.some((t) => fileSet.has(t))) count++;
      if (count > 0) fanIn = count;
    }
    // centralized — concentrated usage (<=3 files) or behind a single directory.
    const dirs = new Set(files.map((f) => f.split('/').slice(0, -1).join('/')));
    const centralized = base <= 3 || dirs.size <= 1;
    return { ...s, fanIn, centralized };
  });

  return { ...inventory, services };
}

function d_isIacKind(dets) { return dets.some((d) => d.kind === 'iac'); }
function prettyConfigType(t) {
  if (t.startsWith('platform:')) return t.slice('platform:'.length);
  return {
    prisma: 'Prisma', terraform: 'Terraform', terragrunt: 'Terragrunt', serverless: 'Serverless',
    'docker-compose': 'Docker Compose', docker: 'Dockerfile', pulumi: 'Pulumi', cloudformation: 'CloudFormation',
    sam: 'AWS SAM', bicep: 'Bicep', arm: 'ARM', sst: 'SST', cdk: 'AWS CDK', cdktf: 'Terraform CDK',
    kubernetes: 'Kubernetes', helm: 'Helm', kustomize: 'Kustomize', crossplane: 'Crossplane',
    argocd: 'ArgoCD', flux: 'Flux', ansible: 'Ansible', chef: 'Chef', puppet: 'Puppet', salt: 'Salt',
    packer: 'Packer', vagrant: 'Vagrant', nix: 'Nix', drizzle: 'Drizzle', flyway: 'Flyway',
    liquibase: 'Liquibase', alembic: 'Alembic', 'gh-workflow': 'CI workflow', 'gitlab-ci': 'GitLab CI', circleci: 'CircleCI',
  }[t] || t;
}
function mapPrivacyKind(k) { return k === 'thirdParty' ? 'third-party' : k; }
function cloudForProvider(d) {
  if (d.kind === 'db') return d.provider === 'DynamoDB' ? 'AWS' : d.provider === 'Supabase' ? 'Supabase' : 'managed';
  if (d.kind === 'infra') return 'unknown'; // IaC tool not matched by IAC_IMPORT (e.g. Serverless Framework import)
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
  const ALLOW_DOT = new Set(['.github', '.circleci']);
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.' && !ALLOW_DOT.has(e.name) && !/^\.env\.(example|sample|template|dist)$/.test(e.name) && !/^\.gitlab-ci\.ya?ml$/.test(e.name)) continue;
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
    // ambiguous yaml/json/hcl/bicep need content for content-classification.
    const isAmbiguous = !ctype && /\.(ya?ml|json|hcl|bicep)$/.test(rel);
    // hand-rolled deploy scripts / inline IAM policies (non-IaC signal).
    const isDeployish = /\.sh$/.test(rel) || /(^|\/)([\w-]*[-.])?(trust-)?policy\.json$/i.test(rel);
    if (!ctype && !isCode && !isAmbiguous && !isDeployish) continue;
    let code = '';
    try { if (fs.statSync(full).size < 512 * 1024) code = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const specs = isCode ? specifiers(code) : [];
    // include content for code files that declare infra (under infra/stacks, or that
    // import an IaC tool) so SST/CDK/Pulumi resources in modules are extracted.
    const iacModule = isCode && (/(^|\/)(infra|stacks|stack|deploy)\//.test(rel) || /aws-cdk-lib|@aws-cdk\/|['"]sst['"]|['"]sst\/|sst\.aws\.|@pulumi\/|cdktf|\bnew\s+aws\.\w+\./.test(code));
    files.push({
      rel,
      specifiers: specs,
      content: ctype || isAmbiguous || iacModule || isDeployish ? code : undefined,
      isClient: isCode && /^\s*['"]use client['"]/m.test(code),
    });
  }
  const inv = buildInfraInventory(files);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...inv }, null, 2));
  console.error(
    `[infra-extract] signal:${inv.signalQuality.level} clouds:${inv.clouds.join('/') || 'none'} services:${inv.summary.serviceCount} stores:${inv.summary.dataStoreCount} external:${inv.summary.externalProcessorCount} → ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
