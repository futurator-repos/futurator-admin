/**
 * story-dev-events.test.mjs — G1 unit tests.
 *
 * Tests cover:
 *   • Exported constants
 *   • ingest() routing: stream_event/text_delta, assistant/tool_use, tool_result
 *   • result event capture → finalResult + metrics getter
 *   • line-buffer carry across chunk boundaries
 *   • finalize() flushes trailing partial line
 *   • Non-JSON lines ignored silently
 *   • pushEvent not injected → no calls, no throw (unit test safety)
 *   • Async pushEvent rejection → swallowed via logger.warn
 *   • Sync pushEvent throw → swallowed via logger.warn
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createStoryEventStream,
  STORY_DEV_STEP_ID,
  STORY_DEV_AGENT_ID,
} from '../story-dev-events.mjs';

const JOB_ID = 'job-test-001';

// ── Constants ──────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('STORY_DEV_STEP_ID is story-dev', () => {
    expect(STORY_DEV_STEP_ID).toBe('story-dev');
  });

  it('STORY_DEV_AGENT_ID is dev', () => {
    expect(STORY_DEV_AGENT_ID).toBe('dev');
  });
});

// ── createStoryEventStream — interface shape ───────────────────────────────────

describe('createStoryEventStream — interface', () => {
  it('returns the expected interface', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID });
    expect(typeof stream.ingest).toBe('function');
    expect(typeof stream.finalize).toBe('function');
    expect(typeof stream.emitStepStart).toBe('function');
    expect(typeof stream.emitStepComplete).toBe('function');
    expect(typeof stream.emitStepError).toBe('function');
    expect(stream.metrics).toEqual({});
    expect(stream.finalResult).toBeNull();
  });

  it('defaults stepId and agentId to the exported constants', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'x' } } };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'text_delta', { text: 'x' });
  });
});

// ── ingest() routing ───────────────────────────────────────────────────────────

describe('ingest — stream_event text_delta', () => {
  it('routes text to pushEvent as text_delta', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = {
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'hello world' } },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'text_delta', { text: 'hello world' });
  });

  it('ignores stream_event when delta type is not text_delta', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = {
      type: 'stream_event',
      event: { delta: { type: 'content_block_start' } },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).not.toHaveBeenCalled();
  });
});

describe('ingest — assistant block routing', () => {
  it('routes tool_use block to pushEvent as tool_use', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } }],
      },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'tool_use', {
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: '/src/app.ts' }),
    });
  });

  it('slices toolInput to 2000 chars', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const bigInput = { content: 'x'.repeat(3000) };
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: bigInput }] },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledOnce();
    const toolInput = pushEvent.mock.calls[0][4].toolInput;
    expect(toolInput.length).toBeLessThanOrEqual(2000);
  });

  it('routes text block inside assistant to text_delta', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reasoning output' }] },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'text_delta', { text: 'reasoning output' });
  });

  it('handles multiple content blocks in one assistant event', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    stream.ingest(JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent.mock.calls[0][3]).toBe('text_delta');
    expect(pushEvent.mock.calls[1][3]).toBe('tool_use');
  });
});

describe('ingest — tool_result routing', () => {
  it('routes string output to tool_result', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.ingest(JSON.stringify({ type: 'tool_result', output: 'file content here' }) + '\n');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'tool_result', { toolOutput: 'file content here' });
  });

  it('slices tool_result output to 2000 chars when string', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.ingest(JSON.stringify({ type: 'tool_result', output: 'y'.repeat(3000) }) + '\n');
    expect(pushEvent.mock.calls[0][4].toolOutput.length).toBeLessThanOrEqual(2000);
  });

  it('JSON-serialises non-string tool_result output before slicing', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.ingest(JSON.stringify({ type: 'tool_result', output: { result: 'ok' } }) + '\n');
    const toolOutput = pushEvent.mock.calls[0][4].toolOutput;
    expect(typeof toolOutput).toBe('string');
    expect(toolOutput).toContain('result');
  });
});

// ── result event → finalResult + metrics ──────────────────────────────────────

describe('ingest — result event capture', () => {
  const resultEvent = {
    type: 'result',
    total_cost_usd: 0.042,
    session_id: 'sess-abc123',
    num_turns: 9,
    usage: { input_tokens: 4500, output_tokens: 1200 },
  };

  it('captures result event into finalResult', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID });
    stream.ingest(JSON.stringify(resultEvent) + '\n');
    expect(stream.finalResult).toEqual(resultEvent);
  });

  it('metrics getter returns costUsd, tokens, sessionId, numTurns', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID });
    stream.ingest(JSON.stringify(resultEvent) + '\n');
    expect(stream.metrics).toEqual({
      costUsd: 0.042,
      inputTokens: 4500,
      outputTokens: 1200,
      sessionId: 'sess-abc123',
      numTurns: 9,
    });
  });

  it('metrics returns {} when no result event received yet', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID });
    expect(stream.metrics).toEqual({});
  });

  it('does not push result event to pushEvent', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.ingest(JSON.stringify(resultEvent) + '\n');
    expect(pushEvent).not.toHaveBeenCalled();
  });
});

// ── line-buffer carry ──────────────────────────────────────────────────────────

describe('ingest — line-buffer carry', () => {
  it('handles a chunk split mid-line', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } };
    const line = JSON.stringify(event);
    // Deliver in two pieces, without a newline in the first piece.
    stream.ingest(line.slice(0, 15));
    expect(pushEvent).not.toHaveBeenCalled(); // not yet — incomplete line
    stream.ingest(line.slice(15) + '\n');
    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent.mock.calls[0][3]).toBe('text_delta');
  });

  it('processes multiple events in one large chunk', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const e1 = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'a' } } };
    const e2 = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'b' } } };
    stream.ingest(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
    expect(pushEvent).toHaveBeenCalledTimes(2);
  });
});

// ── finalize() ────────────────────────────────────────────────────────────────

describe('finalize', () => {
  it('flushes a trailing partial line (no terminal newline)', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID });
    const resultEvent = {
      type: 'result',
      total_cost_usd: 0.01,
      session_id: 'x',
      num_turns: 1,
      usage: {},
    };
    // Deliver without a trailing newline — simulates truncated stdout.
    stream.ingest(JSON.stringify(resultEvent));
    expect(stream.finalResult).toBeNull(); // not yet processed
    stream.finalize();
    expect(stream.finalResult).toEqual(resultEvent);
  });

  it('is a no-op when the line buffer is empty or whitespace', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.finalize(); // nothing in the buffer
    expect(pushEvent).not.toHaveBeenCalled();
  });
});

// ── Non-JSON lines ─────────────────────────────────────────────────────────────

describe('ingest — non-JSON lines', () => {
  it('ignores non-JSON lines silently', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.ingest('Compiling project...\n');
    stream.ingest('Warning: blah\n');
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('continues processing valid events after non-JSON lines', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    const event = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'ok' } } };
    stream.ingest('not json\n' + JSON.stringify(event) + '\n');
    expect(pushEvent).toHaveBeenCalledOnce();
  });
});

// ── No pushEvent injected (unit test safety) ───────────────────────────────────

describe('no pushEvent — unit test safety', () => {
  it('does not throw when pushEvent is absent', () => {
    const stream = createStoryEventStream({ jobId: JOB_ID }); // no pushEvent
    const event = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'x' } } };
    expect(() => {
      stream.ingest(JSON.stringify(event) + '\n');
      stream.finalize();
      stream.emitStepStart('attempt 1');
      stream.emitStepComplete({ costUsd: 0.01, durationMs: 5000 });
      stream.emitStepError('something failed');
    }).not.toThrow();
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe('error resilience', () => {
  it('emitStepComplete swallows a sync pushEvent throw via logger.warn', () => {
    const warns = [];
    const pushEvent = vi.fn(() => { throw new Error('sync boom'); });
    const stream = createStoryEventStream({
      pushEvent,
      jobId: JOB_ID,
      logger: { warn: (m) => warns.push(m) },
    });
    expect(() => stream.emitStepComplete({ costUsd: 0.01, durationMs: 100 })).not.toThrow();
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toMatch(/sync boom/);
  });

  it('emitStepComplete swallows async pushEvent rejection via logger.warn', async () => {
    const warns = [];
    const pushEvent = vi.fn(() => Promise.reject(new Error('async boom')));
    const stream = createStoryEventStream({
      pushEvent,
      jobId: JOB_ID,
      logger: { warn: (m) => warns.push(m) },
    });
    stream.emitStepComplete({ costUsd: 0.01, durationMs: 50 });
    await new Promise((r) => setTimeout(r, 10));
    expect(warns.some((w) => w.includes('async boom'))).toBe(true);
  });

  it('safePush swallows async pushEvent rejection for regular events', async () => {
    const warns = [];
    const pushEvent = vi.fn(() => Promise.reject(new Error('push fail')));
    const stream = createStoryEventStream({
      pushEvent,
      jobId: JOB_ID,
      logger: { warn: (m) => warns.push(m) },
    });
    const event = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'x' } } };
    stream.ingest(JSON.stringify(event) + '\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(warns.some((w) => w.includes('push fail'))).toBe(true);
  });
});

// ── emitStepStart / emitStepError ─────────────────────────────────────────────

describe('emitStepStart and emitStepError', () => {
  it('emitStepStart calls pushEvent with step_start type', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.emitStepStart('story s-1 attempt 1');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'step_start', { text: 'story s-1 attempt 1' });
  });

  it('emitStepError calls pushEvent with step_error type', () => {
    const pushEvent = vi.fn(async () => {});
    const stream = createStoryEventStream({ pushEvent, jobId: JOB_ID });
    stream.emitStepError('dev exit 1');
    expect(pushEvent).toHaveBeenCalledWith(JOB_ID, STORY_DEV_STEP_ID, STORY_DEV_AGENT_ID, 'step_error', { text: 'dev exit 1' });
  });
});
