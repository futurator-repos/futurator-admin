import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    agentJobs: 'test-agent-jobs',
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentEvents: 'test-agent-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
  },
}));

import { createEpic } from '../epic-workflow-repository';
import type { EpicWorkflow } from '../../types/epic-workflow';

function baseEpic(overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'epic-1',
    title: 'Test epic',
    description: 'desc',
    acceptanceCriteria: 'ac',
    workingDir: '/tmp/epic-1',
    status: 'draft',
    stories: [],
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function puttedItem() {
  const input = (sendMock.mock.calls[0][0] as { input: { Item: EpicWorkflow } }).input;
  return input.Item;
}

describe('createEpic — pipeline-mode default (2026-05-17, supersedes EO-7.2)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('defaults useEpicOrchestrator to false when the caller omits it', async () => {
    // 2026-05-17: flipped from `?? true` to `?? false`. EO-7.2's
    // orchestrator-default became dormant once Epic 17 introduced
    // Plan.executionMode, and all pre-Epic-17 legacy epics were wiped
    // on 2026-04-21. New epics created without explicit mode should
    // take the substrate pipeline path, not the orchestrator path.
    const epic = baseEpic();
    delete (epic as Partial<EpicWorkflow>).useEpicOrchestrator;

    const saved = await createEpic(epic);

    expect(saved.useEpicOrchestrator).toBe(false);
    expect(puttedItem().useEpicOrchestrator).toBe(false);
  });

  it('preserves useEpicOrchestrator: false when the caller explicitly sets it', async () => {
    const epic = baseEpic({ useEpicOrchestrator: false });
    const saved = await createEpic(epic);

    expect(saved.useEpicOrchestrator).toBe(false);
    expect(puttedItem().useEpicOrchestrator).toBe(false);
  });

  it('preserves useEpicOrchestrator: true when the caller explicitly sets it', async () => {
    const epic = baseEpic({ useEpicOrchestrator: true });
    const saved = await createEpic(epic);

    expect(saved.useEpicOrchestrator).toBe(true);
    expect(puttedItem().useEpicOrchestrator).toBe(true);
  });
});
