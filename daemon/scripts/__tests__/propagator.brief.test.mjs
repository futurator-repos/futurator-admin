/**
 * propagator.brief.test.mjs — Story 6.4. Drift → substrate-targeted port-brief:
 * RN hooks/screens for Mobile, Unity/C# prefabs for Office, naming the concrete
 * port target + the equivalent of the source component (Appendix E output).
 */

import { describe, it, expect } from 'vitest';
import { buildBrief, buildBriefs, substrateFor, SUBSTRATES } from '../propagator.mjs';

const capabilities = [
  {
    nodeId: 'capability/plan-dependencies',
    label: 'Plan Dependencies',
    implementedBy: {
      labs: ['code/src--components--DependencyGraph.tsx'],
      mobile: ['code/src--screens--PlanScreen.tsx'],
      office: [], // Office has NO implementation yet → a gap
    },
    contract: { tables: ['PlansTable'], endpoints: ['POST /plans/:id/validate'] },
  },
];

const changes = [{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }];

describe('substrateFor', () => {
  it('frames Mobile as React Native and Office as Unity/C#', () => {
    expect(substrateFor('mobile').framework).toBe('React Native');
    expect(substrateFor('office').framework).toBe('Unity');
    expect(SUBSTRATES.office.unit).toMatch(/prefab/i);
  });

  it('falls back to a generic descriptor for an unknown sibling', () => {
    expect(substrateFor('songster').name).toBe('songster');
  });
});

describe('buildBrief — substrate translation', () => {
  it('targets the concrete Mobile screen and names the RN equivalent of the Labs component', () => {
    const brief = buildBrief({ sourceProject: 'labs', sibling: 'mobile', changes, trigger: 'wave-gate', capabilities });
    expect(brief.sibling).toBe('mobile');
    expect(brief.requiresApproval).toBe(true);
    expect(brief.contractChanges).toEqual([{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }]);
    expect(brief.brief).toContain('src/screens/PlanScreen.tsx');
    expect(brief.brief).toContain('React Native');
    expect(brief.brief).toContain('src/components/DependencyGraph.tsx');
    expect(brief.proposedStory).toEqual({ title: 'Port Plan Dependencies to Mobile', epic: 'labs-parity' });
  });

  it('marks a <new prefab> port target for Office where the sibling has no implementation', () => {
    const brief = buildBrief({ sourceProject: 'labs', sibling: 'office', changes, trigger: 'drift-threshold', capabilities });
    expect(brief.brief).toContain('<new C# prefab>');
    expect(brief.brief).toContain('Unity');
    expect(brief.proposedStory.title).toContain('to Office');
  });

  it('falls back to <new …> when no capability maps the changed contract', () => {
    const brief = buildBrief({
      sourceProject: 'labs',
      sibling: 'mobile',
      changes: [{ node: 'infra/table/Unmapped', change: 'new' }],
      trigger: 'wave-gate',
      capabilities,
    });
    expect(brief.brief).toContain('<new hook/screen>');
    expect(brief.requiresApproval).toBe(true);
  });
});

describe('buildBriefs — one per affected sibling', () => {
  it('skips siblings with no pending drift', () => {
    const report = [
      { sibling: 'mobile', changes, pendingCount: 1 },
      { sibling: 'office', changes: [], pendingCount: 0 }, // no drift → no brief
    ];
    const briefs = buildBriefs(report, { sourceProject: 'labs', trigger: 'wave-gate', capabilities });
    expect(briefs).toHaveLength(1);
    expect(briefs[0].sibling).toBe('mobile');
    expect(briefs.every((b) => b.requiresApproval === true)).toBe(true);
  });
});
