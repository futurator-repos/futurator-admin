import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { runQueueRequest } from '../queue-request.mjs';

/**
 * Fake `claude` child. Emits the provided stream-json lines on stdout, then
 * closes with `exitCode`. `stderr` lines (if any) are emitted before close.
 */
function makeFakeSpawn({ stdoutLines = [], stderrLines = [], exitCode = 0, error = null }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    // Emit asynchronously so the caller can attach close/error handlers first.
    queueMicrotask(() => {
      for (const l of stdoutLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      for (const l of stderrLines) child.stderr.emit('data', Buffer.from(l + '\n'));
      if (error) child.emit('error', error);
      else child.emit('close', exitCode);
    });
    return child;
  };
}

function makeCtx(overrides = {}) {
  const events = [];
  const updates = [];
  return {
    events,
    updates,
    ctx: {
      pushEvent: vi.fn(async (jobId, step, agent, type, data) => {
        events.push({ type, data });
      }),
      updateRequest: vi.fn(async (requestId, patch) => {
        updates.push(patch);
      }),
      claudeBin: 'claude',
      nowIso: () => '2026-07-09T00:00:00.000Z',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    },
  };
}

const JOB = {
  jobId: 'job-1',
  queueRequestPayload: { requestId: 'req-1', prompt: 'say hi', source: 'test', target: 'ec2' },
};

describe('runQueueRequest — happy path', () => {
  it('streams tokens, assembles the result, and marks COMPLETED', async () => {
    const { ctx, events, updates } = makeCtx({
      spawn: makeFakeSpawn({
        stdoutLines: [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi ' }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'there' }] } }),
          JSON.stringify({ type: 'result', result: 'Hi there', is_error: false }),
        ],
        exitCode: 0,
      }),
    });

    const out = await runQueueRequest(JOB, ctx);

    expect(out.ok).toBe(true);
    expect(out.result).toBe('Hi there');
    // First update flips RUNNING; a later update writes COMPLETED + response.
    expect(updates.some((u) => u.status === 'RUNNING')).toBe(true);
    const completed = updates.find((u) => u.status === 'COMPLETED');
    expect(completed).toBeTruthy();
    expect(completed.response.ok).toBe(true);
    expect(completed.response.result).toBe('Hi there');
    // A live-terminal result event was emitted.
    expect(events.some((e) => e.type === 'queue.result' && e.data.ok === true)).toBe(true);
  });
});

describe('runQueueRequest — failure path', () => {
  it('marks FAILED on a non-zero exit', async () => {
    const { ctx, updates } = makeCtx({
      spawn: makeFakeSpawn({ stdoutLines: [], stderrLines: ['boom'], exitCode: 1 }),
    });
    const out = await runQueueRequest(JOB, ctx);
    expect(out.ok).toBe(false);
    expect(updates.find((u) => u.status === 'FAILED')).toBeTruthy();
  });
});

describe('runQueueRequest — auto-respond', () => {
  it('POSTs the standard envelope to callbackUrl and marks RESPONDED', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const job = {
      jobId: 'job-2',
      queueRequestPayload: {
        requestId: 'req-2',
        prompt: 'hi',
        autoRespond: true,
        callbackUrl: 'https://example.test/webhook',
      },
    };
    const { ctx, updates } = makeCtx({
      fetchImpl,
      spawn: makeFakeSpawn({
        stdoutLines: [JSON.stringify({ type: 'result', result: 'done', is_error: false })],
        exitCode: 0,
      }),
    });
    await runQueueRequest(job, ctx);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(updates.find((u) => u.status === 'RESPONDED')).toBeTruthy();
  });
});

describe('runQueueRequest — validation', () => {
  it('throws when the prompt is missing', async () => {
    const { ctx } = makeCtx({ spawn: makeFakeSpawn({}) });
    await expect(
      runQueueRequest({ jobId: 'j', queueRequestPayload: { requestId: 'r' } }, ctx),
    ).rejects.toThrow(/prompt is required/);
  });
});
