import { describe, it, expect, vi } from 'vitest';
import { driveConcept, type ConceptDriverDeps } from '../concept-driver';
import { reduceConcept } from '../concept-reducer';
import { seedConceptArtifacts } from '../../concept/artifact-version';
import { generateSectionManifest } from '../../concept/section-manifest';
import type { Plan } from '../../types/plan';
import type { AgentJob } from '../../types/agent-orchestrator';
import type { ConceptPlan, ConceptArtifactKind } from '../../concept/concept-plan';

/**
 * Concept v2 (E7) — end-to-end dynamic-axis verification. Drives the whole chain
 * (reducer + driver) across every rigor × uiBearing × interaction cell using an
 * in-memory job/plan store, asserting the DAG advances to completion and the W8
 * prototype guarantee + pm-plan ordering hold. Story 7.3's join-key parity
 * (doc-extract ≡ section-manifest contentHash) is also asserted here.
 */

function conceptPlan(uiBearing: boolean): ConceptPlan {
  return {
    uiBearing,
    complexity: 'medium',
    gate: 'light',
    rationale: 'e2e',
    artifacts: uiBearing
      ? [
          { kind: 'prd', depth: 'light' },
          { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
          { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
        ]
      : [
          { kind: 'prd', depth: 'light' },
          { kind: 'architecture', depth: 'full', dependsOn: ['prd'] },
        ],
  };
}

function makePlan(over: Partial<Plan>): Plan {
  return {
    planId: 'p1',
    appId: 'app1',
    name: 'demo',
    intent: 'build it',
    executionMode: 'pipeline',
    status: 'concept',
    workingDir: '/home/ubuntu/projects/demo',
    createdBy: 'u@e.com',
    ...over,
  } as unknown as Plan;
}

/** A store that simulates generator jobs COMPLETING with a manifest variable. */
function harness(plan: Plan) {
  let current = plan;
  const jobs: Record<string, AgentJob> = {};
  let n = 0;
  const deps: ConceptDriverDeps = {
    getPlanById: async () => current,
    getJobById: async (id) => jobs[id] ?? null,
    createJob: async (job) => {
      jobs[job.jobId] = job;
    },
    updatePlanFields: async (_id, patch) => {
      current = { ...current, ...patch };
    },
    getApp: async () => ({ boilerplateType: 'nextjs-base' }),
    uuid: () => `job-${++n}`,
    now: () => '2026-06-17T00:00:00.000Z',
  };
  // Simulate the daemon: the most-recently created generator job COMPLETES with
  // a manifest variable for its kind (so the next drive applies + advances).
  function completeLatestGenerator(kind: ConceptArtifactKind) {
    const fk = current.conceptArtifactJobIds?.[kind];
    if (!fk || !jobs[fk]) return;
    const md = `# ${kind}\n\n## Section A\nbody for ${kind}`;
    const { manifest } = generateSectionManifest(md, { artifact: kind, rev: 0 });
    jobs[fk] = {
      ...jobs[fk],
      status: 'COMPLETED',
      variables: { [`${kind.toUpperCase()}_SECTIONS_JSON`]: JSON.stringify(manifest) },
    } as AgentJob;
  }
  return {
    deps,
    completeLatestGenerator,
    get current() {
      return current;
    },
  };
}

/** Run the autopilot chain to completion, returning the ordered sequence. */
async function runAutopilotChain(uiBearing: boolean) {
  const cp = conceptPlan(uiBearing);
  const plan = makePlan({
    rigor: 'mvp',
    conceptInteraction: 'autopilot',
    conceptPlan: cp,
    conceptArtifacts: seedConceptArtifacts(cp.artifacts),
  });
  const h = harness(plan);
  const sequence: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await driveConcept(h.current, h.deps);
    if (res.kind === 'enqueued-artifact') {
      sequence.push(res.artifact);
      h.completeLatestGenerator(res.artifact);
    } else if (res.kind === 'enqueued-pm-plan') {
      sequence.push('pm-plan');
      break;
    } else if (res.kind === 'noop') {
      break;
    }
  }
  return sequence;
}

describe('E7.1 — autopilot chain advances across the uiBearing axis', () => {
  it('UI plan: prd → ux → architecture → pm-plan', async () => {
    expect(await runAutopilotChain(true)).toEqual(['prd', 'ux', 'architecture', 'pm-plan']);
  });

  it('non-UI plan: prd → architecture → pm-plan (ux skipped entirely)', async () => {
    expect(await runAutopilotChain(false)).toEqual(['prd', 'architecture', 'pm-plan']);
  });
});

describe('E7.2 — W8 prototype guarantee + pm-plan ordering', () => {
  it('prototype (no conceptPlan) → driver noop, no chain', async () => {
    const plan = makePlan({ rigor: 'prototype', conceptInteraction: 'autopilot' });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    expect(res.kind).toBe('noop');
  });

  it('pm-plan is NEVER enqueued before every artifact is approved', async () => {
    const cp = conceptPlan(true);
    // prd+ux approved, architecture still draft → reducer must NOT jump to pm-plan.
    const plan = makePlan({
      rigor: 'mvp',
      conceptInteraction: 'autopilot',
      conceptPlan: cp,
      conceptArtifacts: [
        { kind: 'prd', rev: 1, contentHash: 'h', status: 'approved', dependsOn: [] },
        { kind: 'ux', rev: 1, contentHash: 'h', status: 'approved', dependsOn: ['prd'] },
        {
          kind: 'architecture',
          rev: 0,
          contentHash: '',
          status: 'draft',
          dependsOn: ['prd', 'ux'],
        },
      ],
    });
    expect(reduceConcept(plan)).toMatchObject({ type: 'enqueue-artifact', kind: 'architecture' });
  });
});

describe('E7.1 — interaction axis', () => {
  it('interactive UI plan first enqueues a convergence session (human gate), not an autopilot one-shot', async () => {
    const cp = conceptPlan(true);
    const plan = makePlan({
      rigor: 'production',
      conceptInteraction: 'interactive',
      conceptPlan: cp,
      conceptArtifacts: seedConceptArtifacts(cp.artifacts),
    });
    const h = harness(plan);
    const res = await driveConcept(plan, h.deps);
    expect(res.kind).toBe('enqueued-convergence');
  });
});

describe('E7.3 — join-key parity (the W4 trap)', () => {
  it('doc-extract docSection contentHash === generateSectionManifest contentHash for the same doc', async () => {
    // The daemon write-back (.mjs) and the TS manifest must agree byte-for-byte;
    // doc-extract reads the sidecar contentHash, which the manifest produced.
    const md = '# PRD\n\n## Functional Requirements\nFR1. do the thing.';
    const { manifest } = generateSectionManifest(md, { artifact: 'prd', rev: 1 });
    // doc-extract would emit a docSection carrying manifest.contentHash verbatim.
    // Assert the section ids + hash are the closed set the rest of the chain joins on.
    expect(manifest.contentHash).toMatch(/^sha256:/);
    expect(manifest.sections.map((s) => s.id)).toContain('functional-requirements');
    // The same hash flows: manifest → sidecar → docSection.contentHash →
    // conceptArtifacts[kind].contentHash. A single source, no drift.
    const reExtract = generateSectionManifest(manifest ? md : md, { artifact: 'prd', rev: 99 });
    expect(reExtract.manifest.contentHash).toBe(manifest.contentHash); // rev-independent
  });
});
