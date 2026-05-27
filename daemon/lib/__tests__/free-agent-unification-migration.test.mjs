import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeRunUnificationMigration } from '../free-agent-unification-migration.mjs';

/**
 * 2026-05-27 (unification) — one-shot startup migration.
 *
 * Coverage:
 *   - sentinel-present → short-circuits with reason='sentinel-present'
 *   - old root present → rm'd; sessions ACTIVE/PROCESSING → marked EXPIRED;
 *     sentinel written
 *   - old root absent → rm step is a no-op; no error
 *   - one markError throws → counted under markErrors; sweep continues
 *   - listAllSessions throws → caught + logged; still touches sentinel
 *   - sentinel write throws → caught + logged; ran:true returned (idempotent
 *     enough: subsequent boot finds clean state and re-emits the same noop)
 *   - rm throws → rmStatus carries the error; doesn't crash the migration
 */

function makeFsShim({
  existingPaths = new Set(),
  rmThrows = false,
  writeThrows = false,
  mkdirThrows = false,
} = {}) {
  const fs = {
    existsSync: vi.fn((p) => existingPaths.has(p)),
    rmSync: vi.fn(() => {
      if (rmThrows) throw new Error('EBUSY rm failed');
    }),
    writeFileSync: vi.fn(() => {
      if (writeThrows) throw new Error('EACCES write failed');
    }),
    mkdirSync: vi.fn(() => {
      if (mkdirThrows) throw new Error('mkdir failed');
    }),
  };
  return fs;
}

function makeSessionsRepo({ rows = [], markError = vi.fn(async () => {}), listThrows = false } = {}) {
  return {
    listAllSessions: vi.fn(async () => {
      if (listThrows) throw new Error('DDB scan failed');
      return rows;
    }),
    markError,
  };
}

const OLD = '/home/ubuntu/free-agent-worktrees';
const SENTINEL = '/var/lib/futurator-daemon/free-agent-unified.flag';
const SENTINEL_DIR = '/var/lib/futurator-daemon';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maybeRunUnificationMigration', () => {
  it('short-circuits when the sentinel is already present', async () => {
    const fs = makeFsShim({ existingPaths: new Set([SENTINEL]) });
    const repo = makeSessionsRepo();
    const result = await maybeRunUnificationMigration({ sessionsRepo: repo, fs, log: () => {} });
    expect(result).toEqual({ ran: false, reason: 'sentinel-present' });
    expect(repo.listAllSessions).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('removes the old root, marks ACTIVE/PROCESSING sessions EXPIRED, writes sentinel', async () => {
    const fs = makeFsShim({ existingPaths: new Set([OLD]) });
    const markError = vi.fn(async () => {});
    const repo = makeSessionsRepo({
      rows: [
        { sessionId: 'a', status: 'ACTIVE' },
        { sessionId: 'b', status: 'PROCESSING' },
        { sessionId: 'c', status: 'IDLE' },
        { sessionId: 'd', status: 'ERROR' },
        { sessionId: 'e', status: 'EXPIRED' },
      ],
      markError,
    });
    const result = await maybeRunUnificationMigration({ sessionsRepo: repo, fs, log: () => {} });
    expect(result.ran).toBe(true);
    expect(result.rmStatus).toBe('removed');
    expect(result.markedCount).toBe(2);
    expect(result.markErrors).toBe(0);
    expect(fs.rmSync).toHaveBeenCalledWith(OLD, { recursive: true, force: true });
    expect(markError).toHaveBeenCalledTimes(2);
    expect(markError).toHaveBeenCalledWith('a', 'WORKTREE_UNIFICATION_MIGRATION');
    expect(markError).toHaveBeenCalledWith('b', 'WORKTREE_UNIFICATION_MIGRATION');
    expect(fs.mkdirSync).toHaveBeenCalledWith(SENTINEL_DIR, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(SENTINEL, expect.any(String));
  });

  it('treats missing old root as a no-op', async () => {
    const fs = makeFsShim({ existingPaths: new Set() }); // nothing exists
    const repo = makeSessionsRepo({ rows: [] });
    const result = await maybeRunUnificationMigration({ sessionsRepo: repo, fs, log: () => {} });
    expect(result.ran).toBe(true);
    expect(result.rmStatus).toBe('noop');
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('counts a markError throw under markErrors but continues the sweep', async () => {
    const fs = makeFsShim({ existingPaths: new Set([OLD]) });
    let calls = 0;
    const repo = makeSessionsRepo({
      rows: [
        { sessionId: 'a', status: 'ACTIVE' },
        { sessionId: 'b', status: 'PROCESSING' },
      ],
      markError: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('ConditionalCheckFailedException');
      }),
    });
    const warnings = [];
    const result = await maybeRunUnificationMigration({
      sessionsRepo: repo,
      fs,
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    expect(result.markedCount).toBe(1);
    expect(result.markErrors).toBe(1);
    expect(warnings.some((m) => m.includes('mark failed for a'))).toBe(true);
  });

  it('logs and tolerates a listAllSessions throw, still writes sentinel', async () => {
    const fs = makeFsShim({ existingPaths: new Set([OLD]) });
    const repo = makeSessionsRepo({ listThrows: true });
    const errors = [];
    const result = await maybeRunUnificationMigration({
      sessionsRepo: repo,
      fs,
      log: (level, msg) => {
        if (level === 'error') errors.push(msg);
      },
    });
    expect(result.ran).toBe(true);
    expect(result.markedCount).toBe(0);
    expect(errors.some((m) => m.includes('sessions scan failed'))).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(SENTINEL, expect.any(String));
  });

  it('still returns ran:true when sentinel write throws', async () => {
    const fs = makeFsShim({ existingPaths: new Set([OLD]), writeThrows: true });
    const repo = makeSessionsRepo({ rows: [] });
    const warnings = [];
    const result = await maybeRunUnificationMigration({
      sessionsRepo: repo,
      fs,
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    expect(result.ran).toBe(true);
    expect(warnings.some((m) => m.includes('sentinel write failed'))).toBe(true);
  });

  it('captures rm errors in rmStatus without throwing', async () => {
    const fs = makeFsShim({ existingPaths: new Set([OLD]), rmThrows: true });
    const repo = makeSessionsRepo({ rows: [] });
    const result = await maybeRunUnificationMigration({ sessionsRepo: repo, fs, log: () => {} });
    expect(result.ran).toBe(true);
    expect(result.rmStatus).toMatch(/error: /);
  });

  it('throws when sessionsRepo is not supplied', async () => {
    await expect(maybeRunUnificationMigration({})).rejects.toThrow(/sessionsRepo required/);
  });
});
