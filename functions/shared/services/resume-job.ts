/**
 * Resume-job helper (EO-5.3, shared with EO-4.5 crash-resume).
 *
 * Enqueues a new `phase: 'epic-dev'` PENDING job carrying `resumeFromWaveResults`
 * from a prior job's checkpoints so already-APPROVED stories skip. Used by:
 *   - `POST /resolve-blocker` (amend / retry) in `functions/api/index.ts`
 *   - The daemon's stale-heartbeat resume path (`daemon/agent-daemon.mjs`)
 *
 * Kept as a pure-ish service (repos injected at call time) so it can be
 * unit-tested with mocked DDB without booting Hono or the daemon.
 */

import type { AgentJob, WaveResult } from '../types/agent-orchestrator';
import type { EpicWorkflow } from '../types/epic-workflow';
import { buildEpicDevPayload } from './epic-dev-launcher';

export interface EnqueueResumeJobDeps {
  getEpicById: (epicId: string) => Promise<EpicWorkflow | null>;
  getJobById: (jobId: string) => Promise<AgentJob | null>;
  createJob: (job: AgentJob) => Promise<AgentJob>;
  newJobId: () => string;
  now: () => Date;
}

export interface EnqueueResumeJobInput {
  epicId: string;
  userId: string;
  priorJobId?: string;
}

export interface EnqueueResumeJobResult {
  jobId: string;
  resumeFromWaveResults: Record<string, WaveResult>;
}

/**
 * Enqueues an epic-dev resume job. If `priorJobId` resolves to a job with
 * populated `waveResults`, those checkpoints are carried forward on the new
 * job so the orchestrator can skip APPROVED stories. Otherwise the new job
 * starts from scratch.
 */
export async function enqueueResumeJob(
  input: EnqueueResumeJobInput,
  deps: EnqueueResumeJobDeps,
): Promise<EnqueueResumeJobResult> {
  const epic = await deps.getEpicById(input.epicId);
  if (!epic) {
    throw new Error(`enqueueResumeJob: epic ${input.epicId} not found`);
  }

  let resumeFromWaveResults: Record<string, WaveResult> = {};
  if (input.priorJobId) {
    const prior = await deps.getJobById(input.priorJobId);
    if (prior?.waveResults && Object.keys(prior.waveResults).length > 0) {
      resumeFromWaveResults = prior.waveResults;
    }
  }

  const jobId = deps.newJobId();
  const nowIso = deps.now().toISOString();
  const projectId = epic.workingDir.split('/').filter(Boolean).pop() || epic.epicId;

  const job: AgentJob = {
    jobId,
    status: 'PENDING',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: input.userId,
    workingDir: epic.workingDir,
    pipeline: { agents: {}, steps: [] },
    phase: 'epic-dev',
    epicId: epic.epicId,
    projectId,
    epicDevPayload: buildEpicDevPayload(epic),
    ...(Object.keys(resumeFromWaveResults).length > 0 ? { resumeFromWaveResults } : {}),
  };

  await deps.createJob(job);
  return { jobId, resumeFromWaveResults };
}
