import { describe, it, expect } from 'vitest';
import { runSolutioningGate, type GateInput } from '../solutioning-gate';

// Minimal plan+epic with one story carrying one NON-test-shaped AC (bare prose,
// no SHALL/MUST, no GWT) plus a valid BDD AC so the story passes other checks.
function inputWith(severity: GateInput['acShapeSeverity'], rigor: 'mvp' | 'production'): GateInput {
  return {
    plan: { rigor, conceptPlan: undefined },
    epics: [
      {
        epicId: 'E1',
        dependsOnEpics: [],
        stories: [
          {
            storyId: 'S1',
            userStory: { role: 'u', action: 'a', benefit: 'b' },
            criteria: [
              {
                id: 'AC-1',
                text: 'When x, then y',
                given: '',
                when: 'x',
                then: 'y',
                needsBrowser: false,
              },
              { id: 'AC-2', text: 'it should feel fast', needsBrowser: false }, // NOT test-shaped
            ],
          },
        ],
      },
    ] as unknown as GateInput['epics'],
    acShapeSeverity: severity,
  };
}

describe('AC-shape severity knob (W1.3)', () => {
  it('default (condition) surfaces the un-shaped AC as a non-blocking condition — never an error', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const r = runSolutioningGate(inputWith(undefined, rigor));
      expect(r.conditions.some((c) => /AC-2 is not test-shaped/.test(c))).toBe(true);
      expect(r.errors.some((e) => /AC-2 is not test-shaped/.test(e))).toBe(false);
      expect(r.blocks).toBe(false);
    }
  });

  it('scaled promotes to an ERROR (blocks) at production, stays a condition at mvp', () => {
    const mvp = runSolutioningGate(inputWith('scaled', 'mvp'));
    expect(mvp.conditions.some((c) => /AC-2 is not test-shaped/.test(c))).toBe(true);
    expect(mvp.errors.some((e) => /AC-2 is not test-shaped/.test(e))).toBe(false);

    const prod = runSolutioningGate(inputWith('scaled', 'production'));
    expect(prod.errors.some((e) => /AC-2 is not test-shaped/.test(e))).toBe(true);
    expect(prod.blocks).toBe(true);
  });
});
