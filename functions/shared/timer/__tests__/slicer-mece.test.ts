// Gate G-4 — Timer Slicer MECE assertion (Story 1.8.2)
//
// Loads plan-fixture-1.json (hand-built, see fixture header comment for schema).
// Mocks all repository calls at the module boundary — no DynamoDB I/O.
//
// Asserts:
//   1. Σ slice.durationMs for the orchestrator job ≈ plan wall-clock ± 1000ms.
//   2. byCategory.unattributed.totalMs === 0.
//   3. byCategory.idle.totalMs > 0 (fixture has short epic_start + wave_complete slices).
//   4. dev, review, compile, human-wait, machine-wait all have non-zero totals.
//   5. The compile→idle downgrade fires for at least 2 slices (epic_start 350ms, wave_complete 200ms).
//   6. sliceForPlan returns slices sorted by startedAt.
//   7. sliceForPlan returns non-empty results (jobs discovered via plan.epicIds).
//   8. isLive is absent for all slices (terminal job in fixture).

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type { AgentEvent } from '../../types/agent-orchestrator';
import type { AgentJob } from '../../types/agent-orchestrator';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow } from '../../types/epic-workflow';
import { aggregateByCategory } from '../aggregator';

// ── Fixture data ─────────────────────────────────────────────────────────────

import fixture from './fixtures/plan-fixture-1.json';

// ── Vitest module mocks ───────────────────────────────────────────────────────
// Declared BEFORE any `import` of the slicer — Vitest hoists vi.mock() calls.

vi.mock('../../repositories/agent-events-repository', () => ({
  getEventsAfter: vi.fn(),
}));

vi.mock('../../repositories/agent-jobs-repository', () => ({
  getJobById: vi.fn(),
}));

vi.mock('../../repositories/plan-repository', () => ({
  getPlanById: vi.fn(),
}));

vi.mock('../../repositories/epic-workflow-repository', () => ({
  getEpicById: vi.fn(),
}));

// Import mocked modules (they are the vi.fn() stubs above)
import { getEventsAfter } from '../../repositories/agent-events-repository';
import { getJobById } from '../../repositories/agent-jobs-repository';
import { getPlanById } from '../../repositories/plan-repository';
import { getEpicById } from '../../repositories/epic-workflow-repository';

// Cast to typed mocks for autocomplete
const mockGetEventsAfter = getEventsAfter as MockedFunction<typeof getEventsAfter>;
const mockGetJobById = getJobById as MockedFunction<typeof getJobById>;
const mockGetPlanById = getPlanById as MockedFunction<typeof getPlanById>;
const mockGetEpicById = getEpicById as MockedFunction<typeof getEpicById>;

// Import the slicer AFTER mocks are hoisted
import { sliceForJob, sliceForPlan } from '../slicer';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const PLAN = fixture.plan as Plan;
const EPIC = fixture.epics[0] as EpicWorkflow;
const JOB = fixture.jobs['job-orch-1'] as AgentJob;
const EVENTS = (fixture.events['job-orch-1'] as AgentEvent[]).filter((e) => !('_comment' in e));

const PLAN_START_MS = new Date(fixture.meta.planStartedAt).getTime();
const PLAN_END_MS = new Date(fixture.meta.planEndedAt).getTime();
const PLAN_WALL_CLOCK_MS = PLAN_END_MS - PLAN_START_MS; // 600_000

/**
 * Configure mocks to serve the fixture data.
 * getEventsAfter simulates pagination: returns all events on the first call
 * (since events.length < PAGE_SIZE=200) and an empty array on subsequent calls.
 */
