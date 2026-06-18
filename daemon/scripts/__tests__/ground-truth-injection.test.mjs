/**
 * ground-truth-injection.test.mjs — Story 4.4. The DEV loop injects
 * blast_radius results as a <ground_truth> block before editing touch points,
 * and degrades to ast+grep facts on a cold Memgraph without failing the story.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  touchPointToNodeId,
  buildGroundTruthBlock,
  assembleGroundTruth,
} from '../ground-truth-injection.mjs';
import { makeMcpSession } from '../../mcp/__tests__/helpers/fake-mcp-graph.mjs';

const graph = () =>
  makeMcpSession({
    projectId: 'futurator-admin',
    nodes: [
      { id: 'code/functions--cron--agg.ts', kind: 'file', title: 'cost-aggregator.ts' },
      { id: 'tbl/Costs', kind: 'table', title: 'CostsTable' },
      { id: 'evt/cron/daily', kind: 'eventSource', title: 'daily cron' },
      { id: 'svc/anthropic', kind: 'externalService', title: 'Anthropic', billable: true },
    ],
    edges: [
      { from: 'code/functions--cron--agg.ts', to: 'tbl/Costs', type: 'WRITES' },
      { from: 'evt/cron/daily', to: 'code/functions--cron--agg.ts', type: 'TRIGGERS' },
      { from: 'code/functions--cron--agg.ts', to: 'svc/anthropic', type: 'CALLS_SERVICE' },
    ],
  });

describe('ground-truth injection (Story 4.4)', () => {
  it('maps touch-point paths to wiki nodeIds', () => {
    expect(touchPointToNodeId('functions/cron/cost-aggregator.ts')).toBe(
      'code/functions--cron--cost-aggregator.ts',
    );
    expect(touchPointToNodeId('/src/x.ts')).toBe('code/src--x.ts');
  });

  it('formats a <ground_truth> block grouped by kind, infra-first, with paid-service warning', () => {
    const block = buildGroundTruthBlock({
      groups: {
        file: [{ id: 'code/a.ts', title: 'a.ts' }],
        table: [{ id: 'tbl/Costs', title: 'CostsTable' }],
      },
      touchesPaidService: true,
      totalReached: 2,
    });
    expect(block.startsWith('<ground_truth>')).toBe(true);
    expect(block.trim().endsWith('</ground_truth>')).toBe(true);
    // table (infra) is listed before file
    expect(block.indexOf('table (1)')).toBeLessThan(block.indexOf('file (1)'));
    expect(block).toContain('CostsTable');
    expect(block).toMatch(/PAID external service/);
  });

  it('injects blast_radius results — the async cron→table chain is in the block', async () => {
    const res = await assembleGroundTruth(
      { touchPoints: ['functions/cron/agg.ts'], projectId: 'futurator-admin' },
      { session: graph() },
    );
    expect(res.source).toBe('blast_radius');
    expect(res.reached).toBeGreaterThan(0);
    expect(res.block).toContain('CostsTable'); // WRITES, 1 hop
    expect(res.block).toContain('daily cron'); // TRIGGERS event edge — not missed
    expect(res.block).toMatch(/PAID external service/);
  });

  it('falls back to ast+grep facts (without failing) on a cold Memgraph', async () => {
    const fallback = vi.fn(async () => '<ast_facts>existing facts</ast_facts>');
    const res = await assembleGroundTruth(
      { touchPoints: ['functions/cron/agg.ts'], projectId: 'futurator-admin' },
      { session: null, fallback },
    );
    expect(res.source).toBe('fallback');
    expect(res.block).toContain('existing facts');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('falls back when a touch point has no graph connections (new file)', async () => {
    const fallback = vi.fn(async () => 'facts');
    const res = await assembleGroundTruth(
      { touchPoints: ['src/brand-new.ts'], projectId: 'futurator-admin' },
      { session: graph(), fallback },
    );
    expect(res.source).toBe('fallback');
    expect(fallback).toHaveBeenCalled();
  });

  it('never throws when the session errors — story is not failed', async () => {
    const broken = { run: async () => { throw new Error('bolt down'); }, close: async () => {} };
    const res = await assembleGroundTruth(
      { touchPoints: ['src/x.ts'], projectId: 'p' },
      { session: broken, fallback: async () => 'safe' },
    );
    expect(res.source).toBe('fallback');
    expect(res.block).toBe('safe');
  });
});
