/**
 * Plan — the atomic unit of product intent in Labs.
 *
 * A Plan owns:
 *   • an intent (raw user text) + a plan.md on disk
 *   • a canonical name (= folder slug = deploy slug, locked after creation)
 *   • 1..N Epics with inter-epic dependencies (see EpicWorkflow.dependsOnEpics)
 *   • execution settings applied to all epics under the plan
 *   • cost + progress rollups (denormalized for fast list rendering)
 *
 * The status lifecycle is:
 *   concept → developing → review → delivered
 *                      ↘ fixing (recoverable)
 *                      ↘ archived (soft-delete, restorable within 14d)
 */

export type PlanStatus = 'concept' | 'developing' | 'fixing' | 'review' | 'delivered' | 'archived';

export type PlanExecutionMode = 'pipeline' | 'orchestrator';

/**
 * Pipeline Enhancement Plan v2 — Phase C. Rigor dial selected at plan
 * creation (Advanced Settings) and persisted on the plan. Drives the
 * pipeline builder: which steps are included (test-author, tamper-check,
 * browser tests), how strict review is, and the budget warning threshold.
 */
export type PlanRigor = 'prototype' | 'mvp' | 'production';

/** Per-plan testing config. Mirrors epic-level TestingProfile but applied plan-wide. */
export interface PlanTestingProfile {
  /** Include Playwright browser tests in the pipeline. */
  hasBrowserTests?: boolean;
  viewport?: string;
  interactionModel?: string;
}

export interface Plan {
  planId: string;
  /** kebab-case, `[a-z][a-z0-9-]{2,40}`, locked after creation. Also the folder slug + deploy URL segment. */
  name: string;
  /**
   * Human-readable display name (e.g. "Brick Breaker Game"). Optional —
   * when absent, render `name` as the display label. Free-form; no slug
   * constraints. Set at creation time; editable via PATCH until plan
   * transitions out of `concept`.
   */
  displayName?: string;
  /** Raw user input. */
  intent: string;
  /** PM-agent-generated summary. */
  description: string;
  status: PlanStatus;
  /** FK to EpicWorkflow rows (1..N). Order reflects creation order; does NOT determine execution order. */
  epicIds: string[];
  /** `/home/ubuntu/projects/<name>` — derived from `name` at creation. */
  workingDir: string;
  /** Set once deployed via Deploy tab. */
  deployUrl?: string;

  // ── Execution defaults applied to all epics under this plan ──
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  /** Phase C.2: TEST agent model. Defaults to 'sonnet' when absent. */
  testModel?: string;
  yoloMode?: boolean;
  executionMode: PlanExecutionMode;
  /**
   * Phase C.1: Rigor dial. Drives pipeline builder — prototype skips tests
   * and tamper-check, mvp does unit tests, production adds red-green-tamper
   * cycle and browser tests. Editable while `status === 'concept'`; locked
   * once the first wave launches.
   */
  rigor?: PlanRigor;
  /** Phase C.2: plan-wide testing config (Playwright toggle lives here). */
  testingProfile?: PlanTestingProfile;

  /**
   * QA Review — auto-enqueue QA + PO jobs across every epic when the last
   * Developing wave completes. Default derived from rigor at creation time:
   *   prototype → false  (manual only)
   *   mvp       → false  (manual only)
   *   production → true  (auto)
   * Editable via PATCH any time; the manual "Run QA Review" button is
   * always available regardless of this flag.
   */
  autoRunQa?: boolean;

  /**
   * Party Mode (BMAD) toggle — chosen at plan creation (default ON).
   *
   * When `true`, plan creation enqueues a `party-bootstrap` job for the
   * plan's workingDir: installs BMAD 6.3.x, injects the 8 custom agents,
   * and creates a PartyProject row keyed by `plan.name`. The Party Mode
   * stage on the dashboard then surfaces a full chat UI scoped to this
   * project — agents have Read/Grep/Glob access to the codebase.
   *
   * When `false`, the Party Mode stage shows a one-click "Install BMAD"
   * affordance so the operator can retrofit Party Mode later.
   */
  bmadEnabled?: boolean;

