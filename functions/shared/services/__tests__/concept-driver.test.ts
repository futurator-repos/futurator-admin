import { describe, it, expect, vi } from 'vitest';
import { driveConcept, type ConceptDriverDeps } from '../concept-driver';
import { generateSectionManifest } from '../../concept/section-manifest';
import type { Plan } from '../../types/plan';
import type { AgentJob } from '../../types/agent-orchestrator';
import type { ConceptArtifact } from '../../concept/artifact-version';
import type { ConceptPlan } from '../../concept/concept-plan';

const UI_PLAN: ConceptPlan = {
  uiBearing: true,
  complexity: 'medium',
  gate: 'light',
  rationale: 'ui',
  artifacts: [
    { kind: 'prd', depth: 'light' },
    { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
  ],
};

const PRD_MD = ['# PRD', '', 'x', '', '## Functional Requirements', '', 'FR1'].join('\n');

function art(
  kind: ConceptArtifact['kind'],
  status: ConceptArtifact['status'],
  rev: number,
  dependsOn: ConceptArtifact['dependsOn'] = [],
): ConceptArtifact {
  return { kind, status, rev, dependsOn, contentHash: rev > 0 ? `sha256:${kind}` : '' };
}

/** A mock store + deps. Jobs created/updated are captured. */
function harness(plan: Plan, jobs: Record<string, AgentJob> = {}) {
  let current = plan;
  const created: AgentJob[] = [];
  const deps: ConceptDriverDeps = {
    getPlanById: vi.fn(async () => current),
    getJobById: vi.fn(async (id: string) => jobs[id] ?? null),
    createJob: vi.fn(async (job: AgentJob) => {
      created.push(job);
      jobs[job.jobId] = job;
    }),
    updatePlanFields: vi.fn(async (_id: string, patch: Partial<Plan>) => {
      current = { ...current, ...patch };
    }),
    getApp: vi.fn(async () => ({ boilerplateType: 'nextjs-base' })),
    uuid: (() => {
      let n = 0;
      return () => `job-new-${++n}`;
    })(),
    now: () => '2026-06-17T00:00:00.000Z',
  };
  return {
    deps,
    created,
    get current() {
      return current;
    },
  };
}

function basePlan(over: Partial<Plan> = {}): Plan {
  return {
    planId: 'p1',
    appId: 'app1',
    name: 'demo',
    intent: 'build a thing',
    executionMode: 'pipeline',
    rigor: 'mvp',
    status: 'concept',
    workingDir: '/home/ubuntu/projects/demo',
    createdBy: 'u@e.com',
    conceptPlan: UI_PLAN,
    conceptInteraction: 'autopilot',
    ...over,
  } as unknown as Plan;
}

describe('driveConcept (Story 3.2 — driver)', () => {
  it('prototype/legacy (no conceptPlan) → noop', async () => {
    const plan = basePlan({ conceptPlan: undefined });
    const h = harness(plan);
    expect(await driveConcept(plan, h.deps)).toMatchObject({ kind: 'noop' });
    expect(h.created).toHaveLength(0);
  });

  it('fresh plan → enqueues the prd generator + stamps prdGenJobId', async () => {
    const plan = basePlan({
      conceptArtifacts: [
        art('prd', 'draft', 0),
        art('ux', 'draft', 0, ['prd']),
        art('architecture', 'draft', 0, ['prd', 'ux']),
      ],
    });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    expect(res).toMatchObject({ kind: 'enqueued-artifact', artifact: 'prd', jobId: 'job-new-1' });
    expect(h.created).toHaveLength(1);
    expect(h.current.prdGenJobId).toBe('job-new-1');
    expect(h.current.conceptArtifactJobIds?.prd).toBe('job-new-1');
  });

  it('autopilot: a COMPLETED prd-gen applies+auto-approves, then enqueues ux (AC#4)', async () => {
    const { manifest } = generateSectionManifest(PRD_MD, { artifact: 'prd', rev: 0 });
    const plan = basePlan({
      conceptArtifacts: [
        art('prd', 'draft', 0),
        art('ux', 'draft', 0, ['prd']),
        art('architecture', 'draft', 0, ['prd', 'ux']),
      ],
      prdGenJobId: 'prd-job',
      conceptArtifactJobIds: { prd: 'prd-job' },
    });
    const jobs: Record<string, AgentJob> = {
      'prd-job': {
        jobId: 'prd-job',
        status: 'COMPLETED',
        variables: { PRD_SECTIONS_JSON: JSON.stringify(manifest) },
      } as unknown as AgentJob,
    };
    const h = harness(plan, jobs);
    const res = await driveConcept(plan, h.deps);
    // prd was applied + auto-approved → next is ux.
    expect(res).toMatchObject({ kind: 'enqueued-artifact', artifact: 'ux' });
    const prdRow = h.current.conceptArtifacts?.find((a) => a.kind === 'prd');
    expect(prdRow?.status).toBe('approved');
    expect(h.current.uxGenJobId).toBeDefined();
  });

  it('does NOT double-enqueue when an in-flight generator FK exists (AC#5)', async () => {
    const plan = basePlan({
      conceptArtifacts: [
        art('prd', 'draft', 0),
        art('ux', 'draft', 0, ['prd']),
        art('architecture', 'draft', 0, ['prd', 'ux']),
      ],
      prdGenJobId: 'prd-running',
      conceptArtifactJobIds: { prd: 'prd-running' },
    });
    const jobs: Record<string, AgentJob> = {
      'prd-running': {
        jobId: 'prd-running',
        status: 'RUNNING',
        variables: {},
      } as unknown as AgentJob,
    };
    const h = harness(plan, jobs);
    const res = await driveConcept(plan, h.deps);
    expect(res).toMatchObject({ kind: 'skip-inflight', artifact: 'prd', jobId: 'prd-running' });
    expect(h.created).toHaveLength(0);
  });

  it('all artifacts approved → enqueues the chain-driven pm-plan, dedups on re-run', async () => {
    const plan = basePlan({
      conceptArtifacts: [
        art('prd', 'approved', 1),
        art('ux', 'approved', 1, ['prd']),
        art('architecture', 'approved', 1, ['prd', 'ux']),
      ],
    });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    expect(res).toMatchObject({ kind: 'enqueued-pm-plan' });
    expect(h.current.conceptPmPlanJobId).toBeDefined();

    // Re-run: pm-plan FK now set + job PENDING → no duplicate.
    const pmId = h.current.conceptPmPlanJobId!;
    h.deps.getJobById = vi.fn(async (id: string) =>
      id === pmId ? ({ jobId: pmId, status: 'PENDING' } as unknown as AgentJob) : null,
    );
    const before = h.created.length;
    const res2 = await driveConcept(h.current, h.deps);
    expect(res2).toMatchObject({ kind: 'noop' });
    expect(h.created.length).toBe(before);
  });

  it('interactive (Round 1): a FRESH plan enqueues a one-shot DRAFT generator in the plan worktree (no dead convergence job)', async () => {
    const plan = basePlan({
      conceptInteraction: 'interactive',
      conceptArtifacts: [
        art('prd', 'draft', 0),
        art('ux', 'draft', 0, ['prd']),
        art('architecture', 'draft', 0, ['prd', 'ux']),
      ],
    });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    // Round 1: interactive uses the SAME runnable gen pipeline as autopilot; the
    // only difference is it is applied as a DRAFT (awaiting-approval), not
    // auto-approved. The prior `conceptConvergence` job (nothing consumed it) is
    // gone — that was the stall.
    expect(res).toMatchObject({ kind: 'enqueued-artifact', artifact: 'prd' });
    expect(h.created).toHaveLength(1);
    const job = h.created[0] as unknown as {
      conceptConvergence?: unknown;
      conceptArtifactKind?: string;
      pipeline?: unknown;
    };
    expect(job.conceptConvergence).toBeUndefined(); // no dead-end convergence job
    expect(job.pipeline).toBeDefined(); // a real runnable gen pipeline
    expect(job.conceptArtifactKind).toBe('prd');
  });

  it('interactive: a drafted-but-not-approved prd → awaiting-approval, nothing enqueued', async () => {
    const plan = basePlan({
      conceptInteraction: 'interactive',
      conceptArtifacts: [
        art('prd', 'draft', 1),
        art('ux', 'draft', 0, ['prd']),
        art('architecture', 'draft', 0, ['prd', 'ux']),
      ],
    });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    expect(res).toMatchObject({ kind: 'awaiting-approval', artifact: 'prd' });
    expect(h.created).toHaveLength(0);
  });
});
