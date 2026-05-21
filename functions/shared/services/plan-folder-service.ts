import type { Plan } from '../types/plan';
import type { EpicWorkflow } from '../types/epic-workflow';
import { PLAN_NAME_REGEX } from '../schemas/plan-schema';
import { planToMarkdown } from './plan-markdown';

/**
 * SSM-backed helpers for the Plan's filesystem presence.
 *
 * Paths are always re-validated against `PLAN_NAME_REGEX` before going into a
 * shell command so this module can never become an arbitrary `rm -rf` gun
 * even if a caller passes a malicious-looking plan name.
 */

export interface PlanFolderDeps {
  /** Sends an SSM command to EC2; returns the commandId. */
  sendSsmCommand: (cmd: string) => Promise<string>;
  /** Polls for command completion + returns stdout. */
  waitForSsmOutput: (commandId: string, timeoutMs?: number) => Promise<string>;
}

function assertSafeName(name: string): void {
  if (!PLAN_NAME_REGEX.test(name)) {
    throw new Error(`Refused: plan name "${name}" does not match safe pattern`);
  }
}

/**
 * Create `/home/ubuntu/projects/<name>/` on EC2 and write the initial
 * `plan.md` to it. Called immediately after `POST /api/plans` DDB write.
 */
export async function bootstrapPlanFolder(
  plan: Plan,
  epics: EpicWorkflow[],
  deps: PlanFolderDeps,
): Promise<void> {
  assertSafeName(plan.name);
  const md = planToMarkdown(plan, epics);
  // Use a heredoc so shell metacharacters in the plan content don't break.
  const cmd = [
    `mkdir -p /home/ubuntu/projects/${plan.name}`,
    `cat > /home/ubuntu/projects/${plan.name}/plan.md <<'__PLAN_MD_EOF__'`,
    md,
    '__PLAN_MD_EOF__',
    // SSM runs as root; the daemon runs as `ubuntu`. Hand ownership over so
    // downstream pipelines (e.g. party-bootstrap's mkdir of docs/) don't EACCES.
    `chown -R ubuntu:ubuntu /home/ubuntu/projects/${plan.name}`,
    `echo "BOOTSTRAPPED /home/ubuntu/projects/${plan.name}"`,
  ].join('\n');

  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (!output.includes(`BOOTSTRAPPED /home/ubuntu/projects/${plan.name}`)) {
    throw new Error(`Plan folder bootstrap failed: ${output.slice(0, 300)}`);
  }
}

/**
 * Rewrite `plan.md` in place. Called after PATCH /api/plans/:id to keep the
 * file in sync with DDB edits.
 */
