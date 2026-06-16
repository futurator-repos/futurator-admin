/**
 * propagator.trigger.test.mjs — Story 6.5. Autonomous trigger (threshold OR
 * wave gate), consent-gated PROPOSED stories (nothing auto-merged), and the
 * lastPropagatedTo marker that only moves when a port story reaches Done.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldPropagate,
  buildProposals,
  markerUpdateFor,
  applyMarkerUpdate,
} from '../propagator.mjs';

describe('shouldPropagate', () => {
  it('wave-gate trigger always fires (the default)', () => {
    expect(shouldPropagate({ trigger: 'wave-gate', driftCounts: {} })).toBe(true);
  });

  it('drift-threshold fires only when a sibling crosses the threshold', () => {
    expect(shouldPropagate({ trigger: 'drift-threshold', driftCounts: { mobile: 2, office: 0 }, threshold: 3 })).toBe(false);
    expect(shouldPropagate({ trigger: 'drift-threshold', driftCounts: { mobile: 3, office: 0 }, threshold: 3 })).toBe(true);
  });

  it('unknown trigger never fires', () => {
    expect(shouldPropagate({ trigger: 'manual', driftCounts: { mobile: 99 } })).toBe(false);
  });
});

describe('buildProposals — consent-gated', () => {
  const briefs = [
    {
      sibling: 'mobile',
      trigger: 'wave-gate',
      brief: 'PlanScreen needs a dependency picker',
      contractChanges: [{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }],
      proposedStory: { title: 'Port plan-dependencies to Mobile', epic: 'labs-parity' },
      requiresApproval: true,
    },
  ];

  it('produces a PROPOSED story per brief, requiresApproval, nothing auto-merged', () => {
    const proposals = buildProposals(briefs, { sourceProject: 'labs', atCommit: 'abc123', ts: '2026-06-16T00:00:00Z' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      sourceProject: 'labs',
      sibling: 'mobile',
      status: 'proposed',
      requiresApproval: true,
      atCommit: 'abc123',
    });
    expect(proposals[0].proposalId).toBe('prop/labs->mobile/abc123');
    expect(proposals[0].proposedStory.title).toBe('Port plan-dependencies to Mobile');
    // never carries an "applied"/"merged" status
    expect(proposals[0].status).not.toBe('merged');
  });
});

describe('marker update — only on Done', () => {
  it('derives the contract nodes + commit to stamp from a proposal', () => {
    const proposal = {
      sibling: 'mobile',
      atCommit: 'abc123',
      contractChanges: [
        { node: 'infra/table/PlansTable', change: 'x' },
        { node: 'infra/table/PlansTable', change: 'y' }, // dedup
        { node: 'endpoint/POST /plans/:id/validate', change: 'new' },
      ],
    };
    expect(markerUpdateFor(proposal)).toEqual({
      sibling: 'mobile',
      atCommit: 'abc123',
      contractNodes: ['infra/table/PlansTable', 'endpoint/POST /plans/:id/validate'],
    });
  });

  it('stamps lastPropagatedTo_<sibling> on each contract node (query-safe prop)', async () => {
    const calls = [];
    const session = {
      async run(q, p) {
        calls.push({ q, p });
        return { records: [] };
      },
      async close() {},
    };
    const res = await applyMarkerUpdate(session, {
      sibling: 'mobile',
      contractNodes: ['infra/table/PlansTable'],
      atCommit: 'abc123',
    });
    expect(res).toEqual({ sibling: 'mobile', prop: 'lastPropagatedTo_mobile', updated: 1 });
    expect(calls[0].q).toContain('lastPropagatedTo_mobile');
    expect(calls[0].p).toEqual({ node: 'infra/table/PlansTable', atCommit: 'abc123' });
  });
});
