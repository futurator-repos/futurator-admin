// Tests for detectors/overview.ts — Plan Retrospect OV1–OV11 (rubric §0.6 / §7).
//
// Asserts the deterministic verdict bands, the §4a cost honesty guard (OV2/OV3
// go `unreconciled` + lower-bound when OV4 doesn't reconcile), the
// needs-instrumentation '⚪' slices for absent evidence (OV6 always F2-gated;
// OV4/OV8 when their rows aren't provided), OV5 done>total drift, OV10
// fix≈0 misattribution, and OV11's forced-F spawn-precondition detection.

import { describe, it, expect } from 'vitest';
import { scoreOverview } from '../overview';
import type { DetectorContext, ScorecardSlice, AgentSpendRow } from '../../types';
import type { Plan } from '../../../types/plan';
import type { EpicWorkflow, EpicStory } from '../../../types/epic-workflow';
import type { AgentEvent } from '../../../types/agent-orchestrator';
import type { ForensicSkillsBlock } from '../../../timer/forensic-builder';
import type { CategorySummary } from '../../../timer/aggregator';

// ── synthetic context ────────────────────────────────────────────────────────

interface Overrides {
  plan?: Partial<Plan>;
  epics?: EpicWorkflow[];
  events?: AgentEvent[];
  skills?: ForensicSkillsBlock | null;
  reflections?: unknown;
  agentSpendRows?: AgentSpendRow[];
  byCat?: Record<string, CategorySummary>;
}

const ZERO: CategorySummary = { totalMs: 0, count: 0 };

function ctx(o: Overrides = {}): DetectorContext {
  const plan = {
    planId: 'plan_test',
    status: 'review',
    totalStories: 5,
    doneStories: 5,
    totalCostUsd: 4,
    costCeilingUsd: 20,
    startedAt: '2026-06-18T10:00:00.000Z',
    reviewAt: '2026-06-18T10:30:00.000Z', // 30 min build wall → 6 min/story
    ...o.plan,
  } as Plan;

  const byCatMap = o.byCat ?? {};
  return {
    planId: 'plan_test',
    plan,
    epics: o.epics ?? [],
    events: o.events ?? [],
    slices: [],
    aggregate: { byCategory: {}, totalMs: 0 } as DetectorContext['aggregate'],
    skills: o.skills ?? null,
    cohort: null,
    byCat: (c: string) => byCatMap[c] ?? ZERO,
    reflections: o.reflections,
    agentSpendRows: o.agentSpendRows,
  };
}

function story(over: Partial<EpicStory> = {}): EpicStory {
  return { storyId: 's1', title: 't', ...over } as EpicStory;
}
function epic(stories: EpicStory[]): EpicWorkflow {
  return { epicId: 'e1', stories } as EpicWorkflow;
}

function byId(slices: ScorecardSlice[]): Record<string, ScorecardSlice> {
  return Object.fromEntries(slices.map((s) => [s.criterionId, s]));
}

// Reconciled spend rows (within 5% of plan.totalCostUsd=4) so cost criteria
// score precisely unless a test overrides.
const RECONCILED_SPEND: AgentSpendRow[] = [
  { planId: 'plan_test', costUsd: 4, bucket: 'pipeline-v2' },
];

// ── shape ────────────────────────────────────────────────────────────────────

describe('scoreOverview — shape', () => {
  it('emits exactly the DET overview criteria in id order, all deterministic', () => {
    const slices = scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND }));
    expect(slices.map((s) => s.criterionId)).toEqual([
      'OV1',
      'OV2',
      'OV3',
      'OV4',
      'OV5',
      'OV6',
      'OV7',
      'OV8',
      'OV10',
      'OV11',
    ]);
    expect(slices.every((s) => s.engine === 'deterministic')).toBe(true);
    expect(slices.every((s) => s.stage === 'overview')).toBe(true);
    // OV9 (LLM) is never emitted here.
    expect(slices.find((s) => s.criterionId === 'OV9')).toBeUndefined();
  });
});

// ── OV1 — build-phase wall per story ──────────────────────────────────────────

