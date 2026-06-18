/**
 * propagator-ingest.test.mjs — Seam A. Filing PROPAGATOR proposals into the
 * consent queue: the pure transform + idempotent ingest (a decided proposal is
 * never resurrected).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildProposalItems,
  ingestProposals,
  readDoneProposals,
  markProposalApplied,
} from '../propagator-ingest.mjs';

const doc = {
  sourceProject: 'labs',
  trigger: 'wave-gate',
  proposals: [
    {
      proposalId: 'prop/labs->mobile/abc',
      sibling: 'mobile',
      brief: 'PlanScreen needs a dependency picker',
      contractChanges: [{ node: 'infra/table/PlansTable', change: 'field +dependsOn:string[]' }],
      proposedStory: { title: 'Port plan-dependencies to Mobile', epic: 'labs-parity' },
      atCommit: 'abc',
      createdAt: '2026-06-16T00:00:00Z',
    },
  ],
};

describe('buildProposalItems', () => {
  it('maps proposals to DDB items as proposed + requiresApproval', () => {
    const items = buildProposalItems(doc);
    expect(items[0]).toMatchObject({
      proposalId: 'prop/labs->mobile/abc',
      sourceProject: 'labs',
      sibling: 'mobile',
      trigger: 'wave-gate',
      status: 'proposed',
      requiresApproval: true,
    });
  });

  it('inherits source/trigger from the doc when missing on a proposal', () => {
    const items = buildProposalItems({ sourceProject: 'labs', trigger: 'drift-threshold', proposals: [{ proposalId: 'x', sibling: 'office' }] });
    expect(items[0].sourceProject).toBe('labs');
    expect(items[0].trigger).toBe('drift-threshold');
  });

  it('drops entries without a proposalId (never a malformed PK)', () => {
    expect(buildProposalItems({ proposals: [{ sibling: 'mobile' }] })).toHaveLength(0);
  });
});

describe('ingestProposals — idempotent', () => {
  it('files new proposals', async () => {
    const put = vi.fn(async () => {});
    const get = vi.fn(async () => null);
    const res = await ingestProposals(buildProposalItems(doc), { get, put });
    expect(res).toEqual({ filed: 1, skipped: 0, total: 1 });
    expect(put).toHaveBeenCalledOnce();
  });

  it('skips a proposal already decided (status ≠ proposed) — no resurrection', async () => {
    const put = vi.fn(async () => {});
    const get = vi.fn(async () => ({ proposalId: 'prop/labs->mobile/abc', status: 'rejected' }));
    const res = await ingestProposals(buildProposalItems(doc), { get, put });
    expect(res).toEqual({ filed: 0, skipped: 1, total: 1 });
    expect(put).not.toHaveBeenCalled();
  });

  it('re-files a still-proposed row but preserves its original createdAt', async () => {
    const put = vi.fn(async () => {});
    const get = vi.fn(async () => ({ proposalId: 'prop/labs->mobile/abc', status: 'proposed', createdAt: '2026-06-15T00:00:00Z' }));
    await ingestProposals(buildProposalItems(doc), { get, put });
    expect(put.mock.calls[0][0].createdAt).toBe('2026-06-15T00:00:00Z');
  });
});

describe('readDoneProposals + markProposalApplied (Seam C — marker-on-Done)', () => {
  function makeDocClient(items) {
    const calls = [];
    return {
      calls,
      async send(cmd) {
        const name = cmd.constructor.name;
        calls.push({ name, input: cmd.input });
        if (name === 'ScanCommand') return { Items: items };
        return {};
      },
    };
  }

  it('returns only done proposals whose marker has not been applied', async () => {
    const docClient = makeDocClient([
      { proposalId: 'a', status: 'done' }, // eligible
      { proposalId: 'b', status: 'done', markerApplied: true }, // already applied → skip
      { proposalId: 'c', status: 'approved' }, // not done → skip
    ]);
    const done = await readDoneProposals({ tableName: 'T', docClient });
    expect(done.map((p) => p.proposalId)).toEqual(['a']);
  });

  it('marks a proposal applied (UpdateCommand sets markerApplied)', async () => {
    const docClient = makeDocClient([]);
    await markProposalApplied('a', { tableName: 'T', docClient, ts: '2026-06-16T02:00:00Z' });
    const upd = docClient.calls.find((c) => c.name === 'UpdateCommand');
    expect(upd.input.Key).toEqual({ proposalId: 'a' });
    expect(upd.input.ExpressionAttributeValues[':t']).toBe(true);
  });
});
