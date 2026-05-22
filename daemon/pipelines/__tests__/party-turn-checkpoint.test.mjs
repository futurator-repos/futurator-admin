import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPartyTurn } from '../party-turn.mjs';

/**
 * Story 21.4 — checkpoint runner integration into party-turn.
 *
 * Verifies the post-turn flow:
 *   - When CHECKPOINT_SUMMARY is in the assistant text AND V1 is enabled
 *     AND the session has partyBranch + worktreePath, the daemon calls
 *     party-checkpoint.sh via the injected spawnSync.
 *   - The --push flag is added iff getProject returns pushEnabled=true.
 *   - The exit code maps to one of party.checkpoint.{composed|pushed|blocked|failed}.
 *   - When V1 is disabled OR no marker is present, the script is NOT called.
 */

const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';
const PARTY_BRANCH = `party/applicator/${SESSION_ID.slice(0, 8)}`;

function fakeChild({ stdoutLines = [], stderrLines = [], exitCode = 0, exitDelayMs = 5 } = {}) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
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

function makeSession() {
  return {
    sessionId: SESSION_ID,
    projectId: 'applicator',
    projectPath: worktreePath,
    worktreePath,
    partyBranch: PARTY_BRANCH,
    claudeSessionId: 'cl-1', // resumed, so isFirstTurn=false
    status: 'PROCESSING',
    turnCount: 3,
    createdAt: '2026-05-21T00:00:00Z',
    bmadVersionAtStart: '6.0.0-alpha.7',
    GSI1PK: 'applicator',
    GSI1SK: '2026-05-21T00:00:00Z',
  };
}

// Assistant text that contains a CHECKPOINT_SUMMARY marker the extractor
// will pick up.
const CHECKPOINT_ASSISTANT_TEXT = `Some agent prose here.

[CHECKPOINT_SUMMARY]: feat: cohort architecture v0.1
Covers profile-maturity scoring + the DDB schema sketch.
Open: facilitator search.
`;

function makeCtx(overrides = {}) {
  return {
    pushEvent: vi.fn(async () => {}),
    getSession: vi.fn(async () => makeSession()),
    getProject: vi.fn(async () => ({ projectId: 'applicator', pushEnabled: false })),
    setClaudeSessionId: vi.fn(async () => {}),
    incrementTurn: vi.fn(async () => {}),
    releaseSessionLock: vi.fn(async () => {}),
    sessionsRepo: {
      getSession: vi.fn(async () => ({ cancelRequested: false })),
      clearCancelFlag: vi.fn(async () => {}),
    },
    claudeBin: 'claude',
    spawn: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0, stdout: 'STATUS_PORCELAIN_EMPTY\n', stderr: '' })),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

const turnJob = (content = 'do the work') => ({
  jobId: 'job-ck-1',
  jobType: 'party-turn',
  partyTurnPayload: { sessionId: SESSION_ID, content },
});

