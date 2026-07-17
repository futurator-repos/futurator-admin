import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import {
  remapDaemonPath,
  remapPathsInText,
  remapJobPaths,
  isRemapActive,
} from '../path-remap.mjs';

const MAC_PROJECTS = '/Users/rick/FuturatorFleet/projects';
const MAC_WORKTREES = '/Users/rick/FuturatorFleet/worktrees';

// Snapshot + restore the two env knobs so the suite is hermetic regardless of
// what the host shell exports (the Mac runner script sets both for real runs).
let savedProjects;
let savedWorktrees;
beforeEach(() => {
  savedProjects = process.env.PROJECTS_ROOT;
  savedWorktrees = process.env.FUTURATOR_WORKTREE_ROOT;
  delete process.env.PROJECTS_ROOT;
  delete process.env.FUTURATOR_WORKTREE_ROOT;
});
afterEach(() => {
  if (savedProjects === undefined) delete process.env.PROJECTS_ROOT;
  else process.env.PROJECTS_ROOT = savedProjects;
  if (savedWorktrees === undefined) delete process.env.FUTURATOR_WORKTREE_ROOT;
  else process.env.FUTURATOR_WORKTREE_ROOT = savedWorktrees;
});

describe('remapDaemonPath — fleet no-op (CRITICAL INVARIANT)', () => {
  it('returns the input identically when both envs are unset', () => {
    expect(isRemapActive()).toBe(false);
    expect(remapDaemonPath('/home/ubuntu/projects/pacman')).toBe('/home/ubuntu/projects/pacman');
    expect(remapDaemonPath('/home/ubuntu/worktrees/app/plan/s1')).toBe(
      '/home/ubuntu/worktrees/app/plan/s1',
    );
    expect(remapDaemonPath('/home/ubuntu/.claude/.credentials.json')).toBe(
      '/home/ubuntu/.claude/.credentials.json',
    );
  });

  it('is inactive when the envs EQUAL the legacy defaults (EC2 with explicit env)', () => {
    process.env.PROJECTS_ROOT = '/home/ubuntu/projects';
    process.env.FUTURATOR_WORKTREE_ROOT = '/home/ubuntu/worktrees';
    expect(isRemapActive()).toBe(false);
    expect(remapDaemonPath('/home/ubuntu/projects/pacman')).toBe('/home/ubuntu/projects/pacman');
  });

  it('never applies the homedir fallback while no env mapping is active', () => {
    // Even on a host whose homedir differs from /home/ubuntu (this test box),
    // an unset env means ZERO rewriting — the root-run-EC2 safety property.
    expect(remapDaemonPath('/home/ubuntu/repos/pacman.git')).toBe('/home/ubuntu/repos/pacman.git');
  });
});

describe('remapDaemonPath — active mappings', () => {
  beforeEach(() => {
    process.env.PROJECTS_ROOT = MAC_PROJECTS;
    process.env.FUTURATOR_WORKTREE_ROOT = MAC_WORKTREES;
  });

  it('remaps the projects root (exact and nested)', () => {
    expect(isRemapActive()).toBe(true);
    expect(remapDaemonPath('/home/ubuntu/projects')).toBe(MAC_PROJECTS);
    expect(remapDaemonPath('/home/ubuntu/projects/pacman')).toBe(`${MAC_PROJECTS}/pacman`);
    expect(remapDaemonPath('/home/ubuntu/projects/pacman/src/x.ts')).toBe(
      `${MAC_PROJECTS}/pacman/src/x.ts`,
    );
  });

  it('remaps the worktree root', () => {
    expect(remapDaemonPath('/home/ubuntu/worktrees/app/plan/story-1/')).toBe(
      `${MAC_WORKTREES}/app/plan/story-1/`,
    );
  });

  it('longest prefix wins — projects/worktrees beat the bare /home/ubuntu fallback', () => {
    expect(remapDaemonPath('/home/ubuntu/projects/x')).toBe(`${MAC_PROJECTS}/x`);
    expect(remapDaemonPath('/home/ubuntu/worktrees/x')).toBe(`${MAC_WORKTREES}/x`);
  });

  it('maps other /home/ubuntu paths to the local homedir (fallback active off-fleet)', () => {
    const home = homedir();
    const expected = home === '/home/ubuntu' ? '/home/ubuntu/repos/x.git' : `${home}/repos/x.git`;
    expect(remapDaemonPath('/home/ubuntu/repos/x.git')).toBe(expected);
  });

  it('only projects env set — worktree paths fall through to the homedir fallback, not the worktree map', () => {
    delete process.env.FUTURATOR_WORKTREE_ROOT;
    const home = homedir();
    const expected =
      home === '/home/ubuntu' ? '/home/ubuntu/worktrees/a' : `${home}/worktrees/a`;
    expect(remapDaemonPath('/home/ubuntu/worktrees/a')).toBe(expected);
  });

  it('is segment-aware — /home/ubuntu/projectsfoo does not match the projects mapping', () => {
    const home = homedir();
    const expected =
      home === '/home/ubuntu' ? '/home/ubuntu/projectsfoo' : `${home}/projectsfoo`;
    expect(remapDaemonPath('/home/ubuntu/projectsfoo')).toBe(expected);
  });

  it('never double-remaps an already-local path (idempotent)', () => {
    const local = `${MAC_PROJECTS}/pacman`;
    expect(remapDaemonPath(local)).toBe(local);
    expect(remapDaemonPath(remapDaemonPath('/home/ubuntu/projects/pacman'))).toBe(local);
  });

  it('passes through non-strings and empty strings', () => {
    expect(remapDaemonPath(undefined)).toBe(undefined);
    expect(remapDaemonPath(null)).toBe(null);
    expect(remapDaemonPath('')).toBe('');
  });
});

