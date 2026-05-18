import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

import { runFreeAgentSession } from '../free-agent-session.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killSignals = [];
  }
  kill(sig) {
    this.killSignals.push(sig);
    this.killed = true;
  }
}

function makePushEvent() {
  return vi.fn(async () => {});
}

function makeSessionsRepo(overrides = {}) {
  const baseSession = {
    sessionId: 'sid-1',
    operatorId: 'op-rick',
    projectId: 'dino-7',
    status: 'PROCESSING',
    turnCount: 0,
    costUsdAccumulated: 0,
    ...overrides.baseSession,
  };
  return {
    acquireProcessingLock: vi.fn(async () => ({ ok: true })),
    releaseProcessingLock: vi.fn(async () => {}),
    setClaudeSessionId: vi.fn(async () => {}),
    getSession: vi.fn(async () => baseSession),
    incrementTurn: vi.fn(async () => {}),
    updateCostUsd: vi.fn(async () => {}),
    updateTokens: vi.fn(async () => {}),
    markBudgetExhausted: vi.fn(async () => {}),
    markError: vi.fn(async () => {}),
    clearCancelFlag: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeWorktreeHelpers() {
  return {
    ensureWorktree: vi.fn(async () => ({
      worktreePath: '/home/ubuntu/free-agent-worktrees/dino-7/sid-1',
      branchName: 'assist/dino-7/sid-1',
      skipped: false,
    })),
    writeFreeAgentSettings: vi.fn(),
    writeAgentMd: vi.fn(() => ({ finalPath: '/path/to/AGENT.md', bytes: 1234 })),
  };
}

function makeJob(payloadOverrides = {}) {
  return {
    jobId: 'job-1',
    jobType: 'free-agent-session',
    freeAgentSessionPayload: {
      sessionId: 'sid-1',
      projectId: 'dino-7',
      scope: { kind: 'plan', id: 'plan-abc' },
      model: 'sonnet',
      costCapUsd: 10,
      credentials: {
        accessKeyId: 'ASIATEST1234567890XX',
        secretAccessKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sessionToken: 'tok-xyz',
        expiration: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      messages: [{ role: 'user', content: 'investigate plan dino-7' }],
      ...payloadOverrides,
    },
  };
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('runFreeAgentSession — first-turn spawn args (AC #2)', () => {
  it('spawns claude -p with correct args + env + cwd', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();
    const worktreeHelpers = makeWorktreeHelpers();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers,
      spawn,
      logger: silentLogger(),
    });

    // Push a system.init event then close cleanly.
    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-xyz' }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.03 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    const result = await promise;

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('claude');

    // Required arg presence
    expect(args).toContain('--print');
    expect(args).toContain('investigate plan dino-7');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('10');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--add-dir');
    expect(args).toContain('/home/ubuntu/free-agent-worktrees/dino-7/sid-1');
    // First turn: --session-id, not --resume
    expect(args).toContain('--session-id');
    expect(args).toContain('sid-1');
    expect(args).not.toContain('--resume');
    // System-prompt nudge points the agent at AGENT.md (2026-05-18 fix —
    // without this the agent doesn't know it has AWS DDB access).
    expect(args).toContain('--append-system-prompt');
    const sysPromptIdx = args.indexOf('--append-system-prompt');
    expect(args[sysPromptIdx + 1]).toMatch(/AGENT\.md/);

    // cwd + env shape
    expect(opts.cwd).toBe('/home/ubuntu/free-agent-worktrees/dino-7/sid-1');
    expect(opts.env.AWS_ACCESS_KEY_ID).toBe('ASIATEST1234567890XX');
    expect(opts.env.AWS_SECRET_ACCESS_KEY).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(opts.env.AWS_SESSION_TOKEN).toBe('tok-xyz');
    expect(opts.env.FREE_AGENT_CONFINEMENT_ROOT).toBe(
      '/home/ubuntu/free-agent-worktrees/dino-7/sid-1',
    );

    // Worktree create + settings called BEFORE spawn
    expect(worktreeHelpers.ensureWorktree).toHaveBeenCalledWith({
      projectId: 'dino-7',
      sessionId: 'sid-1',
    });
    expect(worktreeHelpers.writeFreeAgentSettings).toHaveBeenCalledTimes(1);
    // AGENT.md refreshed every turn with current scope/project context.
    expect(worktreeHelpers.writeAgentMd).toHaveBeenCalledTimes(1);
    expect(worktreeHelpers.writeAgentMd).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/home/ubuntu/free-agent-worktrees/dino-7/sid-1',
        projectId: 'dino-7',
        sessionId: 'sid-1',
        scope: { kind: 'plan', id: 'plan-abc' },
        planId: 'plan-abc',
      }),
    );

    // Lock is pre-acquired by the API Lambda before enqueue; daemon does NOT
    // re-acquire (would deadlock against the API's own PROCESSING write).
    // It only releases back to ACTIVE on success.
    expect(sessionsRepo.acquireProcessingLock).not.toHaveBeenCalled();
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ACTIVE');
    expect(sessionsRepo.incrementTurn).toHaveBeenCalledWith('sid-1');
    expect(sessionsRepo.updateCostUsd).toHaveBeenCalledWith('sid-1', 0.03);
    expect(sessionsRepo.setClaudeSessionId).toHaveBeenCalledWith('sid-1', 'claude-xyz');
  });
});

