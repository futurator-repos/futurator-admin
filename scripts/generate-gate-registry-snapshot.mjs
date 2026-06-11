#!/usr/bin/env npx tsx
/**
 * generate-gate-registry-snapshot.mjs — v2.6 wave-gate VQA (M2, 2026-06-11).
 *
 * THE SEAM THIS CLOSES: daemon/agent-daemon.mjs has imported
 * `../sst-env-shared/boilerplate-registry-snapshot.mjs` since 2026-05-19 —
 * a file that was NEVER generated, so the catch-fallback (a hardcoded
 * validation command) is what actually ran for every wave gate. Classic
 * "validated ≠ shipped": the design said "registry is the source of truth",
 * the runtime said "hardcoded string".
 *
 * This script serializes the GATE-RELEVANT subset of the TS boilerplate
 * registry to `daemon/lib/boilerplate-gate-registry.json`, which is
 * committed and ships with every daemon rsync. The subset is deliberately
 * lean (no augment file bodies — those flow through the bootstrap payload)
 * so the snapshot can't become a stale second copy of things the daemon
 * gets elsewhere.
 *
 * Run:    npx tsx scripts/generate-gate-registry-snapshot.mjs
 * Guard:  functions/shared/boilerplates/__tests__/gate-registry-snapshot.test.ts
 *         fails when the registry changes without regenerating.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { BOILERPLATE_REGISTRY } = await import(
  join(root, 'functions/shared/boilerplates/registry.ts')
);

/** Gate-relevant subset per boilerplate type. Keep in sync with the parity test. */
export function buildGateRegistrySnapshot(registry) {
  const out = {};
  for (const [type, meta] of Object.entries(registry)) {
    out[type] = {
      postMergeValidationCmd: meta.postMergeValidationCmd ?? null,
      qaContext: meta.qaContext ?? null,
      qualityGate: meta.qualityGate ?? null,
    };
  }
  return out;
}

const snapshot = buildGateRegistrySnapshot(BOILERPLATE_REGISTRY);
const target = join(root, 'daemon/lib/boilerplate-gate-registry.json');
writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(
  `[gate-registry-snapshot] wrote ${target} (${Object.keys(snapshot).length} boilerplate types)`,
);
