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
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { classifyImport, classifyPath } from './privacy-detectors.mjs';

// ── 1. SDK/package catalog (provider-agnostic cloud + service SDKs) ──
// residency: in-account = stays in the operator's own cloud · external = leaves.
export const CLOUD_SDK = [
  // AWS
  {
    re: /^@aws-sdk\/(client|lib)-dynamodb/,
    name: 'DynamoDB',
    kind: 'database',
    cloud: 'AWS',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@aws-sdk\/client-rds/,
    name: 'RDS',
    kind: 'database',
    cloud: 'AWS',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@aws-sdk\/client-s3|^@aws-sdk\/lib-storage/,
    name: 'S3',
    kind: 'storage',
    cloud: 'AWS',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@aws-sdk\/client-lambda/,
    name: 'Lambda',
    kind: 'compute',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-sdk\/client-cloudfront/,
    name: 'CloudFront',
    kind: 'network',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-sdk\/client-elastic-load-balancing/,
    name: 'ALB/ELB',
    kind: 'network',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-sdk\/client-cognito/,
    name: 'Cognito',
    kind: 'auth',
    cloud: 'AWS',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@aws-sdk\/client-ses|^@aws-sdk\/client-sesv2/,
    name: 'SES',
    kind: 'email',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-sdk\/client-(sns|sqs|eventbridge)/,
    name: 'SNS/SQS/EventBridge',
    kind: 'messaging',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-sdk\/client-bedrock/,
    name: 'Bedrock',
    kind: 'ai',
    cloud: 'AWS',
    residency: 'in-account',
  },
  {
    re: /^@aws-amplify\//,
    name: 'Amplify',
    kind: 'platform',
    cloud: 'AWS',
    residency: 'in-account',
  },
  // GCP
  {
    re: /^@google-cloud\/firestore|^firebase-admin\/firestore/,
    name: 'Firestore',
    kind: 'database',
    cloud: 'GCP',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@google-cloud\/storage/,
    name: 'Cloud Storage',
    kind: 'storage',
    cloud: 'GCP',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@google-cloud\/bigquery/,
    name: 'BigQuery',
    kind: 'database',
    cloud: 'GCP',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@google-cloud\/pubsub/,
    name: 'Pub/Sub',
    kind: 'messaging',
    cloud: 'GCP',
    residency: 'in-account',
  },
  {
    re: /^@google-cloud\/run|^@google-cloud\/functions/,
    name: 'Cloud Run/Functions',
    kind: 'compute',
    cloud: 'GCP',
    residency: 'in-account',
  },
  {
    re: /^@google-cloud\/secret-manager/,
    name: 'Secret Manager',
    kind: 'secrets',
    cloud: 'GCP',
    residency: 'in-account',
  },
  {
    re: /^firebase(\/|$)|^firebase-admin(\/|$)/,
    name: 'Firebase',
    kind: 'platform',
    cloud: 'GCP',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@google-cloud\/aiplatform|^@google\/generative-ai/,
    name: 'Vertex AI / Gemini',
    kind: 'ai',
    cloud: 'GCP',
    residency: 'external',
  },
  // Azure
  {
    re: /^@azure\/cosmos/,
    name: 'Cosmos DB',
    kind: 'database',
    cloud: 'Azure',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@azure\/storage-blob/,
    name: 'Blob Storage',
    kind: 'storage',
    cloud: 'Azure',
    residency: 'in-account',
    dataStore: true,
  },
  {
    re: /^@azure\/service-bus/,
    name: 'Service Bus',
    kind: 'messaging',
    cloud: 'Azure',
    residency: 'in-account',
  },
  {
    re: /^@azure\/keyvault/,
    name: 'Key Vault',
    kind: 'secrets',
    cloud: 'Azure',
    residency: 'in-account',
  },
  {
    re: /^@azure\/identity|^@azure\/functions|^@azure\//,
    name: 'Azure SDK',
    kind: 'platform',
    cloud: 'Azure',
    residency: 'in-account',
  },
  // Supabase (managed Postgres + auth + storage)
  {
    re: /^@supabase\//,
    name: 'Supabase',
    kind: 'database',
    cloud: 'Supabase',
    residency: 'external',
    dataStore: true,
  },
  // Graph databases reached over the shared Bolt driver (self-hosted Memgraph / Neo4j)
  {
    re: /^neo4j-driver(\/|$)|^@neo4j\//,
    name: 'Neo4j/Memgraph (graph DB)',
    kind: 'database',
    cloud: 'self-hosted',
    residency: 'in-account',
    dataStore: true,
  },
  // Email / messaging 3rd-party
  {
    re: /^nodemailer/,
    name: 'SMTP (nodemailer)',
    kind: 'email',
    cloud: '3rd-party',
    residency: 'external',
  },
  { re: /^resend/, name: 'Resend', kind: 'email', cloud: '3rd-party', residency: 'external' },
  { re: /^postmark/, name: 'Postmark', kind: 'email', cloud: '3rd-party', residency: 'external' },
  { re: /^mailgun/, name: 'Mailgun', kind: 'email', cloud: '3rd-party', residency: 'external' },
  // Gaming / distribution
  {
    re: /^steamworks(\.js)?$|^greenworks/,
    name: 'Steam',
    kind: 'gaming',
    cloud: '3rd-party',
    residency: 'external',
  },
];

