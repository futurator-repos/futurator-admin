/**
 * Labs3 dashboard constants — the stage-first navigation model, the sub-tab
 * union, the uniform view-props contract, and the localStorage / URL keys.
 *
 * Stage-first IA (design doc I8 v2): the plan lifecycle is FIVE navigable
 * stages (App > Plans > Stage), each owning its own panel + ordered subtab set.
 * Stage SELECTION is decoupled from stage PROGRESS — every stage is always
 * reachable; the lifecycle strip renders both a progress state (done/active/
 * pending, from `stageForStatus`) and a distinct selected ring. This REPLACES
 * the v1 flat `subtabsForStage(status)` tab row that filtered one global tab
 * strip by the plan's current status.
 *
 * Kept separate from the adapter so views can import the contract without
 * pulling the model-building code. Namespaced under `labs3.*` so Labs3 view
 * state never collides with the legacy Labs dashboard.
 */

import type { StoryNodeRow } from '@/types/plan-spec';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { Plan, PlanStatus } from '@/types/plan';

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
 *   'plan-stage' — concept-stage planner (phase stepper + live planner stream).
 *                  LABELED "Planner" (design I8).
 *   'graph'      — dependency DAG / dev-plan (schedule). LABELED "Plan".
 *   'codegraph'  — code knowledge graph (Memgraph/Mycelium). LABELED "Graph".
 *                  Grows after every green story via the compile phase.
 *                  Reuses legacy GraphView(projectId=appId).
 *   'publish'    — production surface (stage 5). LABELED "Publish".
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
  | 'deploy'
  | 'publish';

/**
 * The subtab label registry — a single source of truth for the human label of
 * every surface, shared by the shell's SubtabRow and its URL validation.
 * Order here is declaration order only; per-stage render order lives in
 * STAGE_DEFS.
 */
export const LABS3_SUBTABS: { id: Labs3Subtab; label: string }[] = [
  { id: 'plan-stage', label: 'Planner' },
  { id: 'graph', label: 'Plan' },
  { id: 'codegraph', label: 'Graph' },
  { id: 'gitgraph', label: 'Git Graph' },
  { id: 'stories', label: 'Stories' },
  { id: 'qa', label: 'QA' },
  { id: 'growth', label: 'Skills & Learnings' },
  { id: 'stream', label: 'Stream' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'publish', label: 'Publish' },
];

/** Look up a subtab's human label (falls back to the raw id if unknown). */
export function subtabLabel(id: Labs3Subtab): string {
  return LABS3_SUBTABS.find((t) => t.id === id)?.label ?? id;
}

/** {id,label} pairs for a set of subtab ids, in the given order. */
export function subtabDefs(ids: Labs3Subtab[]): { id: Labs3Subtab; label: string }[] {
  return ids.map((id) => ({ id, label: subtabLabel(id) }));
}

// ── Stage-first model ────────────────────────────────────────────────

/** The five navigable lifecycle stages (App > Plans > Stage). */
export type Labs3Stage = 'concept' | 'development' | 'qa' | 'deployment' | 'publish';

export interface StageDef {
  id: Labs3Stage;
  label: string;
  /** Short descriptor shown under the stage label in the lifecycle strip. */
  sub: string;
  /** Ordered subtab set — render order IS this order. */
  subtabs: Labs3Subtab[];
  /** The subtab a stage lands on when no valid subtab is persisted / in URL. */
  defaultSubtab: Labs3Subtab;
}

/**
 * The authoritative stage → panel map. Each stage owns an ordered subtab set;
 * a stage with exactly one subtab renders no subtab row (the shell hides it).
 */
export const STAGE_DEFS: StageDef[] = [
  {
    id: 'concept',
    label: 'Concept',
    sub: 'intent → plan',
    subtabs: ['plan-stage', 'graph'],
    defaultSubtab: 'plan-stage',
  },
  {
    id: 'development',
    label: 'Development',
    sub: 'stories build',
    subtabs: ['stories', 'graph', 'gitgraph', 'codegraph', 'stream', 'growth'],
    defaultSubtab: 'stories',
  },
  {
    id: 'qa',
    label: 'QA Review',
    sub: 'assembled + tested',
    subtabs: ['qa'],
    defaultSubtab: 'qa',
  },
  {
    id: 'deployment',
    label: 'Deployment',
    sub: 'dev → staging',
    subtabs: ['deploy'],
    defaultSubtab: 'deploy',
  },
  {
    id: 'publish',
    label: 'Publish',
    sub: 'promoted live',
    subtabs: ['publish'],
    defaultSubtab: 'publish',
  },
];

/** Lifecycle order of the five stages (progress + chip ordering). */
export const STAGE_ORDER: Labs3Stage[] = STAGE_DEFS.map((s) => s.id);

/** The 0-based position of a stage in lifecycle order. */
export function stageIndex(stage: Labs3Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** The definition for a stage id. */
export function stageDef(stage: Labs3Stage): StageDef {
  return STAGE_DEFS.find((s) => s.id === stage) ?? STAGE_DEFS[0];
}

const VALID_STAGES = new Set<string>(STAGE_ORDER);

/** Narrow an arbitrary string to a Labs3Stage. */
export function isStage(v: string | null | undefined): v is Labs3Stage {
  return v != null && VALID_STAGES.has(v);
}

const VALID_SUBTABS = new Set<string>(LABS3_SUBTABS.map((t) => t.id));

/** Narrow an arbitrary string to a Labs3Subtab. */
export function isSubtab(v: string | null | undefined): v is Labs3Subtab {
  return v != null && VALID_SUBTABS.has(v);
}

/**
 * Map plan.status → the stage the plan currently SITS IN (its progress
 * position, not necessarily the selected stage). `delivered` splits: a plan
 * with a production deploy URL has reached `publish`; without one it rests at
 * `deployment`.
 */
export function stageForStatus(status: PlanStatus, plan?: Pick<Plan, 'deployUrl'>): Labs3Stage {
  switch (status) {
    case 'concept':
      return 'concept';
    case 'developing':
    case 'fixing':
      return 'development';
    case 'review':
      return 'qa';
    case 'delivered':
      return plan?.deployUrl ? 'publish' : 'deployment';
    default:
      // abandoned / archived / unknown — anchor at concept.
      return 'concept';
  }
}

/**
 * Legacy URL back-compat: a bare `?subtab=<id>` (no `?stage=`) resolves to the
 * EARLIEST stage (in lifecycle order) whose subtab set contains that id, so
 * bookmarked deep links from the v1 flat-tab era still land somewhere sane.
 */
export function stageForSubtab(subtab: Labs3Subtab): Labs3Stage {
  const def = STAGE_DEFS.find((s) => s.subtabs.includes(subtab));
  return def ? def.id : 'concept';
}

/** localStorage key roots — per-plan suffixed via the helpers below. */
export const STAGE_KEY = 'labs3.plan-spec-dashboard.stage';
export const SUBTAB_KEY = 'labs3.plan-spec-dashboard.subtab';

/** Per-plan localStorage key for the last-selected stage. */
export function stageStorageKey(planId: string): string {
  return `${STAGE_KEY}:${planId}`;
}

/** Per-plan localStorage key for the last-selected subtab. */
export function subtabStorageKey(planId: string): string {
  return `${SUBTAB_KEY}:${planId}`;
}
