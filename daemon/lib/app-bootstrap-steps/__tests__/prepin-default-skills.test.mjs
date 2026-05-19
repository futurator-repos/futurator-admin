/**
 * prepin-default-skills.test.mjs — Pipeline v2 Phase 3-C Epic 2 (Story 2.2,
 * 2026-05-19).
 *
 * Hermetic Vitest run against the prepin step. Each test sets up a tmp
 * worktree dir, writes the empty manifest scaffold (mirroring what
 * apply-starter-augments produces in production), then asserts the
 * step's behavior on disk + return shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { runPrepinDefaultSkills } from '../prepin-default-skills.mjs';

const EMPTY_MANIFEST = `# Project skill manifest scaffold
project: my-app
manifest-version: 1
generated-by: bootstrap@v2.5
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`;

const MANIFEST_REL = '.claude/skills.manifest.yaml';

describe('runPrepinDefaultSkills', () => {
  let workingDir;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'prepin-test-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function writeManifest(content) {
    mkdirSync(join(workingDir, '.claude'), { recursive: true });
    writeFileSync(join(workingDir, MANIFEST_REL), content, 'utf-8');
  }

  function readManifest() {
    return parseYaml(readFileSync(join(workingDir, MANIFEST_REL), 'utf-8'));
  }

  it('pins a multi-skill loadout into core[] on empty manifest', async () => {
    writeManifest(EMPTY_MANIFEST);

    const result = await runPrepinDefaultSkills({
      workingDir: workingDir,
      worktreeDir: workingDir,
      defaultSkillLoadout: [
        'canvas-design@anthropic-official',
        'frontend-design@anthropic-official',
      ],
    });

    expect(result.skipped).toBe(false);
    expect(result.pinnedCount).toBe(2);
    expect(result.pinned).toEqual([
      { skill: 'canvas-design', source: 'anthropic-official' },
      { skill: 'frontend-design', source: 'anthropic-official' },
    ]);

    const m = readManifest();
    expect(m.core).toHaveLength(2);
    expect(m.core[0]).toEqual({
      source: 'anthropic-official',
      skill: 'canvas-design',
      version: 'sha:HEAD',
    });
    expect(m.core[1].skill).toBe('frontend-design');
    // stack/domain/vendor stay empty — that's SKILL-SCOUT's territory.
    expect(m.stack).toEqual([]);
    expect(m.domain).toEqual([]);
    expect(m.vendor).toEqual([]);
    // Provenance stamp lets forensic readers tell prepin apart from SKILL-SCOUT.
    expect(m['generated-by']).toBe('prepin-default-skills@v1');
  });

  it('preserves project + manifest-version + plans + gaps fields', async () => {
    writeManifest(EMPTY_MANIFEST);

    await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: ['frontend-design@anthropic-official'],
    });

    const m = readManifest();
    expect(m.project).toBe('my-app');
    expect(m['manifest-version']).toBe(1);
    expect(m.plans).toEqual({});
    expect(m.gaps).toEqual([]);
  });

  it('is idempotent — skips when manifest already has skills in core[]', async () => {
    writeManifest(`project: my-app
manifest-version: 1
core:
  - source: anthropic-official
    skill: pre-existing
    version: sha:abc123
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`);

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: ['frontend-design@anthropic-official'],
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('manifest-non-empty');
    expect(result.pinnedCount).toBe(0);

    // Original entry untouched.
    const m = readManifest();
    expect(m.core).toHaveLength(1);
    expect(m.core[0].skill).toBe('pre-existing');
  });

  it('is idempotent — skips when manifest has skills in any other bucket', async () => {
    writeManifest(`project: my-app
manifest-version: 1
core: []
stack:
  - source: vercel-web
    skill: next-best-practices
    version: tag:v1.0.0
domain: []
vendor: []
plans: {}
gaps: []
`);

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: ['frontend-design@anthropic-official'],
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('manifest-non-empty');
  });

  it('skips with no-default-loadout when defaultSkillLoadout is null', async () => {
    writeManifest(EMPTY_MANIFEST);

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: null,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-default-loadout');
  });

  it('skips with no-default-loadout when defaultSkillLoadout is undefined', async () => {
    writeManifest(EMPTY_MANIFEST);

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: undefined,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-default-loadout');
  });

  it('skips with no-default-loadout when defaultSkillLoadout is empty array', async () => {
    writeManifest(EMPTY_MANIFEST);

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: [],
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-default-loadout');
  });

  it('skips with manifest-missing when scaffold file is absent', async () => {
    // No writeManifest call → .claude/skills.manifest.yaml does not exist.

    const result = await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: ['frontend-design@anthropic-official'],
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('manifest-missing');
    expect(existsSync(join(workingDir, MANIFEST_REL))).toBe(false);
  });

  it('throws on malformed loadout token (missing @)', async () => {
    writeManifest(EMPTY_MANIFEST);

    await expect(
      runPrepinDefaultSkills({
        worktreeDir: workingDir,
        defaultSkillLoadout: ['canvas-design'],
      }),
    ).rejects.toThrow(/invalid loadout token "canvas-design"/);
  });

  it('throws on malformed loadout token (empty source)', async () => {
    writeManifest(EMPTY_MANIFEST);

    await expect(
      runPrepinDefaultSkills({
        worktreeDir: workingDir,
        defaultSkillLoadout: ['canvas-design@'],
      }),
    ).rejects.toThrow(/invalid loadout token "canvas-design@"/);
  });

  it('throws on malformed loadout token (uppercase / illegal char)', async () => {
    writeManifest(EMPTY_MANIFEST);

    await expect(
      runPrepinDefaultSkills({
        worktreeDir: workingDir,
        defaultSkillLoadout: ['CanvasDesign@anthropic-official'],
      }),
    ).rejects.toThrow(/must match/);
  });

  it('throws on missing worktreeDir', async () => {
    await expect(
      runPrepinDefaultSkills({
        defaultSkillLoadout: ['frontend-design@anthropic-official'],
      }),
    ).rejects.toThrow(/worktreeDir required/);
  });

  it('throws on malformed manifest YAML', async () => {
    writeManifest(': : : not valid yaml ::: !!!\n  - [');

    await expect(
      runPrepinDefaultSkills({
        worktreeDir: workingDir,
        defaultSkillLoadout: ['frontend-design@anthropic-official'],
      }),
    ).rejects.toThrow(/manifest parse failed/);
  });

  it('throws on manifest that parses to non-object', async () => {
    writeManifest('"just a string"');

    await expect(
      runPrepinDefaultSkills({
        worktreeDir: workingDir,
        defaultSkillLoadout: ['frontend-design@anthropic-official'],
      }),
    ).rejects.toThrow(/manifest is not an object/);
  });

  it('writes valid YAML that round-trips through parseYaml', async () => {
    writeManifest(EMPTY_MANIFEST);

    await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: [
        'canvas-design@anthropic-official',
        'frontend-design@anthropic-official',
        'algorithmic-art@anthropic-official',
      ],
    });

    // Re-parse + re-assert. Confirms YAML serialization is valid + complete.
    const reparsed = readManifest();
    expect(Array.isArray(reparsed.core)).toBe(true);
    expect(reparsed.core).toHaveLength(3);
    expect(reparsed.core.map((e) => e.skill)).toEqual([
      'canvas-design',
      'frontend-design',
      'algorithmic-art',
    ]);
  });

  it('calls onOutput with a log line on the happy path', async () => {
    writeManifest(EMPTY_MANIFEST);
    const outputs = [];

    await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: ['frontend-design@anthropic-official'],
      onOutput: (msg) => outputs.push(msg),
    });

    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.some((m) => m.includes('pinned 1 skill'))).toBe(true);
  });

  it('calls onOutput with a skip line when no loadout declared', async () => {
    writeManifest(EMPTY_MANIFEST);
    const outputs = [];

    await runPrepinDefaultSkills({
      worktreeDir: workingDir,
      defaultSkillLoadout: null,
      onOutput: (msg) => outputs.push(msg),
    });

    expect(outputs.some((m) => m.includes('no default loadout'))).toBe(true);
  });
});
