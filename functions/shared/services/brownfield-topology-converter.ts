/**
 * brownfield-topology-converter.ts — Story 20.4 (party-push Epic 20).
 *
 * Admin-driven conversion of a brownfield project's working-tree clone
 * to the bare+worktree topology party-push needs:
 *
 *   Before:  /home/ubuntu/projects/<projectId>/           ← regular clone
 *            └── .git/                                    (full repo)
 *
 *   After:   /home/ubuntu/repos/<projectId>.git/          ← bare repo
 *            /home/ubuntu/projects/<projectId>/           ← worktree of bare
 *            └── .git                                     (file pointer to bare)
 *
 * Why bare+worktree: party-push creates per-session worktrees
 * (`<projectId>/_party/<sidShort>/`) that share the bare's object store
 * — cheaper than a full clone per session, and decoupling the bare from
 * the operator's "main" working tree means a per-session worktree can be
 * reaped without touching anything operator-facing.
 *
 * This module DOES NOT run SSM directly — it builds the deps + the SSM
 * script, the caller (API handler) wires `sendSsmCommand` /
 * `waitForSsmOutput` via the existing `PlanFolderDeps` shape so the
 * audit / event integration stays consistent.
 *
 * Per Story 20.4 + Free Explorer §13.7: explicit admin action gated by
 * pre-flight checks (no active plans / no active sessions / clean tree).
 */

import * as partyProjectsRepo from '../repositories/party-projects-repository';
import * as partySessionsRepo from '../repositories/party-sessions-repository';
import { getActivePlanForApp } from '../repositories/plan-repository';
import { listAllSessions as listAllFreeAgentSessions } from '../repositories/free-agent-sessions-repository';
import type { PlanFolderDeps } from './plan-folder-service';

/**
 * Project IDs that reach the SSM script paths. Defense-in-depth: must
 * match the kebab-case slug convention used everywhere else (no shell-meta).
 */
const PROJECT_ID_SAFE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export interface BrownfieldConvertOptions {
  /** Brownfield project to convert. */
  projectId: string;
  /** Operator id for the audit row. */
  operatorId: string;
}

export interface BrownfieldConvertSuccess {
  converted: true;
  bareRepoPath: string;
  worktreePath: string;
  headSha: string;
}

export interface BrownfieldConvertIdempotent {
  converted: false;
  reason: 'already-bare-topology';
  bareRepoPath: string;
  worktreePath: string;
  headSha: string;
}

export interface BrownfieldConvertBlocked {
  converted: false;
  reason: 'preflight-failed';
  blockers: BrownfieldPreflightBlocker[];
}

export interface BrownfieldConvertFailure {
  converted: false;
  reason: 'conversion-failed';
  detail: string;
}

export type BrownfieldConvertResult =
  | BrownfieldConvertSuccess
  | BrownfieldConvertIdempotent
  | BrownfieldConvertBlocked
  | BrownfieldConvertFailure;

export type BrownfieldPreflightBlocker =
  | { code: 'NOT_FOUND'; detail: string }
  | { code: 'NOT_BROWNFIELD'; detail: string }
  | { code: 'ACTIVE_PLAN'; detail: string }
  | { code: 'ACTIVE_FREE_AGENT_SESSION'; detail: string }
  | { code: 'ACTIVE_PARTY_SESSION'; detail: string }
  | { code: 'DIRTY_TREE'; detail: string }
  | { code: 'WORKING_TREE_MISSING'; detail: string };

/**
 * Run the pre-flight checks. Pure-ish: hits DDB + SSM (the dirty-tree
 * check needs a `git status --porcelain` on EC2) but doesn't mutate
 * anything. Returns the full list of blockers — callers should NOT
 * proceed if `blockers.length > 0`.
 *
 * @param args.projectId — kebab-case slug
 * @param deps — same SSM deps used by `plan-folder-service` helpers
 */
