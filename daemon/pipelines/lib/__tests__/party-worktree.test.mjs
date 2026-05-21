import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setupPartyWorktree,
  sessionIdShortOf,
  partyWorktreeDir,
  partyBranchName,
  WorktreeSetupError,
} from '../party-worktree.mjs';

const PROJECT = 'applicator';
const SESSION_ID = 'a1b2c3d4-1111-2222-3333-444455556666';
const SESSION_SHORT = 'a1b2c3d4';
const BRANCH = `party/${PROJECT}/${SESSION_SHORT}`;

let worktreeRoot;
let bareDir;

function silentLog() {
  return vi.fn();
}

function makeGitRunner(scenarios) {
  // Each scenario is a function that takes args + cwd and returns
  // { code, stdout, stderr }. The runner advances through them in order.
  let idx = 0;
  return vi.fn(async (args, cwd) => {
    if (idx >= scenarios.length) {
      return { code: 0, stdout: '', stderr: 'unexpected gitRunner call' };
    }
    return scenarios[idx++](args, cwd);
  });
}

beforeEach(() => {
  worktreeRoot = mkdtempSync(join(tmpdir(), 'party-worktree-'));
  bareDir = join(worktreeRoot, 'bare-repo.git');
  // Create a fake bare-repo dir; the gitRunner is mocked so contents don't matter.
  mkdirSync(bareDir, { recursive: true });
});

