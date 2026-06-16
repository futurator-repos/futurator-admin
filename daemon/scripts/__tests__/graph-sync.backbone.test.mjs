/**
 * graph-sync.backbone.test.mjs — Story SG-2.1 (containment backbone).
 *
 * Every file node must gain a `dir ─CONTAINS→ file` edge by construction, so no
 * code node is ever degree-0 for purely structural reasons. dir nodes are
 * deduped and idempotent; MATCH-only on the file means we never invent file
 * nodes here.
 */

import { describe, it, expect } from 'vitest';
import {
  dirNodeId,
  parentDir,
  emitContainmentBackbone,
} from '../lib/graph-integrity.mjs';
import { makeGraphSession } from './helpers/fake-graph.mjs';

describe('dirNodeId / parentDir', () => {
  it('maps directory paths to dir nodeIds', () => {
    expect(dirNodeId('src/components')).toBe('dir/src--components');
    expect(dirNodeId('.')).toBe('dir/.');
    expect(dirNodeId('')).toBe('dir/.');
  });

  it('extracts the parent directory of a relative path', () => {
    expect(parentDir('src/app/page.tsx')).toBe('src/app');
    expect(parentDir('index.ts')).toBe('.');
  });
});

describe('emitContainmentBackbone (SG-2.1)', () => {
  it('emits dir─CONTAINS→file for every existing file node', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'code/src--app--page.tsx', kind: 'file' },
        { id: 'code/src--lib--util.ts', kind: 'file' },
      ],
    });
    const res = await emitContainmentBackbone(
      s,
      'futurator-admin',
      ['src/app/page.tsx', 'src/lib/util.ts'],
      '2026-06-16',
    );
    expect(res.containsEdges).toBe(2);
    expect(res.dirNodes).toBe(2); // src/app and src/lib
    // both files now carry a CONTAINS edge → never degree-0
    expect(s.edges.filter((e) => e.type === 'CONTAINS')).toHaveLength(2);
    expect(s.nodes.has('dir/src--app')).toBe(true);
    expect(s.nodes.has('dir/src--lib')).toBe(true);
  });

  it('dedupes the dir node when multiple files share a directory', async () => {
    const s = makeGraphSession({
      nodes: [
        { id: 'code/src--a.ts', kind: 'file' },
        { id: 'code/src--b.ts', kind: 'file' },
      ],
    });
    const res = await emitContainmentBackbone(
      s,
      'p',
      ['src/a.ts', 'src/b.ts'],
      '2026-06-16',
    );
    expect(res.dirNodes).toBe(1); // single shared dir/src
    expect(res.containsEdges).toBe(2);
  });

  it('does NOT invent a file node that is absent (MATCH-only)', async () => {
    const s = makeGraphSession({ nodes: [] }); // file node not in graph
    const res = await emitContainmentBackbone(s, 'p', ['ghost.ts'], '2026-06-16');
    expect(res.containsEdges).toBe(0);
    expect(s.nodes.has('code/ghost.ts')).toBe(false);
  });

  it('is idempotent — re-running adds no duplicate CONTAINS edges', async () => {
    const s = makeGraphSession({ nodes: [{ id: 'code/x.ts', kind: 'file' }] });
    await emitContainmentBackbone(s, 'p', ['x.ts'], '2026-06-16');
    await emitContainmentBackbone(s, 'p', ['x.ts'], '2026-06-16');
    expect(s.edges.filter((e) => e.type === 'CONTAINS')).toHaveLength(1);
  });
});
