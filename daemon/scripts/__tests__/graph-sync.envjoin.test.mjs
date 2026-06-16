/**
 * graph-sync.envjoin.test.mjs — Story SG-1.6 (env-join, Resource.*, CALLS_ENDPOINT).
 *
 * The integration seam of Epic 1:
 *   - W4: READS is attributed to the real consumers (importers of a shared
 *     accessor), not to the accessor god-node alone.
 *   - W7: process.env.GITHUB_PAT and Resource.GithubPat.value resolve to the
 *     SAME infra/secret node.
 *   - W1: api-client calls match endpoint nodes (:param ↔ ${template}); misses
 *     are recorded as ambiguous, never invented.
 *
 * A FakeSession models nodes, pre-seeded IMPORTS edges, the importer query, and
 * MERGE semantics for READS / CALLS_ENDPOINT.
 */

import { describe, it, expect } from 'vitest';
import {
  upsertEnvReads,
  upsertCallsEndpoint,
  buildResourceIndex,
  normalizeResourceName,
  normalizeEndpointPath,
  matchCallsToEndpoints,
  extractApiCalls,
} from '../lib/system-graph-ingest.mjs';

function makeFakeSession() {
  const nodes = new Set();
  const imports = []; // { from, to }
  const reads = new Map(); // `${s}->${t}` → props
  const callsEndpoint = new Map();

  return {
    nodes,
    imports,
    reads,
    callsEndpoint,
    addNode: (id) => nodes.add(id),
    addImport: (from, to) => imports.push({ from, to }),
    async run(query, params = {}) {
      // importer lookup
      if (/MATCH \(c:Node\)-\[:IMPORTS\]->\(f:Node \{nodeId: \$f\}\)/.test(query)) {
        const recs = imports
          .filter((e) => e.to === params.f)
          .map((e) => ({ get: (k) => (k === 'id' ? e.from : null) }));
        return { records: recs };
      }
      // READS merge (source is $f for direct, $c for accessor-hop)
      if (/\[r:READS\]->\(t\)/.test(query)) {
        const s = params.f ?? params.c;
        if (nodes.has(s) && nodes.has(params.t)) {
          reads.set(`${s}->${params.t}`, { via: params.via });
        }
        return { records: [] };
      }
      // CALLS_ENDPOINT merge
      if (/\[r:CALLS_ENDPOINT\]->\(b\)/.test(query)) {
        if (nodes.has(params.s) && nodes.has(params.t)) {
          callsEndpoint.set(`${params.s}->${params.t}`, {});
        }
        return { records: [] };
      }
      return { records: [] };
    },
  };
}

describe('upsertEnvReads — accessor-aware READS (W4)', () => {
  it('attributes READS to the importing consumer, not the accessor alone', async () => {
    const s = makeFakeSession();
    const accessor = 'code/functions--shared--dynamo-client.ts';
    const consumer = 'code/functions--shared--repositories--costs.ts';
    const table = 'infra/table/CostsTable';
    s.addNode(accessor);
    s.addNode(consumer);
    s.addNode(table);
    s.addImport(consumer, accessor); // consumer IMPORTS accessor

    const infraDoc = {
      nodes: [{ nodeId: table, kind: 'table', logicalId: 'CostsTable' }],
      envJoin: { COSTS_TABLE: { kind: 'table', id: 'CostsTable' } },
    };
    const envRefsByFile = { 'functions/shared/dynamo-client.ts': { env: ['COSTS_TABLE'], resource: [] } };

    const r = await upsertEnvReads(s, 'admin', infraDoc, envRefsByFile, '2026-06-16');

    // Direct READS on the accessor…
    expect(s.reads.has(`${accessor}->${table}`)).toBe(true);
    // …AND transitive READS on the real consumer (the W4 fix).
    expect(s.reads.has(`${consumer}->${table}`)).toBe(true);
    expect(s.reads.get(`${consumer}->${table}`).via).toContain(accessor);
    expect(r.transitiveReads).toBe(1);
  });
});

