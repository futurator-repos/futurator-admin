import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories/party-projects-repository', () => ({
  getProject: vi.fn(),
}));
vi.mock('../../repositories/party-sessions-repository', () => ({
  hasProcessingSession: vi.fn(),
}));
vi.mock('../../repositories/plan-repository', () => ({
  getActivePlanForApp: vi.fn(),
}));
vi.mock('../../repositories/free-agent-sessions-repository', () => ({
  listAllSessions: vi.fn(),
}));

import * as partyProjectsRepo from '../../repositories/party-projects-repository';
import * as partySessionsRepo from '../../repositories/party-sessions-repository';
import { getActivePlanForApp } from '../../repositories/plan-repository';
import { listAllSessions as listAllFreeAgentSessions } from '../../repositories/free-agent-sessions-repository';

import {
  runConvertPreflight,
  isAlreadyBareTopology,
  performBrownfieldConversion,
} from '../brownfield-topology-converter';

const APP = 'applicator';

function makeDeps(output: string) {
  return {
    sendSsmCommand: vi.fn().mockResolvedValue('cmd-1'),
    waitForSsmOutput: vi.fn().mockResolvedValue(output),
  };
}

const brownfieldProject = {
  projectId: APP,
  kind: 'brownfield' as const,
  gitRepoUrl: 'https://github.com/futurator-repos/applicator.git',
  gitBranch: 'main',
  bmadStatus: 'HEALTHY' as const,
  expectedAgentCount: 14,
  createdAt: 'now',
  updatedAt: 'now',
  path: '/home/ubuntu/projects/applicator',
};

beforeEach(() => {
  vi.mocked(partyProjectsRepo.getProject).mockReset();
  vi.mocked(partySessionsRepo.hasProcessingSession).mockReset();
  vi.mocked(getActivePlanForApp).mockReset();
  vi.mocked(listAllFreeAgentSessions).mockReset();
});

describe('runConvertPreflight — Story 20.4', () => {
  it('NOT_FOUND when project missing', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(null);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r).toEqual([{ code: 'NOT_FOUND', detail: expect.any(String) }]);
  });

  it('NOT_BROWNFIELD when project kind is greenfield', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue({
      ...brownfieldProject,
      kind: 'greenfield',
    } as never);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r[0].code).toBe('NOT_BROWNFIELD');
  });

  it('rejects unsafe projectId without hitting any deps', async () => {
    const deps = makeDeps('');
    const r = await runConvertPreflight({ projectId: '../../etc/passwd' }, deps);
    expect(r[0].code).toBe('NOT_FOUND');
    expect(partyProjectsRepo.getProject).not.toHaveBeenCalled();
  });

  it('ACTIVE_PLAN blocker when getActivePlanForApp returns a plan', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue({
      planId: 'p1',
      name: 'my-plan',
      status: 'developing',
    } as never);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([]);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(false);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r.some((b) => b.code === 'ACTIVE_PLAN')).toBe(true);
  });

  it('ACTIVE_FREE_AGENT_SESSION blocker when a session is ACTIVE on this project', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue(null);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([
      { sessionId: 'ab12cd34-x', projectId: APP, status: 'ACTIVE' },
      { sessionId: 'other', projectId: 'different', status: 'PROCESSING' },
    ] as never);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(false);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r.some((b) => b.code === 'ACTIVE_FREE_AGENT_SESSION')).toBe(true);
  });

  it('ACTIVE_PARTY_SESSION blocker when hasProcessingSession returns true', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue(null);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([]);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(true);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r.some((b) => b.code === 'ACTIVE_PARTY_SESSION')).toBe(true);
  });

  it('DIRTY_TREE blocker when porcelain reports dirty', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue(null);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([]);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(false);
    const deps = makeDeps('DIRTY\n M src/file.ts\n?? new-file');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r.some((b) => b.code === 'DIRTY_TREE')).toBe(true);
  });

  it('WORKING_TREE_MISSING when porcelain probe reports TREE_MISSING', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue(null);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([]);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(false);
    const deps = makeDeps('TREE_MISSING');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r.some((b) => b.code === 'WORKING_TREE_MISSING')).toBe(true);
  });

  it('returns empty blocker list when all checks pass', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    vi.mocked(getActivePlanForApp).mockResolvedValue(null);
    vi.mocked(listAllFreeAgentSessions).mockResolvedValue([]);
    vi.mocked(partySessionsRepo.hasProcessingSession).mockResolvedValue(false);
    const deps = makeDeps('CLEAN');
    const r = await runConvertPreflight({ projectId: APP }, deps);
    expect(r).toEqual([]);
  });
});

