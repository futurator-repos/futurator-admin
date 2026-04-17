import { describe, it, expect } from 'vitest';
import {
  isStale,
  findStaleJobs,
  buildResumeJob,
  DEFAULT_STALE_MS,
} from '../stale-heartbeat.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'job-1',
    status: 'RUNNING',
    phase: 'epic-dev',
    epicId: 'EPIC-1',
    projectId: 'PROJ-1',
    workingDir: '/home/ubuntu/projects/alpha',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    lastHeartbeatAt: '2026-04-17T00:00:00.000Z',
    epicDevPayload: {
      orchestratorModel: 'opus',
      maxParallel: 4,
      maxRemediationRounds: 2,
      epicGoal: 'g',
      contextDigest: 'c',
      rubric: 'r',
      stories: [{ storyId: 'S-1', wave: 1 }],
    },
    ...overrides,
  };
}

const NOW = Date.parse('2026-04-17T00:10:00.000Z');

describe('isStale', () => {
  it('flags a RUNNING epic-dev job whose heartbeat is older than staleMs', () => {
    const job = makeJob({ lastHeartbeatAt: '2026-04-17T00:04:00.000Z' });
    expect(isStale(job, { now: NOW, staleMs: 5 * 60 * 1000 })).toBe(true);
  });

  it('does NOT flag jobs within the heartbeat window', () => {
    const job = makeJob({ lastHeartbeatAt: '2026-04-17T00:07:00.000Z' });
    expect(isStale(job, { now: NOW, staleMs: 5 * 60 * 1000 })).toBe(false);
  });

  it('falls back to updatedAt when lastHeartbeatAt is missing', () => {
    const job = makeJob({ lastHeartbeatAt: undefined, updatedAt: '2026-04-17T00:00:00.000Z' });
    expect(isStale(job, { now: NOW, staleMs: 5 * 60 * 1000 })).toBe(true);
  });

  it('ignores jobs not in RUNNING state', () => {
    const job = makeJob({ status: 'COMPLETED', lastHeartbeatAt: '2026-04-17T00:00:00.000Z' });
    expect(isStale(job, { now: NOW, staleMs: 5 * 60 * 1000 })).toBe(false);
  });

  it('ignores legacy jobs (phase undefined)', () => {
    const job = makeJob({ phase: undefined, lastHeartbeatAt: '2026-04-17T00:00:00.000Z' });
    expect(isStale(job, { now: NOW, staleMs: 5 * 60 * 1000 })).toBe(false);
  });

  it('uses DEFAULT_STALE_MS when staleMs is omitted', () => {
    const fresh = makeJob({ lastHeartbeatAt: '2026-04-17T00:05:01.000Z' });
    expect(isStale(fresh, { now: NOW })).toBe(false);
    const stale = makeJob({ lastHeartbeatAt: '2026-04-17T00:04:50.000Z' });
    expect(isStale(stale, { now: NOW })).toBe(true);
    expect(DEFAULT_STALE_MS).toBe(5 * 60 * 1000);
  });

  it('tolerates null / undefined / malformed timestamps without throwing', () => {
    expect(isStale(null)).toBe(false);
    expect(isStale(undefined)).toBe(false);
    expect(isStale(makeJob({ lastHeartbeatAt: 'not-a-date', updatedAt: 'nope' }))).toBe(false);
  });
});

describe('findStaleJobs', () => {
  it('returns only the stale subset', () => {
    const fresh = makeJob({ jobId: 'fresh', lastHeartbeatAt: '2026-04-17T00:07:00.000Z' });
    const stale = makeJob({ jobId: 'stale', lastHeartbeatAt: '2026-04-17T00:00:00.000Z' });
    const legacy = makeJob({ jobId: 'legacy', phase: undefined });
    const result = findStaleJobs([fresh, stale, legacy], { now: NOW, staleMs: 5 * 60 * 1000 });
    expect(result.map((j) => j.jobId)).toEqual(['stale']);
  });

  it('tolerates non-array input', () => {
    expect(findStaleJobs(null)).toEqual([]);
    expect(findStaleJobs(undefined)).toEqual([]);
  });
});

describe('buildResumeJob', () => {
  const NOW_ISO = '2026-04-17T00:10:00.000Z';

  it('creates a PENDING job that inherits payload + correlation fields', () => {
    const stale = makeJob({
      waveResults: {
        '1': {
          waveNumber: 1,
          stories: { 'S-1': { status: 'APPROVED', attempts: 1, reviewAttempts: 1, filesTouched: [] } },
          durationMs: 100,
          completedAt: 1,
        },
      },
    });
    const resumed = buildResumeJob(stale, { newJobId: 'job-2', now: NOW_ISO });
    expect(resumed.jobId).toBe('job-2');
    expect(resumed.status).toBe('PENDING');
    expect(resumed.phase).toBe('epic-dev');
    expect(resumed.epicId).toBe('EPIC-1');
    expect(resumed.projectId).toBe('PROJ-1');
    expect(resumed.workingDir).toBe('/home/ubuntu/projects/alpha');
    expect(resumed.epicDevPayload).toEqual(stale.epicDevPayload);
    expect(resumed.resumeFromWaveResults).toEqual(stale.waveResults);
    expect(resumed.resumedFromJobId).toBe('job-1');
    expect(resumed.createdAt).toBe(NOW_ISO);
  });

  it('omits resumeFromWaveResults when no prior checkpoints exist', () => {
    const stale = makeJob();
    const resumed = buildResumeJob(stale, { newJobId: 'job-2', now: NOW_ISO });
    expect(resumed.resumeFromWaveResults).toBeUndefined();
  });

  it('omits resumeFromWaveResults when waveResults is an empty map', () => {
    const stale = makeJob({ waveResults: {} });
    const resumed = buildResumeJob(stale, { newJobId: 'job-2', now: NOW_ISO });
    expect(resumed.resumeFromWaveResults).toBeUndefined();
  });

  it('throws when required arguments are missing', () => {
    expect(() => buildResumeJob(null, { newJobId: 'x', now: NOW_ISO })).toThrow();
    expect(() => buildResumeJob(makeJob(), { now: NOW_ISO })).toThrow();
    expect(() => buildResumeJob(makeJob(), { newJobId: 'x' })).toThrow();
  });
});