describe('OV1 — buildWall ÷ doneStories', () => {
  it('🟢 at ≤8 min/story (30min ÷ 5 = 6)', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND }))).OV1;
    expect(s.verdict).toBe('🟢');
    expect(s.score).toBe(4);
    expect(s.value).toBeCloseTo(6, 1);
  });

  it('🔴 above 15 min/story', () => {
    const s = byId(
      scoreOverview(
        ctx({
          plan: { reviewAt: '2026-06-18T11:40:00.000Z' }, // 100 min ÷ 5 = 20
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV1;
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });

  it('⚪ when reviewAt is absent (plan never reached review)', () => {
    const s = byId(scoreOverview(ctx({ plan: { reviewAt: undefined } }))).OV1;
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toContain('needs-instrumentation');
  });
});

// ── OV2/OV3 — cost honesty guard ──────────────────────────────────────────────

describe('OV2/OV3 — cost criteria honesty guard', () => {
  it('reconciled spend → precise value + confidence:reconciled', () => {
    const m = byId(scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND })));
    expect(m.OV2.confidence).toBe('reconciled');
    expect(m.OV2.value).toBe(0.2); // 4 / 20
    expect(m.OV2.verdict).toBe('🟢');
    expect(m.OV3.confidence).toBe('reconciled');
    expect(m.OV3.value).toBe(0.8); // 4 / 5
    expect(m.OV3.verdict).toBe('🟢');
  });

  it('unreconciled spend → lower-bound value + confidence:unreconciled (still scores)', () => {
    // Spend rows undercount (1 vs plan 4 → deltaPct=0.75 > 0.05) → unreconciled.
    const m = byId(scoreOverview(ctx({ agentSpendRows: [{ planId: 'plan_test', costUsd: 1 }] })));
    expect(m.OV2.confidence).toBe('unreconciled');
    expect(String(m.OV2.value)).toContain('lower-bound');
    expect(m.OV2.score).not.toBeNull(); // still scored, not ⚪
    expect(m.OV3.confidence).toBe('unreconciled');
    expect(String(m.OV3.value)).toContain('lower-bound');
  });

  it('no agent-spend rows → cost criteria fall to unreconciled (cannot reconcile)', () => {
    const m = byId(scoreOverview(ctx({ agentSpendRows: undefined })));
    expect(m.OV2.confidence).toBe('unreconciled');
    expect(m.OV3.confidence).toBe('unreconciled');
  });

  it('OV2 🔴 when ratio > 1.1 (overrun)', () => {
    const s = byId(
      scoreOverview(
        ctx({
          plan: { totalCostUsd: 25, costCeilingUsd: 20 },
          agentSpendRows: [{ planId: 'plan_test', costUsd: 25 }],
        }),
      ),
    ).OV2;
    expect(s.verdict).toBe('🔴');
    // IE6→F6 attached on the red.
    expect(s.ieIds).toContain('IE6');
    expect(s.fixIds.map((f) => f.id)).toContain('F6');
  });
});

// ── OV4 — forensic cost completeness ──────────────────────────────────────────

describe('OV4 — agent-spend reconciliation', () => {
  it('🟢 when |deltaPct| ≤ 0.05', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND }))).OV4;
    expect(s.verdict).toBe('🟢');
    expect(s.value).toBeCloseTo(0, 3);
    // OV4 is the F3 surface — IE3→F3(shipped) attached even on green.
    expect(s.ieIds).toContain('IE3');
    expect(s.fixIds.map((f) => f.id)).toContain('F3');
    expect(s.fixIds.find((f) => f.id === 'F3')?.status).toBe('shipped');
  });

  it('🔴 when delta > 0.15', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: [{ costUsd: 1 }] }))).OV4;
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });

  it('⚪ when no agent-spend rows provided', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: undefined }))).OV4;
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toContain('needs-instrumentation');
  });
});

// ── OV5 — count integrity ─────────────────────────────────────────────────────

describe('OV5 — doneStories − totalStories', () => {
  it('🟢 when done ≤ total', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND }))).OV5;
    expect(s.verdict).toBe('🟢');
    expect(s.value).toBe(0);
  });

  it('🔴 when done > total (counter drift, IE4→F4)', () => {
    const s = byId(
      scoreOverview(
        ctx({ plan: { doneStories: 7, totalStories: 5 }, agentSpendRows: RECONCILED_SPEND }),
      ),
    ).OV5;
    expect(s.verdict).toBe('🔴');
    expect(s.value).toBe(2);
    expect(s.ieIds).toContain('IE4');
    expect(s.fixIds.map((f) => f.id)).toContain('F4');
  });

  it('counts wave-vqa-fix fix-forward stories in the note', () => {
    const e = epic([story({ origin: 'wave-vqa-fix' }), story({ storyId: 's2' })]);
    const s = byId(scoreOverview(ctx({ epics: [e], agentSpendRows: RECONCILED_SPEND }))).OV5;
    expect(s.note).toContain('1 wave-vqa-fix');
  });
});

// ── OV6 — always F2-gated ⚪ ───────────────────────────────────────────────────

describe('OV6 — log retention (needs-instrumentation: F2)', () => {
  it('is always ⚪ with an F2 note (priorJobIds not materialized)', () => {
    const s = byId(scoreOverview(ctx({ agentSpendRows: RECONCILED_SPEND }))).OV6;
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
    expect(s.note).toContain('F2');
  });
});

// ── OV7 — skills catalog overhead (secondary) ─────────────────────────────────

