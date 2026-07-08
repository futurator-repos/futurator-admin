/**
 * infra-extract.test.mjs — provider-agnostic, FILE-FIRST infra detection.
 * Covers the operator's scenarios: GCP, Azure, Hostinger email, Supabase, Steam —
 * none AWS — plus IaC-file parsing (the authoritative signal) and the
 * confidence/signal-quality model (codebases express infra differently).
 */

import { describe, it, expect } from 'vitest';
import { buildInfraInventory, parseConfig, detectCloudSdk, configFileType, classifyConfigByContent, extractIacResources, enrichInfraWithGraph, detectDeployScript, gradeIacMaturity, iacTier, stripComments, extractIamGrants, parseCfnResources, normalizeArnResource, detectSecretInEnv } from '../infra-extract.mjs';

const svc = (inv, name) => inv.services.find((s) => s.name === name || s.name.startsWith(name));

describe('configFileType + parseConfig (IaC files = authoritative)', () => {
  it('parses a Prisma datasource provider', () => {
    expect(configFileType('prisma/schema.prisma')).toBe('prisma');
    const d = parseConfig('prisma', 'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}', 'prisma/schema.prisma');
    expect(d[0]).toMatchObject({ name: 'Prisma → postgresql', kind: 'database', detectedBy: 'iac-declared', confidence: 'high' });
  });

  it('parses Terraform providers + resources → services + cloud', () => {
    const tf = `
      provider "google" {}
      resource "google_cloud_run_service" "app" {}
      resource "google_firestore_database" "db" {}
    `;
    const d = parseConfig('terraform', tf, 'infra/main.tf');
    const names = d.map((x) => x.name);
    expect(names).toContain('Cloud Run');
    expect(names).toContain('Firestore');
    expect(d.every((x) => x.cloud === 'GCP')).toBe(true);
    expect(d.every((x) => x.confidence === 'high')).toBe(true);
  });

  it('reads env-example value host hint (Hostinger SMTP) without touching .env', () => {
    expect(configFileType('.env.example')).toBe('env-example');
    const d = parseConfig('env-example', 'SMTP_HOST="smtp.hostinger.com"\nSMTP_PORT=465', '.env.example');
    expect(d.some((x) => /Hostinger/.test(x.name))).toBe(true);
  });
});

describe('detectCloudSdk — multi-cloud, not AWS-biased', () => {
  it('detects GCP / Azure / Supabase / Steam SDKs', () => {
    expect(detectCloudSdk('@google-cloud/firestore')).toMatchObject({ cloud: 'GCP', kind: 'database' });
    expect(detectCloudSdk('@azure/cosmos')).toMatchObject({ cloud: 'Azure' });
    expect(detectCloudSdk('@supabase/supabase-js')).toMatchObject({ cloud: 'Supabase', residency: 'external' });
    expect(detectCloudSdk('steamworks.js')).toMatchObject({ cloud: '3rd-party', kind: 'gaming' });
    expect(detectCloudSdk('nodemailer')).toMatchObject({ kind: 'email' });
  });
});

describe('buildInfraInventory — operator scenarios (none AWS)', () => {
  it('GCP app via Terraform (file-first) → high signal, GCP cloud', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "google" {}\nresource "google_cloud_run_service" "x" {}\nresource "google_firestore_database" "d" {}' },
      { rel: 'src/db.ts', specifiers: ['@google-cloud/firestore'] },
    ]);
    expect(inv.clouds).toContain('GCP');
    expect(svc(inv, 'Firestore')).toBeTruthy();
    expect(inv.signalQuality.level).toBe('high'); // IaC declared
  });

  it('Azure + Supabase + Hostinger + no-IaC → medium signal, external list correct', () => {
    const inv = buildInfraInventory([
      { rel: 'src/cosmos.ts', specifiers: ['@azure/cosmos'] },
      { rel: 'src/store.ts', specifiers: ['@supabase/supabase-js'] },
      { rel: '.env.example', content: 'SMTP_HOST=smtp.hostinger.com\nSUPABASE_URL=https://x.supabase.co\nAZURE_TENANT_ID=xxx' },
    ]);
    expect(inv.clouds).toEqual(expect.arrayContaining(['Azure', 'Supabase']));
    expect(svc(inv, 'Cosmos DB')).toBeTruthy();
    expect(inv.services.some((s) => /Hostinger/.test(s.name))).toBe(true);
    // Supabase + Hostinger are external processors → feed compliance
    const ext = inv.external.map((e) => e.provider);
    expect(ext.some((p) => /Supabase/.test(p))).toBe(true);
    expect(ext.some((p) => /Hostinger/.test(p))).toBe(true);
    expect(inv.signalQuality.level).toBe('medium'); // no IaC declared
  });

  it('Steam game (no cloud IaC) → gaming/distribution detected from SDK + env', () => {
    const inv = buildInfraInventory([
      { rel: 'src/steam.ts', specifiers: ['steamworks.js'] },
      { rel: '.env.example', content: 'STEAM_API_KEY=xxx\nSTEAM_APP_ID=480' },
    ]);
    const steam = svc(inv, 'Steam');
    expect(steam).toBeTruthy();
    expect(steam.kind).toBe('gaming');
    expect(inv.external.some((e) => e.provider === 'Steam')).toBe(true);
  });

  it('records provenance (detectedBy) + confidence per service', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "azurerm" {}\nresource "azurerm_cosmosdb_account" "c" {}' },
      { rel: 'src/c.ts', specifiers: ['@azure/cosmos'] },
    ]);
    const cosmos = svc(inv, 'Cosmos DB');
    expect(cosmos.detectedBy).toEqual(expect.arrayContaining(['iac-declared']));
    expect(cosmos.confidence).toBe('high'); // IaC declaration beats SDK inference
  });

  it('low signal when nothing infra-ish is present', () => {
    const inv = buildInfraInventory([{ rel: 'src/util.ts', specifiers: ['lodash', 'react'] }]);
    expect(inv.services).toHaveLength(0);
    expect(inv.signalQuality.level).toBe('low');
  });
});

