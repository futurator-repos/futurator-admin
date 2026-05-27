import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { runPartyTurn, PARTY_TURN_CONSTANTS } from '../party-turn.mjs';

const { PARTY_MODE_PREFIX } = PARTY_TURN_CONSTANTS;

/**
 * Build a fake child process that looks enough like a ChildProcess for the
 * turn pipeline. Stdout emits the provided stream-json lines (as separate
 * buffer chunks for realism); stderr is a no-op Readable.
 */
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
  // Minimal ChildProcess-like emitter. `kill` is a spy.
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    _stdinWrites: stdinWrites,
  });

  // Schedule emissions asynchronously so consumers can attach 'data' handlers first.
  queueMicrotask(() => {
    for (const line of stdoutLines) {
      stdout.push(`${line}\n`);
    }
    stdout.push(null);
    for (const line of stderrLines) {
      stderr.push(`${line}\n`);
    }
    stderr.push(null);
    setTimeout(() => child.emit('close', exitCode), exitDelayMs);
  });

  return child;
}

function makeCtx(overrides = {}) {
  const ctx = {
    pushEvent: vi.fn(async () => {}),
    getSession: vi.fn(async (sessionId) => ({
      sessionId,
      projectId: 'battleship',
      projectPath: '/tmp/party-proj',
      claudeSessionId: null,
      status: 'PROCESSING',
      turnCount: 0,
      createdAt: '2026-04-17T00:00:00.000Z',
      bmadVersionAtStart: '6.0.0-alpha.7',
      GSI1PK: 'battleship',
      GSI1SK: '2026-04-17T00:00:00.000Z',
    })),
    setClaudeSessionId: vi.fn(async () => {}),
    incrementTurn: vi.fn(async () => {}),
    releaseSessionLock: vi.fn(async () => {}),
    claudeBin: 'claude',
    spawn: vi.fn(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // Stub scoped-doc delivery — the real impl shells `aws s3 cp`.
    syncDocs: vi.fn(async () => []),
    ...overrides,
  };
  return ctx;
}

const turnJob = (content = 'hello party') => ({
  jobId: 'job-turn-1',
  jobType: 'party-turn',
  partyTurnPayload: { sessionId: '123e4567-e89b-12d3-a456-426614174000', content },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runPartyTurn — turn 1 (fresh session)', () => {
  it('writes the party-mode-prefixed prompt to stdin and does NOT pass --resume', async () => {
    const ctx = makeCtx();
    const child = fakeChild({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-abc' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi there' }] },
        }),
        JSON.stringify({ type: 'result' }),
      ],
      exitCode: 0,
    });
    ctx.spawn.mockReturnValue(child);

    const result = await runPartyTurn(turnJob('discuss this project'), ctx);
    expect(result.ok).toBe(true);
    expect(result.claudeSessionId).toBe('claude-abc');

    // Spawn args must NOT contain --resume; must be --print --output-format stream-json --verbose.
    const [, args] = ctx.spawn.mock.calls[0];
    expect(args).toContain('--print');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('--resume');

    // stdin received the party-mode prefix.
    const stdinJoined = child._stdinWrites.join('');
    expect(stdinJoined.startsWith(PARTY_MODE_PREFIX)).toBe(true);
    expect(stdinJoined).toContain('discuss this project');

    // Captured claudeSessionId persisted.
    expect(ctx.setClaudeSessionId).toHaveBeenCalledWith(
      '123e4567-e89b-12d3-a456-426614174000',
      'claude-abc',
    );

    // Events fired: user, assistant.token (text), completed.
    const eventTypes = ctx.pushEvent.mock.calls.map((c) => c[3]);
    expect(eventTypes).toContain('party.turn.user');
    expect(eventTypes).toContain('party.turn.assistant.token');
    expect(eventTypes).toContain('party.turn.completed');

    // Lock released ACTIVE; turnCount incremented.
    expect(ctx.incrementTurn).toHaveBeenCalledWith('123e4567-e89b-12d3-a456-426614174000');
    expect(ctx.releaseSessionLock).toHaveBeenCalledWith(
      '123e4567-e89b-12d3-a456-426614174000',
      'ACTIVE',
    );
  });
});

describe('runPartyTurn — scoped doc delivery', () => {
  it('appends delivered docs to --append-system-prompt as ./.party-uploads/ refs', async () => {
    const ctx = makeCtx({ syncDocs: vi.fn(async () => ['cohort.md', 'notes.txt']) });
    const child = fakeChild({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-docs' }),
        JSON.stringify({ type: 'result' }),
      ],
      exitCode: 0,
    });
    ctx.spawn.mockReturnValue(child);

    await runPartyTurn(turnJob('use the docs'), ctx);

    expect(ctx.syncDocs).toHaveBeenCalledOnce();
    const [, args] = ctx.spawn.mock.calls[0];
    const sysPrompt = args[args.indexOf('--append-system-prompt') + 1];
    expect(sysPrompt).toContain('Reference documents for this debate');
    expect(sysPrompt).toContain('./.party-uploads/cohort.md');
    expect(sysPrompt).toContain('./.party-uploads/notes.txt');
  });

  it('omits the docs note when no docs are delivered', async () => {
    const ctx = makeCtx({ syncDocs: vi.fn(async () => []) });
    const child = fakeChild({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-nodocs' }),
        JSON.stringify({ type: 'result' }),
      ],
      exitCode: 0,
    });
    ctx.spawn.mockReturnValue(child);

    await runPartyTurn(turnJob('no docs'), ctx);

    const [, args] = ctx.spawn.mock.calls[0];
    const sysPrompt = args[args.indexOf('--append-system-prompt') + 1];
    // The static contract mentions .party-uploads (the write-guidance note);
    // the per-session DOCS list is what must be absent when no docs exist.
    expect(sysPrompt).not.toContain('Reference documents for this debate');
  });
});