describe('remapPathsInText', () => {
  it('is identity on fleet boxes', () => {
    const cmd = 'cd /home/ubuntu/projects/foo && npm test';
    expect(remapPathsInText(cmd)).toBe(cmd);
  });

  it('rewrites every occurrence inside baked step commands', () => {
    process.env.PROJECTS_ROOT = MAC_PROJECTS;
    const cmd =
      'cd /home/ubuntu/projects/foo && mkdir -p .pipeline && cp /home/ubuntu/projects/foo/a.txt .';
    expect(remapPathsInText(cmd)).toBe(
      `cd ${MAC_PROJECTS}/foo && mkdir -p .pipeline && cp ${MAC_PROJECTS}/foo/a.txt .`,
    );
  });

  it('respects token boundaries', () => {
    process.env.PROJECTS_ROOT = MAC_PROJECTS;
    expect(remapPathsInText('ls /home/ubuntu/projects-backup')).not.toContain(
      `${MAC_PROJECTS}-backup`,
    );
  });
});

describe('remapJobPaths — the job-intake seam', () => {
  const makeJob = () => ({
    jobId: 'j1',
    planId: 'p1',
    workingDir: '/home/ubuntu/projects/pacman',
    partyBootstrapPayload: { projectPath: '/home/ubuntu/projects/pacman', projectId: 'pacman' },
    queueRequestPayload: { workingDir: '/home/ubuntu/projects/pacman', requestId: 'r1' },
    quickPlanspecPayload: { planId: 'p1', appId: 'pacman', intent: 'build it' },
    pipeline: {
      steps: [
        { id: 'dev', command: 'cd /home/ubuntu/projects/pacman && npm test' },
        { id: 'pm', prompt: 'Working directory: /home/ubuntu/projects/pacman' },
      ],
    },
  });

  it('is an exact no-op on fleet boxes (deep-equal untouched)', () => {
    const job = makeJob();
    const before = JSON.parse(JSON.stringify(job));
    const out = remapJobPaths(job);
    expect(out).toBe(job);
    expect(job).toEqual(before);
  });

  it('remaps workingDir, payload path fields, and step command/prompt text', () => {
    process.env.PROJECTS_ROOT = MAC_PROJECTS;
    const job = remapJobPaths(makeJob());
    expect(job.workingDir).toBe(`${MAC_PROJECTS}/pacman`);
    expect(job.partyBootstrapPayload.projectPath).toBe(`${MAC_PROJECTS}/pacman`);
    expect(job.queueRequestPayload.workingDir).toBe(`${MAC_PROJECTS}/pacman`);
    // Non-path payload fields untouched.
    expect(job.partyBootstrapPayload.projectId).toBe('pacman');
    expect(job.quickPlanspecPayload).toEqual({ planId: 'p1', appId: 'pacman', intent: 'build it' });
    expect(job.pipeline.steps[0].command).toBe(`cd ${MAC_PROJECTS}/pacman && npm test`);
    expect(job.pipeline.steps[1].prompt).toBe(`Working directory: ${MAC_PROJECTS}/pacman`);
  });

  it('tolerates jobs with no pipeline / payloads and already-local paths', () => {
    process.env.PROJECTS_ROOT = MAC_PROJECTS;
    const job = { jobId: 'j2', workingDir: `${MAC_PROJECTS}/pacman` };
    expect(remapJobPaths(job).workingDir).toBe(`${MAC_PROJECTS}/pacman`);
    expect(remapJobPaths(null)).toBe(null);
  });
});
