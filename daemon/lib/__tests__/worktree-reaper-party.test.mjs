/**
 * Story 19.7 tests — party worktree walker + no-op classifier.
 *
 * PR 0 ships only the structural walker (no real reaping until Story 20.15
 * wires `deps.findPartySessionByShort`). These tests verify:
 *   - A fake party worktree dir is discovered by the walker.
 *   - The classifier returns `shouldReap: false` because `findPartySessionByShort`
 *     is absent from `deps` (the test deps fixture omits it).
 *   - `walkPerStoryWorktrees` skips `_party` so the party + per-story walks
 *     don't double-count or double-reap a party path.
 *   - The summary log line carries the `party N/M` segment.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let worktreeRoot;
let storeRoot;
let originalWt;
let originalStore;

beforeEach(() => {
  worktreeRoot = mkdtempSync(join(tmpdir(), 'reap-party-wt-'));
  storeRoot = mkdtempSync(join(tmpdir(), 'reap-party-store-'));
  originalWt = process.env.FUTURATOR_WORKTREE_ROOT;
  originalStore = process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  process.env.FUTURATOR_WORKTREE_ROOT = worktreeRoot;
  process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = storeRoot;
  vi.resetModules();
});

afterEach(() => {
  if (worktreeRoot && existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  if (storeRoot && existsSync(storeRoot)) rmSync(storeRoot, { recursive: true, force: true });
  if (originalWt === undefined) delete process.env.FUTURATOR_WORKTREE_ROOT;
  else process.env.FUTURATOR_WORKTREE_ROOT = originalWt;
  if (originalStore === undefined) delete process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  else process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = originalStore;
});

function makePartyWorktreeDir({ appId, sessionIdShort }) {
  const dir = join(worktreeRoot, appId, '_party', sessionIdShort);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePerStoryWorktreeDir({ appId, planSlug, storyId }) {
  const dir = join(worktreeRoot, appId, planSlug, storyId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('Story 19.7 — party worktree walker (no-op classifier)', () => {
  it('discovers a fake party worktree but does NOT reap it (lookup-not-wired)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktreeDir({ appId: 'applicator', sessionIdShort: 'a1b2c3d4' });

    const logs = [];
    const summary = await runWorktreeReaper({
      // Per-story + coordinator deps. Omitting `findPartySessionByShort`
      // is the load-bearing part of the test — it forces the classifier's
      // no-op branch.
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    });

    expect(summary.party.scanned).toBe(1);
    expect(summary.party.reaped).toBe(0);
    expect(summary.party.errors).toBe(0);
  });

  it('does NOT double-walk a party path as a per-story worktree (walkPerStoryWorktrees skips _party)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktreeDir({ appId: 'applicator', sessionIdShort: 'a1b2c3d4' });
    // Also make a real per-story path on the SAME app so we can prove the
    // per-story counter sees 1 (not 2 = real + accidentally-walked _party).
    makePerStoryWorktreeDir({
      appId: 'applicator',
      planSlug: 'a-real-plan',
      storyId: 'story-1',
    });

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => ({ storyId: 'story-1', jobId: 'j' }),
      getJobById: async () => ({ jobId: 'j', status: 'RUNNING', updatedAt: new Date().toISOString() }),
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });

    expect(summary.perStory.scanned).toBe(1);
    expect(summary.party.scanned).toBe(1);
  });

  it('emits the `party N/M` segment in the summary log line', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktreeDir({ appId: 'applicator', sessionIdShort: 'aaaaaaaa' });
    makePartyWorktreeDir({ appId: 'debatator', sessionIdShort: 'bbbbbbbb' });

    const lines = [];
    await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      log: (level, msg) => {
        if (level === 'info') lines.push(msg);
      },
    });

    const done = lines.find((l) => l.startsWith('[reaper] done in'));
    expect(done).toBeDefined();
    expect(done).toMatch(/party 0\/2/);
  });

  it('yields nothing when no party worktrees exist (party 0/0 baseline)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      log: () => {},
    });
    expect(summary.party).toEqual({ scanned: 0, reaped: 0, errors: 0 });
  });
});
