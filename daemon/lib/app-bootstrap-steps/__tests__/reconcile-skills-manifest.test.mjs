/**
 * reconcile-skills-manifest.test.mjs — Skills Management Phase 0, Story 0.3/0.4
 * (2026-06-13).
 *
 * Hermetic Vitest run. Sets up a tmp worktree with a manifest scaffold + a
 * `.claude/skills/` dir mirroring production (3 prepin-pinned anthropic skills
 * already in core[], 56 unmanaged bmad skills on disk) and asserts the step
 * reconciles to on-disk == manifest parity (Story 0.4) while preserving
 * existing entries and staying idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  runReconcileSkillsManifest,
  listOnDiskSkills,
  pinnedSkillNames,
} from '../reconcile-skills-manifest.mjs';

let wt;

function writeManifest(obj) {
  const dir = join(wt, '.claude');
  mkdirSync(dir, { recursive: true });
  // write minimal YAML by hand-ish via JSON->yaml is overkill; use a tiny serializer
  const lines = [`project: ${obj.project}`, 'manifest-version: 1'];
  if (obj['generated-by']) lines.push(`generated-by: ${obj['generated-by']}`);
  for (const b of ['core', 'stack', 'domain', 'vendor']) {
    const arr = obj[b] || [];
    if (arr.length === 0) {
      lines.push(`${b}: []`);
    } else {
      lines.push(`${b}:`);
      for (const e of arr) lines.push(`  - source: ${e.source}\n    skill: ${e.skill}\n    version: ${e.version}`);
    }
  }
  lines.push('plans: {}', 'gaps: []');
  writeFileSync(join(wt, '.claude', 'skills.manifest.yaml'), lines.join('\n') + '\n');
}

function makeSkillDirs(names) {
  for (const n of names) {
    const d = join(wt, '.claude', 'skills', n);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n} desc\n---\nbody`);
  }
}

beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), 'reconcile-skills-'));
});
afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

describe('listOnDiskSkills / pinnedSkillNames', () => {
  it('lists only dirs with SKILL.md, sorted', () => {
    writeManifest({ project: 'p', core: [] });
    makeSkillDirs(['zeta', 'alpha']);
    mkdirSync(join(wt, '.claude', 'skills', 'no-skill-md'), { recursive: true });
    expect(listOnDiskSkills(wt)).toEqual(['alpha', 'zeta']);
  });
  it('collects pinned names across buckets', () => {
    const m = { core: [{ skill: 'a' }], vendor: [{ skill: 'b' }], stack: [], domain: [] };
    expect([...pinnedSkillNames(m)].sort()).toEqual(['a', 'b']);
  });
});

describe('runReconcileSkillsManifest', () => {
  it('pins unmanaged on-disk skills, preserves existing, reaches parity (0.4)', async () => {
    // production-shaped: 3 anthropic already pinned, 56 bmad unmanaged on disk
    const anthropic = ['canvas-design', 'frontend-design', 'algorithmic-art'];
    const bmad = Array.from({ length: 56 }, (_, i) => `bmad-skill-${String(i).padStart(2, '0')}`);
    writeManifest({
      project: 'pacman1',
      'generated-by': 'prepin-default-skills@v1',
      core: anthropic.map((s) => ({ source: 'anthropic-official', skill: s, version: 'sha:HEAD' })),
    });
    makeSkillDirs([...anthropic, ...bmad]); // all 59 on disk

    const res = await runReconcileSkillsManifest({ worktreeDir: wt, onOutput: () => {} });

    expect(res.skipped).toBe(false);
    expect(res.reconciledCount).toBe(56);
    expect(res.onDiskCount).toBe(59);
    expect(res.manifestCount).toBe(59); // PARITY: manifest now == on-disk (Story 0.4)
    expect(res.added).toEqual(bmad); // sorted, only the unmanaged ones

    const m = parseYaml(readFileSync(join(wt, '.claude', 'skills.manifest.yaml'), 'utf-8'));
    expect(m.core).toHaveLength(59);
    // existing anthropic entries preserved verbatim, keep their source
    const fe = m.core.find((e) => e.skill === 'frontend-design');
    expect(fe.source).toBe('anthropic-official');
    // bmad entries attributed to futurator-skills
    const b0 = m.core.find((e) => e.skill === 'bmad-skill-00');
    expect(b0).toMatchObject({ source: 'futurator-skills', version: 'sha:HEAD' });
    // provenance marker appended, prepin origin preserved
    expect(m['generated-by']).toBe('prepin-default-skills@v1+reconcile-skills-manifest@v1');
  });

  it('is idempotent — second run is a no-op', async () => {
    const skills = ['a', 'b', 'c'];
    writeManifest({ project: 'p', core: [] });
    makeSkillDirs(skills);

    const first = await runReconcileSkillsManifest({ worktreeDir: wt, onOutput: () => {} });
    expect(first.reconciledCount).toBe(3);

    const second = await runReconcileSkillsManifest({ worktreeDir: wt, onOutput: () => {} });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already-reconciled');
    expect(second.reconciledCount).toBe(0);

    const m = parseYaml(readFileSync(join(wt, '.claude', 'skills.manifest.yaml'), 'utf-8'));
    expect(m.core).toHaveLength(3); // no duplication
  });

  it('skips cleanly when manifest missing or no skills on disk', async () => {
    const noManifest = await runReconcileSkillsManifest({ worktreeDir: wt, onOutput: () => {} });
    expect(noManifest).toMatchObject({ skipped: true, reason: 'manifest-missing' });

    writeManifest({ project: 'p', core: [] });
    const noSkills = await runReconcileSkillsManifest({ worktreeDir: wt, onOutput: () => {} });
    expect(noSkills).toMatchObject({ skipped: true, reason: 'no-on-disk-skills' });
  });

  it('respects a custom source attribution', async () => {
    writeManifest({ project: 'p', core: [] });
    makeSkillDirs(['x']);
    await runReconcileSkillsManifest({ worktreeDir: wt, source: 'custom-src', onOutput: () => {} });
    const m = parseYaml(readFileSync(join(wt, '.claude', 'skills.manifest.yaml'), 'utf-8'));
    expect(m.core[0].source).toBe('custom-src');
  });
});