beforeEach(() => {
  process.env.PARTY_PUSH_V1_ENABLED = '1';
  worktreePath = mkdtempSync(join(tmpdir(), 'party-turn-ckpt-'));
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.PARTY_PUSH_V1_ENABLED;
  if (worktreePath && existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  const sidShort = SESSION_ID.slice(0, 8);
  const settingsPath = `/tmp/party-settings-${sidShort}.json`;
  if (existsSync(settingsPath)) unlinkSync(settingsPath);
});

describe('Story 21.4 — checkpoint runner integration', () => {
  it('skips checkpoint when no CHECKPOINT_SUMMARY marker is in assistant text', async () => {
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'just some prose, no marker' }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    expect(ctx.spawnSync).not.toHaveBeenCalled();
    const ckptEvents = ctx.pushEvent.mock.calls.filter((c) => String(c[3]).startsWith('party.checkpoint.'));
    expect(ckptEvents.length).toBe(0);
  });

  it('runs party-checkpoint.sh and emits party.checkpoint.composed when push gated off', async () => {
    const ctx = makeCtx();
    ctx.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'PUSH_SKIPPED: project pushEnabled=false\nabcdef0123456789abcdef0123456789abcdef01\n',
      stderr: '',
    });
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: CHECKPOINT_ASSISTANT_TEXT }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    expect(ctx.spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args, _opts] = ctx.spawnSync.mock.calls[0];
    expect(bin).toBe('bash');
    // Args = [scriptPath, branch, worktreePath]  (NO --push because pushEnabled=false)
    expect(args[1]).toBe(PARTY_BRANCH);
    expect(args[2]).toBe(worktreePath);
    expect(args).not.toContain('--push');
    const composed = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.checkpoint.composed');
    expect(composed).toBeTruthy();
    expect(composed[4].commitSha).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(composed[4].pushed).toBe(false);
    expect(composed[4].branch).toBe(PARTY_BRANCH);
    expect(composed[4].round).toBe(3);
    expect(composed[4].reason).toBe('COMPOSED');
  });

  it('adds --push and emits party.checkpoint.pushed when project.pushEnabled=true', async () => {
    const ctx = makeCtx({
      getProject: vi.fn(async () => ({ projectId: 'applicator', pushEnabled: true })),
    });
    ctx.spawnSync.mockReturnValue({
      status: 0,
      stdout: `PUSHED: origin ${PARTY_BRANCH} @ abcdef0123456789abcdef0123456789abcdef01\nabcdef0123456789abcdef0123456789abcdef01\n`,
      stderr: '',
    });
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: CHECKPOINT_ASSISTANT_TEXT }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    const args = ctx.spawnSync.mock.calls[0][1];
    expect(args).toContain('--push');
    const pushed = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.checkpoint.pushed');
    expect(pushed).toBeTruthy();
    expect(pushed[4].pushed).toBe(true);
    expect(pushed[4].reason).toBe('PUSHED');
  });

  it('emits party.checkpoint.blocked on exit 2 (secrets hit)', async () => {
    const ctx = makeCtx();
    ctx.spawnSync.mockReturnValue({
      status: 2,
      stdout: '',
      stderr: 'SECRETS_HIT: pattern=AKIA...',
    });
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: CHECKPOINT_ASSISTANT_TEXT }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    const blocked = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.checkpoint.blocked');
    expect(blocked).toBeTruthy();
    expect(blocked[4].reason).toBe('SECRETS_HIT');
    expect(blocked[4].commitSha).toBeNull();
  });

  it('emits party.checkpoint.failed on exit 5 (push attempted but failed)', async () => {
    const ctx = makeCtx({
      getProject: vi.fn(async () => ({ projectId: 'applicator', pushEnabled: true })),
    });
    ctx.spawnSync.mockReturnValue({
      status: 5,
      stdout: 'abcdef0123456789abcdef0123456789abcdef01\n',
      stderr: 'PUSH_FAILED: AUTH_DENIED',
    });
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: CHECKPOINT_ASSISTANT_TEXT }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    const failed = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.checkpoint.failed');
    expect(failed).toBeTruthy();
    expect(failed[4].reason).toBe('PUSH_FAILED');
    expect(failed[4].commitSha).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(failed[4].pushed).toBe(false);
  });

  it('does NOT call checkpoint when V1 is disabled (legacy path)', async () => {
    delete process.env.PARTY_PUSH_V1_ENABLED;
    const ctx = makeCtx();
    ctx.spawn.mockReturnValue(
      fakeChild({
        stdoutLines: [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: CHECKPOINT_ASSISTANT_TEXT }] },
          }),
          JSON.stringify({ type: 'result' }),
        ],
        exitCode: 0,
      }),
    );

    await runPartyTurn(turnJob(), ctx);
    expect(ctx.spawnSync).not.toHaveBeenCalled();
  });
});
