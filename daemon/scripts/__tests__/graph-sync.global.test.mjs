/**
 * graph-sync.global.test.mjs — Story 5.1. The `--global` federation: each
 * service subgraph emits CONSUMES_CONTRACT → shared contract nodes, and the
 * join works under BOTH resource-identity (shared ARN) and schema-shape
 * (fields/signature) strategies, selectable by config.
 */

import { describe, it, expect } from 'vitest';
import {
  federateContracts,
  contractKey,
  readContracts,
  writeFederation,
  serviceNodeId,
} from '../lib/federation.mjs';

describe('federateContracts — resource-identity (shared backend)', () => {
  const projects = [
    {
      projectId: 'labs',
      contracts: [{ nodeId: 'tbl/labs/Plans', kind: 'table', arn: 'arn:aws:dynamodb:::table/Plans', label: 'Plans' }],
    },
    {
      projectId: 'mobile',
      contracts: [{ nodeId: 'tbl/mobile/Plans', kind: 'table', arn: 'arn:aws:dynamodb:::table/Plans', label: 'Plans' }],
    },
  ];

  it('joins siblings sharing an ARN onto one contract node, each emitting CONSUMES_CONTRACT', () => {
    const res = federateContracts(projects, { strategy: 'resource-identity' });
    expect(res.contractNodes).toHaveLength(1);
    expect(res.contractNodes[0].consumerCount).toBe(2);
    expect(res.consumes).toHaveLength(2);
    const services = res.consumes.map((c) => c.service).sort();
    expect(services).toEqual([serviceNodeId('labs'), serviceNodeId('mobile')]);
    // both point at the SAME canonical contract node
    expect(new Set(res.consumes.map((c) => c.contract)).size).toBe(1);
    expect(res.consumes.every((c) => c.via === 'resource-identity')).toBe(true);
  });

  it('flags rows that lack an ARN as unjoinable (not silently mis-grouped)', () => {
    const res = federateContracts(
      [{ projectId: 'office', contracts: [{ nodeId: 'tbl/office/Plans', kind: 'table', label: 'Plans' }] }],
      { strategy: 'resource-identity' },
    );
    expect(res.consumes).toHaveLength(0);
    expect(res.unjoinable[0]).toMatchObject({ projectId: 'office', kind: 'table' });
  });
});

describe('federateContracts — schema-shape (separate deployments)', () => {
  it('joins same-shape tables and endpoints; separates different shapes', () => {
    const projects = [
      {
        projectId: 'labs',
        contracts: [
          { nodeId: 'tbl/labs/Plans', kind: 'table', fields: ['id', 'name', 'tier'], primaryIndex: 'id' },
          { nodeId: 'ep/labs/approve', kind: 'endpoint', method: 'POST', path: '/waves/:id/approve' },
        ],
      },
      {
        projectId: 'mobile',
        contracts: [
          // same fields (different order) + same pk ⇒ same contract
          { nodeId: 'tbl/mobile/Plans', kind: 'table', fields: ['tier', 'id', 'name'], primaryIndex: 'id' },
          { nodeId: 'ep/mobile/approve', kind: 'endpoint', method: 'post', path: '/waves/:id/approve' },
          // different shape ⇒ its own contract
          { nodeId: 'tbl/mobile/Extra', kind: 'table', fields: ['x'], primaryIndex: 'x' },
        ],
      },
    ];
    const res = federateContracts(projects, { strategy: 'schema-shape' });
    const shared = res.contractNodes.filter((c) => c.consumerCount === 2);
    expect(shared).toHaveLength(2); // the Plans table + the approve endpoint
    expect(res.contractNodes.some((c) => c.kind === 'table' && c.consumerCount === 1)).toBe(true); // Extra
  });

  it('contractKey is method/path-canonical for endpoints and field-order-insensitive for tables', () => {
    expect(contractKey({ kind: 'endpoint', method: 'get', path: '/x' }, 'schema-shape')).toBe(
      'endpoint:GET /x',
    );
    const a = contractKey({ kind: 'table', fields: ['a', 'b'], primaryIndex: 'a' }, 'schema-shape');
    const b = contractKey({ kind: 'table', fields: ['b', 'a'], primaryIndex: 'a' }, 'schema-shape');
    expect(a).toBe(b);
  });
});

describe('readContracts + writeFederation (graph-sync --global ingest)', () => {
  // A recording fake: serves the cross-project read, records MERGEd nodes/edges.
  function makeFederationSession(seedRows) {
    const merged = { contracts: [], services: [], edges: [] };
    return {
      merged,
      async run(query, params = {}) {
        if (/WHERE n\.kind IN \$kinds\s+RETURN n\.projectId/.test(query)) {
          return { records: seedRows.map((r) => ({ get: (k) => (k in r ? r[k] : null) })) };
        }
        if (/MERGE \(n:Node \{nodeId: \$nodeId\}\)\s+SET n\.kind/.test(query)) {
          merged.contracts.push(params.nodeId);
          return { records: [] };
        }
        if (/MERGE \(s\)-\[rel:CONSUMES_CONTRACT\]->\(c\)/.test(query)) {
          merged.services.push(params.service);
          merged.edges.push({ from: params.service, to: params.contract, via: params.via });
          return { records: [] };
        }
        return { records: [] };
      },
      async close() {},
    };
  }

  it('reads contract rows across projects and writes the shared spine back', async () => {
    const session = makeFederationSession([
      { projectId: 'labs', nodeId: 'tbl/labs/Plans', kind: 'table', arn: 'arn:Plans', label: 'Plans' },
      { projectId: 'mobile', nodeId: 'tbl/mobile/Plans', kind: 'table', arn: 'arn:Plans', label: 'Plans' },
    ]);
    const projects = await readContracts(session);
    expect(projects).toHaveLength(2);

    const result = federateContracts(projects, { strategy: 'resource-identity' });
    const summary = await writeFederation(session, result);
    expect(summary).toEqual({ contractNodes: 1, consumes: 2 });
    expect(session.merged.contracts).toHaveLength(1);
    expect(session.merged.edges).toHaveLength(2);
    expect(new Set(session.merged.edges.map((e) => e.to)).size).toBe(1); // same shared contract
  });
});
