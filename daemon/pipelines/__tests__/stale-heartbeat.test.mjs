import { describe, it, expect } from 'vitest';
import {
  isStale,
  findStaleJobs,
  buildResumeJob,
  DEFAULT_STALE_MS,
  isRequeueableOrphan,
  canReapJob,
  REQUEUE_ON_ORPHAN_JOB_TYPES,
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

/**
 * 2026-06-16 — orphaned idempotent infra jobs (app-bootstrap) are auto-requeued
 * to PENDING after a daemon restart, instead of marked STALE forever (brick1).
 */
describe('isRequeueableOrphan', () => {
  const NOW = Date.parse('2026-06-16T13:00:00.000Z');
  const stale = '2026-06-16T12:00:00.000Z'; // 1h old → stale
  const fresh = '2026-06-16T12:59:30.000Z'; // 30s old → not stale

  function bootstrapJob(over = {}) {
    return {
      jobId: 'b1',
      status: 'RUNNING',
      jobType: 'app-bootstrap',
      updatedAt: stale,
      ...over,
    };
  }

  it('app-bootstrap is in the requeue allowlist', () => {
    expect(REQUEUE_ON_ORPHAN_JOB_TYPES).toContain('app-bootstrap');
  });

  it('requeues a stale, orphaned RUNNING app-bootstrap job', () => {
    expect(isRequeueableOrphan(bootstrapJob(), { now: NOW })).toBe(true);
  });

  it('does NOT requeue a fresh (still-heartbeating) app-bootstrap job', () => {
    expect(isRequeueableOrphan(bootstrapJob({ updatedAt: fresh }), { now: NOW })).toBe(false);
  });

  it('does NOT requeue a non-RUNNING app-bootstrap job', () => {
    expect(isRequeueableOrphan(bootstrapJob({ status: 'FAILED' }), { now: NOW })).toBe(false);
    expect(isRequeueableOrphan(bootstrapJob({ status: 'COMPLETED' }), { now: NOW })).toBe(false);
  });

  it('does NOT requeue a stale story/dev job (fragile state — stays mark-STALE)', () => {
    expect(
      isRequeueableOrphan({ status: 'RUNNING', phase: 'story-dev', updatedAt: stale }, { now: NOW }),
    ).toBe(false);
    expect(
      isRequeueableOrphan({ status: 'RUNNING', jobType: 'skill-scout', updatedAt: stale }, { now: NOW }),
    ).toBe(false);
  });

  it('honors lastHeartbeatAt over updatedAt when present', () => {
    // updatedAt stale, but a recent heartbeat → not orphaned.
    expect(
      isRequeueableOrphan(bootstrapJob({ lastHeartbeatAt: fresh }), { now: NOW }),
    ).toBe(false);
  });

  // ── Story 3.4 — autopilot concept-gen jobs (no jobType) requeue via marker ──
  it('requeues a stale, orphaned autopilot concept-gen job (conceptAutopilotGen marker)', () => {
    const job = {
      jobId: 'g1',
      status: 'RUNNING',
      conceptAutopilotGen: true,
      conceptArtifactKind: 'architecture',
      updatedAt: stale,
    };
    expect(isRequeueableOrphan(job, { now: NOW })).toBe(true);
  });

  it('does NOT requeue an interactive convergence turn (no marker — mid-conversation)', () => {
    const job = {
      jobId: 'fa1',
      status: 'RUNNING',
      jobType: 'free-agent-session',
      conceptArtifactKind: 'prd', // scoped to a kind, but NOT marked autopilot
      updatedAt: stale,
    };
    expect(isRequeueableOrphan(job, { now: NOW })).toBe(false);
  });

  it('does NOT requeue a fresh (heartbeating) autopilot concept-gen job', () => {
    const job = { jobId: 'g2', status: 'RUNNING', conceptAutopilotGen: true, updatedAt: fresh };
    expect(isRequeueableOrphan(job, { now: NOW })).toBe(false);
  });
});

// Cross-daemon reap-ownership guard (pacman1 triple-mint, 2026-07-13): the
// laptop daemon reaped EC2's live story-dev jobs (its activeJobs map is
// process-local), orphan-released their story claims, and the frontier
// re-minted duplicates every ~5 minutes.
describe('canReapJob', () => {
  it('a daemon may reap only jobs its own source claimed', () => {
    expect(canReapJob({ claimedBySource: 'ec2' }, { source: 'ec2' })).toBe(true);
    expect(canReapJob({ claimedBySource: 'local' }, { source: 'local' })).toBe(true);
  });

  it('a peer daemon may NEVER reap another source\'s job (the pacman1 bug)', () => {
    expect(canReapJob({ claimedBySource: 'ec2' }, { source: 'local' })).toBe(false);
    expect(canReapJob({ claimedBySource: 'local' }, { source: 'ec2' })).toBe(false);
  });

  it('legacy rows without a claimedBySource stamp are reaped only by the production ec2 daemon', () => {
    expect(canReapJob({}, { source: 'ec2' })).toBe(true);
    expect(canReapJob({}, { source: 'local' })).toBe(false);
    expect(canReapJob(undefined, { source: 'local' })).toBe(false);
  });

  it('defaults to the safe posture (local, cannot reap legacy rows) when no source given', () => {
    expect(canReapJob({})).toBe(false);
  });
});
