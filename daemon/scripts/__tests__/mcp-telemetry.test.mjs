/**
 * mcp-telemetry.test.mjs — Story 4.3. Every MCP invocation emits a durable
 * record; the aggregator reports adoption rate + measured token delta. No
 * borrowed figures — the baseline is supplied (measured) by the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildTelemetryRecord,
  appendTelemetry,
  parseTelemetry,
  estimateTokens,
} from '../../mcp/telemetry.mjs';
import { aggregateTelemetry, ELIGIBLE_TOOLS } from '../mcp-telemetry-report.mjs';
import { dispatchWithTelemetry } from '../../mcp/mycelium-mcp.mjs';
import { makeMcpSession } from '../../mcp/__tests__/helpers/fake-mcp-graph.mjs';

describe('telemetry record + sink (Story 4.3)', () => {
  it('builds the AC-mandated record shape, estimating tokens from sizes', () => {
    const r = buildTelemetryRecord({
      tool: 'blast_radius',
      projectId: 'p',
      storyId: 'SG-4.2',
      argsSize: 40,
      resultSize: 400,
      fallbackUsed: false,
      ts: '2026-06-16T00:00:00Z',
    });
    expect(r).toEqual({
      tool: 'blast_radius',
      projectId: 'p',
      storyId: 'SG-4.2',
      tokensIn: estimateTokens(40),
      tokensOut: estimateTokens(400),
      fallbackUsed: false,
      ts: '2026-06-16T00:00:00Z',
    });
  });

  it('appends a JSONL line to an injectable sink (no filesystem in tests)', async () => {
    const lines = [];
    await appendTelemetry(buildTelemetryRecord({ tool: 'get_node', ts: 't' }), undefined, (l) =>
      lines.push(l),
    );
    expect(parseTelemetry(lines.join('\n'))[0].tool).toBe('get_node');
  });

  it('dispatchWithTelemetry emits one record per tool call and never breaks the call', async () => {
    const sink = vi.fn(async () => {});
    const session = makeMcpSession({
      projectId: 'p',
      nodes: [{ id: 'a', kind: 'file', centrality: 0.5 }],
      edges: [],
    });
    const res = await dispatchWithTelemetry(
      'god_nodes',
      { projectId: 'p' },
      { session, storyId: 'SG-9.9', sink, now: '2026-06-16T00:00:00Z' },
    );
    expect(res[0].id).toBe('a');
    expect(sink).toHaveBeenCalledTimes(1);
    const record = JSON.parse(sink.mock.calls[0][0]);
    expect(record).toMatchObject({ tool: 'god_nodes', projectId: 'p', storyId: 'SG-9.9' });
  });
});

describe('aggregateTelemetry (Story 4.3 — adoption + token delta)', () => {
  const records = [
    { tool: 'blast_radius', projectId: 'p', storyId: 's1', tokensIn: 10, tokensOut: 300, fallbackUsed: false },
    { tool: 'query_graph', projectId: 'p', storyId: 's2', tokensIn: 12, tokensOut: 500, fallbackUsed: true },
    { tool: 'get_node', projectId: 'p', storyId: 's2', tokensIn: 8, tokensOut: 50, fallbackUsed: false },
  ];

  it('counts eligible token-lever invocations and distinct adopted stories', () => {
    const rep = aggregateTelemetry(records);
    expect(ELIGIBLE_TOOLS).toEqual(['blast_radius', 'query_graph']);
    expect(rep.eligibleInvocations).toBe(2);
    expect(rep.adoptedStories).toBe(2); // s1, s2
    expect(rep.byTool.get_node.count).toBe(1);
  });

  it('reports adoption rate against the supplied eligible-step denominator', () => {
    const rep = aggregateTelemetry(records, { eligibleSteps: 4 });
    expect(rep.adoptionRate).toBe(0.5); // 2 adopted / 4 eligible
  });

  it('computes a measured token delta only when a baseline is supplied', () => {
    const noBaseline = aggregateTelemetry(records);
    expect(noBaseline.tokenDelta).toBeNull(); // never asserts a borrowed figure
    expect(noBaseline.avgContextTokens).toBe(400); // (300+500)/2

    const withBaseline = aggregateTelemetry(records, { baselineContextTokens: 1000 });
    expect(withBaseline.tokenDelta).toBe(600); // 1000 baseline − 400 measured = 600 saved
    expect(withBaseline.fallbackRate).toBe(0.5); // 1 of 2 eligible fell back
  });
});