describe('IaC detection — SST, CDK, cost surface + coverage', () => {
  it('detects SST resources from sst.config.ts → high signal, AWS resources declared', () => {
    expect(configFileType('sst.config.ts')).toBe('sst');
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { app(){return{name:"x"}}, async run(){ const t = new sst.aws.Dynamo("T"); const b = new sst.aws.Bucket("B"); new sst.aws.Function("F",{handler:"h"}); } }' },
    ]);
    expect(inv.signalQuality.level).toBe('high');
    expect(svc(inv, 'DynamoDB')).toBeTruthy();
    expect(svc(inv, 'S3')).toBeTruthy();
    expect(svc(inv, 'Lambda')).toBeTruthy();
    expect(inv.iac.some((i) => i.provider === 'SST' && i.tier === 'resource')).toBe(true);
  });

  it('reclassifies aws-cdk-lib import as DECLARED IaC (not 3rd-party inferred)', () => {
    const inv = buildInfraInventory([{ rel: 'infra/stack.ts', specifiers: ['aws-cdk-lib', 'aws-cdk-lib/aws-s3'] }]);
    const cdk = svc(inv, 'AWS CDK');
    expect(cdk).toBeTruthy();
    expect(cdk.cloud).toBe('AWS');
    expect(cdk.detectedBy).toContain('iac-import');
    expect(cdk.kind).toBe('iac');
    expect(inv.signalQuality.level).toBe('high'); // IaC declared in code
  });

  it('cost surface: own-cloud resources are metered/standing; 3rd-party AI is connectivity', () => {
    const inv = buildInfraInventory([
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] }, // metered
      { rel: 'src/rds.ts', specifiers: ['@aws-sdk/client-rds'] }, // standing
      { rel: 'src/ai.ts', specifiers: ['openai'] }, // connectivity
    ]);
    expect(svc(inv, 'DynamoDB').costModel).toBe('metered');
    expect(svc(inv, 'RDS').costModel).toBe('standing');
    expect(svc(inv, 'OpenAI').costModel).toBe('connectivity');
    expect(inv.costSurface.metered).toBeGreaterThanOrEqual(1);
    expect(inv.costSurface.standing).toBeGreaterThanOrEqual(1);
    expect(inv.costSurface.connectivity).toBeGreaterThanOrEqual(1);
  });

  it('iacCoverage flags own-cloud resources used-but-undeclared (click-ops smell)', () => {
    // DynamoDB + S3 used via SDK, nothing declares them → coverage 0
    const inv = buildInfraInventory([
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3'] },
    ]);
    expect(inv.iacCoverage.provisionable).toBe(2);
    expect(inv.iacCoverage.declared).toBe(0);
    expect(inv.iacCoverage.ratio).toBe(0);
    expect(inv.iacCoverage.undeclared).toEqual(expect.arrayContaining(['DynamoDB', 'S3']));
  });

  it('iacCoverage = 1 when SST declares the same resources the SDK uses', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'new sst.aws.Dynamo("T"); new sst.aws.Bucket("B");' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3'] },
    ]);
    expect(inv.iacCoverage.declared).toBe(inv.iacCoverage.provisionable);
    expect(inv.iacCoverage.ratio).toBe(1);
  });

  it('extracts SST resources from an infra/ MODULE, not just sst.config.ts (the Mycelium fix)', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ await import("./infra/storage"); new sst.aws.Nextjs("Web"); } }', specifiers: ['sst'] },
      { rel: 'infra/storage.ts', specifiers: ['sst'], content: 'export const table = new sst.aws.Dynamo("T"); export const bucket = new sst.aws.Bucket("B");' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3'] },
    ]);
    const dynamo = svc(inv, 'DynamoDB');
    expect(dynamo.detectedBy).toContain('iac-declared'); // declared in the module, not just inferred
    expect(inv.iacCoverage.ratio).toBe(1); // DynamoDB + S3 both declared → no click-ops alarm
  });

  it('bare hyperscaler catch-all (AWS_ env keys) is NOT counted as a cost source or provisionable', () => {
    const inv = buildInfraInventory([
      { rel: '.env.example', content: 'AWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] },
    ]);
    const aws = svc(inv, 'AWS');
    expect(aws.costModel).toBe('none'); // credentials catch-all, not a billable service
    expect(inv.iacCoverage.provisionable).toBe(1); // only DynamoDB, not the bare AWS entry
  });
});

describe('C4 — content-based IaC extraction (no import present)', () => {
  it('extracts SST v3 resources from ambient sst.aws.* with NO sst import', () => {
    // SST v3 infra modules use the ambient `sst.aws.*` global — no import at all.
    const inv = buildInfraInventory([
      { rel: 'infra/storage.ts', content: 'export const table = new sst.aws.Dynamo("T");\nexport const bucket = new sst.aws.Bucket("B");\nexport const fn = new sst.aws.Function("F", { handler: "h" });' },
    ]);
    const dynamo = svc(inv, 'DynamoDB');
    expect(dynamo).toBeTruthy();
    expect(dynamo.detectedBy).toContain('iac-declared');
    expect(dynamo.confidence).toBe('high');
    expect(svc(inv, 'S3')).toBeTruthy();
    expect(svc(inv, 'Lambda')).toBeTruthy();
    expect(inv.signalQuality.level).toBe('high'); // content-declared IaC, no import
    expect(inv.signalQuality.iacDeclared).toBe(true);
  });

  it('extracts Pulumi resources from `new aws.*` constructs with NO @pulumi import', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/index.ts', content: 'const b = new aws.s3.BucketV2("b");\nconst t = new aws.dynamodb.Table("t", {});' },
    ]);
    expect(svc(inv, 'S3')).toBeTruthy();
    expect(svc(inv, 'DynamoDB')).toBeTruthy();
    expect(svc(inv, 'S3').detectedBy).toContain('iac-declared');
    expect(inv.signalQuality.level).toBe('high');
  });

  it('does not false-positive on plain code with no IaC construct signature', () => {
    const inv = buildInfraInventory([
      { rel: 'src/util.ts', content: 'export const add = (a, b) => a + b;\nconst x = new Map();', specifiers: ['lodash'] },
    ]);
    expect(inv.signalQuality.iacDeclared).toBe(false);
    expect(inv.services).toHaveLength(0);
  });
});

describe('C5 — enrichInfraWithGraph (graph-informed fan-in / centralization)', () => {
  it('annotates fanIn + centralized per service', () => {
    const inv = buildInfraInventory([
      { rel: 'src/a/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] }, // 1 file → centralized
      { rel: 'src/b/x.ts', specifiers: ['@aws-sdk/client-s3'] },
      { rel: 'src/c/y.ts', specifiers: ['@aws-sdk/client-s3'] },
      { rel: 'src/d/z.ts', specifiers: ['@aws-sdk/client-s3'] },
      { rel: 'src/e/w.ts', specifiers: ['@aws-sdk/client-s3'] }, // 4 files, 4 dirs → not centralized
    ]);
    const graph = { nodes: [{ source_file: 'src/a/db.ts' }] };
    const resolved = { hubs: [{ file: 'src/a/db.ts', inDegree: 5 }] };
    const enriched = enrichInfraWithGraph(inv, graph, resolved);

    const dynamo = enriched.services.find((s) => s.name === 'DynamoDB');
    const s3 = enriched.services.find((s) => s.name === 'S3');
    expect(dynamo.fanIn).toBe(5); // from hub in-degree
    expect(dynamo.centralized).toBe(true); // single file
    expect(s3.fanIn).toBe(4); // no hub match → falls back to file count
    expect(s3.centralized).toBe(false); // spread across 4 dirs
    // pure: original inventory untouched
    expect(inv.services.find((s) => s.name === 'DynamoDB').fanIn).toBeUndefined();
  });

  it('returns inventory unchanged when graph/resolved are null (defensive)', () => {
    const inv = buildInfraInventory([{ rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] }]);
    expect(enrichInfraWithGraph(inv, null, null)).toBe(inv);
    expect(enrichInfraWithGraph(inv, { nodes: [] }, null)).toBe(inv);
  });
});

