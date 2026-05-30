/**
 * Unit tests for bare-repo-sync.mjs (B1 — brownfield freshness, 2026-05-30).
 *
 * Pins the safety contract: syncs ONLY `main` (downstream mirror), refuses any
 * other branch (plan/<slug> is EC2-owned), runs fetch+reset in the working
 * copy that has main checked out, and is best-effort (never throws).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMainToOrigin } from '../bare-repo-sync.mjs';

let projectsRoot;
const calls = [];
beforeEach(() => {
  calls.length = 0;
  projectsRoot = mkdtempSync(join(tmpdir(), 'brsync-'));
  mkdirSync(join(projectsRoot, 'applicator'), { recursive: true });
});

// Fake runner records commands; returns success + a SHA for rev-parse.
const okRunner = (command, cwd) => {
  calls.push({ command, cwd });
  if (command.includes('rev-parse')) return Promise.resolve({ code: 0, stdout: 'abc1234\n', stderr: '' });
  return Promise.resolve({ code: 0, stdout: '', stderr: '' });
};

describe('syncMainToOrigin', () => {
  it('fetches + hard-resets main in the working copy, returns the new sha', async () => {
    const res = await syncMainToOrigin({ appId: 'applicator', projectsRoot, runner: okRunner });
    expect(res.synced).toBe(true);
    expect(res.sha).toBe('abc1234');
    // The fetch+reset ran in /home/.../applicator (where main is checked out).
    const fetchReset = calls.find((c) => c.command.includes('reset --hard'));
    // Resets to FETCH_HEAD — the bare repo's worktree has an empty fetch
    // refspec, so origin/main doesn't exist; FETCH_HEAD is the fetched tip.
    expect(fetchReset.command).toBe('git fetch origin main && git reset --hard FETCH_HEAD');
    expect(fetchReset.cwd).toBe(join(projectsRoot, 'applicator'));
  });

  it('REFUSES any branch other than main (plan/<slug> is EC2-owned)', async () => {
    const res = await syncMainToOrigin({
      appId: 'applicator',
      branch: 'plan/applicator-initial',
      projectsRoot,
      runner: okRunner,
    });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe('refused-non-main');
    expect(calls).toHaveLength(0); // never touched git
  });

  it('returns no-working-copy when the projects dir is absent (no throw)', async () => {
    const res = await syncMainToOrigin({ appId: 'ghost', projectsRoot, runner: okRunner });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe('no-working-copy');
  });

  it('is best-effort: a failed fetch returns {synced:false}, does not throw', async () => {
    const failRunner = () => Promise.resolve({ code: 1, stdout: '', stderr: 'network down' });
    const res = await syncMainToOrigin({ appId: 'applicator', projectsRoot, runner: failRunner });
    expect(res.synced).toBe(false);
    expect(res.reason).toBe('fetch-reset-failed');
  });

  afterEach(() => {
    if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
  });
});