  /**
   * QA → AC manual sign-off. When set, the AC pillar in the QA report treats
   * every criterion as explicitly approved (regardless of PO job state).
   * Written by POST /api/plans/:id/approve-ac. Clearable so a reviewer can
   * un-approve if a story needs rework.
   */
  acApproval?: {
    approvedAt: string;
    approvedBy: string;
  };

  /**
   * Ordered list of every deploy job ever run for this plan (oldest first).
   * Appended by POST /api/epic-workflows/:id/deploy. The Deploy stage reads
   * this to render deploy history. Legacy plans without this field fall
   * back to `epic.deployJobId` of the final epic.
   */
  deployJobIds?: string[];

  // ── Denormalized rollups for fast list rendering ──
  totalCostUsd: number;
  totalStories: number;
  doneStories: number;

  // ── Lifecycle + archival ──
  /** Set when plan transitions to `developing`. */
  startedAt?: string;
  /** Set when plan transitions to `review`. */
  reviewAt?: string;
  /** Plan-level final build-check job — set by the wave-completion cron when last epic-wave completes. */
  planBuildJobId?: string;
  /**
   * Pipeline v2.0 PR-8a — plan-scoped Visual QA job. Replaces the legacy
   * per-epic `EpicWorkflow.qaJobId` fan-out (one QA job per epic) with a
   * single QA job that boots one dev server and runs every visual test
   * across every epic+story in the plan. Legacy `epic.qaJobId` is read
   * by the dashboard as a fallback for plans created before PR-8a.
   *
   * Pipeline v2.0 PR-8d — under the new aggregate+execute split this is
   * the EXECUTE jobId; the aggregate jobId lives on `qaAggregateJobId`.
   */
  qaJobId?: string;

  // ── Pipeline v2.0 PR-8 (Q4) — operator-gated test contract ──────────
  //
  // The QA stage runs in two phases. Phase 1 (`qa-aggregate`) produces
  // `visual-tests-draft.md` + classifier output and pauses for operator
  // review. Phase 2 (`qa-execute`) runs after the operator POSTs to
  // `/api/plans/:id/qa-contract/approve`.
  /** Aggregate-stage jobId — produced when QA is initiated. */
  qaAggregateJobId?: string;
  /**
   * State of the operator-gated contract:
   *   • `pending` — qa-aggregate emitted a draft, awaiting operator review
   *   • `approved` — operator approved; qa-execute has been launched
   *   • `rejected` — operator chose to cancel QA for this plan
   *
   * Absent on legacy plans that ran QA before PR-8 (treat as 'approved').
   */
  qaContractStatus?: 'pending' | 'approved' | 'rejected';
  /** ISO timestamp of the most recent contract status transition. */
  qaContractDecidedAt?: string;
  /** User who approved/rejected the contract. */
  qaContractDecidedBy?: string;
  /**
   * Pipeline v2.0 PR-8 (Q5.2) — plan-level QA cost ceiling. When the
   * sum of per-test costs in qa-execute would exceed this, remaining
   * tests are marked `skipped-budget` and the operator gets a
   * "QA stopped at X/Y due to budget" signal. Defaults to $1
   * (redesign §7.2). 0 = no cap.
   */
  qaCostBudgetUsd?: number;

  /** Previous status when archived, so restore can return to the right state. */
  preArchiveStatus?: PlanStatus;
  archivedAt?: string;
  /** Where the folder was moved on archive (e.g. `/home/ubuntu/.trash/plans/foo-2026…`). */
  archivePath?: string;

  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** Summary shape returned by `GET /api/plans` (list view). */
export interface PlanSummary {
  planId: string;
  name: string;
  displayName?: string;
  intent: string;
  status: PlanStatus;
  totalStories: number;
  doneStories: number;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deployUrl?: string;
}
