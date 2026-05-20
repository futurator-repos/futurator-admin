/**
 * skill-install-job-runner.mjs — Pipeline v2 Phase 3-C Epic 3 (Story
 * 3.6, 2026-05-20).
 *
 * Operator-confirmed skill installs land here from the API Lambda's
 * `POST /api/skill-scout/proposals/:itemId/confirm|edit` path. The
 * payload carries the proposals subset the operator accepted; we run
 * the shared installer (Story 3.2) to apply them, then commit the
 * manifest + vendored SKILL.md changes with `Agent: SKILL-SCOUT`
 * trailer per v2.5 §39 step 5.
 *
 * Auto-confirm dispositions DON'T go through here — they call
 * applyConfirmedProposals directly from inside the SKILL-SCOUT job
 * runner (Story 3.1). The split keeps the operator-action path
 * easily auditable via job-row history.
 */

import { spawn } from 'node:child_process';

/**
 * Validate that the job carries the fields the install runner needs.
 */
export function validateSkillInstallJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'skill-install') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.skillInstallPayload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'skillInstallPayload-missing' };
  }
  if (typeof p.projectSlug !== 'string' || p.projectSlug.length === 0) {
    return { ok: false, reason: 'projectSlug-missing' };
  }
  if (!p.output || !Array.isArray(p.output.proposals)) {
    return { ok: false, reason: 'output.proposals-missing' };
  }
  if (p.source !== 'auto-confirm' && p.source !== 'operator-confirm') {
    return { ok: false, reason: 'source-invalid' };
  }
  return { ok: true };
}

/**
 * Run a git command inside the project worktree. Returns { ok, stdout,
 * stderr, exitCode }. Failures are non-fatal at the caller's discretion.
 *
 * @param {string} projectPath
 * @param {string[]} args
 * @param {function} [spawnImpl] — injectable for tests
 */
function runGit(projectPath, args, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const proc = spawnImpl('git', args, { cwd: projectPath });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: stderr + err.message, exitCode: null });
    });
    proc.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Commit + push the manifest + SKILL.md changes that applyConfirmedProposals
 * just wrote. Best-effort: a commit failure surfaces but doesn't fail the
 * install (the manifest is already on disk + the operator can re-push
 * manually).
 *
 * Commit-trailer attribution mirrors v2.5 §23 commit-metadata template
 * + §39 step 5's `Agent: SKILL-SCOUT` requirement.
 */
