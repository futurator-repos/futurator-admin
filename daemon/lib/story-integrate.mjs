// story-integrate — per-story commit to the plan branch (development-plan §4.1).
//
// The whole "Integrate" stage in the shared-tree model: stage the story's own
// files and commit them to the plan branch under the commit lock. NO branch, NO
// merge. The returned SHA is what the bound-AC staleness guard
// (testBinding.lastRunSha) binds against. Disjoint `touches` (gate-enforced)
// mean the staged set never overlaps a sibling's, so concurrent stories produce
// clean, independent commits once serialized by the lock.
//
// `git` is injected (so it unit-tests without a real repo); the daemon passes a
// helper that runs git as the repo owner.

import { withCommitLock } from './commit-lock.mjs';

/** Quote a path list for `git add` (defensive against spaces/globs). */
function stageArgs(touches) {
  const paths = (touches || []).filter((t) => t && t !== '<EPIC_WIDE>');
  return paths.length ? paths : ['-A']; // EPIC_WIDE / no declared scope → stage all
}

/**
 * Commit a story's work to the current (plan) branch.
 *
 * @param {{
 *   repoDir: string,
 *   touches: string[],
 *   storyId: string,
 *   title?: string,
 *   git: (args: string[], cwd: string) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   lock?: typeof withCommitLock,
 * }} args
 * @returns {Promise<{ committed: boolean, sha?: string, reason?: string }>}
 */
export async function integrateStory({ repoDir, touches, storyId, title, git, lock = withCommitLock }) {
  if (!git) throw new Error('integrateStory: git helper required');
  return lock(repoDir, async () => {
    // Stage the story's files.
    const add = await git(['add', ...stageArgs(touches)], repoDir);
    if (add.code !== 0) return { committed: false, reason: `git add failed: ${(add.stderr || '').slice(0, 200)}` };

    // Nothing staged (story wrote nothing, or files unchanged) → no commit.
    const staged = await git(['diff', '--cached', '--name-only'], repoDir);
    if (staged.code === 0 && !staged.stdout.trim()) {
      return { committed: false, reason: 'nothing to commit' };
    }

    const msg = `story(${storyId}): ${title || 'implement'}\n\nPipeline-3 per-story commit (shared-tree, no merge).`;
    const commit = await git(['commit', '-m', msg], repoDir);
    if (commit.code !== 0) return { committed: false, reason: `git commit failed: ${(commit.stderr || '').slice(0, 200)}` };

    const head = await git(['rev-parse', 'HEAD'], repoDir);
    const sha = head.code === 0 ? head.stdout.trim() : undefined;
    return { committed: true, sha };
  });
}
