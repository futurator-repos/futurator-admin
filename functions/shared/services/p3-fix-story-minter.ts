// p3-fix-story-minter — turn a blocking QA verdict into fix stories (QA-Review W2).
//
// When the deployed-app QA Review FAILs (a journey assertion fails, a VQA judge
// returns a real fail, or the wiring check finds runtime orphans), we don't just
// report — we mint new StoryNodeRows onto the SAME plan branch so the dev
// pipeline re-wires the app, re-deploys, and QA re-runs against the fresh commit.
// This closes the loop that unit-TDD alone can't (the pacman3 class: green units,
// broken assembled app).
//
// PURE: returns rows; the API endpoint persists them + flips the plan to 'fixing'.
// Deterministic ids so a re-mint of the same verdict is idempotent (same ids).

import type { Plan } from '../types/plan';
import type { StoryNodeRow, BoundAcceptanceCriterion } from '../types/plan-spec';
import type { P3QaVerdict } from '../types/qa-review-p3';

/** Short stable hash for deterministic story ids (no crypto needed). */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 8);
}

interface Finding {
  kind: 'journey' | 'vqa' | 'wiring';
  title: string;
  intent: string;
  acText: string;
  /** Files the fix should touch (globs). Wiring orphans give concrete files. */
  touches: string[];
}

/** True iff any failed step's detail names the missing-__harness disease. */
function seamNotMounted(verdict: P3QaVerdict): boolean {
  return (verdict.journeys || []).some((j) =>
    (j.steps || []).some(
      (s) => !s.deterministic?.passed && /seam not mounted/i.test(s.deterministic?.detail ?? ''),
    ),
  );
}

/** Extract the blocking findings from a verdict (only blockers become stories). */
function blockingFindings(verdict: P3QaVerdict, seamHook?: string): Finding[] {
  const out: Finding[] = [];

  // The seam is the FIRST fix: when window.__harness never mounts, every
  // journey fails for the same root cause. Mint ONE dedicated story with the
  // exact wiring contract (the pacman3 forensic: the scaffold's seam hook
  // publishes the seam, but a dev who hand-rolls their own state container
  // bypasses it — dead code, no seam, all probes blind). `seamHook` is
  // BOILERPLATE METADATA (registry testHarness.seamHook) passed by the caller —
  // never a pipeline constant.
  if (seamNotMounted(verdict)) {
    const hook = seamHook || 'the scaffold seam hook named in SCAFFOLD.md';
    out.push({
      kind: 'wiring',
      title: 'Mount the window.__harness test seam',
      intent:
        'QA cannot verify this app: window.__harness never mounts in the running build. ' +
        `The scaffold already ships the seam — ${hook} publishes ` +
        "window.__harness = { ready:true, snapshot(), dispatch, forceStatus, events } when NEXT_PUBLIC_TEST_HARNESS==='1'. " +
        `FIX: route the live app state through ${hook} (replace any hand-rolled useReducer/useState/store for the app's primary state ` +
        'with the scaffold hook — same reducer, same initial state, seam publishes automatically). ' +
        'Do NOT write a new harness; wire the existing one (see SCAFFOLD.md).',
      acText:
        "With NEXT_PUBLIC_TEST_HARNESS='1', the running app exposes window.__harness with ready:true and a snapshot() function returning the live app state (status and domain fields).",
      touches: ['src/**'],
    });
  }

  for (const j of verdict.journeys || []) {
    if (j.verdict !== 'fail') continue;
    // When the seam never mounted, every journey fails for that ONE root cause —
    // minting a story per journey would be redundant noise (the seam story's
    // re-QA re-verifies them all). Only mint journey stories for failures that
    // are NOT the seam disease.
    const nonSeamFailures = j.steps.filter(
      (s) =>
        s.deterministic &&
        !s.deterministic.passed &&
        !/seam not mounted/i.test(s.deterministic.detail ?? ''),
    );
    if (nonSeamFailures.length === 0 && seamNotMounted(verdict)) continue;
    const failedStep =
      nonSeamFailures[0] ?? j.steps.find((s) => s.deterministic && !s.deterministic.passed);
    out.push({
      kind: 'journey',
      title: `Fix journey: ${j.title}`,
      intent: `The delivery journey "${j.title}" failed against the assembled app${
        failedStep
          ? `: ${failedStep.deterministic.assertion} — ${failedStep.deterministic.detail}`
          : ''
      }. Wire the feature so the journey passes end-to-end in the running app.`,
      acText: failedStep
        ? `When ${failedStep.action}, then ${failedStep.deterministic.assertion} (verified against window.__harness.snapshot in the deployed app).`
        : `The journey "${j.title}" passes end-to-end in the deployed app.`,
      touches: ['src/**'],
    });
  }

  for (const v of verdict.vqa || []) {
    if (v.verdict !== 'fail') continue;
    out.push({
      kind: 'vqa',
      title: `Fix visuals: ${v.stepLabel}`,
      intent: `The VQA judge failed the "${v.stepLabel}" step: ${v.rationale}. Correct the rendering so the before/after frames match the spec.`,
      acText: `The "${v.stepLabel}" screen renders per the spec (not a placeholder): ${v.rationale}`,
      touches: ['src/**'],
    });
  }

  const orphans = verdict.wiring?.orphanModules || [];
  if (verdict.wiring?.blocking && orphans.length > 0) {
    out.push({
      kind: 'wiring',
      title: `Wire orphaned modules into the assembled app`,
      intent: `These modules were built but are never imported by the running app (dead code the assemble step orphaned): ${orphans.join(
        ', ',
      )}. Import + integrate them into the rendered component tree so their behavior actually runs.`,
      acText: `Every built module is reachable from the app entry: ${orphans.join(
        ', ',
      )} are imported and their exports used in the rendered tree (0 runtime orphans).`,
      touches: orphans.length ? orphans : ['src/**'],
    });
  }

  return out;
}

