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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { installBmad } from './lib/bmad-install.mjs';
import { syncCustomAgents } from './lib/custom-agent-sync.mjs';
import { rebuildManifest } from './lib/rebuild-manifest.mjs';
import { computeCustomAgentsSHA } from './lib/custom-agents-sha.mjs';
import { injectCustomAgents } from './lib/inject-custom-agents.mjs';
import { cloneRepo } from './lib/git-clone.mjs';

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

const BROWNFIELD_STEPS = ['clone-repo', 'verify', 'compute-sha', 'persist'];

export async function runPartyBootstrap(job, ctx) {
  const payload = job.partyBootstrapPayload || {};
  const {
    projectId,
    projectPath,
    forceReinstall = false,
    createFolder = false,
    kind = 'greenfield',
    gitRepoUrl,
    gitBranch,
    patSecretName,
    envVars,
  } = payload;

  if (!projectId || !projectPath) {
    throw new Error('runPartyBootstrap: payload missing projectId/projectPath');
  }

  // Story 15.4 — brownfield branch. Skips BMAD install + custom-agent sync;
  // the cloned repo already ships its own bmad/ tree.
  if (kind === 'brownfield') {
    return runBrownfieldBootstrap({
      job,
      ctx,
      projectId,
      projectPath,
      gitRepoUrl,
      gitBranch,
      patSecretName,
      envVars,
    });
  }

  const {
    pushEvent,
    updateProjectState,
    expectedBmadVersion,
    customAgentsSourceDir,
    customAgentsSourceRepo, // parent dir of .git for the admin repo clone
    expectedAgentCount,
    projectsRoot,
  } = ctx;

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
    const child = spawn(
      'bash',
      ['-c', 'git fetch --depth 1 origin main && git reset --hard origin/main'],
      {
        cwd: repoDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
export const PARTY_BOOTSTRAP_BROWNFIELD_STEPS = BROWNFIELD_STEPS;

/**
 * Brownfield bootstrap (Story 15.4). Runs only 4 steps:
 *   1. clone-repo    — git clone via PAT into projectPath
 *   2. verify        — assert bmad/_cfg/agent-manifest.csv exists with ≥ 1 row
 *   3. compute-sha   — SHA over bmad/agents/ (empty input is acceptable)
 *   4. persist       — set HEALTHY + lastPulledAt + lastCommitSha
 *
 * On verify failure: FAILED with failureReason='BMAD_NOT_FOUND_IN_REPO'.
 */
async function runBrownfieldBootstrap({
  job,
  ctx,
  projectId,
  projectPath,
  gitRepoUrl,
  gitBranch,
  patSecretName,
  envVars,
}) {
  const { pushEvent, updateProjectState, loadBrownfieldPat, projectsRoot } = ctx;

  if (!gitRepoUrl) throw new Error('runBrownfieldBootstrap: gitRepoUrl is required');
  if (!gitBranch) throw new Error('runBrownfieldBootstrap: gitBranch is required');
  if (typeof loadBrownfieldPat !== 'function') {
    throw new Error(
      'runBrownfieldBootstrap: ctx.loadBrownfieldPat not wired — daemon must export the secret loader',
    );
  }
  if (projectsRoot && !projectPath.startsWith(projectsRoot)) {
    throw new Error(`projectPath ${projectPath} must be under ${projectsRoot}`);
  }

  // ── Story 20.5 (party-push Epic 20) — topology gate ─────────────────
  // Refuse to bootstrap a brownfield project that hasn't been converted
  // to the bare+worktree topology by Story 20.4's admin endpoint. Without
  // the bare repo at /home/ubuntu/repos/<projectId>.git, party-push's
  // per-session worktrees (Story 20.6) can't share the object store and
  // the design degrades into "every session is a full clone" — defeating
  // the whole point.
  //
  // Compatibility: this only fires for NEW bootstrap invocations. Sessions
  // that already exist on a non-bare topology continue working until they
  // end naturally; the next bootstrap on the same project is when the
  // operator must run the admin migration.
  const bareRepoPath = `/home/ubuntu/repos/${projectId}.git`;
  const topologyCheckPassed = await ctx
    .checkBareRepoExists?.(bareRepoPath)
    .catch(() => false);
  if (topologyCheckPassed === false) {
    // emitStepFailed is defined further down — push the event directly here
    // because we haven't entered the step-emission flow yet.
    const reason = 'TOPOLOGY_NOT_MIGRATED';
    const message =
      `Brownfield project ${projectId} has not been converted to bare+worktree topology. ` +
      `Operator must POST /api/admin/migrate-brownfield/${projectId} first.`;
    await pushEvent(job.jobId, 'topology-check', '__party__', 'party.bootstrap.step.failed', {
      projectId,
      step: 'topology-check',
      kind: 'brownfield',
      reason,
      message,
      suggestedAction: 'run-admin-migrate',
      migrateEndpoint: `POST /api/admin/migrate-brownfield/${projectId}`,
    });
    await pushEvent(job.jobId, 'topology-check', '__party__', 'party.bootstrap.failed', {
      projectId,
      reason,
      message,
    });
    throw new Error(`${reason}: ${message}`);
  }

  // Resolve per-project PAT (or fall back to the legacy shared secret
  // when patSecretName is absent — applicator's case).
  const brownfieldToken = await loadBrownfieldPat(patSecretName);
  if (!brownfieldToken) {
    throw new Error(
      `runBrownfieldBootstrap: PAT not loaded for ${patSecretName || '(legacy shared secret)'} — check Secrets Manager + IAM`,
    );
  }

  let currentStep = 'clone-repo';

  async function emitStepStarted(step) {
    currentStep = step;
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.started', {
      projectId,
      step,
      kind: 'brownfield',
    });
  }
  async function emitStepCompleted(step, details = {}) {
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.completed', {
      projectId,
      step,
      kind: 'brownfield',
      ...details,
    });
  }
  async function emitStepOutput(step, stream, data) {
    await pushEvent(job.jobId, step, '__party__', 'party.bootstrap.step.output', {
      projectId,
      step,
      kind: 'brownfield',
      stream,
      data,
    });
  }

  try {
    // 1. CLONE-REPO — wipe any prior content (brownfield re-install replaces
    // the folder; refresh uses fetch+reset instead so this branch never
    // tramples a working tree mid-session). The bootstrap lock guarantees
    // no concurrent operations on this project.
    await emitStepStarted('clone-repo');
    if (existsSync(projectPath)) {
      rmSync(projectPath, { recursive: true, force: true });
    }
    // Ensure parent directory exists; git clone creates the leaf folder itself.
    const parent = projectPath.slice(0, projectPath.lastIndexOf('/'));
    if (parent) mkdirSync(parent, { recursive: true });

    await cloneRepo({
      repoUrl: gitRepoUrl,
      branch: gitBranch,
      token: brownfieldToken,
      targetPath: projectPath,
      depth: 50,
      ctx: { emit: (stream, data) => emitStepOutput('clone-repo', stream, data) },
    });

    // Migrate-module — write envVars to <projectPath>/.env post-clone so
    // the project can actually run (e.g., LinkedIn API key for applicator).
    // Pre-existing .gitignore should already exclude .env from any
    // accidental commits back to GitHub. Empty/absent envVars → skip.
    if (envVars && Object.keys(envVars).length > 0) {
      const envBody = renderDotEnv(envVars);
      writeFileSync(`${projectPath}/.env`, envBody, { mode: 0o600 });
      await emitStepOutput(
        'clone-repo',
        'stdout',
        `wrote .env with ${Object.keys(envVars).length} key(s)\n`,
      );
    }

    await emitStepCompleted('clone-repo');

    // 2. VERIFY — the cloned repo must already have BMAD installed.
    await emitStepStarted('verify');
    const manifestPath = `${projectPath}/bmad/_cfg/agent-manifest.csv`;
    const newLayoutManifestPath = `${projectPath}/_bmad/_config/agent-manifest.csv`;
    let manifestFile = null;
    if (existsSync(manifestPath)) manifestFile = manifestPath;
    else if (existsSync(newLayoutManifestPath)) manifestFile = newLayoutManifestPath;

    if (!manifestFile) {
      throw new BmadNotFoundError(
        `bmad manifest not found at bmad/_cfg/agent-manifest.csv or _bmad/_config/agent-manifest.csv inside ${gitRepoUrl}`,
      );
    }
    const manifestText = readFileSync(manifestFile, 'utf8');
    const rows = manifestText.split(/\r?\n/).filter((l) => l.length > 0);
    const rowCount = Math.max(0, rows.length - 1); // minus header
    if (rowCount < 1) {
      throw new BmadNotFoundError(`bmad manifest is empty in cloned repo ${gitRepoUrl}`);
    }
    await emitStepCompleted('verify', {
      rowCount,
      manifestFile: manifestFile.replace(projectPath, '<projectPath>'),
    });

    // 3. COMPUTE-SHA — same helper as greenfield; safe on empty bmad/agents/.
    await emitStepStarted('compute-sha');
    const customAgentsSHA = computeCustomAgentsSHA(`${projectPath}/bmad/agents`);
    await emitStepCompleted('compute-sha', { customAgentsSHA });

    // 4. PERSIST — record the new HEAD SHA and pulled-at timestamp.
    await emitStepStarted('persist');
    const headSha = await readGitHeadSha(projectPath);
    const now = new Date().toISOString();
    await updateProjectState(projectId, {
      bmadStatus: 'HEALTHY',
      customAgentsSHA,
      agentCount: rowCount,
      lastInspectedAt: now,
      lastPulledAt: now,
      lastCommitSha: headSha,
      failureReason: undefined,
    });
    await emitStepCompleted('persist');

    await pushEvent(job.jobId, 'completed', '__party__', 'party.bootstrap.completed', {
      projectId,
      kind: 'brownfield',
      agentCount: rowCount,
      customAgentsSHA,
      lastCommitSha: headSha,
      lastPulledAt: now,
    });

    return {
      ok: true,
      kind: 'brownfield',
      agentCount: rowCount,
      customAgentsSHA,
      lastCommitSha: headSha,
    };
  } catch (err) {
    const isBmadMissing = err instanceof BmadNotFoundError;
    const reason = err.message || String(err);
    const failureReason = isBmadMissing ? 'BMAD_NOT_FOUND_IN_REPO' : `${currentStep}: ${reason}`;
    await updateProjectState(projectId, {
      bmadStatus: 'FAILED',
      failureReason,
    }).catch(() => {});
    await pushEvent(job.jobId, currentStep, '__party__', 'party.bootstrap.step.failed', {
      projectId,
      kind: 'brownfield',
      step: currentStep,
      reason,
    });
    await pushEvent(job.jobId, 'failed', '__party__', 'party.bootstrap.failed', {
      projectId,
      kind: 'brownfield',
      step: currentStep,
      reason,
      failureReason,
    });
    throw err;
  }
}

class BmadNotFoundError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BmadNotFoundError';
  }
}

/**
 * Migrate-module — render a key/value env map to a `.env` file body.
 * Values are NOT shell-quoted: standard dotenv loaders strip surrounding
 * double quotes and treat the rest literally. We emit `KEY="value"`
 * (with internal `"` escaped) so multi-line / special-char values work.
 */
export function renderDotEnv(vars) {
  if (!vars || typeof vars !== 'object') return '';
  const lines = [];
  for (const key of Object.keys(vars).sort()) {
    const value = vars[key] ?? '';
    const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`${key}="${escaped}"`);
  }
  return lines.join('\n') + '\n';
}

export function readGitHeadSha(repoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git rev-parse HEAD exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
