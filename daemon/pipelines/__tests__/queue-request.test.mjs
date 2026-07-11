import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { runQueueRequest, queueResponseHeaders } from '../queue-request.mjs';

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
    // Dispatch provenance is stamped onto the response.
    expect(completed.response.dispatcher).toBeTruthy();
    expect(typeof completed.response.dispatcher.source).toBe('string');
    expect(completed.response.dispatcher.host).toBeTruthy();
    expect(completed.response.dispatcher.model).toBe('default');
    expect(completed.response.dispatcher.completedAt).toBe('2026-07-09T00:00:00.000Z');
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
    // The callback POST carries the standard X-Futurator-* tracking headers.
    const sentHeaders = fetchImpl.mock.calls[0][1].headers;
    expect(sentHeaders['x-futurator-request-id']).toBe('req-2');
    expect(sentHeaders['x-futurator-status']).toBe('COMPLETED');
    expect(sentHeaders['x-futurator-ok']).toBe('true');
    expect(sentHeaders['x-futurator-dispatcher']).toBeTruthy();
    expect(sentHeaders['x-futurator-host']).toBeTruthy();
    expect(updates.find((u) => u.status === 'RESPONDED')).toBeTruthy();
  });
});

describe('queueResponseHeaders', () => {
  it('maps an envelope + dispatcher to X-Futurator-* headers', () => {
    const h = queueResponseHeaders({
      requestId: 'r-9',
      status: 'COMPLETED',
      ok: true,
      completedAt: '2026-07-11T00:00:00.000Z',
      dispatcher: { source: 'ec2', host: 'box-1', model: 'claude-opus-4-8', durationMs: 1200 },
    });
    expect(h['x-futurator-request-id']).toBe('r-9');
    expect(h['x-futurator-status']).toBe('COMPLETED');
    expect(h['x-futurator-ok']).toBe('true');
    expect(h['x-futurator-dispatcher']).toBe('ec2');
    expect(h['x-futurator-host']).toBe('box-1');
    expect(h['x-futurator-model']).toBe('claude-opus-4-8');
    expect(h['x-futurator-completed-at']).toBe('2026-07-11T00:00:00.000Z');
    expect(h['x-futurator-duration-ms']).toBe('1200');
  });

  it('tolerates a missing dispatcher (empty strings, no throw)', () => {
    const h = queueResponseHeaders({ requestId: 'r', status: 'FAILED', ok: false });
    expect(h['x-futurator-ok']).toBe('false');
    expect(h['x-futurator-dispatcher']).toBe('');
    expect(h['x-futurator-host']).toBe('');
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