describe('Comprehensive IaC families — any project type', () => {
  it('recognizes the full taxonomy by filename', () => {
    expect(configFileType('main.bicep')).toBe('bicep');
    expect(configFileType('infra/terragrunt.hcl')).toBe('terragrunt');
    expect(configFileType('Dockerfile')).toBe('docker');
    expect(configFileType('Vagrantfile')).toBe('vagrant');
    expect(configFileType('flake.nix')).toBe('nix');
    expect(configFileType('charts/app/Chart.yaml')).toBe('helm');
    expect(configFileType('k8s/kustomization.yaml')).toBe('kustomize');
    expect(configFileType('playbook.yml')).toBe('ansible');
    expect(configFileType('cookbooks/web/metadata.rb')).toBe('chef');
    expect(configFileType('manifests/web.pp')).toBe('puppet');
    expect(configFileType('states/web.sls')).toBe('salt');
    expect(configFileType('.gitlab-ci.yml')).toBe('gitlab-ci');
    expect(configFileType('.circleci/config.yml')).toBe('circleci');
  });

  it('content-classifies ambiguous yaml (K8s / CloudFormation / SAM / ArgoCD / Flux)', () => {
    expect(classifyConfigByContent('deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web')).toBe('kubernetes');
    expect(classifyConfigByContent('stack.yaml', 'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Fn:\n    Type: AWS::Lambda::Function')).toBe('cloudformation');
    expect(classifyConfigByContent('template.yaml', 'Transform: AWS::Serverless-2016-10-31\nResources: {}')).toBe('sam');
    expect(classifyConfigByContent('argo-app.yaml', 'apiVersion: argoproj.io/v1alpha1\nkind: Application')).toBe('argocd');
    expect(classifyConfigByContent('rel.yaml', 'apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease')).toBe('flux');
    expect(classifyConfigByContent('package.json', '{"name":"x"}')).toBe(null); // not infra
  });

  it('a Kubernetes/Helm repo (no own-cloud SDK) reads as IaC-declared, not "no IaC"', () => {
    const inv = buildInfraInventory([
      { rel: 'charts/app/Chart.yaml', content: 'apiVersion: v2\nname: app' },
      { rel: 'k8s/deploy.yaml', content: 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}' },
    ]);
    expect(inv.signalQuality.level).toBe('high');
    expect(inv.summary.resourceIacFiles).toBeGreaterThan(0);
    expect(inv.iac.some((i) => i.tier === 'orchestration')).toBe(true);
  });

  it('extractIacResources handles CDK + Pulumi construct syntax', () => {
    const cdk = extractIacResources('const b = new Bucket(this, "B"); new dynamodb.Table(this, "T");', 'AWS CDK').map((r) => r.name);
    expect(cdk).toEqual(expect.arrayContaining(['S3', 'DynamoDB']));
    const pulumi = extractIacResources('const b = new aws.s3.BucketV2("b"); new aws.dynamodb.Table("t", {});', 'Pulumi').map((r) => r.name);
    expect(pulumi).toEqual(expect.arrayContaining(['S3', 'DynamoDB']));
  });

  it('detects hand-rolled deploy scripts + inline IAM policy (non-IaC / click-ops)', () => {
    expect(detectDeployScript('infra/lambda/graph-sync/deploy.sh', 'aws lambda update-function-code ...\naws iam put-role-policy ...')).toMatchObject({ kind: 'shell-deploy' });
    expect(detectDeployScript('infra/lambda/graph-sync/deploy.sh', 'aws lambda update-function-code').provisions).toContain('Lambda');
    expect(detectDeployScript('infra/lambda/graph-sync/trust-policy.json', '{"Statement":[{"Effect":"Allow","Action":"sts:AssumeRole"}]}')).toMatchObject({ kind: 'iam-policy' });
    expect(detectDeployScript('src/app.ts', 'export const x = 1')).toBe(null);
    const inv = buildInfraInventory([
      { rel: 'infra/lambda/graph-sync/deploy.sh', content: 'aws lambda update-function-code\naws iam put-role-policy' },
      { rel: 'infra/lambda/graph-sync/custom-policy.json', content: '{"Statement":[{"Effect":"Allow","Action":"dynamodb:*"}]}' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] },
    ]);
    expect(inv.deployScripts.length).toBe(2);
    expect(inv.summary.deployScriptCount).toBe(2);
    expect(inv.deployScripts.some((d) => d.kind === 'shell-deploy' && d.provisions.includes('Lambda'))).toBe(true);
  });

  it('Ansible (config-mgmt) is recognized as its own family, not provisioning', () => {
    const inv = buildInfraInventory([{ rel: 'playbook.yml', content: '- hosts: web\n  tasks: []' }]);
    expect(inv.iac.some((i) => i.tier === 'config-mgmt')).toBe(true);
    expect(inv.signalQuality.level).toBe('high');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1 — TRUTH OF DECLARATION (comments ≠ declarations; constructor-invocation only;
// IAM-grant ARNs = used-but-undeclared; infracost needs a real artifact).
// ════════════════════════════════════════════════════════════════════════════

describe('P1 — stripComments (comments are never declarations)', () => {
  it('strips // line, /* block */ (code) and leading-# (yaml) but preserves URLs + TS #private', () => {
    expect(stripComments('const x = 1; // new sst.aws.Dynamo("T")')).not.toMatch(/sst\.aws\.Dynamo/);
    expect(stripComments('/* new sst.aws.Bucket("B") */ const y = 2;')).not.toMatch(/sst\.aws\.Bucket/);
    // URL not eaten as a comment
    expect(stripComments('const u = "https://api.example.com/v1";')).toMatch(/https:\/\/api\.example\.com/);
    // TS private field survives (only yaml/hcl get #-stripping)
    expect(stripComments('class A { #secret = 1; }', 'src/a.ts')).toMatch(/#secret/);
    // yaml leading-# comment removed
    expect(stripComments('region: eu # infracost note', 'infra/x.yaml')).not.toMatch(/infracost/);
  });
});

describe('P1 — truth of declaration', () => {
  // (a) a COMMENT mentioning sst.aws.Dynamo does NOT yield a declared DynamoDB.
  it('(a) a comment mentioning sst.aws.Dynamo does not declare a DynamoDB (defect D1)', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ // NOTE: X is not declared as sst.aws.Dynamo, it is external\n new sst.aws.Bucket("B"); } }' },
    ]);
    expect(svc(inv, 'DynamoDB')).toBeFalsy(); // the comment must not mint a table
    expect(svc(inv, 'S3')).toBeTruthy(); // the real construct is still found
  });

  // (b) a real `new sst.aws.Dynamo(` / TF resource DOES declare a DynamoDB.
  it('(b) a real new sst.aws.Dynamo( construct declares a DynamoDB', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ new sst.aws.Dynamo("T"); } }' },
    ]);
    const d = svc(inv, 'DynamoDB');
    expect(d).toBeTruthy();
    expect(d.detectedBy).toContain('iac-declared');
  });

  it('(b) a real TF aws_dynamodb_table resource declares a DynamoDB', () => {
    const d = parseConfig('terraform', 'resource "aws_dynamodb_table" "t" { name = "T" }', 'infra/main.tf');
    expect(d.some((x) => x.name === 'DynamoDB' && x.confidence === 'high')).toBe(true);
  });

  // (c) an app file with a UI `new Table(` class grows NO phantom DynamoDB.
  it('(c) a UI new Table( class in a real SST file grows no phantom DynamoDB', () => {
    const inv = buildInfraInventory([
      // real SST Lambda declared, plus an unrelated UI grid `new Table(...)`
      { rel: 'infra/app.ts', content: 'export const fn = new sst.aws.Function("F", { handler: "h" });\nconst grid = new Table({ rows: [] });' },
    ]);
    expect(svc(inv, 'Lambda')).toBeTruthy(); // the real construct is detected
    expect(svc(inv, 'DynamoDB')).toBeFalsy(); // the UI `new Table(` is NOT a DynamoDB
  });

  it('(c) extractIacResources ignores a bare UI new Table( under the SST tool', () => {
    const r = extractIacResources('const grid = new Table({ rows: [] });\nconst b = new Box();', 'SST').map((x) => x.name);
    expect(r).not.toContain('DynamoDB');
    expect(r).not.toContain('S3');
  });

  // (d) an ARN in an IAM policy yields a used-but-undeclared reference.
  it('(d) an IAM-policy ARN yields a used-but-undeclared DynamoDB reference', () => {
    expect(extractIamGrants('"Resource":"arn:aws:dynamodb:us-east-1:123456789012:table/Scores"').map((g) => g.name)).toContain('DynamoDB');
    const inv = buildInfraInventory([
      { rel: 'infra/lambda/graph-sync/custom-policy.json', content: '{"Statement":[{"Effect":"Allow","Action":"dynamodb:GetItem","Resource":"arn:aws:dynamodb:us-east-1:123456789012:table/Scores"}]}' },
    ]);
    const d = svc(inv, 'DynamoDB');
    expect(d).toBeTruthy();
    expect(d.detectedBy).toContain('iam-grant');
    expect(d.detectedBy).not.toContain('iac-declared'); // referenced, not declared
    expect(inv.iacCoverage.undeclared).toContain('DynamoDB'); // shows in the click-ops smell
  });

  // (e) no infracost detection without a real config/CI artifact.
  it('(e) an infracost mention in prose/comment does NOT count as a cost gate', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}\n# TODO: someday wire up infracost in CI' },
    ]);
    expect(inv.iacMaturity.dimensions.driftCost.level).toBe(0); // no artifact → not detected
  });

  it('(e) infracost IS detected from a real CI-workflow step', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: '.github/workflows/cost.yml', content: 'jobs:\n  cost:\n    steps:\n      - run: infracost diff' },
    ]);
    expect(inv.iacMaturity.dimensions.driftCost.level).toBeGreaterThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part A — IaC maturity grading + deprecated-toolchain catalog (deterministic)
// ════════════════════════════════════════════════════════════════════════════

