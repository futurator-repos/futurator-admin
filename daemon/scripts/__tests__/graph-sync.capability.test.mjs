/**
 * graph-sync.capability.test.mjs — Stories 5.2 + 5.3. The curated Capability
 * layer (capability nodes + IMPLEMENTS edges, DECLARED provenance) and the
 * coverage-gap detector (W8 — untagged components touching a shared contract).
 */

import { describe, it, expect } from 'vitest';
import {
  buildCapabilityIngest,
  writeCapabilities,
  computeCapabilityGaps,
  readCapabilityCoverage,
} from '../lib/capability.mjs';

describe('buildCapabilityIngest (Story 5.2)', () => {
  const seed = [
    {
      nodeId: 'capability/wave-gate-approval',
      label: 'Wave Gate Approval',
      implementedBy: {
        labs: ['code/src--components--WaveGate.tsx'],
        mobile: ['code/src--screens--WaveGateScreen.tsx'],
        office: [],
      },
      contract: { endpoints: ['POST /waves/:id/approve'], tables: ['WaveConflictsTable'] },
    },
  ];

  it('creates one capability node and an IMPLEMENTS edge per implementing component', () => {
    const ingest = buildCapabilityIngest(seed);
    expect(ingest.capabilityNodes).toHaveLength(1);
    expect(ingest.capabilityNodes[0]).toMatchObject({
      nodeId: 'capability/wave-gate-approval',
      provenance: 'DECLARED',
    });
    expect(ingest.implementsEdges).toEqual([
      { from: 'code/src--components--WaveGate.tsx', to: 'capability/wave-gate-approval', substrate: 'labs' },
      { from: 'code/src--screens--WaveGateScreen.tsx', to: 'capability/wave-gate-approval', substrate: 'mobile' },
    ]);
  });

  it('carries the contract (endpoints/tables) onto the node', () => {
    const ingest = buildCapabilityIngest(seed);
    expect(ingest.capabilityNodes[0].contract.tables).toEqual(['WaveConflictsTable']);
  });

  it('writeCapabilities MERGEs nodes then edges (DECLARED provenance)', async () => {
    const calls = [];
    const session = {
      async run(q, p) {
        calls.push({ q, p });
        return { records: [] };
      },
      async close() {},
    };
    const summary = await writeCapabilities(session, buildCapabilityIngest(seed));
    expect(summary).toEqual({ capabilityNodes: 1, implementsEdges: 2 });
    expect(calls[0].q).toMatch(/kind = 'capability'/);
    expect(calls[0].q).toMatch(/provenance = 'DECLARED'/);
    expect(calls.some((c) => /MERGE \(comp\)-\[rel:IMPLEMENTS\]->\(cap\)/.test(c.q))).toBe(true);
  });
});

describe('capability coverage gaps (Story 5.3 / W8)', () => {
  it('flags components that touch a shared contract but carry no capability tag', () => {
    const rows = [
      { nodeId: 'code/a.ts', title: 'a', contractTouches: 2, capCount: 0 }, // GAP
      { nodeId: 'code/b.ts', title: 'b', contractTouches: 1, capCount: 1 }, // tagged → ok
      { nodeId: 'code/c.ts', title: 'c', contractTouches: 0, capCount: 0 }, // doesn't touch → ok
      { nodeId: 'code/d.ts', title: 'd', contractTouches: 3, capCount: 0 }, // GAP (more touches)
    ];
    const gaps = computeCapabilityGaps(rows);
    expect(gaps.map((g) => g.nodeId)).toEqual(['code/d.ts', 'code/a.ts']); // sorted by touch count desc
  });

  it('readCapabilityCoverage maps the coverage query records', async () => {
    const session = {
      async run() {
        const rec = (o) => ({ get: (k) => o[k] });
        return {
          records: [
            rec({ nodeId: 'code/x.ts', title: 'x', contractTouches: 2, capCount: 0 }),
          ],
        };
      },
      async close() {},
    };
    const rows = await readCapabilityCoverage(session, 'labs');
    expect(rows[0]).toEqual({ nodeId: 'code/x.ts', title: 'x', contractTouches: 2, capCount: 0 });
    expect(computeCapabilityGaps(rows)).toHaveLength(1);
  });
});
