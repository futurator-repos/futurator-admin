/**
 * free-agent-open-pr.ts — 2026-05-27 PR B.d.
 *
 * Orchestrates the agent-opens-PR flow from the API Lambda. The flow:
 *
 *   1. Confirm the session's assist branch has commits ahead of `main`
 *      (via SSM `git rev-list --count`).
 *   2. Load the per-project contents:write PAT from Secrets Manager.
 *   3. SSM invoke: inject the PAT into the worktree's `origin` remote
 *      URL, then run `daemon/pipelines/lib/free-agent-commit-push.sh`.
 *   4. Parse the script's exit code + stdout:
 *      - 0 → push succeeded (SHA in stdout)
 *      - 2 → SECRETS_HIT (blocked)
 *      - 3 → BRANCH_MISMATCH
 *      - 5 → PUSH_FAILED (commit landed locally, push didn't)
 *      - 6 → NO_DIFF_VS_BASE
 *
 * The caller (API route) is responsible for steps 5+:
 *   5. Compute the diff stats via the GitHub API + classify via risk
 *      classifier.
 *   6. Call createPullRequest with the templated body.
 *   7. Persist PR state on the session row.
 *   8. Emit `free-agent.merge.requested` event.
 *
 * This module stops at step 4 so the caller can short-circuit on push
 * failures without holding a GitHub API call.
 */

export interface OpenPrDeps {
  sendSsmCommand: (cmd: string) => Promise<string>;
  waitForSsmOutput: (commandId: string) => Promise<string>;
}

export type PushPhaseResult =
  | { kind: 'pushed'; headSha: string }
  | { kind: 'no-diff' }
  | { kind: 'secrets-hit'; pattern: string }
  | { kind: 'branch-mismatch'; detail: string }
  | { kind: 'push-failed'; reason: string; sha?: string }
  | { kind: 'worktree-missing' }
  | { kind: 'unknown'; detail: string };

const SCRIPT_PATH = '/opt/futurator-daemon/daemon/pipelines/lib/free-agent-commit-push.sh';

/**
 * Confirm the assist branch has at least one commit ahead of `main`.
 * Returns the count (0 means "nothing to push").
 */
export async function countAssistCommitsAhead(
  workingDir: string,
  deps: OpenPrDeps,
): Promise<number> {
  const cmd = [
    `set -e`,
    `if [ ! -d "${workingDir}" ]; then echo "WORKTREE_ABSENT"; exit 0; fi`,
    `cd "${workingDir}"`,
    `COUNT=$(sudo -u ubuntu git rev-list --count main..HEAD 2>/dev/null || echo "0")`,
    `echo "COMMITS_AHEAD=$COUNT"`,
  ].join('\n');
  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  if (output.includes('WORKTREE_ABSENT')) return 0;
  const match = output.match(/COMMITS_AHEAD=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Run the push script via SSM. The PAT is injected into the worktree's
 * `origin` remote URL just before the script runs and rotated back to the
 * un-authed form after. This keeps the PAT out of `git config` between
 * invocations (defense-in-depth — the worktree dir is already path-
 * confined to the daemon's user).
 */
export async function runPushScript(
  args: {
    branchName: string;
    worktreePath: string;
    repoUrl: string;
    pat: string;
  },
  deps: OpenPrDeps,
): Promise<PushPhaseResult> {
  const cloneUrl = args.repoUrl.replace(/^https:\/\//, `https://x-access-token:${args.pat}@`);

  const cmd = [
    `set -o pipefail`,
    `if [ ! -d "${args.worktreePath}" ]; then echo "WORKTREE_MISSING"; exit 4; fi`,
    `cd "${args.worktreePath}"`,
    // Temporarily set origin URL to the auth'd form.
    `sudo -u ubuntu git remote set-url origin "${cloneUrl}" 2>/dev/null || true`,
    // Run the canonical script.
    `bash ${SCRIPT_PATH} "${args.branchName}" "${args.worktreePath}"`,
    `RC=$?`,
    // ALWAYS restore the un-authed origin URL afterwards (defense in depth).
    `sudo -u ubuntu git remote set-url origin "${args.repoUrl}" 2>/dev/null || true`,
    `exit $RC`,
  ].join('\n');

  const commandId = await deps.sendSsmCommand(cmd);
  const output = await deps.waitForSsmOutput(commandId);
  return parsePushOutput(output);
}

export function parsePushOutput(output: string): PushPhaseResult {
  if (output.includes('WORKTREE_MISSING')) return { kind: 'worktree-missing' };
  if (output.includes('NO_DIFF_VS_BASE')) return { kind: 'no-diff' };
  const secretsMatch = output.match(/SECRETS_HIT: pattern=(\S+)/);
  if (secretsMatch) return { kind: 'secrets-hit', pattern: secretsMatch[1] };
  const branchMatch = output.match(/BRANCH_MISMATCH: (.+)/);
  if (branchMatch) return { kind: 'branch-mismatch', detail: branchMatch[1].trim() };
  const pushFailedMatch = output.match(/PUSH_FAILED: (\S+)/);
  if (pushFailedMatch) {
    const shaMatch = output.match(/^([a-f0-9]{40})$/m);
    return { kind: 'push-failed', reason: pushFailedMatch[1], sha: shaMatch?.[1] };
  }
  const pushedMatch = output.match(/PUSHED: \S+ \S+ @ ([a-f0-9]{40})/);
  if (pushedMatch) return { kind: 'pushed', headSha: pushedMatch[1] };
  return { kind: 'unknown', detail: output.slice(0, 500) };
}

/**
 * Templated PR body. Includes the risk class, gate results, diff summary,
 * and a chat-session deep link the operator can use to jump back to the
 * conversation that produced the change.
 */
export function buildPrBody(input: {
  sessionId: string;
  riskClass: 'red' | 'yellow' | 'green';
  riskReasons: string[];
  additions: number;
  deletions: number;
  filesChanged: number;
  appBaseUrl: string;
}): string {
  const reasonsList =
    input.riskReasons.length === 0
      ? '- _(no reasons recorded — default green)_'
      : input.riskReasons.map((r) => `- ${r}`).join('\n');
  const sessionLink = `${input.appBaseUrl.replace(/\/$/, '')}/free-agent?session=${encodeURIComponent(input.sessionId)}`;
  return `## Free Agent — automated PR

| | |
|---|---|
| **Risk class** | \`${input.riskClass}\` |
| **Diff** | ${input.filesChanged} file${input.filesChanged === 1 ? '' : 's'}, +${input.additions} / -${input.deletions} |
| **Session** | [${input.sessionId.slice(0, 8)}](${sessionLink}) |

### Risk classification reasons

${reasonsList}

---

_Generated by the Futurator Free Agent. The operator approved this PR for opening; merge requires a separate operator approval via the inline card (or the GitHub UI). For \`red\` class, merge requires typed confirmation in the admin UI._
`;
}