export async function runConvertPreflight(
  args: { projectId: string },
  deps: PlanFolderDeps,
): Promise<BrownfieldPreflightBlocker[]> {
  if (!PROJECT_ID_SAFE.test(args.projectId)) {
    return [{ code: 'NOT_FOUND', detail: `projectId "${args.projectId}" violates slug pattern` }];
  }
  const blockers: BrownfieldPreflightBlocker[] = [];

  // Check 1: project exists + is brownfield.
  const project = await partyProjectsRepo.getProject(args.projectId);
  if (!project) {
    return [{ code: 'NOT_FOUND', detail: `project "${args.projectId}" not found` }];
  }
  if (project.kind !== 'brownfield') {
    return [
      {
        code: 'NOT_BROWNFIELD',
        detail: `project "${args.projectId}" is kind='${project.kind}' (only brownfield needs conversion)`,
      },
    ];
  }

  // Check 2: no active pipeline-v2 plans.
  const activePlan = await getActivePlanForApp(args.projectId);
  if (activePlan) {
    blockers.push({
      code: 'ACTIVE_PLAN',
      detail: `active plan "${activePlan.name}" (${activePlan.planId}) is in status '${activePlan.status}'`,
    });
  }

  // Check 3: no active free-agent sessions.
  // free-agent doesn't have a per-project query helper — small table size,
  // single Scan + filter is fine for an infrequent admin op.
  const freeAgentSessions = await listAllFreeAgentSessions();
  const activeFreeAgent = freeAgentSessions.filter(
    (s) => s.projectId === args.projectId && (s.status === 'ACTIVE' || s.status === 'PROCESSING'),
  );
  if (activeFreeAgent.length > 0) {
    blockers.push({
      code: 'ACTIVE_FREE_AGENT_SESSION',
      detail: `${activeFreeAgent.length} active free-agent session(s): ${activeFreeAgent
        .map((s) => s.sessionId.slice(0, 8))
        .join(', ')}`,
    });
  }

  // Check 4: no active party sessions (any status that isn't terminal — we
  // gate on PROCESSING here since that's what blocks party-bootstrap too;
  // an ACTIVE session not currently turning is OK to convert under).
  const partyBusy = await partySessionsRepo.hasProcessingSession(args.projectId);
  if (partyBusy) {
    blockers.push({
      code: 'ACTIVE_PARTY_SESSION',
      detail: 'a party session is currently processing a turn',
    });
  }

  // Check 5: working tree clean (no uncommitted changes).
  const workingDir = `/home/ubuntu/projects/${args.projectId}`;
  const cmd = [
    `if [ ! -d "${workingDir}" ]; then echo "TREE_MISSING"; exit 0; fi`,
    `cd "${workingDir}"`,
    `if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "NOT_A_REPO"; exit 0; fi`,
    `PORC=$(git status --porcelain 2>/dev/null || true)`,
    `if [ -z "$PORC" ]; then echo "CLEAN"; else echo "DIRTY"; printf '%s\\n' "$PORC" | head -20; fi`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('TREE_MISSING')) {
      blockers.push({ code: 'WORKING_TREE_MISSING', detail: `${workingDir} does not exist` });
    } else if (output.includes('NOT_A_REPO')) {
      blockers.push({
        code: 'WORKING_TREE_MISSING',
        detail: `${workingDir} is not a git repository`,
      });
    } else if (output.includes('DIRTY')) {
      const lines = output
        .split('\n')
        .filter((l) => l.startsWith(' ') || l.startsWith('?') || l.startsWith('M'))
        .slice(0, 5);
      blockers.push({
        code: 'DIRTY_TREE',
        detail: `working tree has uncommitted changes${lines.length > 0 ? `: ${lines.join('; ')}` : ''}`,
      });
    } else if (!output.includes('CLEAN')) {
      blockers.push({
        code: 'DIRTY_TREE',
        detail: `unexpected output from porcelain probe: ${output.slice(0, 200)}`,
      });
    }
  } catch (err) {
    blockers.push({
      code: 'DIRTY_TREE',
      detail: `porcelain probe SSM failure: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return blockers;
}

/**
 * Check if the project is ALREADY on the bare+worktree topology. Pure
 * idempotence guard — runs before the destructive conversion to detect
 * the "this project was created bare from the start" case (e.g. snake-4
 * from greenfield bootstrap) or a re-run of the conversion endpoint.
 *
 * Returns `{ alreadyBare: true, headSha }` when bare repo exists AND
 * the working tree is attached to it as a worktree, else `{ alreadyBare: false }`.
 */
export async function isAlreadyBareTopology(
  args: { projectId: string },
  deps: PlanFolderDeps,
): Promise<{ alreadyBare: boolean; headSha?: string }> {
  if (!PROJECT_ID_SAFE.test(args.projectId)) return { alreadyBare: false };
  const workingDir = `/home/ubuntu/projects/${args.projectId}`;
  const bareDir = `/home/ubuntu/repos/${args.projectId}.git`;
  const cmd = [
    `if [ ! -d "${bareDir}" ]; then echo "BARE_ABSENT"; exit 0; fi`,
    `if [ ! -d "${workingDir}" ]; then echo "TREE_ABSENT"; exit 0; fi`,
    // Worktree-pointer check: the worktree's .git is a FILE, not a dir,
    // and it points back at the bare repo.
    `if [ ! -f "${workingDir}/.git" ]; then echo "NOT_WORKTREE"; exit 0; fi`,
    `GITDIR=$(cat "${workingDir}/.git" | sed -n 's|^gitdir: ||p' | head -1)`,
    `if ! printf '%s' "$GITDIR" | grep -q "${args.projectId}.git"; then echo "WRONG_BARE: $GITDIR"; exit 0; fi`,
    `cd "${workingDir}"`,
    `SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `echo "ALREADY_BARE_SHA=$SHA"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('ALREADY_BARE_SHA=')) {
      const match = output.match(/ALREADY_BARE_SHA=([a-f0-9]{40})/);
      return { alreadyBare: true, headSha: match?.[1] };
    }
    return { alreadyBare: false };
  } catch {
    return { alreadyBare: false };
  }
}

/**
 * Perform the actual conversion. Caller MUST run `runConvertPreflight`
 * and confirm zero blockers AND `isAlreadyBareTopology({ alreadyBare: false })`
 * before invoking.
 *
 * Conversion steps (the SSM script):
 *   1. Capture the pre-conversion HEAD SHA (for the verify step at the end).
 *   2. Stash the operator's `.env` (post-Migrate-module work; gitignored
 *      but we don't want to nuke it).
 *   3. `git clone --bare https://<pat>@github.com/<owner>/<repo>.git
 *      /home/ubuntu/repos/<projectId>.git`
 *   4. `rm -rf /home/ubuntu/projects/<projectId>`
 *   5. `git --git-dir=<bare> worktree add /home/ubuntu/projects/<projectId> <branch>`
 *   6. Restore `.env`.
 *   7. Verify `git rev-parse HEAD` matches the pre-conversion SHA.
 *
 * Rollback policy: if step 4 or later fails, the working tree might be
 * partially destroyed. We don't attempt automatic rollback (re-cloning
 * from the bare repo is the recovery path, and SSM doesn't have
 * transactional semantics anyway). The audit row's `result.detail`
 * records exactly which step failed so the operator can recover manually.
 */
export async function performBrownfieldConversion(
  args: { projectId: string; gitBranch: string; pat: string },
  deps: PlanFolderDeps,
): Promise<BrownfieldConvertResult> {
  if (!PROJECT_ID_SAFE.test(args.projectId)) {
    return {
      converted: false,
      reason: 'conversion-failed',
      detail: `projectId "${args.projectId}" violates slug pattern`,
    };
  }
  const project = await partyProjectsRepo.getProject(args.projectId);
  if (!project || !project.gitRepoUrl) {
    return {
      converted: false,
      reason: 'conversion-failed',
      detail: 'project missing or has no gitRepoUrl',
    };
  }

  const workingDir = `/home/ubuntu/projects/${args.projectId}`;
  const bareDir = `/home/ubuntu/repos/${args.projectId}.git`;
  const envBackup = `/tmp/migrate-env-${args.projectId}-$(date +%s)`;

  // Build the auth'd clone URL. The PAT is interpolated here; SSM
  // command logs in CloudWatch redact via the daemon's existing
  // pat-redactor (verified during pipeline-v2 brownfield work). We don't
  // log the SSM command string ourselves.
  const cloneUrl = project.gitRepoUrl.replace(/^https:\/\//, `https://x-access-token:${args.pat}@`);

  const cmd = [
    `set -e`,
    `mkdir -p /home/ubuntu/repos`,
    // 1. Capture pre-SHA + verify the working tree exists.
    `if [ ! -d "${workingDir}/.git" ]; then echo "PRE_NO_GIT_DIR"; exit 1; fi`,
    `cd "${workingDir}"`,
    `PRE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `if [ -z "$PRE_SHA" ]; then echo "PRE_NO_HEAD"; exit 1; fi`,
    `echo "PRE_SHA=$PRE_SHA"`,
    // 2. Stash .env if it exists.
    `if [ -f "${workingDir}/.env" ]; then cp "${workingDir}/.env" ${envBackup} && echo "ENV_STASHED"; fi`,
    // 3. Bare clone.
    `git clone --bare --branch ${args.gitBranch} ${cloneUrl} ${bareDir} 2>&1 | tail -3`,
    `if [ ! -d "${bareDir}" ]; then echo "BARE_CLONE_FAILED"; exit 1; fi`,
    // 4. Remove old working tree.
    `rm -rf "${workingDir}"`,
    // 5. Worktree-add from bare.
    `git --git-dir="${bareDir}" worktree add "${workingDir}" ${args.gitBranch} 2>&1 | tail -3`,
    `if [ ! -d "${workingDir}" ]; then echo "WORKTREE_ADD_FAILED"; exit 1; fi`,
    // 6. Restore .env.
    `if [ -f ${envBackup} ]; then cp ${envBackup} "${workingDir}/.env" && rm ${envBackup} && echo "ENV_RESTORED"; fi`,
    // 7. Verify HEAD matches.
    `cd "${workingDir}"`,
    `POST_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `if [ "$POST_SHA" != "$PRE_SHA" ]; then echo "SHA_MISMATCH pre=$PRE_SHA post=$POST_SHA"; exit 1; fi`,
    // Ownership: the bare repo + worktree must be owned by ubuntu so the
    // daemon (which runs as ubuntu) can write to them. SSM runs as root.
    `chown -R ubuntu:ubuntu "${bareDir}" "${workingDir}"`,
    `echo "CONVERT_OK post=$POST_SHA"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (!output.includes('CONVERT_OK')) {
      return {
        converted: false,
        reason: 'conversion-failed',
        detail: `conversion script aborted: ${output.slice(0, 500)}`,
      };
    }
    const shaMatch = output.match(/post=([a-f0-9]{40})/);
    const headSha = shaMatch?.[1] ?? '';
    return {
      converted: true,
      bareRepoPath: bareDir,
      worktreePath: workingDir,
      headSha,
    };
  } catch (err) {
    return {
      converted: false,
      reason: 'conversion-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
