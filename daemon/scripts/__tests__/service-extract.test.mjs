/**
 * service-extract.test.mjs — Story SG-1.5 (external-service nodes, W10).
 *
 * Asserts SDK imports + fetch hosts map to externalService nodes with a cost
 * model, CALLS_SERVICE edges from the file, and that unknown hosts are recorded
 * as ambiguous (never silently invented).
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractServicesFromSource,
  buildServiceNodes,
  costModelFor,
} from '../service-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('service-extract — imports → services', () => {
  it('maps a known SDK import to a CALLS_SERVICE edge from the file', () => {
    const { edges, services } = extractServicesFromSource(
      'functions/jester/handler.ts',
      `import Anthropic from '@anthropic-ai/sdk';\nconst c = new Anthropic();`,
    );
    expect(services.has('Anthropic')).toBe(true);
    expect(edges).toContainEqual({
      type: 'CALLS_SERVICE',
      source: 'code/functions--jester--handler.ts',
      target: 'service/Anthropic',
    });
  });

  it('maps a known fetch host to a service, unknown host → ambiguous', () => {
    const { services, ambiguous } = extractServicesFromSource(
      'src/auth.ts',
      `await fetch('https://auth.futurator.ai/v1/exchange');\nawait fetch('https://example.com/x');`,
    );
    expect(services.has('IdentityBroker')).toBe(true);
    expect(ambiguous).toContainEqual({ file: 'src/auth.ts', host: 'example.com', reason: 'unknown-host' });
  });

  it('dedupes repeated references to the same service', () => {
    const { edges } = extractServicesFromSource(
      'a.ts',
      `import x from '@anthropic-ai/sdk';\nimport y from '@anthropic-ai/sdk';`,
    );
    expect(edges.filter((e) => e.target === 'service/Anthropic')).toHaveLength(1);
  });
});

describe('service-extract — cost model (W10)', () => {
  it('externalService nodes carry billable + costUnit', () => {
    const nodes = buildServiceNodes(new Set(['Anthropic', 'IdentityBroker']));
    const anthropic = nodes.find((n) => n.nodeId === 'service/Anthropic');
    const broker = nodes.find((n) => n.nodeId === 'service/IdentityBroker');
    expect(anthropic).toMatchObject({ kind: 'externalService', billable: true, costUnit: 'token' });
    // IdentityBroker is the internal microservice — NOT billable. This is the
    // queryable distinction the Jester bench asks for ("which paid services?").
    expect(broker).toMatchObject({ kind: 'externalService', billable: false });
  });

  it('unknown-but-known-shaped service defaults to billable (false-alarm > missed cost)', () => {
    expect(costModelFor('SomeNewPaidApi')).toEqual({ unit: 'request', billable: true });
  });
});

describe('service-extract — real functions/api/index.ts', () => {
  it('detects the real @anthropic-ai/sdk import', async () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const src = await readFile(join(repoRoot, 'functions', 'api', 'index.ts'), 'utf-8');
    const { services, edges } = extractServicesFromSource('functions/api/index.ts', src);
    expect(services.has('Anthropic')).toBe(true);
    expect(edges).toContainEqual({
      type: 'CALLS_SERVICE',
      source: 'code/functions--api--index.ts',
      target: 'service/Anthropic',
    });
  });
});