describe('upsertEnvReads — Resource.* and process.env resolve identically (W7)', () => {
  it('process.env.GITHUB_PAT and Resource.GithubPat collapse to one secret READS', async () => {
    const s = makeFakeSession();
    const file = 'code/functions--shared--github--load-pat.ts';
    const secret = 'infra/secret/GithubPat';
    s.addNode(file);
    s.addNode(secret);

    const infraDoc = {
      nodes: [{ nodeId: secret, kind: 'secret', logicalId: 'GithubPat' }],
      envJoin: {}, // no explicit GITHUB_PAT binding — must fall back to name normalization
    };
    const envRefsByFile = {
      'functions/shared/github/load-pat.ts': { env: ['GITHUB_PAT'], resource: ['GithubPat'] },
    };

    const r = await upsertEnvReads(s, 'admin', infraDoc, envRefsByFile, '2026-06-16');

    expect(s.reads.has(`${file}->${secret}`)).toBe(true);
    // Both refs resolved to the SAME node → a single READS, not two.
    expect(r.directReads).toBe(1);
  });

  it('normalizeResourceName bridges SCREAMING_SNAKE and PascalCase', () => {
    expect(normalizeResourceName('GITHUB_PAT')).toBe(normalizeResourceName('GithubPat'));
  });

  it('buildResourceIndex only indexes readable kinds (table/secret)', () => {
    const idx = buildResourceIndex({
      nodes: [
        { nodeId: 'infra/table/T', kind: 'table', logicalId: 'T' },
        { nodeId: 'infra/lambda/Api', kind: 'lambda', logicalId: 'Api' },
      ],
      envJoin: {},
    });
    expect(idx.byNormalized.T).toBeTruthy();
    expect(idx.byNormalized.API).toBeUndefined(); // lambda is not a READS target
  });
});

describe('CALLS_ENDPOINT matching (W1)', () => {
  const endpoints = [
    { method: 'GET', path: '/api/projects/:id', nodeId: 'endpoint/GET /api/projects/:id' },
    { method: 'GET', path: '/api/health', nodeId: 'endpoint/GET /api/health' },
    { method: 'POST', path: '/api/ec2/enable', nodeId: 'endpoint/POST /api/ec2/enable' },
  ];

  it('normalizeEndpointPath makes :param and ${template} compare equal', () => {
    expect(normalizeEndpointPath('/api/projects/:id')).toBe(normalizeEndpointPath('/api/projects/${id}'));
  });

  it('matches a ${template} call to its :param endpoint (basePath prepended)', () => {
    const calls = [{ method: 'GET', path: '/projects/${projectId}', fromFile: 'code/src--hooks--use-projects.ts' }];
    const { edges } = matchCallsToEndpoints(calls, endpoints, { basePath: '/api' });
    expect(edges).toContainEqual({
      type: 'CALLS_ENDPOINT',
      source: 'code/src--hooks--use-projects.ts',
      target: 'endpoint/GET /api/projects/:id',
    });
  });

  it('records an unmatched call as ambiguous (never invented)', () => {
    const calls = [{ method: 'GET', path: '/does-not-exist', fromFile: 'code/x.ts' }];
    const { edges, ambiguous } = matchCallsToEndpoints(calls, endpoints, { basePath: '/api' });
    expect(edges).toHaveLength(0);
    expect(ambiguous[0]).toMatchObject({ reason: 'no-matching-endpoint', path: '/does-not-exist' });
  });

  it('extractApiCalls scans api-client method calls', () => {
    const calls = extractApiCalls('src/hooks/use-ec2-daemon.ts', `await api.post('/ec2/enable', {});`);
    expect(calls).toContainEqual({ method: 'POST', path: '/ec2/enable', fromFile: 'code/src--hooks--use-ec2-daemon.ts' });
  });

  it('upsertCallsEndpoint creates the edge when both nodes exist', async () => {
    const s = makeFakeSession();
    const comp = 'code/src--hooks--use-projects.ts';
    s.addNode(comp);
    s.addNode('endpoint/GET /api/projects/:id');
    const calls = [{ method: 'GET', path: '/projects/${id}', fromFile: comp }];
    const r = await upsertCallsEndpoint(s, 'admin', calls, endpoints, '2026-06-16', { basePath: '/api' });
    expect(r.edgeUpserts).toBe(1);
    expect(s.callsEndpoint.has(`${comp}->endpoint/GET /api/projects/:id`)).toBe(true);
  });
});
