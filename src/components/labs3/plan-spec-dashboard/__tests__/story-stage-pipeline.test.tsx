import { describe, it, expect } from 'vitest';
import { deriveStages } from '../story-stage-pipeline';
import type { AgentEvent } from '@/types/agent-orchestrator';

const ev = (
  stepId: string,
  eventType: AgentEvent['eventType'],
  t: string,
  text?: string,
): AgentEvent =>
  ({
    jobId: 'j',
    eventSeq: t,
    seq: 0,
    timestamp: t,
    stepId,
    agentId: stepId,
    eventType,
    text,
  }) as AgentEvent;

describe('deriveStages', () => {
  it('full TDD run: all four stages done with durations', () => {
    const stages = deriveStages([
      ev('test-author', 'step_start', '2026-07-03T10:00:00Z'),
      ev('test-author', 'step_complete', '2026-07-03T10:01:30Z', 'RED confirmed — 2 test file(s)'),
      ev('story-dev', 'step_start', '2026-07-03T10:01:31Z'),
      ev('story-dev', 'step_complete', '2026-07-03T10:05:00Z'),
      ev('reviewer', 'step_start', '2026-07-03T10:05:01Z'),
      ev('reviewer', 'step_complete', '2026-07-03T10:06:00Z', 'reviewer verdicts: 4 AC(s), 0 fail'),
      ev('compile', 'step_start', '2026-07-03T10:06:01Z'),
      ev('compile', 'step_complete', '2026-07-03T10:07:00Z', 'compile done — graph updated'),
    ]);
    expect(stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(stages[0].durationMs).toBe(90_000);
    expect(stages[0].detail).toMatch(/RED confirmed/);
  });

  it('legacy single-spawn run: test-author/reviewer are not-run, dev done', () => {
    const stages = deriveStages([
      ev('story-dev', 'step_start', '2026-07-03T10:00:00Z'),
      ev('story-dev', 'step_complete', '2026-07-03T10:03:00Z'),
    ]);
    expect(stages.find((s) => s.id === 'test-author')?.status).toBe('not-run');
    expect(stages.find((s) => s.id === 'story-dev')?.status).toBe('done');
    expect(stages.find((s) => s.id === 'reviewer')?.status).toBe('not-run');
  });

  it('running stage + retry attempts counted', () => {
    const stages = deriveStages([
      ev('story-dev', 'step_start', '2026-07-03T10:00:00Z'),
      ev('story-dev', 'step_error', '2026-07-03T10:02:00Z', 'attempt 1 failed'),
      ev('story-dev', 'step_start', '2026-07-03T10:02:10Z'),
    ]);
    const dev = stages.find((s) => s.id === 'story-dev')!;
    expect(dev.attempts).toBe(2);
    // errors present but a fresh start with no terminal → treated as failed-so-far
    expect(dev.status).toBe('failed');
  });

  it('empty stream → every stage not-run (component renders nothing)', () => {
    expect(deriveStages([]).every((s) => s.status === 'not-run')).toBe(true);
  });
});