describe('runFreeAgentSession — FREE_AGENT_SESSION_ID env (Story 18.3 AC #1)', () => {
  it('passes FREE_AGENT_SESSION_ID in the spawn env (for the commit-msg hook)', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo: makeSessionsRepo(),
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.01 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;
    const [, , opts] = spawn.mock.calls[0];
    expect(opts.env.FREE_AGENT_SESSION_ID).toBe('sid-1');
  });
});

describe('runFreeAgentSession — token accumulation (Story 18.3 AC #3)', () => {
  it('parses usage.input_tokens + usage.output_tokens from result event and calls updateTokens', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            total_cost_usd: 0.02,
            usage: { input_tokens: 100, output_tokens: 50 },
          }) + '\n',
        ),
      );
      child.emit('close', 0);
    }, 5);

    await promise;
    expect(sessionsRepo.updateTokens).toHaveBeenCalledWith('sid-1', 100, 50);
  });

  it('sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens for tokensIn', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            total_cost_usd: 0.03,
            usage: {
              input_tokens: 50,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 20,
              output_tokens: 10,
            },
          }) + '\n',
        ),
      );
      child.emit('close', 0);
    }, 5);

    await promise;
    // tokensIn = 50 + 30 + 20 = 100; tokensOut = 10
    expect(sessionsRepo.updateTokens).toHaveBeenCalledWith('sid-1', 100, 10);
  });

  it('does not call updateTokens when no usage fields present', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.01 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;
    expect(sessionsRepo.updateTokens).not.toHaveBeenCalled();
  });

  it('gracefully handles repo facades without updateTokens (backward compat)', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();
    delete sessionsRepo.updateTokens; // simulate a facade that doesn't yet implement it

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            total_cost_usd: 0.01,
            usage: { input_tokens: 100, output_tokens: 50 },
          }) + '\n',
        ),
      );
      child.emit('close', 0);
    }, 5);

    const result = await promise;
    expect(result.ok).toBe(true); // no throw
  });
});

describe('runFreeAgentSession — follow-up turn uses --resume (AC #3)', () => {
  it('passes --resume <claudeSessionId> and NOT --session-id when claudeSessionId exists', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo({
      baseSession: {
        sessionId: 'sid-1',
        operatorId: 'op-rick',
        projectId: 'dino-7',
        status: 'PROCESSING',
        turnCount: 3,
        costUsdAccumulated: 0.5,
        claudeSessionId: 'claude-pre-existing',
      },
    });

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.05 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;

    const [, args] = spawn.mock.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('claude-pre-existing');
    expect(args).not.toContain('--session-id');

    // setClaudeSessionId NOT called again on follow-up turn
    expect(sessionsRepo.setClaudeSessionId).not.toHaveBeenCalled();
  });
});

describe('runFreeAgentSession — stream parsing (AC #3)', () => {
  it('emits free-agent.turn.token for assistant text blocks', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const pushEvent = makePushEvent();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent,
      sessionsRepo: makeSessionsRepo(),
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Hello!' }] },
          }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.01 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;

    const tokenEvents = pushEvent.mock.calls.filter((c) => c[3] === 'free-agent.turn.token');
    expect(tokenEvents.length).toBe(1);
    expect(tokenEvents[0][4]).toMatchObject({ text: 'Hello!' });
  });

  it('emits free-agent.turn.tool_use for assistant tool_use blocks', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const pushEvent = makePushEvent();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent,
      sessionsRepo: makeSessionsRepo(),
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.md' } }],
            },
          }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0.01 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;

    const toolEvents = pushEvent.mock.calls.filter((c) => c[3] === 'free-agent.turn.tool_use');
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0][4].tool).toMatchObject({ id: 'tu-1', name: 'Read' });
  });
});

