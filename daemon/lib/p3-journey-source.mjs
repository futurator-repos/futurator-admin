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

/**
 * An AC is "observe-shaped" when it is a pure APPEARANCE claim: a rendering /
 * visual-taste observation with NO driving action (`when`). These are the
 * `verify:'appearance'` / `acClass:'advisory-taste'` ACs ("maze walls render on
 * canvas", "HUD shows the score") that `isBrowserShaped` deliberately excludes
 * (no `when`), so they never became a Lane-1/Lane-2 step and sat FAILING forever
 * (qa-false-green forensics). They still need SOMETHING to observe (`then` /
 * `thenObservable`) — a bare tag with no claim isn't judgeable. An observe step
 * has no action and no deterministic assertion; the runner judges its single
 * frame VQA-primary (attention-only, never blocking).
 *
 * Mutually exclusive with `isBrowserShaped`: that predicate REQUIRES `when`,
 * this one REQUIRES its absence — an AC can never be both.
 */
function isObserveShaped(ac) {
  if (!ac) return false;
  if (hasText(ac.when)) return false;
  const isAppearance = ac.verify === 'appearance' || ac.acClass === 'advisory-taste';
  return isAppearance && (hasText(ac.thenObservable) || hasText(ac.then));
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
 * One resolved OBSERVE step: no action, no deterministic assertion — just the
 * AC's appearance claim as the VQA `spec`, plus a settle window before the
 * single "after" frame is captured. `kind:'observe'` is what the executor
 * (browser-probe-executor.mjs) and the runner branch on. `spec` is the AC's own
 * text (the human-readable claim the single-frame judge is asked to confirm).
 */
function toObserveStep(ac) {
  return {
    kind: 'observe',
    acId: ac.id,
    spec: ac.text || ac.thenObservable || ac.then || ac.id,
    settleMs: 1200,
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
    if (!ac) continue;
    if (isBrowserShaped(ac)) {
      // Action step — unchanged (byte-for-byte).
      steps.push(toStep(ac));
    } else if (isObserveShaped(ac)) {
      // ADDITIONALLY: a pure-appearance AC becomes an observe step so it finally
      // gets VQA coverage (the advisory-AC hole). Interleaves in declaration
      // order — harmless, an observe step drives nothing.
      steps.push(toObserveStep(ac));
    }
    // else: neither shape (dangling / build-only) — skipped, as before.
  }
  return steps;
}

/** DERIVE one journey per story that has ≥1 QUALIFYING AC (browser- or
 * observe-shaped). Previously only browser-shaped ACs counted, so a story whose
 * ONLY verifiable ACs are pure-appearance claims produced no journey at all —
 * its visual ACs were structurally invisible to QA. Now such a story still
 * yields a journey (observe steps only). Order preserved (declaration order). */
function deriveJourneys(stories) {
  const journeys = [];
  for (const s of stories || []) {
    const qualifyingAcs = (s?.acceptanceCriteria || []).filter(
      (ac) => isBrowserShaped(ac) || isObserveShaped(ac),
    );
    if (!qualifyingAcs.length) continue;
    journeys.push({
      id: `derived-${s.storyId ?? journeys.length}`,
      title: s.title || s.storyId || 'Untitled story',
      narrative: s.intent,
      acRefs: qualifyingAcs.map((ac) => ac.id),
    });
  }
  return journeys;
}

/**
 * Resolve the delivery journeys Lane 1 should run for this plan. PURE (no I/O).
 *
 * @param {{ plan?: { deliveryJourneys?: Array<{id:string,title:string,narrative?:string,acRefs?:string[]}> },
 *           stories?: Array<{ storyId:string, title?:string, intent?:string, acceptanceCriteria?: Array<{id:string,text?:string,when?:string,thenObservable?:string,then?:string}> }> }} args
 * Each `steps` entry is either an ACTION step (browser-shaped AC:
 * `{acId,label,when,thenObservable?,then?,settle}`) or an OBSERVE step
 * (appearance-only AC: `{kind:'observe',acId,spec,settleMs}`).
 *
 * @returns {Array<{ id:string, title:string, narrative?:string, acRefs:string[],
 *                    steps: Array<({acId:string,label:string,when:string,thenObservable?:string,then?:string,
 *                                  settle:{frames:number,pollMs:number}}
 *                                 |{kind:'observe',acId:string,spec:string,settleMs:number})> }>}
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
