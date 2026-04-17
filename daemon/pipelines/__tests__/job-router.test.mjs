import { describe, it, expect } from 'vitest';
import {
  selectHandler,
  validateEpicDevJob,
  JOB_HANDLER_LEGACY,
  JOB_HANDLER_EPIC_DEV,
} from '../job-router.mjs';

describe('selectHandler', () => {
  it('routes phase=epic-dev to the epic-dev handler', () => {
    expect(selectHandler({ phase: 'epic-dev', jobId: 'j' })).toBe(JOB_HANDLER_EPIC_DEV);
  });

  it('routes jobs without a phase to the legacy handler', () => {
    expect(selectHandler({ jobId: 'j', pipeline: { steps: [] } })).toBe(JOB_HANDLER_LEGACY);
  });

  it('routes unknown phases to the legacy handler (forward compat)', () => {
    expect(selectHandler({ phase: 'epic-review', jobId: 'j' })).toBe(JOB_HANDLER_LEGACY);
    expect(selectHandler({ phase: 'epic-build', jobId: 'j' })).toBe(JOB_HANDLER_LEGACY);
  });

  it('tolerates bad input without throwing', () => {
    expect(selectHandler(null)).toBe(JOB_HANDLER_LEGACY);
    expect(selectHandler(undefined)).toBe(JOB_HANDLER_LEGACY);
    expect(selectHandler('not-an-object')).toBe(JOB_HANDLER_LEGACY);
  });

  it('does NOT disturb legacy jobs that happen to have pipelineId', () => {
    const legacyJob = { jobId: 'j', pipelineId: 'knowledge-compiler', pipeline: { steps: [] } };
    expect(selectHandler(legacyJob)).toBe(JOB_HANDLER_LEGACY);
  });
});

describe('validateEpicDevJob', () => {
  const baseJob = () => ({
    jobId: 'job-1',
    phase: 'epic-dev',
    workingDir: '/tmp/project',
    epicDevPayload: {
      orchestratorModel: 'opus',
      maxParallel: 4,
      maxRemediationRounds: 2,
      epicGoal: 'x',
      contextDigest: 'c',
      rubric: 'r',
      stories: [{ storyId: 'S-1', wave: 1, touchPoints: ['a'], complexity: 'standard', reviewRigor: 'standard' }],
    },
  });

  it('passes a well-formed epic-dev job', () => {
    expect(validateEpicDevJob(baseJob())).toEqual({ ok: true });
  });

  it('flags missing job', () => {
    expect(validateEpicDevJob(null)).toMatchObject({ ok: false, reason: 'job-missing' });
  });

  it('flags wrong phase', () => {
    const j = baseJob();
    j.phase = 'legacy';
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'phase-mismatch' });
  });

  it('flags missing jobId', () => {
    const j = baseJob();
    delete j.jobId;
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'jobId-missing' });
  });

  it('flags missing workingDir', () => {
    const j = baseJob();
    delete j.workingDir;
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'workingDir-missing' });
  });

  it('flags missing payload', () => {
    const j = baseJob();
    delete j.epicDevPayload;
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'epicDevPayload-missing' });
  });

  it('flags missing orchestratorModel', () => {
    const j = baseJob();
    delete j.epicDevPayload.orchestratorModel;
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'orchestratorModel-missing' });
  });

  it('flags empty stories', () => {
    const j = baseJob();
    j.epicDevPayload.stories = [];
    expect(validateEpicDevJob(j)).toMatchObject({ ok: false, reason: 'stories-empty' });
  });
});
