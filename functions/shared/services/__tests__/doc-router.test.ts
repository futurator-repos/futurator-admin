import { describe, it, expect } from 'vitest';
import { routeDeterministic, type ArtifactDescriptor } from '../doc-router';
import { validateDecision } from '../../schemas/doc-router-schema';

describe('routeDeterministic — the routing matrix', () => {
  it('code-wiki-change → official / merge-shard with the subsystem target', () => {
    const d = routeDeterministic({
      ref: 'knowledge/code/pipelines--story.md',
      provenance: 'code-wiki-change',
      subsystemShardKey: '§sys:functions--shared--pipelines',
    })!;
    expect(d.realm).toBe('official');
    expect(d.action).toBe('merge-shard');
    expect(d.target).toEqual({
      docType: 'architecture',
      shardKey: '§sys:functions--shared--pipelines',
    });
    expect(d.status).toBe('applied');
  });

  it('concept-arch-section → concept / edge-only PROPOSES (intention, never merged)', () => {
    const d = routeDeterministic({
      ref: 'concept/architecture.md#state-model',
      provenance: 'concept-arch-section',
      conceptSection: {
        docSectionNodeId: 'docSection/architecture/plan1/state-model',
        targetShardKey: '§sys:functions--shared--repositories',
      },
    })!;
    expect(d.action).toBe('edge-only');
    expect(d.edge?.type).toBe('PROPOSES');
    expect(d.edge?.to).toBe('§sys:functions--shared--repositories');
  });

  it('plan-json / concept-plan-json → concept / edge-only INFORMS', () => {
    for (const provenance of ['plan-json', 'concept-plan-json'] as const) {
      const d = routeDeterministic({ ref: 'plan1', provenance, sourceNodeId: 'node/plan/plan1' })!;
      expect(d.realm).toBe('concept');
      expect(d.edge?.type).toBe('INFORMS');
    }
  });

  it('reflection-proposal → self-reflection / edge-only, status PROPOSED (operator-gated)', () => {
    const d = routeDeterministic({
      ref: 'reflection-7',
      provenance: 'reflection-proposal',
      sourceNodeId: 'node/reflection/7',
    })!;
    expect(d.realm).toBe('self-reflection');
    expect(d.status).toBe('proposed');
  });

  it('log / scorecard / claude-md → log-only', () => {
    for (const provenance of ['log', 'scorecard', 'claude-md-append'] as const) {
      expect(routeDeterministic({ ref: 'x', provenance })!.action).toBe('log-only');
    }
  });

  it('ast-facts / dependency-map → system-graph / edge-only', () => {
    for (const provenance of ['ast-facts', 'dependency-map'] as const) {
      const d = routeDeterministic({ ref: 'facts', provenance })!;
      expect(d.realm).toBe('system-graph');
      expect(d.action).toBe('edge-only');
    }
  });

  it('build-output / transient → discard', () => {
    for (const provenance of ['build-output', 'transient'] as const) {
      expect(routeDeterministic({ ref: 'x', provenance })!.action).toBe('discard');
    }
  });

  it('unknown → null (escalate to the LLM classifier)', () => {
    expect(routeDeterministic({ ref: 'mystery.md', provenance: 'unknown' })).toBeNull();
  });

  it('throws if a merge rule is missing its required descriptor field (programming error)', () => {
    expect(() =>
      routeDeterministic({ ref: 'x', provenance: 'code-wiki-change' } as ArtifactDescriptor),
    ).toThrow(/subsystemShardKey/);
  });
});

describe('validateDecision — the 4-action contract', () => {
  it('rejects merge-shard without a target', () => {
    const r = validateDecision({
      artifactRef: 'x',
      provenance: 'unknown',
      realm: 'official',
      action: 'merge-shard',
      reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/target/);
  });

  it('rejects edge-only without an edge', () => {
    const r = validateDecision({
      artifactRef: 'x',
      provenance: 'unknown',
      realm: 'concept',
      action: 'edge-only',
      reason: 'r',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/edge/);
  });

  it('accepts a well-formed log-only decision and defaults status to applied', () => {
    const r = validateDecision({
      artifactRef: 'x',
      provenance: 'log',
      realm: 'decisions',
      action: 'log-only',
      reason: 'r',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.status).toBe('applied');
  });
});