describe('gradeIacMaturity — state & provisioning dimension', () => {
  it('remote Terraform backend (s3) → state L2, remoteOrManaged, no committed-state finding', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'terraform {\n backend "s3" { bucket = "st" \n dynamodb_table = "locks" }\n}\nprovider "aws" { region = "eu-central-1" }\nresource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.dimensions.state.level).toBe(2);
    expect(inv.iacMaturity.dimensions.state.gaps).not.toContain('No state locking detected (add DynamoDB lock table / use_lockfile).');
    expect(inv.iacMaturity.findings.some((f) => f.id === 'iac:committed-state')).toBe(false);
  });

  it('local Terraform backend → state L1 + a no-remote-state finding', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'terraform { backend "local" {} }\nprovider "aws" {}\nresource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.dimensions.state.level).toBe(1);
    const f = inv.iacMaturity.findings.find((x) => x.id === 'iac:no-remote-state');
    expect(f).toBeTruthy();
    expect(f.dimension).toBe('infrastructure');
    expect(f.evidence.iac).toBe(true);
  });

  it('committed terraform.tfstate → state capped at L1 + HIGH security finding (evidence.iac)', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'terraform { backend "s3" {} }\nresource "aws_s3_bucket" "b" {}' },
      { rel: 'infra/terraform.tfstate', content: '{"version":4,"resources":[]}' },
    ]);
    expect(inv.iacMaturity.dimensions.state.level).toBe(1);
    const f = inv.iacMaturity.findings.find((x) => x.id === 'iac:committed-state');
    expect(f).toBeTruthy();
    expect(f.severity).toBe('high');
    expect(f.dimension).toBe('security');
    expect(f.producedBy).toBe('deterministic');
    expect(f.evidence.iac).toBe(true);
  });

  it('SST → platform-managed state (auto-pass) → state L2', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ new sst.aws.Bucket("B"); } }' },
    ]);
    expect(inv.iacMaturity.dimensions.state.level).toBe(2);
  });

  it('no IaC at all → state L0, overall ClickOps (L0)', () => {
    const inv = buildInfraInventory([{ rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] }]);
    expect(inv.iacMaturity.dimensions.state.level).toBe(0);
    expect(inv.iacMaturity.level).toBe(0);
    expect(inv.iacMaturity.levelName).toBe('ClickOps');
  });
});

describe('gradeIacMaturity — env separation dimension', () => {
  it('Pulumi dev/staging/prod stacks → env L2', () => {
    const inv = buildInfraInventory([
      { rel: 'Pulumi.yaml', content: 'name: app\nruntime: nodejs' },
      { rel: 'Pulumi.dev.yaml', content: 'config: {}' },
      { rel: 'Pulumi.staging.yaml', content: 'config: {}' },
      { rel: 'Pulumi.prod.yaml', content: 'config: {}' },
    ]);
    expect(inv.iacMaturity.dimensions.envSeparation.level).toBe(2);
    expect(inv.iacMaturity.dimensions.envSeparation.evidence).toMatch(/dev/);
  });

  it('per-env tfvars in environments/ dirs → env L2', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: 'environments/dev/dev.tfvars', content: 'region = "eu-central-1"' },
      { rel: 'environments/prod/prod.tfvars', content: 'region = "eu-central-1"' },
    ]);
    expect(inv.iacMaturity.dimensions.envSeparation.level).toBe(2);
  });

  it('single-env only → env L0 with a gap', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.dimensions.envSeparation.level).toBe(0);
    expect(inv.iacMaturity.dimensions.envSeparation.gaps.length).toBeGreaterThan(0);
  });
});

describe('gradeIacMaturity — modularity dimension', () => {
  it('module blocks + modules/ dir + pinned version → modularity L3', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'module "net" {\n source = "terraform-aws-modules/vpc/aws"\n version = "5.1.0"\n}' },
      { rel: 'modules/net/main.tf', content: 'resource "aws_vpc" "v" {}' },
    ]);
    expect(inv.iacMaturity.dimensions.modularity.level).toBe(3);
  });

  it('root monolith (many resources, no modules) → modularity L1', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: Array.from({ length: 6 }, (_, i) => `resource "aws_s3_bucket" "b${i}" {}`).join('\n') },
    ]);
    expect(inv.iacMaturity.dimensions.modularity.level).toBe(1);
    expect(inv.iacMaturity.dimensions.modularity.evidence).toMatch(/[Mm]onolith/);
  });

  it('tfer-- generated names → a refactor-smell gap on modularity', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "tfer--my-bucket" {}' },
    ]);
    expect(inv.iacMaturity.dimensions.modularity.gaps.some((g) => /tfer--/.test(g))).toBe(true);
  });

  it('app src/modules/ folder (no .tf) is NOT read as Terraform modules — SST repo stays L1', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { app() {}, async run() { new sst.aws.Function("f", {}); } }' },
      { rel: 'src/modules/auth/index.ts', content: 'export const auth = () => {};' },
      { rel: 'src/modules/billing/index.ts', content: 'export const billing = () => {};' },
    ]);
    expect(inv.iacMaturity.dimensions.modularity.level).toBe(1);
    expect(inv.iacMaturity.dimensions.modularity.evidence).not.toMatch(/Terraform modules present/);
    expect(inv.iacMaturity.dimensions.modularity.evidence).toMatch(/inline|no module abstraction/i);
  });
});

describe('gradeIacMaturity — testing & governance dimensions', () => {
  it('*.tftest.hcl → testing L2', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: 'tests/bucket.tftest.hcl', content: 'run "ok" { command = plan }' },
    ]);
    expect(inv.iacMaturity.dimensions.testing.level).toBe(2);
  });

  it('checkov config → governance L2 (static scanning)', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: '.checkov.yaml', content: 'framework:\n  - terraform' },
    ]);
    expect(inv.iacMaturity.dimensions.governance.level).toBe(2);
  });

  it('OPA/Conftest .rego policy → governance L3 (policy-as-code)', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: 'policy/deny.rego', content: 'package main\ndeny[msg] { true }' },
    ]);
    expect(inv.iacMaturity.dimensions.governance.level).toBe(3);
  });
});

describe('gradeIacMaturity — drift/cost, tags, regions', () => {
  // P5/A7 — REQUIRED_TAGS grew from 4 → 7 (owner/managed-by/data-classification
  // added), so a 4-tag fixture is now PARTIAL coverage (4/7), not 100%.
  it('7-tag full coverage → 100% taxonomy, regions extracted + pinned', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "aws" {\n region = "eu-central-1"\n default_tags {\n tags = {\n team = "core"\n environment = "prod"\n service = "api"\n cost-center = "cc-1"\n owner = "platform"\n managed-by = "terraform"\n data-classification = "internal"\n }\n }\n}\nresource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.tagTaxonomy.coveragePct).toBe(100);
    expect(inv.iacMaturity.tagTaxonomy.missing).toEqual([]);
    expect(inv.iacMaturity.regions).toContain('eu-central-1');
    expect(inv.iacMaturity.regionPinned).toBe(true);
  });

  it('the original 4-tag set alone → 57% coverage against the 7-tag taxonomy, missing lists the new 3', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "aws" {\n region = "eu-central-1"\n default_tags {\n tags = {\n team = "core"\n environment = "prod"\n service = "api"\n cost-center = "cc-1"\n }\n }\n}\nresource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.tagTaxonomy.coveragePct).toBe(57);
    expect(inv.iacMaturity.tagTaxonomy.missing).toEqual(expect.arrayContaining(['owner', 'managed-by', 'data-classification']));
  });

  it('partial tags → coverage < 100 with the missing keys listed', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "aws" {\n default_tags {\n tags = {\n team = "core"\n environment = "prod"\n }\n }\n}\nresource "aws_s3_bucket" "b" {}' },
    ]);
    expect(inv.iacMaturity.tagTaxonomy.coveragePct).toBe(29);
    expect(inv.iacMaturity.tagTaxonomy.missing).toEqual(expect.arrayContaining(['service', 'cost-center']));
  });

  it('scheduled drift + infracost → driftCost L3', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: '.github/workflows/drift.yml', content: 'on:\n  schedule:\n    - cron: "0 6 * * *"\njobs:\n  drift:\n    steps:\n      - run: pulumi preview --expect-no-changes\n      - run: infracost diff' },
    ]);
    expect(inv.iacMaturity.dimensions.driftCost.level).toBe(3);
  });
});