describe('runFreeAgentSession — cost-cap exit detection (AC #5)', () => {
  it('marks BUDGET_EXHAUSTED on non-zero exit + is_error + budget signal', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();
    const pushEvent = makePushEvent();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent,
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'result',
            is_error: true,
            total_cost_usd: 10.42,
            error: { message: 'budget exhausted: max_budget_usd reached' },
          }) + '\n',
        ),
      );
      child.emit('close', 1);
    }, 5);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('BUDGET_EXHAUSTED');
    expect(sessionsRepo.markBudgetExhausted).toHaveBeenCalledWith('sid-1');
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'BUDGET_EXHAUSTED');
    expect(sessionsRepo.updateCostUsd).toHaveBeenCalledWith('sid-1', 10.42);

    const budgetEvents = pushEvent.mock.calls.filter((c) => c[3] === 'free-agent.budget.exhausted');
    expect(budgetEvents.length).toBe(1);
  });

  it('treats non-zero exit WITHOUT budget signal as plain NON_ZERO_EXIT (markError)', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('boom\n'));
      child.emit('close', 1);
    }, 5);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NON_ZERO_EXIT');
    expect(sessionsRepo.markError).toHaveBeenCalledWith('sid-1', 'NON_ZERO_EXIT:1');
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ERROR');
    expect(sessionsRepo.markBudgetExhausted).not.toHaveBeenCalled();
  });
});

describe('runFreeAgentSession — watchdog (AC #6)', () => {
  it('SIGTERMs then SIGKILLs on timeout and marks TIMEOUT', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();
    const pushEvent = makePushEvent();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent,
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      timeoutMs: 600_000,
      logger: silentLogger(),
    });

    // Advance past the watchdog → SIGTERM fires.
    await vi.advanceTimersByTimeAsync(600_001);
    expect(child.killSignals).toContain('SIGTERM');

    // Advance past KILL_GRACE_MS → SIGKILL fires.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(child.killSignals).toContain('SIGKILL');

    // Simulate child finally exiting.
    child.emit('close', 137);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('TIMEOUT');
    expect(sessionsRepo.markError).toHaveBeenCalledWith('sid-1', 'TIMEOUT');
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ERROR');

    const errorEvents = pushEvent.mock.calls.filter((c) => c[3] === 'free-agent.turn.error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0][4]).toMatchObject({ reason: 'TIMEOUT' });
  });
});

describe('runFreeAgentSession — lock acquisition contract (AC #7)', () => {
  it('does NOT call acquireProcessingLock — API Lambda pre-acquires before enqueue', async () => {
    // Regression guard for the double-lock-acquire deadlock that stranded
    // session d6547d46-e23a-446d-8df1-6c52e84df6a4 on 2026-05-18: API moved
    // status to PROCESSING, then daemon tried to re-acquire and ALWAYS hit
    // SESSION_BUSY. The session would have been re-acquirable only if the
    // status were ACTIVE — which it isn't after the API's own write.
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    // Emit a minimal stream-json so the handler exits cleanly.
    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-xyz' }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;

    expect(sessionsRepo.acquireProcessingLock).not.toHaveBeenCalled();
    // But the release-on-completion path still fires.
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ACTIVE');
  });
});

