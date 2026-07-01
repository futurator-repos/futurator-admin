/**
 * infra-extract.test.mjs — provider-agnostic, FILE-FIRST infra detection.
 * Covers the operator's scenarios: GCP, Azure, Hostinger email, Supabase, Steam —
 * none AWS — plus IaC-file parsing (the authoritative signal) and the
 * confidence/signal-quality model (codebases express infra differently).
 */

import { describe, it, expect } from 'vitest';
import { buildInfraInventory, parseConfig, detectCloudSdk, configFileType, classifyConfigByContent, extractIacResources, enrichInfraWithGraph, detectDeployScript } from '../infra-extract.mjs';

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