describe('gradeIacMaturity — deprecated toolchain catalog', () => {
  it('cdktf.json is now a WARNING (deprecation) — still detected as infra, no longer resource-tier', () => {
    // flip: cdktf must NOT be scored resource-tier, but MUST still be detected + flagged.
    expect(iacTier('cdktf')).toBe('deprecated');
    const inv = buildInfraInventory([
      { rel: 'cdktf.json', content: '{"language":"typescript","app":"npx ts-node main.ts"}' },
    ]);
    // still detected as infra (not silently dropped)
    expect(inv.signalQuality.iacDeclared).toBe(true);
    expect(inv.services.some((s) => /Terraform CDK/.test(s.name))).toBe(true);
    // now a deprecation finding + catalog entry
    const dep = inv.iacMaturity.deprecated.find((d) => /CDKTF/.test(d.tool));
    expect(dep).toBeTruthy();
    expect(dep.eolDate).toBe('2025-12-10');
    expect(dep.severity).toBe('medium');
    const f = inv.iacMaturity.findings.find((x) => x.id === 'iac:deprecated:cdktf');
    expect(f).toBeTruthy();
    expect(f.dimension).toBe('infrastructure');
    expect(f.evidence.iac).toBe(true);
  });

  it('cdktf import in code is also flagged (still infra, deprecated)', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.ts', specifiers: ['cdktf', 'cdktf/lib/aws'] }]);
    expect(inv.iacMaturity.deprecated.some((d) => /CDKTF/.test(d.tool))).toBe(true);
  });

  it('GCP Deployment Manager (*.jinja) → HIGH/urgent deprecation (EOL 2026-03-31)', () => {
    const inv = buildInfraInventory([
      { rel: 'dm/vm.jinja', content: 'resources:\n- name: vm\n  type: compute.v1.instance' },
    ]);
    const dep = inv.iacMaturity.deprecated.find((d) => /Deployment Manager/.test(d.tool));
    expect(dep).toBeTruthy();
    expect(dep.severity).toBe('high');
    expect(dep.status).toBe('eol');
    expect(dep.eolDate).toBe('2026-03-31');
    const f = inv.iacMaturity.findings.find((x) => x.id === 'iac:deprecated:gcp-deployment-manager');
    expect(f.severity).toBe('high');
  });

  it('tfsec + terrascan + driftctl configs → low-severity deprecation entries', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: '.tfsec/config.yml', content: 'exclude: []' },
      { rel: 'terrascan.toml', content: '[rules]' },
      { rel: '.driftctl.yml', content: 'driftignore: []' },
    ]);
    const tools = inv.iacMaturity.deprecated.map((d) => d.tool);
    expect(tools.some((t) => /tfsec/.test(t))).toBe(true);
    expect(tools.some((t) => /Terrascan/.test(t))).toBe(true);
    expect(tools.some((t) => /driftctl/.test(t))).toBe(true);
    expect(inv.iacMaturity.deprecated.filter((d) => /tfsec|Terrascan|driftctl/.test(d.tool)).every((d) => d.severity === 'low')).toBe(true);
  });
});

describe('gradeIacMaturity — roll-up (min-gated, uneven grades)', () => {
  it('SST-heavy, all-in-code, no tests/policy/drift → overall L2 (Defined), testing/governance gaps stay L0', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ const t = new sst.aws.Dynamo("T"); const b = new sst.aws.Bucket("B"); } }' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3'] },
    ]);
    // all provisionable declared → allInCode; SST → remote state → L2 achievable
    expect(inv.iacMaturity.level).toBe(2);
    expect(inv.iacMaturity.levelName).toBe('Defined');
    // uneven: testing & governance still 0
    expect(inv.iacMaturity.dimensions.testing.level).toBe(0);
    expect(inv.iacMaturity.dimensions.governance.level).toBe(0);
  });

  it('cannot reach L2 with undeclared (click-ops) resources even with SST present', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ new sst.aws.Bucket("B"); } }' },
      { rel: 'infra/lambda/graph-sync/deploy.sh', content: 'aws lambda update-function-code\naws dynamodb create-table' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-rds'] }, // undeclared → low coverage
    ]);
    expect(inv.iacMaturity.level).toBe(1); // gated down: not all-infra-in-code
    expect(inv.iacMaturity.levelName).toBe('Repeatable');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STAGE A3 — P4 epistemics (basis + verificationBacklog) + the P5 tag/driftCheck
// items that live in gradeIacMaturity.
// ════════════════════════════════════════════════════════════════════════════

describe('gradeIacMaturity — P4 epistemics: basis field on every dimension', () => {
  it('every dimension score carries basis:"declared" (code-only engine, never live-verified)', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' }]);
    for (const dim of Object.values(inv.iacMaturity.dimensions)) expect(dim.basis).toBe('declared');
  });

  it('cloud-blind facts NEVER appear as a scored dimension key (D3 guard)', () => {
    const inv = buildInfraInventory([{ rel: 'sst.config.ts', content: 'export default { async run(){ const t = new sst.aws.Dynamo("T"); } }' }]);
    expect(Object.keys(inv.iacMaturity.dimensions)).toEqual(['state', 'envSeparation', 'modularity', 'testing', 'governance', 'driftCost']);
    expect(Object.keys(inv.iacMaturity.dimensions).some((k) => /pitr|versioning|cmk|dlq|deletion/i.test(k))).toBe(false);
  });
});

describe('gradeIacMaturity — P4 epistemics: verificationBacklog', () => {
  it('a DynamoDB + S3 SST app → non-empty backlog, all basis:"unknown", incl. PITR + bucket-versioning verify commands', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ const t = new sst.aws.Dynamo("T"); const b = new sst.aws.Bucket("B"); } }' },
    ]);
    const backlog = inv.iacMaturity.verificationBacklog;
    expect(backlog.length).toBeGreaterThan(0);
    expect(backlog.every((b) => b.basis === 'unknown')).toBe(true);
    expect(backlog.every((b) => typeof b.verifyCommand === 'string' && b.verifyCommand.length > 0)).toBe(true);
    const pitr = backlog.find((b) => b.id === 'verify:cloud-blind:pitr');
    expect(pitr).toBeTruthy();
    expect(pitr.verifyCommand).toMatch(/describe-continuous-backups/);
    const deletionProtection = backlog.find((b) => b.id === 'verify:cloud-blind:deletion-protection');
    expect(deletionProtection).toBeTruthy();
    const versioning = backlog.find((b) => b.id === 'verify:cloud-blind:bucket-versioning');
    expect(versioning).toBeTruthy();
    expect(versioning.verifyCommand).toMatch(/get-bucket-versioning/);
    const cmk = backlog.find((b) => b.id === 'verify:cloud-blind:cmk-encryption');
    expect(cmk).toBeTruthy();
    // declared-only per-dimension claim also lands in the backlog (state was claimed → L2)
    expect(backlog.some((b) => b.id === 'verify:state')).toBe(true);
  });

  it('a queue/messaging service adds a runtime-health/DLQ verify entry', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'export default { async run(){ const q = new sst.aws.Queue("Q"); } }' },
    ]);
    expect(inv.iacMaturity.verificationBacklog.some((b) => b.id === 'verify:cloud-blind:runtime-health-dlq')).toBe(true);
  });

  it('no IaC and no cloud SDK usage at all → verificationBacklog is empty (nothing declared to verify)', () => {
    const inv = buildInfraInventory([{ rel: 'src/util.ts', content: 'export const add = (a, b) => a + b;' }]);
    expect(inv.iacMaturity.verificationBacklog).toEqual([]);
  });

  it('an SDK-inferred (undeclared) DynamoDB import still seeds cloud-blind PITR/deletion-protection entries, but no per-dimension "declared claim" entries', () => {
    const inv = buildInfraInventory([{ rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] }]);
    const backlog = inv.iacMaturity.verificationBacklog;
    expect(backlog.some((b) => b.id === 'verify:cloud-blind:pitr')).toBe(true);
    // no IaC was declared, so none of the six scored-dimension claims fired.
    expect(backlog.some((b) => b.id.startsWith('verify:state') || b.id.startsWith('verify:testing'))).toBe(false);
  });
});

