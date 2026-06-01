/**
 * Tests for vendor-skills.mjs — daemon-side skill vendoring (rewritten
 * 2026-06-01). Verifies it reads the manifest, fetches each pinned skill from
 * the federation source under the `skills/<name>/` path, writes SKILL.md into
 * the project, and stays non-blocking on fetch failure.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVendorSkills } from '../vendor-skills.mjs';

const tmps = [];
afterEach(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeWorktree(manifestYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-'));
  tmps.push(dir);
  if (manifestYaml !== null) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills.manifest.yaml'), manifestYaml);
  }
  return dir;
}

const CANVAS_MANIFEST = `project: dino2
core:
  - source: anthropic-official
    skill: canvas-design
    version: sha:HEAD
  - source: anthropic-official
    skill: frontend-design
    version: sha:HEAD
stack: []
domain: []
vendor: []
`;

describe('runVendorSkills (daemon-side fetch)', () => {
  it('fetches each pinned skill under skills/<name>/ and writes SKILL.md', async () => {
    const dir = makeWorktree(CANVAS_MANIFEST);
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => `# ${url}\n` };
    };
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl, pat: undefined });

    expect(res.skipped).toBe(false);
    expect(res.vendoredCount).toBe(2);
    expect(res.failed).toBe(0);
    // Correct repo + the `skills/` prefix + sha:HEAD → main.
    expect(urls).toContain(
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/SKILL.md',
    );
    // Files written into the project.
    expect(existsSync(join(dir, '.claude/skills/canvas-design/SKILL.md'))).toBe(true);
    expect(readFileSync(join(dir, '.claude/skills/frontend-design/SKILL.md'), 'utf8')).toContain(
      'frontend-design',
    );
  });

  it('skip=true → stub, no fetch', async () => {
    const res = await runVendorSkills({ worktreeDir: makeWorktree(null), skip: true });
    expect(res).toEqual({ skipped: true, reason: 'stub-boilerplate', vendoredCount: 0 });
  });

  it('no manifest → skipped no-manifest', async () => {
    const res = await runVendorSkills({ worktreeDir: makeWorktree(null) });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no-manifest');
  });

  it('empty manifest → skipped no-skills', async () => {
    const res = await runVendorSkills({
      worktreeDir: makeWorktree('core: []\nstack: []\ndomain: []\nvendor: []\n'),
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no-skills');
  });

  it('NON-BLOCKING on total fetch failure (404) → skipped + attention, no throw', async () => {
    const dir = makeWorktree(CANVAS_MANIFEST);
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' });
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl });
    expect(res.skipped).toBe(true);
    expect(res.vendoredCount).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.attentionCategory).toBe('skill-sync-failed');
  });
});
