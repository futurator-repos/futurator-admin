/**
 * dual-agent-compare-runner.test.mjs — locks the dual-agent comparison
 * orchestration + the job validator + the prompt builder. No real `claude`
 * spawn: captureLane is faked, so this is a fast, deterministic unit test.
 */

import { describe, it, expect } from 'vitest';
import { runDualAgentCompare } from '../dual-agent-compare-runner.mjs';
import { buildPrompt } from '../dual-agent-compare-capture.mjs';
import { validateDualAgentCompareJob, selectHandler } from '../job-router.mjs';

function fakeCapture(perLane) {
  const calls = [];
  const captureLane = async (args) => {
    calls.push(args);
    const r = perLane(args);
    return {
      answer: 'ok',
      latencyMs: 1000,
      tokens: { input: 100, output: 50 },
      costUsd: 0.01,
      toolCalls: 1,
      graphToolCalls: 0,
      ...r,
    };
  };
  return { captureLane, calls };
}

describe('runDualAgentCompare', () => {
  it('runs both lanes (A vanilla, B with graph) and returns both results', async () => {
    const { captureLane, calls } = fakeCapture((a) =>
      a.withGraph ? { graphToolCalls: 4, latencyMs: 2000 } : {},
    );
    const events = [];
    const out = await runDualAgentCompare(
      { question: 'where is user data stored?', projectPath: '/repo', model: 'opus' },
      { captureLane, pushEvent: (e) => events.push(e), jobId: 'job-1234' },
    );
    expect(out.ok).toBe(true);
    expect(out.result.agentA.withGraph).toBe(false);
    expect(out.result.agentB.withGraph).toBe(true);
    expect(out.result.agentB.graphToolCalls).toBe(4);
    // both lanes got the SAME question + cwd; only withGraph differs
    expect(calls).toHaveLength(2);
    expect(calls[0].withGraph).toBe(false);
    expect(calls[1].withGraph).toBe(true);
    expect(calls[0].question).toBe(calls[1].question);
    expect(calls[0].cwd).toBe('/repo');
    // event lifecycle
    const types = events.map((e) => e.type);
    expect(types).toContain('dual.started');
    expect(types.filter((t) => t === 'dual.lane.done')).toHaveLength(2);
    expect(types).toContain('dual.completed');
  });

  it('carries a lane error through without throwing', async () => {
    const { captureLane } = fakeCapture((a) =>
      a.withGraph ? { error: 'timeout after 240000ms', answer: '' } : {},
    );
    const out = await runDualAgentCompare(
      { question: 'q', projectPath: '/repo' },
      { captureLane },
    );
    expect(out.ok).toBe(true);
    expect(out.result.agentB.error).toMatch(/timeout/);
  });

  it('rejects a missing question / projectPath', async () => {
    const { captureLane } = fakeCapture(() => ({}));
    expect((await runDualAgentCompare({ projectPath: '/r' }, { captureLane })).ok).toBe(false);
    expect((await runDualAgentCompare({ question: 'q' }, { captureLane })).ok).toBe(false);
  });
});

describe('buildPrompt', () => {
  it('only mentions graph tools when withGraph is true', () => {
    expect(buildPrompt('q', false)).not.toMatch(/mcp__mycelium__/);
    const withGraph = buildPrompt('q', true);
    expect(withGraph).toMatch(/mcp__mycelium__/);
    expect(withGraph).toContain('q');
  });
});

describe('validateDualAgentCompareJob + dispatch', () => {
  const good = {
    jobType: 'dual-agent-compare',
    jobId: 'j1',
    dualAgentComparePayload: { projectId: 'p', projectPath: '/repo', question: 'q?' },
  };
  it('accepts a well-formed job', () => {
    expect(validateDualAgentCompareJob(good)).toEqual({ ok: true });
  });
  it('rejects missing fields', () => {
    expect(validateDualAgentCompareJob({ ...good, jobType: 'other' }).ok).toBe(false);
    expect(
      validateDualAgentCompareJob({ ...good, dualAgentComparePayload: { projectId: 'p', projectPath: '/r' } }).ok,
    ).toBe(false);
  });
  it('selectHandler routes the job kind', () => {
    expect(selectHandler(good)).toBe('dual-agent-compare');
  });
});
