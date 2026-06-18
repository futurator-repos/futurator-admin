// Tests for detectors/knowledge-graph.ts — D-KC1..D-KC6 (rubric §0.6/§0.7).
//
// Asserts the §0.6 thresholdExprs precisely, the orphans.json→snapshot fallback,
// the UUID-stranded / living-doc-floater derivations, and the honesty guard
// (⚪ + [needs-instrumentation] when evidence is absent — never fabricated).

import { describe, it, expect } from 'vitest';
import { scoreKnowledgeGraph } from '../detectors/knowledge-graph';
import type { DetectorContext, GraphReports, ScorecardSlice } from '../types';

// ── minimal synthetic DetectorContext ────────────────────────────────────────

function ctxWith(graphReports?: GraphReports): DetectorContext {
  return {
    planId: 'plan-test',
    // The detector only reads ctx.graphReports; the rest is structurally
    // satisfied with empty stand-ins (cast to keep the test focused).
    plan: {} as DetectorContext['plan'],
    epics: [],
    events: [],
    slices: [],
    aggregate: { byCategory: {}, totalMs: 0 } as unknown as DetectorContext['aggregate'],
    skills: null,
    cohort: null,
    byCat: (() => ({ totalMs: 0, count: 0 })) as DetectorContext['byCat'],
    ...(graphReports ? { graphReports } : {}),
  };
}

function byId(slices: ScorecardSlice[]): Record<string, ScorecardSlice> {
  return Object.fromEntries(slices.map((s) => [s.criterionId, s]));
}

// ── always-⚪ criteria (needs-instrumentation by design) ──────────────────────

describe('D-KC1 / D-KC4 honesty guard', () => {
  it('D-KC1 is always ⚪ — index.md mtime + wave-close ts not in Lambda inputs', () => {
    const { 'D-KC1': s } = byId(scoreKnowledgeGraph(ctxWith()));
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toContain('[needs-instrumentation:');
  });

  it('D-KC4 is always ⚪ — surfaced-vs-swallowed is a daemon-log fact; F16 linked', () => {
    const full: GraphReports = {
      orphans: { status: 'fail', orphanCount: 14 },
    };
    const { 'D-KC4': s } = byId(scoreKnowledgeGraph(ctxWith(full)));
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toContain('[needs-instrumentation:');
    expect(s.fixIds.map((f) => f.id)).toContain('F16');
  });
});

// ── D-KC2: ast-facts coverage ─────────────────────────────────────────────────

describe('D-KC2 ast-facts completeness', () => {
  it('🟢 ≥0.95', () => {
    const { 'D-KC2': s } = byId(
      scoreKnowledgeGraph(ctxWith({ astFacts: { fileCount: 96 }, projectSourceFileCount: 100 })),
    );
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
    expect(s.value).toBeCloseTo(0.96, 4);
    expect(s.ieIds).toEqual([]);
  });

  it('🟡 0.5–0.95 → IE16/F14 linked', () => {
    const { 'D-KC2': s } = byId(
      scoreKnowledgeGraph(ctxWith({ astFacts: { fileCount: 70 }, projectSourceFileCount: 100 })),
    );
    expect(s.verdict).toBe('🟡');
    expect(s.score).toBe(2);
    expect(s.ieIds).toContain('IE16');
    expect(s.fixIds.map((f) => f.id)).toContain('F14');
  });

  it('🔴 <0.5', () => {
    const { 'D-KC2': s } = byId(
      scoreKnowledgeGraph(ctxWith({ astFacts: { fileCount: 30 }, projectSourceFileCount: 100 })),
    );
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
    expect(s.ieIds).toContain('IE16');
  });

  it('⚪ when ast-facts missing', () => {
    const { 'D-KC2': s } = byId(scoreKnowledgeGraph(ctxWith({ projectSourceFileCount: 100 })));
    expect(s.verdict).toBe('⚪');
    expect(s.note).toContain('[needs-instrumentation:');
  });

  it('⚪ when denominator (projectSourceFileCount) missing', () => {
    const { 'D-KC2': s } = byId(scoreKnowledgeGraph(ctxWith({ astFacts: { fileCount: 96 } })));
    expect(s.verdict).toBe('⚪');
    expect(s.note).toContain('projectSourceFileCount');
  });
});

// ── D-KC3: orphan rate + fallback ─────────────────────────────────────────────

describe('D-KC3 orphan rate (orphans.json primary)', () => {
  it('🟢 pass ∧ 0', () => {
    const { 'D-KC3': s } = byId(
      scoreKnowledgeGraph(ctxWith({ orphans: { status: 'pass', orphanCount: 0 } })),
    );
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
  });

  it('🟡 1–5', () => {
    const { 'D-KC3': s } = byId(
      scoreKnowledgeGraph(ctxWith({ orphans: { status: 'pass', orphanCount: 3 } })),
    );
    expect(s.verdict).toBe('🟡');
    expect(s.score).toBe(2);
    expect(s.value).toBe(3);
  });

  it('🔴 status==fail', () => {
    const { 'D-KC3': s } = byId(
      scoreKnowledgeGraph(ctxWith({ orphans: { status: 'fail', orphanCount: 2 } })),
    );
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });

  it('🔴 orphanCount>5 even when status pass; IE17+IE19 fixes deduped', () => {
    const { 'D-KC3': s } = byId(
      scoreKnowledgeGraph(ctxWith({ orphans: { status: 'pass', orphanCount: 14 } })),
    );
    expect(s.verdict).toBe('🔴');
    expect(s.ieIds).toEqual(expect.arrayContaining(['IE17', 'IE19']));
    const ids = s.fixIds.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['F14', 'F15', 'F17']));
    // deduped — no duplicate F14/F15.
    expect(new Set(ids).size).toBe(ids.length);
    // F17 carries its shipped SHA from the canonical map.
    expect(s.fixIds.find((f) => f.id === 'F17')?.status).toBe('shipped');
  });

  it('surfaces dead-code zombie count in the note', () => {
    const { 'D-KC3': s } = byId(
      scoreKnowledgeGraph(
        ctxWith({ orphans: { status: 'pass', orphanCount: 0 }, deadCode: { count: 4 } }),
      ),
    );
    expect(s.note).toContain('4');
  });
});

