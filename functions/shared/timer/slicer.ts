// Timer Intelligence — Slicer (Story 1.8.2)
// Converts raw AgentEvent streams into ordered TimerSlice arrays.
//
// Public API:
//   sliceForJob(jobId)   → TimerSlice[]  (all slices for one job, ordered by startedAt)
//   sliceForPlan(planId) → TimerSlice[]  (all slices across every job in a plan, ordered by startedAt)
//
// NOTE on overlapping slices: sliceForPlan merges slices from all jobs without deduplication.
// Jobs that run in parallel (e.g. same wave, multiple stories) will produce overlapping slices
// by wall-clock. This is intentional and expected — callers summing durationMs across a plan
// are measuring category-attributed time, not wall-clock time. Use job.startedAt/endedAt
// for wall-clock comparisons.
//
// NOTE on job timing fields: AgentJob does not carry explicit `startedAt`/`endedAt` fields.
// The slicer uses `createdAt` as a proxy for startedAt (when PENDING the job exists but
// hasn't started; this is a small over-count of the first slice gap). `updatedAt` is used
// as `endedAt` for terminal jobs (the daemon writes `updatedAt` when it flips status to a
// terminal state). For live jobs, `Date.now()` is used and the trailing slice carries
// `isLive: true`.
//
// NOTE on NEEDS_ATTENTION tracking: the AgentEvent schema does not carry a `status` field
// (status is stored on the job row, not on individual events). The slicer detects the
// human-wait window through two mechanisms:
//   1. Explicit human-wait event types (dev_blocker_reported, story_blocked) — the classifier
//      returns 'human-wait' natively for these; no special slicer logic needed.
//   2. Job-level NEEDS_ATTENTION: if the job's status is 'NEEDS_ATTENTION' at query time,
//      the live-tail slice (last event → now) is classified with jobStatus='NEEDS_ATTENTION',
//      producing 'human-wait'. For jobs that completed via COMPLETED_VIA_SALVAGE, the
//      human-wait window is approximated by the explicit blocker events in the stream.

import type { AgentEvent, AgentJobStatus } from '../types/agent-orchestrator';
import { getEventsAfter } from '../repositories/agent-events-repository';
import { getJobById } from '../repositories/agent-jobs-repository';
import { getPlanById } from '../repositories/plan-repository';
import { getEpicById } from '../repositories/epic-workflow-repository';
import { isTerminal } from '../types/agent-job-state-machine';
import { classify } from './classifier';
import { resolveStepCategory } from './step-category-map';
import type { JobContext, TimerCategory, TimerSlice } from './types';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Event types that the classifier returns 'compile' for unconditionally,
 * but the slicer downgrades to 'idle' when durationMs < 500.
 * This implements the 500ms heuristic documented in types.ts.
 */
const IDLE_DOWNGRADE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'epic_start',
  'wave_start',
  'wave_complete',
  'epic_complete',
]);

/**
 * Sentinel for getEventsAfter: start from the very beginning of the stream.
 *
 * DynamoDB rejects empty strings in key-attribute comparison values
 * (`KeyConditionExpression: eventSeq > :after`), so we use '000000' which is
 * lexicographically less than every real eventSeq (zero-padded 6-digit
 * starting at '000001'). 2026-05-04: previously this was `''` and the timing
 * dashboard silently fell into the catch-all error path on every poll —
 * the panel showed 00:00 because `slices = []` was returned silently.
 */
const SEQ_START = '000000';

/** Max events fetched per page from DynamoDB. */
const PAGE_SIZE = 200;

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetch ALL events for a job, ordered by (eventSeq ASC).
 * Uses getEventsAfter in a loop to handle pagination.
 */
async function fetchAllEventsForJob(jobId: string): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  let cursor = SEQ_START;

  for (;;) {
    const { events, lastSeq } = await getEventsAfter(jobId, cursor, PAGE_SIZE);
    all.push(...events);
    if (events.length < PAGE_SIZE) break; // no more pages
    cursor = lastSeq;
  }

  // Events come back ordered by eventSeq (ScanIndexForward: true in the repo).
  // eventSeq is a zero-padded integer string so lexicographic sort is correct.
  // Sort by timestamp as the secondary key to handle ties gracefully.
  all.sort((a, b) => {
    const tA = a.timestamp ?? '';
    const tB = b.timestamp ?? '';
    if (tA !== tB) return tA.localeCompare(tB);
    return a.eventSeq.localeCompare(b.eventSeq);
  });

  return all;
}

/**
 * Build the JobContext for a given event index, accounting for NEEDS_ATTENTION.
 *
 * The base context uses the job's stored status. If the stored status is
 * NEEDS_ATTENTION (job is currently paused for operator action), all slices
 * produced from this slicer invocation carry 'NEEDS_ATTENTION' in their context
 * so the classifier returns 'human-wait'. This is deliberately aggressive:
 * we do not know when the transition happened at the event level, so we treat
 * the entire in-flight tail as human-wait.
 */
