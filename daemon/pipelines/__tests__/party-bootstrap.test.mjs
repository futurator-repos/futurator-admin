import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the subprocess-invoking libs so the orchestration can be tested
// in isolation without running npx / rsync / git.
vi.mock('../lib/bmad-install.mjs', () => ({
  installBmad: vi.fn(),
}));
vi.mock('../lib/custom-agent-sync.mjs', () => ({
  syncCustomAgents: vi.fn(),
}));
vi.mock('../lib/rebuild-manifest.mjs', () => ({
  rebuildManifest: vi.fn(),
}));
vi.mock('../lib/custom-agents-sha.mjs', () => ({
  computeCustomAgentsSHA: vi.fn(),
}));

import { runPartyBootstrap, PARTY_BOOTSTRAP_STEPS } from '../party-bootstrap.mjs';
import { installBmad } from '../lib/bmad-install.mjs';
import { syncCustomAgents } from '../lib/custom-agent-sync.mjs';
import { rebuildManifest } from '../lib/rebuild-manifest.mjs';
import { computeCustomAgentsSHA } from '../lib/custom-agents-sha.mjs';

let projectPath;

function makeCtx(overrides = {}) {
  return {
    pushEvent: vi.fn(async () => {}),
    updateProjectState: vi.fn(async () => {}),
    expectedBmadVersion: '6.0.0-alpha.7',
    customAgentsSourceDir: '/tmp/source/bmad/agents',
    customAgentsSourceRepo: '/tmp/source',
    expectedAgentCount: 23,
    projectsRoot: projectPath.slice(0, projectPath.lastIndexOf('/')),
    ...overrides,
  };
}

function makeJob() {
  return {
    jobId: 'job-test',
    jobType: 'party-bootstrap',
    partyBootstrapPayload: {
      projectId: 'battleship',
      projectPath,
      forceReinstall: false,
    },
  };
}

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'party-bootstrap-proj-'));
  mkdirSync(projectPath, { recursive: true });
  vi.mocked(installBmad).mockReset();
  vi.mocked(syncCustomAgents).mockReset();
  vi.mocked(rebuildManifest).mockReset();
  vi.mocked(computeCustomAgentsSHA).mockReset();
});

describe('runPartyBootstrap — happy path', () => {
  it('runs all 8 steps in order and transitions to HEALTHY', async () => {
    vi.mocked(installBmad).mockResolvedValue({
      skipped: false,
      installedVersion: '6.0.0-alpha.7',
    });
    vi.mocked(syncCustomAgents).mockResolvedValue({ stdout: '', stderr: '' });
    vi.mocked(rebuildManifest).mockResolvedValue(23);
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('deadbeef');

    const ctx = makeCtx();
    const result = await runPartyBootstrap(makeJob(), ctx);

    expect(result.ok).toBe(true);
    expect(result.bmadVersion).toBe('6.0.0-alpha.7');
    expect(result.agentCount).toBe(23);
    expect(result.customAgentsSHA).toBe('deadbeef');

    // Verify all 8 steps emitted start + complete events.
    const startedSteps = ctx.pushEvent.mock.calls
      .filter((c) => c[3] === 'party.bootstrap.step.started')
      .map((c) => c[4].step);
    expect(startedSteps).toEqual(PARTY_BOOTSTRAP_STEPS);

    // Final update to HEALTHY.
    expect(ctx.updateProjectState).toHaveBeenCalledWith(
      'battleship',
      expect.objectContaining({
        bmadStatus: 'HEALTHY',
        bmadVersion: '6.0.0-alpha.7',
        customAgentsSHA: 'deadbeef',
        agentCount: 23,
      }),
    );

    // Completion event emitted.
    const final = ctx.pushEvent.mock.calls.find(
      (c) => c[3] === 'party.bootstrap.completed',
    );
    expect(final).toBeTruthy();
  });
});

describe('runPartyBootstrap — idempotency', () => {
  it('marks install as skipped when bmad-install reports skipped', async () => {
    vi.mocked(installBmad).mockResolvedValue({
      skipped: true,
      reason: 'version-match',
      installedVersion: '6.0.0-alpha.7',
    });
    vi.mocked(syncCustomAgents).mockResolvedValue({ stdout: '', stderr: '' });
    vi.mocked(rebuildManifest).mockResolvedValue(23);
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('deadbeef');

    const ctx = makeCtx();
    await runPartyBootstrap(makeJob(), ctx);

    const completion = ctx.pushEvent.mock.calls.find(
      (c) => c[3] === 'party.bootstrap.completed',
    );
    expect(completion[4].skippedInstall).toBe(true);
  });
});

describe('runPartyBootstrap — failure modes', () => {
  it('marks FAILED and emits .failed when install throws', async () => {
    vi.mocked(installBmad).mockRejectedValue(new Error('registry 503'));
    const ctx = makeCtx();
    await expect(runPartyBootstrap(makeJob(), ctx)).rejects.toThrow('registry 503');

    // Verify FAILED persisted.
    const failedUpdate = ctx.updateProjectState.mock.calls.find(
      (c) => c[1].bmadStatus === 'FAILED',
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate[1].failureReason).toContain('bmad-install');
    expect(failedUpdate[1].failureReason).toContain('registry 503');

    // Verify .failed emitted.
    const failed = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.bootstrap.failed');
    expect(failed).toBeTruthy();
  });

  it('marks FAILED when manifest row count is below the minimum sanity floor', async () => {
    vi.mocked(installBmad).mockResolvedValue({
      skipped: false,
      installedVersion: '6.3.0',
    });
    vi.mocked(syncCustomAgents).mockResolvedValue({ stdout: '', stderr: '' });
    vi.mocked(rebuildManifest).mockResolvedValue(2); // well under the 5-row floor
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('deadbeef');

    const ctx = makeCtx();
    await expect(runPartyBootstrap(makeJob(), ctx)).rejects.toThrow(
      /at least 5 rows required, got 2/,
    );

    const failedUpdate = ctx.updateProjectState.mock.calls.find(
      (c) => c[1].bmadStatus === 'FAILED',
    );
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate[1].failureReason).toContain('verify');
  });

  it('rejects projectPath outside projectsRoot', async () => {
    const ctx = makeCtx({ projectsRoot: '/somewhere/else' });
    await expect(runPartyBootstrap(makeJob(), ctx)).rejects.toThrow(/must be under/);
    expect(vi.mocked(installBmad)).not.toHaveBeenCalled();
  });

  it('rejects when projectPath does not exist (but is within projectsRoot)', async () => {
    const ctx = makeCtx();
    const job = makeJob();
    // Keep path inside projectsRoot so validation reaches the existence check.
    job.partyBootstrapPayload.projectPath = join(ctx.projectsRoot, 'not-a-real-folder');
    await expect(runPartyBootstrap(job, ctx)).rejects.toThrow(/does not exist/);
    expect(vi.mocked(installBmad)).not.toHaveBeenCalled();
  });
});