describe('isAlreadyBareTopology — Story 20.4 idempotence', () => {
  it('returns alreadyBare:true when bare repo + worktree pointer + matching gitdir', async () => {
    const sha = 'a'.repeat(40);
    const deps = makeDeps(`ALREADY_BARE_SHA=${sha}`);
    const r = await isAlreadyBareTopology({ projectId: APP }, deps);
    expect(r).toEqual({ alreadyBare: true, headSha: sha });
  });

  it('returns alreadyBare:false when bare repo is absent', async () => {
    const deps = makeDeps('BARE_ABSENT');
    const r = await isAlreadyBareTopology({ projectId: APP }, deps);
    expect(r.alreadyBare).toBe(false);
  });

  it('returns alreadyBare:false when working tree exists but .git is a dir (regular clone)', async () => {
    const deps = makeDeps('NOT_WORKTREE');
    const r = await isAlreadyBareTopology({ projectId: APP }, deps);
    expect(r.alreadyBare).toBe(false);
  });

  it('returns alreadyBare:false on unsafe projectId without invoking SSM', async () => {
    const deps = makeDeps('');
    const r = await isAlreadyBareTopology({ projectId: '../bad' }, deps);
    expect(r.alreadyBare).toBe(false);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });
});

describe('performBrownfieldConversion — Story 20.4', () => {
  it('returns converted:true with paths + SHA on CONVERT_OK', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    const sha = 'b'.repeat(40);
    const deps = makeDeps(`PRE_SHA=${sha}\nENV_STASHED\n...\nCONVERT_OK post=${sha}`);
    const r = await performBrownfieldConversion(
      { projectId: APP, gitBranch: 'main', pat: 'ghp_fake' },
      deps,
    );
    expect(r.converted).toBe(true);
    if (r.converted) {
      expect(r.bareRepoPath).toBe('/home/ubuntu/repos/applicator.git');
      expect(r.worktreePath).toBe('/home/ubuntu/projects/applicator');
      expect(r.headSha).toBe(sha);
    }
  });

  it('returns conversion-failed when CONVERT_OK marker absent', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(brownfieldProject as never);
    const deps = makeDeps('PRE_NO_HEAD');
    const r = await performBrownfieldConversion(
      { projectId: APP, gitBranch: 'main', pat: 'ghp_fake' },
      deps,
    );
    expect(r.converted).toBe(false);
    if (!r.converted && r.reason === 'conversion-failed') {
      expect(r.detail).toMatch(/conversion script aborted/);
    }
  });

  it('returns conversion-failed when project missing or no gitRepoUrl', async () => {
    vi.mocked(partyProjectsRepo.getProject).mockResolvedValue(null);
    const deps = makeDeps('');
    const r = await performBrownfieldConversion(
      { projectId: APP, gitBranch: 'main', pat: 'ghp_fake' },
      deps,
    );
    expect(r.converted).toBe(false);
    if (!r.converted && r.reason === 'conversion-failed') {
      expect(r.detail).toMatch(/no gitRepoUrl/);
    }
  });

  it('rejects unsafe projectId without invoking SSM', async () => {
    const deps = makeDeps('');
    const r = await performBrownfieldConversion(
      { projectId: '../etc', gitBranch: 'main', pat: 'x' },
      deps,
    );
    expect(r.converted).toBe(false);
    expect(deps.sendSsmCommand).not.toHaveBeenCalled();
  });
});
