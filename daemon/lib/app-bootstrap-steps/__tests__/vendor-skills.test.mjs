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

// ── Story 4.2 — trusted-only install gate ──────────────────────────────────

const COMMUNITY_MANIFEST = `project: dino2
core: []
stack:
  - source: community
    skill: untrusted-skill
    version: sha:HEAD
domain: []
vendor: []
`;

/** fetchImpl that serves index.json (with trust facets) + SKILL.md bodies. */
function trustAwareFetch(indexByRepo) {
  return async (url) => {
    if (url.endsWith('/index.json')) {
      const repo = url.replace('https://raw.githubusercontent.com/', '').replace('/main/index.json', '');
      return { ok: true, status: 200, json: async () => ({ skills: indexByRepo[repo] ?? [] }) };
    }
    return { ok: true, status: 200, text: async () => `# body ${url}\n` };
  };
}

describe('runVendorSkills — trusted-only install gate (Story 4.2)', () => {
  it('BLOCKS a non-trusted skill from a community (non-auto-trust) source', async () => {
    const dir = makeWorktree(COMMUNITY_MANIFEST);
    const fetchImpl = trustAwareFetch({
      // legacy entry (no trustTier) on a non-auto-trust source → blocked
      'anthropics/skills-community': [{ name: 'untrusted-skill', kind: 'stack' }],
    });
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl });
    expect(res.blocked).toBe(1);
    expect(res.vendoredCount).toBe(0);
    expect(existsSync(join(dir, '.claude/skills/untrusted-skill/SKILL.md'))).toBe(false);
  });

  it('ALLOWS a trusted skill even from a community source', async () => {
    const dir = makeWorktree(COMMUNITY_MANIFEST);
    const fetchImpl = trustAwareFetch({
      'anthropics/skills-community': [{ name: 'untrusted-skill', trustTier: 'trusted' }],
    });
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl });
    expect(res.blocked).toBe(0);
    expect(res.vendoredCount).toBe(1);
    expect(existsSync(join(dir, '.claude/skills/untrusted-skill/SKILL.md'))).toBe(true);
  });

  it('BLOCKS a reviewed skill even on an auto-trust source', async () => {
    const dir = makeWorktree(CANVAS_MANIFEST);
    const fetchImpl = trustAwareFetch({
      'anthropics/skills': [
        { name: 'canvas-design', trustTier: 'reviewed' },
        { name: 'frontend-design', trustTier: 'trusted' },
      ],
    });
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl });
    expect(res.blocked).toBe(1); // canvas-design (reviewed) blocked
    expect(res.vendoredCount).toBe(1); // frontend-design (trusted) vendored
  });

  it('GRANDFATHERS legacy entries on an auto-trust source (prod-safe)', async () => {
    const dir = makeWorktree(CANVAS_MANIFEST);
    // index has no trust facets at all → legacy; anthropic-official is auto-trust.
    const fetchImpl = trustAwareFetch({ 'anthropics/skills': [] });
    const res = await runVendorSkills({ worktreeDir: dir, fetchImpl });
    expect(res.blocked).toBe(0);
    expect(res.vendoredCount).toBe(2);
  });
});
