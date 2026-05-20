/**
 * skill-installer.mjs — Pipeline v2 Phase 3-C Epic 3 (Story 3.2,
 * 2026-05-20).
 *
 * Applies a SKILL-SCOUT-confirmed `SkillScoutOutput` to the project's
 * `.claude/skills.manifest.yaml`. Three proposal kinds (per v2.5 §38):
 *
 *   - 'add'     append to manifest[bucket] if (skill, source) not already present
 *   - 'upgrade' bump the version on a matching (skill, source) entry; if absent,
 *               treated as 'add' (degraded — log + continue)
 *   - 'remove'  drop a matching entry from manifest[bucket]
 *
 * After writing the manifest, re-run `vendor-skills` (the Epic 2 step)
 * so the new SKILL.md bodies materialize on disk BEFORE the next
 * `claude -p` invocation auto-discovers them. Vendor-skills failures
 * are NOT fatal here — the manifest write committed, the operator can
 * re-run sync via `node scripts/skills-sync.mjs --resync`.
 *
 * Idempotency: applying the same proposal set twice → second call
 * writes 0 (matching entries skipped). Safe to re-invoke from the
 * daemon's retry ladder.
 *
 * Used by:
 *   - Story 3.1's runSkillScoutJob (auto-confirm path)
 *   - Story 3.6's runSkillInstallJob (operator-confirm path)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

import { runVendorSkills } from '../lib/app-bootstrap-steps/vendor-skills.mjs';

const MANIFEST_REL = '.claude/skills.manifest.yaml';
const VALID_BUCKETS = ['core', 'stack', 'domain', 'vendor'];

/**
 * Apply a confirmed SKILL-SCOUT output to the manifest + re-run vendor.
 *

 * @param {{
 *   projectPath: string,
 *   output: {
 *     trigger: string,
 *     projectSlug: string,
 *     proposals: Array<{
 *       kind: 'add' | 'remove' | 'upgrade',
 *       source: string,
 *       skill: string,
 *       manifestBucket: 'core' | 'stack' | 'domain' | 'vendor',
 *       version: string,
 *       rationale?: string,
 *       verifyNotes?: string,
 *       confidence?: number,
 *     }>,
 *   },
 *   source: 'auto-confirm' | 'operator-confirm',
 *   runVendor?: typeof runVendorSkills,
 * }} args
 * @returns {Promise<{
 *   ok: boolean,
 *   written: number,
 *   added: number,
 *   upgraded: number,
 *   removed: number,
 *   vendoredCount: number,
 *   drift?: number,
 *   vendorAttention?: { category: string, severity: string },
 * }>}
 */
export async function applyConfirmedProposals({
  projectPath,
  output,
  source,
  runVendor = runVendorSkills,
}) {
  if (!projectPath) throw new Error('applyConfirmedProposals: projectPath required');
  if (!output || !Array.isArray(output.proposals)) {
    throw new Error('applyConfirmedProposals: output.proposals[] required');
  }
  if (source !== 'auto-confirm' && source !== 'operator-confirm') {
    throw new Error(
      `applyConfirmedProposals: source must be auto-confirm | operator-confirm (got ${source})`,
    );
  }

  const manifestPath = join(projectPath, MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    throw new Error(`applyConfirmedProposals: manifest missing at ${MANIFEST_REL}`);
  }

  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    throw new Error(`applyConfirmedProposals: manifest parse failed: ${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('applyConfirmedProposals: manifest is not an object');
  }

  // Ensure every bucket exists as an array so blind .push() doesn't NPE
  // on a manifest where SKILL-SCOUT proposes into a bucket that
  // prepin-default-skills hasn't touched.
  for (const b of VALID_BUCKETS) {
    if (!Array.isArray(manifest[b])) manifest[b] = [];
  }

  let added = 0;
  let upgraded = 0;
  let removed = 0;

  // Short-circuit on empty proposals — no manifest write, no vendor run.
  if (output.proposals.length === 0) {
    return {
      ok: true, written: 0, added, upgraded, removed,
      vendoredCount: 0,
    };
  }

  for (const p of output.proposals) {
    if (!VALID_BUCKETS.includes(p.manifestBucket)) {
      // Shape validator should have caught this; guard defensively.
      continue;
    }
    const bucket = manifest[p.manifestBucket];

    if (p.kind === 'add') {
      const exists = bucket.some(
        (e) => e?.skill === p.skill && e?.source === p.source,
      );
      if (!exists) {
        bucket.push({ source: p.source, skill: p.skill, version: p.version });
        added += 1;
      }
      continue;
    }

    if (p.kind === 'upgrade') {
      const entry = bucket.find(
        (e) => e?.skill === p.skill && e?.source === p.source,
      );
      if (entry) {
        if (entry.version !== p.version) {
          entry.version = p.version;
          upgraded += 1;
        }
      } else {
        // Degraded path: nothing to upgrade. Treat as add so the
        // intended end-state is reached.
        bucket.push({ source: p.source, skill: p.skill, version: p.version });
        added += 1;
      }
      continue;
    }

    if (p.kind === 'remove') {
      const idx = bucket.findIndex(
        (e) => e?.skill === p.skill && e?.source === p.source,
      );
      if (idx >= 0) {
        bucket.splice(idx, 1);
        removed += 1;
      }
      continue;
    }
  }

  const written = added + upgraded + removed;
  if (written === 0) {
    // All proposals were no-ops (already in desired state). Don't
    // re-write the file just to bump mtime, but DO run vendor-skills
    // — operator may have triggered "confirm" precisely to force a
    // re-sync after a manual edit.
    const vendorNoOp = await runVendor({
      worktreeDir: projectPath,
      skip: false,
    });
    return {
      ok: true, written: 0, added, upgraded, removed,
      vendoredCount: vendorNoOp.vendoredCount ?? 0,
      drift: vendorNoOp.drift,
      ...(vendorNoOp.attentionCategory
        ? {
            vendorAttention: {
              category: vendorNoOp.attentionCategory,
              severity: vendorNoOp.attentionSeverity ?? 'low',
            },
          }
        : {}),
    };
  }

  // Stamp provenance so forensic queries can tell installs apart.
  manifest['last-modified-by'] =
    `skill-scout-${source}@${new Date().toISOString()}`;

  writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');

  // Re-vendor so new SKILL.md bodies land on disk. Same non-blocking
  // contract as Story 2.3's bootstrap-time vendor step.
  const vendorResult = await runVendor({
    worktreeDir: projectPath,
    skip: false,
  });

  return {
    ok: true,
    written,
    added,
    upgraded,
    removed,
    vendoredCount: vendorResult.vendoredCount ?? 0,
    drift: vendorResult.drift,
    ...(vendorResult.attentionCategory
      ? {
          vendorAttention: {
            category: vendorResult.attentionCategory,
            severity: vendorResult.attentionSeverity ?? 'medium',
          },
        }
      : {}),
  };
}
