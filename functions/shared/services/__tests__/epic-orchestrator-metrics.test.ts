import { describe, it, expect } from 'vitest';
import { aggregateOrchestratorMetrics } from '../epic-orchestrator-metrics';
import type { AgentEvent } from '../../types/agent-orchestrator';

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    jobId: 'job-1',
    eventSeq: '0001',
    seq: 1,
    timestamp: '2026-04-17T00:00:00.000Z',
    stepId: 'step-1',
    agentId: 'orchestrator',
    eventType: 'status',
    expireAt: 0,
    ...overrides,
  };
}

describe('aggregateOrchestratorMetrics', () => {
  it('returns zeros on an empty event stream', () => {
    const m = aggregateOrchestratorMetrics([]);
    expect(m.sampleSize).toBe(0);
    expect(m.epic.count).toBe(0);
    expect(m.story.count).toBe(0);
    expect(m.remediation.rate).toBe(0);
    expect(m.tokenSpend).toEqual({ opus: 0, sonnet: 0, haiku: 0, unknown: 0 });
  });

  it('computes epic wall-clock from epic_start/epic_complete pairs', () => {
    const events: AgentEvent[] = [
      event({ jobId: 'a', eventType: 'epic_start', timestamp: '2026-04-17T00:00:00.000Z' }),
      event({ jobId: 'a', eventType: 'epic_complete', timestamp: '2026-04-17T00:00:10.000Z' }),
      event({ jobId: 'b', eventType: 'epic_start', timestamp: '2026-04-17T00:00:00.000Z' }),
      event({ jobId: 'b', eventType: 'epic_failed', timestamp: '2026-04-17T00:00:30.000Z' }),
    ];
    const m = aggregateOrchestratorMetrics(events);
    expect(m.epic.count).toBe(2);
    expect(m.epic.medianMs).toBeGreaterThanOrEqual(10_000);
    expect(m.epic.p95Ms).toBe(30_000);
  });

  it('computes story wall-clock only for dev subagents — reviewer dispatches are ignored', () => {
    const events: AgentEvent[] = [
      event({
        jobId: 'a',
        eventType: 'subagent_dispatch',
        role: 'dev',
        subagentId: 'dev-1',
        timestamp: '2026-04-17T00:00:00.000Z',
      }),
      event({
        jobId: 'a',
        eventType: 'subagent_return',
        role: 'dev',
        subagentId: 'dev-1',
        timestamp: '2026-04-17T00:00:05.000Z',
      }),
      // Reviewer pair — must NOT appear in story wall-clock
      event({
        jobId: 'a',
        eventType: 'subagent_dispatch',
        role: 'reviewer',
        subagentId: 'rev-1',
        timestamp: '2026-04-17T00:00:05.000Z',
      }),
      event({
        jobId: 'a',
        eventType: 'subagent_return',
        role: 'reviewer',
        subagentId: 'rev-1',
        timestamp: '2026-04-17T00:00:08.000Z',
      }),
    ];
    const m = aggregateOrchestratorMetrics(events);
    expect(m.story.count).toBe(1);
    expect(m.story.medianMs).toBe(5_000);
  });

  it('buckets token spend by model tier via payload.model', () => {
    const events: AgentEvent[] = [
      event({ eventType: 'result', cost: 0.25, payload: { model: 'claude-opus-4-7' } }),
      event({ eventType: 'step_complete', cost: 0.1, payload: { model: 'claude-sonnet-4-6' } }),
      event({ eventType: 'result', cost: 0.05, payload: { model: 'haiku' } }),
      event({ eventType: 'result', cost: 0.02, payload: { model: 'unknown-model' } }),
    ];
    const m = aggregateOrchestratorMetrics(events);
    expect(m.tokenSpend.opus).toBeCloseTo(0.25);
    expect(m.tokenSpend.sonnet).toBeCloseTo(0.1);
    expect(m.tokenSpend.haiku).toBeCloseTo(0.05);
    expect(m.tokenSpend.unknown).toBeCloseTo(0.02);
  });

  it('computes remediation rate as epics-with-remediations / total epics', () => {
    const events: AgentEvent[] = [
      event({ jobId: 'a', eventType: 'epic_start' }),
      event({ jobId: 'a', eventType: 'remediation_start' }),
      event({ jobId: 'a', eventType: 'epic_complete', timestamp: '2026-04-17T00:00:10.000Z' }),
      event({ jobId: 'b', eventType: 'epic_start' }),
      event({ jobId: 'b', eventType: 'epic_complete', timestamp: '2026-04-17T00:00:05.000Z' }),
    ];
    const m = aggregateOrchestratorMetrics(events);
    expect(m.remediation.epicsTotal).toBe(2);
    expect(m.remediation.epicsWithRemediations).toBe(1);
    expect(m.remediation.rate).toBe(0.5);
  });

  it('aggregates blocker taxonomy by payload.code', () => {
    const events: AgentEvent[] = [
      event({ eventType: 'story_blocked', payload: { code: 'ambiguous-ac' } }),
      event({ eventType: 'story_blocked', payload: { code: 'ambiguous-ac' } }),
      event({ eventType: 'dev_blocker_reported', payload: { code: 'missing-dependency' } }),
      event({ eventType: 'story_blocked', payload: {} }),
    ];
    const m = aggregateOrchestratorMetrics(events);
    expect(m.blockerTaxonomy['ambiguous-ac']).toBe(2);
    expect(m.blockerTaxonomy['missing-dependency']).toBe(1);
    expect(m.blockerTaxonomy.unknown).toBe(1);
  });

  it('respects from/to/projectId filters', () => {
    const events: AgentEvent[] = [
      event({
        jobId: 'a',
        projectId: 'p1',
        eventType: 'epic_start',
        timestamp: '2026-04-16T00:00:00.000Z',
      }),
      event({
        jobId: 'a',
        projectId: 'p1',
        eventType: 'epic_complete',
        timestamp: '2026-04-16T00:00:10.000Z',
      }),
      event({
        jobId: 'b',
        projectId: 'p2',
        eventType: 'epic_start',
        timestamp: '2026-04-17T00:00:00.000Z',
      }),
      event({
        jobId: 'b',
        projectId: 'p2',
        eventType: 'epic_complete',
        timestamp: '2026-04-17T00:00:20.000Z',
      }),
    ];
    const m = aggregateOrchestratorMetrics(events, {
      from: Date.parse('2026-04-17T00:00:00.000Z'),
      projectId: 'p2',
    });
    expect(m.sampleSize).toBe(2);
    expect(m.epic.count).toBe(1);
    expect(m.epic.medianMs).toBe(20_000);
  });
});
