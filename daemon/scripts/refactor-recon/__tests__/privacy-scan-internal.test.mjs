/**
 * privacy-scan-internal.test.mjs — runs the REAL internal scanner as a child
 * process against a synthetic repo and asserts on the emitted report:
 *   1. emits the report shape summarizePrivacyReport() consumes
 *      (scanner:'internal', by_regulation grouped by family)
 *   2. residency-aware AI findings (Claude API → external transfer + AI Act)
 *   3. db client → GDPR Art. 32 Personal Data Store
 *   4. IaC file → Infrastructure & Data Residency
 *   5. analytics import → 3rd-party Tracking — Consent
 *   6. PII-in-logs line scan fires
 *   7. test / d.ts / docs noise is skipped (the external scanner's FP source)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, '..', 'privacy-scan-internal.mjs');

let dir;
let report;

function write(rel, code) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, code);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-scan-'));
  // AI: Claude API (external) — should produce AI Act + cross-border transfer
  write('src/ai/claude.ts', `import Anthropic from '@anthropic-ai/sdk';\nexport const c = new Anthropic();\n`);
  // db: DynamoDB (in-account)
  write('src/db/users.ts', `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';\nexport const db = new DynamoDBClient({});\n`);
  // 3rd-party analytics → consent finding
  write('src/analytics.ts', `import posthog from 'posthog-js';\nposthog.init('x');\n`);
  // PII in logs
  write('src/log.ts', `export function f(email: string){ console.log('user', email); }\n`);
  // IaC file → infra
  write('infra/main.tf', `resource "aws_dynamodb_table" "users" {}\n`);
  // NOISE that must be skipped:
  write('src/ai/claude.test.ts', `import Anthropic from '@anthropic-ai/sdk';\n`);
  write('src/types.d.ts', `import type x from 'openai';\n`);
  write('docs/example.ts', `import Stripe from 'stripe';\n`);

  const outPath = path.join(dir, 'privacy.json');
  execFileSync('node', [SCAN, dir, '--src', 'src', '--out', outPath], { encoding: 'utf8' });
  report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const allFindings = () =>
  Object.values(report.by_regulation).flatMap((r) => r.hotspots);
const categories = () => new Set(allFindings().map((f) => f.category));

describe('report shape', () => {
  it('is the internal scanner contract', () => {
    expect(report.scanner).toBe('internal');
    expect(report.tier).toBe('internal');
    expect(report.rulepack_source).toBe('internal:privacy-detectors.mjs');
    expect(Array.isArray(report.regulations)).toBe(true);
  });

  it('groups into gdpr + eu-ai-act families', () => {
    expect(report.regulations).toContain('gdpr');
    expect(report.regulations).toContain('eu-ai-act');
    for (const reg of report.regulations) {
      const slice = report.by_regulation[reg];
      expect(slice.summary.total).toBe(slice.hotspots.length);
    }
  });
});

describe('detections', () => {
  it('Claude API → AI System In Use + cross-border transfer', () => {
    const cats = categories();
    expect(cats.has('AI System In Use')).toBe(true);
    expect(cats.has('Cross-border AI Data Transfer')).toBe(true);
  });

  it('DynamoDB → Personal Data Store', () => {
    expect(categories().has('Personal Data Store')).toBe(true);
  });

  it('IaC → Infrastructure & Data Residency', () => {
    expect(categories().has('Infrastructure & Data Residency')).toBe(true);
  });

  it('analytics → 3rd-party Tracking — Consent', () => {
    expect(categories().has('3rd-party Tracking — Consent')).toBe(true);
  });

  it('PII-in-logs fires', () => {
    expect(categories().has('PII in Logs')).toBe(true);
  });
});

describe('noise suppression', () => {
  it('skips .test.ts / .d.ts / docs (no findings reference them)', () => {
    const files = allFindings().map((f) => f.file);
    expect(files.some((f) => /\.test\.ts$/.test(f))).toBe(false);
    expect(files.some((f) => /\.d\.ts$/.test(f))).toBe(false);
    expect(files.some((f) => /(^|\/)docs\//.test(f))).toBe(false);
  });
});
