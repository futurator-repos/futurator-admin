import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

vi.mock('../lib/custom-agents-sha.mjs', () => ({
  computeCustomAgentsSHA: vi.fn(),
}));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

import { runPartyRefresh, PARTY_REFRESH_STEPS } from '../party-refresh.mjs';
import { computeCustomAgentsSHA } from '../lib/custom-agents-sha.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

let projectPath;

function seedBmadManifest(rows = 5) {
  mkdirSync(`${projectPath}/bmad/_cfg`, { recursive: true });
  mkdirSync(`${projectPath}/bmad/agents`, { recursive: true });
  const lines = ['name,role,description'];
  for (let i = 0; i < rows; i++) lines.push(`agent-${i},analyst,Mock ${i}`);
  writeFileSync(`${projectPath}/bmad/_cfg/agent-manifest.csv`, lines.join('\n') + '\n');
}

function makeCtx(overrides = {}) {
  return {
    pushEvent: vi.fn(async () => {}),
    tryAcquireRefreshLock: vi.fn(async () => ({ ok: true })),
    releaseRefreshLock: vi.fn(async () => {}),
    updateProjectAfterRefresh: vi.fn(async () => {}),
    projectsRoot: projectPath.slice(0, projectPath.lastIndexOf('/')),
    ...overrides,
  };
}

function makeJob() {
  return {
    jobId: 'job-refresh',
    jobType: 'party-refresh',
    partyRefreshPayload: {
      projectId: 'songster',
      projectPath,
      gitBranch: 'main',
    },
  };
}

/**
 * Drive subprocess mock: git fetch+reset succeeds, git rev-parse HEAD returns
 * a fixed SHA. Any unmatched command returns a clean close.
 */
function arrangeSubprocesses({ headSha = 'abc1234567', fetchExitCode = 0 } = {}) {
  spawnMock.mockImplementation((cmd, args) => {
    const child = new FakeChild();
    if (cmd === 'bash' && Array.isArray(args) && args[0] === '-c') {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`fetching origin\n`));
        child.emit('close', fetchExitCode);
      });
    } else if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(headSha + '\n'));
        child.emit('close', 0);
      });
    } else {
      setImmediate(() => child.emit('close', 0));
    }
    return child;
  });
}

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'party-refresh-proj-'));
  mkdirSync(projectPath, { recursive: true });
  spawnMock.mockReset();
  vi.mocked(computeCustomAgentsSHA).mockReset();
});

describe('runPartyRefresh — happy path', () => {
  it('runs all 6 steps and transitions to HEALTHY (AC #6)', async () => {
    seedBmadManifest(6);
    arrangeSubprocesses({ headSha: 'cafebabe' });
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-refresh');

    const ctx = makeCtx();
    const result = await runPartyRefresh(makeJob(), ctx);

    expect(result.ok).toBe(true);
    expect(result.lastCommitSha).toBe('cafebabe');
    expect(result.customAgentsSHA).toBe('sha-refresh');
    expect(result.agentCount).toBe(6);

    expect(vi.mocked(ctx.tryAcquireRefreshLock)).toHaveBeenCalledWith('songster');
    expect(vi.mocked(ctx.releaseRefreshLock)).toHaveBeenCalledWith('songster', 'HEALTHY');
    expect(vi.mocked(ctx.updateProjectAfterRefresh)).toHaveBeenCalledWith(
      'songster',
      expect.objectContaining({
        lastCommitSha: 'cafebabe',
        customAgentsSHA: 'sha-refresh',
        agentCount: 6,
      }),
    );
  });

  it('emits party.refresh.completed with the new SHA', async () => {
    seedBmadManifest(3);
    arrangeSubprocesses({ headSha: 'deadbeef' });
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeCtx();
    await runPartyRefresh(makeJob(), ctx);

    const completed = vi
      .mocked(ctx.pushEvent)
      .mock.calls.find((c) => c[3] === 'party.refresh.completed');
    expect(completed).toBeTruthy();
    expect(completed[4]).toMatchObject({ projectId: 'songster', lastCommitSha: 'deadbeef' });
  });

  it('exposes PARTY_REFRESH_STEPS as the canonical step list', () => {
    expect(PARTY_REFRESH_STEPS).toEqual([
      'acquire-lock',
      'git-fetch-reset',
      'compute-sha',
      'verify',
      'read-head-sha',
      'persist',
    ]);
  });

  it('emits one party.refresh.started (pipeline) and one party.refresh.step.started per step', async () => {
    seedBmadManifest();
    arrangeSubprocesses();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeCtx();
    await runPartyRefresh(makeJob(), ctx);

    const startedEvents = vi
      .mocked(ctx.pushEvent)
      .mock.calls.filter((c) => c[3] === 'party.refresh.started');
    const stepStartedEvents = vi
      .mocked(ctx.pushEvent)
      .mock.calls.filter((c) => c[3] === 'party.refresh.step.started');

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0][4]).toMatchObject({ projectId: 'songster', gitBranch: 'main' });
    expect(stepStartedEvents.map((c) => c[4].step)).toEqual(PARTY_REFRESH_STEPS);
  });

  it('streams git output as party.refresh.step.output (not step.completed)', async () => {
    seedBmadManifest();
    arrangeSubprocesses();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeCtx();
    await runPartyRefresh(makeJob(), ctx);

    const outputEvents = vi
      .mocked(ctx.pushEvent)
      .mock.calls.filter((c) => c[3] === 'party.refresh.step.output');
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(outputEvents[0][4]).toHaveProperty('stream');
    expect(outputEvents[0][4]).toHaveProperty('data');

    // step.completed must NOT carry a `stream` field (would mean output is
    // still being misrouted into completion events).
    const stepCompletedWithStream = vi
      .mocked(ctx.pushEvent)
      .mock.calls.filter((c) => c[3] === 'party.refresh.step.completed' && c[4].stream);
    expect(stepCompletedWithStream).toHaveLength(0);
  });
});

