import { describe, it, expect } from 'vitest';
import { buildReverseImpactCypher, STRUCTURAL_EDGE_TYPES, queryImpact } from '../lib/impact-propagation.mjs';
import { createMemoryGraphStore } from '../lib/graph-store-memory.mjs';

describe('buildReverseImpactCypher', () => {
  it('reverse-traverses only the deterministic structural edges', () => {
    const q = buildReverseImpactCypher();
    expect(q).toMatch(/<-\[:IMPORTS\|CALLS\|RENDERS\|TESTS\*1\.\.4\]-/);
    expect(q).not.toMatch(/DEPENDS_ON|VALIDATES/); // never the guessed semantic edges
  });
  it('clamps hops into [1,6]', () => {
    expect(buildReverseImpactCypher(99)).toMatch(/\*1\.\.6\]/);
    expect(buildReverseImpactCypher(0)).toMatch(/\*1\.\.1\]/);
  });
  it('exposes the structural edge set', () => {
    expect(STRUCTURAL_EDGE_TYPES).toEqual(['IMPORTS', 'CALLS', 'RENDERS', 'TESTS']);
  });
});

// EU-migration S2.2: bolt/Memgraph EXCISED — queryImpact now reverse-BFSes the
// GraphStore's `inEdges`, so the test drives the real in-memory store (the same
// code path the DynamoDB impl exposes) instead of a fake neo4j session.
describe('queryImpact (read-only)', () => {
  const PID = 'p';

  it('returns impacted nodes at their shortest hop + surfaces covering tests', async () => {
    const store = createMemoryGraphStore();
    await store.putNodes(PID, [
      { nodeId: 'code/token.ts', kind: 'file', label: 'token.ts' },
      { nodeId: 'code/login.ts', kind: 'file', label: 'login.ts' },
      { nodeId: 'code/login.test.ts', kind: 'file', label: 'login.test.ts' },
    ]);
    // login.ts IMPORTS token.ts  → token.ts's reverse-reach at hop 1 is login.ts
    // login.test.ts TESTS login.ts → the covering test at hop 2
    await store.putEdges(PID, [
      { from: 'code/login.ts', to: 'code/token.ts', type: 'IMPORTS' },
      { from: 'code/login.test.ts', to: 'code/login.ts', type: 'TESTS' },
    ]);

    const r = await queryImpact('code/token.ts', store, { projectId: PID });
    expect(r.sourceNodeId).toBe('code/token.ts');
    expect(r.impacted.find((n) => n.nodeId === 'code/login.ts').hops).toBe(1);
    expect(r.impacted.find((n) => n.nodeId === 'code/login.test.ts').hops).toBe(2);
    expect(r.impacted).toHaveLength(2);
    expect(r.tests).toEqual(['code/login.test.ts']); // the covering test, for selective regression
  });

  it('empty graph → empty impact (no throw)', async () => {
    const store = createMemoryGraphStore();
    const r = await queryImpact('x', store, { projectId: PID });
    expect(r.impacted).toEqual([]);
    expect(r.tests).toEqual([]);
  });

  it('requires a projectId (the store is project-partitioned)', async () => {
    const store = createMemoryGraphStore();
    await expect(queryImpact('x', store, {})).rejects.toThrow(/projectId/);
  });
});
