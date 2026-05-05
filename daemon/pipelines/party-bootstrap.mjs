/**
 * Party Bootstrap Pipeline — retrofits BMAD onto a project folder.
 *
 * 8 steps per tech-spec §"Bootstrap Pipeline Steps":
 *   1. validate        — projectPath under PROJECTS_ROOT, projectId regex
 *   2. refresh-source  — git pull on the admin-repo clone (custom-agent source)
 *   3. bmad-install    — npx bmad-method@<version> install ...  (idempotent)
 *   4. sync-agents     — rsync custom-agent source → <project>/bmad/agents/
 *   5. rebuild-manifest — regenerate bmad/_cfg/agent-manifest.csv
 *   6. compute-sha     — SHA256 of installed custom agents
 *   7. verify          — assert row count === expectedAgentCount
 *   8. persist         — update party-projects row to HEALTHY
 *
 * On any step failure: set bmadStatus=FAILED, emit .failed, no auto-retry.
 *
 * Idempotent: running on a HEALTHY project re-runs refresh + rsync + rebuild
 * but skips the `npx install` step (handled inside installBmad).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { installBmad } from './lib/bmad-install.mjs';
import { syncCustomAgents } from './lib/custom-agent-sync.mjs';
import { rebuildManifest } from './lib/rebuild-manifest.mjs';
import { computeCustomAgentsSHA } from './lib/custom-agents-sha.mjs';
import { injectCustomAgents } from './lib/inject-custom-agents.mjs';

const STEPS = [
  'validate',
  'refresh-source',
  'bmad-install',
  'sync-agents',
  'rebuild-manifest',
  'inject-custom-agents',
  'compute-sha',
  'verify',
  'persist',
];

export async function runPartyBootstrap(job, ctx) {
  const payload = job.partyBootstrapPayload || {};
  const { projectId, projectPath, forceReinstall = false, createFolder = false } = payload;
  const {
    pushEvent,
    updateProjectState,
    expectedBmadVersion,
    customAgentsSourceDir,
    customAgentsSourceRepo, // parent dir of .git for the admin repo clone
    expectedAgentCount,
    projectsRoot,
  } = ctx;

  if (!projectId || !projectPath) {
    throw new Error('runPartyBootstrap: payload missing projectId/projectPath');
  }

  let currentStep = 'validate';

  async function emitStepStarted(step) {
    currentStep = step;
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.started', {
      projectId,
      step,
    });
  }
  async function emitStepCompleted(step, details = {}) {
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.completed', {
      projectId,
      step,
      ...details,
    });
  }
  async function emitStepOutput(step, stream, data) {
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.output', {
      projectId,
      step,
      stream,
      data,
    });
  }

  try {
    // 1. VALIDATE
    await emitStepStarted('validate');
    if (projectsRoot && !projectPath.startsWith(projectsRoot)) {
      throw new Error(`projectPath ${projectPath} must be under ${projectsRoot}`);
    }
    if (!existsSync(projectPath)) {
      if (createFolder) {
        mkdirSync(projectPath, { recursive: true });
        mkdirSync(`${projectPath}/docs`, { recursive: true });
        await emitStepOutput('validate', 'stdout', `created project folder ${projectPath}`);
      } else {
        throw new Error(`project directory does not exist: ${projectPath}`);
      }
    } else if (createFolder) {
      // Folder existed; make sure the docs subdir is present for uploads.
      mkdirSync(`${projectPath}/docs`, { recursive: true });
    }
    await emitStepCompleted('validate');

    // 2. REFRESH-SOURCE (git pull custom-agent source clone)
    //
    // If `customAgentsSourceRepo/.git` doesn't exist the source was populated
    // via rsync (not a clone); skip refresh silently. This is the common case
    // during initial rollout when the operator is syncing agents manually
    // rather than giving the EC2 box GitHub credentials.
    await emitStepStarted('refresh-source');
    const hasGitRepo =
      customAgentsSourceRepo &&
      existsSync(customAgentsSourceRepo) &&
      existsSync(`${customAgentsSourceRepo}/.git`);
    if (hasGitRepo) {
      try {
        await runGitRefresh(customAgentsSourceRepo, (chunk) =>
          emitStepOutput('refresh-source', chunk.stream, chunk.data),
        );
      } catch (err) {
        // Non-fatal: log but continue with whatever's currently on disk.
        await pushEvent(job.jobId, 'refresh-source', '__party__', 'party.bootstrap.step.output', {
          projectId,
          step: 'refresh-source',
          stream: 'stderr',
          data: `git refresh failed (continuing with on-disk source): ${err.message}`,
        });
      }
    } else {
      await emitStepOutput('refresh-source', 'stdout', 'no .git in source — using on-disk copy');
    }
    await emitStepCompleted('refresh-source', { skipped: !hasGitRepo });

    // 3. BMAD-INSTALL
    await emitStepStarted('bmad-install');
    const installResult = await installBmad({
      projectPath,
      version: expectedBmadVersion,
      force: forceReinstall,
      onOutput: (o) => emitStepOutput('bmad-install', o.stream, o.data),
    });
    await emitStepCompleted('bmad-install', {
      skipped: installResult.skipped,
      installedVersion: installResult.installedVersion,
    });

    // Detect install layout. BMAD 6.3.x writes `_bmad/_config/agent-manifest.csv`
    // (new) and generates the manifest itself; custom-agent sync and manual
    // rebuild are deferred to a later story. On the legacy `bmad/_cfg/...`
    // layout we fall through to the original sync+rebuild path.
    const newCsv = `${projectPath}/_bmad/_config/agent-manifest.csv`;
    const legacyCsvDir = `${projectPath}/bmad/_cfg`;
    const isNewLayout = existsSync(newCsv);
    const isLegacyLayout = existsSync(legacyCsvDir) && !isNewLayout;

    // 4. SYNC-AGENTS
    await emitStepStarted('sync-agents');
    if (isNewLayout) {
      await emitStepOutput(
        'sync-agents',
        'stdout',
        'skipped — BMAD 6.3.x manages agents via Claude Code skills; custom-agent sync deferred',
      );
    } else {
      await syncCustomAgents({
        sourceDir: customAgentsSourceDir,
        projectPath,
        onOutput: (o) => emitStepOutput('sync-agents', o.stream, o.data),
      });
    }
    await emitStepCompleted('sync-agents', { skipped: isNewLayout });

    // 5. REBUILD-MANIFEST
    await emitStepStarted('rebuild-manifest');
    let rowCount;
    if (isNewLayout) {
      // BMAD's installer already produced the manifest; just count its rows.
      const text = readFileSync(newCsv, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      rowCount = Math.max(0, lines.length - 1);
      await emitStepOutput(
        'rebuild-manifest',
        'stdout',
        `skipped — using BMAD-generated manifest at _bmad/_config/agent-manifest.csv (${rowCount} rows)`,
      );
    } else {
      rowCount = await rebuildManifest(`${projectPath}/bmad`);
    }
    await emitStepCompleted('rebuild-manifest', { rowCount, skipped: isNewLayout });

    // 5.5. INJECT-CUSTOM-AGENTS (Path 3b from party-module-implementation §15)
    //
    // Append rows from our 8 custom agents to the 6.3.x-generated manifest so
    // Party Mode's roster surfaces them. Idempotent: re-running on a project
    // that already has custom rows de-dupes by the `name` column.
    //
    // Legacy layout pre-6.3.x wrote these via `rebuild-manifest` by scanning
    // `bmad/agents/<slug>/<slug>.md` directly, so we skip injection there.
    const customAgentsEnabled = process.env.PARTY_CUSTOM_AGENTS_ENABLED !== 'false';
    await emitStepStarted('inject-custom-agents');
    let injectedCount = 0;
    if (!isNewLayout) {
      await emitStepOutput(
        'inject-custom-agents',
        'stdout',
        'skipped — legacy layout already sources custom agents via rebuild-manifest',
      );
    } else if (!customAgentsEnabled) {
      await emitStepOutput(
        'inject-custom-agents',
        'stdout',
        'skipped — PARTY_CUSTOM_AGENTS_ENABLED=false',
      );
    } else {
      const result = await injectCustomAgents({
        sourceDir: customAgentsSourceDir,
        manifestPath: newCsv,
        onOutput: (o) => emitStepOutput('inject-custom-agents', o.stream, o.data),
      });
      injectedCount = result.injected;
      rowCount = result.total;
    }
    await emitStepCompleted('inject-custom-agents', {
      injectedCount,
      rowCount,
      skipped: !isNewLayout || !customAgentsEnabled,
    });

    // 6. COMPUTE-SHA
    //
    // On 6.3.x we now have custom agents injected into the manifest — revive
    // real SHA computation over the source .md files so drift detection fires
    // when an agent file changes in the admin repo.
    await emitStepStarted('compute-sha');
    let customAgentsSHA;
    if (!isNewLayout) {
      customAgentsSHA = computeCustomAgentsSHA(`${projectPath}/bmad/agents`);
    } else if (!customAgentsEnabled || !customAgentsSourceDir) {
      customAgentsSHA = 'n/a-6.3.x';
      await emitStepOutput(
        'compute-sha',
        'stdout',
        'skipped — custom-agent injection disabled (placeholder SHA)',
      );
    } else {
      customAgentsSHA = computeCustomAgentsSHA(customAgentsSourceDir);
    }
    await emitStepCompleted('compute-sha', { customAgentsSHA, skipped: false });

    // 7. VERIFY
    //
    // Minimum row sanity check only — exact expected count varies by BMAD
    // minor version (different stock-module sets add/remove agents between
    // releases). We fail if the manifest came out empty or suspiciously
    // small; everything else is considered healthy and the actual count is
    // persisted on the project row for the UI to display.
    await emitStepStarted('verify');
    // Floor is a sanity check, not an agent-count gate. BMAD 6.3.0 stock
    // install ships 6 agents; 5 leaves headroom for a minor future removal
    // without breaking us. Our own `expectedAgentCount` setting is what the
    // UI displays, separate from this pass/fail floor.
    const MIN_REASONABLE_ROW_COUNT = 5;
    if (rowCount < MIN_REASONABLE_ROW_COUNT) {
      throw new Error(
        `manifest: at least ${MIN_REASONABLE_ROW_COUNT} rows required, got ${rowCount}`,
      );
    }
    await emitStepCompleted('verify', { rowCount, expectedAgentCount });

    // 8. PERSIST
    await emitStepStarted('persist');
    await updateProjectState(projectId, {
      bmadStatus: 'HEALTHY',
      bmadVersion: expectedBmadVersion,
      customAgentsSHA,
      agentCount: rowCount,
      lastInspectedAt: new Date().toISOString(),
      failureReason: undefined,
    });
    await emitStepCompleted('persist');

    await pushEvent(job.jobId, 'completed', '__party__', 'party.bootstrap.completed', {
      projectId,
      bmadVersion: expectedBmadVersion,
      agentCount: rowCount,
      customAgentsSHA,
      skippedInstall: installResult.skipped === true,
    });

    return {
      ok: true,
      bmadVersion: expectedBmadVersion,
      agentCount: rowCount,
      customAgentsSHA,
    };
  } catch (err) {
    const reason = err.message || String(err);
    await updateProjectState(projectId, {
      bmadStatus: 'FAILED',
      failureReason: `${currentStep}: ${reason}`,
    }).catch(() => {});
    await pushEvent(job.jobId, currentStep, '__party__', 'party.bootstrap.step.failed', {
      projectId,
      step: currentStep,
      reason,
    });
    await pushEvent(job.jobId, 'failed', '__party__', 'party.bootstrap.failed', {
      projectId,
      step: currentStep,
      reason,
    });
    throw err;
  }
}

function runGitRefresh(repoDir, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'git fetch --depth 1 origin main && git reset --hard origin/main'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => onOutput?.({ stream: 'stdout', data: c.toString('utf8') }));
    child.stderr.on('data', (c) => onOutput?.({ stream: 'stderr', data: c.toString('utf8') }));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git refresh exited with code ${code}`));
    });
  });
}

export const PARTY_BOOTSTRAP_STEPS = STEPS;
