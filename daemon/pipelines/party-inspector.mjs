/**
 * Party Inspector — classify a project folder's BMAD install state.
 *
 * Cheap (filesystem stat + small file reads). Safe to call on every
 * session open. Returns a status classification per tech-spec
 * §"Inspector Steps".
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computeCustomAgentsSHA } from './lib/custom-agents-sha.mjs';

/**
 * Inspect a single project.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.projectPath
 * @param {string} args.expectedBmadVersion
 * @param {string} args.customAgentsSourceDir  — admin repo clone on EC2
 * @returns {Promise<{status:string, bmadVersion?:string, agentCount?:number, customAgentsSHA?:string, expectedCustomAgentsSHA?:string, failureReason?:string}>}
 */
export async function inspectProject({
  projectId,
  projectPath,
  expectedBmadVersion,
  customAgentsSourceDir,
}) {
  if (!projectId || !projectPath) {
    throw new Error('inspectProject: projectId and projectPath are required');
  }

  // Step 1: project dir exists?
  if (!safeIsDir(projectPath)) {
    return { status: 'MISSING', failureReason: 'project directory does not exist' };
  }

  // Resolve the bmad config/manifest locations. BMAD 6.3.x moved from
  // `bmad/_cfg/...` (old) to `_bmad/_config/...` + `_bmad/core/config.yaml`
  // (new). Prefer the new layout; fall back to old only when new is absent —
  // treating the legacy layout as "still healthy" avoids wrongly flipping an
  // older install to MISSING purely because we updated our expectations.
  const newCoreConfig = join(projectPath, '_bmad', 'core', 'config.yaml');
  const newCsvPath = join(projectPath, '_bmad', '_config', 'agent-manifest.csv');
  const oldManifestYaml = join(projectPath, 'bmad', '_cfg', 'manifest.yaml');
  const oldCsvPath = join(projectPath, 'bmad', '_cfg', 'agent-manifest.csv');

  let bmadVersion = null;
  let csvPath;
  if (existsSync(newCoreConfig)) {
    bmadVersion = readInstallationVersion(newCoreConfig); // `version:` line
    csvPath = newCsvPath;
  } else if (existsSync(oldManifestYaml)) {
    bmadVersion = readInstallationVersion(oldManifestYaml);
    csvPath = oldCsvPath;
  } else {
    return { status: 'MISSING' };
  }

  if (!existsSync(csvPath)) {
    return {
      status: 'CORRUPTED',
      bmadVersion: bmadVersion ?? undefined,
      failureReason: `agent-manifest.csv missing at ${csvPath}`,
    };
  }

  // Step 5: parse CSV row count (exclude header)
  let csvLines;
  try {
    csvLines = readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.length > 0);
  } catch (err) {
    return {
      status: 'CORRUPTED',
      bmadVersion: bmadVersion ?? undefined,
      failureReason: `agent-manifest.csv unreadable: ${err.message}`,
    };
  }
  if (csvLines.length < 2) {
    return {
      status: 'CORRUPTED',
      bmadVersion: bmadVersion ?? undefined,
      failureReason: 'agent-manifest.csv has no rows',
    };
  }
  const agentCount = csvLines.length - 1; // minus header

  // Step 6: compute installed customAgentsSHA
  let installedSHA;
  try {
    installedSHA = computeCustomAgentsSHA(join(projectPath, 'bmad', 'agents'));
  } catch (err) {
    return {
      status: 'CORRUPTED',
      bmadVersion: bmadVersion ?? undefined,
      agentCount,
      failureReason: `cannot hash custom agents: ${err.message}`,
    };
  }

  // Step 7: compute expected SHA from admin-repo source clone
  let expectedSHA;
  if (customAgentsSourceDir && existsSync(customAgentsSourceDir)) {
    try {
      expectedSHA = computeCustomAgentsSHA(customAgentsSourceDir);
    } catch {
      // If source can't be read, fall back to version-only drift detection.
      expectedSHA = undefined;
    }
  }

  // Step 8: version drift?
  if (expectedBmadVersion && bmadVersion && bmadVersion !== expectedBmadVersion) {
    return {
      status: 'DRIFTED',
      bmadVersion,
      agentCount,
      customAgentsSHA: installedSHA,
      expectedCustomAgentsSHA: expectedSHA,
      failureReason: `bmad version drift: installed ${bmadVersion}, expected ${expectedBmadVersion}`,
    };
  }

  // Step 8b: SHA drift?
  if (expectedSHA && expectedSHA !== installedSHA) {
    return {
      status: 'DRIFTED',
      bmadVersion,
      agentCount,
      customAgentsSHA: installedSHA,
      expectedCustomAgentsSHA: expectedSHA,
      failureReason: 'custom-agent source drift detected',
    };
  }

  // Step 9: healthy
  return {
    status: 'HEALTHY',
    bmadVersion,
    agentCount,
    customAgentsSHA: installedSHA,
    expectedCustomAgentsSHA: expectedSHA,
  };
}

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readInstallationVersion(manifestPath) {
  try {
    const text = readFileSync(manifestPath, 'utf8');
    // Matches either:
    //   - BMAD 6.0.x legacy YAML: `  version: '6.0.0-alpha.7'`
    //     (indented under `installation:` — leading whitespace allowed)
    //   - BMAD 6.3.x comment header: `# Version: 6.3.0`
    //     (at top of _bmad/core/config.yaml — no YAML key)
    const match = text.match(/(?:^|\n)\s*(?:#\s*)?version:\s*['"]?([^'"\n]+?)['"]?\s*$/im);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Pipeline handler wired through job-router. Inspects one project and
 * persists status to the party-projects row (via provided updater) and
 * emits a summary event.
 */
export async function runPartyInspect(job, ctx) {
  const { projectId, projectPath } = job.partyInspectPayload || {};
  const {
    pushEvent,
    updateProjectState,
    expectedBmadVersion,
    customAgentsSourceDir,
  } = ctx;

  if (!projectId || !projectPath) {
    throw new Error('runPartyInspect: job.partyInspectPayload must include projectId and projectPath');
  }

  const result = await inspectProject({
    projectId,
    projectPath,
    expectedBmadVersion,
    customAgentsSourceDir,
  });

  await updateProjectState(projectId, {
    bmadStatus: result.status,
    bmadVersion: result.bmadVersion,
    agentCount: result.agentCount,
    customAgentsSHA: result.customAgentsSHA,
    lastInspectedAt: new Date().toISOString(),
    failureReason: result.failureReason,
  });

  if (result.status === 'DRIFTED') {
    await pushEvent(job.jobId, 'inspect', '__party__', 'party.inspect.drift.detected', {
      projectId,
      installedSHA: result.customAgentsSHA,
      expectedSHA: result.expectedCustomAgentsSHA,
      bmadVersion: result.bmadVersion,
      reason: result.failureReason,
    });
  }
  await pushEvent(job.jobId, 'inspect', '__party__', 'party.inspect.completed', {
    projectId,
    ...result,
  });

  return result;
}