describe('gradeIacMaturity — P5 tag report: declared-IaC coverage vs platform-implicit SST tags', () => {
  it('SST app with zero custom tags declared → 0% "in declared IaC", but platformImplicit lists sst:app/sst:stage', () => {
    const inv = buildInfraInventory([{ rel: 'sst.config.ts', content: 'export default { async run(){ new sst.aws.Bucket("B"); } }' }]);
    const t = inv.iacMaturity.tagTaxonomy;
    expect(t.coveragePct).toBe(0);
    expect(t.platformImplicit).toEqual(['sst:app', 'sst:stage']);
    expect(t.detail).toMatch(/0%.*declared IaC/);
    expect(t.detail).toMatch(/sst:app/);
  });

  it('a non-SST repo with no tags → platformImplicit stays empty', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' }]);
    expect(inv.iacMaturity.tagTaxonomy.platformImplicit).toEqual([]);
  });

  it('REQUIRED_TAGS is exposed and includes the new owner/managed-by/data-classification keys', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' }]);
    expect(inv.iacMaturity.tagTaxonomy.requiredTags).toEqual(expect.arrayContaining(['owner', 'managed-by', 'data-classification']));
  });
});

describe('gradeIacMaturity — P5 driftCheck requires a CI-workflow artifact', () => {
  it('an "expect-no-changes" + cron mention in a non-CI file (README/comment) does NOT count as a drift gate', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' },
      { rel: 'README.md', content: 'Run this on a cron schedule and expect-no-changes from terraform plan.' },
    ]);
    expect(inv.iacMaturity.dimensions.driftCost.level).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P2 — RESOURCE-LEVEL MODEL (resources[] per service; CFN/SAM/serverless resource
// enumeration; resource-level coverage; GCP/Azure regions; IaC-scoped tags;
// platform-config demoted). Referenced-only resources carry existence:'unknown'.
// ════════════════════════════════════════════════════════════════════════════

describe('P2 — normalizeArnResource', () => {
  it('collapses table/bucket/function sub-paths to a bare resource name; drops pure *', () => {
    expect(normalizeArnResource('dynamodb', 'table/Mycelium_*/index/*')).toBe('Mycelium_*');
    expect(normalizeArnResource('dynamodb', 'table/Scores')).toBe('Scores');
    expect(normalizeArnResource('s3', 'mycelium-snapshots/*')).toBe('mycelium-snapshots');
    expect(normalizeArnResource('lambda', 'function:my-fn')).toBe('my-fn');
    expect(normalizeArnResource('dynamodb', 'table/*')).toBe(null); // no name to enumerate
  });
});

describe('P2 — extractIamGrants carries referenced resources[] (existence unknown)', () => {
  it('a table ARN + its /index/* variant collapse to ONE referenced resource', () => {
    const grants = extractIamGrants('arn:aws:dynamodb:us-east-1:123:table/Scores\narn:aws:dynamodb:us-east-1:123:table/Scores/index/gsi1');
    const dyn = grants.find((g) => g.name === 'DynamoDB');
    expect(dyn.resources).toHaveLength(1);
    expect(dyn.resources[0]).toMatchObject({ name: 'Scores', declared: false, existence: 'unknown' });
  });

  it('tolerates ${REGION}/${ACCT} interpolation and captures the wildcard pattern', () => {
    const grants = extractIamGrants('const a = `arn:aws:dynamodb:${REGION}:${ACCT}:table/Mycelium_*`;');
    const dyn = grants.find((g) => g.name === 'DynamoDB');
    expect(dyn.resources.map((r) => r.name)).toContain('Mycelium_*');
    expect(dyn.resources[0].existence).toBe('unknown');
  });
});

describe('P2 — Mycelium-like SST + IAM-wildcard: 11 tables + snapshots bucket, all referenced', () => {
  // The real Mycelium declares NONE of its data plane in SST — the Mycelium_* tables
  // and mycelium-snapshots bucket exist out-of-band and are only granted by ARN, and
  // the app builds table names via `${prefix}_X`. The scan must enumerate them as
  // referenced (existence:'unknown'), never as declared.
  const sstConfig = `export default $config({ async run() {
    const REGION='us-east-1', ACCT='835745294770';
    // NOTE: the Mycelium_* tables are intentionally NOT declared as sst.aws.Dynamo here.
    const perms = [
      { actions:['dynamodb:Query'], resources:[
        \`arn:aws:dynamodb:\${REGION}:\${ACCT}:table/Mycelium_*\`,
        \`arn:aws:dynamodb:\${REGION}:\${ACCT}:table/Mycelium_*/index/*\`,
      ]},
      { actions:['s3:GetObject'], resources:['arn:aws:s3:::mycelium-snapshots','arn:aws:s3:::mycelium-snapshots/*']},
    ];
    new sst.aws.Nextjs('MyceliumWeb', { environment:{ DYNAMODB_TABLE_PREFIX:'Mycelium', S3_BUCKET:'mycelium-snapshots' } });
  }});`;
  const dynamoLib = `const prefix = process.env.DYNAMODB_TABLE_PREFIX || "Mycelium";
    const NODES=\`\${prefix}_Nodes\`, EDGES=\`\${prefix}_Edges\`, PROJ=\`\${prefix}_Projects\`,
      FILES=\`\${prefix}_Files\`, EVENTS=\`\${prefix}_Events\`, CAP=\`\${prefix}_Captures\`,
      EMB=\`\${prefix}_Embeddings\`, SET=\`\${prefix}_Settings\`, DIR=\`\${prefix}_Directory\`,
      AUTH=\`\${prefix}_Auth\`, AGENTS=\`\${process.env.DYNAMODB_TABLE_PREFIX || "Mycelium"}_Agents\`;`;
  const inv = buildInfraInventory([
    { rel: 'sst.config.ts', content: sstConfig, specifiers: [] },
    { rel: 'src/lib/dynamo.ts', content: dynamoLib, specifiers: ['@aws-sdk/client-dynamodb'] },
  ]);
  const dynamo = () => inv.services.find((s) => s.name === 'DynamoDB');
  const s3 = () => inv.services.find((s) => s.name === 'S3');

  it('enumerates ≥12 resources across DynamoDB + S3', () => {
    const total = (dynamo().resources.length) + (s3().resources.length);
    expect(total).toBeGreaterThanOrEqual(12);
    // 11 named tables (Nodes…Agents) are present
    expect(dynamo().resources.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Mycelium_Nodes', 'Mycelium_Edges', 'Mycelium_Projects', 'Mycelium_Agents']),
    );
    expect(s3().resources.map((r) => r.name)).toContain('mycelium-snapshots');
  });

  it('the ARN wildcard is ONE referenced entry (existence:unknown)', () => {
    const wc = dynamo().resources.find((r) => r.name === 'Mycelium_*');
    expect(wc).toBeTruthy();
    expect(wc.existence).toBe('unknown');
    expect(wc.declared).toBe(false);
  });

  it('a referenced-only Mycelium_Agents is existence:unknown, never declared', () => {
    const agents = dynamo().resources.find((r) => r.name === 'Mycelium_Agents');
    expect(agents).toMatchObject({ declared: false, existence: 'unknown' });
    // NONE of the data-plane resources may assert existence:'declared'
    expect(dynamo().resources.every((r) => r.existence === 'unknown')).toBe(true);
  });

  it('iacCoverage carries resource-level truth + undeclared reflects it', () => {
    expect(inv.iacCoverage.resourcesTotal).toBeGreaterThanOrEqual(12);
    expect(typeof inv.iacCoverage.resourceRatio).toBe('number');
    expect(inv.iacCoverage.resourceRatio).toBeLessThan(0.5); // data plane is undeclared
    // DynamoDB present only via IAM/name-builders → shows in the click-ops smell
    expect(inv.iacCoverage.undeclared).toEqual(expect.arrayContaining(['DynamoDB', 'S3']));
    expect(dynamo().detectedBy).toContain('iam-grant');
    expect(dynamo().detectedBy).not.toContain('iac-declared');
  });
});

describe('P2b — name-builders in REGULAR app code (codeText, content not loaded)', () => {
  // On the real repo, src/lib/*.ts data-access modules are NOT loaded as `content`
  // (they import no IaC tool), so their `${prefix}_X` table builders were invisible to
  // resource enumeration. main() now hands that raw text as `codeText`, and the miner
  // reads it too. attachResource binds ONLY to an already-detected service, so this can
  // never mint a phantom.
  it('enumerates ${prefix}_X tables from a codeText-only src/lib module', () => {
    const authLib = `const prefix = process.env.DYNAMODB_TABLE_PREFIX || "Mycelium";
      const AUTH_TABLE = \`\${prefix}_Auth\`;
      const DIRECTORY_TABLE = \`\${prefix}_Directory\`;
      import { DynamoDBAdapter } from "@auth/dynamodb-adapter";`;
    const inv = buildInfraInventory([
      // DynamoDB service comes from the SDK import (specifier); the auth adapter from a
      // specifier too. The table NAMES live only in codeText (no `content`).
      { rel: 'src/lib/auth.ts', codeText: authLib, specifiers: ['@aws-sdk/client-dynamodb', '@auth/dynamodb-adapter'] },
    ]);
    const dynamo = inv.services.find((s) => s.name === 'DynamoDB');
    expect(dynamo).toBeTruthy();
    const names = dynamo.resources.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Mycelium_Auth', 'Mycelium_Directory']));
    // referenced-only, never declared
    expect(dynamo.resources.every((r) => r.existence === 'unknown' && r.declared === false)).toBe(true);
    // A6 PII-by-name still fires off the codeText-derived resource names
    const auth = dynamo.resources.find((r) => r.name === 'Mycelium_Auth');
    expect(auth.contains_pii).toBe(true);
  });

  it('codeText name-builders NEVER mint a phantom service (no DynamoDB SDK → dropped)', () => {
    // No @aws-sdk/client-dynamodb anywhere → DynamoDB service is never detected, so the
    // mined names have nothing to attach to and must silently vanish (no phantom).
    const inv = buildInfraInventory([
      { rel: 'src/util.ts', codeText: 'const T = `${prefix}_Ghost`;', specifiers: ['react'] },
    ]);
    expect(inv.services.find((s) => s.name === 'DynamoDB')).toBeUndefined();
    expect(JSON.stringify(inv)).not.toContain('Ghost');
  });
});

describe('P2 — declared resources carry existence:declared + lift resourceRatio', () => {
  it('SST constructs enumerate one declared resource per invocation', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/storage.ts', content: 'export const t1 = new sst.aws.Dynamo("Scores");\nexport const t2 = new sst.aws.Dynamo("Users");\nexport const b = new sst.aws.Bucket("Assets");' },
    ]);
    const dynamo = inv.services.find((s) => s.name === 'DynamoDB');
    expect(dynamo.resources.map((r) => r.name).sort()).toEqual(['Scores', 'Users']);
    expect(dynamo.resources.every((r) => r.declared && r.existence === 'declared')).toBe(true);
    // 2 tables + 1 bucket, all declared → resourceRatio 1
    expect(inv.iacCoverage.resourcesTotal).toBe(3);
    expect(inv.iacCoverage.resourcesDeclared).toBe(3);
    expect(inv.iacCoverage.resourceRatio).toBe(1);
  });
});

