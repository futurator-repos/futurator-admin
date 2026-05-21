/**
 * reflector-apply.mjs — Pipeline v2 Phase 3-C Epic 6 (2026-05-20).
 *
 * Originally a stub (PR-76, Story 3-E-3-1). This commit replaces the
 * stub with the real on-disk apply path. The daemon's REFLECTOR-APPLY
 * pipeline lands an operator-confirmed proposal by routing on the
 * proposal's `target` field:
 *
 *   project-claude-md → claude-md-writer.appendArchitectureDecision
 *                       (sections beyond "Architecture decisions" use a
 *                       small section-append shim below)
 *   project-skill     → skill-installer.applyConfirmedProposals
 *                       (one-skill manifest add + vendor)
 *   org-skill         → DEFERRED — needs `gh pr create` against
 *                       futurator-skills (Epic 1 follow-on)
 *   agent-persona     → DEFERRED — needs futurator-personas repo
 *   pipeline-config   → DEFERRED — no operator-config repo defined yet
 *   tool-wrapper      → DEFERRED — skill-creator sub-plan path
 *
 * After applying, a small git commit + push (when possible) lands the
 * change with `Agent: REFLECTOR-APPLY` + `Reflection-Id:` trailers per
 * v2.5 §23 so `git log --grep="Agent: REFLECTOR-APPLY"` reconstructs
 * the knowledge-ratchet history.
 *
 * Idempotency: each target-specific writer is itself idempotent.
 * Re-applying the same proposal is safe (the underlying writers
 * short-circuit on duplicate content).
 */

import { spawn } from 'node:child_process';

import { appendArchitectureDecision } from '../lib/claude-md-writer.mjs';
import { applyConfirmedProposals } from './skill-installer.mjs';

/**
 * Apply a confirmed reflection proposal. The public entry point — the
 * daemon's executeReflectorJob (or the Reflection Inbox confirm-action
 * API) calls this with the row from `futurator-reflections`.
 *
 * @param {{
 *   workingDir: string,
 *   projectSlug: string,
 *   proposal: {
 *     id: string,
 *     target: string,
 *     planId?: string,
 *     content?: object,
 *     rationale?: string,
 *   },
 *   logFn?: (level: string, msg: string) => void,
 *   spawnImpl?: typeof spawn,
 * }} args
 * @returns {Promise<{
 *   status: 'applied' | 'noop' | 'deferred' | 'failed',
 *   target: string,
 *   reason?: string,
 *   commitSha?: string,
 *   error?: string,
 * }>}
 */
export async function applyReflection({
  workingDir,
  projectSlug,
  proposal,
  logFn,
  spawnImpl = spawn,
}) {
  const log = logFn || (() => {});
  if (!workingDir) throw new Error('applyReflection: workingDir required');
  if (!proposal || !proposal.target) {
    throw new Error('applyReflection: proposal.target required');
  }

  const target = proposal.target;
  log('info', `reflector-apply: target=${target} proposal=${proposal.id} slug=${projectSlug}`);

  let outcome;
  switch (target) {
    case 'project-claude-md':
    case 'claude-md': {
      outcome = await applyClaudeMdProposal({ workingDir, proposal, log });
      break;
    }
    case 'project-skill': {
      outcome = await applyProjectSkillProposal({ workingDir, projectSlug, proposal, log });
      break;
    }
    case 'org-skill':
    case 'agent-persona':
    case 'pipeline-config':
    case 'tool-wrapper': {
      log('warn', `reflector-apply: target=${target} is deferred to follow-on`);
      return {
        status: 'deferred',
        target,
        reason: `${target} apply path is held back (Epic 6 follow-on — needs operator-side repo provisioning)`,
      };
    }
    default: {
      log('warn', `reflector-apply: unknown target=${target} — no-op`);
      return { status: 'noop', target, reason: `unknown target "${target}"` };
    }
  }

  if (!outcome.ok) {
    return {
      status: 'failed',
      target,
      reason: outcome.reason,
      error: outcome.error,
    };
  }

  // Best-effort commit + push. The writer already wrote the file(s);
  // a commit failure leaves the change on disk for manual recovery.
  let commitSha;
  try {
    const commitResult = await commitReflection({
      workingDir,
      proposal,
      target,
      spawnImpl,
    });
    commitSha = commitResult.commitSha;
    if (!commitResult.ok) {
      log('warn', `reflector-apply: commit failed (non-fatal): ${commitResult.reason}`);
    }
  } catch (err) {
    log('warn', `reflector-apply: commit threw (non-fatal): ${err?.message || err}`);
  }

  return { status: 'applied', target, commitSha };
}

// ── target=project-claude-md ───────────────────────────────────────────