/**
 * Mint fix StoryNodeRows from a blocking QA verdict. One story per blocking
 * finding. Each carries a browser-verify AC so the RE-RUN QA has a probe. Rows
 * are 'ready' (no deps) so the frontier dispatches them immediately.
 */
export function mintFixStories(args: {
  plan: Plan;
  verdict: P3QaVerdict;
  /** Boilerplate seam hook (registry testHarness.seamHook); resolved by callers. */
  seamHook?: string;
  now?: () => string;
}): StoryNodeRow[] {
  const { plan, verdict, seamHook } = args;
  const now = args.now ? args.now() : new Date().toISOString();
  const findings = blockingFindings(verdict, seamHook);
  const shaTag = (verdict.ranAtSha || 'nosha').slice(0, 7);

  // The seam story (if minted) gates the rest: without the seam, no other fix
  // can be verified. Its deterministic id is computed first so siblings can
  // depend_on it (the frontier then builds it first).
  const seamFinding = findings.find((f) => f.title.startsWith('Mount the window.__harness'));
  const seamStoryId = seamFinding
    ? `qafix-${plan.planId.slice(0, 8)}-${seamFinding.kind}-${shortHash(
        `${shaTag}:${seamFinding.title}:${seamFinding.touches.join(',')}`,
      )}`
    : null;

  return findings.map((f) => {
    const storyId = `qafix-${plan.planId.slice(0, 8)}-${f.kind}-${shortHash(
      `${shaTag}:${f.title}:${f.touches.join(',')}`,
    )}`;
    const dependsOn = seamStoryId && storyId !== seamStoryId ? [seamStoryId] : [];
    const ac: BoundAcceptanceCriterion = {
      id: `${storyId}-ac1`,
      text: f.acText,
      needsBrowser: true,
      when: 'the app is loaded and exercised in the browser',
      thenObservable: f.acText,
      verify: 'behavior',
      acClass: 'deterministic',
      testBinding: { status: 'unbound' },
    };
    const row: StoryNodeRow = {
      storyId,
      cohort: { epicId: `p3-qa-fix-${shaTag}`, epicTitle: 'QA Review fixes' },
      title: f.title,
      intent: f.intent,
      acceptanceCriteria: [ac],
      depends_on: dependsOn,
      touches: f.touches,
      complexity: 'standard',
      planId: plan.planId,
      appId: plan.appId ?? '',
      state: dependsOn.length > 0 ? 'blocked' : 'ready',
      unblockedDepsCount: dependsOn.length,
      cohortBatch: dependsOn.length > 0 ? 1 : 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return row;
  });
}
