/**
 * contract-revision.test.mjs — Story 6.2 (W6). The :ContractRevision append-log
 * is the temporal source for drift-count; a stateless snapshot can't say
 * "3 changes since commitY".
 */

import { describe, it, expect } from 'vitest';
import {
  buildRevisionNode,
  buildRevisions,
  revisionSlug,
  computeDriftCounts,
  appendRevisions,
  readRevisions,
  driftSince,
} from '../lib/contract-revision.mjs';

describe('buildRevisionNode (Appendix E shape)', () => {
  it('builds a contractRevision node with the full shape, no clock of its own', () => {
    const rev = buildRevisionNode(
      { node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' },
      { atCommit: '3da50ba', atWave: 'wave-42', ts: '2026-06-15T10:31:00Z' },
    );
    expect(rev).toMatchObject({
      kind: 'contractRevision',
      contractNode: 'infra/table/PlansTable',
      change: 'field +dependsOn:string[]',
      atCommit: '3da50ba',
      atWave: 'wave-42',
      ts: '2026-06-15T10:31:00Z',
    });
    expect(rev.nodeId).toBe('rev/PlansTable/2026-06-15T10:31:00Z/field-dependson-string');
  });

  it('slugs the change for a stable, readable id', () => {
    expect(revisionSlug('field +dependsOn:string[]')).toBe('field-dependson-string');
    expect(revisionSlug('new')).toBe('new');
  });

  it('builds one revision per diff change', () => {
    const diff = { changes: [{ node: 'a', change: 'new' }, { node: 'b', change: 'removed' }] };
    const revs = buildRevisions(diff, { atCommit: 'c1', atWave: 'w1', ts: '2026-06-15T00:00:00Z' });
    expect(revs).toHaveLength(2);
    expect(revs.every((r) => r.kind === 'contractRevision')).toBe(true);
  });
});

describe('computeDriftCounts (W6 — count since lastPropagatedTo)', () => {
  const order = ['c0', 'c1', 'c2', 'c3', 'c4']; // oldest → newest
  const revisions = [{ atCommit: 'c2' }, { atCommit: 'c3' }, { atCommit: 'c4' }];

  it('counts only revisions newer than each sibling marker', () => {
    const drift = computeDriftCounts(revisions, { mobile: 'c1', office: 'c4' }, order);
    expect(drift).toEqual({ mobile: 3, office: 0 });
  });

  it('counts ALL revisions when a sibling has never been propagated to (null marker)', () => {
    const drift = computeDriftCounts(revisions, { mobile: null }, order);
    expect(drift).toEqual({ mobile: 3 });
  });

  it('is conservative when a marker commit is not in known history (re-brief, not drop)', () => {
    const drift = computeDriftCounts(revisions, { mobile: 'unknown-sha' }, order);
    expect(drift).toEqual({ mobile: 3 });
  });
});

describe('appendRevisions + readRevisions + driftSince (graph path)', () => {
  function makeRevisionSession() {
    const store = []; // appended revision params
    return {
      store,
      async run(query, params = {}) {
        if (/MERGE \(rev:Node \{nodeId: \$nodeId\}\)/.test(query)) {
          store.push(params);
          return { records: [] };
        }
        if (/-\[:REVISED\]->\(rev:Node \{kind: 'contractRevision'\}\)/.test(query)) {
          const rows = store
            .filter((p) => p.contractNode === params.contractNode)
            .map((p) => ({ get: (k) => p[k] }));
          return { records: rows };
        }
        return { records: [] };
      },
      async close() {},
    };
  }

  it('appends revisions then reads them back and computes drift', async () => {
    const session = makeRevisionSession();
    const diff = {
      changes: [
        { node: 'infra/table/PlansTable', change: 'field +a:string' },
        { node: 'infra/table/PlansTable', change: 'field +b:string' },
      ],
    };
    // two waves at two commits
    await appendRevisions(session, buildRevisions({ changes: [diff.changes[0]] }, { atCommit: 'c2', atWave: 'w2', ts: '2026-06-15T00:00:01Z' }));
    await appendRevisions(session, buildRevisions({ changes: [diff.changes[1]] }, { atCommit: 'c3', atWave: 'w3', ts: '2026-06-15T00:00:02Z' }));

    const revs = await readRevisions(session, 'infra/table/PlansTable');
    expect(revs).toHaveLength(2);

    const drift = await driftSince(session, 'infra/table/PlansTable', { mobile: 'c2', office: null }, ['c1', 'c2', 'c3']);
    expect(drift).toEqual({ mobile: 1, office: 2 });
  });
});
