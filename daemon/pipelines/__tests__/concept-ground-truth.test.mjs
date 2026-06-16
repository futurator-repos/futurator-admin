import { describe, it, expect } from 'vitest';
import { formatGroundTruth, bucketNodes } from '../lib/concept-ground-truth.mjs';

describe('formatGroundTruth (Story 2.5 — brownfield grounding block)', () => {
  it('greenfield / empty facts → empty string (cold run)', () => {
    expect(formatGroundTruth({})).toBe('');
    expect(formatGroundTruth({ tables: [], lambdas: [], endpoints: [], files: [] })).toBe('');
    expect(formatGroundTruth(undefined)).toBe('');
  });

  it('change plan → a <ground_truth> block with the real node kinds + do-not-contradict directive', () => {
    const block = formatGroundTruth({
      tables: ['PlansTable', 'AgentJobsTable'],
      lambdas: ['api-lambda'],
      endpoints: ['POST /api/plans'],
      files: ['functions/api/index.ts'],
    });
    expect(block).toContain('<ground_truth source="system-graph">');
    expect(block).toContain('Do NOT contradict');
    expect(block).toContain('PlansTable');
    expect(block).toContain('api-lambda');
    expect(block).toContain('POST /api/plans');
    expect(block).toContain('functions/api/index.ts');
    expect(block.trimEnd().endsWith('</ground_truth>')).toBe(true);
  });

  it('omits empty categories but keeps populated ones', () => {
    const block = formatGroundTruth({ tables: ['T1'], lambdas: [], endpoints: [], files: [] });
    expect(block).toContain('### Data stores');
    expect(block).not.toContain('### Lambdas');
    expect(block).not.toContain('### API endpoints');
  });
});

describe('bucketNodes (Story 2.5 — kind → category)', () => {
  it('buckets known kinds, dedupes, and drops interior kinds', () => {
    const buckets = bucketNodes([
      { kind: 'table', title: 'PlansTable' },
      { kind: 'dynamodb', title: 'AgentJobsTable' },
      { kind: 'lambda', title: 'api-lambda' },
      { kind: 'route', title: 'GET /api/health' },
      { kind: 'file', title: 'index.ts' },
      { kind: 'function', title: 'api-lambda' }, // dup label into lambdas → deduped
      { kind: 'class', title: 'SomeInteriorClass' }, // not a structural kind → dropped
    ]);
    expect(buckets.tables).toEqual(['PlansTable', 'AgentJobsTable']);
    expect(buckets.lambdas).toEqual(['api-lambda']);
    expect(buckets.endpoints).toEqual(['GET /api/health']);
    expect(buckets.files).toEqual(['index.ts']);
  });

  it('caps each category at perCategory', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'file', title: `f${i}.ts` }));
    const buckets = bucketNodes(many, { perCategory: 5 });
    expect(buckets.files).toHaveLength(5);
  });

  it('the full pipe (bucket → format) is empty for a graph of only interior kinds', () => {
    const buckets = bucketNodes([{ kind: 'class', title: 'X' }, { kind: 'variable', title: 'y' }]);
    expect(formatGroundTruth(buckets)).toBe('');
  });
});
