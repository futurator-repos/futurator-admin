// Tests for detectors/deployment.ts — Plan Retrospect deployment-stage scorer.
//
// Builds a synthetic DetectorContext and asserts the verdict/score/honesty
// behavior of each DP-* criterion: present-in-report ones score, log-only ones
// (DP-I1, DP-T1, DP-S1-command) emit '⚪' with a needs-instrumentation note.

import { describe, it, expect } from 'vitest';
import { scoreDeployment } from '../detectors/deployment';
import type { DetectorContext, ScorecardSlice } from '../types';
import type { DeployReport } from '../../types/deploy-report';
import type { Plan } from '../../types/plan';

// ── synthetic inputs ─────────────────────────────────────────────────────────

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan_1',
    name: 'brick1',
    intent: 'a brick breaker',
    description: '',
    status: 'review',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/brick1',
    executionMode: 'pipeline',
    totalStories: 5,
    doneStories: 5,
    totalCostUsd: 1.2,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T01:00:00.000Z',
    ...overrides,
  } as Plan;
}

function deployReport(overrides: Partial<DeployReport> = {}): DeployReport {
  const base: DeployReport = {
    planId: 'plan_1',
    verdict: 'live',
    target: {
      publicUrl: 'https://futurator.ai/apps/brick1/',
      s3Bucket: 'futurator-ai-website',
      s3Prefix: 'apps/brick1/',
    },
    handoff: {
      planName: 'brick1',
      rigor: 'mvp',
      stories: { done: 5, total: 5 },
      costUsd: 1.2,
      qaVerdict: 'ready',
      thumbnailUrls: [],
    },
    environments: [
      {
        environment: 'dev',
        url: 'https://dev.futurator.ai/apps/brick1/',
        status: 'live',
        canPromote: false,
        activeJobId: 'job_dev',
        smokeStatus: 'pass',
      },
      {
        environment: 'staging',
        url: 'https://staging.futurator.ai/apps/brick1/',
        status: 'live',
        canPromote: true,
        activeJobId: 'job_staging',
        smokeStatus: 'pass',
      },
      {
        environment: 'production',
        url: 'https://futurator.ai/apps/brick1/',
        status: 'live',
        canPromote: true,
        activeJobId: 'job_prod',
        smokeStatus: 'pass',
      },
    ],
    current: {
      jobId: 'job_prod',
      epicId: 'epic_1',
      status: 'COMPLETED',
      startedAtIso: '2026-06-18T00:50:00.000Z',
      finishedAtIso: '2026-06-18T00:55:00.000Z',
      durationSec: 300,
      publicUrl: 'https://futurator.ai/apps/brick1/',
      sha: 'abc1234',
      steps: [
        { id: 'build', label: 'Build', status: 'pass' },
        { id: 'sync', label: 'Sync to S3', status: 'pass' },
        { id: 'invalidate', label: 'Invalidate CDN', status: 'pass' },
        { id: 'verify', label: 'Verify URL', status: 'pass' },
      ],
    },
    history: [],
    generatedAt: '2026-06-18T01:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function ctx(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    planId: 'plan_1',
    plan: plan(),
    epics: [],
    events: [],
    slices: [],
    // aggregate / byCat unused by the deployment detector; minimal stubs.
    aggregate: { totalMs: 0, byCategory: {} } as DetectorContext['aggregate'],
    skills: null,
    cohort: null,
    byCat: () => ({ totalMs: 0, count: 0 }),
    deployReport: deployReport(),
    ...overrides,
  };
}

function byId(slices: ScorecardSlice[], id: string): ScorecardSlice {
  const s = slices.find((x) => x.criterionId === id);
  if (!s) throw new Error(`missing slice ${id}`);
  return s;
}

// ── happy path ─────────────────────────────────────────────────────────────

