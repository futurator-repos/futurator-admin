import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
vi.mock('../lib/git-clone.mjs', () => ({
  cloneRepo: vi.fn(),
}));

// Mock the git rev-parse subprocess used by readGitHeadSha so brownfield
// tests don't need a real .git directory.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

import { runPartyBootstrap, PARTY_BOOTSTRAP_STEPS } from '../party-bootstrap.mjs';
import { installBmad } from '../lib/bmad-install.mjs';
import { syncCustomAgents } from '../lib/custom-agent-sync.mjs';
import { rebuildManifest } from '../lib/rebuild-manifest.mjs';
import { computeCustomAgentsSHA } from '../lib/custom-agents-sha.mjs';
import { cloneRepo } from '../lib/git-clone.mjs';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

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
  vi.mocked(cloneRepo).mockReset();
  spawnMock.mockReset();
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
    const final = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.bootstrap.completed');
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

    const completion = ctx.pushEvent.mock.calls.find((c) => c[3] === 'party.bootstrap.completed');
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

// ───────────────────────────────────────────────────────────────────────────
// Story 15.4 — brownfield bootstrap branch
// ───────────────────────────────────────────────────────────────────────────

function makeBrownfieldJob(overrides = {}) {
  return {
    jobId: 'job-brownfield',
    jobType: 'party-bootstrap',
    partyBootstrapPayload: {
      projectId: 'songster',
      projectPath,
      kind: 'brownfield',
      gitRepoUrl: 'https://github.com/foo/songster',
      gitBranch: 'main',
      ...overrides.payload,
    },
    ...overrides.top,
  };
}

function makeBrownfieldCtx(overrides = {}) {
  return {
    ...makeCtx(),
    loadBrownfieldPat: vi.fn(async () => 'ghp_fake_secret'),
    ...overrides,
  };
}

/**
 * Drives the mocked cloneRepo so it: (a) re-creates the project folder (real
 * git clone would do this) and (b) writes a fake bmad manifest at the legacy
 * path so the verify step passes.
 */
function arrangeCloneSuccess({ rows = 5 } = {}) {
  vi.mocked(cloneRepo).mockImplementation(async ({ targetPath }) => {
    mkdirSync(targetPath, { recursive: true });
    mkdirSync(`${targetPath}/bmad/_cfg`, { recursive: true });
    mkdirSync(`${targetPath}/bmad/agents`, { recursive: true });
    const header = 'name,role,description';
    const lines = [header];
    for (let i = 0; i < rows; i++) lines.push(`agent-${i},analyst,Mock agent ${i}`);
    writeFileSync(`${targetPath}/bmad/_cfg/agent-manifest.csv`, lines.join('\n') + '\n');
  });
}

function arrangeGitHeadSha(sha = 'abc1234567890') {
  spawnMock.mockImplementation((cmd, args) => {
    const child = new FakeChild();
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(sha + '\n'));
        child.emit('close', 0);
      });
    } else {
      setImmediate(() => child.emit('close', 0));
    }
    return child;
  });
}