function buildJobContext(
  job: {
    jobType?: string;
    status: AgentJobStatus;
    retryAttempt?: number;
  },
  event: AgentEvent,
  activeStatus: AgentJobStatus,
): JobContext {
  // agentRole: prefer the event's `role` field (set by orchestrator events),
  // fall back to agentId which is the pipeline-ID string for daemon-emitted
  // events. Daemon emits `agentId: 'DEV' | 'REVIEWER' | 'COMPILER'`
  // (uppercase pipeline IDs), but the classifier table keys are lowercase
  // role strings (matching the AgentRole type union). Lowercase the value
  // before returning so byRole lookups in CLASSIFICATION_TABLE actually
  // match — without this, every reviewer event falls through to default
  // 'dev' and the timing dashboard reports 0 % review time.
  // 2026-05-04 dino-runner-1 forensic: 87 % dev / 0 % review across all
  // jobs despite 6 reviewer steps. Root cause was this case mismatch.
  const agentRole: string = (event.role ?? event.agentId ?? 'dev').toLowerCase();
  const jobKind: string = job.jobType ?? 'pipeline';
  const retryCount: number = job.retryAttempt ?? 0;

  return {
    jobKind,
    agentRole,
    jobStatus: activeStatus,
    retryCount,
  };
}

/**
 * Apply the compile→idle downgrade heuristic:
 * if the slice's category is 'compile' AND durationMs < 500 AND the eventType
 * is one of the lifecycle bookmarks, downgrade category to 'idle'.
 */
function applyIdleDowngrade(slice: TimerSlice): TimerSlice {
  if (
    slice.category === 'compile' &&
    slice.durationMs < 500 &&
    IDLE_DOWNGRADE_EVENT_TYPES.has(slice.eventType)
  ) {
    return { ...slice, category: 'idle' as TimerCategory };
  }
  return slice;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Produce all time slices for a single agent job, ordered by startedAt.
 *
 * Algorithm:
 *   1. Load the job row.
 *   2. Fetch all events ordered by (timestamp, eventSeq).
 *   3. For each consecutive pair (A, B): emit one slice.
 *   4. For the last event in a terminal job: emit a final slice → job.updatedAt.
 *   5. For the last event in a non-terminal job: emit a live-tail slice → Date.now().
 *   6. Apply the compile→idle downgrade on every slice.
 *
 * Returns an empty array if the job does not exist or has no events.
 */
export async function sliceForJob(jobId: string): Promise<TimerSlice[]> {
  const job = await getJobById(jobId);
  if (!job) return [];

  const events = await fetchAllEventsForJob(jobId);
  if (events.length === 0) return [];

  const terminal = isTerminal(job.status);

  // Determine the effective status context. If NEEDS_ATTENTION, we propagate
  // that for all slices (see module-level comment).
  const activeStatus: AgentJobStatus =
    job.status === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : job.status;

  const slices: TimerSlice[] = [];

  // Emit inter-event slices
  for (let i = 0; i < events.length - 1; i++) {
    const eventA = events[i];
    const eventB = events[i + 1];

    const startedAt = eventA.timestamp;
    const endedAt = eventB.timestamp;
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

    const ctx = buildJobContext(job, eventA, activeStatus);
    // PR-49 — stepId override takes precedence over classifier's role+
    // event-type chain for shell steps (test-verify, tamper-check,
    // baseline-regression, compile-commit-on-pass, compile-push, etc.).
    // Falls back to the classifier when the stepId isn't mapped.
    const stepOverride = resolveStepCategory(eventA.stepId);
    const category = stepOverride ?? classify(eventA, ctx);

    const slice: TimerSlice = applyIdleDowngrade({
      jobId,
      eventSeq: eventA.eventSeq,
      category,
      startedAt,
      endedAt,
      durationMs: Math.max(0, durationMs),
      agentRole: ctx.agentRole,
      eventType: eventA.eventType,
    });

    slices.push(slice);
  }

  // Emit the trailing slice for the last event
  const lastEvent = events[events.length - 1];
  const lastCtx = buildJobContext(job, lastEvent, activeStatus);
  // PR-49 — same stepId override as inter-event slices.
  const lastStepOverride = resolveStepCategory(lastEvent.stepId);
  const lastCategory = lastStepOverride ?? classify(lastEvent, lastCtx);

  if (terminal) {
    // Terminal job: span last event → job.updatedAt (proxy for endedAt)
    const endedAt = job.updatedAt;
    const durationMs = Math.max(
      0,
      new Date(endedAt).getTime() - new Date(lastEvent.timestamp).getTime(),
    );

    const slice: TimerSlice = applyIdleDowngrade({
      jobId,
      eventSeq: lastEvent.eventSeq,
      category: lastCategory,
      startedAt: lastEvent.timestamp,
      endedAt,
      durationMs,
      agentRole: lastCtx.agentRole,
      eventType: lastEvent.eventType,
    });

    slices.push(slice);
  } else {
    // Non-terminal (live) job: span last event → now, mark isLive
    const nowIso = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - new Date(lastEvent.timestamp).getTime());

    const slice: TimerSlice = applyIdleDowngrade({
      jobId,
      eventSeq: lastEvent.eventSeq,
      category: lastCategory,
      startedAt: lastEvent.timestamp,
      endedAt: nowIso,
      durationMs,
      agentRole: lastCtx.agentRole,
      eventType: lastEvent.eventType,
      isLive: true,
    });

    slices.push(slice);
  }

  // Already in (timestamp, seq) order from fetchAllEventsForJob sort
  return slices;
}

