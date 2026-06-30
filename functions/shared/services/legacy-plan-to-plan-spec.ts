/**
 * legacy-plan-to-plan-spec — the test bridge (development-plan §3, interim).
 *
 * Mycelium will eventually emit a `plan_spec` directly. Until then this converts
 * an EXISTING legacy plan (epics → stories with ACs / touchPoints / dependsOn)
 * into the same `plan_spec` shape, so a plan created in the UI can be run through
 * the Pipeline-3 ready-frontier / story-dev path. Pure: `convertPlanToPlanSpec`
 * builds the spec; the route ingests it.
 *
 * Mapping:
 *   EpicStory.storyId      → StoryNode.storyId (already globally unique)
 *   epic                   → cohort { epicId, epicTitle }
 *   story.dependsOn        → depends_on (filtered to ids present in the spec, so a
 *                            stale ref can't dangling-reject the whole conversion)
 *   story.touchPoints      → touches (EPIC_WIDE sentinel when none declared, which
 *                            the scope gate treats as "no restriction")
 *   story.criteria         → boundAC[] (testBinding unbound; acClass derived)
 *   story.complexity       → complexity
 */

import type { Plan } from '../types/plan';
import type { EpicWorkflow, EpicStory, AcceptanceCriterion } from '../types/epic-workflow';
import type { PlanSpec, StoryNode, BoundAcceptanceCriterion, AcClass } from '../types/plan-spec';
import { EPIC_WIDE_TOUCH } from '../schemas/plan-spec-schema';

function deriveAcClass(ac: AcceptanceCriterion): AcClass {
  // Visual/taste criteria become advisory-taste (reviewer-judged, non-blocking);
  // everything else is deterministic (test-bound). Legacy ACs carry no security
  // signal, so none map to advisory-security here.
  if (ac.verify === 'appearance') return 'advisory-taste';
  return 'deterministic';
}

function toBoundAc(ac: AcceptanceCriterion, fallbackId: string): BoundAcceptanceCriterion {
  return {
    id: ac.id || fallbackId,
    text: ac.text && ac.text.length >= 5 ? ac.text : `${ac.text || fallbackId} (legacy criterion)`,
    needsBrowser: ac.needsBrowser,
    given: ac.given,
    when: ac.when,
    then: ac.then,
    thenObservable: ac.thenObservable,
    verify: ac.verify,
    manualReason: ac.manualReason,
    testBinding: { status: 'unbound' },
    acClass: deriveAcClass(ac),
  };
}

function storyToNode(story: EpicStory, epic: EpicWorkflow): StoryNode {
  const criteria = Array.isArray(story.criteria) ? story.criteria : [];
  const acceptanceCriteria: BoundAcceptanceCriterion[] = criteria.length
    ? criteria.map((ac, i) => toBoundAc(ac, `${story.storyId}-ac${i + 1}`))
    : [
        {
          id: `${story.storyId}-ac1`,
          text: (story.title || story.description || 'Story complete').slice(0, 200),
          testBinding: { status: 'unbound' },
          acClass: 'deterministic',
        },
      ];

  const touches =
    story.touchPoints && story.touchPoints.length ? story.touchPoints : [EPIC_WIDE_TOUCH];

  return {
    storyId: story.storyId,
    cohort: { epicId: epic.epicId, epicTitle: epic.title },
    title: story.title || story.storyId,
    intent: story.userStory
      ? `As a ${story.userStory.role}, I want ${story.userStory.action}, so that ${story.userStory.benefit}`
      : (story.description || '').slice(0, 400),
    acceptanceCriteria,
    depends_on: Array.isArray(story.dependsOn) ? story.dependsOn : [],
    touches,
    forbiddenAreas: story.forbiddenAreas || [],
    complexity: story.complexity || 'standard',
  };
}

/**
 * Convert a legacy plan + its epics into a plan_spec. PURE.
 *
 * @param now an ISO timestamp (injected so the result is deterministic in tests).
 */
export function convertPlanToPlanSpec(plan: Plan, epics: EpicWorkflow[], now: string): PlanSpec {
  const stories: StoryNode[] = [];
  for (const epic of epics) {
    for (const story of epic.stories || []) {
      // Skip terminal-skipped stories — they won't run.
      if (story.status === 'skipped') continue;
      stories.push(storyToNode(story, epic));
    }
  }

  // Filter depends_on to ids present in the spec so a stale cross-epic / removed
  // reference can't dangling-reject the whole conversion.
  const present = new Set(stories.map((s) => s.storyId));
  for (const s of stories)
    s.depends_on = s.depends_on.filter((d) => present.has(d) && d !== s.storyId);

  return {
    schemaVersion: 'plan-spec/1',
    planId: plan.planId,
    appId: plan.appId || plan.planId,
    planSlug: plan.name || plan.planId,
    rigor: plan.rigor || 'mvp',
    convergedAt: now,
    myceliumPlanSpecId: `legacy:${plan.planId}`,
    stories,
  };
}