describe('runFreeAgentSession — worktree failure handling', () => {
  it('marks ERROR + releases lock on ensureWorktree throw', async () => {
    const sessionsRepo = makeSessionsRepo();
    const worktreeHelpers = {
      ensureWorktree: vi.fn(async () => {
        throw new Error('bare repo not found');
      }),
      writeFreeAgentSettings: vi.fn(),
    };

    await expect(
      runFreeAgentSession(makeJob(), {
        pushEvent: makePushEvent(),
        sessionsRepo,
        worktreeHelpers,
        spawn: vi.fn(),
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/bare repo not found/);

    expect(sessionsRepo.markError).toHaveBeenCalledWith(
      'sid-1',
      expect.stringContaining('WORKTREE_FAILURE'),
    );
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ERROR');
  });
});

describe('runFreeAgentSession — Cmd+Shift+4 image attachments', () => {
  it('decodes payload images, writes to .agent-attachments/, and prepends prompt with file refs', async () => {
    // Use a real tmp dir for the worktree so writeAttachments can actually
    // mkdir + write decoded bytes. We then read the file back to verify the
    // base64 decode round-trip.
    const tmpWt = mkdtempSync(pathJoin(tmpdir(), 'free-agent-attach-test-'));
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();
    const worktreeHelpers = {
      ensureWorktree: vi.fn(async () => ({
        worktreePath: tmpWt,
        branchName: 'assist/dino-7/sid-1',
        skipped: false,
      })),
      writeFreeAgentSettings: vi.fn(),
      writeAgentMd: vi.fn(),
    };

    // 1×1 transparent PNG; base64 is well under any threshold so no risk of
    // canvas-related failure.
    const onePxPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const job = makeJob({
      messages: [
        {
          role: 'user',
          content: 'what is in this image?',
          images: [{ mediaType: 'image/png', base64: onePxPng }],
        },
      ],
    });

    const promise = runFreeAgentSession(job, {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers,
      spawn,
      logger: silentLogger(),
    });

    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-xyz' }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = spawn.mock.calls[0];
    const printIdx = args.indexOf('--print');
    expect(printIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[printIdx + 1];
    // Attachment directive prepended; user's text preserved.
    expect(prompt).toMatch(/\.agent-attachments\/0\.png/);
    expect(prompt).toContain('what is in this image?');
    expect(prompt).toMatch(/Read.*before answering/i);

    // File round-trip: directory created, image bytes decoded correctly.
    const expectedPath = pathJoin(tmpWt, '.agent-attachments', '0.png');
    expect(existsSync(expectedPath)).toBe(true);
    const decoded = readFileSync(expectedPath);
    // PNG magic header.
    expect(decoded[0]).toBe(0x89);
    expect(decoded[1]).toBe(0x50);
    expect(decoded[2]).toBe(0x4e);
    expect(decoded[3]).toBe(0x47);

    rmSync(tmpWt, { recursive: true, force: true });
  });

  it('does NOT prepend directive when images array is absent', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const sessionsRepo = makeSessionsRepo();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent: makePushEvent(),
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });
    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c' }) + '\n',
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n'),
      );
      child.emit('close', 0);
    }, 5);

    await promise;
    const [, args] = spawn.mock.calls[0];
    const printIdx = args.indexOf('--print');
    const prompt = args[printIdx + 1];
    expect(prompt).not.toMatch(/\.agent-attachments/);
    expect(prompt).not.toMatch(/Read.*before answering/i);
  });
});

describe('runFreeAgentSession — operator cancel (Stop button)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('kills subprocess + releases lock to ACTIVE + emits cancelled event when cancelRequested flips true', async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    // First getSession (pre-spawn) returns baseSession. Subsequent calls
    // (cancel poller) return a row with cancelRequested=true on the 2nd hit.
    let getCallCount = 0;
    const sessionsRepo = makeSessionsRepo({
      getSession: vi.fn(async () => {
        getCallCount += 1;
        return getCallCount >= 2
          ? { sessionId: 'sid-1', status: 'PROCESSING', cancelRequested: true, turnCount: 0 }
          : { sessionId: 'sid-1', status: 'PROCESSING', turnCount: 0 };
      }),
    });
    const pushEvent = makePushEvent();

    const promise = runFreeAgentSession(makeJob(), {
      pushEvent,
      sessionsRepo,
      worktreeHelpers: makeWorktreeHelpers(),
      spawn,
      logger: silentLogger(),
    });

    // Advance to trigger the cancel poller (2.5s interval).
    await vi.advanceTimersByTimeAsync(2_600);
    // Child should have been killed.
    expect(child.killSignals).toContain('SIGTERM');

    // Simulate the child exiting after SIGTERM.
    child.emit('close', 143);

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject({ ok: false, reason: 'CANCELLED' });
    // Cancelled event emitted (not a generic error).
    const cancelledCalls = pushEvent.mock.calls.filter(
      (c) => c[3] === 'free-agent.turn.cancelled',
    );
    expect(cancelledCalls.length).toBe(1);
    // Session released back to ACTIVE (NOT ERROR — user can keep chatting).
    expect(sessionsRepo.releaseProcessingLock).toHaveBeenCalledWith('sid-1', 'ACTIVE');
    expect(sessionsRepo.markError).not.toHaveBeenCalled();
    // Cancel flag cleared after handoff.
    expect(sessionsRepo.clearCancelFlag).toHaveBeenCalled();
  });
});

describe('runFreeAgentSession — payload validation', () => {
  it('rejects payload missing sessionId', async () => {
    const job = makeJob();
    delete job.freeAgentSessionPayload.sessionId;
    await expect(
      runFreeAgentSession(job, {
        pushEvent: makePushEvent(),
        sessionsRepo: makeSessionsRepo(),
        worktreeHelpers: makeWorktreeHelpers(),
        spawn: vi.fn(),
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/payload requires/);
  });

  it('rejects payload with no user message', async () => {
    const job = makeJob({ messages: [{ role: 'assistant', content: 'hi' }] });
    await expect(
      runFreeAgentSession(job, {
        pushEvent: makePushEvent(),
        sessionsRepo: makeSessionsRepo(),
        worktreeHelpers: makeWorktreeHelpers(),
        spawn: vi.fn(),
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/user message/);
  });
});
