/**
 * skill-installer.test.mjs — Pipeline v2 Phase 3-C Epic 3 (Story 3.2,
 * 2026-05-20).
 *
 * Hermetic tests: write a manifest to a tmp dir, apply proposals, verify
 * on-disk YAML round-trips correctly, idempotency holds, and runVendor
 * is invoked with the right args. runVendor is injected so we never
 * spawn a real `node scripts/skills-sync.mjs`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { applyConfirmedProposals } from '../skill-installer.mjs';

const EMPTY_MANIFEST = `project: my-app
manifest-version: 1
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`;

const PREPINNED_MANIFEST = `project: my-app
manifest-version: 1
core:
  - source: anthropic-official
    skill: canvas-design
    version: sha:HEAD
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`;

function makeProposal(over = {}) {
  return {
    kind: 'add',
    source: 'anthropic-official',
    skill: 'frontend-design',
    manifestBucket: 'core',
    version: 'tag:v1.0.0',
    rationale: 'r',
    verifyNotes: 'v',
    confidence: 0.95,
    ...over,
  };
}

describe('applyConfirmedProposals', () => {
  let projectPath;
  let vendorCalls;
  let runVendor;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'installer-test-'));
    mkdirSync(join(projectPath, '.claude'), { recursive: true });
    vendorCalls = [];
    runVendor = async (args) => {
      vendorCalls.push(args);
      return { vendoredCount: 1, drift: 0 };
    };
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  function writeManifest(content) {
    writeFileSync(join(projectPath, '.claude/skills.manifest.yaml'), content, 'utf-8');
  }

  function readManifest() {
    return parseYaml(readFileSync(join(projectPath, '.claude/skills.manifest.yaml'), 'utf-8'));
  }

  // ── Happy path: add ──

  it('adds a new skill to empty bucket', async () => {
    writeManifest(EMPTY_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: { trigger: 'T1', projectSlug: 'my-app', proposals: [makeProposal()] },
      source: 'auto-confirm',
      runVendor,
    });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(1);
    expect(r.added).toBe(1);

    const m = readManifest();
    expect(m.core).toHaveLength(1);
    // Step-0.9c — the scout's rationale is persisted into the manifest
    // entry (skills-prompt.mjs surfaces it to agents as the task-shaped
    // description; the upstream SKILL.md description never matched
    // machine prompts → 0 activations ever).
    expect(m.core[0]).toEqual({
      source: 'anthropic-official',
      skill: 'frontend-design',
      version: 'tag:v1.0.0',
      rationale: 'r',
    });
    expect(m['last-modified-by']).toMatch(/skill-scout-auto-confirm@/);
    expect(vendorCalls).toHaveLength(1);
    expect(vendorCalls[0].worktreeDir).toBe(projectPath);
  });

  // ── Idempotency ──

  it('is idempotent — second apply writes 0', async () => {
    writeManifest(EMPTY_MANIFEST);
    const args = {
      projectPath,
      projectSlug: 'my-app',
      output: { trigger: 'T1', projectSlug: 'my-app', proposals: [makeProposal()] },
      source: 'auto-confirm',
      runVendor,
    };
    await applyConfirmedProposals(args);
    const r2 = await applyConfirmedProposals(args);
    expect(r2.written).toBe(0);
    expect(r2.added).toBe(0);
    expect(readManifest().core).toHaveLength(1); // not duplicated
    // Vendor still runs even with written=0 (operator may have triggered
    // a forced resync).
    expect(vendorCalls).toHaveLength(2);
  });

  // ── Upgrade ──

  it('upgrades an existing entry version', async () => {
    writeManifest(PREPINNED_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T8',
        projectSlug: 'my-app',
        proposals: [makeProposal({
          kind: 'upgrade',
          skill: 'canvas-design',
          version: 'tag:v2.0.0',
        })],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(1);
    expect(r.upgraded).toBe(1);
    expect(readManifest().core[0].version).toBe('tag:v2.0.0');
  });

  it('upgrade-as-add when the target entry is absent (degraded path)', async () => {
    writeManifest(EMPTY_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T2',
        projectSlug: 'my-app',
        proposals: [makeProposal({ kind: 'upgrade' })],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(1);
    expect(r.added).toBe(1);
    expect(r.upgraded).toBe(0);
    expect(readManifest().core).toHaveLength(1);
  });

  // ── Remove ──

  it('removes an existing entry', async () => {
    writeManifest(PREPINNED_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T2',
        projectSlug: 'my-app',
        proposals: [makeProposal({ kind: 'remove', skill: 'canvas-design' })],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(1);
    expect(r.removed).toBe(1);
    expect(readManifest().core).toHaveLength(0);
  });

  it('remove on absent entry is a no-op', async () => {
    writeManifest(EMPTY_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T2',
        projectSlug: 'my-app',
        proposals: [makeProposal({ kind: 'remove' })],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(0);
    expect(r.removed).toBe(0);
  });

  // ── Vendor failure surfaces but doesn't fail the install ──

  it('passes vendor attention through without failing the install', async () => {
    writeManifest(EMPTY_MANIFEST);
    runVendor = async () => ({
      vendoredCount: 0,
      drift: 0,
      attentionCategory: 'skill-sync-failed',
      attentionSeverity: 'medium',
    });
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: { trigger: 'T1', projectSlug: 'my-app', proposals: [makeProposal()] },
      source: 'auto-confirm',
      runVendor,
    });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(1); // install committed despite vendor fail
    expect(r.vendorAttention).toEqual({
      category: 'skill-sync-failed',
      severity: 'medium',
    });
  });

  // ── Multiple proposals in a single output ──

  it('processes a mixed batch (add + upgrade + remove)', async () => {
    writeManifest(`project: my-app
manifest-version: 1
core:
  - source: anthropic-official
    skill: keep-me
    version: tag:v1.0.0
  - source: anthropic-official
    skill: upgrade-me
    version: tag:v1.0.0
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T8',
        projectSlug: 'my-app',
        proposals: [
          makeProposal({ kind: 'add', skill: 'newcomer' }),
          makeProposal({ kind: 'upgrade', skill: 'upgrade-me', version: 'tag:v2.0.0' }),
          makeProposal({ kind: 'remove', skill: 'keep-me' }),
        ],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(3);
    expect(r.added).toBe(1);
    expect(r.upgraded).toBe(1);
    expect(r.removed).toBe(1);
    const m = readManifest();
    expect(m.core).toHaveLength(2); // keep-me removed, upgrade-me + newcomer
    expect(m.core.map((e) => e.skill).sort()).toEqual(['newcomer', 'upgrade-me']);
    expect(m.core.find((e) => e.skill === 'upgrade-me').version).toBe('tag:v2.0.0');
  });

  // ── Multiple buckets ──

  it('writes into stack and vendor buckets, not just core', async () => {
    writeManifest(EMPTY_MANIFEST);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T2',
        projectSlug: 'my-app',
        proposals: [
          makeProposal({ skill: 'react-best-practices', manifestBucket: 'stack' }),
          makeProposal({ skill: 'stripe-checkout', source: 'stripe-official', manifestBucket: 'vendor' }),
        ],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(2);
    const m = readManifest();
    expect(m.stack).toHaveLength(1);
    expect(m.vendor).toHaveLength(1);
    expect(m.core).toHaveLength(0);
  });

  it('initializes a bucket as [] if absent in the source manifest', async () => {
    // Old manifest predating PR-71's scaffold may not have all 4 buckets.
    writeManifest(`project: my-app
manifest-version: 1
core: []
plans: {}
gaps: []
`);
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: {
        trigger: 'T2',
        projectSlug: 'my-app',
        proposals: [makeProposal({ manifestBucket: 'domain' })],
      },
      source: 'operator-confirm',
      runVendor,
    });
    expect(r.written).toBe(1);
    expect(readManifest().domain).toHaveLength(1);
  });

  // ── Empty input ──

  it('short-circuits on empty proposals — no manifest write, no vendor run', async () => {
    writeManifest(EMPTY_MANIFEST);
    const before = readFileSync(join(projectPath, '.claude/skills.manifest.yaml'), 'utf-8');
    const r = await applyConfirmedProposals({
      projectPath,
      projectSlug: 'my-app',
      output: { trigger: 'T1', projectSlug: 'my-app', proposals: [] },
      source: 'auto-confirm',
      runVendor,
    });
    expect(r.written).toBe(0);
    const after = readFileSync(join(projectPath, '.claude/skills.manifest.yaml'), 'utf-8');
    expect(after).toBe(before); // byte-identical
    expect(vendorCalls).toHaveLength(0); // no vendor run either
  });

  // ── Error paths ──

  it('throws when manifest is missing', async () => {
    // No writeManifest call.
    await expect(
      applyConfirmedProposals({
        projectPath,
        projectSlug: 'my-app',
        output: { trigger: 'T1', projectSlug: 'my-app', proposals: [makeProposal()] },
        source: 'auto-confirm',
        runVendor,
      }),
    ).rejects.toThrow(/manifest missing/);
  });

  it('throws when source is invalid', async () => {
    writeManifest(EMPTY_MANIFEST);
    await expect(
      applyConfirmedProposals({
        projectPath,
        projectSlug: 'my-app',
        output: { trigger: 'T1', projectSlug: 'my-app', proposals: [] },
        source: 'rogue',
        runVendor,
      }),
    ).rejects.toThrow(/source must be auto-confirm/);
  });

  it('throws when output.proposals is missing', async () => {
    writeManifest(EMPTY_MANIFEST);
    await expect(
      applyConfirmedProposals({
        projectPath,
        projectSlug: 'my-app',
        output: { trigger: 'T1', projectSlug: 'my-app' },
        source: 'auto-confirm',
        runVendor,
      }),
    ).rejects.toThrow(/output.proposals/);
  });

  it('throws when manifest is malformed YAML', async () => {
    writeManifest(': : : invalid : ::!!!\n');
    await expect(
      applyConfirmedProposals({
        projectPath,
        projectSlug: 'my-app',
        output: { trigger: 'T1', projectSlug: 'my-app', proposals: [makeProposal()] },
        source: 'auto-confirm',
        runVendor,
      }),
    ).rejects.toThrow(/manifest parse failed/);
  });
});