describe('P2 — CloudFormation / SAM / serverless resource enumeration', () => {
  it('a CloudFormation Resources: map yields per-resource declared enumeration', () => {
    const cfn = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ScoresTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: Scores
  AssetsBucket:
    Type: AWS::S3::Bucket
  ApiFn:
    Type: AWS::Lambda::Function`;
    expect(parseCfnResources(cfn).map((r) => r.resourceName).sort()).toEqual(['ApiFn', 'AssetsBucket', 'ScoresTable']);
    const inv = buildInfraInventory([{ rel: 'stack.yaml', content: cfn }]);
    const dynamo = inv.services.find((s) => s.name === 'DynamoDB');
    expect(dynamo.resources).toEqual([{ name: 'ScoresTable', kind: 'database', declared: true, existence: 'declared', evidence: 'CloudFormation AWS::DynamoDB::Table' }]);
    expect(inv.services.find((s) => s.name === 'S3').resources[0].name).toBe('AssetsBucket');
    expect(inv.iacCoverage.resourceRatio).toBe(1); // all CFN-declared
  });

  it('serverless functions: + nested resources: enumerate (no false handler: capture)', () => {
    const sls = `service: api
provider:
  name: aws
functions:
  hello:
    handler: h.hello
  world:
    handler: h.world
resources:
  Resources:
    UploadsBucket:
      Type: AWS::S3::Bucket
    JobsQueue:
      Type: AWS::SQS::Queue`;
    const inv = buildInfraInventory([{ rel: 'serverless.yml', content: sls }]);
    const lambda = inv.services.find((s) => s.name === 'Lambda');
    expect(lambda.resources.map((r) => r.name).sort()).toEqual(['hello', 'world']); // not `handler`
    expect(inv.services.find((s) => s.name === 'S3').resources[0].name).toBe('UploadsBucket'); // not `Resources`
    expect(inv.services.find((s) => s.name === 'SQS').resources[0].name).toBe('JobsQueue');
  });
});

describe('P2 — region generality (AWS / GCP / Azure)', () => {
  it('pins a GCP us-central1 region', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: 'provider "google" { region = "us-central1" }\nresource "google_storage_bucket" "b" {}' }]);
    expect(inv.iacMaturity.regions).toContain('us-central1');
    expect(inv.iacMaturity.regionPinned).toBe(true);
  });

  it('captures an Azure eastus2 region and still an AWS eu-central-1', () => {
    const az = buildInfraInventory([{ rel: 'infra/main.tf', content: 'resource "azurerm_resource_group" "r" { location = "eastus2" }\nresource "azurerm_storage_account" "s" {}' }]);
    expect(az.iacMaturity.regions).toContain('eastus2');
    const aws = buildInfraInventory([{ rel: 'infra/main.tf', content: 'provider "aws" { region = "eu-central-1" }\nresource "aws_s3_bucket" "b" {}' }]);
    expect(aws.iacMaturity.regions).toContain('eu-central-1');
  });
});

describe('P2 — tag taxonomy scoped to IaC files only', () => {
  it('an app-domain tags: object earns NO cost-taxonomy credit', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'provider "aws" { default_tags { tags = { team = "core"\n environment = "prod" } } }\nresource "aws_s3_bucket" "b" {}' },
      // a blog post's tag map — must be ignored (previously false-credited via allContent)
      { rel: 'src/blog.ts', content: 'export const post = { tags: { service: "x", "cost-center": "y" } };' },
    ]);
    expect(inv.iacMaturity.tagTaxonomy.coveragePct).toBe(29);
    expect(inv.iacMaturity.tagTaxonomy.missing).toEqual(expect.arrayContaining(['service', 'cost-center']));
  });
});

describe('P2 — platform-config demoted out of the declared set', () => {
  it('iacCoverage exposes a separate platformConfigDeclared tier; CI-deploy never declares a data resource', () => {
    const inv = buildInfraInventory([
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] },
      { rel: '.github/workflows/deploy.yml', content: 'jobs:\n  deploy:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4' },
    ]);
    expect(inv.iacCoverage).toHaveProperty('platformConfigDeclared');
    // DynamoDB is provisioned nowhere in code — a CI workflow using aws-actions does
    // NOT make it "declared".
    expect(inv.iacCoverage.declared).toBe(0);
    expect(inv.iacCoverage.undeclared).toContain('DynamoDB');
  });
});

describe('A4 — orphan triage (retirement signals, never "dead")', () => {
  it('flags a service (SERVICE-level) when a SCOPE-BOUNDARY/retire comment sits near its declaration', () => {
    const tf = `
      resource "aws_dynamodb_table" "OldSessions" {
        # SCOPE-BOUNDARY: legacy table, retire after migration to Redis
        name = "OldSessions"
      }
    `;
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: tf }]);
    const dynamo = svc(inv, 'DynamoDB');
    expect(dynamo.orphanCandidate).toBe(true);
    expect(dynamo.basis).toBe('declared');
    expect(dynamo.orphanReason).toMatch(/retirement signal/);
  });

  it('flags a RESOURCE-level orphan candidate when the retirement comment sits near the specific resource name', () => {
    const sst = `
      // SCOPE-BOUNDARY: retire this table after Q3 migration
      new sst.aws.Dynamo("OldSessions", {})
    `;
    const inv = buildInfraInventory([{ rel: 'infra/db.ts', content: sst }]);
    const table = svc(inv, 'DynamoDB').resources.find((r) => r.name === 'OldSessions');
    expect(table.orphanCandidate).toBe(true);
    expect(table.basis).toBe('declared');
  });

  it('flags a service declared in IaC but never imported/used by application code', () => {
    const inv = buildInfraInventory([{ rel: 'infra/main.tf', content: 'resource "aws_s3_bucket" "b" {}' }]);
    const s3 = svc(inv, 'S3');
    expect(s3.orphanCandidate).toBe(true);
    expect(s3.orphanReason).toMatch(/no application code imports/);
  });

  it('does NOT flag a normal, actively-used, non-retired service', () => {
    const inv = buildInfraInventory([
      { rel: 'infra/main.tf', content: 'resource "aws_dynamodb_table" "Scores" {}' },
      { rel: 'src/db.ts', specifiers: ['@aws-sdk/client-dynamodb'] },
    ]);
    const dynamo = svc(inv, 'DynamoDB');
    expect(dynamo.orphanCandidate).toBeUndefined();
  });

  it('never flags the active deploy substrate (IaC tool / CDN) even with a retire word nearby', () => {
    // A SCOPE-BOUNDARY note explaining that a store is retired must NOT bleed onto
    // the SST config / CloudFront that happen to sit next to it (the Mycelium bug).
    const sst = `
      // SCOPE BOUNDARY: tables managed outside SST. Memgraph is being retired.
      new sst.aws.Nextjs("Site", {})
    `;
    const inv = buildInfraInventory([{ rel: 'sst.config.ts', content: sst }]);
    const sstSvc = svc(inv, 'SST');
    const cdn = (inv.services || []).find((s) => /cloudfront/i.test(s.name));
    expect(sstSvc?.orphanCandidate).toBeUndefined();
    expect(cdn?.orphanCandidate).toBeUndefined();
  });

  it('flags a data store named by a retirement note in a DIFFERENT file (cross-file)', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: '// MEMGRAPH_* left unset — Memgraph is being retired.\nnew sst.aws.Nextjs("Site", {})' },
      { rel: 'src/lib/memgraph.ts', specifiers: ['neo4j-driver'] },
    ]);
    const mg = (inv.services || []).find((s) => /memgraph|neo4j/i.test(s.name));
    expect(mg).toBeTruthy();
    expect(mg.kind).toBe('database');
    expect(mg.orphanCandidate).toBe(true);
    expect(mg.basis).toBe('declared');
  });
});

describe('A5 — secret-into-Lambda-env detection', () => {
  it('flags a literal secret in a shell --environment Variables={} block', () => {
    const sh = 'aws lambda update-function-configuration --function-name foo --environment Variables={DB_PASSWORD=hunter2,STAGE=prod}';
    expect(detectSecretInEnv(sh)).toContain('DB_PASSWORD');
  });

  it('does not flag a value that references a secret store / CI secret context', () => {
    const sh = 'aws lambda update-function-configuration --environment Variables={DB_PASSWORD=${SECRET_FROM_CI},STAGE=prod}';
    expect(detectSecretInEnv(sh)).toEqual([]);
  });

  it('flags a literal secret in a CI-workflow environment: block', () => {
    const yml = 'jobs:\n  deploy:\n    steps:\n      - run: deploy.sh\n        environment:\n          API_TOKEN: sk-abc123literal\n          STAGE: prod';
    expect(detectSecretInEnv(yml)).toContain('API_TOKEN');
  });

  it('does not flag a GitHub Actions ${{ secrets.* }} reference', () => {
    const yml = 'environment:\n  API_TOKEN: ${{ secrets.API_TOKEN }}';
    expect(detectSecretInEnv(yml)).toEqual([]);
  });

  it('detectDeployScript surfaces secretEnvKeys additively on shell-deploy scripts', () => {
    const ds = detectDeployScript('scripts/deploy.sh', 'aws lambda update-function-configuration --environment Variables={API_KEY=abc123}');
    expect(ds.kind).toBe('shell-deploy');
    expect(ds.secretEnvKeys).toContain('API_KEY');
  });

  it('gradeIacMaturity (via buildInfraInventory) emits an infra-security finding for the credential', () => {
    const files = [{ rel: 'scripts/deploy.sh', content: 'aws lambda update-function-configuration --function-name foo --environment Variables={DB_PASSWORD=hunter2}' }];
    const inv = buildInfraInventory(files);
    const finding = inv.iacMaturity.findings.find((f) => f.id.startsWith('iac:secret-in-lambda-env'));
    expect(finding).toBeDefined();
    expect(finding.dimension).toBe('security');
    expect(finding.severity).toBe('high');
    expect(finding.evidence.secretEnvKeys).toContain('DB_PASSWORD');
  });
});

describe('A6 — PII→store by store NAME (Auth.js adapter)', () => {
  it('flags a *_Auth-named DynamoDB table contains_pii when @auth/dynamodb-adapter is imported', () => {
    const files = [
      { rel: 'src/auth.ts', specifiers: ['@auth/dynamodb-adapter'] },
      { rel: 'infra/db.ts', content: 'new sst.aws.Dynamo("Users_Auth", {})' },
    ];
    const inv = buildInfraInventory(files);
    const table = svc(inv, 'DynamoDB').resources.find((r) => r.name === 'Users_Auth');
    expect(table.contains_pii).toBe(true);
    expect(table.piiReason).toMatch(/Auth\.js adapter/);
  });

  it('flags a *_Directory-named store too', () => {
    const files = [
      { rel: 'src/auth.ts', specifiers: ['@auth/dynamodb-adapter'] },
      { rel: 'infra/db.ts', content: 'new sst.aws.Dynamo("Members_Directory", {})' },
    ];
    const inv = buildInfraInventory(files);
    const table = svc(inv, 'DynamoDB').resources.find((r) => r.name === 'Members_Directory');
    expect(table.contains_pii).toBe(true);
  });

  it('does NOT flag PII without an Auth.js adapter present, even with a matching store name', () => {
    const inv = buildInfraInventory([{ rel: 'infra/db.ts', content: 'new sst.aws.Dynamo("Users_Auth", {})' }]);
    const table = svc(inv, 'DynamoDB').resources.find((r) => r.name === 'Users_Auth');
    expect(table.contains_pii).toBeUndefined();
  });

  it('does NOT flag a store whose name does not match *_Auth/*_Directory', () => {
    const files = [
      { rel: 'src/auth.ts', specifiers: ['@auth/dynamodb-adapter'] },
      { rel: 'infra/db.ts', content: 'new sst.aws.Dynamo("Products", {})' },
    ];
    const inv = buildInfraInventory(files);
    const table = svc(inv, 'DynamoDB').resources.find((r) => r.name === 'Products');
    expect(table.contains_pii).toBeUndefined();
  });
});

describe('B11 — moduleReadiness (downstream unlock gates)', () => {
  it('blocks finops/privacy/policy when coverage is low, PII stores exist, and no policy pack', () => {
    const inv = buildInfraInventory([
      { rel: 'sst.config.ts', content: 'new sst.aws.Nextjs("Site", {})\n// arn:aws:dynamodb:us-east-1:1:table/App_*' },
      { rel: 'src/auth.ts', specifiers: ['@auth/dynamodb-adapter', '@aws-sdk/client-dynamodb'] },
    ]);
    const mr = inv.moduleReadiness;
    expect(mr.finops.ready).toBe(false);
    expect(mr.finops.blockedBy.join(' ')).toMatch(/tags|undeclared/i);
    expect(mr.privacy.blockedBy.join(' ')).toMatch(/PII|classification/i);
    expect(mr.policyAsCode.ready).toBe(false);
    expect(mr.policyAsCode.basis).toBe('declared');
  });
});