async function commitSkillChanges({
  projectPath, projectSlug, output, source, originAttentionId, spawnImpl = spawn,
}) {
  // Stage only the skill artifacts. Other in-flight changes (e.g. a
  // running plan's wip branch) MUST NOT be swept into this commit.
  const addResult = await runGit(
    projectPath,
    ['add', '.claude/skills.manifest.yaml', '.claude/skills/'],
    spawnImpl,
  );
  if (!addResult.ok) {
    return { ok: false, reason: 'git-add-failed', stderr: addResult.stderr.slice(-500) };
  }

  // Check whether there's anything actually staged. Empty git diff →
  // no-op success (idempotency: same proposal applied twice).
  const diff = await runGit(projectPath, ['diff', '--cached', '--name-only'], spawnImpl);
  if (!diff.stdout.trim()) {
    return { ok: true, skipped: true, reason: 'no-changes' };
  }

  const skills = output.proposals
    .map((p) => `${p.kind} ${p.skill}@${p.source}`)
    .join(', ');
  const subject = `chore(skills): ${source} — ${output.proposals.length} proposal(s)`;
  const body = [
    '',
    `Trigger: ${output.trigger}`,
    `Source:  ${source}`,
    `Project: ${projectSlug}`,
    originAttentionId ? `OriginAttentionId: ${originAttentionId}` : null,
    '',
    `Skills-Changed: ${skills}`,
    `Agent: SKILL-SCOUT`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const commit = await runGit(
    projectPath,
    [
      '-c', 'user.email=skill-scout@futurator.local',
      '-c', 'user.name=SKILL-SCOUT',
      'commit', '-m', subject + '\n' + body,
    ],
    spawnImpl,
  );
  if (!commit.ok) {
    return { ok: false, reason: 'git-commit-failed', stderr: commit.stderr.slice(-500) };
  }

  // Push — best-effort. Defaults to current branch's upstream which
  // for project worktrees is the per-app github remote. The git
  // command's exit is propagated but doesn't fail the install: the
  // operator can re-push manually after fixing local conflicts.
  const push = await runGit(projectPath, ['push'], spawnImpl);
  return {
    ok: true,
    skipped: false,
    pushed: push.ok,
    pushError: push.ok ? undefined : push.stderr.slice(-500),
  };
}

/**
 * Run the skill-install job end-to-end.
 *
 * @param {object} job
 * @param {object} ctx
 * @param {function} ctx.applyConfirmedProposals  — from skill-installer.mjs
 * @param {function} ctx.writeAttentionItem
 * @param {function} ctx.pushEvent
 * @param {function} ctx.getProjectPath  — `(slug) => string`
 * @param {function} [ctx.spawnImpl]     — injectable git spawn for tests
 */
export async function runSkillInstallJob(job, ctx) {
  const validation = validateSkillInstallJob(job);
  if (!validation.ok) {
    return { ok: false, reason: `validation: ${validation.reason}` };
  }

  const { projectSlug, appId, output, source, originAttentionId } = job.skillInstallPayload;
  const projectPath = ctx.getProjectPath(projectSlug);

  let applyResult;
  try {
    applyResult = await ctx.applyConfirmedProposals({
      projectPath,
      projectSlug,
      output,
      source,
    });
  } catch (err) {
    await ctx.writeAttentionItem({
      appId: appId ?? projectSlug,
      planId: null,
      severity: 'medium',
      category: 'skill-install-failed',
      title: `Skill install failed for ${projectSlug}: ${err?.message || err}`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `skill-install-failed:${projectSlug}:${originAttentionId ?? 'auto'}`,
    });
    return { ok: false, reason: 'apply-failed', error: String(err?.message || err) };
  }

  // Pass-through any vendor-skills attention the installer surfaced.
  // (The installer already attached it to applyResult; we just write it.)
  if (applyResult.vendorAttention) {
    await ctx.writeAttentionItem({
      appId: appId ?? projectSlug,
      planId: null,
      severity: applyResult.vendorAttention.severity ?? 'medium',
      category: applyResult.vendorAttention.category,
      title:
        applyResult.vendorAttention.category === 'skill-manifest-out-of-sync'
          ? `Skill vendor drift after install: ${projectSlug}`
          : `Skill vendor sync failed after install: ${projectSlug}`,
      body: `Manifest write committed; vendor-skills reported issues.`,
      dedupKey: `skill-install-vendor:${projectSlug}:${originAttentionId ?? 'auto'}`,
    });
  }

  // Commit + push the change so the operator can see the SKILL-SCOUT
  // attribution in `git log`. Best-effort — install is "done" once
  // the manifest is on disk + vendored.
  const commitResult = await commitSkillChanges({
    projectPath,
    projectSlug,
    output,
    source,
    originAttentionId,
    spawnImpl: ctx.spawnImpl,
  });
  if (!commitResult.ok) {
    // Manifest is on disk, vendor ran — install was effective. Commit
    // failure is a low-severity housekeeping issue.
    await ctx.writeAttentionItem({
      appId: appId ?? projectSlug,
      planId: null,
      severity: 'low',
      category: 'skill-install-failed',
      title: `Skill install: git commit/push failed for ${projectSlug} (manifest is on disk)`,
      body: `${commitResult.reason}: ${commitResult.stderr ?? ''}`.slice(0, 1500),
      dedupKey: `skill-install-commit:${projectSlug}:${originAttentionId ?? 'auto'}`,
    });
  }

  return {
    ok: true,
    written: applyResult.written,
    added: applyResult.added,
    upgraded: applyResult.upgraded,
    removed: applyResult.removed,
    vendoredCount: applyResult.vendoredCount,
    drift: applyResult.drift,
    committed: commitResult.ok && !commitResult.skipped,
    pushed: commitResult.pushed === true,
  };
}
