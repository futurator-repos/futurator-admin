/**
 * propagator-service.test.ts — Seam B. Approve → enqueue: a registered sibling
 * gets a real PENDING port-story job; an unregistered sibling approves-only
 * (the enqueue is gated on registration, never speculative).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSiblingPipelines,
  buildSiblingJob,
  type SiblingPipelineConfig,
} from '../propagator-service';
import type { PropagatorProposal } from '../../types/propagator';

const proposal = (over: Partial<PropagatorProposal> = {}): PropagatorProposal => ({
  proposalId: 'prop/labs->mobile/abc',
  sourceProject: 'labs',
  sibling: 'mobile',
  trigger: 'wave-gate',
  status: 'approved',
  requiresApproval: true,
  brief: 'PlanScreen needs a dependency picker',
  contractChanges: [{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }],
  proposedStory: { title: 'Port plan-dependencies to Mobile', epic: 'labs-parity' },
  atCommit: 'abc',
  createdAt: '2026-06-16T00:00:00Z',
  ...over,
});

const registry: Record<string, SiblingPipelineConfig> = {
  mobile: {
    workingDir: '/repos/mobile',
    pipeline: { agents: {}, steps: [{ id: 'dev', agentId: 'dev', prompt: 'port it' }] },
  },
};

describe('parseSiblingPipelines', () => {
  it('parses a valid registry JSON', () => {
    const raw = JSON.stringify(registry);
    expect(parseSiblingPipelines(raw).mobile.workingDir).toBe('/repos/mobile');
  });

  it('returns {} for undefined / malformed / shape-invalid input (never throws)', () => {
    expect(parseSiblingPipelines(undefined)).toEqual({});
    expect(parseSiblingPipelines('not json')).toEqual({});
    expect(parseSiblingPipelines(JSON.stringify({ mobile: { workingDir: '/x' } }))).toEqual({}); // no pipeline.steps
  });
});

describe('buildSiblingJob', () => {
  const ctx = { jobId: 'job-1', now: '2026-06-16T01:00:00Z', createdBy: 'op@futurator' };

  it('enqueues a PENDING job for a registered sibling, carrying story + linkage vars', () => {
    const decision = buildSiblingJob(proposal(), registry, ctx);
    expect(decision.enqueue).toBe(true);
    if (!decision.enqueue) throw new Error('expected enqueue');
    expect(decision.job).toMatchObject({
      jobId: 'job-1',
      status: 'PENDING',
      workingDir: '/repos/mobile',
      projectId: 'mobile',
    });
    const vars = decision.job.pipeline!.initialVariables!;
    expect(vars.STORY_TITLE).toBe('Port plan-dependencies to Mobile');
    expect(vars.EPIC_ID).toBe('labs-parity');
    expect(vars.PROPAGATOR_PROPOSAL_ID).toBe('prop/labs->mobile/abc');
    expect(JSON.parse(vars.PROPAGATOR_CONTRACT_CHANGES)).toHaveLength(1);
  });

  it('approves-only when the sibling is not registered (no speculative enqueue)', () => {
    const decision = buildSiblingJob(proposal({ sibling: 'office' }), registry, ctx);
    expect(decision.enqueue).toBe(false);
    if (decision.enqueue) throw new Error('expected no enqueue');
    expect(decision.reason).toMatch(/office.*not registered/);
  });
});
