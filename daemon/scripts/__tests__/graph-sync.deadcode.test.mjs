/**
 * graph-sync.deadcode.test.mjs — Story SG-2.3 (dead-code detector, W2).
 *
 * Dead code = a `file` whose ONLY incident edge is CONTAINS. It must be a
 * DIFFERENT query from the orphan invariant: a dead file (degree-1 via CONTAINS)
 * appears here and NOT in orphans.json. Advisory, never a wave-gate failure.
 */

import { describe, it, expect } from 'vitest';
import { reportDeadCode, reportOrphans } from '../lib/graph-integrity.mjs';
import { makeGraphSession } from './helpers/fake-graph.mjs';

describe('reportDeadCode (SG-2.3)', () => {
  it('flags a file whose only edge is CONTAINS', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'dir/src', kind: 'dir' },
        { id: 'code/src--dead.ts', kind: 'file', updated: '2026-06-01', title: 'dead.ts' },
      ],
      edges: [{ from: 'dir/src', to: 'code/src--dead.ts', type: 'CONTAINS' }],
    });
    const dead = await reportDeadCode(s, 'p');
    expect(dead.map((d) => d.id)).toEqual(['code/src--dead.ts']);
    expect(dead[0].updated).toBe('2026-06-01');
    expect(dead[0].title).toBe('dead.ts');
  });

  it('does NOT flag a file that imports something live', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'code/a.ts', kind: 'file' },
        { id: 'code/b.ts', kind: 'file' },
      ],
      edges: [
        { from: 'dir/.', to: 'code/a.ts', type: 'CONTAINS' },
        { from: 'dir/.', to: 'code/b.ts', type: 'CONTAINS' },
        { from: 'code/a.ts', to: 'code/b.ts', type: 'IMPORTS' },
      ],
    });
    const dead = await reportDeadCode(s, 'p');
    // a imports b → a is live; b is imported → b is live. Neither is dead.
    expect(dead).toHaveLength(0);
  });

  it('does NOT flag a file that READS a table or CALLS_SERVICE', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'code/repo.ts', kind: 'file' },
        { id: 'infra/table/Costs', kind: 'table' },
      ],
      edges: [
        { from: 'dir/.', to: 'code/repo.ts', type: 'CONTAINS' },
        { from: 'code/repo.ts', to: 'infra/table/Costs', type: 'READS' },
      ],
    });
    const dead = await reportDeadCode(s, 'p');
    expect(dead).toHaveLength(0);
  });

  it('does NOT flag a file that defines a symbol that is called', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'code/util.ts', kind: 'file' },
        { id: 'code/util.ts#function:helper', kind: 'function' },
        { id: 'code/main.ts#function:run', kind: 'function' },
      ],
      edges: [
        { from: 'dir/.', to: 'code/util.ts', type: 'CONTAINS' },
        { from: 'code/util.ts', to: 'code/util.ts#function:helper', type: 'DEFINES' },
        { from: 'code/main.ts#function:run', to: 'code/util.ts#function:helper', type: 'CALLS' },
      ],
    });
    const dead = await reportDeadCode(s, 'p');
    expect(dead.map((d) => d.id)).not.toContain('code/util.ts');
  });

  it('W2: a dead file appears in dead-code and NOT in orphans (distinct queries)', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'dir/src', kind: 'dir' },
        { id: 'code/src--dead.ts', kind: 'file' },
      ],
      edges: [{ from: 'dir/src', to: 'code/src--dead.ts', type: 'CONTAINS' }],
    });
    const dead = await reportDeadCode(s, 'p');
    const { orphans } = await reportOrphans(s, 'p');
    expect(dead.map((d) => d.id)).toContain('code/src--dead.ts');
    expect(orphans.map((o) => o.id)).not.toContain('code/src--dead.ts');
  });

  it('ignores pruned files', async () => {
    const s = makeGraphSession({
      nodes: [{ id: 'code/old.ts', kind: 'file', status: 'pruned' }],
      edges: [{ from: 'dir/.', to: 'code/old.ts', type: 'CONTAINS' }],
    });
    const dead = await reportDeadCode(s, 'p');
    expect(dead).toHaveLength(0);
  });
});
