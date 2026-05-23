import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPartyTurn } from '../party-turn.mjs';

/**
 * Story 20.7 — party-push V1 rewire tests. Enabled via PARTY_PUSH_V1_ENABLED='1'.
 *
 * Covers AC 4:
 *   - Worktree missing → WORKTREE_MISSING
 *   - Happy path → spawn args carry --settings <tmp> + bypassPermissions
 *   - Cancel during turn → party.turn.cancelled, clearCancelFlag fires
 *   - Default-allow stderr → party.tool.default-allow event
 */

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

function fakeChild({ stdoutLines = [], stderrLines = [], exitCode = 0, exitDelayMs = 5 } = {}) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinWrites = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinWrites.push(chunk.toString('utf8'));
      cb();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    _stdinWrites: stdinWrites,
  });
  queueMicrotask(() => {
    for (const line of stdoutLines) stdout.push(`${line}\n`);
    stdout.push(null);
    for (const line of stderrLines) stderr.push(`${line}\n`);
    stderr.push(null);
    setTimeout(() => child.emit('close', exitCode), exitDelayMs);
  });
  return child;
}

let worktreePath;

function makeCtx(overrides = {}) {
  return {
    pushEvent: vi.fn(async () => {}),
    // Pre-populate `worktreePath` + `partyBranch` so the lazy-setup branch
    // added in Story 20.16 carryover (party-turn.mjs setupPartyWorktree call)
    // SKIPS the setup. Tests that want to exercise the setup path can
    // override `getSession` to return a session without these fields AND
    // wire `setupPartyWorktree`'s deps (bare-repo fixture).
    getSession: vi.fn(async (sessionId) => ({
      sessionId,
      projectId: 'applicator',
      projectPath: worktreePath,
      worktreePath,
      partyBranch: `party/applicator/${SESSION_ID.slice(0, 8)}`,
      claudeSessionId: null,
      status: 'PROCESSING',
      turnCount: 0,
      createdAt: '2026-05-21T00:00:00Z',
      bmadVersionAtStart: '6.0.0-alpha.7',
      GSI1PK: 'applicator',
      GSI1SK: '2026-05-21T00:00:00Z',
    })),
    setClaudeSessionId: vi.fn(async () => {}),
    incrementTurn: vi.fn(async () => {}),
    releaseSessionLock: vi.fn(async () => {}),
    sessionsRepo: {
      getSession: vi.fn(async () => ({ cancelRequested: false })),
      clearCancelFlag: vi.fn(async () => {}),
      setWorktreePath: vi.fn(async () => {}),
    },
    claudeBin: 'claude',
    spawn: vi.fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const turnJob = (content = 'hello') => ({
  jobId: 'job-1',
  jobType: 'party-turn',
  partyTurnPayload: { sessionId: SESSION_ID, content },
});

beforeEach(() => {
  process.env.PARTY_PUSH_V1_ENABLED = '1';
  worktreePath = mkdtempSync(join(tmpdir(), 'party-turn-v1-'));
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.PARTY_PUSH_V1_ENABLED;
  if (worktreePath && existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  // Clean up the settings tmp file the V1 path writes (named by sid prefix).
  const sidShort = SESSION_ID.slice(0, 8);
  const settingsPath = `/tmp/party-settings-${sidShort}.json`;
  if (existsSync(settingsPath)) unlinkSync(settingsPath);
});

describe('Story 20.7 — WORKTREE_MISSING gate (AC 4.1)', () => {
  it('throws WORKTREE_MISSING when worktreePath is set on the session but the dir is gone (post-setup race)', async () => {
    // Reaper deleted the worktree after the session row was populated.
    // Lazy-setup is skipped (worktreePath + partyBranch present); the cwd
    // assertion that runs immediately after fires.
    const ctx = makeCtx();
    ctx.getSession = vi.fn(async () => ({
      sessionId: SESSION_ID,
      projectId: 'applicator',
      projectPath: '/nonexistent/worktree/path',
      worktreePath: '/nonexistent/worktree/path',
      partyBranch: `party/applicator/${SESSION_ID.slice(0, 8)}`,
      claudeSessionId: null,
      status: 'PROCESSING',
      turnCount: 0,
      createdAt: 'x',
      bmadVersionAtStart: '6.0.0-alpha.7',
      GSI1PK: 'applicator',
      GSI1SK: 'x',
    }));
    await expect(runPartyTurn(turnJob(), ctx)).rejects.toThrow(/WORKTREE_MISSING/);
    expect(ctx.spawn).not.toHaveBeenCalled();
    const errorEvents = ctx.pushEvent.mock.calls.filter((c) => c[3] === 'party.turn.error');
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0][4].reason).toBe('WORKTREE_MISSING');
  });

  it('Story 20.16 lazy-setup — throws WORKTREE_SETUP_FAILED when the bare repo is missing pre-setup', async () => {
    // Fresh session (no worktreePath / no partyBranch on the row).
    // Lazy-setup tries setupPartyWorktree which throws if no bare repo —
    // operator must run /api/admin/migrate-brownfield first.
    const ctx = makeCtx();
    ctx.getSession = vi.fn(async () => ({
      sessionId: SESSION_ID,
      projectId: 'applicator',
      projectPath: worktreePath,
      // intentionally NO worktreePath / partyBranch — fresh session row.
      claudeSessionId: null,
      status: 'PROCESSING',
      turnCount: 0,
      createdAt: 'x',
      bmadVersionAtStart: '6.0.0-alpha.7',
      GSI1PK: 'applicator',
      GSI1SK: 'x',
    }));
    await expect(runPartyTurn(turnJob(), ctx)).rejects.toThrow(/WORKTREE_SETUP_FAILED/);
    expect(ctx.spawn).not.toHaveBeenCalled();
    const errorEvents = ctx.pushEvent.mock.calls.filter((c) => c[3] === 'party.turn.error');
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0][4].reason).toBe('WORKTREE_SETUP_FAILED');
  });
});