export async function writePlanMarkdown(
  plan: Plan,
  epics: EpicWorkflow[],
  deps: PlanFolderDeps,
): Promise<void> {
  assertSafeName(plan.name);
  const md = planToMarkdown(plan, epics);
  const cmd = [
    `test -d /home/ubuntu/projects/${plan.name} || { echo "MISSING_FOLDER"; exit 1; }`,
    `cat > /home/ubuntu/projects/${plan.name}/plan.md <<'__PLAN_MD_EOF__'`,
    md,
    '__PLAN_MD_EOF__',
    `echo "WROTE plan.md"`,
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (!output.includes('WROTE plan.md')) {
    throw new Error(`plan.md write failed: ${output.slice(0, 300)}`);
  }
}

/**
 * Read `plan.md` back from EC2. Used when hydrating a plan from disk after
 * out-of-band edits (operator edits the file directly via SSH).
 */
export async function readPlanMarkdown(planName: string, deps: PlanFolderDeps): Promise<string> {
  assertSafeName(planName);
  const cmd = `cat /home/ubuntu/projects/${planName}/plan.md 2>&1`;
  const commandId = await deps.sendSsmCommand(cmd);
  return deps.waitForSsmOutput(commandId);
}

/**
 * Soft-delete: move the project folder to `.trash/plans/<name>-<iso>/`.
 * Reversible via `restorePlanFolder` within 14 days.
 */
export async function movePlanFolderToTrash(
  plan: Plan,
  timestamp: string,
  deps: PlanFolderDeps,
): Promise<string> {
  assertSafeName(plan.name);
  // Use a safe iso string (replace colons with dashes for filesystem sanity).
  const safeTs = timestamp.replace(/[:.]/g, '-');
  const archivePath = `/home/ubuntu/.trash/plans/${plan.name}-${safeTs}`;
  const cmd = [
    `mkdir -p /home/ubuntu/.trash/plans`,
    `if [ -d "/home/ubuntu/projects/${plan.name}" ]; then`,
    `  mv "/home/ubuntu/projects/${plan.name}" "${archivePath}" && echo "ARCHIVED ${archivePath}"`,
    `else`,
    `  echo "NO_FOLDER (already archived or never created)"`,
    `fi`,
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (!output.includes('ARCHIVED') && !output.includes('NO_FOLDER')) {
    throw new Error(`Archive failed: ${output.slice(0, 300)}`);
  }
  return archivePath;
}

/**
 * Restore a previously archived folder.
 */
export async function restorePlanFolder(plan: Plan, deps: PlanFolderDeps): Promise<void> {
  assertSafeName(plan.name);
  if (!plan.archivePath) {
    throw new Error('Plan has no archivePath to restore from');
  }
  // Validate archivePath is inside .trash
  if (!plan.archivePath.startsWith('/home/ubuntu/.trash/plans/')) {
    throw new Error(`Refused: archivePath "${plan.archivePath}" is not in .trash/plans/`);
  }
  const cmd = [
    `if [ -d "${plan.archivePath}" ]; then`,
    `  mv "${plan.archivePath}" "/home/ubuntu/projects/${plan.name}" && echo "RESTORED"`,
    `else`,
    `  echo "NO_ARCHIVE_FOLDER"; exit 1`,
    `fi`,
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (!output.includes('RESTORED')) {
    throw new Error(`Restore failed: ${output.slice(0, 300)}`);
  }
}

/**
 * Hard-delete the folder (used by the cascade delete in Story 17.7).
 *
 * Handles both `projects/<name>` and `.trash/plans/<name>-<ts>` — whichever
 * one currently exists, it's removed.
 */
export async function deletePlanFolder(plan: Plan, deps: PlanFolderDeps): Promise<void> {
  assertSafeName(plan.name);
  const cmd = [
    `rm -rf "/home/ubuntu/projects/${plan.name}" 2>/dev/null || true`,
    plan.archivePath && plan.archivePath.startsWith('/home/ubuntu/.trash/plans/')
      ? `rm -rf "${plan.archivePath}" 2>/dev/null || true`
      : '',
    `echo "DELETED"`,
  ]
    .filter(Boolean)
    .join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (!output.includes('DELETED')) {
    throw new Error(`Delete failed: ${output.slice(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2026-05-19 — plan-branch + worktree cleanup for App/Plan v1.
//
// Pre-fix legacy plans committed straight to `main` on the shared
// `/home/ubuntu/projects/<appId>/` worktree. Post-fix (snake-4 followup)
// every story commit lands on `plan/<plan.name>` so a plan delete can
// surgically drop just that branch instead of risking the App's history.
//
// `cleanupPlanBranch` is the post-fix flow: runs in the App's worktree,
// fetches origin, deletes the local + remote `plan/<slug>` branch, returns
// the worktree to `main`. Designed for the App/Plan v1 case where the
// folder itself is preserved (other plans + the App live there).
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate a folder name (used for the App-level workingDir, which doesn't
 * follow PLAN_NAME_REGEX but is still a daemon-managed kebab-case slug).
 */
function assertSafeFolderName(name: string): void {
  // Same character class as App slugs (kebab-case, 3-40 chars).
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) {
    throw new Error(`Refused: folder name "${name}" does not match safe pattern`);
  }
}

/** Cleanup result for one step of a delete cascade. */
export interface CleanupStep {
  step: string;
  status: 'done' | 'skipped' | 'error';
  detail?: string;
}

/**
 * Delete the per-plan branch (local + remote) inside the App's worktree.
 * Best-effort: a missing branch, network blip, or push rejection logs but
 * does NOT throw — the cascade should keep going regardless.
 *
 * Steps inside the SSM script:
 *   1. `sudo -u ubuntu git fetch origin --prune` — refresh remote-tracking.
 *   2. `sudo -u ubuntu git push origin --delete plan/<slug>` — remove from GH.
 *   3. `sudo -u ubuntu git branch -D plan/<slug>` — remove locally.
 *   4. `sudo -u ubuntu git checkout main` — leave the worktree on main.
 *
 * SSM runs as root; daemon-owned `.git` dirs reject root operations because
 * of git's safe.directory protection — hence the `sudo -u ubuntu` prefix
 * everywhere (matches the manual cleanup pattern verified 2026-05-19).
 */
export async function cleanupPlanBranch(
  args: {
    /** The App's worktree slug — usually `app.appId` and the folder name. */
    workingDirSlug: string;
    /** Plan slug used to derive the branch name. */
    planName: string;
  },
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeName(args.planName);
  const dir = `/home/ubuntu/projects/${args.workingDirSlug}`;
  const branch = `plan/${args.planName}`;

  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `sudo -u ubuntu git fetch origin --prune 2>&1 | head -10 || true`,
    `if sudo -u ubuntu git ls-remote --exit-code --heads origin "${branch}" >/dev/null 2>&1; then`,
    `  sudo -u ubuntu git push origin --delete "${branch}" 2>&1 | head -10 || echo "REMOTE_DELETE_WARN: ${branch} push --delete failed"`,
    `else`,
    `  echo "REMOTE_BRANCH_ABSENT: ${branch}"`,
    `fi`,
    `if sudo -u ubuntu git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then`,
    `  sudo -u ubuntu git checkout main 2>&1 | head -3 || true`,
    `  sudo -u ubuntu git branch -D "${branch}" 2>&1 | head -3 || echo "LOCAL_DELETE_WARN: ${branch}"`,
    `else`,
    `  echo "LOCAL_BRANCH_ABSENT: ${branch}"`,
    `fi`,
    `echo "CLEANUP_PLAN_BRANCH_DONE"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('FOLDER_MISSING')) {
      return { step: 'plan-branch', status: 'skipped', detail: 'worktree folder absent' };
    }
    if (!output.includes('CLEANUP_PLAN_BRANCH_DONE')) {
      return {
        step: 'plan-branch',
        status: 'error',
        detail: `script did not reach completion marker: ${output.slice(0, 300)}`,
      };
    }
    // Surface useful diagnostic snippets in the detail so the operator can
    // see whether the remote or local branch was the one removed.
    const flags: string[] = [];
    if (output.includes('REMOTE_BRANCH_ABSENT')) flags.push('remote=absent');
    else if (output.includes('REMOTE_DELETE_WARN')) flags.push('remote=warn');
    else flags.push('remote=deleted');
    if (output.includes('LOCAL_BRANCH_ABSENT')) flags.push('local=absent');
    else if (output.includes('LOCAL_DELETE_WARN')) flags.push('local=warn');
    else flags.push('local=deleted');
    return { step: 'plan-branch', status: 'done', detail: flags.join(' ') };
  } catch (err) {
    return {
      step: 'plan-branch',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 2026-05-21 — Phase 1 worktree rollout followup. Reap every per-story
 * wip worktree + branch that belongs to a plan. Called from the
 * plan-delete cascade so a deleted plan leaves NO residue under
 * /home/ubuntu/worktrees/<app>/<planSlug>/ and NO orphan wip/<storyId>
 * branches in the bare repo or on GitHub.
 *
 * The hourly reaper would eventually catch these (terminal-job + 24h
 * stale rule), but operator-driven plan-delete should not wait — the
 * next plan-create's worktree-clean guard fails until those stories'
 * wip branches stop colliding with state.
 *
 * Best-effort: each per-story teardown is independent; one failure
 * doesn't block siblings. Returns a single CleanupStep with a count.
 */
export async function reapPlanStoryWorktrees(
  args: {
    workingDirSlug: string;
    planName: string;
  },
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeName(args.planName);
  const planWorktreeRoot = `/home/ubuntu/worktrees/${args.workingDirSlug}/${args.planName}`;
  const bareRepo = `/home/ubuntu/repos/${args.workingDirSlug}.git`;

  const cmd = [
    // Bail early if neither the worktree root nor the bare repo exists —
    // nothing to reap.
    `if [ ! -d "${planWorktreeRoot}" ] && [ ! -d "${bareRepo}" ]; then echo "REAP_NOTHING"; exit 0; fi`,
    // Enumerate the story dirs (each is a per-story worktree). _merge is
    // skipped here — the coordinator worktree is handled separately by
    // the App-delete cascade or the hourly reaper.
    `STORY_DIRS=$(ls -d "${planWorktreeRoot}"/*/ 2>/dev/null | grep -v "/_merge/$" || true)`,
    `WIP_BRANCHES=$(sudo -u ubuntu git --git-dir="${bareRepo}" branch 2>/dev/null | tr -d " *" | grep "^wip/" || true)`,
    // Per-story worktree removal.
    `REAPED=0; FAILED=0`,
    `for dir in $STORY_DIRS; do`,
    `  storyId=$(basename "$dir")`,
    `  sudo -u ubuntu git --git-dir="${bareRepo}" worktree remove --force "$dir" 2>/dev/null || true`,
    `  if [ -d "$dir" ]; then sudo rm -rf "$dir" || true; fi`,
    `  if [ -d "$dir" ]; then FAILED=$((FAILED+1)); else REAPED=$((REAPED+1)); fi`,
    `done`,
    // Wave-merge coordinator worktree (if it still exists).
    `if [ -d "${planWorktreeRoot}/_merge" ]; then`,
    `  sudo -u ubuntu git --git-dir="${bareRepo}" worktree remove --force "${planWorktreeRoot}/_merge" 2>/dev/null || true`,
    `  sudo rm -rf "${planWorktreeRoot}/_merge" || true`,
    `fi`,
    // Empty plan-root directory.
    `if [ -d "${planWorktreeRoot}" ]; then sudo rmdir "${planWorktreeRoot}" 2>/dev/null || true; fi`,
    // Local wip/<storyId> branch deletion. Loop over every wip branch in
    // the bare repo (cheap; usually < 20). We DON'T limit to this plan's
    // stories because a plan's storyIds aren't easily known from the
    // shell — but `git worktree remove` already disowned the ref, and
    // the branch HAS to be unused (no checked-out worktree) for `-D` to
    // succeed without a force flag.
    `BRANCH_REAPED=0; BRANCH_REMOTE_REAPED=0`,
    `for branch in $WIP_BRANCHES; do`,
    // Skip branches still referenced by a worktree (those belong to other plans).
    `  if sudo -u ubuntu git --git-dir="${bareRepo}" worktree list 2>/dev/null | awk \"{print \\$3}\" | tr -d \"[]\" | grep -qx \"$branch\"; then continue; fi`,
    `  sudo -u ubuntu git --git-dir="${bareRepo}" branch -D "$branch" >/dev/null 2>&1 && BRANCH_REAPED=$((BRANCH_REAPED+1)) || true`,
    `  sudo -u ubuntu git --git-dir="${bareRepo}" push origin --delete "$branch" >/dev/null 2>&1 && BRANCH_REMOTE_REAPED=$((BRANCH_REMOTE_REAPED+1)) || true`,
    `done`,
    `echo "REAP_DONE worktrees=$REAPED failed=$FAILED local_branches=$BRANCH_REAPED remote_branches=$BRANCH_REMOTE_REAPED"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('REAP_NOTHING')) {
      return {
        step: 'plan-story-worktrees',
        status: 'skipped',
        detail: 'no worktrees or bare repo',
      };
    }
    const m = output.match(
      /REAP_DONE worktrees=(\d+) failed=(\d+) local_branches=(\d+) remote_branches=(\d+)/,
    );
    if (!m) {
      return {
        step: 'plan-story-worktrees',
        status: 'error',
        detail: `script did not reach completion marker: ${output.slice(0, 300)}`,
      };
    }
    const [, reaped, failed, localBr, remoteBr] = m;
    return {
      step: 'plan-story-worktrees',
      status: failed === '0' ? 'done' : 'error',
      detail: `worktrees=${reaped} failed=${failed} local-wip=${localBr} remote-wip=${remoteBr}`,
    };
  } catch (err) {
    return {
      step: 'plan-story-worktrees',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 2026-05-21 — Phase 1 worktree rollout followup. Reset the App's
 * legacy shared worktree (`/home/ubuntu/projects/<app>/`) to clean main.
 *
 * Background: even though per-story DEV writes happen in
 * /home/ubuntu/worktrees/<app>/<plan>/<story>/, the legacy worktree
 * accumulates uncommitted drift across plans (knowledge sidecars,
 * `.mycelium/*`, transient build artifacts). The Phase 0 worktree-clean
 * guard refuses plan-create until that drift is cleaned. Without this
 * step in plan-delete, the operator has to SSH and clean by hand
 * (which is what the snake-4 user just hit).
 *
 * Mechanics: force-checkout main, hard-reset to origin/main, clean
 * untracked except node_modules + .next (avoiding a 90-second
 * reinstall on next plan).
 *
 * Best-effort: a failure here logs but does not block the rest of the
 * cascade. Returns the dirty-file count BEFORE/AFTER for visibility.
 */
export async function resetAppWorktreeToMain(
  workingDirSlug: string,
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(workingDirSlug);
  const dir = `/home/ubuntu/projects/${workingDirSlug}`;
  const cmd = [
    `if [ ! -d "${dir}/.git" ] && [ ! -f "${dir}/.git" ]; then echo "RESET_SKIPPED_NOT_A_REPO"; exit 0; fi`,
    `cd "${dir}" 2>/dev/null || { echo "RESET_SKIPPED_FOLDER_MISSING"; exit 0; }`,
    `BEFORE=$(sudo -u ubuntu git status --porcelain 2>/dev/null | wc -l | tr -d " ")`,
    `sudo -u ubuntu git fetch origin --quiet 2>/dev/null || true`,
    `sudo -u ubuntu git checkout -f main >/dev/null 2>&1 || true`,
    `sudo -u ubuntu git reset --hard origin/main >/dev/null 2>&1 || true`,
    `sudo -u ubuntu git clean -fdx -e node_modules -e .next >/dev/null 2>&1 || true`,
    `AFTER=$(sudo -u ubuntu git status --porcelain 2>/dev/null | wc -l | tr -d " ")`,
    `HEAD_BRANCH=$(sudo -u ubuntu git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)`,
    `echo "RESET_DONE before=$BEFORE after=$AFTER head=$HEAD_BRANCH"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('RESET_SKIPPED_NOT_A_REPO')) {
      return { step: 'app-worktree-reset', status: 'skipped', detail: 'not a git repo' };
    }
    if (output.includes('RESET_SKIPPED_FOLDER_MISSING')) {
      return { step: 'app-worktree-reset', status: 'skipped', detail: 'folder missing' };
    }
    const m = output.match(/RESET_DONE before=(\d+) after=(\d+) head=(\S+)/);
    if (!m) {
      return {
        step: 'app-worktree-reset',
        status: 'error',
        detail: `unexpected output: ${output.slice(0, 200)}`,
      };
    }
    const [, before, after, head] = m;
    return {
      step: 'app-worktree-reset',
      status: head === 'main' && after === '0' ? 'done' : 'error',
      detail: `dirty ${before}→${after} on ${head}`,
    };
  } catch (err) {
    return {
      step: 'app-worktree-reset',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 2026-05-19 — count commits remaining on `main` that carry this plan's
 * `Plan-Id:` trailer (v2.5 §23). After the per-plan branch is deleted,
 * any commit still on main with the trailer is "residual" — either:
 *   - The plan was force-merged into main by an operator, or
 *   - The commit landed direct-on-main from a pre-fix legacy plan, or
 *   - A previous wave's commits were merged before the rest of the plan
 *     failed.
 *
 * Non-destructive: this function only reports. Operator decides whether
 * to revert. Pre-fix plans (no Plan-Id trailer anywhere) → returns 0
 * because the trailer didn't exist when the commits were made; they're
 * legitimately indistinguishable from the App's baseline history.
 */
export async function countResidualPlanCommits(
  args: {
    workingDirSlug: string;
    planId: string;
  },
  deps: PlanFolderDeps,
): Promise<{ count: number; sample: string[] }> {
  assertSafeFolderName(args.workingDirSlug);
  // planId is opaque (uuid-shaped or `plan_<app>_<base36>`); reject any
  // shell-meta characters so it can't break out of the grep pattern.
  if (!/^[A-Za-z0-9_-]+$/.test(args.planId)) {
    throw new Error(`Refused: planId "${args.planId}" contains shell-meta`);
  }
  const dir = `/home/ubuntu/projects/${args.workingDirSlug}`;
  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `if ! sudo -u ubuntu git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "NOT_A_REPO"; exit 0; fi`,
    `sudo -u ubuntu git fetch origin --quiet 2>/dev/null || true`,
    `MAIN_REF=$(sudo -u ubuntu git rev-parse --verify origin/main 2>/dev/null || sudo -u ubuntu git rev-parse --verify main 2>/dev/null || echo HEAD)`,
    `echo "RESIDUAL_COUNT_BEGIN"`,
    // `--all-match` is unnecessary; one grep is enough. The trailer line is
    // unambiguous since planIds are uuid/base36-shaped.
    `sudo -u ubuntu git log "$MAIN_REF" --grep="Plan-Id: ${args.planId}" --format=%H 2>/dev/null | head -50 || true`,
    `echo "RESIDUAL_COUNT_END"`,
  ].join('\n');

  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (output.includes('FOLDER_MISSING') || output.includes('NOT_A_REPO')) {
    return { count: 0, sample: [] };
  }
  const match = output.match(/RESIDUAL_COUNT_BEGIN\n([\s\S]*?)\n?RESIDUAL_COUNT_END/);
  const shas = (match?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{40}$/.test(l));
  return { count: shas.length, sample: shas.slice(0, 5) };
}

// ── Story 20.9 (party-push Epic 20) — party-* cascade helpers ─────────────
//
// Parallel set to the plan-* helpers above. Consumed by:
//   - DELETE /api/party/sessions/:id        (Story 20.10)
//   - App-delete cascade party-cleanup step (Story 20.11)
//   - Worktree-reaper real classifier       (Story 20.15)
//
// Branch namespace per plan.md §10.2:
//   party/<workingDirSlug>/<sessionIdShort>
//   archive/party/<workingDirSlug>/<sessionIdShort>   (soft-delete target)
//
// Worktree path per plan.md §10.1:
//   /home/ubuntu/worktrees/<workingDirSlug>/_party/<sessionIdShort>/
//
// `<sessionIdShort>` is the first 8 chars of the session UUID (lowercase hex).
// `<workingDirSlug>` is the App slug (= `appId` for greenfield, = the
// brownfield project slug for brownfield apps).

const SESSION_ID_SHORT_REGEX_SVC = /^[a-f0-9]{8}$/;

function assertSafeSessionIdShort(sid: string): void {
  if (!SESSION_ID_SHORT_REGEX_SVC.test(sid)) {
    throw new Error(`Refused: sessionIdShort "${sid}" must be 8 lowercase hex chars`);
  }
}

const SESSION_UUID_REGEX_SVC = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function assertSafeSessionUuid(sid: string): void {
  if (!SESSION_UUID_REGEX_SVC.test(sid)) {
    throw new Error(`Refused: sessionId "${sid}" must be a lowercase UUID`);
  }
}

/**
 * Story 20.9 — drop the local + remote party branch.
 *
 * Mirrors `cleanupPlanBranch`'s posture: best-effort, idempotent, runs as
 * `sudo -u ubuntu` so git's safe.directory protection on daemon-owned
 * `.git` directories doesn't reject the operation.
 *
 * Use {@link archivePartyBranch} when you want soft-delete semantics
 * (push to `archive/party/...` BEFORE dropping the live branch). This
 * helper is the hard-delete variant — appropriate when the operator has
 * already explicitly opted out of the archive.
 */
export async function cleanupPartyBranch(
  args: { workingDirSlug: string; sessionIdShort: string },
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeSessionIdShort(args.sessionIdShort);
  const dir = `/home/ubuntu/projects/${args.workingDirSlug}`;
  const branch = `party/${args.workingDirSlug}/${args.sessionIdShort}`;

  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `sudo -u ubuntu git fetch origin --prune 2>&1 | head -10 || true`,
    `if sudo -u ubuntu git ls-remote --exit-code --heads origin "${branch}" >/dev/null 2>&1; then`,
    `  sudo -u ubuntu git push origin --delete "${branch}" 2>&1 | head -10 || echo "REMOTE_DELETE_WARN: ${branch}"`,
    `else`,
    `  echo "REMOTE_BRANCH_ABSENT: ${branch}"`,
    `fi`,
    `if sudo -u ubuntu git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then`,
    `  sudo -u ubuntu git branch -D "${branch}" 2>&1 | head -3 || echo "LOCAL_DELETE_WARN: ${branch}"`,
    `else`,
    `  echo "LOCAL_BRANCH_ABSENT: ${branch}"`,
    `fi`,
    `echo "CLEANUP_PARTY_BRANCH_DONE"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('FOLDER_MISSING')) {
      return { step: 'party-branch', status: 'skipped', detail: 'worktree folder absent' };
    }
    if (!output.includes('CLEANUP_PARTY_BRANCH_DONE')) {
      return {
        step: 'party-branch',
        status: 'error',
        detail: `script did not reach completion marker: ${output.slice(0, 300)}`,
      };
    }
    const flags: string[] = [];
    if (output.includes('REMOTE_BRANCH_ABSENT')) flags.push('remote=absent');
    else if (output.includes('REMOTE_DELETE_WARN')) flags.push('remote=warn');
    else flags.push('remote=deleted');
    if (output.includes('LOCAL_BRANCH_ABSENT')) flags.push('local=absent');
    else if (output.includes('LOCAL_DELETE_WARN')) flags.push('local=warn');
    else flags.push('local=deleted');
    const allAbsent =
      output.includes('REMOTE_BRANCH_ABSENT') && output.includes('LOCAL_BRANCH_ABSENT');
    if (allAbsent) {
      return { step: 'party-branch', status: 'skipped', detail: 'nothing-to-do' };
    }
    return { step: 'party-branch', status: 'done', detail: flags.join(' ') };
  } catch (err) {
    return {
      step: 'party-branch',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Story 20.9 — soft-delete a party branch.
 *
 * Per plan.md §2.4 + Free Explorer §9.4: push to `archive/party/...`
 * FIRST, then drop the live branch. If the archive push fails (network
 * blip, ref-update conflict), the live branch is preserved so the
 * operator can retry — better than silently losing the debate history.
 */
export async function archivePartyBranch(
  args: { workingDirSlug: string; sessionIdShort: string },
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeSessionIdShort(args.sessionIdShort);
  const dir = `/home/ubuntu/projects/${args.workingDirSlug}`;
  const branch = `party/${args.workingDirSlug}/${args.sessionIdShort}`;
  const archive = `archive/party/${args.workingDirSlug}/${args.sessionIdShort}`;

  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `sudo -u ubuntu git fetch origin --prune 2>&1 | head -10 || true`,
    // Check the branch exists locally OR on the remote. If neither: nothing to archive.
    `HAS_REMOTE=0; HAS_LOCAL=0`,
    `if sudo -u ubuntu git ls-remote --exit-code --heads origin "${branch}" >/dev/null 2>&1; then HAS_REMOTE=1; fi`,
    `if sudo -u ubuntu git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then HAS_LOCAL=1; fi`,
    `if [ "$HAS_REMOTE" = "0" ] && [ "$HAS_LOCAL" = "0" ]; then echo "ARCHIVE_NOTHING_TO_DO"; echo "ARCHIVE_PARTY_BRANCH_DONE"; exit 0; fi`,
    // Push live branch to archive ref. Use the local ref if present, else the remote.
    `if [ "$HAS_LOCAL" = "1" ]; then`,
    `  if sudo -u ubuntu git push origin "${branch}:refs/heads/${archive}" 2>&1 | head -10; then echo "ARCHIVE_PUSH_OK"; else echo "ARCHIVE_PUSH_FAIL"; echo "ARCHIVE_PARTY_BRANCH_DONE"; exit 0; fi`,
    `else`,
    `  if sudo -u ubuntu git push origin "refs/remotes/origin/${branch}:refs/heads/${archive}" 2>&1 | head -10; then echo "ARCHIVE_PUSH_OK"; else echo "ARCHIVE_PUSH_FAIL"; echo "ARCHIVE_PARTY_BRANCH_DONE"; exit 0; fi`,
    `fi`,
    // Archive succeeded — safe to drop the live branch.
    `if [ "$HAS_REMOTE" = "1" ]; then sudo -u ubuntu git push origin --delete "${branch}" 2>&1 | head -10 || echo "REMOTE_DELETE_WARN: ${branch}"; fi`,
    `if [ "$HAS_LOCAL" = "1" ]; then sudo -u ubuntu git branch -D "${branch}" 2>&1 | head -3 || echo "LOCAL_DELETE_WARN: ${branch}"; fi`,
    `echo "ARCHIVE_PARTY_BRANCH_DONE"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('FOLDER_MISSING')) {
      return { step: 'party-archive', status: 'skipped', detail: 'worktree folder absent' };
    }
    if (output.includes('ARCHIVE_NOTHING_TO_DO')) {
      return { step: 'party-archive', status: 'skipped', detail: 'nothing-to-do' };
    }
    if (output.includes('ARCHIVE_PUSH_FAIL')) {
      return {
        step: 'party-archive',
        status: 'error',
        detail: 'archive-failed; live branch preserved',
      };
    }
    if (!output.includes('ARCHIVE_PARTY_BRANCH_DONE')) {
      return {
        step: 'party-archive',
        status: 'error',
        detail: `script did not reach completion marker: ${output.slice(0, 300)}`,
      };
    }
    return {
      step: 'party-archive',
      status: 'done',
      detail: `archived to ${archive}; live branch dropped`,
    };
  } catch (err) {
    return {
      step: 'party-archive',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Story 20.9 — reap a per-session party worktree.
 *
 * `git worktree remove --force` against the bare repo (so the bare repo's
 * worktree-list stays consistent) followed by `rm -rf` against the
 * filesystem path (in case `git worktree remove` left orphan files).
 * Idempotent — missing path returns `{ status: 'skipped' }`.
 */
export async function reapPartyWorktree(
  args: { workingDirSlug: string; sessionIdShort: string },
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeSessionIdShort(args.sessionIdShort);
  const worktreePath = `/home/ubuntu/worktrees/${args.workingDirSlug}/_party/${args.sessionIdShort}`;
  // The bare repo lives at /home/ubuntu/repos/<workingDirSlug>.git per
  // Phase 1 worktree rollout. `git worktree remove` needs --git-dir
  // pointed at it.
  const bareDir = `/home/ubuntu/repos/${args.workingDirSlug}.git`;

  const cmd = [
    `if [ ! -d "${worktreePath}" ]; then echo "WORKTREE_ABSENT"; echo "REAP_PARTY_WORKTREE_DONE"; exit 0; fi`,
    `if [ -d "${bareDir}" ]; then`,
    `  sudo -u ubuntu git --git-dir="${bareDir}" worktree remove --force "${worktreePath}" 2>&1 | head -10 || echo "WORKTREE_REMOVE_WARN"`,
    `else`,
    `  echo "BARE_REPO_ABSENT: ${bareDir}"`,
    `fi`,
    `if [ -d "${worktreePath}" ]; then rm -rf "${worktreePath}" 2>&1 | head -3 || echo "RMRF_WARN: ${worktreePath}"; fi`,
    `echo "REAP_PARTY_WORKTREE_DONE"`,
  ].join('\n');

  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('WORKTREE_ABSENT')) {
      return { step: 'party-worktree', status: 'skipped', detail: 'nothing-to-do' };
    }
    if (!output.includes('REAP_PARTY_WORKTREE_DONE')) {
      return {
        step: 'party-worktree',
        status: 'error',
        detail: `script did not reach completion marker: ${output.slice(0, 300)}`,
      };
    }
    const flags: string[] = [];
    if (output.includes('WORKTREE_REMOVE_WARN')) flags.push('git-worktree-remove=warn');
    if (output.includes('BARE_REPO_ABSENT')) flags.push('bare-repo=absent');
    if (output.includes('RMRF_WARN')) flags.push('rm-rf=warn');
    return {
      step: 'party-worktree',
      status: 'done',
      detail: flags.length > 0 ? flags.join(' ') : 'removed',
    };
  } catch (err) {
    return {
      step: 'party-worktree',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Story 20.9 — count residual party commits on main attributed to this
 * session via the `Session-Id:` trailer. Mirrors {@link countResidualPlanCommits}.
 *
 * Searches for the FULL session UUID (not the 8-char short form) because
 * the commit-message trailer carries the full UUID per
 * `agent-commit-composer.composeAgentCommit({ kind: 'party', sessionId })`.
 *
 * @returns `{ count, sample }` — count is total hits (capped at the `head
 *          -50` cap inside the script), sample is the first 5 SHAs for
 *          operator inspection in the UI.
 */
export async function countResidualPartyCommits(
  args: { workingDirSlug: string; sessionId: string },
  deps: PlanFolderDeps,
): Promise<{ count: number; sample: string[] }> {
  assertSafeFolderName(args.workingDirSlug);
  assertSafeSessionUuid(args.sessionId);
  const dir = `/home/ubuntu/projects/${args.workingDirSlug}`;
  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `if ! sudo -u ubuntu git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "NOT_A_REPO"; exit 0; fi`,
    `sudo -u ubuntu git fetch origin --quiet 2>/dev/null || true`,
    `MAIN_REF=$(sudo -u ubuntu git rev-parse --verify origin/main 2>/dev/null || sudo -u ubuntu git rev-parse --verify main 2>/dev/null || echo HEAD)`,
    `echo "RESIDUAL_PARTY_BEGIN"`,
    `sudo -u ubuntu git log "$MAIN_REF" --grep="Session-Id: ${args.sessionId}" --format=%H 2>/dev/null | head -50 || true`,
    `echo "RESIDUAL_PARTY_END"`,
  ].join('\n');

  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (output.includes('FOLDER_MISSING') || output.includes('NOT_A_REPO')) {
    return { count: 0, sample: [] };
  }
  const match = output.match(/RESIDUAL_PARTY_BEGIN\n([\s\S]*?)\n?RESIDUAL_PARTY_END/);
  const shas = (match?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{40}$/.test(l));
  return { count: shas.length, sample: shas.slice(0, 5) };
}

/**
 * 2026-05-19 — worktree cleanliness probe for plan-create.
 *
 * Plan-create on top of a polluted worktree (un-committed changes from a
 * failed earlier plan, lingering branches, detached HEAD, ...) leads to the
 * exact failure class snake-4 plan_2 hit. Before launching a fresh plan,
 * the API verifies the App's worktree is on `main`, clean (no `git status
 * --porcelain` output), and synced with `origin/main`.
 *
 * Returns a structured result so the API can refuse with a meaningful
 * 409 + the operator can manually clean (or force) per case.
 */
export type WorktreeCleanlinessResult =
  | { clean: true; headBranch: 'main'; commitSha: string }
  | {
      clean: false;
      reason:
        | 'folder-missing'
        | 'not-a-repo'
        | 'wrong-branch'
        | 'dirty'
        | 'ahead-or-behind'
        | 'plan-branches-linger';
      detail: string;
      headBranch?: string;
      planBranches?: string[];
      dirtyFiles?: string[];
    };

export async function assertWorktreeClean(
  workingDirSlug: string,
  deps: PlanFolderDeps,
): Promise<WorktreeCleanlinessResult> {
  assertSafeFolderName(workingDirSlug);
  const dir = `/home/ubuntu/projects/${workingDirSlug}`;
  const cmd = [
    `cd "${dir}" 2>/dev/null || { echo "FOLDER_MISSING"; exit 0; }`,
    `if ! sudo -u ubuntu git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "NOT_A_REPO"; exit 0; fi`,
    `echo "HEAD_BRANCH:$(sudo -u ubuntu git symbolic-ref --short HEAD 2>/dev/null || echo DETACHED)"`,
    `echo "HEAD_SHA:$(sudo -u ubuntu git rev-parse HEAD 2>/dev/null || echo NONE)"`,
    `sudo -u ubuntu git fetch origin --quiet 2>/dev/null || true`,
    `echo "ORIGIN_MAIN_SHA:$(sudo -u ubuntu git rev-parse origin/main 2>/dev/null || echo NONE)"`,
    `echo "STATUS_PORCELAIN_BEGIN"`,
    `sudo -u ubuntu git status --porcelain 2>/dev/null | head -50`,
    `echo "STATUS_PORCELAIN_END"`,
    `echo "PLAN_BRANCHES_BEGIN"`,
    `sudo -u ubuntu git branch 2>/dev/null | grep -E 'plan/' | tr -d ' *' | head -20 || true`,
    `echo "PLAN_BRANCHES_END"`,
    `echo "CLEANLINESS_DONE"`,
  ].join('\n');

  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);

  if (output.includes('FOLDER_MISSING')) {
    return { clean: false, reason: 'folder-missing', detail: dir };
  }
  if (output.includes('NOT_A_REPO')) {
    return { clean: false, reason: 'not-a-repo', detail: dir };
  }

  const headBranch = output.match(/HEAD_BRANCH:(\S+)/)?.[1] ?? 'unknown';
  const headSha = output.match(/HEAD_SHA:(\S+)/)?.[1] ?? '';
  const originSha = output.match(/ORIGIN_MAIN_SHA:(\S+)/)?.[1] ?? '';

  // Use regex over the BEGIN/END sentinels so an EMPTY section (e.g. clean
  // working tree, no plan branches) parses to '' instead of swallowing the
  // next sentinel line. The split-based variant had a bug where
  // `BEGIN\nEND` produced "END" as the captured body.
  //
  // The boundaries are `\n` only — NOT `\s*` — because `git status
  // --porcelain` lines have a significant leading space (col 1 is staged
  // state, col 2 is working-tree state). `\s*` would eat the ` ` in
  // ` M src/foo.ts` and silently corrupt the output.
  const statusMatch = output.match(/STATUS_PORCELAIN_BEGIN\n([\s\S]*?)\n?STATUS_PORCELAIN_END/);
  const dirtyFiles = (statusMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);

  const branchMatch = output.match(/PLAN_BRANCHES_BEGIN\n([\s\S]*?)\n?PLAN_BRANCHES_END/);
  const planBranches = (branchMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);

  if (headBranch !== 'main') {
    return {
      clean: false,
      reason: 'wrong-branch',
      detail: `worktree HEAD is "${headBranch}"; expected "main"`,
      headBranch,
    };
  }
  if (planBranches.length > 0) {
    return {
      clean: false,
      reason: 'plan-branches-linger',
      detail: `${planBranches.length} stale plan/* branch(es) remain`,
      planBranches,
    };
  }
  if (dirtyFiles.length > 0) {
    return {
      clean: false,
      reason: 'dirty',
      detail: `${dirtyFiles.length} uncommitted change(s)`,
      dirtyFiles,
    };
  }
  if (originSha !== 'NONE' && headSha !== 'NONE' && originSha !== headSha) {
    return {
      clean: false,
      reason: 'ahead-or-behind',
      detail: `HEAD ${headSha.slice(0, 7)} != origin/main ${originSha.slice(0, 7)}`,
    };
  }

  return { clean: true, headBranch: 'main', commitSha: headSha };
}
