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
  | 'graph'
  | 'codegraph'
  | 'gitgraph'
  | 'stories'
  | 'qa'
  | 'growth'
  | 'stream';

export const LABS3_SUBTABS: { id: Labs3Subtab; label: string }[] = [
  // Dependency DAG — the schedule. Previously mislabeled "Graph".
  { id: 'graph', label: 'Plan' },
  // Code knowledge graph (files/symbols/imports) — the REAL "Graph".
  { id: 'codegraph', label: 'Graph' },
  { id: 'gitgraph', label: 'Git Graph' },
  { id: 'stories', label: 'Stories' },
  { id: 'qa', label: 'QA' },
  // The learning-loop lens: skill catalog + reflections + instinct loop / gate
  // would-blocks (pipeline-3's continuous-learning surface).
  { id: 'growth', label: 'Skills & Learnings' },
  { id: 'stream', label: 'Stream' },
];

/** localStorage keys — continuity within a Labs3 session. */
export const STAGE_KEY = 'labs3.plan-spec-dashboard.stage';
export const SUBTAB_KEY = 'labs3.plan-spec-dashboard.subtab';