/**
 * Produce all time slices for every job in a plan, ordered by startedAt.
 *
 * Traversal: plan.epicIds → epic.orchestratorJobId (epic-dev jobs) +
 *            epic.stories[].jobId (per-story jobs). All job IDs are
 *            deduplicated before fetching to avoid duplicate slices from
 *            stories that share a job.
 *
 * NOTE: Overlapping slices are intentional — see module-level comment.
 *
 * Returns an empty array if the plan does not exist.
 */
export async function sliceForPlan(planId: string): Promise<TimerSlice[]> {
  const plan = await getPlanById(planId);
  if (!plan) return [];

  // Collect all job IDs across the plan, deduplicating
  const jobIds = new Set<string>();

  for (const epicId of plan.epicIds ?? []) {
    const epic = await getEpicById(epicId);
    if (!epic) continue;

    // Epic-dev orchestrator job (single job runs entire epic via orchestrator)
    if (epic.orchestratorJobId) {
      jobIds.add(epic.orchestratorJobId);
    }

    // Per-story jobs (legacy per-step pipeline or sub-agent dispatches)
    for (const story of epic.stories ?? []) {
      if (story.jobId) {
        jobIds.add(story.jobId);
      }
    }
  }

  // Fetch slices for each job and merge
  const allSlices: TimerSlice[] = [];

  await Promise.all(
    Array.from(jobIds).map(async (jobId) => {
      const slices = await sliceForJob(jobId);
      allSlices.push(...slices);
    }),
  );

  // Sort all slices by startedAt ascending
  allSlices.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  // PR-23b — emit synthetic machine-wait slices for inter-job gaps.
  //
  // The slicer's per-job pass only produces slices BETWEEN events within a
  // single job. Wave-boundary wait time (last event of wave-N's last job →
  // first event of wave-N+1's first job) is the cron's poll cycle plus
  // launch latency — typically 60-90 s per wave boundary. Without this
  // pass that time is lost: machine-wait reports as 0 % even when the
  // plan spent ~22 % of its wall-clock waiting for the cron to detect
  // wave close + launch the next wave.
  //
  // Algorithm: walk the SORTED slices and for each pair (A, B) where
  // A.jobId !== B.jobId AND B.startedAt > A.endedAt, insert a synthetic
  // slice spanning A.endedAt → B.startedAt with category='machine-wait'.
  //
  // Skipped when:
  //   • Same job (intra-job gaps already classified inside sliceForJob).
  //   • Negative gap (parallel siblings — wave-N stories overlap; one
  //     starts before the other finishes — that's NOT wait time).
  //   • Gap < 1000 ms (sub-second gaps are noise, not real waits).
  //
  // 2026-05-04 dino-runner-1 forensic showed 254 s of inter-job gaps
  // entirely missed; this surfaces them as machine-wait correctly.
  const filledSlices: TimerSlice[] = [];
  const INTER_JOB_GAP_MIN_MS = 1000;
  for (let i = 0; i < allSlices.length; i++) {
    filledSlices.push(allSlices[i]);
    const cur = allSlices[i];
    const next = allSlices[i + 1];
    if (!next) continue;
    if (cur.jobId === next.jobId) continue;
    const gapMs = new Date(next.startedAt).getTime() - new Date(cur.endedAt).getTime();
    if (gapMs < INTER_JOB_GAP_MIN_MS) continue;
    filledSlices.push({
      jobId: '__inter_job__',
      eventSeq: `${cur.eventSeq}->${next.eventSeq}`,
      category: 'machine-wait' as TimerCategory,
      startedAt: cur.endedAt,
      endedAt: next.startedAt,
      durationMs: gapMs,
      agentRole: 'orchestrator',
      eventType: 'status',
    });
  }

  return filledSlices;
}