describe('runPartyRefresh — failure paths (AC #6, AC #7)', () => {
  it('rejects when tryAcquireRefreshLock fails (REFRESH_IN_PROGRESS)', async () => {
    seedBmadManifest();
    arrangeSubprocesses();
    const ctx = makeCtx({
      tryAcquireRefreshLock: vi.fn(async () => ({ ok: false, reason: 'REFRESH_IN_PROGRESS' })),
    });
    await expect(runPartyRefresh(makeJob(), ctx)).rejects.toThrow(/REFRESH_IN_PROGRESS/);
    // Lock was never held — release should NOT have been called.
    expect(vi.mocked(ctx.releaseRefreshLock)).not.toHaveBeenCalled();
  });

  it('releases lock to FAILED when git fetch errors', async () => {
    seedBmadManifest();
    arrangeSubprocesses({ fetchExitCode: 1 });

    const ctx = makeCtx();
    await expect(runPartyRefresh(makeJob(), ctx)).rejects.toThrow(/exited with code 1/);
    expect(vi.mocked(ctx.releaseRefreshLock)).toHaveBeenCalledWith('songster', 'FAILED');
    expect(vi.mocked(ctx.updateProjectAfterRefresh)).not.toHaveBeenCalled();
  });

  it('releases lock to FAILED when manifest is missing after reset', async () => {
    // Manifest absent (forgot seedBmadManifest).
    arrangeSubprocesses();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha');

    const ctx = makeCtx();
    await expect(runPartyRefresh(makeJob(), ctx)).rejects.toThrow(/BMAD_NOT_FOUND_IN_REPO/);
    expect(vi.mocked(ctx.releaseRefreshLock)).toHaveBeenCalledWith('songster', 'FAILED');
  });

  it('throws when projectPath does not exist', async () => {
    const ctx = makeCtx();
    const job = makeJob();
    // Use a path under projectsRoot so the "must be under" guard passes but
    // the existsSync check fails.
    job.partyRefreshPayload.projectPath = join(ctx.projectsRoot, 'not-a-real-folder-xyz');
    await expect(runPartyRefresh(job, ctx)).rejects.toThrow(/does not exist/);
    expect(vi.mocked(ctx.tryAcquireRefreshLock)).not.toHaveBeenCalled();
  });

  it('emits party.refresh.failed with the step that failed', async () => {
    seedBmadManifest();
    arrangeSubprocesses({ fetchExitCode: 1 });
    const ctx = makeCtx();
    await expect(runPartyRefresh(makeJob(), ctx)).rejects.toThrow();
    const failed = vi.mocked(ctx.pushEvent).mock.calls.find((c) => c[3] === 'party.refresh.failed');
    expect(failed).toBeTruthy();
    expect(failed[4].step).toBe('git-fetch-reset');
  });
});
