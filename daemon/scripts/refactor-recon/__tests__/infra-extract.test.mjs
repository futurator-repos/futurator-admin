/**
 * infra-extract.test.mjs — provider-agnostic, FILE-FIRST infra detection.
 * Covers the operator's scenarios: GCP, Azure, Hostinger email, Supabase, Steam —
 * none AWS — plus IaC-file parsing (the authoritative signal) and the
 * confidence/signal-quality model (codebases express infra differently).
 */

import { describe, it, expect } from 'vitest';
import { buildInfraInventory, parseConfig, detectCloudSdk, configFileType } from '../infra-extract.mjs';

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
