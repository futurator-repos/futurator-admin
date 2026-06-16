/**
 * contract-diff.test.mjs — Story 6.1. The false-positive guard: a real shared
 * contract change fires; a Labs-internal rename does NOT (PRD §7.4.1, Risk 4).
 */

import { describe, it, expect } from 'vitest';
import { diffContracts, contractShape, identityKey, CONTRACT_NODE_KINDS } from '../contract-diff.mjs';

describe('contractShape — keys on shape, not symbol names', () => {
  it('table shape is field-order- and case-insensitive', () => {
    const a = contractShape({ kind: 'table', name: 'Plans', fields: ['id', 'name'], primaryIndex: 'id' });
    const b = contractShape({ kind: 'table', name: 'Plans', fields: ['name', 'id'], primaryIndex: 'id' });
    expect(a).toBe(b);
  });

  it('endpoint shape is method-canonical', () => {
    expect(contractShape({ kind: 'endpoint', method: 'post', path: '/x' })).toBe(
      contractShape({ kind: 'endpoint', method: 'POST', path: '/x' }),
    );
  });

  it('returns null for non-contract kinds (symbols, files, dirs)', () => {
    expect(contractShape({ kind: 'symbol', nodeId: 'sym/foo' })).toBeNull();
    expect(contractShape({ kind: 'file', nodeId: 'code/a.ts' })).toBeNull();
  });
});

describe('diffContracts — real change fires', () => {
  it('detects a field added to a shared table as a field-level change', () => {
    const before = [{ nodeId: 'infra/table/PlansTable', kind: 'table', name: 'Plans', fields: ['id', 'name'], primaryIndex: 'id' }];
    const after = [
      { nodeId: 'infra/table/PlansTable', kind: 'table', name: 'Plans', fields: ['id', 'name', { name: 'dependsOn', type: 'string[]' }], primaryIndex: 'id' },
    ];
    const { changes, modified } = diffContracts(before, after);
    expect(modified).toBe(1);
    expect(changes[0]).toMatchObject({ node: 'infra/table/PlansTable', kind: 'table' });
    expect(changes[0].change).toBe('field +dependsOn:string[]');
  });

  it('detects a brand-new endpoint as "new"', () => {
    const before = [];
    const after = [{ nodeId: 'endpoint/POST /plans/:id/validate', kind: 'endpoint', method: 'POST', path: '/plans/:id/validate' }];
    const { changes, added } = diffContracts(before, after);
    expect(added).toBe(1);
    expect(changes[0]).toMatchObject({ change: 'new', kind: 'endpoint' });
  });

  it('detects a removed contract', () => {
    const before = [{ nodeId: 'infra/topic/Orders', kind: 'topic', name: 'Orders' }];
    const after = [];
    const { changes, removed } = diffContracts(before, after);
    expect(removed).toBe(1);
    expect(changes[0].change).toBe('removed');
  });
});

describe('diffContracts — the negative test (false-positive guard)', () => {
  it('a Labs-internal rename with no contract-shape change produces ZERO contract changes', () => {
    // Same shared table both sides; only an internal symbol/file got renamed.
    const sharedTable = { nodeId: 'infra/table/PlansTable', kind: 'table', name: 'Plans', fields: ['id', 'name'], primaryIndex: 'id' };
    const before = [
      sharedTable,
      { nodeId: 'code/src--planService.ts', kind: 'file' },
      { nodeId: 'sym/getPlan', kind: 'symbol' },
    ];
    const after = [
      sharedTable,
      { nodeId: 'code/src--planRepository.ts', kind: 'file' }, // renamed file
      { nodeId: 'sym/fetchPlan', kind: 'symbol' }, // renamed symbol
    ];
    const { changes } = diffContracts(before, after);
    expect(changes).toHaveLength(0);
  });

  it('reordering table fields is not a change', () => {
    const before = [{ nodeId: 't', kind: 'table', name: 'T', fields: ['a', 'b', 'c'], primaryIndex: 'a' }];
    const after = [{ nodeId: 't', kind: 'table', name: 'T', fields: ['c', 'a', 'b'], primaryIndex: 'a' }];
    expect(diffContracts(before, after).changes).toHaveLength(0);
  });
});

describe('identityKey + kinds', () => {
  it('identity survives a shape change (same table id when fields differ)', () => {
    const a = identityKey({ kind: 'table', name: 'Plans', fields: ['id'] });
    const b = identityKey({ kind: 'table', name: 'Plans', fields: ['id', 'extra'] });
    expect(a).toBe(b);
  });

  it('exposes the contract kind set', () => {
    expect(CONTRACT_NODE_KINDS).toContain('table');
    expect(CONTRACT_NODE_KINDS).toContain('capability');
    expect(CONTRACT_NODE_KINDS).not.toContain('symbol');
  });
});
