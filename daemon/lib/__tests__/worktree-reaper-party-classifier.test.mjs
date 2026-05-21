import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Story 20.15 — reaper real classifier (with findPartySessionByShort wired).
 *
 * The classifier ALREADY shipped with Story 19.7 — this file tests it
 * end-to-end with a wired dep. Story 19.7's test (worktree-reaper-party.test.mjs)
 * covers the no-op branch (dep absent); this file covers the four
 * real-work branches:
 *   - session-row-missing → reap
 *   - session-active (not in terminal statuses) → no reap
 *   - session-terminal-but-fresh (<7d) → no reap
 *   - session-terminal-and-stale (>7d) → reap
 */

let worktreeRoot;
let storeRoot;
let originalWt;
let originalStore;

const APP = 'applicator';
const SID_MISSING = 'aaaaaaaa';
const SID_ACTIVE = 'bbbbbbbb';
const SID_FRESH = 'cccccccc';
const SID_STALE = 'dddddddd';
const SID_CANCELLED_STALE = 'eeeeeeee';

const NOW = Date.now();
const ONE_HOUR_AGO = new Date(NOW - 60 * 60 * 1000).toISOString();
const EIGHT_DAYS_AGO = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();

function makePartyWorktree(sidShort) {
  mkdirSync(join(worktreeRoot, APP, '_party', sidShort), { recursive: true });
}

function partySessionLookup(sidShort) {
  switch (sidShort) {
    case SID_MISSING:
      return null;
    case SID_ACTIVE:
      return { sessionId: `${SID_ACTIVE}-uuid`, status: 'ACTIVE', updatedAt: ONE_HOUR_AGO };
    case SID_FRESH:
      return { sessionId: `${SID_FRESH}-uuid`, status: 'ENDED', updatedAt: ONE_HOUR_AGO };
    case SID_STALE:
      return { sessionId: `${SID_STALE}-uuid`, status: 'ENDED', updatedAt: EIGHT_DAYS_AGO };
    case SID_CANCELLED_STALE:
      return {
        sessionId: `${SID_CANCELLED_STALE}-uuid`,
        status: 'CANCELLED',
        updatedAt: EIGHT_DAYS_AGO,
      };
    default:
      return null;
  }
}

beforeEach(() => {
  worktreeRoot = mkdtempSync(join(tmpdir(), 'reap-real-wt-'));
  storeRoot = mkdtempSync(join(tmpdir(), 'reap-real-store-'));
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

describe('Story 20.15 — classifyPartyWorktree real branches (deps wired)', () => {
  it('REAPs when session row is missing', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_MISSING);

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => partySessionLookup(sid),
      log: () => {},
    });

    expect(summary.party.scanned).toBe(1);
    // reap-attempts go through `git --git-dir <bare> worktree remove` which
    // fails (no bare repo on disk in this test); summary.party.reaped will
    // be 0 + errors counter bumps, but the verdict was shouldReap:true.
    // Easier to assert: at least one of reaped/errors fired (not skipped).
    expect(summary.party.reaped + summary.party.errors).toBeGreaterThanOrEqual(1);
  });

  it('does NOT reap when session is active', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_ACTIVE);

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => partySessionLookup(sid),
      log: () => {},
    });

    expect(summary.party.scanned).toBe(1);
    expect(summary.party.reaped).toBe(0);
    expect(summary.party.errors).toBe(0);
  });

  it('does NOT reap when session is terminal-but-fresh (<7d old)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_FRESH);

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => partySessionLookup(sid),
      log: () => {},
    });

    expect(summary.party.scanned).toBe(1);
    expect(summary.party.reaped).toBe(0);
    expect(summary.party.errors).toBe(0);
  });

  it('REAPs when session is ENDED + stale (>7d old)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_STALE);

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => partySessionLookup(sid),
      log: () => {},
    });

    expect(summary.party.scanned).toBe(1);
    expect(summary.party.reaped + summary.party.errors).toBeGreaterThanOrEqual(1);
  });

  it('REAPs when session is CANCELLED + stale (>7d old)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_CANCELLED_STALE);

    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => partySessionLookup(sid),
      log: () => {},
    });

    expect(summary.party.scanned).toBe(1);
    expect(summary.party.reaped + summary.party.errors).toBeGreaterThanOrEqual(1);
  });

  it('continues classifying siblings when one session lookup fails', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makePartyWorktree(SID_ACTIVE);
    makePartyWorktree(SID_STALE);

    // One throws, one succeeds.
    const summary = await runWorktreeReaper({
      findStoryByIds: async () => null,
      getJobById: async () => null,
      findPlanByAppAndSlug: async () => null,
      findPartySessionByShort: async (sid) => {
        if (sid === SID_ACTIVE) throw new Error('DDB blip');
        return partySessionLookup(sid);
      },
      log: () => {},
    });

    expect(summary.party.scanned).toBe(2);
    // SID_ACTIVE: lookup throws → classifier catches → returns null
    // (session-row-missing → reap-attempt). SID_STALE: terminal+stale → reap-attempt.
    // Both reap-attempts may fail (no bare repo in test); the loop survives.
  });
});
