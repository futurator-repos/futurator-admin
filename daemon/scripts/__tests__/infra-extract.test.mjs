/**
 * infra-extract.test.mjs — Story SG-1.2 (core infrastructure nodes & edges).
 *
 * Drives the pure `extractInfra` over the mini-sst fixture (one Dynamo, one
 * Function, one Cron, one Secret, one Bucket, one SNS topic) and asserts the
 * node/edge taxonomy, the env-join map, the table data contract, and the scoped
 * bucketPath that encodes the dual-bucket safety rule.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsParser } from '../lib/extractor-envelope.mjs';
import { extractInfra } from '../infra-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '__fixtures__', 'mini-sst');

let result;

beforeAll(async () => {
  const ts = await loadTsParser('test');
  expect(ts, 'tree-sitter must be installed for infra-extract tests').toBeTruthy();
  const source = await readFile(join(FIXTURE_ROOT, 'sst.config.ts'), 'utf-8');
  result = extractInfra(source, { ...ts, root: FIXTURE_ROOT });
});

const nodeById = (id) => result.nodes.find((n) => n.nodeId === id);
const hasEdge = (type, source, target) =>
  result.edges.some((e) => e.type === type && e.source === source && e.target === target);

describe('infra-extract — core node kinds', () => {
  it('emits table / lambda / cron / secret / bucket nodes', () => {
    expect(nodeById('infra/table/ScoresTable')?.kind).toBe('table');
    expect(nodeById('infra/lambda/Api')?.kind).toBe('lambda');
    expect(nodeById('infra/cron/DigestCron')?.kind).toBe('cron');
    expect(nodeById('infra/secret/AnthropicApiKey')?.kind).toBe('secret');
    expect(nodeById('infra/bucket/MediaBucket')?.kind).toBe('bucket');
    expect(nodeById('infra/topic/AlarmsTopic')?.kind).toBe('topic');
  });

  it('table node carries the data contract (fields + primaryIndex)', () => {
    const t = nodeById('infra/table/ScoresTable');
    expect(t.fields).toContain('playerName');
    expect(t.fields).toContain('score');
    expect(t.primaryIndex).toContain('hashKey');
  });

  it('cron node carries its schedule', () => {
    expect(nodeById('infra/cron/DigestCron').schedule).toBe('rate(1 day)');
  });
});

describe('infra-extract — edges', () => {
  it('HANDLED_BY resolves the handler to graph-sync canonical code/ nodeId (dashes)', () => {
    // functions/api/index.ts exists in the fixture → resolves to .ts
    expect(hasEdge('HANDLED_BY', 'infra/lambda/Api', 'code/functions--api--index.ts')).toBe(true);
    // functions/cron/digest.ts does NOT exist → falls back to .ts default
    expect(hasEdge('HANDLED_BY', 'infra/cron/DigestCron', 'code/functions--cron--digest.ts')).toBe(true);
  });

  it('USES edges for link: [table, secret]', () => {
    expect(hasEdge('USES', 'infra/lambda/Api', 'infra/table/ScoresTable')).toBe(true);
    expect(hasEdge('USES', 'infra/lambda/Api', 'infra/secret/AnthropicApiKey')).toBe(true);
    expect(hasEdge('USES', 'infra/cron/DigestCron', 'infra/table/ScoresTable')).toBe(true);
  });

  it('REPRESENTS maps the secret to its external service', () => {
    expect(hasEdge('REPRESENTS', 'infra/secret/AnthropicApiKey', 'service/Anthropic')).toBe(true);
    expect(nodeById('service/Anthropic')?.kind).toBe('externalService');
  });

  it('USES → service for a secret-in-env (Anthropic) and a literal URL (IdentityBroker)', () => {
    expect(hasEdge('USES', 'infra/lambda/Api', 'service/Anthropic')).toBe(true);
    expect(hasEdge('USES', 'infra/lambda/Api', 'service/IdentityBroker')).toBe(true);
    expect(nodeById('service/IdentityBroker')?.kind).toBe('externalService');
  });

  it('WRITES → a distinct scoped bucketPath node (dual-bucket safety rule)', () => {
    const bp = result.nodes.find((n) => n.kind === 'bucketPath' && /media\/\*/.test(n.nodeId));
    expect(bp).toBeTruthy();
    expect(hasEdge('WRITES', 'infra/lambda/Api', bp.nodeId)).toBe(true);
  });
});

describe('infra-extract — env-join + honesty', () => {
  it('returns an envJoin map keyed on env var → resource', () => {
    expect(result.envJoin.SCORES_TABLE).toEqual({ kind: 'table', id: 'ScoresTable' });
    expect(result.envJoin.ANTHROPIC_API_KEY).toEqual({ kind: 'secret', id: 'AnthropicApiKey' });
  });

  it('ambiguous is an array (unresolved joins recorded, never guessed)', () => {
    expect(Array.isArray(result.ambiguous)).toBe(true);
  });
});

describe('infra-extract — runs against the real sst.config.ts', () => {
  it('extracts the real tables, the Api lambda, and multiple scoped bucketPaths', async () => {
    const ts = await loadTsParser('test');
    const repoRoot = join(__dirname, '..', '..', '..');
    const source = await readFile(join(repoRoot, 'sst.config.ts'), 'utf-8');
    const real = extractInfra(source, { ...ts, root: repoRoot });

    const ids = new Set(real.nodes.map((n) => n.nodeId));
    expect(ids.has('infra/table/CostsTable')).toBe(true);
    expect(ids.has('infra/lambda/Api')).toBe(true);
    expect(ids.has('infra/secret/AnthropicApiKey')).toBe(true);

    // The real config has 6 scoped paths: data/ media/ party-docs/ timing/ apps/ knowledge-live/
    const bucketPaths = real.nodes.filter((n) => n.kind === 'bucketPath');
    expect(bucketPaths.length).toBeGreaterThanOrEqual(5);
    const paths = bucketPaths.map((n) => n.nodeId);
    expect(paths.some((p) => /\/data\/\*$/.test(p))).toBe(true);
    expect(paths.some((p) => /\/media\/\*$/.test(p))).toBe(true);
    expect(paths.some((p) => /\/knowledge-live\/\*$/.test(p))).toBe(true);

    // Real env-join must include the COSTS_TABLE → table mapping (drives W4 READS).
    expect(real.envJoin.COSTS_TABLE).toEqual({ kind: 'table', id: 'CostsTable' });
  });
});
