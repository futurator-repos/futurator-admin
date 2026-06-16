/**
 * graph-sync.orphan.test.mjs — Story SG-2.2 (orphan invariant tripwire).
 *
 * A degree-0 node is an EXTRACTOR BUG, never a finding. Non-`file` orphans
 * ({function,class,table,lambda,endpoint,externalService}) are a hard failure
 * that blocks the wave gate. A clean Futurator-Admin sync produces zero of them.
 */

import { describe, it, expect } from 'vitest';
import {
  reportOrphans,
  classifyOrphans,
  ORPHAN_HARD_FAIL_KINDS,
} from '../lib/graph-integrity.mjs';
import { makeGraphSession } from './helpers/fake-graph.mjs';

describe('classifyOrphans (pure)', () => {
  it('splits non-file orphans into hardFail and groups by kind', () => {
    const { byKind, hardFail } = classifyOrphans([
      { id: 'infra/lambda/Api', kind: 'lambda' },
      { id: 'code/a.ts', kind: 'file' },
      { id: 'code/b.ts#function:foo', kind: 'function' },
    ]);
    expect(hardFail.map((o) => o.kind).sort()).toEqual(['function', 'lambda']);
    expect(byKind.file).toEqual(['code/a.ts']);
  });

  it('every hard-fail kind is a non-file structural kind', () => {
    expect([...ORPHAN_HARD_FAIL_KINDS]).not.toContain('file');
    expect([...ORPHAN_HARD_FAIL_KINDS]).not.toContain('dir');
    expect(ORPHAN_HARD_FAIL_KINDS.has('endpoint')).toBe(true);
  });
});

describe('reportOrphans (SG-2.2)', () => {
  it('a degree-0 lambda is a hard failure (extractor dropped an edge)', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'infra/lambda/Orphaned', kind: 'lambda' },
        { id: 'code/a.ts', kind: 'file' },
      ],
      edges: [{ from: 'dir/.', to: 'code/a.ts', type: 'CONTAINS' }],
    });
    const { orphans, hardFail } = await reportOrphans(s, 'p');
    expect(orphans.map((o) => o.id)).toContain('infra/lambda/Orphaned');
    expect(hardFail).toHaveLength(1);
    expect(hardFail[0].kind).toBe('lambda');
  });

  it('a degree-0 file is an orphan but a SOFT one (no hard fail)', async () => {
    const s = makeGraphSession({
      nodes: [{ id: 'code/lonely.ts', kind: 'file' }],
    });
    const { orphans, hardFail } = await reportOrphans(s, 'p');
    expect(orphans).toHaveLength(1);
    expect(hardFail).toHaveLength(0);
  });

  it('a connected node is not an orphan', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'dir/.', kind: 'dir' },
        { id: 'code/a.ts', kind: 'file' },
      ],
      edges: [{ from: 'dir/.', to: 'code/a.ts', type: 'CONTAINS' }],
    });
    const { orphans } = await reportOrphans(s, 'p');
    expect(orphans).toHaveLength(0);
  });

  it('ignores pruned nodes', async () => {
    const s = makeGraphSession({
      nodes: [{ id: 'infra/table/Old', kind: 'table', status: 'pruned' }],
    });
    const { orphans, hardFail } = await reportOrphans(s, 'p');
    expect(orphans).toHaveLength(0);
    expect(hardFail).toHaveLength(0);
  });

  it('a file with only a CONTAINS edge is NOT an orphan (backbone did its job)', async () => {
    // This is the W2 distinction: the dead file is degree-1, so it never trips
    // the orphan invariant — it surfaces in the dead-code detector instead.
    const s = makeGraphSession({
      nodes: [
        { id: 'dir/src', kind: 'dir' },
        { id: 'code/src--dead.ts', kind: 'file' },
      ],
      edges: [{ from: 'dir/src', to: 'code/src--dead.ts', type: 'CONTAINS' }],
    });
    const { orphans } = await reportOrphans(s, 'p');
    expect(orphans.map((o) => o.id)).not.toContain('code/src--dead.ts');
  });
});