afterEach(() => {
  if (worktreeRoot && existsSync(worktreeRoot)) {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

describe('sessionIdShortOf', () => {
  it('returns the first 8 chars of a UUID', () => {
    expect(sessionIdShortOf(SESSION_ID)).toBe(SESSION_SHORT);
  });
  it('throws on too-short input', () => {
    expect(() => sessionIdShortOf('abc')).toThrow(/invalid sessionId/);
  });
  it('throws on non-string input', () => {
    expect(() => sessionIdShortOf(null)).toThrow(/invalid sessionId/);
  });
});

describe('partyWorktreeDir / partyBranchName', () => {
  it('builds /home/ubuntu/worktrees/<project>/_party/<sidShort>', () => {
    // Default WORKTREE_ROOT is /home/ubuntu/worktrees; env override is tested via setup args.
    expect(partyWorktreeDir(PROJECT, SESSION_SHORT)).toMatch(
      /\/worktrees\/applicator\/_party\/a1b2c3d4$/,
    );
  });
  it('builds party/<project>/<sidShort>', () => {
    expect(partyBranchName(PROJECT, SESSION_SHORT)).toBe(BRANCH);
  });
});

describe('setupPartyWorktree — Story 20.6 fresh setup (AC 7.1)', () => {
  it('creates worktree on a fresh party/... branch off main', async () => {
    const expectedPath = join(worktreeRoot, PROJECT, '_party', SESSION_SHORT);
    const gitRunner = makeGitRunner([
      // `git worktree add -B branch path main` succeeds
      (args) => {
        expect(args).toContain('worktree');
        expect(args).toContain('add');
        expect(args).toContain('-B');
        expect(args).toContain(BRANCH);
        expect(args).toContain(expectedPath);
        expect(args).toContain('main');
        // Simulate side-effect: worktree-add creates the dir.
        mkdirSync(expectedPath, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    ]);

    const r = await setupPartyWorktree({
      projectId: PROJECT,
      sessionId: SESSION_ID,
      gitRunner,
      bareDir,
      worktreeRootOverride: worktreeRoot,
      log: silentLog(),
    });

    expect(r.created).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.branch).toBe(BRANCH);
    expect(r.worktreePath).toBe(expectedPath);
    expect(gitRunner).toHaveBeenCalledTimes(1);
  });
});

describe('setupPartyWorktree — idempotent reuse (AC 7.2)', () => {
  it('returns created:false, reused:true when worktree exists on correct branch', async () => {
    const expectedPath = join(worktreeRoot, PROJECT, '_party', SESSION_SHORT);
    mkdirSync(expectedPath, { recursive: true });

    const gitRunner = makeGitRunner([
      // rev-parse HEAD returns the matching branch
      (args) => {
        expect(args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
        return { code: 0, stdout: `${BRANCH}\n`, stderr: '' };
      },
    ]);

    const r = await setupPartyWorktree({
      projectId: PROJECT,
      sessionId: SESSION_ID,
      gitRunner,
      bareDir,
      worktreeRootOverride: worktreeRoot,
      log: silentLog(),
    });

    expect(r.created).toBe(false);
    expect(r.reused).toBe(true);
    expect(r.branch).toBe(BRANCH);
    expect(gitRunner).toHaveBeenCalledTimes(1);
  });
});

describe('setupPartyWorktree — wrong-branch recovery (AC 7.3)', () => {
  it('removes + recreates when existing worktree is on a different branch', async () => {
    const expectedPath = join(worktreeRoot, PROJECT, '_party', SESSION_SHORT);
    mkdirSync(expectedPath, { recursive: true });

    const gitRunner = makeGitRunner([
      // 1. rev-parse HEAD returns wrong branch
      () => ({ code: 0, stdout: 'orphan-branch\n', stderr: '' }),
      // 2. worktree remove --force
      (args) => {
        expect(args).toContain('worktree');
        expect(args).toContain('remove');
        expect(args).toContain('--force');
        // Simulate teardown: remove the dir so the recreate path sees it gone.
        rmSync(expectedPath, { recursive: true, force: true });
        return { code: 0, stdout: '', stderr: '' };
      },
      // 3. worktree add to recreate
      (args) => {
        expect(args).toContain('add');
        expect(args).toContain('-B');
        mkdirSync(expectedPath, { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      },
    ]);

    const r = await setupPartyWorktree({
      projectId: PROJECT,
      sessionId: SESSION_ID,
      gitRunner,
      bareDir,
      worktreeRootOverride: worktreeRoot,
      log: silentLog(),
    });

    expect(r.created).toBe(true);
    expect(r.reused).toBe(false);
    expect(gitRunner).toHaveBeenCalledTimes(3);
  });
});

describe('setupPartyWorktree — bare repo missing (AC 7.4)', () => {
  it('throws WORKTREE_SETUP_FAILED with hint pointing at the migrate endpoint', async () => {
    rmSync(bareDir, { recursive: true, force: true });
    const gitRunner = vi.fn();

    await expect(
      setupPartyWorktree({
        projectId: PROJECT,
        sessionId: SESSION_ID,
        gitRunner,
        bareDir,
        worktreeRootOverride: worktreeRoot,
        log: silentLog(),
      }),
    ).rejects.toThrow(WorktreeSetupError);
    await expect(
      setupPartyWorktree({
        projectId: PROJECT,
        sessionId: SESSION_ID,
        gitRunner,
        bareDir,
        worktreeRootOverride: worktreeRoot,
        log: silentLog(),
      }),
    ).rejects.toThrow(/migrate-brownfield/);
    expect(gitRunner).not.toHaveBeenCalled();
  });
});

describe('setupPartyWorktree — git failure surfaces', () => {
  it('wraps git worktree add failure in WorktreeSetupError with stderr', async () => {
    const gitRunner = makeGitRunner([
      () => ({
        code: 128,
        stdout: '',
        stderr: "fatal: 'main' does not exist in the bare repo",
      }),
    ]);

    await expect(
      setupPartyWorktree({
        projectId: PROJECT,
        sessionId: SESSION_ID,
        gitRunner,
        bareDir,
        worktreeRootOverride: worktreeRoot,
        log: silentLog(),
      }),
    ).rejects.toThrow(/main.*does not exist/);
  });
});

describe('setupPartyWorktree — input validation', () => {
  it('throws on missing projectId', async () => {
    await expect(
      setupPartyWorktree({ sessionId: SESSION_ID, gitRunner: vi.fn(), bareDir }),
    ).rejects.toThrow(/required/);
  });
  it('throws on missing sessionId', async () => {
    await expect(
      setupPartyWorktree({ projectId: PROJECT, gitRunner: vi.fn(), bareDir }),
    ).rejects.toThrow(/required/);
  });
});
