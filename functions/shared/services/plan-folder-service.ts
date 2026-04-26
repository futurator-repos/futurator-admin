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
