// p3-journey-source — resolves WHICH delivery journeys Lane 1 (deterministic
// probe driver, browser-probe-executor.mjs) runs against a plan's dev URL
// (QA-Review W2, functions/shared/types/qa-review-p3.ts JourneyResult).
//
// Two sources, PM-preferred:
//   1. Stage-C `plan.deliveryJourneys` (functions/shared/types/plan.ts) — the PM
//      curated the end-to-end paths worth verifying. Used verbatim when present.
//   2. DERIVED fallback — one journey per StoryNodeRow (daemon/pipelines/lib/
//      quick-planspec.mjs buildStoryNodeRows) that has ≥1 browser-shaped
//      acceptanceCriterion (a `when` + observable-assertion pair), so a plan
//      with no PM-authored journeys still gets Lane-1 coverage.
//
// Either way, every journey's `acRefs` are resolved against the plan's stories
// into `steps` carrying the AC's own `when`/`thenObservable`/`then` prose —
// literally spreadable into browser-probe-executor.mjs `parseProbe({ when,
// thenObservable, then })` (see that file ~:85) without any further rewriting.
// This module does NOT parse the prose or touch a browser; it is pure
// resolution. No journeys resolvable (neither source) → `[]` (honesty
// contract: Lane 1 has nothing to assert, never a fabricated pass).

/** True iff `s` is a non-empty string. */
function hasText(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * An AC is "browser-shaped" when it carries an action (`when`) AND something
 * to observe afterward (`thenObservable`, falling back to `then` — the same
 * fallback chain `parseProbe`'s `assertSrc` uses).
 */
function isBrowserShaped(ac) {
  if (!ac) return false;
  return hasText(ac.when) && (hasText(ac.thenObservable) || hasText(ac.then));
}

/** Build an AC-id → AC lookup across every story (dangling acRefs resolve to `undefined`). */
function buildAcIndex(stories) {
  const idx = new Map();
  for (const s of stories || []) {
    for (const ac of s?.acceptanceCriteria || []) {
      if (ac?.id) idx.set(ac.id, ac);
    }
  }
  return idx;
}

/**
 * A per-step SETTLE hint derived from the AC's `verify` intent (DATA-only — no
 * I/O; the browser-probe executor consumes it, absent → executor default).
 * A `behavior` AC (a rAF/game loop where the observable change arrives over
 * several animation frames) needs a longer rAF settle + a longer poll window
 * than a `state`/`appearance` AC whose change lands in ~1 frame. This is the
 * calibration that stops VQA/deterministic false-negatives on a WORKING canvas
 * game: give the game time to integrate the input before reading the snapshot.
 */
function settleFor(ac) {
  return (ac?.verify === 'behavior') ? { frames: 12, pollMs: 1200 } : { frames: 2, pollMs: 300 };
}

/** One resolved step: the AC's own prose, ready to spread into `parseProbe`. */
function toStep(ac) {
  return {
    acId: ac.id,
    label: ac.text || ac.id,
    when: ac.when,
    thenObservable: ac.thenObservable,
    then: ac.then,
    settle: settleFor(ac),
  };
}

/**
 * Resolve a journey's `acRefs` into probe-ready `steps`. ACs that don't
 * resolve (dangling ref) or aren't browser-shaped are skipped rather than
 * failing the whole journey — a partially-resolvable journey still runs its
 * resolvable steps; the honesty contract lives in the probe driver (an
 * unresolvable AC never fakes a pass), not here.
 *
 * STEP ORDER IS LOAD-BEARING: the resolved steps preserve `acRefs` order (which
 * the derived path keeps in AC declaration order). The driver replays steps in
 * sequence against a SINGLE live page, so a "press Space to start" AC MUST
 * precede a "move the player" AC — reordering would drive the game out of order
 * (move before start) and fabricate a failure. Never sort or dedupe here.
 */
function resolveSteps(acRefs, acIndex) {
  const steps = [];
  for (const ref of acRefs || []) {
    const ac = acIndex.get(ref);
    if (!ac || !isBrowserShaped(ac)) continue;
    steps.push(toStep(ac));
  }
  return steps;
}

/** DERIVE one journey per story that has ≥1 browser-shaped AC. */
function deriveJourneys(stories) {
  const journeys = [];
  for (const s of stories || []) {
    const browserAcs = (s?.acceptanceCriteria || []).filter(isBrowserShaped);
    if (!browserAcs.length) continue;
    journeys.push({
      id: `derived-${s.storyId ?? journeys.length}`,
      title: s.title || s.storyId || 'Untitled story',
      narrative: s.intent,
      acRefs: browserAcs.map((ac) => ac.id),
    });
  }
  return journeys;
}

/**
 * Resolve the delivery journeys Lane 1 should run for this plan. PURE (no I/O).
 *
 * @param {{ plan?: { deliveryJourneys?: Array<{id:string,title:string,narrative?:string,acRefs?:string[]}> },
 *           stories?: Array<{ storyId:string, title?:string, intent?:string, acceptanceCriteria?: Array<{id:string,text?:string,when?:string,thenObservable?:string,then?:string}> }> }} args
 * @returns {Array<{ id:string, title:string, narrative?:string, acRefs:string[],
 *                    steps: Array<{acId:string,label:string,when:string,thenObservable?:string,then?:string,
 *                                  settle:{frames:number,pollMs:number}}> }>}
 */
export function resolveJourneys({ plan, stories } = {}) {
  const provided = Array.isArray(plan?.deliveryJourneys) ? plan.deliveryJourneys : [];
  const journeys = provided.length ? provided : deriveJourneys(stories);
  if (!journeys.length) return [];

  const acIndex = buildAcIndex(stories);
  return journeys.map((j) => ({
    id: j?.id ?? '',
    title: j?.title ?? '',
    narrative: j?.narrative,
    acRefs: Array.isArray(j?.acRefs) ? j.acRefs : [],
    steps: resolveSteps(j?.acRefs, acIndex),
  }));
}
