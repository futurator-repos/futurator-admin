import { describe, it, expect } from 'vitest';
import {
  selectHandler,
  validateEpicDevJob,
  validatePartyRefreshJob,
  validateFreeAgentSessionJob,
  validateP3QaJob,
  validateIntegratorJob,
  JOB_HANDLER_LEGACY,
  JOB_HANDLER_EPIC_DEV,
  JOB_HANDLER_PARTY_REFRESH,
  JOB_HANDLER_FREE_AGENT_SESSION,
  JOB_HANDLER_P3_QA,
  JOB_HANDLER_INTEGRATOR,
} from '../job-router.mjs';

const SHA = 'a'.repeat(40);

describe('p3-qa routing (W2)', () => {
  it('routes jobType p3-qa to the p3-qa handler', () => {
    expect(selectHandler({ jobType: 'p3-qa', jobId: 'j' })).toBe(JOB_HANDLER_P3_QA);
  });
  it('validateP3QaJob requires jobId, planId, http devUrl, 40-hex sha', () => {
    expect(validateP3QaJob({ jobType: 'p3-qa', jobId: 'j', planId: 'p', devUrl: 'https://dev.futurator.ai/x/', qaCommitSha: SHA }).ok).toBe(true);
    expect(validateP3QaJob({ jobType: 'p3-qa', jobId: 'j', planId: 'p', devUrl: 'https://x', qaCommitSha: 'short' }).ok).toBe(false);
    expect(validateP3QaJob({ jobType: 'p3-qa', jobId: 'j', planId: 'p', qaCommitSha: SHA }).reason).toBe('devUrl-missing');
    expect(validateP3QaJob({ jobType: 'other', jobId: 'j' }).reason).toBe('jobType-mismatch');
  });
});

describe('integrator routing (Reality-Spine P3)', () => {
  it('routes jobType integrator to the integrator handler', () => {
    expect(selectHandler({ jobType: 'integrator', jobId: 'j' })).toBe(JOB_HANDLER_INTEGRATOR);
  });
  it('integrator takes precedence over phase=epic-dev', () => {
    expect(selectHandler({ jobType: 'integrator', phase: 'epic-dev', jobId: 'j' })).toBe(
      JOB_HANDLER_INTEGRATOR,
    );
  });
  it('validateIntegratorJob passes a well-formed job', () => {
    expect(
      validateIntegratorJob({ jobType: 'integrator', jobId: 'j', planId: 'p', workingDir: '/x' }),
    ).toEqual({ ok: true });
  });
  it('validateIntegratorJob flags each missing field with a reason', () => {
    expect(validateIntegratorJob(null).reason).toBe('job-missing');
    expect(validateIntegratorJob({ jobType: 'other', jobId: 'j' }).reason).toBe('jobType-mismatch');
    expect(validateIntegratorJob({ jobType: 'integrator', planId: 'p', workingDir: '/x' }).reason).toBe('jobId-missing');
    expect(validateIntegratorJob({ jobType: 'integrator', jobId: 'j', workingDir: '/x' }).reason).toBe('planId-missing');
    expect(validateIntegratorJob({ jobType: 'integrator', jobId: 'j', planId: 'p' }).reason).toBe('workingDir-missing');
  });
});

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
      stories: [
        {
          storyId: 'S-1',
          wave: 1,
          touchPoints: ['a'],
          complexity: 'standard',
          reviewRigor: 'standard',
        },
      ],
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

describe('selectHandler — party-refresh (Story 15.4)', () => {
  it('routes jobType=party-refresh to the party-refresh handler', () => {
    expect(selectHandler({ jobType: 'party-refresh', jobId: 'j' })).toBe(JOB_HANDLER_PARTY_REFRESH);
  });
});

describe('validatePartyRefreshJob (Story 15.4)', () => {
  const baseJob = () => ({
    jobId: 'job-r',
    jobType: 'party-refresh',
    partyRefreshPayload: {
      projectId: 'songster',
      projectPath: '/home/ubuntu/projects/songster',
      gitBranch: 'main',
    },
  });

  it('passes a well-formed party-refresh job', () => {
    expect(validatePartyRefreshJob(baseJob())).toEqual({ ok: true });
  });

  it('flags missing jobId', () => {
    const j = baseJob();
    delete j.jobId;
    expect(validatePartyRefreshJob(j)).toMatchObject({ ok: false, reason: 'jobId-missing' });
  });

  it('flags wrong jobType', () => {
    const j = baseJob();
    j.jobType = 'party-bootstrap';
    expect(validatePartyRefreshJob(j)).toMatchObject({ ok: false, reason: 'jobType-mismatch' });
  });

  it('flags missing payload', () => {
    const j = baseJob();
    delete j.partyRefreshPayload;
    expect(validatePartyRefreshJob(j)).toMatchObject({
      ok: false,
      reason: 'partyRefreshPayload-missing',
    });
  });

  it('flags missing gitBranch', () => {
    const j = baseJob();
    delete j.partyRefreshPayload.gitBranch;
    expect(validatePartyRefreshJob(j)).toMatchObject({ ok: false, reason: 'gitBranch-missing' });
  });
});

