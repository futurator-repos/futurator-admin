import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapPlanFolder,
  writePlanMarkdown,
  movePlanFolderToTrash,
  restorePlanFolder,
  deletePlanFolder,
} from '../plan-folder-service';
import type { Plan } from '../../types/plan';

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    name: 'pong-classic',
    intent: 'Create a Pong game',
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/pong-classic',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-21T10:00:00.000Z',
    updatedAt: '2026-04-21T10:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function makeDeps(output: string) {
  return {
    sendSsmCommand: vi.fn(async (_cmd: string) => 'cmd-id-1'),
    waitForSsmOutput: vi.fn(async (_id: string, _t?: number) => output),
  };
}

describe('plan-folder-service — safe-path guard', () => {
  it('rejects unsafe plan names in bootstrap', async () => {
    const plan = basePlan({ name: '../etc/passwd' });
    const deps = makeDeps('BOOTSTRAPPED');
    await expect(bootstrapPlanFolder(plan, [], deps)).rejects.toThrow(/does not match safe pattern/);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });

  it('rejects unsafe names in writePlanMarkdown', async () => {
    const plan = basePlan({ name: 'rm -rf /' });
    const deps = makeDeps('');
    await expect(writePlanMarkdown(plan, [], deps)).rejects.toThrow(/does not match safe pattern/);
  });

  it('rejects restore when archivePath is outside .trash', async () => {
    const plan = basePlan({ archivePath: '/etc/passwd' });
    const deps = makeDeps('');
    await expect(restorePlanFolder(plan, deps)).rejects.toThrow(/not in \.trash/);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });
});

describe('bootstrapPlanFolder', () => {
  it('sends mkdir + heredoc write command', async () => {
    const plan = basePlan();
    const deps = makeDeps(`BOOTSTRAPPED /home/ubuntu/projects/${plan.name}`);
    await bootstrapPlanFolder(plan, [], deps);
    const cmd = deps.sendSsmCommand.mock.calls[0]![0];
    expect(cmd).toContain('mkdir -p /home/ubuntu/projects/pong-classic');
    expect(cmd).toContain('__PLAN_MD_EOF__');
    expect(cmd).toContain('# Plan: pong-classic');
  });

  it('throws when SSM output does not confirm bootstrap', async () => {
    const plan = basePlan();
    const deps = makeDeps('permission denied');
    await expect(bootstrapPlanFolder(plan, [], deps)).rejects.toThrow(/bootstrap failed/);
  });
});

describe('movePlanFolderToTrash', () => {
  it('returns the .trash path and checks ARCHIVED marker', async () => {
    const plan = basePlan();
    const ts = '2026-04-21T10:00:00.000Z';
    const deps = makeDeps(`ARCHIVED /home/ubuntu/.trash/plans/pong-classic-2026-04-21T10-00-00-000Z`);
    const archivePath = await movePlanFolderToTrash(plan, ts, deps);
    expect(archivePath).toContain('/home/ubuntu/.trash/plans/pong-classic-');
  });

  it('tolerates already-archived (NO_FOLDER) path', async () => {
    const plan = basePlan();
    const deps = makeDeps('NO_FOLDER (already archived or never created)');
    await expect(movePlanFolderToTrash(plan, '2026-04-21T10:00:00.000Z', deps)).resolves.toBeTruthy();
  });
});

describe('deletePlanFolder', () => {
  it('rm-rfs both projects/ and .trash/ paths when archivePath is set', async () => {
    const plan = basePlan({ archivePath: '/home/ubuntu/.trash/plans/pong-classic-foo' });
    const deps = makeDeps('DELETED');
    await deletePlanFolder(plan, deps);
    const cmd = deps.sendSsmCommand.mock.calls[0]![0];
    expect(cmd).toContain('rm -rf "/home/ubuntu/projects/pong-classic"');
    expect(cmd).toContain('rm -rf "/home/ubuntu/.trash/plans/pong-classic-foo"');
  });
});