function setupMocks(): void {
  // getEventsAfter: return all events on first call (last item's seq < next cursor)
  mockGetEventsAfter.mockImplementation(async (jobId: string, afterSeq: string) => {
    if (jobId !== 'job-orch-1') {
      return { events: [], lastSeq: afterSeq };
    }
    // First call: afterSeq === '' — return all events
    // Subsequent calls with a non-empty afterSeq (cursor) return nothing
    if (afterSeq === '') {
      const events = [...EVENTS];
      const lastSeq = events[events.length - 1]?.eventSeq ?? '';
      return { events, lastSeq };
    }
    return { events: [], lastSeq: afterSeq };
  });

  mockGetJobById.mockImplementation(async (jobId: string) => {
    if (jobId === 'job-orch-1') return JOB;
    return null;
  });

  mockGetPlanById.mockImplementation(async (planId: string) => {
    if (planId === 'plan-fixture-1') return PLAN;
    return null;
  });

  mockGetEpicById.mockImplementation(async (epicId: string) => {
    if (epicId === 'epic-f1') return EPIC;
    return null;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Gate G-4 — Timer Slicer MECE (plan-fixture-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // ── sliceForJob ────────────────────────────────────────────────────────────

  describe('sliceForJob("job-orch-1")', () => {
    it('returns one slice per event (N events → N slices, last closes at job.updatedAt)', async () => {
      const slices = await sliceForJob('job-orch-1');
      // 31 events → 30 inter-event slices + 1 trailing (last event → updatedAt) = 31 slices
      expect(slices).toHaveLength(EVENTS.length);
    });

    it('slices are ordered by startedAt ascending', async () => {
      const slices = await sliceForJob('job-orch-1');
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].startedAt >= slices[i - 1].startedAt).toBe(true);
      }
    });

    it('no slice has isLive=true (terminal job)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const liveSlices = slices.filter((s) => s.isLive === true);
      expect(liveSlices).toHaveLength(0);
    });

    it('all slices carry the correct jobId', async () => {
      const slices = await sliceForJob('job-orch-1');
      expect(slices.every((s) => s.jobId === 'job-orch-1')).toBe(true);
    });

    it('no slice has a negative durationMs', async () => {
      const slices = await sliceForJob('job-orch-1');
      expect(slices.every((s) => s.durationMs >= 0)).toBe(true);
    });

    it('returns empty array for a non-existent jobId', async () => {
      const slices = await sliceForJob('job-nonexistent');
      expect(slices).toHaveLength(0);
    });
  });

  // ── MECE assertion ─────────────────────────────────────────────────────────

  describe('MECE: Σ durationMs ≈ plan wall-clock ± 1000ms', () => {
    it('sum of all slice durations is within 1000ms of plan wall-clock', async () => {
      const slices = await sliceForJob('job-orch-1');
      const totalMs = slices.reduce((acc, s) => acc + s.durationMs, 0);
      const diff = Math.abs(totalMs - PLAN_WALL_CLOCK_MS);
      expect(diff).toBeLessThanOrEqual(1000);
    });

    it('aggregateByCategory unattributed.totalMs === 0', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.unattributed.totalMs).toBe(0);
    });

    it('aggregateByCategory idle.totalMs > 0 (short lifecycle events downgraded)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      // epic_start (350ms) and wave_complete (200ms) → both downgraded to idle
      expect(byCategory.idle.totalMs).toBeGreaterThan(0);
    });

    it('idle slices total exactly 550ms (350ms epic_start + 200ms wave_complete)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.idle.totalMs).toBe(550);
    });

    it('idle count is 2 (exactly two short lifecycle slices in fixture)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.idle.count).toBe(2);
    });
  });

  // ── Category coverage ──────────────────────────────────────────────────────

  describe('category coverage (fixture includes all key categories)', () => {
    it('dev time is non-zero', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.dev.totalMs).toBeGreaterThan(0);
    });

    it('review time is non-zero', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.review.totalMs).toBeGreaterThan(0);
    });

    it('compile time is non-zero', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory.compile.totalMs).toBeGreaterThan(0);
    });

    it('human-wait time is non-zero (dev_blocker_reported window)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory['human-wait'].totalMs).toBeGreaterThan(0);
    });

    it('machine-wait time is non-zero (subagent_dispatch/return + status)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      expect(byCategory['machine-wait'].totalMs).toBeGreaterThan(0);
    });
  });

  // ── Idle downgrade specifics ───────────────────────────────────────────────

  describe('compile→idle downgrade', () => {
    it('slices with eventType=epic_start and durationMs<500 are downgraded to idle', async () => {
      const slices = await sliceForJob('job-orch-1');
      const epicStartSlices = slices.filter((s) => s.eventType === 'epic_start');
      // The slice starting at epic_start has duration 350ms → should be idle
      expect(epicStartSlices.length).toBeGreaterThan(0);
      for (const s of epicStartSlices) {
        if (s.durationMs < 500) {
          expect(s.category).toBe('idle');
        }
      }
    });

    it('slices with eventType=wave_complete and durationMs<500 are downgraded to idle', async () => {
      const slices = await sliceForJob('job-orch-1');
      const waveCompleteSlices = slices.filter(
        (s) => s.eventType === 'wave_complete' && s.durationMs < 500,
      );
      // wave_complete at 10:09:01.000 → epic_complete at 10:09:01.200 = 200ms
      expect(waveCompleteSlices.length).toBe(1);
      expect(waveCompleteSlices[0].category).toBe('idle');
    });

    it('slices with eventType=wave_complete and durationMs>=500 remain compile', async () => {
      const slices = await sliceForJob('job-orch-1');
      const longWaveCompleteSlices = slices.filter(
        (s) => s.eventType === 'wave_complete' && s.durationMs >= 500,
      );
      // wave_complete at 10:03:03 → wave_start at 10:03:04 = 1000ms → compile
      expect(longWaveCompleteSlices.length).toBe(1);
      expect(longWaveCompleteSlices[0].category).toBe('compile');
    });

    it('epic_complete slice (>500ms) is NOT downgraded to idle', async () => {
      const slices = await sliceForJob('job-orch-1');
      const epicCompleteSlices = slices.filter((s) => s.eventType === 'epic_complete');
      // epic_complete → job.updatedAt = 58800ms → compile
      expect(epicCompleteSlices.length).toBe(1);
      expect(epicCompleteSlices[0].category).toBe('compile');
      expect(epicCompleteSlices[0].durationMs).toBe(58800);
    });
  });

  // ── human-wait window ─────────────────────────────────────────────────────

  describe('human-wait window (dev_blocker_reported)', () => {
    it('slice starting at dev_blocker_reported is classified as human-wait', async () => {
      const slices = await sliceForJob('job-orch-1');
      const blockerSlice = slices.find((s) => s.eventType === 'dev_blocker_reported');
      expect(blockerSlice).toBeDefined();
      expect(blockerSlice?.category).toBe('human-wait');
    });

    it('human-wait slice spans 120000ms (10:05:00 → 10:07:00)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const blockerSlice = slices.find((s) => s.eventType === 'dev_blocker_reported');
      expect(blockerSlice?.durationMs).toBe(120_000);
    });
  });

  // ── sliceForPlan ───────────────────────────────────────────────────────────

  describe('sliceForPlan("plan-fixture-1")', () => {
    it('returns non-empty slices (discovers job via plan.epicIds → epic.orchestratorJobId)', async () => {
      const slices = await sliceForPlan('plan-fixture-1');
      expect(slices.length).toBeGreaterThan(0);
    });

    it('returns same slices as sliceForJob when plan has one job', async () => {
      const [planSlices, jobSlices] = await Promise.all([
        sliceForPlan('plan-fixture-1'),
        sliceForJob('job-orch-1'),
      ]);
      expect(planSlices).toHaveLength(jobSlices.length);
      // Spot-check first and last
      expect(planSlices[0].eventSeq).toBe(jobSlices[0].eventSeq);
      expect(planSlices[planSlices.length - 1].eventSeq).toBe(
        jobSlices[jobSlices.length - 1].eventSeq,
      );
    });

    it('returned slices are sorted by startedAt', async () => {
      const slices = await sliceForPlan('plan-fixture-1');
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i].startedAt >= slices[i - 1].startedAt).toBe(true);
      }
    });

    it('returns empty for non-existent planId', async () => {
      const slices = await sliceForPlan('plan-nonexistent');
      expect(slices).toHaveLength(0);
    });
  });

  // ── aggregator standalone ─────────────────────────────────────────────────

  describe('aggregateByCategory', () => {
    it('every TimerCategory key is present in byCategory (including zero-count buckets)', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory } = aggregateByCategory(slices);
      const ALL_CATEGORIES = [
        'dev',
        'test-author',
        'test-execute',
        'review',
        'qa',
        'po',
        'architect',
        'compile',
        'human-wait',
        'machine-wait',
        'git',
        'bootstrap',
        'fix',
        'idle',
        'unattributed',
      ];
      for (const cat of ALL_CATEGORIES) {
        expect(byCategory).toHaveProperty(cat);
        expect(byCategory[cat as keyof typeof byCategory].totalMs).toBeGreaterThanOrEqual(0);
      }
    });

    it('totalMs equals sum of byCategory totals', async () => {
      const slices = await sliceForJob('job-orch-1');
      const { byCategory, totalMs } = aggregateByCategory(slices);
      const sumFromCategories = Object.values(byCategory).reduce(
        (acc, { totalMs: ms }) => acc + ms,
        0,
      );
      expect(totalMs).toBe(sumFromCategories);
    });

    it('aggregates an empty slice array without throwing', () => {
      const { byCategory, totalMs } = aggregateByCategory([]);
      expect(totalMs).toBe(0);
      expect(byCategory.dev.totalMs).toBe(0);
      expect(byCategory.unattributed.totalMs).toBe(0);
    });
  });

  // ── Live tail ─────────────────────────────────────────────────────────────

  describe('live-tail slice (non-terminal job)', () => {
    it('emits isLive=true for the trailing slice when job is RUNNING', async () => {
      // Override the mock to return a RUNNING job
      const runningJob: AgentJob = {
        ...JOB,
        status: 'RUNNING',
        // updatedAt can stay — slicer uses Date.now() for live jobs
      };
      mockGetJobById.mockResolvedValueOnce(runningJob);

      const slices = await sliceForJob('job-orch-1');
      const lastSlice = slices[slices.length - 1];
      expect(lastSlice.isLive).toBe(true);
    });

    it('live trailing slice has a positive durationMs', async () => {
      const runningJob: AgentJob = { ...JOB, status: 'RUNNING' };
      mockGetJobById.mockResolvedValueOnce(runningJob);

      const slices = await sliceForJob('job-orch-1');
      const lastSlice = slices[slices.length - 1];
      expect(lastSlice.durationMs).toBeGreaterThan(0);
    });

    it('non-last slices do not carry isLive for a RUNNING job', async () => {
      const runningJob: AgentJob = { ...JOB, status: 'RUNNING' };
      mockGetJobById.mockResolvedValueOnce(runningJob);

      const slices = await sliceForJob('job-orch-1');
      const nonLast = slices.slice(0, -1);
      expect(nonLast.every((s) => !s.isLive)).toBe(true);
    });
  });
});