describe('scoreDeployment — clean live deploy', () => {
  const slices = scoreDeployment(ctx());

  it('emits exactly the 12 DP-* criteria', () => {
    const ids = slices.map((s) => s.criterionId).sort();
    expect(ids).toEqual(
      [
        'DP-B1',
        'DP-D1',
        'DP-E1',
        'DP-I1',
        'DP-L1',
        'DP-L2',
        'DP-O1',
        'DP-R1',
        'DP-S1',
        'DP-S2',
        'DP-T1',
        'DP-U1',
      ].sort(),
    );
  });

  it('DP-B1 green when build step passed', () => {
    expect(byId(slices, 'DP-B1').score).toBe(4);
    expect(byId(slices, 'DP-B1').verdict).toBe('🟢');
  });

  it('DP-L1 green ladder (all rungs live)', () => {
    expect(byId(slices, 'DP-L1').verdict).toBe('🟢');
  });

  it('DP-R1 green when a commit SHA pins the release', () => {
    const s = byId(slices, 'DP-R1');
    expect(s.score).toBe(4);
    expect(s.value).toBe('abc1234');
  });

  it('DP-S1 scores the scoped prefix but disclaims the log-only root-sync seam', () => {
    const s = byId(slices, 'DP-S1');
    expect(s.score).toBe(4);
    expect(s.value).toBe('apps/brick1/');
    expect(s.note).toMatch(/log-only/i);
  });

  it('DP-S2 green when smoke surfaced on every rung', () => {
    expect(byId(slices, 'DP-S2').score).toBe(4);
  });

  it('DP-D1 full report → 4', () => {
    expect(byId(slices, 'DP-D1').score).toBe(4);
  });

  it('DP-U1 full-URL shape → green but needs-instrumentation for HTTP-200', () => {
    const s = byId(slices, 'DP-U1');
    expect(s.verdict).toBe('🟢');
    expect(s.note).toMatch(/needs-instrumentation/i);
  });

  it('DP-O1 green when every deployed rung is job-bound', () => {
    expect(byId(slices, 'DP-O1').score).toBe(4);
  });

  it('DP-T1 is ⚪ — no deploy-latency budget declared', () => {
    const s = byId(slices, 'DP-T1');
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toMatch(/needs-instrumentation/i);
  });

  it('DP-I1 is ⚪ — worktree-overlap is log-only (IE13/F11)', () => {
    const s = byId(slices, 'DP-I1');
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toMatch(/needs-instrumentation/i);
  });
});

// ── failure / skip paths ──────────────────────────────────────────────────────

describe('scoreDeployment — failure & skip signals', () => {
  it('DP-B1 red when the build step failed', () => {
    const r = deployReport();
    r.current!.steps = [{ id: 'build', label: 'Build', status: 'fail' }];
    const s = byId(scoreDeployment(ctx({ deployReport: r })), 'DP-B1');
    expect(s.score).toBe(0);
    expect(s.verdict).toBe('🔴');
  });

  it('DP-L1 red when prod is live but staging never was (ladder skip)', () => {
    const r = deployReport();
    r.environments[1].url = undefined; // staging dark
    const s = byId(scoreDeployment(ctx({ deployReport: r })), 'DP-L1');
    expect(s.score).toBe(0);
    expect(s.verdict).toBe('🔴');
  });

  it('DP-S2 red when deployed but no smoke surfaced anywhere', () => {
    const r = deployReport();
    for (const e of r.environments) e.smokeStatus = undefined;
    const s = byId(scoreDeployment(ctx({ deployReport: r })), 'DP-S2');
    expect(s.score).toBe(0);
    expect(s.verdict).toBe('🔴');
  });

  it('DP-U1 red + IE20/F19 attribution when the recorded URL is truncated', () => {
    const r = deployReport();
    r.current!.publicUrl = 'futurator.ai/apps/bri'; // truncated, no scheme
    for (const e of r.environments) e.url = undefined;
    const s = byId(scoreDeployment(ctx({ deployReport: r })), 'DP-U1');
    expect(s.score).toBe(0);
    expect(s.verdict).toBe('🔴');
    expect(s.ieIds).toContain('IE20');
    expect(s.fixIds.map((f) => f.id)).toContain('F19');
  });

  it('DP-O1 yellow when one deployed rung is dark', () => {
    const r = deployReport();
    r.environments[0].activeJobId = undefined; // dev dark but live
    const s = byId(scoreDeployment(ctx({ deployReport: r })), 'DP-O1');
    expect(s.score).toBe(2);
    expect(s.verdict).toBe('🟡');
  });
});

// ── never-deployed path ───────────────────────────────────────────────────────

describe('scoreDeployment — never deployed', () => {
  const r = deployReport({
    verdict: 'never-deployed',
    current: null,
    environments: [
      { environment: 'dev', status: 'none', canPromote: false },
      { environment: 'staging', status: 'none', canPromote: false },
      { environment: 'production', status: 'none', canPromote: false },
    ],
  });
  const slices = scoreDeployment(ctx({ deployReport: r }));

  it('build/release/url all degrade to ⚪ (nothing to score)', () => {
    for (const id of ['DP-B1', 'DP-R1', 'DP-S1', 'DP-U1']) {
      expect(byId(slices, id).verdict).toBe('⚪');
    }
  });

  it('DP-L1 stays green — no prod release means no ladder skip', () => {
    expect(byId(slices, 'DP-L1').verdict).toBe('🟢');
  });
});

// ── missing deploy report ─────────────────────────────────────────────────────

describe('scoreDeployment — no deploy report at all', () => {
  const slices = scoreDeployment(ctx({ deployReport: undefined }));

  it('report-dependent criteria are ⚪ with notes', () => {
    for (const id of ['DP-B1', 'DP-L1', 'DP-R1', 'DP-S2', 'DP-D1', 'DP-O1']) {
      const s = byId(slices, id);
      expect(s.verdict).toBe('⚪');
      expect(s.note).toMatch(/needs-instrumentation/i);
    }
  });

  it('still emits all 12 DP-* slices', () => {
    expect(slices).toHaveLength(12);
  });
});
