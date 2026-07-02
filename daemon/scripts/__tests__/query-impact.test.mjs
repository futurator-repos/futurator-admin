import { describe, it, expect } from 'vitest';
import { buildReverseImpactCypher, STRUCTURAL_EDGE_TYPES, queryImpact } from '../lib/impact-propagation.mjs';

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

// Minimal neo4j-driver stand-in.
function fakeDriver(rows) {
  const rec = (o) => ({ get: (k) => o[k] });
  return {
    session: () => ({
      run: async () => ({ records: rows.map(rec) }),
      close: async () => {},
    }),
  };
}

describe('queryImpact (read-only)', () => {
  it('returns impacted nodes deduped to shortest hop + surfaces covering tests', async () => {
    const driver = fakeDriver([
      { nodeId: 'code/login.ts', kind: 'file', label: 'login.ts', hops: 1 },
      { nodeId: 'code/login.ts', kind: 'file', label: 'login.ts', hops: 3 }, // longer path — dropped
      { nodeId: 'code/login.test.ts', kind: 'file', label: 'login.test.ts', hops: 1 },
    ]);
    const r = await queryImpact('code/token.ts', driver);
    expect(r.sourceNodeId).toBe('code/token.ts');
    expect(r.impacted.find((n) => n.nodeId === 'code/login.ts').hops).toBe(1);
    expect(r.impacted).toHaveLength(2);
    expect(r.tests).toEqual(['code/login.test.ts']); // the covering test, for selective regression
  });

  it('empty graph → empty impact (no throw)', async () => {
    const r = await queryImpact('x', fakeDriver([]));
    expect(r.impacted).toEqual([]);
    expect(r.tests).toEqual([]);
  });
});
