/**
 * graph-prune.test.mjs — F15 delete-aware prune of zombie code nodes.
 *
 * Additive ingest never removes nodes for files deleted on disk. This covers
 * the prune that marks such nodes `status='pruned'` against the authoritative
 * full scan, while preserving:
 *   - nodes whose source file is still in the scan (incl. legitimately-edgeless
 *     test files — we prune by absence-from-scan, never by edge count),
 *   - nodes that carry a live wiki article (`summary` set — Compiler-owned).
 *
 * A FakeSession models the node store, the stale-file SELECT, the file-node
 * prune SET, and the function/class child prune SET.
 */

import { describe, it, expect } from 'vitest';
import { pruneDeletedCodeNodes } from '../lib/graph-prune.mjs';

function codeId(path) {
  return `code/${path.replace(/\//g, '--')}`;
}

/**
 * @param {Array<object>} seed  node rows: { nodeId, kind, summary?, parentFile?, status? }
 */
function makeFakeSession(seed) {
  const nodes = new Map(seed.map((n) => [n.nodeId, { status: 'active', ...n }]));
  const projectId = 'demo';

  return {
    nodes,
    async run(query, params = {}) {
      // stale `file` node SELECT
      if (/MATCH \(f:Node \{projectId: \$projectId, kind: 'file'\}\)/.test(query)) {
        const live = new Set(params.liveFileNodeIds);
        const recs = [];
        for (const n of nodes.values()) {
          if (n.kind !== 'file') continue;
          if (live.has(n.nodeId)) continue;
          if (n.summary != null) continue;
          if ((n.status ?? 'active') === 'pruned') continue;
          recs.push({ get: (k) => (k === 'id' ? n.nodeId : null) });
        }
        return { records: recs };
      }
      // single-node prune SET
      if (/MATCH \(n:Node \{nodeId: \$nodeId\}\) SET n\.status = 'pruned'/.test(query)) {
        const n = nodes.get(params.nodeId);
        if (n) n.status = 'pruned';
        return { records: [] };
      }
      // function/class child prune SET (parentFile keyed)
      if (/parentFile: \$fileId/.test(query)) {
        const recs = [];
        for (const n of nodes.values()) {
          if (n.parentFile !== params.fileId) continue;
          if (!['function', 'class'].includes(n.kind)) continue;
          if (n.summary != null) continue;
          if ((n.status ?? 'active') === 'pruned') continue;
          n.status = 'pruned';
          recs.push({ get: (k) => (k === 'id' ? n.nodeId : null) });
        }
        return { records: recs };
      }
      return { records: [] };
    },
  };
}

const today = '2026-06-18';

describe('pruneDeletedCodeNodes — delete-aware prune (F15)', () => {
  it('prunes a file node whose source is absent from the full scan, plus its children', async () => {
    const goneFile = codeId('src/gone.ts');
    const s = makeFakeSession([
      { nodeId: codeId('src/keep.ts'), kind: 'file' },
      { nodeId: goneFile, kind: 'file' },
      { nodeId: `${goneFile}#function:dead`, kind: 'function', parentFile: goneFile },
      { nodeId: `${goneFile}#class:Dead`, kind: 'class', parentFile: goneFile },
    ]);

    const res = await pruneDeletedCodeNodes(s, 'demo', ['src/keep.ts'], today);

    expect(res.prunedFiles).toBe(1);
    expect(res.prunedSubNodes).toBe(2);
    expect(s.nodes.get(goneFile).status).toBe('pruned');
    expect(s.nodes.get(`${goneFile}#function:dead`).status).toBe('pruned');
    expect(s.nodes.get(`${goneFile}#class:Dead`).status).toBe('pruned');
    expect(s.nodes.get(codeId('src/keep.ts')).status).toBe('active');
  });

  it('keeps a legitimately-edgeless file that is still in the scan (e.g. a test file)', async () => {
    const testFile = codeId('src/foo.test.ts');
    const s = makeFakeSession([{ nodeId: testFile, kind: 'file' }]);

    const res = await pruneDeletedCodeNodes(s, 'demo', ['src/foo.test.ts'], today);

    expect(res.prunedFiles).toBe(0);
    expect(s.nodes.get(testFile).status).toBe('active');
  });

  it('never prunes a node carrying a live wiki article even if absent from the scan', async () => {
    const documented = codeId('src/legacy.ts');
    const s = makeFakeSession([
      { nodeId: documented, kind: 'file', summary: 'still documented' },
    ]);

    const res = await pruneDeletedCodeNodes(s, 'demo', [], today);

    expect(res.prunedFiles).toBe(0);
    expect(s.nodes.get(documented).status).toBe('active');
  });

  it('is idempotent — re-running over an empty scan does not re-prune', async () => {
    const goneFile = codeId('src/gone.ts');
    const s = makeFakeSession([{ nodeId: goneFile, kind: 'file' }]);

    const first = await pruneDeletedCodeNodes(s, 'demo', [], today);
    const second = await pruneDeletedCodeNodes(s, 'demo', [], today);

    expect(first.prunedFiles).toBe(1);
    expect(second.prunedFiles).toBe(0);
  });
});