describe('runPartyBootstrap — brownfield happy path (Story 15.4 AC #3)', () => {
  it('runs only clone-repo, verify, compute-sha, persist and transitions to HEALTHY', async () => {
    arrangeCloneSuccess({ rows: 6 });
    arrangeGitHeadSha('cafebabecafebabe');
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-brownfield');

    const ctx = makeBrownfieldCtx();
    const result = await runPartyBootstrap(makeBrownfieldJob(), ctx);

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('brownfield');
    expect(result.agentCount).toBe(6);
    expect(result.customAgentsSHA).toBe('sha-brownfield');
    expect(result.lastCommitSha).toBe('cafebabecafebabe');

    // installBmad / syncCustomAgents / rebuildManifest must NOT be called.
    expect(vi.mocked(installBmad)).not.toHaveBeenCalled();
    expect(vi.mocked(syncCustomAgents)).not.toHaveBeenCalled();
    expect(vi.mocked(rebuildManifest)).not.toHaveBeenCalled();

    // updateProjectState was called with HEALTHY + lastPulledAt + lastCommitSha.
    const persistCall = vi
      .mocked(ctx.updateProjectState)
      .mock.calls.find((c) => c[1].bmadStatus === 'HEALTHY');
    expect(persistCall).toBeTruthy();
    expect(persistCall[1].lastPulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(persistCall[1].lastCommitSha).toBe('cafebabecafebabe');
  });

  it('emits a party.bootstrap.completed event with kind=brownfield', async () => {
    arrangeCloneSuccess({ rows: 3 });
    arrangeGitHeadSha('deadbeef');
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeBrownfieldCtx();
    await runPartyBootstrap(makeBrownfieldJob(), ctx);

    const completedCall = vi
      .mocked(ctx.pushEvent)
      .mock.calls.find((c) => c[3] === 'party.bootstrap.completed');
    expect(completedCall).toBeTruthy();
    expect(completedCall[4]).toMatchObject({
      kind: 'brownfield',
      lastCommitSha: 'deadbeef',
    });
  });

  it('passes the PAT to cloneRepo but never lets it appear in event payloads (AC #4)', async () => {
    arrangeCloneSuccess();
    arrangeGitHeadSha();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeBrownfieldCtx({
      loadBrownfieldPat: vi.fn(async () => 'ghp_super_secret_xyz'),
    });
    await runPartyBootstrap(makeBrownfieldJob(), ctx);

    // cloneRepo received the token in args.
    const cloneArgs = vi.mocked(cloneRepo).mock.calls[0][0];
    expect(cloneArgs.token).toBe('ghp_super_secret_xyz');

    // No event payload contains the raw token.
    for (const call of vi.mocked(ctx.pushEvent).mock.calls) {
      const payload = JSON.stringify(call[4] || {});
      expect(payload).not.toContain('ghp_super_secret_xyz');
    }
  });
});

describe('runPartyBootstrap — brownfield failure paths (Story 15.4 AC #5)', () => {
  it('sets FAILED with failureReason=BMAD_NOT_FOUND_IN_REPO when manifest is missing', async () => {
    // Clone succeeds but produces no bmad/ tree.
    vi.mocked(cloneRepo).mockImplementation(async ({ targetPath }) => {
      mkdirSync(targetPath, { recursive: true });
      writeFileSync(`${targetPath}/README.md`, 'no bmad here');
    });
    arrangeGitHeadSha();

    const ctx = makeBrownfieldCtx();
    await expect(runPartyBootstrap(makeBrownfieldJob(), ctx)).rejects.toThrow(
      /bmad manifest not found/,
    );

    const failedCall = vi
      .mocked(ctx.updateProjectState)
      .mock.calls.find((c) => c[1].bmadStatus === 'FAILED');
    expect(failedCall).toBeTruthy();
    expect(failedCall[1].failureReason).toBe('BMAD_NOT_FOUND_IN_REPO');

    const failedEvent = vi
      .mocked(ctx.pushEvent)
      .mock.calls.find((c) => c[3] === 'party.bootstrap.failed');
    expect(failedEvent).toBeTruthy();
    expect(failedEvent[4].failureReason).toBe('BMAD_NOT_FOUND_IN_REPO');
  });

  it('sets FAILED when manifest exists but has zero rows', async () => {
    vi.mocked(cloneRepo).mockImplementation(async ({ targetPath }) => {
      mkdirSync(`${targetPath}/bmad/_cfg`, { recursive: true });
      writeFileSync(`${targetPath}/bmad/_cfg/agent-manifest.csv`, 'name,role,description\n');
    });
    arrangeGitHeadSha();

    const ctx = makeBrownfieldCtx();
    await expect(runPartyBootstrap(makeBrownfieldJob(), ctx)).rejects.toThrow(/empty/);

    const failedCall = vi
      .mocked(ctx.updateProjectState)
      .mock.calls.find((c) => c[1].bmadStatus === 'FAILED');
    expect(failedCall[1].failureReason).toBe('BMAD_NOT_FOUND_IN_REPO');
  });

  it('throws when loadBrownfieldPat returns null (secret missing or IAM denied)', async () => {
    const ctx = makeBrownfieldCtx({
      loadBrownfieldPat: vi.fn(async () => null),
    });
    await expect(runPartyBootstrap(makeBrownfieldJob(), ctx)).rejects.toThrow(
      /PAT not loaded/,
    );
    // cloneRepo must NOT have been called.
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });

  it('passes patSecretName from payload to loadBrownfieldPat (per-project PAT)', async () => {
    arrangeCloneSuccess();
    arrangeGitHeadSha();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const loadSpy = vi.fn(async () => 'ghp_per_project_token');
    const ctx = makeBrownfieldCtx({ loadBrownfieldPat: loadSpy });
    const job = makeBrownfieldJob();
    job.partyBootstrapPayload.patSecretName = 'futurator/brownfield-pat/songster';
    await runPartyBootstrap(job, ctx);

    expect(loadSpy).toHaveBeenCalledWith('futurator/brownfield-pat/songster');
  });

  it('writes envVars to <projectPath>/.env post-clone when payload includes them', async () => {
    arrangeCloneSuccess();
    arrangeGitHeadSha();
    vi.mocked(computeCustomAgentsSHA).mockReturnValue('sha-1');

    const ctx = makeBrownfieldCtx();
    const job = makeBrownfieldJob();
    job.partyBootstrapPayload.envVars = {
      OPENAI_API_KEY: 'sk-fake',
      LINKEDIN_API_KEY: 'li-fake',
    };
    await runPartyBootstrap(job, ctx);

    const envBody = readFileSync(`${projectPath}/.env`, 'utf8');
    expect(envBody).toContain('OPENAI_API_KEY="sk-fake"');
    expect(envBody).toContain('LINKEDIN_API_KEY="li-fake"');
  });
});
