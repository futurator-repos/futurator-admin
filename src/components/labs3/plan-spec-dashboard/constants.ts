/**
 * Labs3 dashboard constants — the sub-tab union, the uniform view-props
 * contract, and the localStorage / URL keys.
 *
 * Kept separate from the adapter so views can import the contract without
 * pulling the model-building code. Namespaced under `labs3.*` so Labs3 view
 * state never collides with the legacy Labs dashboard.
 */

import type { StoryNodeRow } from '@/types/plan-spec';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { PlanStatus } from '@/types/plan';

/**
 * Uniform props every B3–B7 surface receives. The shell (PlanSpecDashboard)
 * fetches the StoryNode snapshot ONCE and fans these into each view slot, so
 * views need no snapshot fetch of their own (QA / Growth may self-fetch their
 * secondary sources). Lives here — the dependency-free constants module — so
 * all parallel views import one stable contract without a model-code cycle.
 */
export interface Labs3ViewProps {
  planId: string;
  appId: string | null;
  stories: StoryNodeRow[];
  plan?: PlanWithEpics;
  githubRepoUrl?: string | null;
  onSelectStory?: (storyId: string) => void;
}

/**
 * Labs3 surfaces — the SDD analogue of legacy DevelopingSubtab.
 *
 * Tab semantics:
 *   'graph'     — dependency DAG / dev-plan (schedule). LABELED "Plan".
 *   'codegraph' — code knowledge graph (Memgraph/Mycelium). LABELED "Graph".
 *                 Grows after every green story via the compile phase.
 *                 Reuses legacy GraphView(projectId=appId).
 */
export type Labs3Subtab =
  | 'plan-stage'
  | 'graph'
  | 'codegraph'
  | 'gitgraph'
  | 'stories'
  | 'qa'
  | 'growth'
  | 'stream'
  | 'deploy';

export const LABS3_SUBTABS: { id: Labs3Subtab; label: string; stages: PlanStatus[] }[] = [
  // Concept-stage planning surface — mint-job status / phase stepper / narrative.
  { id: 'plan-stage', label: 'Planning', stages: ['concept'] },
  // Dependency DAG — the schedule. Previously mislabeled "Graph".
  { id: 'graph', label: 'Plan', stages: ['concept', 'developing', 'fixing'] },
  // Code knowledge graph (files/symbols/imports) — the REAL "Graph".
  { id: 'codegraph', label: 'Graph', stages: ['developing', 'fixing', 'delivered'] },
  { id: 'gitgraph', label: 'Git Graph', stages: ['developing', 'fixing', 'review', 'delivered'] },
  { id: 'stories', label: 'Stories', stages: ['developing', 'fixing', 'review'] },
  { id: 'qa', label: 'QA', stages: ['review', 'delivered'] },
  // The learning-loop lens: skill catalog + reflections + instinct loop / gate
  // would-blocks (pipeline-3's continuous-learning surface).
  { id: 'growth', label: 'Skills & Learnings', stages: ['delivered'] },
  { id: 'stream', label: 'Stream', stages: ['developing', 'fixing', 'review'] },
  // Deploy ladder — environment cards + promote CTA (QA-review W2 evidence).
  { id: 'deploy', label: 'Deploy', stages: ['review', 'delivered'] },
];

/** localStorage keys — continuity within a Labs3 session. */
export const STAGE_KEY = 'labs3.plan-spec-dashboard.stage';
export const SUBTAB_KEY = 'labs3.plan-spec-dashboard.subtab';

/**
 * Stage-aware tab sets (design doc I2/U3). Order here IS render order — it
 * intentionally diverges from LABS3_SUBTABS' declaration order per stage
 * (e.g. developing puts Stories before Graph/codegraph), so this is kept as
 * an explicit ordered map rather than derived by filtering the per-entry
 * `stages` field above (which only records membership, not per-stage order).
 */
const STAGE_SUBTAB_IDS: Record<'concept' | 'developing' | 'review' | 'delivered', Labs3Subtab[]> = {
  concept: ['plan-stage', 'graph'],
  developing: ['graph', 'stories', 'gitgraph', 'stream', 'codegraph'],
  review: ['qa', 'stories', 'gitgraph', 'stream', 'deploy'],
  delivered: ['deploy', 'qa', 'codegraph', 'gitgraph', 'growth'],
};

const ALL_SUBTAB_IDS: Labs3Subtab[] = LABS3_SUBTABS.map((t) => t.id);

function stageGroupFor(status: PlanStatus): keyof typeof STAGE_SUBTAB_IDS | null {
  switch (status) {
    case 'concept':
      return 'concept';
    case 'developing':
    case 'fixing':
      return 'developing';
    case 'review':
      return 'review';
    case 'delivered':
      return 'delivered';
    default:
      // abandoned / archived — outside the stage union, show every tab.
      return null;
  }
}

/** The ordered set of subtabs visible for a plan's current lifecycle stage. */
export function subtabsForStage(status: PlanStatus): Labs3Subtab[] {
  const group = stageGroupFor(status);
  return group ? STAGE_SUBTAB_IDS[group] : ALL_SUBTAB_IDS;
}

/** The tab a stage should redirect to when the persisted/URL subtab is no longer valid. */
export function defaultSubtabForStage(status: PlanStatus): Labs3Subtab {
  return subtabsForStage(status)[0];
}
