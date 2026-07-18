import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJourneys } from '../p3-journey-source.mjs';

// SLICE A1 (design Q1) — observe-only journey steps. These cover the
// appearance-AC hole: a pure-appearance/advisory-taste AC (no `when`) must now
// resolve into a `{kind:'observe'}` step and a story whose ONLY qualifying ACs
// are observe-shaped must still produce a derived journey.

// An appearance AC as authored by quick-planspec.mjs acClassOf(): verify
// 'appearance', acClass 'advisory-taste', a `then`/`thenObservable` claim, NO `when`.
function appearanceAc(overrides = {}) {
  return {
    id: 'obs-ac1',
    text: 'The maze walls render on the canvas',
    thenObservable: 'the blue maze walls are visible on the canvas',
    verify: 'appearance',
    acClass: 'advisory-taste',
    ...overrides,
  };
}

// A browser-shaped action AC (has `when` + observable) — unchanged behavior.
function actionAc(overrides = {}) {
  return {
    id: 'act-ac1',
    text: 'Pressing Space starts the run',
    when: 'The user presses Space',
    thenObservable: "snapshot.status equals 'running'",
    verify: 'behavior',
    ...overrides,
  };
}

describe('resolveJourneys — observe steps (PM-provided journeys)', () => {
  it('emits an observe step for an appearance AC (verify:appearance, then, no when)', () => {
    const stories = [{ storyId: 's1', title: 'Render maze', acceptanceCriteria: [appearanceAc()] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'Look at maze', acRefs: ['obs-ac1'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.equal(journey.steps.length, 1);
    assert.deepEqual(journey.steps[0], {
      kind: 'observe',
      acId: 'obs-ac1',
      spec: 'The maze walls render on the canvas',
      settleMs: 1200,
    });
  });

  it('emits an observe step for an advisory-taste AC even when verify is not "appearance"', () => {
    const ac = appearanceAc({ id: 'taste1', verify: 'taste', acClass: 'advisory-taste', text: 'HUD looks polished' });
    const stories = [{ storyId: 's1', acceptanceCriteria: [ac] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['taste1'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.equal(journey.steps.length, 1);
    assert.partialDeepStrictEqual(journey.steps[0], { kind: 'observe', acId: 'taste1', spec: 'HUD looks polished' });
  });

  it('falls back spec to thenObservable/then/id when the AC has no text', () => {
    const ac = appearanceAc({ id: 'obsX', text: undefined, thenObservable: undefined, then: 'sprites are pixel-art' });
    const stories = [{ storyId: 's1', acceptanceCriteria: [ac] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['obsX'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.equal(journey.steps[0].spec, 'sprites are pixel-art');
  });

  it('does NOT emit an observe step for an appearance AC that ALSO has a `when` (that is a browser-shaped action step, unchanged)', () => {
    // verify:appearance but with a `when` → still isBrowserShaped, an ACTION step,
    // never an observe step. Byte-for-byte the old action-step shape.
    const ac = { id: 'mixed', text: 'clicking reveals the panel', when: 'the user clicks "Show"', thenObservable: "snapshot.open is true", verify: 'appearance' };
    const stories = [{ storyId: 's1', acceptanceCriteria: [ac] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['mixed'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.equal(journey.steps.length, 1);
    assert.equal(journey.steps[0].kind, undefined); // action step, not observe
    assert.partialDeepStrictEqual(journey.steps[0], { acId: 'mixed', when: 'the user clicks "Show"' });
  });

  it('does NOT emit a step for an appearance AC with no observable claim (no then / thenObservable)', () => {
    const ac = { id: 'bare', text: 'looks nice', verify: 'appearance', acClass: 'advisory-taste' };
    const stories = [{ storyId: 's1', acceptanceCriteria: [ac] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['bare'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.deepEqual(journey.steps, []);
  });

  it('does NOT emit an observe step for a plain non-appearance AC with no when (e.g. build-only) — must stay excluded', () => {
    const ac = { id: 'build1', text: 'types compile', then: 'the build is green', verify: 'build' };
    const stories = [{ storyId: 's1', acceptanceCriteria: [ac] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['build1'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.deepEqual(journey.steps, []);
  });

  it('preserves declaration order across mixed action + observe ACs (action step shape unchanged)', () => {
    const start = actionAc({ id: 'start' });
    const render = appearanceAc({ id: 'render', text: 'maze renders' });
    const stories = [{ storyId: 's1', acceptanceCriteria: [start, render] }];
    const plan = { deliveryJourneys: [{ id: 'j1', title: 'J', acRefs: ['start', 'render'] }] };
    const [journey] = resolveJourneys({ plan, stories });
    assert.deepEqual(journey.steps.map((s) => s.acId), ['start', 'render']);
    // action step is byte-for-byte the old shape (no `kind`, carries when/settle).
    assert.equal(journey.steps[0].kind, undefined);
    assert.partialDeepStrictEqual(journey.steps[0], { acId: 'start', when: 'The user presses Space' });
    assert.deepEqual(journey.steps[0].settle, { frames: 12, pollMs: 1200 });
    // observe step second.
    assert.partialDeepStrictEqual(journey.steps[1], { kind: 'observe', acId: 'render' });
  });
});

describe('resolveJourneys — observe steps (derived journeys)', () => {
  it('derives a journey for a story whose ONLY qualifying ACs are observe-shaped (previously dropped)', () => {
    const stories = [
      {
        storyId: 's-visual',
        title: 'Render the board',
        intent: 'the board renders',
        acceptanceCriteria: [
          appearanceAc({ id: 'v1', text: 'walls render' }),
          appearanceAc({ id: 'v2', text: 'pellets render' }),
          { id: 'b1', text: 'compiles', verify: 'build' }, // non-qualifying
        ],
      },
    ];
    const journeys = resolveJourneys({ plan: {}, stories });
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].id, 'derived-s-visual');
    assert.deepEqual(journeys[0].acRefs, ['v1', 'v2']);
    assert.deepEqual(journeys[0].steps.map((s) => s.kind), ['observe', 'observe']);
    assert.deepEqual(journeys[0].steps.map((s) => s.acId), ['v1', 'v2']);
  });

  it('derived journey mixes action + observe ACs (both qualify), in declaration order', () => {
    const stories = [
      {
        storyId: 's-mixed',
        title: 'Play + look',
        acceptanceCriteria: [actionAc({ id: 'a1' }), appearanceAc({ id: 'o1' })],
      },
    ];
    const journeys = resolveJourneys({ plan: {}, stories });
    assert.equal(journeys.length, 1);
    assert.deepEqual(journeys[0].acRefs, ['a1', 'o1']);
    assert.equal(journeys[0].steps[0].kind, undefined); // action
    assert.equal(journeys[0].steps[1].kind, 'observe');
  });

  it('still drops a story with neither action nor observe ACs (pure build-only)', () => {
    const stories = [{ storyId: 's3', acceptanceCriteria: [{ id: 'x', text: 'types', verify: 'build' }] }];
    assert.deepEqual(resolveJourneys({ plan: {}, stories }), []);
  });
});
