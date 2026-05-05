import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderPmAugmentationPrompt,
  _resetTemplateCache,
} from '../lib/render-pm-augmentation-prompt.mjs';

beforeEach(() => {
  _resetTemplateCache();
});

const APP = {
  appId: 'dino3',
  displayName: 'Dino Runner v3',
  workingDir: '/home/ubuntu/projects/dino3',
};

const PLAN = {
  intent: 'Make dino3 work on mobile devices.',
};

const PRIOR_PLAN = {
  planId: 'p1',
  kind: 'initial',
  iterationLabel: 'v1.0 — first build',
  status: 'delivered',
  intent: 'Build the first version',
  epicIds: ['e1'],
};

describe('renderPmAugmentationPrompt', () => {
  it('substitutes app + plan placeholders', () => {
    const out = renderPmAugmentationPrompt({
      app: APP,
      plan: PLAN,
      priorPlans: [PRIOR_PLAN],
    });

    expect(out).toContain('App named `dino3`');
    expect(out).toContain('appId: dino3');
    expect(out).toContain('displayName: Dino Runner v3');
    expect(out).toContain('workingDir: /home/ubuntu/projects/dino3');
    expect(out).toContain('Make dino3 work on mobile devices');
    expect(out).toContain('priorPlans: 1');
  });

  it('renders prior Plans in the prior-plans section', () => {
    const out = renderPmAugmentationPrompt({
      app: APP,
      plan: PLAN,
      priorPlans: [PRIOR_PLAN],
    });
    expect(out).toContain('Plan #1');
    expect(out).toContain('initial');
    expect(out).toContain('v1.0 — first build');
    expect(out).toContain('delivered');
    expect(out).toContain('Build the first version');
  });

  it('renders multiple prior Plans in chronological order', () => {
    const out = renderPmAugmentationPrompt({
      app: APP,
      plan: PLAN,
      priorPlans: [
        PRIOR_PLAN,
        { ...PRIOR_PLAN, planId: 'p2', kind: 'change', iterationLabel: 'v1.1 — first refinement' },
      ],
    });
    const idx1 = out.indexOf('Plan #1');
    const idx2 = out.indexOf('Plan #2');
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('renders epic + story breakdown when epicsByPlanId is provided', () => {
    const epicsByPlanId = {
      e1: {
        epicId: 'e1',
        planId: 'p1',
        title: 'Mobile responsiveness pass',
        stories: [
          {
            storyId: 's1',
            title: 'Replace keyboard input',
            acceptanceCriteria: ['Tap left moves left', 'Tap right moves right'],
          },
        ],
      },
    };
    const out = renderPmAugmentationPrompt({
      app: APP,
      plan: PLAN,
      priorPlans: [PRIOR_PLAN],
      epicsByPlanId,
    });

    expect(out).toContain('Mobile responsiveness pass');
    expect(out).toContain('Replace keyboard input');
    expect(out).toContain('AC: Tap left moves left');
  });

  it('throws when app missing', () => {
    expect(() =>
      renderPmAugmentationPrompt({
        app: { displayName: 'x' },
        plan: PLAN,
        priorPlans: [PRIOR_PLAN],
      }),
    ).toThrow();
  });

  it('throws when plan.intent missing', () => {
    expect(() =>
      renderPmAugmentationPrompt({ app: APP, plan: {}, priorPlans: [PRIOR_PLAN] }),
    ).toThrow();
  });

  it('throws when priorPlans is empty (a non-initial Plan must follow at least one)', () => {
    expect(() =>
      renderPmAugmentationPrompt({ app: APP, plan: PLAN, priorPlans: [] }),
    ).toThrow();
  });
});
