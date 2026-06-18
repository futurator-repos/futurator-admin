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
 *   project-skill     → two paths, discriminated by `content` shape (Skills
 *                       Institution Story 1.1):
 *                         • content is an OBJECT {skill,source,manifestBucket,
 *                           version} → install an EXISTING federation skill by
 *                           name (skill-installer.applyConfirmedProposals).
 *                         • content is a STRING (the real reflection shape) →
 *                           AUTHOR a NEW app-evolved skill from that content:
 *                           write `.claude/skills/<skillName>/SKILL.md`, add a
 *                           manifest pin (vendor skips it — body on disk), and
 *                           commit. `action: create` authors, `tune` rewrites an
 *                           existing app skill, `promote-from-project` is
 *                           deferred (needs the daemon→skill-proposals write).
 *                       Every authored body is Gate-1 scanned BEFORE commit
 *                       (Story 1.3); a blocked body is never written.
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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

import { appendArchitectureDecision } from '../lib/claude-md-writer.mjs';
import { applyConfirmedProposals } from './skill-installer.mjs';
import { scanSkill } from '../lib/security-scan.mjs';

/** A slug usable as a directory name + skill id (mirrors skill-authoring.ts). */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MANIFEST_REL = '.claude/skills.manifest.yaml';
const SKILLS_DIR_REL = '.claude/skills';
/** Sentinel source for locally-authored skills — vendor-skills skips on-disk bodies. */
const APP_EVOLVED_SOURCE = 'app-evolved';

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

  // A target writer may DEFER (e.g. promote-from-project needs the daemon→
  // skill-proposals write that isn't wired yet) — surface it distinctly so the
  // reflection stays pending rather than being marked failed/applied.
  if (outcome.deferred) {
    return { status: 'deferred', target, reason: outcome.reason };
  }

  // A Gate-1 block is a security quarantine, not a transient failure — surface
  // the scan report so the operator can see exactly what tripped.
  if (outcome.quarantined) {
    return {
      status: 'failed',
      target,
      reason: 'gate1-quarantined',
      error: outcome.reason,
      scanReport: outcome.scanReport,
    };
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
  const c = proposal.content;

  // Path A — AUTHOR a NEW app-evolved skill from string content (the real
  // reflection shape: `content` is the lesson/body text). This is the spine of
  // success criterion #1 — a lesson becomes a brand-new skill the next run uses.
  if (typeof c === 'string' && c.trim().length > 0) {
    return authorAppSkill({ workingDir, proposal, content: c, log });
  }

  // Path B — install an EXISTING federation skill by name. The legacy
  // (Epic 6 / scout-promotion) shape: `content` is an OBJECT carrying federation
  // coordinates. Preserved unchanged.
  const obj = c ?? {};
  if (
    typeof obj.skill !== 'string' ||
    typeof obj.source !== 'string' ||
    typeof obj.manifestBucket !== 'string' ||
    typeof obj.version !== 'string'
  ) {
    return {
      ok: false,
      reason: 'project-skill-payload-malformed',
      error: 'proposal.content must be a non-empty string (author) or {skill,source,manifestBucket,version} (install)',
    };
  }
  return installFederationSkill({ workingDir, projectSlug, proposal, c: obj, log });
}

