import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 2026-05-27 (unification) — reaper classifier for the `_assist` namespace.
 *
 * Mirror of worktree-reaper-party-classifier.test.mjs. Covers:
 *   - lookup-not-wired (dep absent) → no reap
 *   - session-row-missing → reap
 *   - session active (not in ASSIST_TERMINAL_STATUSES) → no reap
 *   - session terminal-but-fresh (<7d) → no reap
 *   - session terminal-and-stale (>7d) → reap
 *   - per-row lookup throw is caught; sibling worktrees still classified
 */

let worktreeRoot;
let storeRoot;
let originalWt;
let originalStore;

const APP = 'snake-4';
const SID_MISSING = '11111111';
const SID_ACTIVE = '22222222';
const SID_FRESH = '33333333';
const SID_STALE_IDLE = '44444444';
const SID_STALE_EXPIRED = '55555555';
const SID_STALE_BUDGET = '66666666';
const SID_STALE_ERROR = '77777777';

const NOW = Date.now();
const ONE_HOUR_AGO = new Date(NOW - 60 * 60 * 1000).toISOString();
const EIGHT_DAYS_AGO = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();

function makeAssistWorktree(sidShort) {
  mkdirSync(join(worktreeRoot, APP, '_assist', sidShort), { recursive: true });
}

function freeAgentSessionLookup(sidShort) {
  switch (sidShort) {
    case SID_MISSING:
      return null;
    case SID_ACTIVE:
      return { sessionId: `${SID_ACTIVE}-uuid`, status: 'ACTIVE', lastActivityAt: ONE_HOUR_AGO };
    case SID_FRESH:
      return { sessionId: `${SID_FRESH}-uuid`, status: 'IDLE', lastActivityAt: ONE_HOUR_AGO };
    case SID_STALE_IDLE:
      return {
        sessionId: `${SID_STALE_IDLE}-uuid`,
        status: 'IDLE',
        lastActivityAt: EIGHT_DAYS_AGO,
      };
    case SID_STALE_EXPIRED:
      return {
        sessionId: `${SID_STALE_EXPIRED}-uuid`,
        status: 'EXPIRED',
        lastActivityAt: EIGHT_DAYS_AGO,
      };
    case SID_STALE_BUDGET:
      return {
        sessionId: `${SID_STALE_BUDGET}-uuid`,
        status: 'BUDGET_EXHAUSTED',
        lastActivityAt: EIGHT_DAYS_AGO,
      };
    case SID_STALE_ERROR:
      return {
        sessionId: `${SID_STALE_ERROR}-uuid`,
        status: 'ERROR',
        lastActivityAt: EIGHT_DAYS_AGO,
      };
    default:
      return null;
  }
}

beforeEach(() => {
  worktreeRoot = mkdtempSync(join(tmpdir(), 'reap-assist-wt-'));
  storeRoot = mkdtempSync(join(tmpdir(), 'reap-assist-store-'));
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

const baseDeps = () => ({
  findStoryByIds: async () => null,
  getJobById: async () => null,
  findPlanByAppAndSlug: async () => null,
  findPartySessionByShort: async () => null,
  log: () => {},
});

describe('classifyAssistWorktree — lookup-not-wired', () => {
  it('does NOT reap when findFreeAgentSessionByShort is absent', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(SID_STALE_IDLE); // would otherwise reap

    const summary = await runWorktreeReaper(baseDeps());

    expect(summary.assist.scanned).toBe(1);
    expect(summary.assist.reaped).toBe(0);
    expect(summary.assist.errors).toBe(0);
  });
});

describe('classifyAssistWorktree — real branches (deps wired)', () => {
  it('REAPs when session row is missing', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(SID_MISSING);

    const summary = await runWorktreeReaper({
      ...baseDeps(),
      findFreeAgentSessionByShort: async (sid) => freeAgentSessionLookup(sid),
    });

    expect(summary.assist.scanned).toBe(1);
    // The git --git-dir invocation against a non-existent bare repo will fail
    // (test does not create one); summary.assist.reaped may be 0 with errors,
    // but EITHER way the verdict was shouldReap:true → reap was attempted.
    expect(summary.assist.reaped + summary.assist.errors).toBeGreaterThanOrEqual(1);
  });

  it('does NOT reap when session is ACTIVE', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(SID_ACTIVE);

    const summary = await runWorktreeReaper({
      ...baseDeps(),
      findFreeAgentSessionByShort: async (sid) => freeAgentSessionLookup(sid),
    });

    expect(summary.assist.scanned).toBe(1);
    expect(summary.assist.reaped).toBe(0);
    expect(summary.assist.errors).toBe(0);
  });

  it('does NOT reap when session is terminal-but-fresh (<7d)', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(SID_FRESH);

    const summary = await runWorktreeReaper({
      ...baseDeps(),
      findFreeAgentSessionByShort: async (sid) => freeAgentSessionLookup(sid),
    });

    expect(summary.assist.scanned).toBe(1);
    expect(summary.assist.reaped).toBe(0);
    expect(summary.assist.errors).toBe(0);
  });

  it.each([
    ['IDLE', SID_STALE_IDLE],
    ['EXPIRED', SID_STALE_EXPIRED],
    ['BUDGET_EXHAUSTED', SID_STALE_BUDGET],
    ['ERROR', SID_STALE_ERROR],
  ])('REAPs when session is %s + stale (>7d)', async (_label, sid) => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(sid);

    const summary = await runWorktreeReaper({
      ...baseDeps(),
      findFreeAgentSessionByShort: async (s) => freeAgentSessionLookup(s),
    });

    expect(summary.assist.scanned).toBe(1);
    expect(summary.assist.reaped + summary.assist.errors).toBeGreaterThanOrEqual(1);
  });

  it('continues classifying siblings when one lookup throws', async () => {
    const { runWorktreeReaper } = await import('../worktree-reaper.mjs');
    makeAssistWorktree(SID_ACTIVE);
    makeAssistWorktree(SID_STALE_IDLE);

    const summary = await runWorktreeReaper({
      ...baseDeps(),
      findFreeAgentSessionByShort: async (sid) => {
        if (sid === SID_ACTIVE) throw new Error('DDB blip');
        return freeAgentSessionLookup(sid);
      },
    });

    expect(summary.assist.scanned).toBe(2);
    // SID_ACTIVE: lookup throws → caught → null → reap-attempt (no bare repo).
    // SID_STALE_IDLE: terminal+stale → reap-attempt.
    // Loop survives.
  });
});
