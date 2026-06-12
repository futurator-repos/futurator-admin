// pong1 P2 (2026-06-12) — wave-gate slice attribution.
//
// pong1 forensic: 41% of the plan's wall-clock booked as 'machine-wait'
// because every wave-merge runner line streams as a 'status' event (default
// machine-wait) under stepId 'wave-merge'. The fix routes those slices to
// 'merge-gate', and lines carrying the '[wave-vqa]' text prefix to
// 'vqa-gate', so gate work is attributed instead of hidden.

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type { AgentEvent, AgentJob } from '../../types/agent-orchestrator';
import { aggregateByCategory } from '../aggregator';

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

import { getEventsAfter } from '../../repositories/agent-events-repository';
import { getJobById } from '../../repositories/agent-jobs-repository';

const mockGetEventsAfter = getEventsAfter as MockedFunction<typeof getEventsAfter>;
const mockGetJobById = getJobById as MockedFunction<typeof getJobById>;

import { sliceForJob } from '../slicer';

const T0 = new Date('2026-06-12T00:00:00.000Z').getTime();
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const GATE_JOB: AgentJob = {
  jobId: 'job-gate-1',
  status: 'COMPLETED',
  createdAt: at(0),
  updatedAt: at(150),
  createdBy: 'fixture',
  workingDir: '/home/ubuntu/worktrees/app/plan',
  jobType: 'wave-merge',
  retryAttempt: 0,
  phase: 'wave-merge',
  epicId: 'epic-g1',
} as unknown as AgentJob;

// The exact emission shape from agent-daemon's waveLog tee: every runner
// line is pushEvent(jobId, 'wave-merge', 'MERGE', 'status'|'step_error',
// { text }). VQA-stage lines carry the '[wave-vqa]' prefix (vlog in
// wave-vqa-runner.mjs).
function gateEvent(seq: number, offsetSec: number, eventType: string, text: string): AgentEvent {
  return {
    jobId: 'job-gate-1',
    eventSeq: String(seq).padStart(4, '0'),
    seq,
    timestamp: at(offsetSec),
    stepId: 'wave-merge',
    agentId: 'MERGE',
    eventType,
    text,
    expireAt: 9999999999,
  } as unknown as AgentEvent;
}

const GATE_EVENTS: AgentEvent[] = [
  gateEvent(1, 0, 'status', 'Creating merge candidate for wave 2 (3 stories)'),
  gateEvent(2, 30, 'status', '[wave-vqa] evidence capture started (port 3700)'),
  gateEvent(3, 90, 'status', '[wave-vqa] judge panel: 3/3 PASS on AC-S5-1'),
  gateEvent(4, 120, 'status', 'advance-on-green: plan branch fast-forwarded'),
  // terminal tail: 120s → updatedAt 150s
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetJobById.mockResolvedValue(GATE_JOB);
  mockGetEventsAfter.mockImplementation(async (jobId: string) => {
    if (jobId !== 'job-gate-1') return { events: [], lastSeq: '000000' };
    return { events: GATE_EVENTS, lastSeq: '0004' };
  });
});

describe('pong1 P2 — wave-merge job slices attribute to merge-gate / vqa-gate', () => {
  it('splits gate time: plain runner lines → merge-gate, [wave-vqa] lines → vqa-gate', async () => {
    const slices = await sliceForJob('job-gate-1');
    expect(slices).toHaveLength(4);

    const { byCategory } = aggregateByCategory(slices);
    // e1→e2 (30s) + e4→end (30s) are merge work.
    expect(byCategory['merge-gate'].totalMs).toBe(60_000);
    // e2→e3 (60s) + e3→e4 (30s) are VQA work.
    expect(byCategory['vqa-gate'].totalMs).toBe(90_000);
    // The pong1 disease: NONE of this may book as machine-wait anymore.
    expect(byCategory['machine-wait'].totalMs).toBe(0);
    expect(byCategory['unattributed'].totalMs).toBe(0);
  });

  it('step_error lines from the VQA stage stay in vqa-gate (override beats the fix default)', async () => {
    mockGetEventsAfter.mockImplementation(async () => ({
      events: [
        gateEvent(1, 0, 'status', '[wave-vqa] fixer round 1 starting'),
        gateEvent(2, 60, 'step_error', '[wave-vqa] fixer round 1 produced no improvement'),
      ],
      lastSeq: '0002',
    }));
    const slices = await sliceForJob('job-gate-1');
    expect(slices.every((s) => s.category === 'vqa-gate')).toBe(true);
  });
});
