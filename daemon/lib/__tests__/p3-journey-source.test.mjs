import { describe, it, expect } from 'vitest';
import { resolveJourneys } from '../p3-journey-source.mjs';
import { parseProbe } from '../browser-probe-executor.mjs';

// A story shaped like buildStoryNodeRows' output (daemon/pipelines/lib/quick-planspec.mjs).
function story(overrides = {}) {
  return {
    storyId: 's1',
    title: 'Wire game loop',
    intent: 'Press Space to run the game and observe score increase.',
    acceptanceCriteria: [
      {
        id: 's1-ac1',
        text: 'Pressing Space starts the run and score increases',
        when: 'The user presses Space and 2 seconds of game time elapse',
        thenObservable: "snapshot.status equals 'running' and snapshot.score is greater than 0",
        verify: 'behavior',
        needsBrowser: true,
      },
      {
        id: 's1-ac2',
        text: 'Build compiles cleanly',
        verify: 'build',
      },
    ],
    ...overrides,
  };
}

describe('resolveJourneys', () => {
  it('uses plan.deliveryJourneys verbatim (id/title/acRefs) when present, resolving acRefs into probe-ready steps', () => {
    const plan = {
      deliveryJourneys: [
        { id: 'j1', title: 'Play a full run', narrative: 'user plays the game', acRefs: ['s1-ac1'] },
      ],
    };
    const stories = [story()];
    const journeys = resolveJourneys({ plan, stories });

    expect(journeys).toHaveLength(1);
    expect(journeys[0].id).toBe('j1');
    expect(journeys[0].title).toBe('Play a full run');
    expect(journeys[0].acRefs).toEqual(['s1-ac1']);
    expect(journeys[0].steps).toHaveLength(1);
    expect(journeys[0].steps[0]).toMatchObject({
      acId: 's1-ac1',
      when: 'The user presses Space and 2 seconds of game time elapse',
      thenObservable: "snapshot.status equals 'running' and snapshot.score is greater than 0",
    });

    // The resolved step must be directly consumable by parseProbe, unmodified.
    const parsed = parseProbe(journeys[0].steps[0]);
    expect(parsed.interpretable).toBe(true);
    expect(parsed.actions).toEqual([
      { type: 'key', key: 'Space' },
      { type: 'wait', ms: 2000 },
    ]);
    expect(parsed.assertions).toEqual([
      { field: 'status', op: 'eq', value: 'running' },
      { field: 'score', op: 'gt', value: 0 },
    ]);
  });

  it('skips a plan-provided acRef that does not resolve to a browser-shaped AC (dangling or build-only), without dropping the journey', () => {
    const plan = {
      deliveryJourneys: [{ id: 'j1', title: 'Mixed refs', acRefs: ['s1-ac1', 's1-ac2', 'does-not-exist'] }],
    };
    const stories = [story()];
    const journeys = resolveJourneys({ plan, stories });

    expect(journeys).toHaveLength(1);
    expect(journeys[0].acRefs).toEqual(['s1-ac1', 's1-ac2', 'does-not-exist']);
    expect(journeys[0].steps).toHaveLength(1);
    expect(journeys[0].steps[0].acId).toBe('s1-ac1');
  });

  it('derives one journey per story from browser-shaped acceptanceCriteria when plan has no deliveryJourneys', () => {
    const stories = [story(), story({ storyId: 's2', title: 'Second story', acceptanceCriteria: [
      {
        id: 's2-ac1',
        text: 'Forcing game over shows the over state',
        when: "The harness forces status to 'over'",
        thenObservable: "snapshot.status equals 'over' and snapshot.gameOver is true",
        verify: 'behavior',
        needsBrowser: true,
      },
    ] })];

    const journeys = resolveJourneys({ plan: {}, stories });

    expect(journeys).toHaveLength(2);
    expect(journeys[0].id).toBe('derived-s1');
    expect(journeys[0].title).toBe('Wire game loop');
    expect(journeys[0].acRefs).toEqual(['s1-ac1']);
    expect(journeys[0].steps).toHaveLength(1);

    expect(journeys[1].id).toBe('derived-s2');
    expect(journeys[1].acRefs).toEqual(['s2-ac1']);
    expect(journeys[1].steps[0]).toMatchObject({
      acId: 's2-ac1',
      when: "The harness forces status to 'over'",
      thenObservable: "snapshot.status equals 'over' and snapshot.gameOver is true",
    });

    const parsed = parseProbe(journeys[1].steps[0]);
    expect(parsed.interpretable).toBe(true);
  });

  it('derivation skips a story with no browser-shaped ACs (build-only story never becomes a journey)', () => {
    const buildOnlyStory = {
      storyId: 's3',
      title: 'Types and constants',
      acceptanceCriteria: [{ id: 's3-ac1', text: 'Types compile', verify: 'build' }],
    };
    const journeys = resolveJourneys({ plan: {}, stories: [buildOnlyStory] });
    expect(journeys).toEqual([]);
  });

  it('returns [] when neither plan.deliveryJourneys nor any story has browser-shaped ACs', () => {
    expect(resolveJourneys({ plan: {}, stories: [] })).toEqual([]);
    expect(resolveJourneys({ plan: undefined, stories: undefined })).toEqual([]);
    expect(resolveJourneys({})).toEqual([]);
  });

  it('returns [] when plan.deliveryJourneys is an empty array (falls through to derive, which also yields none)', () => {
    const journeys = resolveJourneys({ plan: { deliveryJourneys: [] }, stories: [] });
    expect(journeys).toEqual([]);
  });

  it('sets a per-step settle hint from the AC verify intent (behavior=long rAF/poll, else short)', () => {
    const stories = [
      {
        storyId: 's1',
        title: 'Mixed verify',
        acceptanceCriteria: [
          { id: 'behav', text: 'moves over frames', when: 'holds ArrowRight', thenObservable: 'snapshot.x increases', verify: 'behavior' },
          { id: 'statey', text: 'toggles a flag', when: 'clicks "Pause"', thenObservable: 'snapshot.paused is true', verify: 'state' },
        ],
      },
    ];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['behav', 'statey'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    // Order preserved (load-bearing) + settle scaled by verify.
    expect(journey.steps.map((s) => s.acId)).toEqual(['behav', 'statey']);
    expect(journey.steps[0].settle).toEqual({ frames: 12, pollMs: 1200 });
    expect(journey.steps[1].settle).toEqual({ frames: 2, pollMs: 300 });
  });

  it('derives a SINGLE journey per story with multiple browser-shaped ACs, steps in AC order', () => {
    const stories = [
      {
        storyId: 's1',
        title: 'Play a run',
        acceptanceCriteria: [
          { id: 'start', text: 'start', when: 'presses Space', thenObservable: "snapshot.status equals 'running'", verify: 'behavior' },
          { id: 'move', text: 'move', when: 'presses ArrowRight', thenObservable: 'snapshot.x increases', verify: 'behavior' },
          { id: 'score', text: 'score', when: 'eats a pellet', thenObservable: 'snapshot.score increases', verify: 'behavior' },
        ],
      },
    ];
    const journeys = resolveJourneys({ plan: {}, stories });
    expect(journeys).toHaveLength(1);
    expect(journeys[0].steps.map((s) => s.acId)).toEqual(['start', 'move', 'score']);
  });
});