describe('runPartyTurn — turn N (resume)', () => {
  it('passes --resume <claudeSessionId> and does NOT include party-mode prefix', async () => {
    const ctx = makeCtx({
      getSession: vi.fn(async (sessionId) => ({
        sessionId,
        projectId: 'battleship',
        projectPath: '/tmp/party-proj',
        claudeSessionId: 'claude-existing',
        status: 'PROCESSING',
        turnCount: 1,
        createdAt: '2026-04-17T00:00:00.000Z',
        bmadVersionAtStart: '6.0.0-alpha.7',
        GSI1PK: 'battleship',
        GSI1SK: '2026-04-17T00:00:00.000Z',
      })),
    });
    const child = fakeChild({
      stdoutLines: [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'continuation' }] },
        }),
        JSON.stringify({ type: 'result' }),
      ],
      exitCode: 0,
    });
    ctx.spawn.mockReturnValue(child);

    await runPartyTurn(turnJob('tell me more'), ctx);

    const [, args] = ctx.spawn.mock.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('claude-existing');

    const stdinJoined = child._stdinWrites.join('');
    expect(stdinJoined.startsWith(PARTY_MODE_PREFIX)).toBe(false);
    expect(stdinJoined).toBe('tell me more');

    // Does not re-set claudeSessionId on turn N.
    expect(ctx.setClaudeSessionId).not.toHaveBeenCalled();
  });
});

describe('runPartyTurn — non-zero exit', () => {
  it('releases lock to ERROR and throws', async () => {
    const ctx = makeCtx();
    const child = fakeChild({
      stdoutLines: [],
      stderrLines: ['boom'],
      exitCode: 2,
    });
    ctx.spawn.mockReturnValue(child);

    await expect(runPartyTurn(turnJob(), ctx)).rejects.toThrow(/exited with code 2/);
    expect(ctx.releaseSessionLock).toHaveBeenCalledWith(
      '123e4567-e89b-12d3-a456-426614174000',
      'ERROR',
    );
    const errorEvents = ctx.pushEvent.mock.calls.filter((c) => c[3] === 'party.turn.error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0][4].reason).toBe('NON_ZERO_EXIT');
  });
});

describe('runPartyTurn — timeout', () => {
  it('SIGTERMs the child, releases lock ERROR, and throws', async () => {
    const ctx = makeCtx({ timeoutMs: 20 });
    // Build a child that never emits 'close' on its own — the watchdog must fire.
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    const stdinWrites = [];
    child.stdin = new Writable({
      write(chunk, _e, cb) {
        stdinWrites.push(chunk.toString('utf8'));
        cb();
      },
    });
    child.kill = vi.fn((signal) => {
      // Simulate the child eventually exiting after SIGTERM.
      if (signal === 'SIGTERM') {
        setTimeout(() => child.emit('close', 143), 5);
      }
    });
    ctx.spawn.mockReturnValue(child);

    await expect(runPartyTurn(turnJob(), { ...ctx, timeoutMs: 20 })).rejects.toThrow(/timeout/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ctx.releaseSessionLock).toHaveBeenCalledWith(
      '123e4567-e89b-12d3-a456-426614174000',
      'ERROR',
    );
    const errorEvents = ctx.pushEvent.mock.calls.filter((c) => c[3] === 'party.turn.error');
    expect(errorEvents[0][4].reason).toBe('TIMEOUT');
  });
});

describe('runPartyTurn — missing session', () => {
  it('throws when getSession returns null', async () => {
    const ctx = makeCtx({ getSession: vi.fn(async () => null) });
    await expect(runPartyTurn(turnJob(), ctx)).rejects.toThrow(/not found/);
    expect(ctx.spawn).not.toHaveBeenCalled();
  });
});

describe('runPartyTurn — Story 20.8 system-prompt marker contract', () => {
  it('appends the [CHECKPOINT_SUMMARY]: + [ASK_HUMAN]: marker explanation to --append-system-prompt', async () => {
    const ctx = makeCtx();
    const child = fakeChild({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-x' }),
        JSON.stringify({ type: 'result' }),
      ],
      exitCode: 0,
    });
    ctx.spawn.mockReturnValue(child);

    await runPartyTurn(turnJob('initial'), ctx);

    const [, args] = ctx.spawn.mock.calls[0];
    const sysIdx = args.indexOf('--append-system-prompt');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    const contractPayload = args[sysIdx + 1];
    expect(contractPayload).toContain('## Saving your work to git');
    expect(contractPayload).toContain('[CHECKPOINT_SUMMARY]:');
    expect(contractPayload).toContain('## Asking the human for input');
    expect(contractPayload).toContain('[ASK_HUMAN]:');
    // Keep the existing party-output-format contract intact alongside.
    expect(contractPayload).toContain('⟪AGENT:Name⟫');
    expect(contractPayload).toContain('⟪SYSTEM⟫');
  });
});

describe('runPartyTurn — payload validation', () => {
  it('throws when sessionId or content is missing', async () => {
    const ctx = makeCtx();
    await expect(
      runPartyTurn({ jobId: 'j', partyTurnPayload: {} }, ctx),
    ).rejects.toThrow(/sessionId and payload.content are required/);
    await expect(
      runPartyTurn({ jobId: 'j', partyTurnPayload: { sessionId: 'x' } }, ctx),
    ).rejects.toThrow(/content are required/);
  });
});
