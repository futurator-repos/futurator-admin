// qa-review-p3 — the plan-keyed QA Review verdict shape (QA-Review W2).
//
// A DELIBERATELY new, NON-epic type. The legacy QaReport
// (functions/shared/types/*) is GateVqaClaim / WaveMatrix / single-screenshot
// coupled and assumes epics+waves that a P3 plan does not have. W2 evaluates the
// ASSEMBLED plan at its deployed dev URL (plan.devUrl), pinned to a frozen
// commit (plan.qaCommitSha), through two gate lanes + a wiring check:
//
//   Lane 1 (deterministic journeys) — Playwright drives the dev URL through the
//     PM's delivery journeys via the window.__harness seam (reach/act/observe,
//     real assertions). A failed assertion BLOCKS. This is the primary verdict
//     (research: probe-based verification is the convergent SOTA).
//   Lane 2 (VQA judge) — before/after screenshot PAIRS around each act step,
//     judged by a VLM given spec + source diff + both frames. A real FAIL blocks;
//     'uncertain' never blocks (F12 honest-verdict lane).
//   Wiring — a deterministic orphan check: modules the assemble step should have
//     imported but left as 0-importer dead code (the pacman3 ghost-module class).
//
// The client mirror (src/types/qa-review-p3.ts) is byte-parity with this file.

export type LaneVerdict = 'pass' | 'fail' | 'uncertain';

/** One deterministic assertion inside a journey step (Lane 1). */
export interface DeterministicResult {
  /** Human-readable assertion, e.g. "score increased after ArrowUp". */
  assertion: string;
  passed: boolean;
  /** Why it passed/failed (snapshot delta, seam-not-mounted, timeout, …). */
  detail: string;
  /**
   * True iff this step failed due to a TEST-HARNESS/infra problem (no browser,
   * launch/nav error) rather than a real app failure. Infra steps are excluded
   * from the blocking check — they render 'uncertain', never a false-block.
   */
  infra?: boolean;
}

/** The Lane-2 before/after VQA judgment for one step. */
export interface StepVqa {
  verdict: LaneVerdict;
  rationale: string;
  /** S3/CloudFront URLs of the captured frames (empty until uploaded). */
  beforeShotUrl: string;
  afterShotUrl: string;
  /** Ref (path or key) to the source diff the judge was given. */
  sourceDiffRef: string;
}

/** One step of a journey: an action + its deterministic result (+ optional VQA). */
export interface JourneyStep {
  label: string;
  /** The seam action executed (e.g. "press ArrowUp", "__harness.forceStatus(...)"). */
  action: string;
  deterministic: DeterministicResult;
  vqa?: StepVqa;
  /**
   * True iff this step is a real BLOCKER: a deterministic hard-fail, or an
   * UNDECIDED step (uninterpretable / drive-disabled) that VQA confirmed as a
   * fail. A VQA 'fail' on a deterministically-PASSED step is NOT blocking
   * (confirmatory policy — VQA can never false-block a verified step).
   */
  blocking?: boolean;
}

/** One end-to-end delivery journey run against the assembled app. */
export interface JourneyResult {
  id: string;
  title: string;
  narrative?: string;
  /** ACs this journey exercises. */
  acRefs: string[];
  verdict: LaneVerdict;
  steps: JourneyStep[];
}

/** A flattened Lane-2 result (mirrors a step's vqa, keyed to its journey/step). */
export interface VqaResult {
  journeyId: string;
  stepLabel: string;
  verdict: LaneVerdict;
  rationale: string;
  beforeShotUrl: string;
  afterShotUrl: string;
}

/** The assemble-must-import wiring check. */
export interface WiringReport {
  /** Runtime modules with 0 importers (dead code the assemble step orphaned). */
  orphanModules: string[];
  blocking: boolean;
  /**
   * Static seam-mount sub-lane: false when the scaffold's seam hook is defined
   * but never imported by a feature (the pacman3 root cause — window.__harness
   * can never publish). Absent when the boilerplate declares no seam.
   */
  seamMounted?: boolean;
  seamDetail?: string;
}

export type P3QaStatus = 'idle' | 'running' | 'passed' | 'failed';

/**
 * Q2 — Agentic VQA lane (BrowserAgent integration). One operator-play-test
 * finding surfaced by the agentic loop while attempting a delivery journey.
 * `'blocking'` is the class of defect the agentic lane exists to catch (the
 * journey could not be completed); `'attention'` is a non-blocking note.
 */
export interface AgenticFinding {
  severity: 'blocking' | 'attention';
  note: string;
}

/**
 * Q2 — one agentic (BrowserAgent) run against a single delivery journey.
 * `verdict:'skipped'` covers the no-api-key / disabled-flag fail-soft path
 * (never a QA failure). `frameUrls` are S3/CloudFront step screenshots,
 * `_qa/<planId>/<sha>/agentic/<journeyId>/step-NNN.png`.
 */
export interface AgenticRun {
  journeyId: string;
  instruction: string;
  verdict: 'pass' | 'fail' | 'uncertain' | 'skipped';
  findings: AgenticFinding[];
  frameUrls: string[];
  steps: number;
  durationMs: number;
  error?: string;
}

/** The full plan-keyed QA Review report the daemon writes + the UI reads. */
export interface P3QaReport {
  planId: string;
  /** The frozen commit QA ran against (parity with plan.qaCommitSha). */
  qaCommitSha: string;
  devUrl: string;
  status: P3QaStatus;
  journeys: JourneyResult[];
  vqa: VqaResult[];
  wiring: WiringReport;
  /**
   * P3_QA_REVIEW honest-gate (Slice B) — passthrough of plan.qaVerifiedAt: the
   * ISO timestamp deployed-app QA last passed (non-blocking) for the current
   * qaCommitSha. ABSENT ⇒ not verified (never ran, blocking, or stale SHA). The
   * UI's "READY TO DELIVER" chip gates on this (OR an operator Approve).
   */
  qaVerifiedAt?: string;
  /**
   * Q2 — Agentic VQA lane report (BrowserAgent-driven operator-play-test).
   * ABSENT when the lane didn't run (flag off / plan has no delivery
   * journeys). `mode` reflects which backend actually drove the browser
   * (`'headless'` embedded Playwright, or `'extension'` when the operator's
   * live Chrome was reachable). `skippedReason` covers fail-soft paths
   * (e.g. `'no-api-key'`) — the lane never fails QA, it just doesn't run.
   */
  agentic?: {
    mode: 'headless' | 'extension';
    model: string;
    skippedReason?: string;
    runs: AgenticRun[];
  };
}

/**
 * The compact verdict persisted on the plan row (plan.p3QaVerdict). Carries
 * `ranAtSha` so a stale verdict (from a prior commit) is detectable, and the
 * operator decision (decidedAt/decidedBy) which a re-run must NEVER clobber.
 */
export interface P3QaVerdict {
  status: LaneVerdict;
  /** True iff a blocker (failed journey / real VQA fail / blocking orphan) exists. */
  blocking: boolean;
  /** The commit this verdict was computed against (== qaCommitSha at run time). */
  ranAtSha: string;
  journeys: JourneyResult[];
  vqa: VqaResult[];
  wiring: WiringReport;
  /** Operator decision — set by Approve/Send-back, never overwritten by a re-run. */
  decidedAt?: string;
  decidedBy?: string;
  decision?: 'approved' | 'sent-back';
  /** For an approval: the SHA blessed (== ranAtSha) so W3 promotes exactly it. */
  approvedSha?: string;
}
