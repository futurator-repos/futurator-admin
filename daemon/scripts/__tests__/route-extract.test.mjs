/**
 * route-extract.test.mjs — Story SG-1.4 (endpoint nodes, W1).
 *
 * Endpoints are the missing middle of the component→endpoint→table contract
 * spine. Also asserts the `auth` flag makes the public-route contract queryable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTsParser } from '../lib/extractor-envelope.mjs';
import { extractRoutes } from '../route-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '..', '__fixtures__', 'mini-sst');

let result;
let ts;
beforeAll(async () => {
  ts = await loadTsParser('test');
  const source = await readFile(join(FIXTURE_ROOT, 'functions', 'api', 'index.ts'), 'utf-8');
  result = extractRoutes(source, 'infra/lambda/Api', ts);
});

const ep = (id) => result.nodes.find((n) => n.nodeId === id);
const hasEdge = (type, source, target) =>
  result.edges.some((e) => e.type === type && e.source === source && e.target === target);

describe('route-extract — endpoint nodes', () => {
  it('emits an endpoint node per route with {method, path, auth}', () => {
    expect(ep('endpoint/GET /api/health')).toMatchObject({ kind: 'endpoint', method: 'GET', path: '/api/health', auth: false });
    expect(ep('endpoint/POST /api/scores')).toMatchObject({ method: 'POST', path: '/api/scores', auth: false });
    expect(ep('endpoint/GET /api/leaderboard')).toMatchObject({ method: 'GET', auth: false });
  });

  it('flags auth=true only when authMiddleware is in the chain', () => {
    expect(ep('endpoint/GET /api/me')?.auth).toBe(true);
    expect(ep('endpoint/GET /api/health')?.auth).toBe(false);
  });

  it('keeps the :param template in the path', () => {
    expect(ep('endpoint/GET /api/scores/:id')?.path).toBe('/api/scores/:id');
  });

  it('emits ROUTES → lambda for every endpoint', () => {
    expect(hasEdge('ROUTES', 'endpoint/GET /api/health', 'infra/lambda/Api')).toBe(true);
    expect(hasEdge('ROUTES', 'endpoint/GET /api/me', 'infra/lambda/Api')).toBe(true);
    expect(result.edges.every((e) => e.type === 'ROUTES' && e.target === 'infra/lambda/Api')).toBe(true);
  });
});

describe('route-extract — real functions/api/index.ts', () => {
  it('extracts real routes with correct public/auth flags', async () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const source = await readFile(join(repoRoot, 'functions', 'api', 'index.ts'), 'utf-8');
    const real = extractRoutes(source, 'infra/lambda/Api', ts);

    const byId = new Map(real.nodes.map((n) => [n.nodeId, n]));
    // Public routes — auth must be false.
    expect(byId.get('endpoint/GET /api/health')?.auth).toBe(false);
    expect(byId.get('endpoint/POST /api/auth/exchange')?.auth).toBe(false);
    expect(byId.get('endpoint/GET /api/public/projects')?.auth).toBe(false);
    // Guarded route — authMiddleware → auth true.
    expect(byId.get('endpoint/GET /api/auth/me')?.auth).toBe(true);
    // A representative :param route exists.
    expect(byId.has('endpoint/GET /api/projects/:id')).toBe(true);

    // Sanity: a real API surface has many endpoints, all routed to the Api lambda.
    expect(real.nodes.length).toBeGreaterThan(20);
    expect(real.edges.every((e) => e.type === 'ROUTES' && e.target === 'infra/lambda/Api')).toBe(true);
  });
});
