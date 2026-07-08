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
// CLIENT MIRROR of functions/shared/types/qa-review-p3.ts — byte-parity with it.

export type LaneVerdict = 'pass' | 'fail' | 'uncertain';

/** One deterministic assertion inside a journey step (Lane 1). */
export interface DeterministicResult {
  /** Human-readable assertion, e.g. "score increased after ArrowUp". */
  assertion: string;
  passed: boolean;
  /** Why it passed/failed (snapshot delta, seam-not-mounted, timeout, …). */
  detail: string;
  /** True iff a harness/infra failure (not a real app failure) — never blocks. */
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
  /** Static seam-mount sub-lane: false = seam hook never imported (root cause). */
  seamMounted?: boolean;
  seamDetail?: string;
}

export type P3QaStatus = 'idle' | 'running' | 'passed' | 'failed';

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
   * ISO-8601 timestamp set when a NON-BLOCKING verdict is durably recorded for
   * the CURRENT qaCommitSha (deployed-app QA passed). ABSENT/empty ⇒ QA has NOT
   * passed (never ran, ran-and-blocking, or stale SHA). Passthrough of
   * plan.qaVerifiedAt on the GET /plans/:id/qa-review-p3 report envelope.
   * CLIENT MIRROR of functions/shared/types/qa-review-p3.ts — byte-parity.
   */
  qaVerifiedAt?: string;
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

/**
 * CLIENT MIRROR of DeliveryJourney (functions/shared/schemas/plan-output-schema.ts
 * `deliveryJourneySchema`) — the PM-declared journeys, for frontend typing.
 */
export interface DeliveryJourney {
  id: string;
  title: string;
  narrative?: string;
  acRefs: string[];
}
