import { describe, it, expect } from 'vitest';
import { classifyJob, summarize } from '../migrate-to-epic-orchestrator';
import type { AgentJob } from '../../functions/shared/types/agent-orchestrator';

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    jobId: 'j-1',
    status: 'PENDING',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    createdBy: 'tester',
    workingDir: '/tmp',
    pipeline: { agents: {}, steps: [] },
    ...overrides,
  };
}

describe('classifyJob', () => {
  it('skips jobs already on the orchestrator pipeline', () => {
    const c = classifyJob(job({ phase: 'epic-dev' }));
    expect(c.action).toBe('skip-already-orchestrator');
  });

  it('skips terminal COMPLETED / FAILED jobs', () => {
    expect(classifyJob(job({ status: 'COMPLETED' })).action).toBe('skip-terminal');
    expect(classifyJob(job({ status: 'FAILED' })).action).toBe('skip-terminal');
  });

  it('marks legacy PENDING jobs for conversion', () => {
    const c = classifyJob(job({ status: 'PENDING' }));
    expect(c.action).toBe('convert-to-epic-dev');
  });

  it('marks a RUNNING job on its final step as drain-eligible', () => {
    const c = classifyJob(
      job({
        status: 'RUNNING',
        pipeline: {
          agents: {},
          steps: [
            { id: 's1', agentId: 'a' },
            { id: 's2', agentId: 'a' },
            { id: 's3', agentId: 'a' },
          ],
        },
        currentStepIndex: 2,
      }),
    );
    expect(c.action).toBe('drain-eligible');
  });

  it('marks a RUNNING job mid-pipeline as blocking migration', () => {
    const c = classifyJob(
      job({
        status: 'RUNNING',
        pipeline: {
          agents: {},
          steps: [
            { id: 's1', agentId: 'a' },
            { id: 's2', agentId: 'a' },
            { id: 's3', agentId: 'a' },
          ],
        },
        currentStepIndex: 0,
      }),
    );
    expect(c.action).toBe('block-migration-on');
  });

  it('blocks on unexpected statuses like STALE', () => {
    const c = classifyJob(job({ status: 'STALE' }));
    expect(c.action).toBe('block-migration-on');
  });
});

describe('summarize', () => {
  it('groups by action and extracts blockers', () => {
    const jobs: AgentJob[] = [
      job({ jobId: 'a', phase: 'epic-dev' }),
      job({ jobId: 'b', status: 'COMPLETED' }),
      job({ jobId: 'c', status: 'PENDING' }),
      job({ jobId: 'd', status: 'PENDING' }),
      job({
        jobId: 'e',
        status: 'RUNNING',
        pipeline: { agents: {}, steps: [{ id: 's1', agentId: 'a' }] },
        currentStepIndex: 0,
      }),
      job({
        jobId: 'f',
        status: 'RUNNING',
        pipeline: {
          agents: {},
          steps: [
            { id: 's1', agentId: 'a' },
            { id: 's2', agentId: 'a' },
          ],
        },
        currentStepIndex: 0,
      }),
    ];

    const s = summarize(jobs);
    expect(s.total).toBe(6);
    expect(s.byAction['skip-already-orchestrator']).toBe(1);
    expect(s.byAction['skip-terminal']).toBe(1);
    expect(s.byAction['convert-to-epic-dev']).toBe(2);
    expect(s.byAction['drain-eligible']).toBe(1); // e: single-step pipeline on step 0 => final
    expect(s.byAction['block-migration-on']).toBe(1); // f
    expect(s.blockers.map((b) => b.jobId)).toEqual(['f']);
  });
});