export function detectCloudSdk(spec) {
  for (const s of CLOUD_SDK)
    if (s.re.test(spec))
      return {
        name: s.name,
        kind: s.kind,
        cloud: s.cloud,
        residency: s.residency,
        dataStore: !!s.dataStore,
      };
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
  if (/(^|\/)(playbook|site)\.ya?ml$|(^|\/)ansible\.cfg$|(^|\/)(roles|playbooks)\//.test(rel))
    return 'ansible';
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
  if (/AWSTemplateFormatVersion/.test(c) || /Type:\s*['"]?AWS::[A-Za-z0-9]+::/m.test(c))
    return 'cloudformation';
  if (/Microsoft\.[A-Za-z]+\//.test(c) && /(deploymentTemplate\.json|"resources"\s*:)/.test(c))
    return 'arm';
  if (/\.crossplane\.io\//.test(c)) return 'crossplane';
  if (/argoproj\.io\//.test(c)) return 'argocd';
  if (/toolkit\.fluxcd\.io\//.test(c)) return 'flux';
  if (
    /^apiVersion:\s*\S/m.test(c) &&
    /^kind:\s*(Deployment|Service|StatefulSet|DaemonSet|ReplicaSet|Ingress|ConfigMap|Pod|Job|CronJob|Namespace|PersistentVolumeClaim|Secret|ServiceAccount|Role|RoleBinding|HorizontalPodAutoscaler|NetworkPolicy)\b/m.test(
      c,
    )
  )
    return 'kubernetes';
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
const tfCloud = (rt) =>
  /^aws_/.test(rt)
    ? 'AWS'
    : /^google_/.test(rt)
      ? 'GCP'
      : /^azurerm_|^azuread_/.test(rt)
        ? 'Azure'
        : 'unknown';

// env-key name → provider (the KEY, never the value)
const ENV_KEY = [
  [
    /^(NEXT_PUBLIC_)?SUPABASE_/i,
    {
      name: 'Supabase',
      kind: 'database',
      cloud: 'Supabase',
      residency: 'external',
      dataStore: true,
    },
  ],
  [
    /^(GCP_|GOOGLE_CLOUD_|GCLOUD_|GOOGLE_APPLICATION_CREDENTIALS)/i,
    { name: 'GCP', kind: 'platform', cloud: 'GCP', residency: 'in-account' },
  ],
  [
    /^(FIREBASE_)/i,
    { name: 'Firebase', kind: 'platform', cloud: 'GCP', residency: 'in-account', dataStore: true },
  ],
  [/^AZURE_/i, { name: 'Azure', kind: 'platform', cloud: 'Azure', residency: 'in-account' }],
  [/^AWS_/i, { name: 'AWS', kind: 'platform', cloud: 'AWS', residency: 'in-account' }],
  [
    /^(MEMGRAPH_|NEO4J_)/i,
    {
      name: 'Neo4j/Memgraph (graph DB)',
      kind: 'database',
      cloud: 'self-hosted',
      residency: 'in-account',
      dataStore: true,
    },
  ],
  [/^STEAM_/i, { name: 'Steam', kind: 'gaming', cloud: '3rd-party', residency: 'external' }],
  [/^RESEND_/i, { name: 'Resend', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^POSTMARK_/i, { name: 'Postmark', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^MAILGUN_/i, { name: 'Mailgun', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^SENDGRID_/i, { name: 'SendGrid', kind: 'email', cloud: '3rd-party', residency: 'external' }],
  [/^STRIPE_/i, { name: 'Stripe', kind: 'payment', cloud: '3rd-party', residency: 'external' }],
  [/^OPENAI_/i, { name: 'OpenAI', kind: 'ai', cloud: '3rd-party', residency: 'external' }],
  [
    /^ANTHROPIC_/i,
    { name: 'Anthropic (Claude API)', kind: 'ai', cloud: '3rd-party', residency: 'external' },
  ],
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
const STANDING_RE =
  /\bRDS\b|Aurora|Cosmos|Cloud SQL|App Service|Service Bus|ALB|ELB|NAT|EC2|Fargate|ECS|\(self-hosted\)/i;
export function costModelFor(s) {
  if (s.kind === 'iac' || s.kind === 'secrets') return 'none';
  // bare hyperscaler catch-all (from AWS_/GCP_/AZURE_ env keys) = credentials, not a
  // specific billable service → not a cost source.
  if (s.kind === 'platform' && ['AWS', 'GCP', 'Azure'].includes(s.cloud)) return 'none';
  const ownCloud =
    s.residency === 'in-account' || ['AWS', 'GCP', 'Azure', 'self-hosted'].includes(s.cloud);
  if (ownCloud) return STANDING_RE.test(s.name) ? 'standing' : 'metered';
  if (s.cloud === 'platform' || s.cloud === 'Supabase' || s.cloud === 'managed')
    return 'subscription';
  if (s.cloud === '3rd-party')
    return s.kind === 'ai' || s.kind === 'payment' ? 'connectivity' : 'subscription';
  return 'unknown';
}

// IaC strength tier per config kind: resource-declaring ≫ schema/migrations >
// platform-config > deploy-automation. The maturity axis weights these.
export function iacTier(ctype) {
  // CDKTF was archived by HashiCorp on 2025-12-10. It IS still infra (kept detected),
  // but it must NOT score as a healthy 'resource'-tier signal — gradeIacMaturity flags
  // it as a deprecation finding instead.
  if (ctype === 'cdktf') return 'deprecated';
  if (
    [
      'terraform',
      'terragrunt',
      'sst',
      'pulumi',
      'cloudformation',
      'sam',
      'bicep',
      'arm',
      'serverless',
      'cdk',
    ].includes(ctype)
  )
    return 'resource';
  if (['prisma', 'drizzle', 'flyway', 'liquibase', 'alembic'].includes(ctype)) return 'migrations';
  if (['kubernetes', 'helm', 'kustomize', 'crossplane', 'argocd', 'flux'].includes(ctype))
    return 'orchestration';
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
// P1 — CONSTRUCTOR-INVOCATION syntax only. Each construct must be an actual
// factory/constructor call (followed by `(`), never a bare class token. This kills
// the phantom-DynamoDB defect where an app's UI `new Table(` / `new Bucket(` class
// was mis-credited as a declared AWS resource. SST v3 is a factory (`sst.aws.Dynamo(`
// with or without `new`); CDK/Pulumi are `new <ctor>(`.
const SST_RES = [
  [/\b(?:new\s+)?sst\.aws\.Function\s*\(/, 'Lambda', 'compute'],
  [/\b(?:new\s+)?sst\.aws\.(?:Dynamo|Table)\s*\(/, 'DynamoDB', 'database'],
  [/\b(?:new\s+)?sst\.aws\.Bucket\s*\(/, 'S3', 'storage'],
  [/\b(?:new\s+)?sst\.aws\.(?:Postgres|Aurora)\s*\(/, 'RDS/Aurora', 'database'],
  [/\b(?:new\s+)?sst\.aws\.Queue\s*\(/, 'SQS', 'messaging'],
  [/\b(?:new\s+)?sst\.aws\.Topic\s*\(/, 'SNS', 'messaging'],
  [/\b(?:new\s+)?sst\.aws\.Cron\s*\(/, 'EventBridge (cron)', 'messaging'],
  [
    /\b(?:new\s+)?sst\.aws\.(?:Cdn|Nextjs|StaticSite|SvelteKit|Astro|React)\s*\(|\bnew\s+(?:StaticSite|NextjsSite|SvelteKitSite|AstroSite)\s*\(/,
    'CloudFront',
    'network',
  ],
  [/\b(?:new\s+)?sst\.aws\.(?:ApiGatewayV2|Api)\s*\(/, 'API Gateway', 'network'],
];
const CDK_RES = [
  [/\bnew\s+(?:s3\.)?Bucket\s*\(/, 'S3', 'storage'],
  [/\bnew\s+(?:dynamodb\.)?Table\s*\(/, 'DynamoDB', 'database'],
  [/\bnew\s+(?:lambda(?:_nodejs|\.)?\.?)?(?:NodejsFunction|Function)\s*\(/, 'Lambda', 'compute'],
  [
    /\bnew\s+(?:rds\.)?(?:DatabaseInstance|DatabaseCluster|ServerlessCluster)\s*\(/,
    'RDS',
    'database',
  ],
  [/\bnew\s+(?:sqs\.)?Queue\s*\(/, 'SQS', 'messaging'],
  [/\bnew\s+(?:sns\.)?Topic\s*\(/, 'SNS', 'messaging'],
  [/\bnew\s+(?:cloudfront\.)?Distribution\s*\(/, 'CloudFront', 'network'],
  [/\bnew\s+(?:apigateway\w*\.)?(?:RestApi|HttpApi|LambdaRestApi)\s*\(/, 'API Gateway', 'network'],
];
const PULUMI_RES = [
  [/\bnew\s+aws\.s3\.Bucket(?:V2)?\s*\(/, 'S3', 'storage', 'AWS'],
  [/\bnew\s+aws\.dynamodb\.Table\s*\(/, 'DynamoDB', 'database', 'AWS'],
  [/\bnew\s+aws\.lambda\.(?:Function|CallbackFunction)\s*\(/, 'Lambda', 'compute', 'AWS'],
  [/\bnew\s+aws\.rds\.\w+\s*\(/, 'RDS', 'database', 'AWS'],
  [/\bnew\s+gcp\.storage\.Bucket\s*\(/, 'Cloud Storage', 'storage', 'GCP'],
  [/\bnew\s+gcp(?:\.\w+)+\s*\(/, 'GCP resource', 'compute', 'GCP'],
  [/\bnew\s+azure(?:-native|nm)?(?:\.\w+)+\s*\(/, 'Azure resource', 'compute', 'Azure'],
];

// P1 — strip comments before construct extraction so a COMMENT that mentions
// `sst.aws.Dynamo` (e.g. Mycelium sst.config.ts:81 "not declared as sst.aws.Dynamo")
// can never be read as a declaration (defect D1). Removes // and /* */ (code + HCL)
// and leading-# comments (yaml/hcl/tfvars/toml). Preserves `://` (URLs) and TS `#`
// private fields. When `rel` is unknown the content is treated as code (SST/CDK/Pulumi
// constructs only ever live in general-purpose-language files).
export function stripComments(content, rel = '') {
  let c = String(content || '');
  const codeLike = !rel || /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel);
  const hclLike = /\.(tf|tofu|hcl)$/.test(rel);
  const hashLike = /\.(ya?ml|tfvars|toml)$/.test(rel) || hclLike;
  if (codeLike || hclLike) {
    c = c.replace(/\/\*[\s\S]*?\*\//g, '');
    c = c.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }
  if (hashLike) c = c.replace(/(^|\s)#[^\n]*/g, '$1');
  return c;
}

// P1 — ARN service segment → friendly resource (used-but-undeclared references from
// IAM policy / permission blocks). NOT a declaration — these are resources the code
// is granted access to but does not provision here.
const ARN_SVC = {
  dynamodb: { name: 'DynamoDB', kind: 'database', dataStore: true },
  s3: { name: 'S3', kind: 'storage', dataStore: true },
  lambda: { name: 'Lambda', kind: 'compute' },
  sqs: { name: 'SQS', kind: 'messaging' },
  sns: { name: 'SNS', kind: 'messaging' },
};

// P2 — AWS::Service::Kind (CloudFormation/SAM/serverless resource types) → friendly
// service. Broader than ARN_SVC because CFN enumerates the full resource graph.
// value: [friendlyName, kind, dataStore].
const AWS_SVC_MAP = {
  dynamodb: ['DynamoDB', 'database', true],
  s3: ['S3', 'storage', true],
  lambda: ['Lambda', 'compute', false],
  sqs: ['SQS', 'messaging', false],
  sns: ['SNS', 'messaging', false],
  rds: ['RDS', 'database', true],
  cloudfront: ['CloudFront', 'network', false],
  apigateway: ['API Gateway', 'network', false],
  apigatewayv2: ['API Gateway', 'network', false],
  cognito: ['Cognito', 'auth', true],
  serverless: ['Lambda', 'compute', false],
  ec2: ['EC2', 'compute', false],
  elasticloadbalancingv2: ['ALB/ELB', 'network', false],
};

// P2 — normalize the ARN resource segment to a bare resource name. Table/bucket/
// function sub-paths and /index/* /-* suffixes collapse so the same physical
// resource is not double-counted. A pure `*` (no name) is dropped.
export function normalizeArnResource(svc, raw) {
  let r = String(raw || '').trim();
  if (!r) return null;
  if (svc === 'dynamodb') {
    const mm = r.match(/table\/([^/]+)/i);
    if (mm) r = mm[1];
  } else if (svc === 's3') {
    r = r.replace(/\/.*$/, '');
  } else if (svc === 'lambda') {
    const mm = r.match(/function:([^:]+)/i);
    if (mm) r = mm[1];
  } else if (svc === 'sqs' || svc === 'sns') {
    r = r.split(/[:/]/).pop();
  } else {
    r = r.replace(/^[^/:]+[/:]/, '');
  }
  r = (r || '').trim();
  // A wildcard (`*` or `Mycelium_*`) names a CLASS of resources, and a `${VAR}` template
  // literal is unresolved — neither is an enumerable resource, so it never counts.
  if (!r || r.includes('*') || r.includes('${')) return null;
  return r;
}

/**
 * Extract used-but-undeclared references from IAM policy / permission ARNs.
 * An `arn:aws:<svc>:...:table/…` inside a policy proves the resource is REFERENCED
 * (granted), not that it is declared here — so each maps to a service tagged
 * detectedBy 'iam-grant', declared:false (never counted as declared in iacCoverage).
 * P2 — each grant now also carries resources[]: the specific/​wildcard resource
 * names from its ARNs, tagged existence:'unknown' (referenced, never declared here).
 */
export function extractIamGrants(content) {
  const out = [];
  const byService = new Map(); // friendly name -> grant entry (accumulates resources)
  const seenRes = new Set();
  // Region + account segments tolerate `${...}` interpolation (SST/CDK build ARNs from
  // template literals, e.g. arn:aws:dynamodb:${REGION}:${ACCT}:table/Mycelium_*). The
  // resource capture stops at a quote/backtick/bracket so the literal ends cleanly.
  for (const m of String(content || '').matchAll(
    /arn:aws:([a-z0-9-]+):(?:\$\{[^}]*\}|[a-z0-9-]*):(?:\$\{[^}]*\}|[0-9*]*):([^\s"'`\\)}\]]+)/gi,
  )) {
    const svc = m[1].toLowerCase();
    const hit = ARN_SVC[svc];
    if (!hit) continue;
    let entry = byService.get(hit.name);
    if (!entry) {
      entry = {
        name: hit.name,
        kind: hit.kind,
        cloud: 'AWS',
        residency: 'in-account',
        dataStore: !!hit.dataStore,
        detectedBy: 'iam-grant',
        confidence: 'medium',
        declared: false,
        resources: [],
      };
      byService.set(hit.name, entry);
      out.push(entry);
    }
    const resName = normalizeArnResource(svc, m[2]);
    if (resName && !seenRes.has(`${hit.name}:${resName}`)) {
      seenRes.add(`${hit.name}:${resName}`);
      entry.resources.push({
        name: resName,
        kind: hit.kind,
        declared: false,
        existence: 'unknown',
        evidence: `IAM grant ARN (${resName.includes('*') ? 'wildcard' : 'specific'})`,
      });
    }
  }
  return out;
}

// P2 — the logical/resource name of an IaC construct is the first quoted string in
// its argument list (skipping a leading bare identifier like CDK's `this` scope arg).
// `stripped` is the comment-free content, `end` the index just past the construct's
// opening `(`. Returns the name or null (unnamed construct).
function constructName(stripped, end) {
  const win = stripped.slice(end, end + 200);
  const m = win.match(/^\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?["'`]([^"'`]+)["'`]/);
  return m ? m[1] : null;
}

/**
 * Extract declared cloud resources from a general-purpose IaC file's content.
 * P2 — each service entry now also carries resources[]: one per construct
 * INVOCATION (declared:true, existence:'declared'), named by the construct's first
 * string argument, so 3 `new sst.aws.Dynamo(...)` calls enumerate 3 tables.
 */
export function extractIacResources(content, tool) {
  const bySvc = new Map();
  const stripped = stripComments(content); // P1: comments are never declarations
  const RES =
    tool === 'SST' ? SST_RES : tool === 'AWS CDK' ? CDK_RES : tool === 'Pulumi' ? PULUMI_RES : null;
  if (!RES) return [];
  for (const entry of RES) {
    const [re, name, kind] = entry;
    const cloud = tool === 'Pulumi' ? entry[3] || 'AWS' : 'AWS';
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(stripped))) {
      const key = `${cloud}:${name}`;
      let svc = bySvc.get(key);
      if (!svc) {
        svc = {
          name,
          kind,
          cloud,
          residency: 'in-account',
          dataStore: kind === 'database' || kind === 'storage',
          resources: [],
        };
        bySvc.set(key, svc);
      }
      const rn = constructName(stripped, m.index + m[0].length);
      const resName = rn || `${name}#${svc.resources.length + 1}`;
      if (!svc.resources.some((r) => r.name === resName))
        svc.resources.push({
          name: resName,
          kind,
          declared: true,
          existence: 'declared',
          evidence: `${tool} construct`,
        });
      if (g.lastIndex === m.index) g.lastIndex++; // guard against zero-width
    }
  }
  return [...bySvc.values()];
}

// P2 — enumerate CloudFormation / SAM / serverless `Resources:` blocks. Each resource
// is `<LogicalId>:` … `Type: AWS::Service::Kind`. Line-based (YAML indentation is not
// regex-friendly): for every `Type: AWS::…` line, the logical id is the NEAREST
// preceding bare-key line at strictly-lesser indent (the immediate parent) — so a
// nested serverless `resources: → Resources: → Bucket: → Type:` credits `Bucket`, not
// the `Resources:` section header. Returns per-resource records + friendly service.
const CFN_SECTION_WORDS = new Set([
  'Resources',
  'Properties',
  'Outputs',
  'Parameters',
  'Conditions',
  'Mappings',
  'Metadata',
  'Globals',
]);
export function parseCfnResources(content) {
  const lines = String(content || '').split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const tm = lines[i].match(/^(\s*)Type\s*:\s*['"]?(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)/);
    if (!tm) continue;
    const typeIndent = tm[1].length;
    const type = tm[2];
    let logicalId = null;
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].trim() === '') continue;
      const km = lines[j].match(/^(\s*)([A-Za-z][A-Za-z0-9]*)\s*:\s*(?:#.*)?$/);
      if (km && km[1].length < typeIndent) {
        logicalId = km[2];
        break;
      }
    }
    if (!logicalId || CFN_SECTION_WORDS.has(logicalId)) continue;
    const svcSeg = type.split('::')[1].toLowerCase();
    const hit = AWS_SVC_MAP[svcSeg] || [type.replace(/^AWS::/, ''), 'other', false];
    const key = `${hit[0]}:${logicalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ service: hit[0], kind: hit[1], dataStore: hit[2], resourceName: logicalId, type });
  }
  return out;
}

/** Parse a config/IaC file's content into declared detections (high confidence). */
export function parseConfig(type, content, rel) {
  const out = [];
  const push = (d) =>
    out.push({
      ...d,
      detectedBy: d.detectedBy || 'iac-declared',
      confidence: d.confidence || 'high',
      file: rel,
    });
  if (type === 'prisma') {
    const m = content.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s);
    if (m)
      push({
        name: `Prisma → ${m[1]}`,
        kind: 'database',
        cloud: 'managed',
        residency: 'varies',
        dataStore: true,
        declares: [m[1]],
      });
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
      push({
        name,
        kind,
        cloud,
        residency: 'in-account',
        dataStore: kind === 'database' || kind === 'storage',
        declares: [rt],
      });
    }
    for (const p of providers) {
      const cloud =
        p === 'aws' ? 'AWS' : p === 'google' ? 'GCP' : /azurerm|azuread/.test(p) ? 'Azure' : p;
      push({
        name: `Terraform provider: ${cloud}`,
        kind: 'iac',
        cloud,
        residency: 'in-account',
        declares: [p],
      });
    }
  } else if (type === 'serverless') {
    const m = content.match(/provider:\s*[\s\S]*?name:\s*(aws|google|azure)/i);
    const cloud = m ? (m[1] === 'aws' ? 'AWS' : m[1] === 'google' ? 'GCP' : 'Azure') : 'AWS';
    push({ name: `Serverless → ${cloud}`, kind: 'iac', cloud, residency: 'in-account' });
    // P2 — functions: map → declared Lambda resources. Capture ONLY the direct
    // children (function names) at the block's base indent, never nested leaf keys
    // like `handler:` / `events:`.
    const fm = content.match(/(^|\n)functions\s*:\s*\n([\s\S]*?)(?=\n[A-Za-z_]|$)/);
    const fnNames = [];
    if (fm) {
      const block = fm[2];
      const indM = block.match(/^([ \t]+)\S/);
      if (indM)
        for (const fx of block.matchAll(
          new RegExp('(^|\\n)' + indM[1] + '([A-Za-z][\\w-]*)\\s*:', 'g'),
        ))
          fnNames.push(fx[2]);
    }
    if (fnNames.length)
      push({
        name: 'Lambda',
        kind: 'compute',
        cloud: 'AWS',
        residency: 'in-account',
        resources: fnNames.map((n) => ({
          name: n,
          kind: 'compute',
          declared: true,
          existence: 'declared',
          evidence: 'serverless function',
        })),
      });
    // P2 — resources: block is inline CloudFormation → enumerate it.
    for (const r of parseCfnResources(content))
      push({
        name: r.service,
        kind: r.kind,
        cloud: 'AWS',
        residency: 'in-account',
        dataStore: r.dataStore,
        resources: [
          {
            name: r.resourceName,
            kind: r.kind,
            declared: true,
            existence: 'declared',
            evidence: `serverless resources ${r.type}`,
          },
        ],
      });
  } else if (type === 'docker-compose') {
    for (const m of content.matchAll(/image:\s*['"]?([a-z0-9._/-]+)/gi)) {
      const img = m[1].toLowerCase();
      const svc = /postgres/.test(img)
        ? 'Postgres'
        : /mysql|mariadb/.test(img)
          ? 'MySQL'
          : /mongo/.test(img)
            ? 'MongoDB'
            : /redis/.test(img)
              ? 'Redis'
              : null;
      if (svc)
        push({
          name: `${svc} (self-hosted)`,
          kind: 'database',
          cloud: 'self-hosted',
          residency: 'in-account',
          dataStore: true,
          declares: [img],
        });
    }
  } else if (type === 'pulumi') {
    push({ name: 'Pulumi', kind: 'iac', cloud: 'unknown', residency: 'in-account' });
  } else if (type === 'cloudformation' || type === 'sam') {
    // P2 — parse the top-level Resources: map into per-resource declared detections
    // (previously resource-blind — a single 'CloudFormation/SAM' service).
    push({
      name: type === 'sam' ? 'AWS SAM' : 'CloudFormation',
      kind: 'iac',
      cloud: 'AWS',
      residency: 'in-account',
    });
    for (const r of parseCfnResources(content))
      push({
        name: r.service,
        kind: r.kind,
        cloud: 'AWS',
        residency: 'in-account',
        dataStore: r.dataStore,
        resources: [
          {
            name: r.resourceName,
            kind: r.kind,
            declared: true,
            existence: 'declared',
            evidence: `CloudFormation ${r.type}`,
          },
        ],
      });
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
    const BICEP_RES = [
      [/Microsoft\.Web\/sites/i, 'App Service', 'compute'],
      [/Microsoft\.Sql/i, 'Azure SQL', 'database'],
      [/Microsoft\.Storage/i, 'Blob Storage', 'storage'],
      [/Microsoft\.DocumentDB|Microsoft\.DBforPostgreSQL/i, 'Cosmos/Postgres', 'database'],
      [/Microsoft\.ServiceBus/i, 'Service Bus', 'messaging'],
    ];
    for (const [re, name, kind] of BICEP_RES)
      if (re.test(content))
        push({
          name,
          kind,
          cloud: 'Azure',
          residency: 'in-account',
          dataStore: kind === 'database' || kind === 'storage',
        });
  } else if (type === 'arm') {
    push({ name: 'ARM template', kind: 'iac', cloud: 'Azure', residency: 'in-account' });
  } else if (
    type === 'kubernetes' ||
    type === 'helm' ||
    type === 'kustomize' ||
    type === 'crossplane'
  ) {
    push({
      name: {
        kubernetes: 'Kubernetes',
        helm: 'Helm',
        kustomize: 'Kustomize',
        crossplane: 'Crossplane',
      }[type],
      kind: 'iac',
      cloud: 'k8s',
      residency: 'in-account',
    });
  } else if (type === 'argocd' || type === 'flux') {
    push({
      name: type === 'argocd' ? 'ArgoCD' : 'Flux',
      kind: 'iac',
      cloud: 'k8s',
      residency: 'in-account',
    });
  } else if (type === 'ansible' || type === 'chef' || type === 'puppet' || type === 'salt') {
    push({
      name: { ansible: 'Ansible', chef: 'Chef', puppet: 'Puppet', salt: 'Salt' }[type],
      kind: 'iac',
      cloud: 'multi',
      residency: 'in-account',
    });
  } else if (type === 'docker' || type === 'packer' || type === 'vagrant' || type === 'nix') {
    push({
      name: { docker: 'Docker', packer: 'Packer', vagrant: 'Vagrant', nix: 'Nix' }[type],
      kind: 'iac',
      cloud: 'any',
      residency: 'in-account',
    });
  } else if (type === 'terragrunt') {
    push({ name: 'Terragrunt', kind: 'iac', cloud: 'multi', residency: 'in-account' });
  } else if (type === 'gitlab-ci' || type === 'circleci') {
    push({
      name: type === 'gitlab-ci' ? 'GitLab CI' : 'CircleCI',
      kind: 'iac',
      cloud: 'unknown',
      residency: 'in-account',
      detectedBy: 'platform-config',
    });
  } else if (type === 'flyway' || type === 'liquibase' || type === 'alembic') {
    push({
      name:
        { flyway: 'Flyway', liquibase: 'Liquibase', alembic: 'Alembic' }[type] + ' (migrations)',
      kind: 'database',
      cloud: 'managed',
      residency: 'varies',
      dataStore: true,
    });
  } else if (type === 'drizzle') {
    push({
      name: 'Drizzle (migrations)',
      kind: 'database',
      cloud: 'managed',
      residency: 'varies',
      dataStore: true,
      declares: ['drizzle.config'],
    });
  } else if (type && type.startsWith('platform:')) {
    push({
      name: type.slice('platform:'.length),
      kind: 'platform',
      cloud: 'platform',
      residency: 'varies',
      detectedBy: 'platform-config',
    });
  } else if (type === 'gh-workflow') {
    if (/aws-actions\//.test(content))
      push({
        name: 'AWS (CI deploy)',
        kind: 'iac',
        cloud: 'AWS',
        residency: 'in-account',
        detectedBy: 'platform-config',
      });
    if (/google-github-actions\//.test(content))
      push({
        name: 'GCP (CI deploy)',
        kind: 'iac',
        cloud: 'GCP',
        residency: 'in-account',
        detectedBy: 'platform-config',
      });
    if (/azure\/login/.test(content))
      push({
        name: 'Azure (CI deploy)',
        kind: 'iac',
        cloud: 'Azure',
        residency: 'in-account',
        detectedBy: 'platform-config',
      });
  } else if (type === 'env-example') {
    for (const line of content.split('\n')) {
      const km = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=(.*)$/);
      if (!km) continue;
      const [, key, rawVal] = km;
      const val = (rawVal || '').trim().replace(/^["']|["']$/g, '');
      const hit = ENV_KEY.find(([re]) => re.test(key));
      if (hit) push({ ...hit[1], detectedBy: 'env-key', confidence: 'medium', declares: [key] });
      // value host hint (safe in .env.example): SMTP host → provider
      if (/smtp\.hostinger\.com/i.test(val))
        push({
          name: 'Hostinger (email/SMTP)',
          kind: 'email',
          cloud: '3rd-party',
          residency: 'external',
          detectedBy: 'env-key',
          confidence: 'medium',
          declares: [key],
        });
      else if (/^SMTP_HOST$/i.test(key) && val && !/your|example|changeme|<|placeholder/i.test(val))
        push({
          name: `SMTP: ${val}`,
          kind: 'email',
          cloud: '3rd-party',
          residency: 'external',
          detectedBy: 'env-key',
          confidence: 'medium',
          declares: [key],
        });
      if (/^DATABASE_URL$/i.test(key)) {
        const scheme = (val.match(/^(\w+):\/\//) || [])[1];
        if (scheme)
          push({
            name: `DB via DATABASE_URL (${scheme})`,
            kind: 'database',
            cloud: 'managed',
            residency: 'varies',
            dataStore: true,
            detectedBy: 'env-key',
            confidence: 'medium',
          });
      }
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
  if (
    /(^|\/)deploy[\w.-]*\.sh$/i.test(rel) ||
    (/\.sh$/.test(rel) && /\b(aws|gcloud|az|kubectl|serverless)\s+\w/.test(c))
  ) {
    const provisions = [];
    if (/aws\s+lambda/i.test(c)) provisions.push('Lambda');
    if (/aws\s+iam/i.test(c)) provisions.push('IAM');
    if (/aws\s+s3/i.test(c)) provisions.push('S3');
    if (/aws\s+dynamodb/i.test(c)) provisions.push('DynamoDB');
    if (/aws\s+(ecs|ec2|cloudfront|apigateway)/i.test(c)) provisions.push('other-AWS');
    // A5 — a secret/credential passed literally into a function's --environment
    // block (rather than resolved via a secrets manager / CI secret store) is an
    // infra-security smell: the credential now lives in plaintext deploy history.
    return { kind: 'shell-deploy', provisions, secretEnvKeys: detectSecretInEnv(c) };
  }
  if (
    /(^|\/)([\w-]*[-.])?(trust-)?policy\.json$/i.test(base) ||
    (/\.json$/.test(rel) &&
      /"Effect"\s*:/.test(c) &&
      /"Action"\s*:/.test(c) &&
      /"Statement"\s*:/.test(c))
  ) {
    return { kind: 'iam-policy', provisions: [] };
  }
  return null;
}

// A5 — credential-shaped key names (SECRET/PASSWORD/TOKEN/API_KEY/PRIVATE_KEY/
// CREDENTIAL). Matched against env-var KEYS only (never values) elsewhere in this
// file per repo convention; here the VALUE also matters because the whole point is
// catching a LITERAL secret value landing in a Lambda's env block.
const CREDENTIAL_KEY_RE =
  /SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|APIKEY|PRIVATE[_-]?KEY|CREDENTIAL/i;
// A value that looks like a real literal (not a placeholder, not a reference to a
// secret store / env var / CI secret context).
function isLiteralSecretValue(raw) {
  const v = String(raw || '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim();
  if (!v) return false;
  if (
    /^\$\{|^\$\(|\bsecrets\.|\bvars\.|process\.env|getenv|<|placeholder|changeme|your[-_]?(key|secret|token|password)|xxx|redacted/i.test(
      v,
    )
  )
    return false;
  return true;
}
/**
 * A5 — detect a secret/credential passed as a LITERAL value into a function's
 * `--environment` (shell/CLI deploy) or `environment:` (CI workflow YAML) block.
 * Returns the flagged key names (empty array if none). Deterministic, no LLM.
 */
export function detectSecretInEnv(content) {
  const c = String(content || '');
  const flagged = new Set();
  // Shell/CLI: `--environment Variables={KEY=value,KEY2=value2}` (aws lambda CLI).
  for (const m of c.matchAll(/--environment\s+["']?Variables=\{([^}]*)\}/gi)) {
    for (const km of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^,}]+)/g)) {
      if (CREDENTIAL_KEY_RE.test(km[1]) && isLiteralSecretValue(km[2])) flagged.add(km[1]);
    }
  }
  // YAML: an `environment:` block (CI workflow step / IaC config) with `KEY: value`
  // children at a deeper indent.
  for (const m of c.matchAll(
    /\benvironment\s*:\s*\n((?:[ \t]+[A-Za-z_][A-Za-z0-9_]*\s*:.*\n?)+)/gi,
  )) {
    for (const km of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)/g)) {
      if (CREDENTIAL_KEY_RE.test(km[1]) && isLiteralSecretValue(km[2])) flagged.add(km[1]);
    }
  }
  return [...flagged];
}

// A6 — Auth.js / next-auth adapter packages (@auth/dynamodb-adapter, @auth/prisma-
// adapter, @auth/firebase-adapter, …) persist SESSIONS/ACCOUNTS/USERS — i.e. PII —
// into whatever store they're pointed at. Their presence + a store NAME ending in
// `_Auth` / `_Directory` is a strong (name-based, not content-inspecting) contains_pii
// signal for that store.
const AUTH_ADAPTER_RE = /^@auth\/[\w-]+-adapter$|^@next-auth\/[\w-]+-adapter$/;
const PII_STORE_NAME_RE = /_(Auth|Directory)$/i;

// Final-iteration item 3 — metering-source detector: a per-call-billed 3rd-party service
// (Anthropic, OpenAI, …) needs SOME in-repo record of where spend is tracked before FinOps
// can attribute cost to it. Generic whole-token match (never a hardcoded resource/file
// name) over BOTH resource names and file basenames. Whole-token (not substring) so
// "outage_log" doesn't false-match "usage" and "rateLimiter" doesn't false-match "rate".
const METERING_TOKENS = new Set(['usage', 'billing', 'metering', 'spend', 'pricing']);
function meteringTokenMatch(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return !!tokens && tokens.some((t) => METERING_TOKENS.has(t));
}
/**
 * Scan the already-detected resource names + file basenames for a usage/pricing/billing
 * artifact — evidence that SOME in-repo record tracks metered spend. Never claims WHICH
 * external service it covers (that's a human/verification call); a consumer that finds
 * ≥1 hit treats it as "a metering artifact exists," not "every 3rd-party call is priced."
 */
export function detectMeteringArtifacts(files, services) {
  const out = [];
  const seen = new Set();
  for (const s of services || []) {
    for (const r of s.resources || []) {
      if (meteringTokenMatch(r.name) && !seen.has(`res:${r.name}`)) {
        seen.add(`res:${r.name}`);
        out.push({
          kind: 'resource',
          name: r.name,
          service: s.name,
          evidence: 'resource name matches a usage/billing/pricing token',
        });
      }
    }
  }
  for (const f of files || []) {
    const base = (f.rel || '').split('/').pop() || '';
    if (meteringTokenMatch(base) && !seen.has(`file:${f.rel}`)) {
      seen.add(`file:${f.rel}`);
      out.push({
        kind: 'file',
        name: f.rel,
        evidence: 'filename matches a usage/billing/pricing token',
      });
    }
  }
  return out;
}

// Final-iteration item 4 — intentional-separation signal: some repos explicitly document
// that a resource is deliberately kept OUT of the primary IaC tool (e.g. Mycelium's
// sst.config.ts "SCOPE BOUNDARY … managed OUTSIDE SST … intentionally NOT declared here").
// That is evidence the authors already chose tool-separation on purpose — the planner
// should PRESENT the fork (separate project vs fold-in), not silently emit one opinionated
// import command as if there were no decision. Absence of the signal is the common case;
// the planner falls back to its existing single-recommendation behavior.
// STRONG: unambiguous, specifically about IaC-tool scope (never fires on a mundane bash
// idempotency check). WEAK: "already exist(s)" alone is genuinely common in deploy-script
// idempotency guards ("role already exists — updating…") — only trusted as a fallback,
// and only when no STRONG signal exists anywhere in the repo.
const SEPARATION_RE_STRONG =
  /\bSCOPE[\s-]?BOUNDARY\b|\bmanaged\s+outside\b|\bout-of-band\b|\bintentionally\s+not\s+declared\b|\bnot\s+declared\s+here\b/i;
const SEPARATION_RE_WEAK = /\balready\s+exists?\b/i;
export function detectIntentionalSeparation(files) {
  let weak = null;
  for (const f of files || []) {
    if (typeof f.content !== 'string') continue;
    const strongHit = f.content.match(SEPARATION_RE_STRONG);
    if (strongHit) return { present: true, evidence: `"${strongHit[0]}" found in ${f.rel}` };
    if (!weak) {
      const weakHit = f.content.match(SEPARATION_RE_WEAK);
      if (weakHit) weak = { present: true, evidence: `"${weakHit[0]}" found in ${f.rel}` };
    }
  }
  return weak || { present: false, evidence: null };
}

// A4 — orphan-candidate retirement signals: an explicit `SCOPE-BOUNDARY` marker or a
// retire/legacy/deprecated comment sitting near the resource's declaration/reference.
// This is a DECLARED signal (someone wrote it down), never proof the resource is
// actually dead/unused — basis stays 'declared'.
// A retirement keyword must be an actual retire/legacy/decommission verb — a
// `SCOPE-BOUNDARY` marker means "managed elsewhere", NOT "being retired", so it is
// deliberately NOT a trigger (it caused the active SST/CloudFront stack to be
// mis-flagged as orphan on Mycelium).
// Kinds that are the active deploy substrate, never orphan "data left behind".
const ORPHAN_INELIGIBLE_KINDS = new Set([
  'iac',
  'network',
  'platform',
  'compute',
  'secrets',
  'gaming',
]);
const RETIREMENT_RE =
  /\b(?:retire[ds]?|retiring|legacy|deprecated|decommission(?:ed|ing)?|sunset)\b/gi;
// Generic infrastructure nouns (>=5 chars) that carry no identity on their own — a
// retire note near "graph" / "bucket" / "table" must not tar an unrelated store.
const ORPHAN_TOKEN_STOPWORDS = new Set([
  'graph',
  'table',
  'tables',
  'bucket',
  'buckets',
  'queue',
  'queues',
  'store',
  'stores',
  'index',
  'database',
  'databases',
  'cloud',
  'lambda',
  'dynamo',
  'dynamodb',
  'production',
  'staging',
  'snapshot',
  'snapshots',
  'config',
  'default',
  'backup',
  'primary',
  'secondary',
  'resource',
  'resources',
  'service',
  'services',
  'stack',
  'stacks',
]);
// Distinctive resource-name tokens (>=5 chars), minus generic infra nouns and minus the
// shared namespace prefix (`common`). Without the namespace filter a single retire note
// mentioning the product name ("Mycelium is …") would flag EVERY table (they all share
// the "mycelium" token) — including active PII stores. `common` is the set of tokens that
// recur across many resource names in this scan, i.e. the namespace, never an identity.
// Substring (not word-boundary) matching so a token still resolves inside snake_case
// (aws_dynamodb_table) and CamelCase (Memgraph) identifiers.
function retirementTokens(name, common) {
  return [
    ...new Set(
      String(name || '')
        .toLowerCase()
        .match(/[a-z0-9]{5,}/g) || [],
    ),
  ].filter((t) => !ORPHAN_TOKEN_STOPWORDS.has(t) && !(common && common.has(t)));
}
function hasRetirementSignalNear(content, needle, common) {
  const tokens = retirementTokens(needle, common);
  if (!tokens.length) return false;
  const c = String(content || '');
  const re = new RegExp(RETIREMENT_RE.source, 'gi');
  let m;
  while ((m = re.exec(c))) {
    const start = Math.max(0, m.index - 120);
    const end = Math.min(c.length, m.index + 120);
    const window = c.slice(start, end).toLowerCase();
    if (tokens.some((t) => window.includes(t))) return true;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return false;
}

// P2 — merge resource records into a Map keyed by name; a DECLARED record upgrades a
// prior referenced (existence:'unknown') one, so the same table declared in IaC AND
// referenced by ARN collapses to one, declared entry.
function mergeResources(map, list) {
  for (const r of list || []) {
    if (!r || !r.name) continue;
    const prev = map.get(r.name);
    if (!prev || (r.declared && !prev.declared))
      map.set(r.name, {
        name: r.name,
        kind: r.kind,
        declared: !!r.declared,
        existence: r.existence || (r.declared ? 'declared' : 'unknown'),
        evidence: r.evidence || '',
      });
  }
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
  let hasAuthAdapter = false; // A6

  const record = (d, rel) => {
    const key = d.name;
    if (!merged.has(key))
      merged.set(key, {
        name: d.name,
        kind: d.kind,
        cloud: d.cloud || 'unknown',
        residency: d.residency || null,
        dataStore: !!d.dataStore,
        detectedBy: new Set(),
        confidence: 'low',
        files: new Set(),
        declares: new Set(),
        resources: new Map(),
      });
    const e = merged.get(key);
    if (d.detectedBy) e.detectedBy.add(d.detectedBy);
    if (CONF_RANK[d.confidence] > CONF_RANK[e.confidence]) e.confidence = d.confidence;
    // declared cloud/residency wins over inferred 'unknown'
    if (
      d.cloud &&
      d.cloud !== 'unknown' &&
      (e.cloud === 'unknown' || d.detectedBy === 'iac-declared')
    )
      e.cloud = d.cloud;
    if (d.residency && !e.residency) e.residency = d.residency;
    if (d.dataStore) e.dataStore = true;
    if (rel) e.files.add(rel);
    for (const x of d.declares || []) e.declares.add(x);
    // P2 — merge resource-level records; a DECLARED entry upgrades a prior referenced one.
    if (Array.isArray(d.resources)) mergeResources(e.resources, d.resources);
    if (d.residency === 'external' && rel) externalTouchedBy.add(rel);
  };
  // P2 — attach referenced resources (name-builders / TableName / create-args) to an
  // ALREADY-detected service only; never mint a phantom service from a bare string.
  const attachResource = (serviceName, res) => {
    const e = merged.get(serviceName);
    if (e) mergeResources(e.resources, [res]);
  };

  // tiers that count as genuine infra-as-code (drive the HIGH signal); platform-config
  // + CI-deploy are weaker (medium).
  const GENUINE_IAC = new Set([
    'resource',
    'migrations',
    'orchestration',
    'config-mgmt',
    'container',
  ]);
  for (const f of files) {
    if (f.isClient) clientFiles++;
    else serverFiles++;
    // hand-rolled deploy (non-IaC) — capture + skip further processing. P1: also
    // mine any IAM-policy ARNs into used-but-undeclared references (declared nowhere).
    const ds = detectDeployScript(f.rel, f.content);
    if (ds) {
      deployScripts.push({ file: f.rel, kind: ds.kind, provisions: ds.provisions });
      // ARNs + create-* args are mined in the centralized P2 resource pass below.
      continue;
    }
    // name first; fall back to content sniffing for ambiguous yaml/json.
    const ctype =
      configFileType(f.rel) ||
      (typeof f.content === 'string' ? classifyConfigByContent(f.rel, f.content) : null);
    if (ctype) {
      if (ctype === 'env-example') hasEnvExample = true;
      const dets = parseConfig(ctype, f.content || '', f.rel);
      if (dets.length) {
        for (const d of dets) record(d, f.rel);
        if (d_isIacKind(dets)) iacDeclared = true;
      }
      const tier = iacTier(ctype);
      if (ctype !== 'env-example')
        iac.push({ provider: prettyConfigType(ctype), file: f.rel, tier });
      if (GENUINE_IAC.has(tier)) iacDeclared = true;
      // a config file isn't ALSO a code file — don't fall through to import scanning.
      if (configFileType(f.rel)) continue;
    }
    // code file → IaC tooling import (declared infra; extract resources from the
    // module — SST/CDK/Pulumi split resources across infra/*.ts) → SDK → import infer
    const fileIac = (f.specifiers || []).reduce((acc, s) => acc || detectIacImport(s), null);
    if (fileIac) {
      record(
        {
          name: fileIac.name,
          kind: 'iac',
          cloud: fileIac.cloud,
          residency: 'in-account',
          detectedBy: 'iac-import',
          confidence: 'high',
        },
        f.rel,
      );
      iacDeclared = true;
      if (typeof f.content === 'string')
        for (const r of extractIacResources(f.content, fileIac.name))
          record({ ...r, detectedBy: 'iac-declared', confidence: 'high' }, f.rel);
    }
    // Content-based IaC extraction — declared infra with NO re-detectable import.
    // SST v3 uses the ambient `sst.aws.*` global (no import at all); Pulumi/CDK
    // constructs may also appear in modules whose import wasn't matched. Run the
    // construct extractor by content signature regardless of import; record() dedupes
    // by name so the import-based path above is not double-counted.
    if (typeof f.content === 'string') {
      // P1: strip comments first + require CONSTRUCTOR-INVOCATION syntax, so a comment
      // mentioning sst.aws.* / new aws.* never mints a phantom resource.
      const stripped = stripComments(f.content, f.rel);
      const contentTool = /\bsst\.aws\.\w+\s*\(/.test(stripped)
        ? 'SST'
        : /\bnew\s+aws\.\w+\.\w+\s*\(/.test(stripped)
          ? 'Pulumi'
          : /aws-cdk-lib|@aws-cdk\//.test(stripped) || /\bcdk\.(App|Stack)\b/.test(stripped)
            ? 'AWS CDK'
            : null;
      if (contentTool) {
        for (const r of extractIacResources(stripped, contentTool))
          record({ ...r, detectedBy: 'iac-declared', confidence: 'high' }, f.rel);
        iacDeclared = true;
      }
    }
    for (const spec of f.specifiers || []) {
      if (AUTH_ADAPTER_RE.test(spec)) hasAuthAdapter = true; // A6
      if (detectIacImport(spec)) continue; // handled above
      const c = detectCloudSdk(spec);
      if (c) {
        record({ ...c, detectedBy: 'sdk-import', confidence: 'medium' }, f.rel);
        continue;
      }
      const d = classifyImport(spec);
      if (d)
        record(
          {
            name: d.provider,
            kind: mapPrivacyKind(d.kind),
            cloud: cloudForProvider(d),
            residency: d.residency,
            dataStore: d.kind === 'db',
            detectedBy: 'sdk-import',
            confidence: 'medium',
          },
          f.rel,
        );
      else if (classifyPath(f.rel)?.kind === 'infra') {
        /* handled by config path */
      }
    }
  }

  // ── P2 resource pass (runs after service detection so referenced resources attach
  //   to the services they belong to). Three sources, all comment-stripped:
  //   (1) IAM-grant / permission-block ARNs (specific + wildcard) → referenced;
  //   (2) ${PREFIX}_X name-builders + TableName: literals + create-* deploy args;
  //   (3) buckets from create-bucket / s3 mb args. ──
  let tablePrefix = null;
  const tableSuffixes = new Set();
  const tableNames = new Set();
  const bucketNames = new Set();
  for (const f of files) {
    if (typeof f.content !== 'string') continue;
    const c = stripComments(f.content, f.rel);
    if (c.includes('arn:aws:')) for (const g of extractIamGrants(c)) record(g, f.rel);
    if (!tablePrefix) {
      const pm = c.match(/(?:TABLE_PREFIX|tablePrefix)\b[^\n]*?["']([A-Za-z][\w-]*)["']/);
      if (pm) tablePrefix = pm[1];
    }
    for (const m of c.matchAll(/\$\{[^}]*?(?:prefix|PREFIX)[^}]*?\}_([A-Za-z][A-Za-z0-9]*)/g))
      tableSuffixes.add(m[1]);
    for (const m of c.matchAll(/\bTableName\s*:\s*["']([A-Za-z][\w.-]*)["']/g))
      tableNames.add(m[1]);
    for (const m of c.matchAll(/--table-name\s+["']?([A-Za-z][\w.-]*)/g)) tableNames.add(m[1]);
    for (const m of c.matchAll(/(?:--bucket\s+["']?|s3\s+mb\s+s3:\/\/)([a-z0-9][a-z0-9.-]*)/g))
      bucketNames.add(m[1]);
  }
  // P2b — mine table/bucket NAME-BUILDERS (${PREFIX}_X / TableName: / --table-name /
  // --bucket) from regular application code whose content was NOT loaded for service
  // detection (src/lib/*.ts data-access modules build `${prefix}_Directory` etc.).
  // These names attach ONLY to services already detected via sdk-import — attachResource
  // never mints a phantom service — so this widens resource enumeration to the true data
  // plane without any risk of a phantom service. Comment-stripped first (P1 truth rule),
  // and NO ARN/service detection runs here (that stays on real f.content only).
  for (const f of files) {
    if (typeof f.codeText !== 'string' || !f.codeText) continue;
    const c = stripComments(f.codeText, f.rel);
    if (!tablePrefix) {
      const pm = c.match(/(?:TABLE_PREFIX|tablePrefix)\b[^\n]*?["']([A-Za-z][\w-]*)["']/);
      if (pm) tablePrefix = pm[1];
    }
    for (const m of c.matchAll(/\$\{[^}]*?(?:prefix|PREFIX)[^}]*?\}_([A-Za-z][A-Za-z0-9]*)/g))
      tableSuffixes.add(m[1]);
    for (const m of c.matchAll(/\bTableName\s*:\s*["']([A-Za-z][\w.-]*)["']/g))
      tableNames.add(m[1]);
    for (const m of c.matchAll(/--table-name\s+["']?([A-Za-z][\w.-]*)/g)) tableNames.add(m[1]);
    for (const m of c.matchAll(/(?:--bucket\s+["']?|s3\s+mb\s+s3:\/\/)([a-z0-9][a-z0-9.-]*)/g))
      bucketNames.add(m[1]);
  }
  for (const suf of tableSuffixes) tableNames.add(tablePrefix ? `${tablePrefix}_${suf}` : suf);
  for (const n of tableNames)
    attachResource('DynamoDB', {
      name: n,
      kind: 'database',
      declared: false,
      existence: 'unknown',
      evidence: 'referenced (table name / ${PREFIX}_X builder)',
    });
  for (const n of bucketNames)
    attachResource('S3', {
      name: n,
      kind: 'storage',
      declared: false,
      existence: 'unknown',
      evidence: 'referenced (bucket name)',
    });

  // A4/A6 — raw (non-comment-stripped) content by file, for retirement-signal
  // proximity search (A4) and store-name PII flagging (A6).
  const contentByRel = new Map();
  for (const f of files) if (typeof f.content === 'string') contentByRel.set(f.rel, f.content);

  // A4 — shared-namespace tokens: a >=5-char token appearing in >=3 distinct resource or
  // service names is the product/namespace prefix (e.g. "mycelium" across every table),
  // NOT a distinctive identifier. Excluding it stops one retirement note from flagging
  // every store in the namespace (which mislabeled active PII stores as orphan-candidates).
  const nameDocFreq = new Map();
  for (const e of merged.values()) {
    const names = [e.name, ...[...e.resources.values()].map((r) => r.name)];
    for (const nm of names)
      for (const t of new Set(
        String(nm || '')
          .toLowerCase()
          .match(/[a-z0-9]{5,}/g) || [],
      ))
        nameDocFreq.set(t, (nameDocFreq.get(t) || 0) + 1);
  }
  const commonTokens = new Set([...nameDocFreq].filter(([, c]) => c >= 3).map(([t]) => t));

  const services = [...merged.values()]
    .map((e) => {
      const fileList = [...e.files];
      // A4 — orphan-candidacy applies ONLY to data/backend services, never to the
      // active deploy substrate (the IaC tool itself, the CDN/edge, the cloud
      // platform, the app's own compute, or secrets managers). Flagging those as
      // "retiring" is the trust-breaking false positive we must not emit.
      const orphanEligible = !ORPHAN_INELIGIBLE_KINDS.has(e.kind);
      // A4 — retirement signal (retire|legacy|deprecated|decommission|sunset) naming
      // this service. Searched across ALL scanned content (the note that a store is
      // being retired often lives in the platform config, not the store's own file).
      const retiredByComment =
        orphanEligible &&
        [...contentByRel.values()].some((c) => hasRetirementSignalNear(c, e.name, commonTokens));
      // A4 — "a service the app no longer imports": declared in IaC (iac-declared /
      // iac-import) but never actually reached by application code (no sdk-import /
      // env-key usage) — the declaration outlived the code that used it.
      const declaredHere = e.detectedBy.has('iac-declared') || e.detectedBy.has('iac-import');
      const codeUsed = e.detectedBy.has('sdk-import') || e.detectedBy.has('env-key');
      const noLongerImported = orphanEligible && declaredHere && !codeUsed;
      const orphanCandidate = retiredByComment || noLongerImported;
      const orphanReason = retiredByComment
        ? 'retirement signal (retire|legacy|deprecated|decommission|sunset) found near this resource'
        : noLongerImported
          ? 'declared in IaC but no application code imports/references it'
          : null;

      const resources = [...e.resources.values()]
        // Drop non-enumerable names: prefix wildcards (`Mycelium_*` — a class, not a
        // resource) and unresolved template literals (`${DLQ_NAME}`). They inflate the
        // coverage denominator and manufacture phantom orphan-candidates; the concrete
        // members are already enumerated from the ${PREFIX}_X builder / literal names.
        .filter((r) => r.name && !r.name.includes('*') && !r.name.includes('${'))
        .map((r) => {
          // A6 — Auth.js adapter present + store name ends in _Auth/_Directory ⇒
          // contains_pii by NAME (never content-inspecting; the store may hold
          // sessions/accounts/users which are PII).
          const containsPii = hasAuthAdapter && PII_STORE_NAME_RE.test(r.name);
          // A4 — resource-level retirement signal near this specific resource's name.
          const resOrphan = fileList.some((rel) =>
            hasRetirementSignalNear(contentByRel.get(rel), r.name, commonTokens),
          );
          return containsPii || resOrphan
            ? {
                ...r,
                ...(containsPii
                  ? {
                      contains_pii: true,
                      piiReason:
                        'Auth.js adapter (@auth/*-adapter) present + store name pattern (*_Auth/*_Directory)',
                    }
                  : {}),
                ...(resOrphan ? { orphanCandidate: true, basis: 'declared' } : {}),
              }
            : r;
        })
        .sort((a, b) => (b.declared ? 1 : 0) - (a.declared ? 1 : 0) || a.name.localeCompare(b.name))
        .slice(0, 60);
      const s = {
        name: e.name,
        kind: e.kind,
        cloud: e.cloud,
        residency: e.residency,
        dataStore: e.dataStore,
        detectedBy: [...e.detectedBy],
        confidence: e.confidence,
        declares: [...e.declares].slice(0, 6),
        fileCount: e.files.size,
        files: fileList.sort().slice(0, 8),
        resources,
        ...(orphanCandidate ? { orphanCandidate: true, orphanReason, basis: 'declared' } : {}),
      };
      return { ...s, costModel: costModelFor(s) };
    })
    .sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || b.fileCount - a.fileCount);

  const external = services
    .filter((s) => s.residency === 'external')
    .map((s) => ({
      provider: s.name,
      kind: s.kind,
      fileCount: s.fileCount,
      detectedBy: s.detectedBy,
    }));
  const clouds = [...new Set(services.map((s) => s.cloud))].filter((c) => c && c !== 'unknown');
  const dataStoreCount = services.filter((s) => s.dataStore).length;

  // ── Cost surface: potential cost sources grouped by model (no dollars — see above) ──
  const costSurface = { standing: 0, metered: 0, subscription: 0, connectivity: 0 };
  for (const s of services) if (costSurface[s.costModel] != null) costSurface[s.costModel]++;

  // ── IaC coverage: of the OWN-CLOUD resources you provision (standing/metered), how
  // many are DECLARED in code vs only inferred-from-usage? Low ratio = the click-ops
  // smell (resources used but declared nowhere — invisible to cost/audit/repro). ──
  // P2 — DEMOTE 'platform-config' out of DECLARED_BY: a CI workflow using aws-actions
  // is deploy automation, not a resource declaration. Tracked separately as a weaker tier.
  const DECLARED_BY = new Set(['iac-declared', 'iac-import']);
  const DECLARED_WEAK = new Set(['platform-config']);
  const provisionable = services.filter(
    (s) =>
      (s.costModel === 'standing' || s.costModel === 'metered') &&
      ['AWS', 'GCP', 'Azure', 'self-hosted'].includes(s.cloud) &&
      !['platform', 'iac', 'secrets'].includes(s.kind),
  );
  const isServiceDeclared = (s) => s.detectedBy.some((d) => DECLARED_BY.has(d));
  const declaredProvisionable = provisionable.filter(isServiceDeclared);
  // P2 — resource-level truth: of every enumerated provisionable resource, how many
  // are DECLARED (in IaC) vs merely referenced (ARN/name-builder/TableName)?
  const provisionableResources = provisionable.flatMap((s) => s.resources || []);
  const resourcesTotal = provisionableResources.length;
  const resourcesDeclared = provisionableResources.filter((r) => r.declared).length;
  // undeclared[] now reflects resource truth: a service is flagged if it is not
  // service-level-declared OR carries any referenced-only resource (e.g. DynamoDB
  // present only via an IAM ARN wildcard).
  const undeclared = provisionable
    .filter((s) => !isServiceDeclared(s) || (s.resources || []).some((r) => !r.declared))
    .map((s) => s.name)
    .slice(0, 12);
  const iacCoverage = {
    provisionable: provisionable.length,
    declared: declaredProvisionable.length,
    ratio: provisionable.length ? declaredProvisionable.length / provisionable.length : null,
    platformConfigDeclared: provisionable.filter(
      (s) => !isServiceDeclared(s) && s.detectedBy.some((d) => DECLARED_WEAK.has(d)),
    ).length,
    resourcesTotal,
    resourcesDeclared,
    resourceRatio: resourcesTotal ? resourcesDeclared / resourcesTotal : null,
    undeclared,
  };
  const resourceIacFiles = iac.filter((i) =>
    ['resource', 'migrations', 'orchestration', 'config-mgmt', 'container'].includes(i.tier),
  ).length;
  // IaC files grouped by family/tier (for the report's tiered display).
  const iacByTier = {};
  for (const i of iac) (iacByTier[i.tier || 'other'] ||= []).push(i.provider);

  // infra signal quality — the "how well does this codebase express its infra" rating.
  const iacFiles = iac.length;
  const level = iacDeclared
    ? 'high'
    : services.some((s) => [...s.detectedBy].includes('env-key')) || services.length
      ? 'medium'
      : 'low';
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

  const inventory = {
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
  // ── Part A: deterministic IaC maturity grade (state/env/modularity/testing/
  //   governance/drift-cost) + deprecated-toolchain catalog. Needs the raw file
  //   set (backends, tftest, rego, tags, regions live in file content). ──
  inventory.iacMaturity = gradeIacMaturity(inventory, files);
  inventory.summary.iacMaturityLevel = inventory.iacMaturity.level;
  // ── B11: downstream module readiness — what the IaC assessment unlocks. Pure
  //   derivation from the truthful inventory (coverage + tags + PII). blockedBy is
  //   the concrete gap list; each ties back to a real detection, never a guess. ──
  inventory.moduleReadiness = computeModuleReadiness(inventory);
  // Final-iteration items 3/4 — feeds the planner's manifest-preview metering-source
  // field and the import-substrate-fork decision, respectively.
  inventory.meteringArtifacts = detectMeteringArtifacts(files, services);
  inventory.intentionalSeparation = detectIntentionalSeparation(files);
  return inventory;
}

/**
 * B11 — derive FinOps / privacy / policy-as-code readiness from the inventory.
 * Each gate is `ready` only when its concrete blockers are all cleared; blockedBy
 * lists the exact gaps (declared-basis — a code scan cannot confirm the cloud side).
 */
export function computeModuleReadiness(inventory = {}) {
  const cov = inventory.iacCoverage || {};
  const mat = inventory.iacMaturity || {};
  const tax = mat.tagTaxonomy || {};
  const services = inventory.services || [];
  const undeclared = Array.isArray(cov.undeclared) ? cov.undeclared : [];
  const piiStores = services.flatMap((s) =>
    (s.resources || []).filter((r) => r.contains_pii).map((r) => r.name),
  );
  const govLevel = mat.dimensions?.governance?.level ?? 0;

  const finopsBlocks = [];
  if ((tax.coveragePct ?? 0) < 100)
    finopsBlocks.push(
      `cost tags incomplete (${tax.coveragePct ?? 0}% in declared IaC; missing ${(tax.missing || []).join(', ') || 'tags'})`,
    );
  if (undeclared.length)
    finopsBlocks.push(
      `${undeclared.length} service(s) undeclared — no per-resource cost attribution (${undeclared.slice(0, 4).join(', ')})`,
    );

  const privacyBlocks = [];
  if (piiStores.length)
    privacyBlocks.push(
      `PII stores identified (${piiStores.slice(0, 4).join(', ')}) but encryption-at-rest / residency unverified — see verificationBacklog`,
    );
  else
    privacyBlocks.push(
      'no PII→store mapping yet (add data-classification tags / confirm identity stores)',
    );

  const policyBlocks = [];
  if (govLevel < 2)
    policyBlocks.push('no policy-as-code / misconfig scanning (Checkov / OPA / CrossGuard)');
  if (undeclared.length)
    policyBlocks.push(
      `declared/undeclared set incomplete — ${undeclared.length} resource(s) outside IaC cannot be policed`,
    );

  const gate = (blockedBy) => ({ ready: blockedBy.length === 0, basis: 'declared', blockedBy });
  return {
    finops: gate(finopsBlocks),
    privacy: gate(privacyBlocks),
    policyAsCode: gate(policyBlocks),
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
  if (Array.isArray(resolved.hubs))
    for (const h of resolved.hubs) if (h && h.file) hubsByFile.set(h.file, Number(h.inDegree) || 0);
  const importsByFile =
    resolved.importsByFile && typeof resolved.importsByFile === 'object'
      ? resolved.importsByFile
      : null;

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
      for (const [, imports] of Object.entries(importsByFile))
        if (Array.isArray(imports) && imports.some((t) => fileSet.has(t))) count++;
      if (count > 0) fanIn = count;
    }
    // centralized — concentrated usage (<=3 files) or behind a single directory.
    const dirs = new Set(files.map((f) => f.split('/').slice(0, -1).join('/')));
    const centralized = base <= 3 || dirs.size <= 1;
    return { ...s, fanIn, centralized };
  });

  return { ...inventory, services };
}

function d_isIacKind(dets) {
  return dets.some((d) => d.kind === 'iac');
}
function prettyConfigType(t) {
  if (t.startsWith('platform:')) return t.slice('platform:'.length);
  return (
    {
      prisma: 'Prisma',
      terraform: 'Terraform',
      terragrunt: 'Terragrunt',
      serverless: 'Serverless',
      'docker-compose': 'Docker Compose',
      docker: 'Dockerfile',
      pulumi: 'Pulumi',
      cloudformation: 'CloudFormation',
      sam: 'AWS SAM',
      bicep: 'Bicep',
      arm: 'ARM',
      sst: 'SST',
      cdk: 'AWS CDK',
      cdktf: 'Terraform CDK',
      kubernetes: 'Kubernetes',
      helm: 'Helm',
      kustomize: 'Kustomize',
      crossplane: 'Crossplane',
      argocd: 'ArgoCD',
      flux: 'Flux',
      ansible: 'Ansible',
      chef: 'Chef',
      puppet: 'Puppet',
      salt: 'Salt',
      packer: 'Packer',
      vagrant: 'Vagrant',
      nix: 'Nix',
      drizzle: 'Drizzle',
      flyway: 'Flyway',
      liquibase: 'Liquibase',
      alembic: 'Alembic',
      'gh-workflow': 'CI workflow',
      'gitlab-ci': 'GitLab CI',
      circleci: 'CircleCI',
    }[t] || t
  );
}
function mapPrivacyKind(k) {
  return k === 'thirdParty' ? 'third-party' : k;
}
function cloudForProvider(d) {
  if (d.kind === 'db')
    return d.provider === 'DynamoDB' ? 'AWS' : d.provider === 'Supabase' ? 'Supabase' : 'managed';
  if (d.kind === 'infra') return 'unknown'; // IaC tool not matched by IAC_IMPORT (e.g. Serverless Framework import)
  return '3rd-party';
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — IaC MATURITY GRADING (deterministic, ~0 tokens, file/content-based).
//
// Grades the six rubric dimensions INDEPENDENTLY (they may be uneven — that is the
// whole point), then rolls up to an overall 0–4 level with the doc's min-gated rule:
//   • cannot be L≥2 without remote/managed state + all-infra-in-code (low undeclared)
//   • cannot be L≥3 without IaC tests + policy/scanning + drift/cost gate
// Also emits a deprecated-toolchain catalog + ScanFindings. NEVER probes live cloud,
// NEVER runs terraform/pulumi — it detects the PRESENCE of signals in files only.
// ════════════════════════════════════════════════════════════════════════════

const LEVEL_NAMES = ['ClickOps', 'Repeatable', 'Defined', 'Managed', 'Optimizing'];

// Doc-verified (mid-2026) archived / deprecated / EOL IaC toolchain. Each match runs
// against a context {rels, files:[{rel,content}], allContent, allSpecs}.
const DEPRECATED_TOOLCHAIN = [
  {
    id: 'cdktf',
    tool: 'CDKTF (Terraform CDK)',
    status: 'archived',
    eolDate: '2025-12-10',
    severity: 'medium',
    remediation: 'Migrate to Terraform/OpenTofu (HCL) or Pulumi.',
    detail:
      'CDKTF was archived by HashiCorp on 2025-12-10 ("did not find product-market fit at scale") — still deployable but unmaintained.',
    match: ({ rels, allSpecs, allContent }) =>
      rels.some((r) => /(^|\/)cdktf\.json$/.test(r)) ||
      /\bcdktf\b|@cdktf\//.test(allSpecs) ||
      /['"]cdktf['"]|@cdktf\//.test(allContent),
  },
  {
    id: 'tfsec',
    tool: 'tfsec',
    status: 'merged-into-trivy',
    eolDate: null,
    severity: 'low',
    remediation:
      'Replace tfsec with `trivy config` (tfsec merged into the Trivy family, Aqua 2023).',
    detail: 'tfsec joined Trivy in 2023; engineering attention moved to Trivy.',
    match: ({ rels }) => rels.some((r) => /(^|\/)\.tfsec(\/|$)/.test(r)),
  },
  {
    id: 'terrascan',
    tool: 'Terrascan',
    status: 'archived',
    eolDate: '2025-11-20',
    severity: 'low',
    remediation:
      'Migrate policy scanning to Checkov or Trivy; Terrascan was archived by Tenable on 2025-11-20.',
    detail: 'Terrascan archived by Tenable on 2025-11-20 (read-only).',
    match: ({ rels }) => rels.some((r) => /(^|\/)(terrascan\.(toml|ya?ml)|\.terrascan)$/i.test(r)),
  },
  {
    id: 'terraformer',
    tool: 'Terraformer (generated code)',
    status: 'archived',
    eolDate: '2026-03-16',
    severity: 'low',
    remediation:
      'Refactor generated `tfer--` resources into hand-authored modules; Terraformer is one-shot only (archived 2026-03-16), never a pipeline.',
    detail:
      'Auto-generated `tfer--` resource names are unrefactored Terraformer output (Terraformer archived 2026-03-16).',
    match: ({ rels, allContent }) =>
      rels.some((r) => /tfer(--|_)/.test(r)) || /"?tfer(--|_)/.test(allContent),
  },
  {
    id: 'gcp-deployment-manager',
    tool: 'GCP Deployment Manager',
    status: 'eol',
    eolDate: '2026-03-31',
    severity: 'high',
    remediation:
      'URGENT: run DM Convert → Terraform / Infrastructure Manager before the 2026-03-31 EOL, then abandon the DM deployment.',
    detail:
      'GCP Deployment Manager reaches end of support 2026-03-31; all related APIs stop working after that date.',
    match: ({ rels, files }) =>
      rels.some((r) => /\.jinja$/.test(r)) ||
      files.some(
        (f) =>
          /\.ya?ml$/.test(f.rel) &&
          /(^|\n)\s*resources\s*:/.test(f.content) &&
          /type\s*:\s*[\w./-]*(gcp-types\/|compute\.v1\.|storage\.v1\.|\.jinja)/.test(f.content),
      ),
  },
  {
    id: 'driftctl',
    tool: 'driftctl',
    status: 'maintenance',
    eolDate: null,
    severity: 'low',
    remediation:
      'Migrate drift detection to cloud-concierge or scheduled `plan`/`preview --expect-no-changes`; driftctl has been in maintenance mode since 2023.',
    detail: 'driftctl has been in maintenance mode since 2023 (last release Dec 2023).',
    match: ({ rels }) => rels.some((r) => /(^|\/)(\.?driftctl\.(ya?ml|toml))$/i.test(r)),
  },
];

/**
 * Grade IaC maturity from the raw file set (rel + content). Pure, deterministic.
 * @param {object} inventory — output of buildInfraInventory (uses iacCoverage/signalQuality)
 * @param {Array<{rel,content?,specifiers?}>} files — same shape buildInfraInventory receives
 * @returns iacMaturity object (see SHARED DATA CONTRACT)
 */
export function gradeIacMaturity(inventory = {}, files = []) {
  const norm = (files || []).map((f) => ({
    rel: f.rel || '',
    content: typeof f.content === 'string' ? f.content : '',
    specs: (f.specifiers || []).join(' '),
  }));
  const rels = norm.map((f) => f.rel);
  const allContent = norm.map((f) => f.content).join('\n');
  const allSpecs = norm.map((f) => f.specs).join(' ');
  const tfFiles = norm.filter((f) => /\.tf$|\.tf\.json$|\.tofu$/.test(f.rel));
  const tfContent = tfFiles.map((f) => f.content).join('\n');
  const pulumiYaml = norm.filter((f) => /(^|\/)Pulumi\.ya?ml$/.test(f.rel));

  const hasSst =
    rels.some((r) => /(^|\/)sst\.config\.(ts|mjs|js)$/.test(r)) ||
    /\bsst\.aws\./.test(allContent) ||
    /from\s+['"]sst['"]|['"]sst\//.test(allContent) ||
    /\bsst\b/.test(allSpecs);
  const hasCdk =
    rels.some((r) => /(^|\/)cdk\.json$/.test(r)) ||
    /aws-cdk-lib|@aws-cdk\//.test(allSpecs + ' ' + allContent);
  const hasPulumi =
    pulumiYaml.length > 0 ||
    /@pulumi\//.test(allSpecs) ||
    /\bnew\s+(aws|gcp|azure)\.\w+\./.test(allContent);
  const hasTf = tfFiles.length > 0;
  const iacPresent =
    !!inventory.signalQuality?.iacDeclared || hasSst || hasCdk || hasPulumi || hasTf;

  const findings = [];
  const mkFinding = (o) => ({
    id: o.id,
    title: o.title,
    detail: o.detail,
    dimension: o.dimension,
    severity: o.severity,
    producedBy: 'deterministic',
    evidence: { iac: true, ...(o.evidence || {}) },
    files: o.files || [],
  });

  // ── Deprecated-toolchain catalog + findings ──
  const deprecated = [];
  const depCtx = { rels, files: norm, allContent, allSpecs };
  for (const d of DEPRECATED_TOOLCHAIN) {
    if (!d.match(depCtx)) continue;
    deprecated.push({
      tool: d.tool,
      status: d.status,
      eolDate: d.eolDate,
      remediation: d.remediation,
      severity: d.severity,
    });
    findings.push(
      mkFinding({
        id: `iac:deprecated:${d.id}`,
        title: `Deprecated IaC toolchain: ${d.tool}`,
        detail: `${d.detail} Remediation: ${d.remediation}`,
        dimension: 'infrastructure',
        severity: d.severity,
        evidence: { deprecatedTool: d.tool, status: d.status, eolDate: d.eolDate },
      }),
    );
  }

  // ── A5 — secret/credential passed as a literal into a Lambda function's
  //   --environment / environment: block (deploy scripts + CI/gh-workflow files). ──
  for (const f of norm) {
    const isGhWorkflow =
      /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(f.rel) ||
      /(^|\/)\.gitlab-ci\.ya?ml$/.test(f.rel) ||
      /(^|\/)\.circleci\/config\.ya?ml$/.test(f.rel);
    const isDeployScript =
      /(^|\/)deploy[\w.-]*\.sh$/i.test(f.rel) ||
      (/\.sh$/.test(f.rel) && /\b(aws|gcloud|az|kubectl|serverless)\s+\w/.test(f.content));
    if (!isGhWorkflow && !isDeployScript) continue;
    const secretKeys = detectSecretInEnv(f.content);
    if (secretKeys.length) {
      findings.push(
        mkFinding({
          id: `iac:secret-in-lambda-env:${f.rel}`,
          title: 'Secret/credential passed into a function environment',
          detail: `${f.rel} passes what looks like a secret/credential (${secretKeys.join(', ')}) as a LITERAL value into a --environment/environment: block — use a secrets manager (AWS Secrets Manager / SSM Parameter Store) or CI-injected secret references instead.`,
          dimension: 'security',
          severity: 'high',
          evidence: { secretEnvKeys: secretKeys },
          files: [f.rel],
        }),
      );
    }
  }

  // ── 1. State & provisioning ──
  const backends = [...tfContent.matchAll(/backend\s+"([a-z0-9_]+)"/gi)].map((m) =>
    m[1].toLowerCase(),
  );
  const REMOTE_TF = ['s3', 'gcs', 'azurerm', 'remote', 'http', 'oss', 'cos', 'pg', 'kubernetes'];
  const hasRemoteTfBackend = backends.some((b) => REMOTE_TF.includes(b));
  const hasLocalTfBackend = backends.some((b) => b === 'local');
  const pulumiBackendUrl =
    (pulumiYaml
      .map((f) => f.content)
      .join('\n')
      .match(/backend\s*:\s*[\s\S]*?url\s*:\s*["']?([a-z0-9+]+:\/\/[^\s"']+)/i) || [])[1] || null;
  const pulumiRemote =
    hasPulumi && (!pulumiBackendUrl || /^(s3|gs|azblob):\/\//i.test(pulumiBackendUrl)); // Pulumi Cloud default OR object-store backend
  const pulumiLocalBackend = !!pulumiBackendUrl && /^file:\/\//i.test(pulumiBackendUrl);
  const committedState = rels.some(
    (r) =>
      /(^|\/)terraform\.tfstate(\.backup)?$/.test(r) ||
      /(^|\/)\.pulumi\/(stacks\/|[^/]*\.json$)/.test(r) ||
      /(^|\/)\.terraform\/terraform\.tfstate$/.test(r),
  );
  const hasLock =
    /dynamodb_table\s*=/.test(tfContent) ||
    /use_lockfile\s*=\s*true/.test(tfContent) ||
    hasSst ||
    pulumiRemote;

  let stateLevel, stateEvidence;
  const stateGaps = [];
  if (!iacPresent) {
    stateLevel = 0;
    stateEvidence = 'No IaC detected — provisioning is manual / click-ops.';
    stateGaps.push('Adopt an IaC tool (Terraform/OpenTofu, Pulumi, SST, or CDK).');
  } else if (committedState) {
    stateLevel = 1;
    stateEvidence = 'State file committed to the repository (local / mishandled state).';
    stateGaps.push('Remove committed state; move to a remote, locked, encrypted backend.');
  } else if (hasRemoteTfBackend || pulumiRemote || hasSst || hasCdk) {
    stateLevel = 2;
    stateEvidence = hasSst
      ? 'SST platform-managed state.'
      : hasRemoteTfBackend
        ? `Remote Terraform backend (${[...new Set(backends)].join(', ')}).`
        : hasCdk
          ? 'CloudFormation-managed state (CDK).'
          : 'Managed Pulumi state backend.';
    if (!hasLock)
      stateGaps.push('No state locking detected (add DynamoDB lock table / use_lockfile).');
  } else {
    stateLevel = 1;
    stateEvidence =
      hasLocalTfBackend || pulumiLocalBackend
        ? 'Local state backend.'
        : 'IaC present but no remote state backend declared (defaults to local).';
    stateGaps.push('Configure a remote, locked backend (S3+DynamoDB / GCS / Pulumi Cloud).');
  }
  if (committedState) {
    findings.push(
      mkFinding({
        id: 'iac:committed-state',
        title: 'IaC state file committed to the repository',
        detail:
          'A terraform.tfstate / .pulumi state file is committed — it embeds provider secrets and outputs in plaintext and corrupts under concurrent edits. Remove it and adopt a remote, locked, encrypted backend.',
        dimension: 'security',
        severity: 'high',
        evidence: { committedState: true },
        files: rels.filter((r) => /tfstate|\.pulumi\//.test(r)).slice(0, 8),
      }),
    );
  } else if (iacPresent && stateLevel < 2) {
    findings.push(
      mkFinding({
        id: 'iac:no-remote-state',
        title: 'No remote/locked IaC state backend',
        detail:
          'IaC is declared but state appears local — remote + locked state is the Level 1→2 boundary.',
        dimension: 'infrastructure',
        severity: 'medium',
      }),
    );
  }

  // ── 2. Env separation ──
  const envSet = new Set();
  for (const r of rels) {
    let m;
    if ((m = r.match(/(^|\/)Pulumi\.([a-z0-9-]+)\.ya?ml$/i)) && m[2].toLowerCase() !== 'yaml')
      envSet.add(m[2].toLowerCase());
    if ((m = r.match(/(^|\/)environments?\/([a-z0-9-]+)\//i))) envSet.add(m[2].toLowerCase());
    if (
      (m = r.match(
        /(^|\/)[a-z0-9-]*?(dev|develop|staging|stage|prod|production|test|qa|nonprod)[a-z0-9-]*\.tfvars$/i,
      ))
    )
      envSet.add(m[2].toLowerCase());
  }
  const workspaceInCi = /terraform\s+workspace|TF_WORKSPACE/.test(allContent);
  const sstStage = /--stage\b|SST_STAGE/.test(allContent);
  const envNames = [...envSet];
  let envLevel, envEvidence;
  const envGaps = [];
  if (envNames.length >= 2) {
    envLevel = 2;
    envEvidence = `Separate environments: ${envNames.join(', ')}.`;
  } else if (workspaceInCi || sstStage || envNames.length === 1) {
    envLevel = 1;
    envEvidence =
      envNames.length === 1
        ? `Single environment (${envNames[0]}) with stage/workspace tooling.`
        : 'Stage/workspace tooling present but environments not clearly separated.';
    envGaps.push('Add per-environment stacks/dirs/tfvars (dev/staging/prod) with separate state.');
  } else {
    envLevel = 0;
    envEvidence = 'No environment separation detected (single-env or none).';
    envGaps.push(
      'Introduce dev/staging/prod separation (Pulumi stacks / environments/ dirs / per-env tfvars).',
    );
  }

  // ── 3. Modularity ──
  const resRe = /(^|\n)\s*resource\s+"[a-z0-9_]+"/gi;
  const tfResourceCount = (tfContent.match(resRe) || []).length;
  const rootTfResourceCount = tfFiles
    .filter((f) => !/(^|\/)modules?\//.test(f.rel))
    .reduce((n, f) => n + (f.content.match(resRe) || []).length, 0);
  const hasModuleBlocks = /(^|\n)\s*module\s+"[^"]+"\s*\{/m.test(tfContent);
  // A `modules/` dir is only a Terraform-modularity signal when it actually holds .tf files —
  // scoping to tfFiles avoids false-positiving on app source folders like src/modules/ (SST/TS repos).
  const hasModulesDir = tfFiles.some((f) => /(^|\/)modules?\//.test(f.rel));
  const pinnedModuleSource =
    /source\s*=\s*["'][^"']*\?ref=/.test(tfContent) ||
    /(^|\n)\s*version\s*=\s*["'][~>=0-9]/.test(tfContent) ||
    /source\s*=\s*["'][\w.-]+\/[\w.-]+\/[\w.-]+["']/.test(tfContent);
  const hasComponentResource = /extends\s+(pulumi\.)?ComponentResource|\bComponentResource\b/.test(
    allContent,
  );
  const tferSmell = /tfer(--|_)/.test(allContent) || rels.some((r) => /tfer(--|_)/.test(r));
  let modLevel, modEvidence;
  const modGaps = [];
  if ((hasModuleBlocks || hasModulesDir || hasComponentResource) && pinnedModuleSource) {
    modLevel = 3;
    modEvidence = 'Composed from pinned / versioned modules.';
  } else if (hasModuleBlocks || hasModulesDir || hasComponentResource) {
    modLevel = 2;
    modEvidence = hasComponentResource
      ? 'Pulumi ComponentResource abstractions present.'
      : 'Terraform modules present.';
    modGaps.push('Pin/version module sources (?ref= / version =).');
  } else if (tfResourceCount > 0 || hasSst || hasCdk || hasPulumi) {
    modLevel = 1;
    modEvidence =
      rootTfResourceCount > 0
        ? `Monolithic config (${rootTfResourceCount} resources in root, no modules).`
        : 'Resources declared inline, no module abstraction.';
    modGaps.push('Extract repeated blocks into reusable modules / ComponentResources.');
  } else {
    modLevel = 0;
    modEvidence = 'No IaC resources to modularize.';
  }
  if (tferSmell)
    modGaps.push(
      'Refactor auto-generated tfer-- resources (Terraformer output) into hand-authored modules.',
    );

  // ── 4. Testing ──
  const hasTftest = rels.some((r) => /\.tftest\.hcl$/.test(r));
  const hasTerratest =
    /github\.com\/gruntwork-io\/terratest/.test(allContent) || /\bterratest\b/.test(allSpecs);
  const hasPulumiUnit =
    /@pulumi\/pulumi/.test(`${allContent} ${allSpecs}`) &&
    /setMocks|runtime\.setMocks/.test(allContent);
  let testLevel, testEvidence;
  const testGaps = [];
  if (hasTerratest && (hasTftest || hasPulumiUnit)) {
    testLevel = 3;
    testEvidence = 'Unit (native/Pulumi) + integration (Terratest) tests present.';
  } else if (hasTftest || hasPulumiUnit || hasTerratest) {
    testLevel = 2;
    testEvidence = hasTftest
      ? 'Native tftest.hcl tests present.'
      : hasPulumiUnit
        ? 'Pulumi unit tests (mocked) present.'
        : 'Terratest integration tests present.';
    testGaps.push('Add the complementary test layer (unit ↔ integration).');
  } else {
    testLevel = 0;
    testEvidence = 'No IaC tests detected.';
    if (iacPresent)
      testGaps.push('Add native tftest.hcl / Pulumi unit tests, then Terratest for integration.');
  }

  // ── 5. Governance ──
  const hasCrossGuard =
    rels.some((r) => /(^|\/)PulumiPolicy\.ya?ml$/.test(r)) ||
    /new\s+PolicyPack\(|@pulumi\/policy/.test(`${allContent} ${allSpecs}`);
  const hasRego = rels.some((r) => /\.rego$/.test(r));
  const hasCheckov = rels.some((r) => /(^|\/)\.checkov\.ya?ml$/.test(r));
  const hasTrivyConfig = rels.some((r) => /(^|\/)(trivy\.ya?ml|\.trivyignore)$/.test(r));
  const hasSentinel = rels.some((r) => /\.sentinel$/.test(r));
  const policyAsCode = hasCrossGuard || hasSentinel || hasRego;
  const staticScan = hasCheckov || hasTrivyConfig;
  let govLevel, govEvidence;
  const govGaps = [];
  if (policyAsCode) {
    govLevel = 3;
    govEvidence = hasCrossGuard
      ? 'Pulumi CrossGuard policy pack.'
      : hasSentinel
        ? 'Sentinel policies.'
        : 'OPA/Conftest (.rego) policies.';
    if (!staticScan) govGaps.push('Add Checkov/Trivy static misconfig scanning.');
  } else if (staticScan) {
    govLevel = 2;
    govEvidence = hasCheckov
      ? 'Checkov static scanning configured.'
      : 'Trivy config scanning configured.';
    govGaps.push('Add policy-as-code (CrossGuard / OPA / Sentinel), advisory → mandatory.');
  } else {
    govLevel = 0;
    govEvidence = 'No policy-as-code or misconfig scanning detected.';
    if (iacPresent) govGaps.push('Add Checkov/Trivy scanning + a policy pack.');
  }

  // ── 6. Drift & cost ──
  // P1: Infracost is a real detection ONLY from a named config (infracost.yml) or a
  // CI-workflow step that invokes it — NEVER an allContent keyword (a prose/comment
  // mention of "infracost" is not a cost gate).
  const ciContent = norm
    .filter(
      (f) =>
        /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(f.rel) ||
        /(^|\/)\.gitlab-ci\.ya?ml$/.test(f.rel) ||
        /(^|\/)\.circleci\/config\.ya?ml$/.test(f.rel),
    )
    .map((f) => f.content)
    .join('\n');
  const infracost =
    rels.some((r) => /(^|\/)infracost\.ya?ml$/.test(r)) || /\binfracost\b/i.test(ciContent);
  // P5 — driftCheck requires a CI-WORKFLOW ARTIFACT context (gh-workflow/gitlab-ci/
  // circleci file content), never a prose mention of 'expect-no-changes' anywhere in
  // allContent (a doc string or code comment is not a scheduled drift gate).
  const driftCheck =
    !!ciContent && /expect-no-changes/i.test(ciContent) && /\bcron\b|schedule\s*:/i.test(ciContent);
  // tag taxonomy — default_tags (TF) + Pulumi/inline `tags` maps. P2: scoped to IaC
  // FILES ONLY (not allContent), so an app-domain `tags:` object (a blog post's tags,
  // a UI chip list) can no longer earn false cost-taxonomy credit.
  const isIacTagFile = (f) =>
    /\.(tf|tofu|hcl|bicep)$/i.test(f.rel) ||
    (() => {
      const t = configFileType(f.rel);
      return (
        t &&
        ['resource', 'migrations', 'orchestration', 'container', 'config-mgmt'].includes(iacTier(t))
      );
    })() ||
    /\bsst\.aws\.\w+\s*\(|\bnew\s+(?:aws|gcp|azure)\.\w+\.|aws-cdk-lib|@aws-cdk\//.test(f.content);
  const iacTagContent = norm
    .filter(isIacTagFile)
    .map((f) => f.content)
    .join('\n');
  const tagKeys = new Set();
  for (const m of iacTagContent.matchAll(/default_tags\s*\{([\s\S]*?)\}/gi))
    for (const km of m[1].matchAll(/([A-Za-z][\w-]*)\s*=/g)) tagKeys.add(km[1]);
  for (const m of iacTagContent.matchAll(/\btags\s*[:=]\s*\{([\s\S]*?)\}/gi))
    for (const km of m[1].matchAll(/["']?([A-Za-z][\w-]*)["']?\s*[:=]/g)) tagKeys.add(km[1]);
  const normSet = new Set(
    [...tagKeys].map((k) =>
      k
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/_/g, '-'),
    ),
  );
  // P5/A7 — REQUIRED_TAGS gains owner/managed-by/data-classification (governance
  // taxonomy, not just the original cost taxonomy).
  const REQUIRED_TAGS = [
    'team',
    'environment',
    'service',
    'cost-center',
    'owner',
    'managed-by',
    'data-classification',
  ];
  const TAG_ALIAS = {
    team: ['team'],
    environment: ['environment', 'env'],
    service: ['service', 'service-name', 'svc'],
    'cost-center': ['cost-center', 'costcenter', 'cost-centre'],
    owner: ['owner'],
    'managed-by': ['managed-by', 'managedby', 'managed_by'],
    'data-classification': ['data-classification', 'data-class'],
  };
  const present = REQUIRED_TAGS.filter((t) => (TAG_ALIAS[t] || [t]).some((a) => normSet.has(a)));
  const missing = REQUIRED_TAGS.filter((t) => !present.includes(t));
  const coveragePct = Math.round((present.length / REQUIRED_TAGS.length) * 100);
  // A7 — SST auto-applies `sst:app` / `sst:stage` tags to every resource it
  // provisions. Those are PLATFORM-IMPLICIT (the operator declared nothing), so they
  // must never inflate `coveragePct` — but a bare "0%" reads as "no tags anywhere",
  // which is false for an SST app. Report the two tiers separately and phrase
  // coverage explicitly against the DECLARED-IaC taxonomy.
  const platformImplicit = hasSst ? ['sst:app', 'sst:stage'] : [];
  const tagTaxonomy = {
    present,
    missing,
    coveragePct,
    requiredTags: REQUIRED_TAGS,
    platformImplicit,
    detail:
      `${coveragePct}% (${present.length}/${REQUIRED_TAGS.length}) tag taxonomy present in declared IaC` +
      (platformImplicit.length
        ? `; platform-implicit tags also applied automatically (${platformImplicit.join(', ')}) — not counted, not declared by the operator`
        : ''),
  };
  // regions — P2: generalized beyond AWS (us-east-1) to GCP (us-central1) and Azure
  // (eastus2). Ordered alternatives, most-specific first: AWS xx-word-N · GCP
  // word-wordN · Azure wordN (trailing digit required to avoid matching bare words).
  const regionSet = new Set();
  for (const m of allContent.matchAll(
    /(?:region|location)["']?\s*[:=]\s*["']?([a-z]{2}-[a-z]+-\d+|[a-z]+-[a-z]+\d+|[a-z]{3,}\d+)\b/gi,
  ))
    regionSet.add(m[1].toLowerCase());
  const regions = [...regionSet];
  const regionPolicyPin =
    /deny[\s\S]{0,80}region|region[\s\S]{0,40}(eu-central-1|allowed_regions)/i.test(allContent);
  const regionPinned = regions.length === 1 || (regions.length >= 1 && regionPolicyPin);

  let dcLevel, dcEvidence;
  const dcGaps = [];
  if (driftCheck && infracost) {
    dcLevel = 3;
    dcEvidence = 'Scheduled drift check + Infracost cost gate.';
  } else if (driftCheck || infracost || coveragePct >= 75) {
    dcLevel = 2;
    dcEvidence = [
      driftCheck ? 'scheduled drift check' : null,
      infracost ? 'Infracost cost gate' : null,
      coveragePct >= 75 ? `tag taxonomy ${coveragePct}%` : null,
    ]
      .filter(Boolean)
      .join(' + ');
    if (!driftCheck) dcGaps.push('Add a scheduled plan/preview --expect-no-changes drift check.');
    if (!infracost) dcGaps.push('Add an Infracost cost gate in CI.');
  } else {
    dcLevel = 0;
    dcEvidence = 'No drift check, cost gate, or tag taxonomy detected.';
    if (iacPresent) {
      dcGaps.push('Add scheduled drift detection (--expect-no-changes).');
      dcGaps.push('Enforce a 4-tag cost taxonomy (team/environment/service/cost-center).');
    }
  }
  if (missing.length && dcLevel > 0) dcGaps.push(`Tag taxonomy missing: ${missing.join(', ')}.`);

  // P4 — every dimension score carries `basis`: 'declared' (code-only claim) vs
  // 'verified' (independently confirmed against the live cloud). This engine NEVER
  // probes live cloud, so basis is always 'declared' here — the field exists so a
  // future live-verification pass has somewhere to upgrade it, and so the report can
  // never silently present a declared claim as ground truth.
  const dimensions = {
    state: { level: stateLevel, evidence: stateEvidence, gaps: stateGaps, basis: 'declared' },
    envSeparation: { level: envLevel, evidence: envEvidence, gaps: envGaps, basis: 'declared' },
    modularity: { level: modLevel, evidence: modEvidence, gaps: modGaps, basis: 'declared' },
    testing: { level: testLevel, evidence: testEvidence, gaps: testGaps, basis: 'declared' },
    governance: { level: govLevel, evidence: govEvidence, gaps: govGaps, basis: 'declared' },
    driftCost: { level: dcLevel, evidence: dcEvidence, gaps: dcGaps, basis: 'declared' },
  };

  // ── Roll-up (min-gated, per contract): overall = lowest blocking dimension ──
  const ratio = inventory.iacCoverage?.ratio;
  const allInCode = ratio == null ? true : ratio >= 0.8; // low undeclared
  const remoteOrManaged = stateLevel >= 2;
  let level = 0;
  if (iacPresent) level = 1;
  if (level >= 1 && remoteOrManaged && allInCode) level = 2;
  if (level >= 2 && testLevel >= 2 && govLevel >= 2 && dcLevel >= 2) level = 3;
  if (
    level >= 3 &&
    envLevel >= 2 &&
    modLevel >= 3 &&
    testLevel >= 3 &&
    govLevel >= 3 &&
    dcLevel >= 3
  )
    level = 4;

  // The single binding constraint that capped `level` — shown verbatim so the subtitle
  // never contradicts the visible per-dimension bars (a repo can hold an L0 dimension yet
  // sit at overall L1 because the L2 gate is coverage, not that dimension's own level).
  const pct = ratio == null ? null : Math.round(ratio * 100);
  let levelReason;
  if (!iacPresent) levelReason = 'no IaC declared in the repo';
  else if (!remoteOrManaged)
    levelReason = 'state is local/unmanaged — remote or platform-managed state unlocks L2';
  else if (!allInCode)
    levelReason = `capped at L1 — only ${pct == null ? '<80' : pct}% of infra is declared in code; reach 80% to unlock L2`;
  else if (!(testLevel >= 2 && govLevel >= 2 && dcLevel >= 2))
    levelReason = 'capped at L2 — testing / governance / drift-cost below L2 (the L3 gate)';
  else if (!(envLevel >= 2 && modLevel >= 3 && testLevel >= 3 && govLevel >= 3 && dcLevel >= 3))
    levelReason =
      'capped at L3 — env-separation / modularity / testing / governance / drift not yet at the L4 bar';
  else levelReason = 'all gates satisfied — optimizing';

  // ── P4 — epistemics: verificationBacklog. Every score above is basis:'declared'
  // (parsed from files, never probed live) — one entry per non-trivial declared claim
  // records HOW an operator would independently confirm it. PLUS a fixed set of
  // cloud-blind facts that this file-only engine can NEVER assert either way (PITR,
  // deletion-protection, bucket-versioning, CMK/encryption, runtime-health/DLQ depth,
  // applied cloud tags, shared-account context) — these appear ONLY here, NEVER as a
  // scored dimension (asserting the unmeasurable is defect D3).
  const verificationBacklog = [];
  const addBacklog = (o) =>
    verificationBacklog.push({
      id: o.id,
      fact: o.fact,
      dimension: o.dimension,
      verifyCommand: o.verifyCommand,
      basis: 'unknown',
    });
  if (stateLevel > 0)
    addBacklog({
      id: 'verify:state',
      fact: stateEvidence,
      dimension: 'state',
      verifyCommand:
        'terraform state list (or `pulumi stack export`) — confirm the declared backend is live and its resource count matches code',
    });
  if (envLevel > 0)
    addBacklog({
      id: 'verify:envSeparation',
      fact: envEvidence,
      dimension: 'envSeparation',
      verifyCommand:
        'aws cloudformation list-stacks --query "StackSummaries[].StackName" (or `pulumi stack ls`) — confirm each environment is actually deployed as a distinct stack',
    });
  if (modLevel > 0)
    addBacklog({
      id: 'verify:modularity',
      fact: modEvidence,
      dimension: 'modularity',
      verifyCommand:
        'terraform providers -json | jq .module_calls — confirm pinned module sources actually resolve to the declared versions',
    });
  if (testLevel > 0)
    addBacklog({
      id: 'verify:testing',
      fact: testEvidence,
      dimension: 'testing',
      verifyCommand:
        'terraform test (or `go test ./... -run TestTerraform`) — confirm the declared IaC tests currently pass',
    });
  if (govLevel > 0)
    addBacklog({
      id: 'verify:governance',
      fact: govEvidence,
      dimension: 'governance',
      verifyCommand:
        'checkov -d . --compact (or `conftest test`) — confirm the policy-as-code scan currently passes with 0 hard failures',
    });
  if (dcLevel > 0)
    addBacklog({
      id: 'verify:driftCost',
      fact: dcEvidence,
      dimension: 'driftCost',
      verifyCommand:
        'terraform plan -detailed-exitcode && infracost breakdown --path . — confirm no live drift and current cost numbers',
    });
  // Cloud-blind facts — gated on the resource types actually present so the backlog
  // stays relevant, but the facts themselves are never derivable from files at all.
  const svcList = Array.isArray(inventory.services) ? inventory.services : [];
  const ownCloud = (s) => ['AWS', 'GCP', 'Azure', 'self-hosted'].includes(s.cloud);
  const hasDbStore = svcList.some((s) => s.dataStore && s.kind === 'database' && ownCloud(s));
  const hasObjectStore = svcList.some((s) => s.dataStore && s.kind === 'storage' && ownCloud(s));
  const hasMessaging = svcList.some((s) => s.kind === 'messaging' && ownCloud(s));
  if (hasDbStore) {
    addBacklog({
      id: 'verify:cloud-blind:pitr',
      fact: 'Point-in-time recovery (PITR) enabled on declared data-store tables',
      dimension: 'security',
      verifyCommand:
        'aws dynamodb describe-continuous-backups --table-name <table> (or `aws rds describe-db-instances --query "DBInstances[].BackupRetentionPeriod"`)',
    });
    addBacklog({
      id: 'verify:cloud-blind:deletion-protection',
      fact: 'Deletion protection enabled on declared data-store tables',
      dimension: 'security',
      verifyCommand:
        'aws dynamodb describe-table --table-name <table> --query Table.DeletionProtectionEnabled (or `aws rds describe-db-instances --query "DBInstances[].DeletionProtection"`)',
    });
  }
  if (hasObjectStore) {
    addBacklog({
      id: 'verify:cloud-blind:bucket-versioning',
      fact: 'Bucket versioning enabled on declared object-store buckets',
      dimension: 'security',
      verifyCommand: 'aws s3api get-bucket-versioning --bucket <bucket>',
    });
  }
  if (hasDbStore || hasObjectStore) {
    addBacklog({
      id: 'verify:cloud-blind:cmk-encryption',
      fact: 'Data stores encrypted with a customer-managed key (CMK) vs default/provider-managed key',
      dimension: 'security',
      verifyCommand:
        'aws kms describe-key --key-id <key> (or `aws dynamodb describe-table --query Table.SSEDescription` / `aws s3api get-bucket-encryption --bucket <bucket>`)',
    });
  }
  if (hasMessaging) {
    addBacklog({
      id: 'verify:cloud-blind:runtime-health-dlq',
      fact: 'Runtime health and dead-letter-queue (DLQ) depth of declared messaging resources',
      dimension: 'infrastructure',
      verifyCommand:
        'aws sqs get-queue-attributes --queue-url <dlq-url> --attribute-names ApproximateNumberOfMessages (or `aws lambda get-function --query Configuration.State`)',
    });
  }
  if (iacPresent) {
    addBacklog({
      id: 'verify:cloud-blind:applied-tags',
      fact: 'Tags actually applied to live cloud resources vs declared in IaC',
      dimension: 'governance',
      verifyCommand:
        'aws resourcegroupstaggingapi get-resources --tag-filters Key=team — confirm the declared tag taxonomy is actually applied on live resources',
    });
    addBacklog({
      id: 'verify:cloud-blind:shared-account',
      fact: 'Whether the target cloud account is dedicated or shared with other, unrelated workloads',
      dimension: 'infrastructure',
      verifyCommand:
        'aws sts get-caller-identity && aws organizations describe-account --account-id <id> — confirm the account is not shared with unrelated workloads',
    });
  }

  return {
    level,
    levelName: LEVEL_NAMES[level],
    levelReason,
    dimensions,
    deprecated,
    regions,
    regionPinned,
    tagTaxonomy,
    findings,
    verificationBacklog,
  };
}

// ── CLI ──
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
// P0 — 'graphify-out' + 'vendor' are excluded so the walker never re-ingests prior
// scan artifacts (which ratchets scores upward on every re-scan) or vendored deps.
const IGNORE = new Set([
  'node_modules',
  '.next',
  'dist',
  'out',
  'build',
  '.git',
  'coverage',
  'graphify-out',
  'vendor',
]);
const SPEC_RE = [
  /(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
function specifiers(code) {
  const set = new Set();
  for (const re of SPEC_RE) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(code))) set.add(m[1]);
  }
  return [...set];
}
function walk(dir, root, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  // Sort so file-processing order (and thus any downstream `.slice(0,N)` truncation on
  // an unsorted list) never depends on filesystem readdir order, which POSIX does not
  // guarantee stable across runs/filesystems — pins the resource enumeration count.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const ALLOW_DOT = new Set(['.github', '.circleci', '.tfsec', '.pulumi']);
  // IaC-maturity dotfiles worth surfacing (governance/drift/deprecated catalogs).
  const ALLOW_DOT_FILE = /^\.(checkov\.ya?ml|trivyignore|driftctl\.(ya?ml|toml)|terrascan)$/i;
  for (const e of entries) {
    if (
      e.name.startsWith('.') &&
      e.name !== '.' &&
      !ALLOW_DOT.has(e.name) &&
      !ALLOW_DOT_FILE.test(e.name) &&
      !/^\.env\.(example|sample|template|dist)$/.test(e.name) &&
      !/^\.gitlab-ci\.ya?ml$/.test(e.name)
    )
      continue;
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, root, acc);
    else acc.push(full);
  }
  return acc;
}

/**
 * P5 — dirty-state provenance (best-effort, NEVER author emails/identity): counts
 * pending changes via `git status --porcelain` + a short digest of the untracked-file
 * list, so a scan report can flag "this scan ran against an uncommitted/dirty tree"
 * (which can shift results run-to-run) without embedding any commit/author identity.
 */
export function gitDirtyStateProvenance(repo) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').filter(Boolean);
    const untracked = lines
      .filter((l) => l.startsWith('??'))
      .map((l) => l.slice(3).trim())
      .sort();
    const untrackedDigest = crypto
      .createHash('sha256')
      .update(untracked.join('\n'))
      .digest('hex')
      .slice(0, 16);
    return {
      available: true,
      dirtyCount: lines.length,
      untrackedCount: untracked.length,
      untrackedDigest,
    };
  } catch {
    return { available: false, dirtyCount: null, untrackedCount: null, untrackedDigest: null };
  }
}

function main(argv) {
  const args = argv.slice(2);
  const repo = path.resolve(args[0] || '.');
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
  };
  const out = flag('--out') || path.join(repo, 'graphify-out', 'infra.json');
  const all = walk(repo, repo);
  const files = [];
  const skippedForSize = []; // P5 — files that exceeded the 512KB read cap
  for (const full of all) {
    const rel = path.relative(repo, full);
    const ctype = configFileType(rel);
    const isCode = EXTS.includes(path.extname(full));
    // ambiguous yaml/json/hcl/bicep need content for content-classification.
    const isAmbiguous = !ctype && /\.(ya?ml|json|hcl|bicep)$/.test(rel);
    // hand-rolled deploy scripts / inline IAM policies (non-IaC signal).
    const isDeployish = /\.sh$/.test(rel) || /(^|\/)([\w-]*[-.])?(trust-)?policy\.json$/i.test(rel);
    // Part A: IaC-maturity aux files — state, tests, policy, tags, deprecated tools.
    const isIacAux =
      /(\.tftest\.hcl|\.rego|\.sentinel|\.jinja|\.tfvars|\.tfstate(\.backup)?)$/i.test(rel) ||
      /(^|\/)(PulumiPolicy\.ya?ml|infracost\.ya?ml|trivy\.ya?ml|\.trivyignore|terrascan\.(toml|ya?ml)|driftctl\.(ya?ml|toml)|\.checkov\.ya?ml)$/i.test(
        rel,
      ) ||
      /(^|\/)\.pulumi\//.test(rel) ||
      /(^|\/)\.tfsec\//.test(rel) ||
      /tfer(--|_)/.test(rel) ||
      /_test\.go$/.test(rel);
    if (!ctype && !isCode && !isAmbiguous && !isDeployish && !isIacAux) continue;
    let code = '';
    try {
      const size = fs.statSync(full).size;
      if (size < 512 * 1024) code = fs.readFileSync(full, 'utf8');
      else skippedForSize.push(rel);
    } catch {
      continue;
    }
    const specs = isCode ? specifiers(code) : [];
    // include content for code files that declare infra (under infra/stacks, or that
    // import an IaC tool) so SST/CDK/Pulumi resources in modules are extracted.
    const iacModule =
      isCode &&
      (/(^|\/)(infra|stacks|stack|deploy)\//.test(rel) ||
        /aws-cdk-lib|@aws-cdk\/|['"]sst['"]|['"]sst\/|sst\.aws\.|@pulumi\/|cdktf|\bnew\s+aws\.\w+\./.test(
          code,
        ));
    const contentVal =
      ctype || isAmbiguous || iacModule || isDeployish || isIacAux ? code : undefined;
    files.push({
      rel,
      specifiers: specs,
      content: contentVal,
      // P2b — raw text of regular application code (content NOT loaded for service
      // detection) so the resource-name-builder pass can enumerate the true data plane
      // (e.g. `${prefix}_Directory` in src/lib/*.ts). Kept OUT of the service-detection
      // path on purpose; only the name-builder miner reads it. Skipped when >512KB.
      codeText: contentVal === undefined && isCode ? code : undefined,
      isClient: isCode && /^\s*['"]use client['"]/m.test(code),
    });
  }
  const inv = buildInfraInventory(files);
  // P5 — low-confidence note: files skipped by the 512KB read cap (content-based
  // detections over them are necessarily incomplete).
  inv.lowConfidence = {
    skippedForSize,
    note: skippedForSize.length
      ? `${skippedForSize.length} file(s) exceeded the 512KB read cap and were skipped (content-based detections may be incomplete): ${skippedForSize.slice(0, 20).join(', ')}${skippedForSize.length > 20 ? ', …' : ''}`
      : null,
  };
  // P5 — dirty-state provenance (best-effort; never author identity).
  inv.provenance = { git: gitDirtyStateProvenance(repo) };
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
  } catch {
    /* ignore */
  }
  fs.writeFileSync(out, JSON.stringify({ generatedAt: null, root: repo, ...inv }, null, 2));
  console.error(
    `[infra-extract] signal:${inv.signalQuality.level} iac-maturity:L${inv.iacMaturity.level}(${inv.iacMaturity.levelName}) clouds:${inv.clouds.join('/') || 'none'} services:${inv.summary.serviceCount} stores:${inv.summary.dataStoreCount} external:${inv.summary.externalProcessorCount} → ${out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv);
