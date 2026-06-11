/**
 * gate-registry-snapshot.test.ts — v2.6 wave-gate VQA (M2, 2026-06-11).
 *
 * Parity guard for `daemon/lib/boilerplate-gate-registry.json` — the
 * committed snapshot the daemon's wave-gate reads (postMergeValidationCmd,
 * qaContext, qualityGate). The daemon imported a snapshot module that was
 * NEVER generated for three weeks; the lesson is "a designed seam needs a
 * drift alarm". This test IS the alarm: edit the registry without running
 *   npx tsx scripts/generate-gate-registry-snapshot.mjs
 * and it fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOILERPLATE_REGISTRY } from '../registry';

const SNAPSHOT_PATH = join(__dirname, '../../../../daemon/lib/boilerplate-gate-registry.json');

// Mirror of buildGateRegistrySnapshot in scripts/generate-gate-registry-snapshot.mjs.
function expectedSnapshot() {
  const out: Record<string, unknown> = {};
  for (const [type, meta] of Object.entries(BOILERPLATE_REGISTRY)) {
    out[type] = {
      postMergeValidationCmd: meta.postMergeValidationCmd ?? null,
      qaContext: meta.qaContext ?? null,
      qualityGate: meta.qualityGate ?? null,
    };
  }
  return out;
}

describe('daemon gate-registry snapshot — drift alarm', () => {
  it('matches the TS registry (regenerate via scripts/generate-gate-registry-snapshot.mjs)', () => {
    const onDisk = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    expect(onDisk).toEqual(expectedSnapshot());
  });

  it('covers every boilerplate type', () => {
    const onDisk = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(Object.keys(BOILERPLATE_REGISTRY).sort());
  });
});