describe('OV7 — availableSkillCount vs activatedSkills', () => {
  function block(over: Partial<ForensicSkillsBlock> = {}): ForensicSkillsBlock {
    return {
      activatedSkills: [],
      perJob: [],
      totalSkillToolUseEvents: 0,
      skillScoutRuns: [],
      availableSkillCount: 66,
      hasSkillTool: true,
      ...over,
    };
  }

  it('🟡 (secondary) for a large unused catalog — never the catastrophic 🔴', () => {
    const s = byId(scoreOverview(ctx({ skills: block(), agentSpendRows: RECONCILED_SPEND }))).OV7;
    expect(s.verdict).toBe('🟡');
    expect(s.note).toContain('SECONDARY');
  });

  it('⚪ when skills block is null', () => {
    const s = byId(scoreOverview(ctx({ skills: null, agentSpendRows: RECONCILED_SPEND }))).OV7;
    expect(s.verdict).toBe('⚪');
  });

  it('🟢 when the catalog is scoped (small / well-activated)', () => {
    const s = byId(
      scoreOverview(
        ctx({
          skills: block({
            availableSkillCount: 6,
            activatedSkills: [{ skill: 'a', source: 's', activationCount: 1 }],
          }),
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV7;
    expect(s.verdict).toBe('🟢');
  });
});

// ── OV8 — learning loop closed ────────────────────────────────────────────────

describe('OV8 — reflector written>0', () => {
  it('🟢 when reflections written', () => {
    const s = byId(
      scoreOverview(ctx({ reflections: [{ id: 'r1' }], agentSpendRows: RECONCILED_SPEND })),
    ).OV8;
    expect(s.verdict).toBe('🟢');
    expect(s.value).toBe(1);
  });

  it('🔴 when zero reflections written (write-loss, IE5→F5)', () => {
    const s = byId(scoreOverview(ctx({ reflections: [], agentSpendRows: RECONCILED_SPEND }))).OV8;
    expect(s.verdict).toBe('🔴');
    expect(s.ieIds).toContain('IE5');
    expect(s.fixIds.map((f) => f.id)).toContain('F5');
  });

  it('⚪ when reflection rows are not provided to the scorer', () => {
    const s = byId(
      scoreOverview(ctx({ reflections: undefined, agentSpendRows: RECONCILED_SPEND })),
    ).OV8;
    expect(s.verdict).toBe('⚪');
    expect(s.note).toContain('needs-instrumentation');
  });
});

// ── OV10 — stage-time attribution ─────────────────────────────────────────────

describe('OV10 — byCategory sanity', () => {
  it('🔴 when fix work happened but fix category logs ~0ms', () => {
    const e = epic([story({ origin: 'wave-vqa-fix' })]);
    const s = byId(
      scoreOverview(
        ctx({
          epics: [e],
          byCat: { fix: { totalMs: 200, count: 1 } },
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV10;
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
  });

  it('🟢 when fix category logged real time for the fix work', () => {
    const e = epic([story({ origin: 'wave-vqa-fix' })]);
    const s = byId(
      scoreOverview(
        ctx({
          epics: [e],
          byCat: { fix: { totalMs: 120_000, count: 3 } },
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV10;
    expect(s.verdict).toBe('🟢');
  });
});

// ── OV11 — agent-spawn precondition (forced-F detection) ──────────────────────

describe('OV11 — MCP-config spawn precondition', () => {
  function ev(over: Partial<AgentEvent>): AgentEvent {
    return {
      jobId: 'j1',
      eventSeq: '1',
      seq: 1,
      timestamp: '2026-06-18T10:00:00.000Z',
      stepId: 'step1',
      agentId: 'a1',
      eventType: 'step_complete',
      expireAt: 0,
      ...over,
    } as AgentEvent;
  }

  it('🔴 (score 0 → forces F) when a step_error names a missing MCP config', () => {
    const s = byId(
      scoreOverview(
        ctx({
          events: [
            ev({ eventType: 'step_error', errorMessage: 'MCP config file not found at /tmp/x' }),
          ],
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV11;
    expect(s.verdict).toBe('🔴');
    expect(s.score).toBe(0);
    expect(s.ieIds).toContain('IE23');
    expect(s.fixIds.map((f) => f.id)).toContain('F23');
  });

  it('🟢 when agent jobs ran with no spawn-precondition failure', () => {
    const s = byId(
      scoreOverview(
        ctx({
          events: [ev({ eventType: 'step_complete', text: 'all good' })],
          agentSpendRows: RECONCILED_SPEND,
        }),
      ),
    ).OV11;
    expect(s.verdict).toBe('🟢');
  });

  it('⚪ when no events were collected (cannot observe spawn signatures)', () => {
    const s = byId(scoreOverview(ctx({ events: [], agentSpendRows: RECONCILED_SPEND }))).OV11;
    expect(s.verdict).toBe('⚪');
    expect(s.score).toBeNull();
  });
});
