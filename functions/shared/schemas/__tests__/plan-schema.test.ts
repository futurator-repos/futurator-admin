import { describe, it, expect } from 'vitest';
import {
  PLAN_NAME_REGEX,
  planNameSchema,
  planExecutionModeSchema,
  planRigorSchema,
  planStatusSchema,
  planKindSchema,
  PLAN_LEGAL_TRANSITIONS,
  planCreateInputSchema,
  planPatchSchema,
  createPlanForAppInputSchema,
  updatePlanV1Schema,
} from '../plan-schema';

describe('PLAN_NAME_REGEX (legacy)', () => {
  it('accepts kebab-case starting with a letter', () => {
    expect(PLAN_NAME_REGEX.test('dino3')).toBe(true);
    expect(PLAN_NAME_REGEX.test('brick-breaker')).toBe(true);
  });

  it('rejects names that start with a digit or hyphen', () => {
    expect(PLAN_NAME_REGEX.test('3dino')).toBe(false);
    expect(PLAN_NAME_REGEX.test('-dino')).toBe(false);
  });
});

describe('planNameSchema', () => {
  it('returns helpful error message on invalid name', () => {
    const result = planNameSchema.safeParse('UPPER');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('kebab-case');
    }
  });
});

describe('planStatusSchema (App/Plan v1 + legacy)', () => {
  it('accepts the v1 statuses', () => {
    for (const s of ['concept', 'developing', 'review', 'delivered', 'abandoned']) {
      expect(planStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('accepts the legacy statuses for backward compat', () => {
    expect(planStatusSchema.safeParse('fixing').success).toBe(true);
    expect(planStatusSchema.safeParse('archived').success).toBe(true);
  });

  it('rejects unknown statuses', () => {
    expect(planStatusSchema.safeParse('').success).toBe(false);
    expect(planStatusSchema.safeParse('done').success).toBe(false);
  });
});

describe('planKindSchema', () => {
  it('accepts the three kinds', () => {
    expect(planKindSchema.safeParse('initial').success).toBe(true);
    expect(planKindSchema.safeParse('change').success).toBe(true);
    expect(planKindSchema.safeParse('experiment').success).toBe(true);
  });

  it('rejects unknown kinds', () => {
    expect(planKindSchema.safeParse('refinement').success).toBe(false);
    expect(planKindSchema.safeParse('').success).toBe(false);
  });
});

describe('PLAN_LEGAL_TRANSITIONS', () => {
  it('allows concept → developing/abandoned', () => {
    expect(PLAN_LEGAL_TRANSITIONS.concept).toContain('developing');
    expect(PLAN_LEGAL_TRANSITIONS.concept).toContain('abandoned');
  });

  it('allows developing → review/abandoned', () => {
    expect(PLAN_LEGAL_TRANSITIONS.developing).toContain('review');
    expect(PLAN_LEGAL_TRANSITIONS.developing).toContain('abandoned');
  });

  it('allows review → delivered/developing/abandoned', () => {
    expect(PLAN_LEGAL_TRANSITIONS.review).toContain('delivered');
    expect(PLAN_LEGAL_TRANSITIONS.review).toContain('developing');
    expect(PLAN_LEGAL_TRANSITIONS.review).toContain('abandoned');
  });

  it('treats delivered + abandoned as terminal (App/Plan v1)', () => {
    expect(PLAN_LEGAL_TRANSITIONS.delivered).toEqual([]);
    expect(PLAN_LEGAL_TRANSITIONS.abandoned).toEqual([]);
  });

  it('rejects illegal transitions: delivered cannot go anywhere', () => {
    // Iterate via a new Plan on the same App, not by un-delivering.
    expect(PLAN_LEGAL_TRANSITIONS.delivered.length).toBe(0);
  });
});

describe('planExecutionModeSchema', () => {
  it('accepts the two modes', () => {
    expect(planExecutionModeSchema.safeParse('pipeline').success).toBe(true);
    expect(planExecutionModeSchema.safeParse('orchestrator').success).toBe(true);
  });
});

describe('planRigorSchema', () => {
  it('accepts the three rigor levels', () => {
    expect(planRigorSchema.safeParse('prototype').success).toBe(true);
    expect(planRigorSchema.safeParse('mvp').success).toBe(true);
    expect(planRigorSchema.safeParse('production').success).toBe(true);
  });
});

describe('planCreateInputSchema (legacy)', () => {
  it('accepts a minimal legacy create', () => {
    expect(
      planCreateInputSchema.safeParse({
        name: 'dino3',
        intent: 'Build a dino runner game',
      }).success,
    ).toBe(true);
  });

  it('rejects intent shorter than 10 chars', () => {
    expect(
      planCreateInputSchema.safeParse({ name: 'dino3', intent: 'short' }).success,
    ).toBe(false);
  });
});

describe('planPatchSchema (legacy)', () => {
  it('accepts a single-field patch', () => {
    expect(planPatchSchema.safeParse({ displayName: 'New' }).success).toBe(true);
  });

  it('accepts an empty patch', () => {
    expect(planPatchSchema.safeParse({}).success).toBe(true);
  });
});

describe('createPlanForAppInputSchema (App/Plan v1)', () => {
  it('accepts a minimal v1 create', () => {
    expect(
      createPlanForAppInputSchema.safeParse({
        kind: 'change',
        intent: 'Make dino3 work on mobile devices',
      }).success,
    ).toBe(true);
  });

  it('accepts an initial-kind create', () => {
    expect(
      createPlanForAppInputSchema.safeParse({
        kind: 'initial',
        intent: 'Build the first version of the app',
      }).success,
    ).toBe(true);
  });

  it('rejects intent under 10 chars', () => {
    expect(
      createPlanForAppInputSchema.safeParse({ kind: 'change', intent: 'too short' })
        .success,
    ).toBe(false);
  });

  it('rejects intent over 2000 chars', () => {
    expect(
      createPlanForAppInputSchema.safeParse({
        kind: 'change',
        intent: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown kind', () => {
    expect(
      createPlanForAppInputSchema.safeParse({
        kind: 'refinement',
        intent: 'Add mobile support to the app',
      }).success,
    ).toBe(false);
  });
});

describe('updatePlanV1Schema', () => {
  it('accepts an empty update', () => {
    expect(updatePlanV1Schema.safeParse({}).success).toBe(true);
  });

  it('accepts iterationLabel update', () => {
    expect(
      updatePlanV1Schema.safeParse({ iterationLabel: 'v1.1 — mobile pass' })
        .success,
    ).toBe(true);
  });

  it('accepts noTouchPaths array', () => {
    expect(
      updatePlanV1Schema.safeParse({
        noTouchPaths: ['src/game/physics.ts', 'src/game/sprites/**'],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      updatePlanV1Schema.safeParse({ unknownField: 'x' }).success,
    ).toBe(false);
    expect(
      updatePlanV1Schema.safeParse({ kind: 'change' }).success,
    ).toBe(false);
  });

  it('rejects intent under 10 chars', () => {
    expect(updatePlanV1Schema.safeParse({ intent: 'short' }).success).toBe(false);
  });
});
