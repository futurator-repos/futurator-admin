/**
 * admin-self-edit-bootstrap.ts — 2026-05-27 PR B.a.
 *
 * One-time admin action that bootstraps the `futurator-admin` repo itself
 * as a worktree-managed project on EC2, so the Free Agent can have its
 * own `_assist` worktrees against the admin codebase. Mirrors the shape
 * of `brownfield-topology-converter.ts` but for our own repo:
 *
 *   1. Bare-clone https://github.com/<owner>/futurator-admin.git
 *      → /home/ubuntu/repos/futurator-admin.git
 *   2. git worktree add /home/ubuntu/projects/futurator-admin main
 *      (the "operator checkout mirror" — read-only by convention; lets
 *       the operator's Free Agent sessions diff against `main` without
 *       re-cloning).
 *
 * Idempotent: re-running on an already-bootstrapped EC2 returns
 * `{ converted: false, reason: 'already-bare-topology' }` per §7.2.a.
 *
 * PAT scope: contents:read on the futurator-admin repo (minimum). PR B.d
 * extends this to contents:write + pull_requests:write for Rung 1's
 * agent-opens-PRs flow.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

export const ADMIN_PROJECT_ID = 'futurator-admin';
export const ADMIN_SELF_EDIT_PAT_SECRET_NAME =
  process.env.ADMIN_SELF_EDIT_PAT_SECRET_NAME || 'futurator/admin-self-edit-pat';

const DEFAULT_REPO_URL = 'https://github.com/futurator-repos/futurator-admin.git';
const DEFAULT_BRANCH = 'main';

export interface BootstrapDeps {
  sendSsmCommand: (cmd: string) => Promise<string>;
  waitForSsmOutput: (commandId: string) => Promise<string>;
}

export type BootstrapResult =
  | { converted: true; bareRepoPath: string; worktreePath: string; headSha: string }
  | { converted: false; reason: 'already-bare-topology'; bareRepoPath: string; headSha?: string }
  | { converted: false; reason: 'bootstrap-failed'; detail: string };

/**
 * Load the admin self-edit PAT from Secrets Manager. The secret body MUST
 * be a JSON document with a `pat` field (matches the brownfield-pat shape).
 */
export async function loadAdminSelfEditPat(): Promise<string> {
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: ADMIN_SELF_EDIT_PAT_SECRET_NAME }),
  );
  if (!res.SecretString) {
    throw new Error(
      `Secret ${ADMIN_SELF_EDIT_PAT_SECRET_NAME} has no SecretString (must be a JSON object with a 'pat' field)`,
    );
  }
  let parsed: { pat?: string };
  try {
    parsed = JSON.parse(res.SecretString);
  } catch (err) {
    throw new Error(
      `Secret ${ADMIN_SELF_EDIT_PAT_SECRET_NAME} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.pat || typeof parsed.pat !== 'string') {
    throw new Error(`Secret ${ADMIN_SELF_EDIT_PAT_SECRET_NAME} JSON missing required 'pat' field`);
  }
  return parsed.pat;
}

/**
 * Idempotence probe — same shape as `isAlreadyBareTopology` but for the
 * admin repo. Returns `{ alreadyBare: true, headSha }` when both the bare
 * repo AND the worktree-attached operator checkout exist.
 */
export async function isAdminAlreadyBootstrapped(
  deps: BootstrapDeps,
): Promise<{ alreadyBare: boolean; headSha?: string }> {
  const workingDir = `/home/ubuntu/projects/${ADMIN_PROJECT_ID}`;
  const bareDir = `/home/ubuntu/repos/${ADMIN_PROJECT_ID}.git`;
  const cmd = [
    `if [ ! -d "${bareDir}" ]; then echo "BARE_ABSENT"; exit 0; fi`,
    `if [ ! -d "${workingDir}" ]; then echo "TREE_ABSENT"; exit 0; fi`,
    `if [ ! -f "${workingDir}/.git" ]; then echo "NOT_WORKTREE"; exit 0; fi`,
    `GITDIR=$(cat "${workingDir}/.git" | sed -n 's|^gitdir: ||p' | head -1)`,
    `if ! printf '%s' "$GITDIR" | grep -q "${ADMIN_PROJECT_ID}.git"; then echo "WRONG_BARE: $GITDIR"; exit 0; fi`,
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
 * Perform the admin-self-edit bootstrap.
 *
 * Steps (the SSM script):
 *   1. Ensure /home/ubuntu/repos exists (parent dir).
 *   2. git clone --bare --branch main https://x-access-token:<pat>@github.com/.../futurator-admin.git /home/ubuntu/repos/futurator-admin.git
 *   3. mkdir -p /home/ubuntu/projects
 *   4. git --git-dir=<bare> worktree add /home/ubuntu/projects/futurator-admin main
 *   5. chown -R ubuntu:ubuntu <bare> <working>
 *   6. echo "BOOTSTRAP_OK post=<sha>"
 *
 * Rollback: same posture as brownfield-topology-converter — if step 4 or
 * later fails the bare may be present but the worktree might not; the
 * audit row captures detail for manual recovery.
 */
export async function bootstrapAdminSelfEdit(
  args: { pat: string; repoUrl?: string; branch?: string },
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const repoUrl = args.repoUrl ?? DEFAULT_REPO_URL;
  const branch = args.branch ?? DEFAULT_BRANCH;
  const workingDir = `/home/ubuntu/projects/${ADMIN_PROJECT_ID}`;
  const bareDir = `/home/ubuntu/repos/${ADMIN_PROJECT_ID}.git`;

  const cloneUrl = repoUrl.replace(/^https:\/\//, `https://x-access-token:${args.pat}@`);

  const cmd = [
    `set -e`,
    `mkdir -p /home/ubuntu/repos /home/ubuntu/projects`,
    // 1. Bare clone.
    `if [ -d "${bareDir}" ]; then echo "BARE_ALREADY_EXISTS"; else git clone --bare --branch ${branch} ${cloneUrl} ${bareDir} 2>&1 | tail -5; fi`,
    `if [ ! -d "${bareDir}" ]; then echo "BARE_CLONE_FAILED"; exit 1; fi`,
    // 2. Worktree-add the operator checkout mirror.
    `if [ -d "${workingDir}" ]; then echo "TREE_ALREADY_EXISTS"; else git --git-dir="${bareDir}" worktree add "${workingDir}" ${branch} 2>&1 | tail -5; fi`,
    `if [ ! -d "${workingDir}" ]; then echo "WORKTREE_ADD_FAILED"; exit 1; fi`,
    // 3. Ownership for ubuntu daemon user.
    `chown -R ubuntu:ubuntu "${bareDir}" "${workingDir}"`,
    // 4. Verify + emit SHA.
    `cd "${workingDir}"`,
    `POST_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `if [ -z "$POST_SHA" ]; then echo "POST_NO_HEAD"; exit 1; fi`,
    `echo "BOOTSTRAP_OK post=$POST_SHA"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (!output.includes('BOOTSTRAP_OK')) {
      return {
        converted: false,
        reason: 'bootstrap-failed',
        detail: `bootstrap script aborted: ${output.slice(0, 500)}`,
      };
    }
    const shaMatch = output.match(/post=([a-f0-9]{40})/);
    return {
      converted: true,
      bareRepoPath: bareDir,
      worktreePath: workingDir,
      headSha: shaMatch?.[1] ?? '',
    };
  } catch (err) {
    return {
      converted: false,
      reason: 'bootstrap-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
