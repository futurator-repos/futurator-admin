/**
 * propagator.drift.test.mjs — Story 6.3. Per-sibling drift report: scoped to
 * what each sibling actually consumes (N/A where it doesn't), so a brief targets
 * only real gaps.
 */

import { describe, it, expect } from 'vitest';
import { buildDriftReport, readSiblings, readConsumers, perSiblingDrift } from '../propagator.mjs';

const changes = [
  { node: 'contract/table/Plans', change: 'field +dependsOn:string[]' },
  { node: 'contract/endpoint/POST_-plans-:id-validate', change: 'new' },
];

describe('buildDriftReport (Story 6.3)', () => {
  it('lists per sibling only the changes on contracts that sibling consumes', () => {
    const report = buildDriftReport({
      sourceProject: 'labs',
      changes,
      siblings: ['mobile', 'office'],
      consumes: [
        { projectId: 'mobile', contract: 'contract/table/Plans' },
        { projectId: 'mobile', contract: 'contract/endpoint/POST_-plans-:id-validate' },
        { projectId: 'office', contract: 'contract/table/Plans' }, // office consumes only the table
      ],
    });
    const mobile = report.find((r) => r.sibling === 'mobile');
    const office = report.find((r) => r.sibling === 'office');
    expect(mobile.pendingCount).toBe(2);
    expect(office.pendingCount).toBe(1);
    // office gets N/A for the endpoint it doesn't consume
    expect(office.notApplicable).toEqual([
      { node: 'contract/endpoint/POST_-plans-:id-validate', change: 'new', status: 'N/A' },
    ]);
  });

  it('sorts most-affected siblings first and never briefs the source project', () => {
    const report = buildDriftReport({
      sourceProject: 'labs',
      changes,
      siblings: ['labs', 'office', 'mobile'],
      consumes: [
        { projectId: 'mobile', contract: 'contract/table/Plans' },
        { projectId: 'mobile', contract: 'contract/endpoint/POST_-plans-:id-validate' },
        { projectId: 'office', contract: 'contract/table/Plans' },
      ],
    });
    expect(report.map((r) => r.sibling)).toEqual(['mobile', 'office']); // labs excluded, mobile first
  });

  it('a sibling that consumes nothing gets an all-N/A report (no false brief)', () => {
    const report = buildDriftReport({
      sourceProject: 'labs',
      changes,
      siblings: ['office'],
      consumes: [],
    });
    expect(report[0].pendingCount).toBe(0);
    expect(report[0].notApplicable).toHaveLength(2);
  });
});

describe('perSiblingDrift (graph reads + build)', () => {
  function makeSession() {
    return {
      async run(query, params = {}) {
        if (/MATCH \(s:Node \{kind: 'service'\}\) WHERE s\.projectId <> \$sourceProject/.test(query)) {
          return {
            records: [{ projectId: 'mobile' }, { projectId: 'office' }, { projectId: params.sourceProject }]
              .filter((r) => r.projectId !== params.sourceProject)
              .map((r) => ({ get: (k) => r[k] })),
          };
        }
        if (/-\[:CONSUMES_CONTRACT\]->\(c:Node\)/.test(query)) {
          const edges = [
            { projectId: 'mobile', contract: 'contract/table/Plans' },
            { projectId: 'office', contract: 'contract/table/Plans' },
          ].filter((e) => params.contractNodes.includes(e.contract));
          return { records: edges.map((e) => ({ get: (k) => e[k] })) };
        }
        return { records: [] };
      },
      async close() {},
    };
  }

  it('reads siblings + consumers and produces the scoped report', async () => {
    const session = makeSession();
    expect(await readSiblings(session, 'labs')).toEqual(['mobile', 'office']);
    const consumers = await readConsumers(session, ['contract/table/Plans']);
    expect(consumers).toHaveLength(2);

    const report = await perSiblingDrift(session, { sourceProject: 'labs', changes });
    const mobile = report.find((r) => r.sibling === 'mobile');
    expect(mobile.changes.map((c) => c.node)).toEqual(['contract/table/Plans']);
    expect(mobile.notApplicable).toHaveLength(1); // the endpoint nobody consumes
  });
});