async function applyClaudeMdProposal({ workingDir, proposal, log }) {
  // Default routing: append as Architecture decision. The proposal's
  // `content` field carries `{ section?, decision, rationale }`; absent
  // section means Architecture decisions.
  const content = proposal.content ?? {};
  const decision = content.decision ?? proposal.rationale ?? `Reflection ${proposal.id}`;
  const rationale = content.rationale ?? proposal.rationale ?? 'see Reflection Inbox';
  try {
    const r = await appendArchitectureDecision({
      workingDir,
      storyId: `reflection:${proposal.id}`,
      decision: String(decision).slice(0, 200),
      rationale: String(rationale).slice(0, 200),
    });
    if (!r.written) {
      log('info', `reflector-apply claude-md: skipped (${r.reason})`);
      return { ok: true, idempotent: true };
    }
    return { ok: true, newSha: r.newSha };
  } catch (err) {
    return { ok: false, reason: 'claude-md-write-failed', error: String(err?.message || err) };
  }
}

// ── target=project-skill ──────────────────────────────────────────────

async function applyProjectSkillProposal({ workingDir, projectSlug, proposal, log }) {
  // The proposal's `content` is expected to carry `{ skill, source,
  // version, manifestBucket, rationale }` shaped like a SkillScoutProposal.
  const c = proposal.content ?? {};
  if (
    typeof c.skill !== 'string' ||
    typeof c.source !== 'string' ||
    typeof c.manifestBucket !== 'string' ||
    typeof c.version !== 'string'
  ) {
    return {
      ok: false,
      reason: 'project-skill-payload-malformed',
      error: 'proposal.content missing required {skill,source,manifestBucket,version}',
    };
  }
  try {
    const output = {
      trigger: 'T0', // REFLECTOR-originated; T0 is a sentinel for "non-SCOUT-trigger"
      projectSlug,
      proposals: [
        {
          kind: 'add',
          source: c.source,
          skill: c.skill,
          manifestBucket: c.manifestBucket,
          version: c.version,
          rationale: c.rationale ?? proposal.rationale ?? 'promoted by REFLECTOR',
          verifyNotes: 'promoted from project-local pattern',
          confidence: 0.9,
        },
      ],
    };
    const r = await applyConfirmedProposals({
      projectPath: workingDir,
      output,
      source: 'operator-confirm',
    });
    log(
      'info',
      `reflector-apply project-skill: written=${r.written} vendoredCount=${r.vendoredCount ?? 0}`,
    );
    return { ok: r.ok !== false };
  } catch (err) {
    return { ok: false, reason: 'project-skill-apply-failed', error: String(err?.message || err) };
  }
}

// ── commit + push helper ──────────────────────────────────────────────

function runGit(workingDir, args, spawnImpl) {
  return new Promise((resolve) => {
    const proc = spawnImpl('git', args, { cwd: workingDir });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) =>
      resolve({ ok: false, stdout, stderr: stderr + err.message, code: null }),
    );
    proc.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, code }));
  });
}

async function commitReflection({ workingDir, proposal, target, spawnImpl }) {
  // Stage only the targets we know we touched.
  let pathsToAdd;
  if (target === 'project-claude-md' || target === 'claude-md') {
    pathsToAdd = ['CLAUDE.md'];
  } else if (target === 'project-skill') {
    pathsToAdd = ['.claude/skills.manifest.yaml', '.claude/skills/'];
  } else {
    return { ok: false, reason: 'no-paths-for-target' };
  }

  const addResult = await runGit(workingDir, ['add', ...pathsToAdd], spawnImpl);
  if (!addResult.ok) {
    return { ok: false, reason: 'git-add-failed', stderr: addResult.stderr.slice(-500) };
  }

  const diff = await runGit(workingDir, ['diff', '--cached', '--name-only'], spawnImpl);
  if (!diff.stdout.trim()) {
    // Nothing changed — idempotent re-apply.
    return { ok: true, skipped: true, reason: 'no-changes' };
  }

  const subject = `chore(reflection): apply ${proposal.id} (${target})`;
  const body = [
    '',
    `Target: ${target}`,
    `Reflection-Id: ${proposal.id}`,
    proposal.planId ? `Plan-Id: ${proposal.planId}` : null,
    '',
    'Agent: REFLECTOR-APPLY',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const commit = await runGit(
    workingDir,
    [
      '-c',
      'user.email=reflector@futurator.local',
      '-c',
      'user.name=REFLECTOR-APPLY',
      'commit',
      '-m',
      subject + '\n' + body,
    ],
    spawnImpl,
  );
  if (!commit.ok) {
    return { ok: false, reason: 'git-commit-failed', stderr: commit.stderr.slice(-500) };
  }

  // Pull the new commit's SHA so callers can record it on the reflection row.
  const sha = await runGit(workingDir, ['rev-parse', 'HEAD'], spawnImpl);
  const commitSha = sha.ok ? sha.stdout.trim() : undefined;

  // Best-effort push.
  await runGit(workingDir, ['push'], spawnImpl).catch(() => null);

  return { ok: true, commitSha };
}
