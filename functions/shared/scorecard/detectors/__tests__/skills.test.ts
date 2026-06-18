// Tests for detectors/skills.ts — Plan Retrospect SK1–SK6 (rubric §3.10 / §0.6).
//
// Asserts the deterministic verdict bands, the honesty guard (⚪ + score:null
// for SK3/SK5 and absent inputs), one-criterion-per-line, and IE/fix linkage
// only when a threshold is breached.

import { describe, it, expect } from 'vitest';
import { scoreSkills } from '../skills';
import type { DetectorContext, ScorecardSlice } from '../../types';
import type { ForensicSkillsBlock } from '../../../timer/forensic-builder';

// ── synthetic context ────────────────────────────────────────────────────────

function ctx(skills: ForensicSkillsBlock | null, reflections?: unknown): DetectorContext {
  return {
    planId: 'plan_test',
    // Only `skills` + `reflections` are read by this detector; the rest are
    // stubbed to satisfy the type (the detector never touches them).
    plan: {} as DetectorContext['plan'],
    epics: [],
    events: [],
    slices: [],
    aggregate: {} as DetectorContext['aggregate'],
    skills,
    cohort: null,
    byCat: () => ({ totalMs: 0, count: 0 }),
    reflections,
  };
}

function fullBlock(over: Partial<ForensicSkillsBlock> = {}): ForensicSkillsBlock {
  return {
    activatedSkills: [],
    perJob: [],
    totalSkillToolUseEvents: 0,
    skillScoutRuns: [],
    availableSkillCount: 66,
    hasSkillTool: true,
    sessionsReportingAvailability: 10,
    sessionsReportingZeroSkills: 0,
    ...over,
  };
}

function byId(slices: ScorecardSlice[]): Record<string, ScorecardSlice> {
  return Object.fromEntries(slices.map((s) => [s.criterionId, s]));
}

// ── shape ────────────────────────────────────────────────────────────────────

describe('scoreSkills — shape', () => {
  it('emits exactly one slice per SK criterion, in id order, all deterministic', () => {
    const slices = scoreSkills(ctx(fullBlock()));
    expect(slices.map((s) => s.criterionId)).toEqual(['SK1', 'SK2', 'SK3', 'SK4', 'SK5', 'SK6']);
    expect(slices.every((s) => s.engine === 'deterministic')).toBe(true);
    expect(slices.every((s) => s.stage === 'development')).toBe(true);
  });
});

// ── null block (pre-Epic-3/4 plan) ───────────────────────────────────────────

describe('scoreSkills — null skills block', () => {
  it('emits ⚪/null for every SK with a needs-instrumentation note', () => {
    const slices = scoreSkills(ctx(null));
    expect(slices).toHaveLength(6);
    for (const s of slices) {
      expect(s.verdict).toBe('⚪');
      expect(s.score).toBeNull();
      expect(s.note).toContain('[needs-instrumentation:');
    }
  });
});

// ── SK1 availability ─────────────────────────────────────────────────────────

describe('SK1 — availability', () => {
  it('🟢 when tool present and no zero-skill session', () => {
    const s = byId(scoreSkills(ctx(fullBlock())));
    expect(s.SK1.verdict).toBe('🟢');
    expect(s.SK1.score).toBe(4);
  });

  it('🔴 when any session reported zero skills', () => {
    const s = byId(scoreSkills(ctx(fullBlock({ sessionsReportingZeroSkills: 3 }))));
    expect(s.SK1.verdict).toBe('🔴');
    expect(s.SK1.score).toBe(0);
  });

  it('⚪ when no session emitted an availability probe', () => {
    const s = byId(scoreSkills(ctx(fullBlock({ sessionsReportingAvailability: 0 }))));
    expect(s.SK1.verdict).toBe('⚪');
    expect(s.SK1.score).toBeNull();
    expect(s.SK1.note).toContain('[needs-instrumentation:');
  });
});

// ── SK2 activation (the pacman3 red) ─────────────────────────────────────────

