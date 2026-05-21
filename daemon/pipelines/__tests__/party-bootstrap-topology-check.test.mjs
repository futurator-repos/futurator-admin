import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/git-clone.mjs', () => ({
  cloneRepo: vi.fn(),
}));

import { runPartyBootstrap } from '../party-bootstrap.mjs';
import { cloneRepo } from '../lib/git-clone.mjs';

/**
 * Story 20.5 — party-bootstrap topology gate.
 *
 * When ctx.checkBareRepoExists is wired AND returns false for the expected
 * bare repo path, runBrownfieldBootstrap must abort with TOPOLOGY_NOT_MIGRATED
 * BEFORE running any of the clone/verify/persist steps.
 */

let projectsRoot;
let projectPath;

function makeCtx(overrides = {}) {
  return {
    pushEvent: vi.fn(),
    updateProjectState: vi.fn(),
    loadBrownfieldPat: vi.fn(async () => 'ghp_fake'),
    projectsRoot,
    ...overrides,
  };
}

function brownfieldJob() {
  return {
    jobId: 'job-1',
    partyBootstrapPayload: {
      projectId: 'applicator',
      projectPath,
      kind: 'brownfield',
      gitRepoUrl: 'https://github.com/x/applicator.git',
      gitBranch: 'main',
    },
  };
}

beforeEach(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), 'topo-check-projects-'));
  projectPath = join(projectsRoot, 'applicator');
  mkdirSync(projectPath, { recursive: true });
  vi.mocked(cloneRepo).mockReset();
});

afterEach: {
  // (vitest's afterEach is unused here; cleanup happens via test isolation +
  // the OS reaping tmpdirs eventually. We keep tests focused on the gate.)
}

describe('Story 20.5 — TOPOLOGY_NOT_MIGRATED gate', () => {
  it('aborts brownfield bootstrap when checkBareRepoExists returns false', async () => {
    const ctx = makeCtx({
      checkBareRepoExists: vi.fn(async () => false),
    });
    await expect(runPartyBootstrap(brownfieldJob(), ctx)).rejects.toThrow(
      /TOPOLOGY_NOT_MIGRATED/,
    );

    // cloneRepo MUST NOT have been called — abort happens before the clone step.
    expect(cloneRepo).not.toHaveBeenCalled();

    // The party.bootstrap.step.failed event should carry suggestedAction.
    const failedCalls = ctx.pushEvent.mock.calls.filter(
      (call) => call[3] === 'party.bootstrap.step.failed',
    );
    expect(failedCalls.length).toBeGreaterThan(0);
    const payload = failedCalls[0][4];
    expect(payload.step).toBe('topology-check');
    expect(payload.reason).toBe('TOPOLOGY_NOT_MIGRATED');
    expect(payload.suggestedAction).toBe('run-admin-migrate');
    expect(payload.migrateEndpoint).toContain('/api/admin/migrate-brownfield/applicator');
  });

  it('aborts when checkBareRepoExists throws (fail-safe)', async () => {
    const ctx = makeCtx({
      checkBareRepoExists: vi.fn(async () => {
        throw new Error('SSM connection refused');
      }),
    });
    await expect(runPartyBootstrap(brownfieldJob(), ctx)).rejects.toThrow(
      /TOPOLOGY_NOT_MIGRATED/,
    );
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('proceeds when checkBareRepoExists returns true', async () => {
    // Arrange cloneRepo to fake a successful clone that produces a valid
    // BMAD manifest so the bootstrap doesn't abort on the subsequent verify step.
    vi.mocked(cloneRepo).mockImplementation(async ({ targetPath }) => {
      mkdirSync(`${targetPath}/bmad/_cfg`, { recursive: true });
      mkdirSync(`${targetPath}/bmad/agents`, { recursive: true });
      const csv = ['name,role,description', 'a,analyst,A', 'b,dev,B', 'c,pm,C', 'd,arch,D', 'e,ux,E']
        .join('\n');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${targetPath}/bmad/_cfg/agent-manifest.csv`, csv + '\n');
    });

    const ctx = makeCtx({
      checkBareRepoExists: vi.fn(async () => true),
    });

    // The bootstrap will run through more steps; we just verify it gets
    // past the topology gate without throwing TOPOLOGY_NOT_MIGRATED.
    let topologyError = null;
    try {
      await runPartyBootstrap(brownfieldJob(), ctx);
    } catch (err) {
      if (/TOPOLOGY_NOT_MIGRATED/.test(err.message)) topologyError = err;
      // Other failures (compute-sha, persist) are unrelated to this test —
      // we only care that the topology gate didn't fire.
    }
    expect(topologyError).toBeNull();
    expect(ctx.checkBareRepoExists).toHaveBeenCalledWith('/home/ubuntu/repos/applicator.git');
  });

  it('rolls out safely — no check fires when ctx.checkBareRepoExists is undefined (back-compat)', async () => {
    vi.mocked(cloneRepo).mockImplementation(async ({ targetPath }) => {
      mkdirSync(`${targetPath}/bmad/_cfg`, { recursive: true });
      mkdirSync(`${targetPath}/bmad/agents`, { recursive: true });
      const csv = ['name,role,description', 'a,analyst,A', 'b,dev,B', 'c,pm,C', 'd,arch,D', 'e,ux,E']
        .join('\n');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${targetPath}/bmad/_cfg/agent-manifest.csv`, csv + '\n');
    });
    const ctx = makeCtx(); // no checkBareRepoExists

    let topologyError = null;
    try {
      await runPartyBootstrap(brownfieldJob(), ctx);
    } catch (err) {
      if (/TOPOLOGY_NOT_MIGRATED/.test(err.message)) topologyError = err;
    }
    expect(topologyError).toBeNull();
    // cloneRepo SHOULD have been called — bootstrap proceeded past the gate.
    expect(cloneRepo).toHaveBeenCalled();
  });
});