describe('D-KC3 fallback (snapshot degree-0)', () => {
  it('derives degree-0 code orphans when orphans.json absent', () => {
    const snapshot = {
      projectId: 'pacman3',
      generatedAt: 't',
      nodeCount: 3,
      edgeCount: 1,
      nodes: [
        { id: 'a', type: 'code' },
        { id: 'b', type: 'code' }, // orphan: in no edge
        { id: 'd', type: 'decision' }, // not code → ignored
      ],
      edges: [{ source: 'a', target: 'd' }],
    };
    const { 'D-KC3': s } = byId(scoreKnowledgeGraph(ctxWith({ snapshot })));
    expect(s.value).toBe(1); // only node 'b'
    expect(s.verdict).toBe('🟡');
    expect(s.evidence.ref).toContain('derived');
  });

  it('⚪ when neither orphans.json nor snapshot present', () => {
    const { 'D-KC3': s } = byId(scoreKnowledgeGraph(ctxWith({})));
    expect(s.verdict).toBe('⚪');
    expect(s.note).toContain('[needs-instrumentation:');
  });
});

// ── D-KC5: projectId partition integrity ──────────────────────────────────────

describe('D-KC5 UUID-stranded nodes', () => {
  const slug = 'pacman3';
  const uuid = '550e8400-e29b-41d4-a716-446655440000';

  it('🟢 all nodes carry the slug', () => {
    const snapshot = {
      projectId: slug,
      generatedAt: 't',
      nodeCount: 2,
      edgeCount: 0,
      nodes: [
        { id: 'a', projectId: slug },
        { id: 'b', projectId: slug },
      ],
      edges: [],
    };
    const { 'D-KC5': s } = byId(scoreKnowledgeGraph(ctxWith({ snapshot })));
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
    expect(s.value).toBe(0);
  });

  it('🔴 ≥1 UUID-stranded node → IE18/F17(shipped)', () => {
    const snapshot = {
      projectId: slug,
      generatedAt: 't',
      nodeCount: 2,
      edgeCount: 0,
      nodes: [
        { id: 'a', projectId: slug },
        { id: 'b', projectId: uuid },
      ],
      edges: [],
    };
    const { 'D-KC5': s } = byId(scoreKnowledgeGraph(ctxWith({ snapshot })));
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
    expect(s.value).toBe(1);
    expect(s.ieIds).toContain('IE18');
    expect(s.fixIds.find((f) => f.id === 'F17')?.status).toBe('shipped');
  });

  it('⚪ when snapshot absent', () => {
    const { 'D-KC5': s } = byId(scoreKnowledgeGraph(ctxWith({})));
    expect(s.verdict).toBe('⚪');
  });
});

// ── D-KC6: living-doc connectivity ────────────────────────────────────────────

describe('D-KC6 degree-0 living-doc floaters', () => {
  it('🟢 every living-doc node is connected', () => {
    const snapshot = {
      projectId: 'pacman3',
      generatedAt: 't',
      nodeCount: 2,
      edgeCount: 1,
      nodes: [
        { id: 'arch', type: 'architecture' },
        { id: 'code1', type: 'code' },
      ],
      edges: [{ source: 'arch', target: 'code1' }],
    };
    const { 'D-KC6': s } = byId(scoreKnowledgeGraph(ctxWith({ snapshot })));
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
  });

  it('🔴 a decision/system/index/architecture node floats unconnected → F18(shipped)', () => {
    const snapshot = {
      projectId: 'pacman3',
      generatedAt: 't',
      nodeCount: 3,
      edgeCount: 1,
      nodes: [
        { id: 'arch', type: 'architecture' }, // connected
        { id: 'dec', type: 'decision' }, // floater
        { id: 'code1', type: 'code' },
      ],
      edges: [{ source: 'arch', target: 'code1' }],
    };
    const { 'D-KC6': s } = byId(scoreKnowledgeGraph(ctxWith({ snapshot })));
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
    expect(s.value).toBe(1);
    expect(s.fixIds.find((f) => f.id === 'F18')?.status).toBe('shipped');
  });

  it('⚪ when snapshot absent', () => {
    const { 'D-KC6': s } = byId(scoreKnowledgeGraph(ctxWith({})));
    expect(s.verdict).toBe('⚪');
  });
});

// ── shape invariants ──────────────────────────────────────────────────────────

describe('scoreKnowledgeGraph shape', () => {
  it('emits exactly D-KC1..D-KC6, all engine=deterministic', () => {
    const slices = scoreKnowledgeGraph(ctxWith());
    expect(slices.map((s) => s.criterionId)).toEqual([
      'D-KC1',
      'D-KC2',
      'D-KC3',
      'D-KC4',
      'D-KC5',
      'D-KC6',
    ]);
    for (const s of slices) {
      expect(s.engine).toBe('deterministic');
      expect(s.stage).toBe('development');
    }
  });
});