async function installFederationSkill({ workingDir, projectSlug, proposal, c, log }) {
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

// ── author a NEW app-evolved skill from a reflection's content (Story 1.1) ──

/** Assemble a SKILL.md (frontmatter name+description + body). Mirror of skill-authoring.ts. */
function buildSkillMd({ name, description, body }) {
  const safeDesc = `"${String(description).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${String(body).trim()}\n`;
}

/** First non-empty prose line, heading-stripped, as a short description. */
function deriveDescription(proposal, content) {
  const fromRationale = (proposal.rationale ?? '').trim();
  if (fromRationale) return fromRationale.slice(0, 200);
  const firstLine = String(content)
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return (firstLine ?? `app-evolved skill ${proposal.skillName}`).slice(0, 200);
}

/**
 * Add (or refresh) an app-evolved manifest pin so the skill is tracked +
 * prompt-prioritized. vendor-skills skips it because the body is on disk, so the
 * sentinel `app-evolved` source never triggers a (failing) federation fetch.
 * Idempotent. Best-effort: a manifest read/write failure does NOT block the
 * authored skill (it's loadable from disk regardless).
 */
function addAppEvolvedManifestPin({ workingDir, skillName, rationale, log }) {
  const manifestPath = join(workingDir, MANIFEST_REL);
  if (!existsSync(manifestPath)) return; // no manifest → skill still loads from disk
  try {
    const manifest = parseYaml(readFileSync(manifestPath, 'utf-8')) || {};
    if (!Array.isArray(manifest.domain)) manifest.domain = [];
    const exists = manifest.domain.some(
      (e) => e?.skill === skillName && e?.source === APP_EVOLVED_SOURCE,
    );
    if (!exists) {
      manifest.domain.push({
        source: APP_EVOLVED_SOURCE,
        skill: skillName,
        version: 'local',
        ...(rationale ? { rationale: String(rationale).slice(0, 300) } : {}),
      });
      manifest['last-modified-by'] = `reflector-apply@${new Date().toISOString()}`;
      writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');
    }
  } catch (err) {
    log('warn', `reflector-apply author: manifest pin failed (non-fatal): ${err?.message || err}`);
  }
}

async function authorAppSkill({ workingDir, proposal, content, log }) {
  const skillName = proposal.skillName;
  const action = proposal.action ?? 'create';

  // promote-from-project graduates an app skill to the GLOBAL registry as a
  // skill-proposals row — that daemon→DDB write is an E3 follow-on, not wired.
  if (action === 'promote-from-project') {
    return {
      deferred: true,
      reason:
        'promote-from-project stages a global skill-proposals row (E3) — daemon→skill-proposals write not yet wired',
    };
  }

  if (!skillName || !SKILL_NAME_RE.test(skillName)) {
    return {
      ok: false,
      reason: 'app-skill-name-invalid',
      error: `proposal.skillName "${skillName}" must match ${SKILL_NAME_RE}`,
    };
  }

  // Gate-1 BEFORE any write — a malicious reflection must not author executable
  // instructions into the app (Story 1.3).
  const scan = scanSkill({ body: content });
  if (scan.securityStatus === 'quarantined') {
    log(
      'warn',
      `reflector-apply author: ${skillName} QUARANTINED by Gate-1 (${scan.patternsHit
        .filter((h) => h.severity === 'blocking')
        .map((h) => h.id)
        .join(', ')}) — not written`,
    );
    return {
      quarantined: true,
      reason: `Gate-1 blocked: ${scan.patternsHit
        .filter((h) => h.severity === 'blocking')
        .map((h) => h.id)
        .join(', ')}`,
      scanReport: scan,
    };
  }

  const skillDir = join(workingDir, SKILLS_DIR_REL, skillName);
  const skillMdPath = join(skillDir, 'SKILL.md');
  const isTune = action === 'tune';
  if (isTune && !existsSync(skillMdPath)) {
    log('info', `reflector-apply author: tune target ${skillName} absent — authoring as new`);
  }

  const description = deriveDescription(proposal, content);
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillMdPath, buildSkillMd({ name: skillName, description, body: content }), 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'app-skill-write-failed', error: String(err?.message || err) };
  }

  addAppEvolvedManifestPin({ workingDir, skillName, rationale: proposal.rationale, log });
  log(
    'info',
    `reflector-apply author: ${isTune ? 'tuned' : 'created'} app-evolved skill ${skillName} (security=${scan.securityStatus})`,
  );
  return { ok: true, authored: skillName, securityStatus: scan.securityStatus };
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
