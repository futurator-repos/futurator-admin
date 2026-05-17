/**
 * Party Refresh Pipeline — brownfield-only (Story 15.4).
 *
 * 6 steps:
 *   1. acquire-lock     — conditional UpdateCommand HEALTHY|DRIFTED → REFRESHING
 *   2. git-fetch-reset  — `git fetch origin && git reset --hard origin/<branch>`
 *   3. compute-sha      — recompute customAgentsSHA from bmad/agents/
 *   4. verify           — re-check the manifest still exists with ≥1 row
 *   5. read-head-sha    — git rev-parse HEAD
 *   6. persist + release — write new lastPulledAt + lastCommitSha; release lock
 *
 * On any step error: release lock to FAILED, emit party.refresh.failed.
 * The lock is owned by the daemon for the whole pipeline lifecycle.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { computeCustomAgentsSHA } from './lib/custom-agents-sha.mjs';
import { readGitHeadSha, renderDotEnv } from './party-bootstrap.mjs';

export const PARTY_REFRESH_STEPS = [
  'acquire-lock',
  'git-fetch-reset',
  'compute-sha',
  'verify',
  'read-head-sha',
  'persist',
];

export async function runPartyRefresh(job, ctx) {
  const payload = job.partyRefreshPayload || {};
  const { projectId, projectPath, gitBranch, envVars } = payload;
  const {
    pushEvent,
    tryAcquireRefreshLock,
    releaseRefreshLock,
    updateProjectAfterRefresh,
    projectsRoot,
  } = ctx;

  if (!projectId || !projectPath || !gitBranch) {
    throw new Error('runPartyRefresh: payload missing projectId/projectPath/gitBranch');
  }
  if (projectsRoot && !projectPath.startsWith(projectsRoot)) {
    throw new Error(`projectPath ${projectPath} must be under ${projectsRoot}`);
  }
  if (!existsSync(projectPath)) {
    throw new Error(`projectPath ${projectPath} does not exist — re-bootstrap required`);
  }

  let currentStep = 'acquire-lock';
  let lockHeld = false;

  async function emitStepStarted(step) {
    currentStep = step;
    await pushEvent(job.jobId, step, '__party__', 'party.refresh.step.started', {
      projectId,
      step,
    });
  }
  async function emitStepCompleted(step, details = {}) {
    await pushEvent(job.jobId, step, '__party__', 'party.refresh.step.completed', {
      projectId,
      step,
      ...details,
    });
  }
  async function emitStepOutput(step, stream, data) {
    await pushEvent(job.jobId, step, '__party__', 'party.refresh.step.output', {
      projectId,
      step,
      stream,
      data,
    });
  }

  try {
    // 0. Emit a one-shot pipeline-start event before any step starts so
    // consumers can distinguish "pipeline began" from individual step starts.
    await pushEvent(job.jobId, 'pipeline', '__party__', 'party.refresh.started', {
      projectId,
      gitBranch,
    });

    // 1. ACQUIRE-LOCK
    await emitStepStarted('acquire-lock');
    const lock = await tryAcquireRefreshLock(projectId);
    if (!lock.ok) {
      throw new Error(`refresh lock not acquired: ${lock.reason}`);
    }
    lockHeld = true;
    await emitStepCompleted('acquire-lock');

    // 2. GIT-FETCH-RESET
    await emitStepStarted('git-fetch-reset');
    await runGitFetchReset(projectPath, gitBranch, (chunk) =>
      emitStepOutput('git-fetch-reset', chunk.stream, chunk.data),
    );

    // Migrate-module — re-sync .env after `git reset --hard`. The reset
    // doesn't touch untracked files, but if the operator updated env
    // vars via PATCH /api/migrations/:id between bootstrap and refresh,
    // this is when those changes hit disk.
    if (envVars && Object.keys(envVars).length > 0) {
      const envBody = renderDotEnv(envVars);
      writeFileSync(`${projectPath}/.env`, envBody, { mode: 0o600 });
      await emitStepOutput(
        'git-fetch-reset',
        'stdout',
        `re-synced .env with ${Object.keys(envVars).length} key(s)\n`,
      );
    }

    await emitStepCompleted('git-fetch-reset');

    // 3. COMPUTE-SHA
    await emitStepStarted('compute-sha');
    const customAgentsSHA = computeCustomAgentsSHA(`${projectPath}/bmad/agents`);
    await emitStepCompleted('compute-sha', { customAgentsSHA });

    // 4. VERIFY — manifest still present after reset.
    await emitStepStarted('verify');
    const manifestPath = `${projectPath}/bmad/_cfg/agent-manifest.csv`;
    const newLayoutManifest = `${projectPath}/_bmad/_config/agent-manifest.csv`;
    let manifestFile = null;
    if (existsSync(manifestPath)) manifestFile = manifestPath;
    else if (existsSync(newLayoutManifest)) manifestFile = newLayoutManifest;
    if (!manifestFile) {
      throw new Error('BMAD_NOT_FOUND_IN_REPO');
    }
    const text = readFileSync(manifestFile, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    const rowCount = Math.max(0, lines.length - 1);
    if (rowCount < 1) throw new Error('BMAD_NOT_FOUND_IN_REPO');
    await emitStepCompleted('verify', { rowCount });

    // 5. READ-HEAD-SHA
    await emitStepStarted('read-head-sha');
    const lastCommitSha = await readGitHeadSha(projectPath);
    await emitStepCompleted('read-head-sha', { lastCommitSha });

    // 6. PERSIST + release-lock
    await emitStepStarted('persist');
    const now = new Date().toISOString();
    await updateProjectAfterRefresh(projectId, {
      lastPulledAt: now,
      lastCommitSha,
      customAgentsSHA,
      agentCount: rowCount,
    });
    await releaseRefreshLock(projectId, 'HEALTHY');
    lockHeld = false;
    await emitStepCompleted('persist');

    await pushEvent(job.jobId, 'completed', '__party__', 'party.refresh.completed', {
      projectId,
      lastPulledAt: now,
      lastCommitSha,
      customAgentsSHA,
      agentCount: rowCount,
    });

    return { ok: true, lastPulledAt: now, lastCommitSha, customAgentsSHA, agentCount: rowCount };
  } catch (err) {
    const reason = err.message || String(err);
    if (lockHeld) {
      await releaseRefreshLock(projectId, 'FAILED').catch(() => {});
    }
    await pushEvent(job.jobId, currentStep, '__party__', 'party.refresh.failed', {
      projectId,
      step: currentStep,
      reason,
    });
    throw err;
  }
}

function runGitFetchReset(repoDir, branch, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', `git fetch origin && git reset --hard origin/${branch}`], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => onOutput?.({ stream: 'stdout', data: c.toString('utf8') }));
    child.stderr.on('data', (c) => onOutput?.({ stream: 'stderr', data: c.toString('utf8') }));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git fetch/reset exited with code ${code}`));
    });
  });
}