describe('Story 20.7 — spawn args carry --settings + bypassPermissions (AC 4.2)', () => {
  it('passes --settings <tmp> + --permission-mode bypassPermissions when V1 enabled', async () => {
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-1' }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);

    const [bin, args] = ctx.spawn.mock.calls[0];
    expect(bin).toBe('claude');
    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const settingsPath = args[settingsIdx + 1];
    expect(settingsPath).toMatch(/\/tmp\/party-settings-[a-f0-9]{8}\.json$/);
    expect(existsSync(settingsPath)).toBe(true);
    // Confirm the file content is well-formed JSON with PreToolUse hook.
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(content.hooks.PreToolUse[0].hooks[0].command).toMatch(/party-tool-hook\.sh$/);

    const permIdx = args.indexOf('--permission-mode');
    expect(args[permIdx + 1]).toBe('bypassPermissions');
  });
});

describe('Story 20.7 — cancel flow (AC 4.3)', () => {
  it('emits party.turn.cancelled when cancelRequested is true and poller observes it', async () => {
    const ctx = makeCtx({
      sessionsRepo: {
        // Flag is true from the start of the turn — first poll tick at 2.5s observes.
        getSession: vi.fn(async () => ({ cancelRequested: true })),
        clearCancelFlag: vi.fn(async () => {}),
      },
    });
    const child = fakeChild({
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-cancel' })],
      exitCode: 143,
      exitDelayMs: 3000, // long enough for the 2.5s poll tick to fire
    });
    ctx.spawn.mockReturnValue(child);

    const result = await runPartyTurn(turnJob(), ctx);

    expect(ctx.sessionsRepo.getSession).toHaveBeenCalled();
    expect(ctx.sessionsRepo.clearCancelFlag).toHaveBeenCalledWith(SESSION_ID);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const cancelledEvents = ctx.pushEvent.mock.calls.filter(
      (c) => c[3] === 'party.turn.cancelled',
    );
    expect(cancelledEvents.length).toBe(1);
    expect(cancelledEvents[0][4].reason).toBe('CANCELLED_BY_OPERATOR');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('CANCELLED');
  }, 10000);

  it('pre-spawn clearCancelFlag fires when V1 enabled (clears stale flags)', async () => {
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-x' }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);

    // Pre-spawn clear + post-close clear (via poller.stop) — at least 2 calls.
    expect(ctx.sessionsRepo.clearCancelFlag).toHaveBeenCalled();
  });
});

describe('Story 20.7 — default-allow stderr ingest (AC 4.4)', () => {
  it('emits party.tool.default-allow event when stderr contains the audit marker', async () => {
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-da' }),
          JSON.stringify({ type: 'result' }),
        ],
        stderrLines: [
          '[party-tool-hook] default-allow cmd=mkdir docs',
          'some other unrelated stderr',
          '[party-tool-hook] default-allow cmd=node -e "console.log(1)"',
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);

    const defaultAllowEvents = ctx.pushEvent.mock.calls.filter(
      (c) => c[3] === 'party.tool.default-allow',
    );
    expect(defaultAllowEvents.length).toBe(2);
    expect(defaultAllowEvents[0][4].cmd).toBe('mkdir docs');
    expect(defaultAllowEvents[1][4].cmd).toBe('node -e "console.log(1)"');
  });
});

describe('Story 20.7 — feature flag OFF preserves legacy spawn args', () => {
  it('with PARTY_PUSH_V1_ENABLED unset, args contain acceptEdits + no --settings', async () => {
    delete process.env.PARTY_PUSH_V1_ENABLED;
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cl-legacy' }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);

    const [, args] = ctx.spawn.mock.calls[0];
    expect(args).not.toContain('--settings');
    const permIdx = args.indexOf('--permission-mode');
    expect(args[permIdx + 1]).toBe('acceptEdits');
  });
});
