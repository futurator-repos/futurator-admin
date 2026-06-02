/**
 * Unit tests for worktree-reaper.mjs (Phase 1 worktree rollout).
 *
 * Pure-function coverage of `runWorktreeReaper`'s classify logic via
 * dependency injection. Filesystem walking + git operations are exercised
 * with mkdtemp + spawnSync stubs.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let storeRoot;
let worktreeRoot;
let originalStore;
let originalWt;

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), 'reap-store-'));
  worktreeRoot = mkdtempSync(join(tmpdir(), 'reap-wt-'));
  originalStore = process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  originalWt = process.env.FUTURATOR_WORKTREE_ROOT;
  process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = storeRoot;
  process.env.FUTURATOR_WORKTREE_ROOT = worktreeRoot;
  vi.resetModules();
});

afterEach(() => {
  if (storeRoot && existsSync(storeRoot)) rmSync(storeRoot, { recursive: true, force: true });
  if (worktreeRoot && existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  if (originalStore === undefined) delete process.env.FUTURATOR_NODE_MODULES_STORE_ROOT;
  else process.env.FUTURATOR_NODE_MODULES_STORE_ROOT = originalStore;
  if (originalWt === undefined) delete process.env.FUTURATOR_WORKTREE_ROOT;
  else process.env.FUTURATOR_WORKTREE_ROOT = originalWt;
});

function makeWorktreeDir({ appId, planSlug, storyId }) {
  const dir = join(worktreeRoot, appId, planSlug, storyId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStoreEntry({ appId, sha, refcount = 0 }) {
  const entryDir = join(storeRoot, appId, sha);
  mkdirSync(join(entryDir, 'node_modules'), { recursive: true });
  writeFileSync(
    join(entryDir, '.refcount.json'),
    JSON.stringify({ count: refcount, createdAt: new Date().toISOString(), lastBumpedAt: new Date().toISOString() }),
  );
  return entryDir;
}

describe('runWorktreeReaper — per-story', () => {
  it('reaps a STALE worktree when its story row is missing', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    const dir = makeWorktreeDir({ appId: 'snake-4', planSlug: 'p', storyId: 'orphan-story' });
    // 2026-06-02 — reap-on-missing only fires for STALE worktrees now. Age the
    // dir past the 30-min freshness window so the lookup-miss is treated as a
    // genuine orphan, not an active story whose DDB lookup transiently failed.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(dir, old, old);
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.perStory.scanned).toBe(1);
    // Reap is attempted; the reap calls teardownStoryWorktree which tries
    // git worktree remove. In the test env there's no bare repo, so the
    // teardown logs warnings but still rm -rf's the dir.
    expect(summary.perStory.reaped + summary.perStory.errors).toBe(1);
  });

  it('does NOT reap a FRESH worktree even when its story row is missing (transient lookup miss)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    // Freshly created (mtime = now) — simulates an in-flight story whose
    // findStoryByIds transiently returned null (throttled/eventually-consistent
    // DDB Scan). Reaping it would kill an active story mid-run.
    makeWorktreeDir({ appId: 'snake-4', planSlug: 'p', storyId: 'active-but-unlookupable' });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.perStory.scanned).toBe(1);
    expect(summary.perStory.reaped).toBe(0);
  });

  it('does NOT reap a worktree whose job is still active', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeWorktreeDir({ appId: 'snake-4', planSlug: 'p', storyId: 'live-story' });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => ({ storyId: 'live-story', jobId: 'job-1' }),
      getJobById: async () => ({ jobId: 'job-1', status: 'RUNNING', updatedAt: new Date().toISOString() }),
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.perStory.scanned).toBe(1);
    expect(summary.perStory.reaped).toBe(0);
  });

  it('does NOT reap a worktree whose job is terminal but FRESH (<24h)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeWorktreeDir({ appId: 'snake-4', planSlug: 'p', storyId: 'fresh-story' });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => ({ storyId: 'fresh-story', jobId: 'job-1' }),
      getJobById: async () => ({
        jobId: 'job-1',
        status: 'COMPLETED',
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
      }),
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.perStory.scanned).toBe(1);
    expect(summary.perStory.reaped).toBe(0);
  });

  it('reaps a worktree whose job is terminal AND >24h stale', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeWorktreeDir({ appId: 'snake-4', planSlug: 'p', storyId: 'stale-story' });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => ({ storyId: 'stale-story', jobId: 'job-1' }),
      getJobById: async () => ({
        jobId: 'job-1',
        status: 'COMPLETED',
        updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      }),
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.perStory.scanned).toBe(1);
    expect(summary.perStory.reaped + summary.perStory.errors).toBe(1);
  });
});

describe('runWorktreeReaper — coordinator', () => {
  it('reaps a coordinator worktree when the plan is delivered', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    mkdirSync(join(worktreeRoot, 'snake-4', 'p', '_merge'), { recursive: true });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'delivered' }),
      log: () => {},
    });
    expect(summary.coordinator.scanned).toBe(1);
    expect(summary.coordinator.reaped + summary.coordinator.errors).toBe(1);
  });

  it('does NOT reap a coordinator when plan is still developing', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    mkdirSync(join(worktreeRoot, 'snake-4', 'p', '_merge'), { recursive: true });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => ({ planId: 'p', status: 'developing' }),
      log: () => {},
    });
    expect(summary.coordinator.scanned).toBe(1);
    expect(summary.coordinator.reaped).toBe(0);
  });
});

describe('runWorktreeReaper — store', () => {
  it('reaps a store entry with refcount=0 and no live symlinks', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeStoreEntry({ appId: 'snake-4', sha: 'sha-zero' });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      log: () => {},
    });
    expect(summary.store.scanned).toBe(1);
    expect(summary.store.reaped).toBe(1);
  });

  it('does NOT reap a store entry with positive refcount', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeStoreEntry({ appId: 'snake-4', sha: 'sha-live', refcount: 2 });
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      log: () => {},
    });
    expect(summary.store.scanned).toBe(1);
    expect(summary.store.reaped).toBe(0);
  });
});