describe('SK2 — activation rate', () => {
  it('🟢 at ≥0.30 with no IE attached', () => {
    const s = byId(
      scoreSkills(
        ctx(fullBlock({ totalSkillToolUseEvents: 5, sessionsReportingAvailability: 10 })),
      ),
    );
    expect(s.SK2.verdict).toBe('🟢');
    expect(s.SK2.value).toBeCloseTo(0.5, 5);
    expect(s.SK2.ieIds).toEqual([]);
  });

  it('🟡 in [0.10, 0.30)', () => {
    const s = byId(
      scoreSkills(
        ctx(fullBlock({ totalSkillToolUseEvents: 2, sessionsReportingAvailability: 10 })),
      ),
    );
    expect(s.SK2.verdict).toBe('🟡');
    expect(s.SK2.ieIds).toContain('IE25');
  });

  it('🔴 below 0.10 (pacman3 5.2%) with IE25→F24 attached', () => {
    const s = byId(
      scoreSkills(
        ctx(fullBlock({ totalSkillToolUseEvents: 4, sessionsReportingAvailability: 77 })),
      ),
    );
    expect(s.SK2.verdict).toBe('🔴');
    expect(s.SK2.score).toBe(0);
    expect(s.SK2.ieIds).toContain('IE25');
    expect(s.SK2.fixIds.map((f) => f.id)).toContain('F24');
  });
});

// ── SK3 / SK5 honesty guard (no fabricated value) ────────────────────────────

describe('SK3 / SK5 — needs-instrumentation honesty guard', () => {
  it('SK3 is always ⚪ (no embeddings-read signal on the forensic block)', () => {
    const s = byId(scoreSkills(ctx(fullBlock())));
    expect(s.SK3.verdict).toBe('⚪');
    expect(s.SK3.score).toBeNull();
    expect(s.SK3.note).toContain('IE27');
  });

  it('SK5 is ⚪ N/A pre-institution and surfaces the Story 4.2 (+F26) dep', () => {
    const s = byId(scoreSkills(ctx(fullBlock())));
    expect(s.SK5.verdict).toBe('⚪');
    expect(s.SK5.score).toBeNull();
    expect(s.SK5.ieIds).toContain('IE28');
    const fixes = s.SK5.fixIds;
    expect(fixes.find((f) => f.kind === 'story' && f.id === '4.2')).toBeDefined();
    expect(fixes.find((f) => f.id === '4.2')?.dependsOn).toContain('F26');
  });
});

// ── SK4 scout ────────────────────────────────────────────────────────────────

describe('SK4 — scout discovery', () => {
  it('🔴 with IE26→F25 when scout never fired', () => {
    const s = byId(scoreSkills(ctx(fullBlock({ skillScoutRuns: [] }))));
    expect(s.SK4.verdict).toBe('🔴');
    expect(s.SK4.ieIds).toContain('IE26');
    expect(s.SK4.fixIds.map((f) => f.id)).toContain('F25');
  });

  it('🟡 when scout fired but relevance is an Assessor judgment', () => {
    const s = byId(
      scoreSkills(
        ctx(
          fullBlock({
            skillScoutRuns: [
              { jobId: 'j1', trigger: 'plan-open', proposalCount: 2, durationMs: 100 },
            ],
          }),
        ),
      ),
    );
    expect(s.SK4.verdict).toBe('🟡');
    expect(s.SK4.value).toBe(1);
  });
});

// ── SK6 registry self-improvement ────────────────────────────────────────────

describe('SK6 — registry self-improvement', () => {
  it('⚪ when no reflector rows are provided', () => {
    const s = byId(scoreSkills(ctx(fullBlock())));
    expect(s.SK6.verdict).toBe('⚪');
    expect(s.SK6.score).toBeNull();
  });

  it('🔴 with IE29→F28 (canonical IE→Fix map) when reflections present but zero skill-targeted', () => {
    // Note: SK6's §0.6 fixLink column lists F5,F28, but the FixRef authority
    // (ie-to-f-map) resolves IE29 → F28 only (F5 belongs to OV8/IE5; it is the
    // IAM dependency named in the SK6 note, not a fix derived from IE29).
    const s = byId(scoreSkills(ctx(fullBlock(), [{ target: 'project-claude-md' }])));
    expect(s.SK6.verdict).toBe('🔴');
    expect(s.SK6.ieIds).toContain('IE29');
    expect(s.SK6.fixIds.map((f) => f.id)).toContain('F28');
  });

  it('🟡 when ≥1 skill-targeted proposal was written', () => {
    const s = byId(
      scoreSkills(
        ctx(fullBlock(), [
          { target: 'project-skill' },
          { target: 'org-skill' },
          { target: 'agent-persona' },
        ]),
      ),
    );
    expect(s.SK6.verdict).toBe('🟡');
    expect(s.SK6.value).toBe(2);
  });
});
