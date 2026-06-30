// plan-branch — the git bookends of the shared-tree model (development-plan §4.1).
//
// Per-PLAN branch, per-STORY commit, ONE plan→main merge at deploy:
//   • ensurePlanBranch — at the first story commit, put the shared tree on
//     `plan/<id>` (create from HEAD, or check out if it already exists). Idempotent
//     and cheap; safe to call on every integrate (it no-ops once we're on it).
//   • mergePlanToMain — the ONLY merge in the whole flow, run at deploy/sign-off:
//     fast-forward-or-`--no-ff` `plan/<id>` into `main`.
//
// `git` is injected; both run under the commit lock at the call site so a branch
// switch never races a concurrent commit.

/** Sanitize an id into a valid git ref segment. */
export function planBranchName(planIdOrSlug) {
  const safe = String(planIdOrSlug || 'plan').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return `plan/${safe || 'plan'}`;
}

/**
 * Ensure the shared tree is on the plan branch. Idempotent.
 * @returns {Promise<{ branch:string, created:boolean, switched:boolean, reason?:string }>}
 */
export async function ensurePlanBranch({ repoDir, branch, git, fromRef = 'HEAD' }) {
  if (!git) throw new Error('ensurePlanBranch: git helper required');
  const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  const current = cur.code === 0 ? cur.stdout.trim() : '';
  if (current === branch) return { branch, created: false, switched: false };

  // Does the branch already exist?
  const exists = await git(['rev-parse', '--verify', '--quiet', branch], repoDir);
  if (exists.code === 0) {
    const co = await git(['checkout', branch], repoDir);
    if (co.code !== 0) return { branch, created: false, switched: false, reason: `checkout failed: ${(co.stderr || '').slice(0, 160)}` };
    return { branch, created: false, switched: true };
  }
  const create = await git(['checkout', '-b', branch, fromRef], repoDir);
  if (create.code !== 0) return { branch, created: false, switched: false, reason: `create failed: ${(create.stderr || '').slice(0, 160)}` };
  return { branch, created: true, switched: true };
}

/**
 * The single deploy merge: plan branch → main. Run once, at sign-off/deploy.
 * @returns {Promise<{ merged:boolean, sha?:string, reason?:string }>}
 */
export async function mergePlanToMain({ repoDir, branch, git, mainBranch = 'main' }) {
  if (!git) throw new Error('mergePlanToMain: git helper required');
  const co = await git(['checkout', mainBranch], repoDir);
  if (co.code !== 0) return { merged: false, reason: `checkout ${mainBranch} failed: ${(co.stderr || '').slice(0, 160)}` };
  const merge = await git(['merge', '--no-ff', branch, '-m', `merge ${branch} → ${mainBranch} (Pipeline-3 plan delivery)`], repoDir);
  if (merge.code !== 0) {
    // Leave main clean on conflict; the operator (or a later retry) resolves.
    await git(['merge', '--abort'], repoDir);
    return { merged: false, reason: `merge conflict: ${(merge.stdout || merge.stderr || '').slice(0, 200)}` };
  }
  const head = await git(['rev-parse', 'HEAD'], repoDir);
  return { merged: true, sha: head.code === 0 ? head.stdout.trim() : undefined };
}
