// Gate G-5 — Timer classifier coverage (Story 1.8.1)
// Every AgentEventType maps to exactly one category; 50+ matrix rows;
// at least 3 hits per category; edge cases: NEEDS_ATTENTION override,
// fix-on-retry, reviewer cross-cut, unknown event → unattributed.
import { describe, it, expect } from 'vitest';
import { classify } from '../classifier';
import type { AgentEvent } from '../../types/agent-orchestrator';
import type { AgentEventType } from '../../types/agent-orchestrator';
import type { JobContext } from '../types';
import { CLASSIFICATION_TABLE } from '../categories';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CONTEXT: JobContext = {
  jobKind: 'pipeline',
  agentRole: 'dev',
  jobStatus: 'RUNNING',
  retryCount: 0,
};

function makeEvent(eventType: AgentEventType, role?: string): AgentEvent {
  return {
    jobId: 'job-1',
    eventSeq: '0001',
    seq: 1,
    timestamp: new Date().toISOString(),
    stepId: 'step-1',
    agentId: role ?? 'dev-agent',
    eventType,
    expireAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function ctx(overrides: Partial<JobContext>): JobContext {
  return { ...BASE_CONTEXT, ...overrides };
}

// ── Matrix rows ───────────────────────────────────────────────────────────────
// Format: [description, eventType, jobContext overrides, expected category]

type MatrixRow = [string, AgentEventType, Partial<JobContext>, string];

const MATRIX: MatrixRow[] = [
  // ── dev ───────────────────────────────────────────────────────────────────
  ['text_delta + dev role → dev', 'text_delta', { agentRole: 'dev', retryCount: 0 }, 'dev'],
  ['tool_use + dev role → dev', 'tool_use', { agentRole: 'dev', retryCount: 0 }, 'dev'],
  ['tool_result + dev role → dev', 'tool_result', { agentRole: 'dev', retryCount: 0 }, 'dev'],
  ['result + dev role → dev', 'result', { agentRole: 'dev', retryCount: 0 }, 'dev'],
  // unknown role falls to default (dev for these events)
  [
    'text_delta + unknown role → dev',
    'text_delta',
    { agentRole: 'unknown-agent', retryCount: 0 },
    'dev',
  ],
  ['tool_use + unknown role → dev', 'tool_use', { agentRole: 'qa-agent', retryCount: 0 }, 'dev'],

  // ── review ────────────────────────────────────────────────────────────────
  [
    'text_delta + reviewer → review',
    'text_delta',
    { agentRole: 'reviewer', retryCount: 0 },
    'review',
  ],
  ['tool_use + reviewer → review', 'tool_use', { agentRole: 'reviewer', retryCount: 0 }, 'review'],
  [
    'tool_result + reviewer → review',
    'tool_result',
    { agentRole: 'reviewer', retryCount: 0 },
    'review',
  ],
  ['result + reviewer → review', 'result', { agentRole: 'reviewer', retryCount: 0 }, 'review'],

  // ── test-author + compile (PR-49 role overrides) ──────────────────────────
  [
    'text_delta + test → test-author',
    'text_delta',
    { agentRole: 'test', retryCount: 0 },
    'test-author',
  ],
  [
    'tool_use + test → test-author',
    'tool_use',
    { agentRole: 'test', retryCount: 0 },
    'test-author',
  ],
  [
    'tool_result + test → test-author',
    'tool_result',
    { agentRole: 'test', retryCount: 0 },
    'test-author',
  ],
  ['result + test → test-author', 'result', { agentRole: 'test', retryCount: 0 }, 'test-author'],
  [
    'text_delta + compiler → compile',
    'text_delta',
    { agentRole: 'compiler', retryCount: 0 },
    'compile',
  ],
  [
    'tool_use + compiler → compile',
    'tool_use',
    { agentRole: 'compiler', retryCount: 0 },
    'compile',
  ],
  [
    'tool_result + compiler → compile',
    'tool_result',
    { agentRole: 'compiler', retryCount: 0 },
    'compile',
  ],
  ['result + compiler → compile', 'result', { agentRole: 'compiler', retryCount: 0 }, 'compile'],
  [
    'review_verdict (any role) → review',
    'review_verdict',
    { agentRole: 'reviewer', retryCount: 0 },
    'review',
  ],
  [
    'review_verdict + dev role → review',
    'review_verdict',
    { agentRole: 'dev', retryCount: 0 },
    'review',
  ],
  [
    'review_verdict + orchestrator → review',
    'review_verdict',
    { agentRole: 'orchestrator', retryCount: 0 },
    'review',
  ],

  // ── fix ───────────────────────────────────────────────────────────────────
  [
    'text_delta + dev + retryCount=1 → fix',
    'text_delta',
    { agentRole: 'dev', retryCount: 1 },
    'fix',
  ],
  ['tool_use + dev + retryCount=2 → fix', 'tool_use', { agentRole: 'dev', retryCount: 2 }, 'fix'],
  [
    'tool_result + dev + retryCount=3 → fix',
    'tool_result',
    { agentRole: 'dev', retryCount: 3 },
    'fix',
  ],
  ['result + dev + retryCount=1 → fix', 'result', { agentRole: 'dev', retryCount: 1 }, 'fix'],
  ['remediation_start → fix', 'remediation_start', { agentRole: 'dev', retryCount: 0 }, 'fix'],
  ['step_error → fix', 'step_error', { agentRole: 'dev', retryCount: 0 }, 'fix'],
  ['compilation-failed → fix', 'compilation-failed', { agentRole: 'dev', retryCount: 0 }, 'fix'],
  [
    'inference_failed → fix',
    'inference_failed',
    { agentRole: 'orchestrator', retryCount: 0 },
    'fix',
  ],
  [
    'story_failed_terminally → fix',
    'story_failed_terminally',
    { agentRole: 'orchestrator', retryCount: 0 },
    'fix',
  ],

  // reviewer on retry does NOT shift to fix (reviewing is reviewing)
  [
    'text_delta + reviewer + retryCount=5 → still review',
    'text_delta',
    { agentRole: 'reviewer', retryCount: 5 },
    'review',
  ],
  // orchestrator on retry does NOT shift to fix (orchestrating is compiling)
  [
    'tool_use + orchestrator + retryCount=2 → compile',
    'tool_use',
    { agentRole: 'orchestrator', retryCount: 2 },
    'compile',
  ],

  // ── compile ───────────────────────────────────────────────────────────────
  ['step_start → compile', 'step_start', { agentRole: 'dev', retryCount: 0 }, 'compile'],
  ['step_complete → compile', 'step_complete', { agentRole: 'dev', retryCount: 0 }, 'compile'],
  ['extraction → compile', 'extraction', { agentRole: 'dev', retryCount: 0 }, 'compile'],
  ['validation → compile', 'validation', { agentRole: 'dev', retryCount: 0 }, 'compile'],
  [
    'compilation-started → compile',
    'compilation-started',
    { agentRole: 'dev', retryCount: 0 },
    'compile',
  ],
  [
    'compilation-completed → compile',
    'compilation-completed',
    { agentRole: 'dev', retryCount: 0 },
    'compile',
  ],
  ['epic_start → compile', 'epic_start', { agentRole: 'orchestrator', retryCount: 0 }, 'compile'],
  [
    'epic_complete → compile',
    'epic_complete',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  ['epic_failed → compile', 'epic_failed', { agentRole: 'orchestrator', retryCount: 0 }, 'compile'],
  ['wave_start → compile', 'wave_start', { agentRole: 'orchestrator', retryCount: 0 }, 'compile'],
  [
    'wave_complete → compile',
    'wave_complete',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  ['wave_split → compile', 'wave_split', { agentRole: 'orchestrator', retryCount: 0 }, 'compile'],
  [
    'wave_collision → compile',
    'wave_collision',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'blocker_resolved → compile',
    'blocker_resolved',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'touch_points_expanded → compile',
    'touch_points_expanded',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'context_expanded → compile',
    'context_expanded',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'inference_start → compile',
    'inference_start',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'story_inferred → compile',
    'story_inferred',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'wave_conflict_autosplit → compile',
    'wave_conflict_autosplit',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'inference_complete → compile',
    'inference_complete',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],
  [
    'text_delta + orchestrator → compile',
    'text_delta',
    { agentRole: 'orchestrator', retryCount: 0 },
    'compile',
  ],

  // ── human-wait ────────────────────────────────────────────────────────────
  // NEEDS_ATTENTION cross-cut overrides every event type
  [
    'ANY event + NEEDS_ATTENTION → human-wait (text_delta)',
    'text_delta',
    { jobStatus: 'NEEDS_ATTENTION', agentRole: 'dev', retryCount: 0 },
    'human-wait',
  ],
  [
    'ANY event + NEEDS_ATTENTION → human-wait (tool_use)',
    'tool_use',
    { jobStatus: 'NEEDS_ATTENTION', agentRole: 'dev', retryCount: 0 },
    'human-wait',
  ],
  [
    'ANY event + NEEDS_ATTENTION → human-wait (wave_start)',
    'wave_start',
    { jobStatus: 'NEEDS_ATTENTION', agentRole: 'orchestrator', retryCount: 0 },
    'human-wait',
  ],
  [
    'NEEDS_ATTENTION with reviewer role → still human-wait',
    'review_verdict',
    { jobStatus: 'NEEDS_ATTENTION', agentRole: 'reviewer', retryCount: 0 },
    'human-wait',
  ],
  // Explicit human-wait events (independent of NEEDS_ATTENTION)
  [
    'dev_blocker_reported → human-wait',
    'dev_blocker_reported',
    { agentRole: 'orchestrator', jobStatus: 'RUNNING', retryCount: 0 },
    'human-wait',
  ],
  [
    'story_blocked → human-wait',
    'story_blocked',
    { agentRole: 'orchestrator', jobStatus: 'RUNNING', retryCount: 0 },
    'human-wait',
  ],
  // Transition: NEEDS_ATTENTION → COMPLETED_VIA_SALVAGE — any events during NA window
  [
    'NEEDS_ATTENTION → terminal: intermediate events → human-wait',
    'status',
    { jobStatus: 'NEEDS_ATTENTION', agentRole: 'dev', retryCount: 1 },
    'human-wait',
  ],

  // ── machine-wait ──────────────────────────────────────────────────────────
  [
    'status → machine-wait',
    'status',
    { agentRole: 'dev', jobStatus: 'RUNNING', retryCount: 0 },
    'machine-wait',
  ],
  [
    'subagent_dispatch → machine-wait',
    'subagent_dispatch',
    { agentRole: 'orchestrator', retryCount: 0 },
    'machine-wait',
  ],
  [
    'subagent_return → machine-wait',
    'subagent_return',
    { agentRole: 'orchestrator', retryCount: 0 },
    'machine-wait',
  ],

  // ── Edge: RUNNING + specific event type ──────────────────────────────────
  [
    'RUNNING + tool_use + dev + retryCount=0 → dev',
    'tool_use',
    { jobStatus: 'RUNNING', agentRole: 'dev', retryCount: 0 },
    'dev',
  ],
  [
    'RUNNING + tool_use + dev + retryCount=1 → fix',
    'tool_use',
    { jobStatus: 'RUNNING', agentRole: 'dev', retryCount: 1 },
    'fix',
  ],

  // ── Edge: COMPLETED status (job done, event is a late flush) ─────────────
  // COMPLETED is NOT NEEDS_ATTENTION → normal classification applies
  [
    'COMPLETED status + text_delta + dev → dev',
    'text_delta',
    { jobStatus: 'COMPLETED', agentRole: 'dev', retryCount: 0 },
    'dev',
  ],

  // ── unattributed ──────────────────────────────────────────────────────────
  // Only reached for event types not in the table (future unknown events).
  // We cannot exercise this via a valid AgentEventType enum value, so we cast.
  // The test verifies the fallback path exists and returns 'unattributed'.
  // (The exhaustive switch in lookupTable() prevents valid types from reaching here.)
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('classify — matrix', () => {
  it.each(MATRIX)('%s', (_, eventType, ctxOverrides, expectedCategory) => {
    const event = makeEvent(eventType);
    const jobContext = ctx(ctxOverrides);
    expect(classify(event, jobContext)).toBe(expectedCategory);
  });
});

describe('classify — unattributed fallback', () => {
  it('returns unattributed for an unknown event type (forward-compat)', () => {
    // Cast a non-existent event type to bypass TypeScript — simulates a new daemon
    // version emitting an event type the current classifier does not know yet.
    const event = {
      ...makeEvent('text_delta'),
      eventType: '__future_event_type__' as AgentEventType,
    };
    const result = classify(event, BASE_CONTEXT);
    expect(result).toBe('unattributed');
  });
});

describe('classify — exhaustiveness: every AgentEventType in the table', () => {
  it('every key in CLASSIFICATION_TABLE is a valid AgentEventType and returns a non-unattributed category', () => {
    const allEventTypes = Object.keys(CLASSIFICATION_TABLE) as AgentEventType[];

    // Verify we have all 38 values from the enum (sanity count —
    // pacman1 2026-06-12 added skills_available/skill_activated/
    // claude_md_loaded).
    expect(allEventTypes.length).toBe(38);

    for (const eventType of allEventTypes) {
      const event = makeEvent(eventType);
      const result = classify(event, BASE_CONTEXT);
      // Every known event type must resolve to a defined category.
      // 'unattributed' means the table is incomplete — this is the G-5 runtime gate.
      expect(result, `${eventType} should not be unattributed`).not.toBe('unattributed');
    }
  });
});

describe('classify — category coverage (≥3 per category)', () => {
  // Build a map of category → count from MATRIX
  const categoryCounts: Record<string, number> = {};
  for (const [, , , expected] of MATRIX) {
    categoryCounts[expected] = (categoryCounts[expected] ?? 0) + 1;
  }

  const EXPECTED_CATEGORIES = [
    'dev',
    'review',
    'fix',
    'compile',
    'human-wait',
    'machine-wait',
  ] as const;

  for (const cat of EXPECTED_CATEGORIES) {
    it(`category '${cat}' has ≥3 matrix rows`, () => {
      expect(categoryCounts[cat] ?? 0).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('classify — fix-on-retry edge cases', () => {
  it('retryCount=0 does not trigger fix for dev text_delta', () => {
    expect(classify(makeEvent('text_delta'), ctx({ agentRole: 'dev', retryCount: 0 }))).toBe('dev');
  });

  it('retryCount=1 triggers fix for dev text_delta', () => {
    expect(classify(makeEvent('text_delta'), ctx({ agentRole: 'dev', retryCount: 1 }))).toBe('fix');
  });

  it('retryCount=10 triggers fix for dev tool_use', () => {
    expect(classify(makeEvent('tool_use'), ctx({ agentRole: 'dev', retryCount: 10 }))).toBe('fix');
  });

  it('retryCount=1 does NOT trigger fix for reviewer (role not fix-eligible)', () => {
    expect(classify(makeEvent('text_delta'), ctx({ agentRole: 'reviewer', retryCount: 1 }))).toBe(
      'review',
    );
  });

  it('retryCount=1 does NOT trigger fix for orchestrator (role not fix-eligible)', () => {
    expect(
      classify(makeEvent('text_delta'), ctx({ agentRole: 'orchestrator', retryCount: 1 })),
    ).toBe('compile');
  });

  it('retryCount=1 does NOT trigger fix for step_start (event type not fix-on-retry eligible)', () => {
    expect(classify(makeEvent('step_start'), ctx({ agentRole: 'dev', retryCount: 1 }))).toBe(
      'compile',
    );
  });
});

describe('classify — NEEDS_ATTENTION cross-cut', () => {
  const attentionCtx = ctx({ jobStatus: 'NEEDS_ATTENTION', retryCount: 0 });

  it('overrides dev text_delta → human-wait', () => {
    expect(classify(makeEvent('text_delta'), { ...attentionCtx, agentRole: 'dev' })).toBe(
      'human-wait',
    );
  });

  it('overrides reviewer review_verdict → human-wait', () => {
    expect(classify(makeEvent('review_verdict'), { ...attentionCtx, agentRole: 'reviewer' })).toBe(
      'human-wait',
    );
  });

  it('overrides orchestrator wave_start → human-wait', () => {
    expect(classify(makeEvent('wave_start'), { ...attentionCtx, agentRole: 'orchestrator' })).toBe(
      'human-wait',
    );
  });

  it('overrides compilation-started → human-wait', () => {
    expect(classify(makeEvent('compilation-started'), attentionCtx)).toBe('human-wait');
  });

  it('overrides subagent_dispatch → human-wait (not machine-wait)', () => {
    expect(
      classify(makeEvent('subagent_dispatch'), { ...attentionCtx, agentRole: 'orchestrator' }),
    ).toBe('human-wait');
  });

  it('overrides step_error → human-wait (not fix)', () => {
    expect(classify(makeEvent('step_error'), attentionCtx)).toBe('human-wait');
  });
});

describe('classify — matrix row count', () => {
  it('matrix has at least 50 rows', () => {
    expect(MATRIX.length).toBeGreaterThanOrEqual(50);
  });
});
