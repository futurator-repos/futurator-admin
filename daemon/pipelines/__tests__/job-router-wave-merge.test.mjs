/**
 * Unit tests for job-router wave-merge dispatch (Phase 1 worktree rollout).
 *
 * Covers the new `'wave-merge'` jobType handler selection + validator.
 */

import { describe, expect, it } from 'vitest';
import {
  selectHandler,
  validateWaveMergeJob,
  JOB_HANDLER_WAVE_MERGE,
  JOB_HANDLER_LEGACY,
} from '../job-router.mjs';

describe('selectHandler — wave-merge', () => {
  it('routes wave-merge jobType to the wave-merge handler', () => {
    expect(selectHandler({ jobType: 'wave-merge' })).toBe(JOB_HANDLER_WAVE_MERGE);
  });

  it('legacy jobs (no jobType) still route to legacy', () => {
    expect(selectHandler({ jobId: 'foo' })).toBe(JOB_HANDLER_LEGACY);
  });

  it('returns LEGACY for falsy job', () => {
    expect(selectHandler(null)).toBe(JOB_HANDLER_LEGACY);
    expect(selectHandler(undefined)).toBe(JOB_HANDLER_LEGACY);
  });
});

describe('validateWaveMergeJob', () => {
  function baseJob() {
    return {
      jobId: 'job-uuid',
      jobType: 'wave-merge',
      waveMergePayload: {
        appId: 'snake-4',
        planId: 'plan_snake-4_abc',
        planSlug: 'snake-4-animations',
        epicId: 'epic-uuid',
        waveNumber: 0,
        storyIds: ['story-a', 'story-b'],
      },
    };
  }

  it('accepts a well-formed payload', () => {
    expect(validateWaveMergeJob(baseJob())).toEqual({ ok: true });
  });

  it('rejects missing payload', () => {
    const j = baseJob();
    delete j.waveMergePayload;
    expect(validateWaveMergeJob(j).ok).toBe(false);
  });

  it('rejects mismatched jobType', () => {
    const j = baseJob();
    j.jobType = 'app-bootstrap';
    expect(validateWaveMergeJob(j)).toEqual({ ok: false, reason: 'jobType-mismatch' });
  });

  it('rejects missing identity fields', () => {
    const j = baseJob();
    delete j.waveMergePayload.appId;
    expect(validateWaveMergeJob(j).reason).toBe('identity-fields-missing');
  });

  it('rejects missing waveNumber', () => {
    const j = baseJob();
    delete j.waveMergePayload.waveNumber;
    expect(validateWaveMergeJob(j).reason).toBe('waveNumber-missing');
  });

  it('rejects empty storyIds', () => {
    const j = baseJob();
    j.waveMergePayload.storyIds = [];
    expect(validateWaveMergeJob(j).reason).toBe('storyIds-empty');
  });
});
