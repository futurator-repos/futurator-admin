import { describe, it, expect } from 'vitest';
import {
  acceptanceCriterionSchema,
  storyOutputSchema,
  epicOutputSchema,
  verifyIntentSchema,
  manualReasonSchema,
} from '../plan-output-schema';

/**
 * Concept v2 — Story E1.1: AcceptanceCriterion gains optional BDD structure +
 * a PM-set `verify` intent, with `manual` ⇒ `manualReason` enforced. Legacy
 * flat-`text` ACs must still validate (back-compat).
 */
describe('acceptanceCriterionSchema (Concept v2 — E1.1)', () => {
  const baseStory = {
    id: 'S1',
    title: 'A story',
    description: 'A story with enough description to pass.',
    touchPoints: ['src/foo.ts'],
  };

  it('AC1 — accepts BDD structure + a verify intent', () => {
    const result = acceptanceCriterionSchema.safeParse({
      id: 'AC-1',
      text: 'The score increments on collision.',
      needsBrowser: true,
      given: 'a game in playing state',
      when: 'the player collides with a pellet',
      then: 'the score increments by 10',
      thenObservable: 'score increments',
      verify: 'behavior',
    });
    expect(result.success).toBe(true);
  });

  it('AC2 — a manual criterion REQUIRES a manualReason', () => {
    const missing = acceptanceCriterionSchema.safeParse({
      id: 'AC-2',
      text: 'Operator confirms the real Stripe charge succeeds.',
      needsBrowser: false,
      verify: 'manual',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.some((i) => i.path.includes('manualReason'))).toBe(true);
    }

    const present = acceptanceCriterionSchema.safeParse({
      id: 'AC-2',
      text: 'Operator confirms the real Stripe charge succeeds.',
      needsBrowser: false,
      verify: 'manual',
      manualReason: 'real-payment',
    });
    expect(present.success).toBe(true);
  });

  it('AC2 — rejects a manualReason outside the closed enum', () => {
    const result = acceptanceCriterionSchema.safeParse({
      id: 'AC-3',
      text: 'Some manual check.',
      needsBrowser: false,
      verify: 'manual',
      manualReason: 'because-i-said-so',
    });
    expect(result.success).toBe(false);
  });

  it('AC3 — a legacy flat-text criterion still validates (no BDD fields)', () => {
    const result = acceptanceCriterionSchema.safeParse({
      id: 'AC-4',
      text: 'The page renders without errors.',
      needsBrowser: false,
    });
    expect(result.success).toBe(true);
  });

  it('AC3 — needsBrowser defaults to false when omitted', () => {
    const result = acceptanceCriterionSchema.parse({ id: 'AC-5', text: 'Typechecks cleanly.' });
    expect(result.needsBrowser).toBe(false);
  });

  it('flows through storyOutputSchema with enriched criteria', () => {
    const result = storyOutputSchema.safeParse({
      ...baseStory,
      criteria: [
        { id: 'AC-1', text: 'Renders the title.', needsBrowser: true, verify: 'appearance' },
        {
          id: 'AC-2',
          text: 'Manual payment check.',
          verify: 'manual',
          manualReason: 'real-payment',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('a story with a malformed manual criterion is rejected at the story level', () => {
    const result = storyOutputSchema.safeParse({
      ...baseStory,
      criteria: [{ id: 'AC-1', text: 'Manual check, no reason.', verify: 'manual' }],
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Concept v2 — Story E1.2: EpicStory gains userStory/technicalNotes/tasks/
 * references; EpicWorkflow gains goal (already present) + requirementRefs. All
 * optional → legacy plans still validate.
 */
describe('storyOutputSchema BMAD-grade fields (Concept v2 — E1.2)', () => {
  const baseStory = {
    id: 'S1',
    title: 'A story',
    description: 'A story with enough description to pass.',
    touchPoints: ['src/foo.ts'],
    criteria: [{ id: 'AC-1', text: 'Renders.', needsBrowser: false }],
  };

  it('accepts the full BMAD-grade story shape', () => {
    const result = storyOutputSchema.safeParse({
      ...baseStory,
      userStory: { role: 'operator', action: 'see the plan rail', benefit: 'verify the chain' },
      technicalNotes: 'Extend PlanReviewView; reuse existing epics→waves node.',
      tasks: [{ id: 'T1', text: 'Render the rail', acRefs: ['AC-1'] }],
      references: [{ source: 'architecture', section: 'state-model', note: 'routing decisions' }],
    });
    expect(result.success).toBe(true);
  });

  it('back-compat — a story with none of the new fields still validates', () => {
    expect(storyOutputSchema.safeParse(baseStory).success).toBe(true);
  });

  it('rejects a reference with an out-of-enum source', () => {
    const result = storyOutputSchema.safeParse({
      ...baseStory,
      references: [{ source: 'slack', section: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('epicOutputSchema requirementRefs (Concept v2 — E1.2)', () => {
  const baseEpic = {
    id: 'E1',
    title: 'Foundation',
    goal: 'Establish the shared schema both PRDs build on.',
    stories: [
      {
        id: 'S1',
        title: 'A story',
        description: 'A story with enough description to pass.',
        criteria: [{ id: 'AC-1', text: 'Typechecks.', needsBrowser: false }],
      },
    ],
  };

  it('accepts requirementRefs', () => {
    const result = epicOutputSchema.safeParse({ ...baseEpic, requirementRefs: ['FR-1', 'FR-7'] });
    expect(result.success).toBe(true);
  });

  it('back-compat — an epic without requirementRefs still validates', () => {
    expect(epicOutputSchema.safeParse(baseEpic).success).toBe(true);
  });
});

describe('verify/manualReason enums (Concept v2 — E1.1)', () => {
  it('verifyIntentSchema accepts the five intents', () => {
    for (const v of ['build', 'appearance', 'state', 'behavior', 'manual']) {
      expect(verifyIntentSchema.safeParse(v).success).toBe(true);
    }
    expect(verifyIntentSchema.safeParse('smoke').success).toBe(false);
  });

  it('manualReasonSchema accepts exactly the eight locked reasons', () => {
    const reasons = [
      'real-payment',
      'oauth-consent',
      'captcha',
      'native-device',
      'email-sms-loop',
      'subjective-quality',
      'video-audio-perception',
      'no-stub-possible',
    ];
    for (const r of reasons) expect(manualReasonSchema.safeParse(r).success).toBe(true);
    expect(manualReasonSchema.options).toHaveLength(8);
  });
});
