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

// ── Dependency derivation (for legacy plans that carry no story-level deps) ──

const FOUNDATION_RE =
  /\b(types?|constants?|config(uration)?|setup|scaffold(ing)?|schema|enums?|interfaces?|boilerplate|registry|register|models?)\b/i;
const INTEGRATION_RE =
  /\b(assembl\w*|integrat\w*|compose|composit\w*|end-to-end|full[- ](game|app|build|flow)|the complete)\b/i;

/** foundation < feature < integration — a strict layer order (used as a DAG spine). */
const LAYER = { foundation: 0, feature: 1, integration: 2 } as const;
type StoryLayer = keyof typeof LAYER;

function classifyStory(s: StoryNode): StoryLayer {
  const title = s.title || '';
  const epicWide = (s.touches || []).includes(EPIC_WIDE_TOUCH);
  // Integration first: an "assemble the whole thing" / epic-wide story must land last.
  if (epicWide || INTEGRATION_RE.test(title)) return 'integration';
  if (FOUNDATION_RE.test(title)) return 'foundation';
  return 'feature';
}

function concreteTouches(s: StoryNode): string[] {
  return (s.touches || []).filter((t) => t && t !== EPIC_WIDE_TOUCH);
}

/**
 * Derive story dependency edges when the legacy plan carries NONE — the common
 * case, since the epic/story model has no story-level ordering, so every story
 * lands in one flat `cohortBatch` and the ready-frontier can't stage the work.
 *
 * Produces a DAG so ingest's Kahn layering yields real batches:
 *   - A strict class spine (foundation → feature → integration): every story
 *     depends on ALL stories in a strictly-lower layer. Because layers are a
 *     total order, these cross-layer edges can never form a cycle.
 *   - A same-layer shared-touch edge (earlier→later in list order) whenever two
 *     stories write the same concrete file, so siblings that would collide on a
 *     shared file are serialized instead of racing the commit lock.
 *
 * No-op when ANY story already declares `depends_on` (a plan with real edges is
 * trusted verbatim) or when there are fewer than 2 stories.
 *
 * @returns the number of edges added (0 when skipped) — handy for tests/telemetry.
 */
export function deriveStoryDependencies(stories: StoryNode[]): number {
  if (stories.length < 2) return 0;
  if (stories.some((s) => (s.depends_on?.length ?? 0) > 0)) return 0; // trust real deps

  const layers = stories.map((s) => LAYER[classifyStory(s)]);
  const touchSets = stories.map((s) => new Set(concreteTouches(s)));
  let added = 0;

  for (let i = 0; i < stories.length; i++) {
    const deps = new Set<string>();
    for (let j = 0; j < stories.length; j++) {
      if (j === i) continue;
      if (layers[j] < layers[i]) {
        deps.add(stories[j].storyId); // lower layer → dependency (acyclic by construction)
      } else if (layers[j] === layers[i] && j < i && touchSets[i].size) {
        for (const t of touchSets[j])
          if (touchSets[i].has(t)) {
            deps.add(stories[j].storyId);
            break;
          }
      }
    }
    stories[i].depends_on = [...deps];
    added += deps.size;
  }
  return added;
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

  // Legacy plans usually carry no story-level dependencies → one flat batch.
  // Derive a foundation→feature→integration DAG so the frontier stages real
  // waves. No-op when the plan already declares its own edges.
  deriveStoryDependencies(stories);

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