describe('selectHandler — free-agent-session (Story 18.2)', () => {
  it('routes jobType=free-agent-session to the free-agent-session handler', () => {
    expect(selectHandler({ jobType: 'free-agent-session', jobId: 'j' })).toBe(
      JOB_HANDLER_FREE_AGENT_SESSION,
    );
  });
});

describe('validateFreeAgentSessionJob (Story 18.2)', () => {
  const baseJob = () => ({
    jobId: 'job-fa',
    jobType: 'free-agent-session',
    freeAgentSessionPayload: {
      sessionId: 'sid-1',
      projectId: 'dino-7',
      scope: { kind: 'plan', id: 'plan-abc' },
      model: 'sonnet',
      costCapUsd: 10,
      credentials: {
        accessKeyId: 'ASIAEXAMPLE12345678X',
        secretAccessKey: 'a'.repeat(40),
        sessionToken: 'tok',
        expiration: '2026-05-17T20:00:00.000Z',
      },
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  it('passes a well-formed free-agent-session job', () => {
    expect(validateFreeAgentSessionJob(baseJob())).toEqual({ ok: true });
  });

  it('flags missing jobId', () => {
    const j = baseJob();
    delete j.jobId;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({ ok: false, reason: 'jobId-missing' });
  });

  it('flags wrong jobType', () => {
    const j = baseJob();
    j.jobType = 'party-turn';
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'jobType-mismatch',
    });
  });

  it('flags missing payload', () => {
    const j = baseJob();
    delete j.freeAgentSessionPayload;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'freeAgentSessionPayload-missing',
    });
  });

  it('flags missing sessionId', () => {
    const j = baseJob();
    delete j.freeAgentSessionPayload.sessionId;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'sessionId-missing',
    });
  });

  it('flags missing credentials', () => {
    const j = baseJob();
    delete j.freeAgentSessionPayload.credentials;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'credentials-missing',
    });
  });

  it('flags incomplete credentials (missing sessionToken)', () => {
    const j = baseJob();
    delete j.freeAgentSessionPayload.credentials.sessionToken;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'credentials-incomplete',
    });
  });

  it('flags missing costCapUsd', () => {
    const j = baseJob();
    delete j.freeAgentSessionPayload.costCapUsd;
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'costCapUsd-missing',
    });
  });

  it('flags empty messages array', () => {
    const j = baseJob();
    j.freeAgentSessionPayload.messages = [];
    expect(validateFreeAgentSessionJob(j)).toMatchObject({
      ok: false,
      reason: 'messages-empty',
    });
  });
});

// ── Epic 3 Story 3.1 + 3.6 (2026-05-20) — skill-scout + skill-install ──

describe('selectHandler — skill-scout + skill-install (Epic 3)', () => {
  it('routes jobType=skill-scout to the skill-scout handler', async () => {
    const { selectHandler, JOB_HANDLER_SKILL_SCOUT } = await import('../../pipelines/job-router.mjs');
    expect(selectHandler({ jobType: 'skill-scout', jobId: 'j' })).toBe(JOB_HANDLER_SKILL_SCOUT);
  });

  it('routes jobType=skill-install to the skill-install handler', async () => {
    const { selectHandler, JOB_HANDLER_SKILL_INSTALL } = await import('../../pipelines/job-router.mjs');
    expect(selectHandler({ jobType: 'skill-install', jobId: 'j' })).toBe(JOB_HANDLER_SKILL_INSTALL);
  });

  it('skill-scout takes precedence over phase=epic-dev', async () => {
    const { selectHandler, JOB_HANDLER_SKILL_SCOUT } = await import('../../pipelines/job-router.mjs');
    expect(
      selectHandler({ jobType: 'skill-scout', phase: 'epic-dev', jobId: 'j' }),
    ).toBe(JOB_HANDLER_SKILL_SCOUT);
  });
});

// ── Epic 6 wire-in (2026-05-20) — reflector jobType ──

describe('selectHandler — reflector (Epic 6)', () => {
  it('routes jobType=reflector to the reflector handler', async () => {
    const { selectHandler, JOB_HANDLER_REFLECTOR } = await import('../../pipelines/job-router.mjs');
    expect(selectHandler({ jobType: 'reflector', jobId: 'j' })).toBe(JOB_HANDLER_REFLECTOR);
  });

  it('reflector takes precedence over phase=epic-dev', async () => {
    const { selectHandler, JOB_HANDLER_REFLECTOR } = await import('../../pipelines/job-router.mjs');
    expect(
      selectHandler({ jobType: 'reflector', phase: 'epic-dev', jobId: 'j' }),
    ).toBe(JOB_HANDLER_REFLECTOR);
  });
});
