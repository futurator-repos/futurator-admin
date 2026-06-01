/**
 * worktree-paths.mjs — Pipeline v2 Phase 2-B / Story 2-B-2-1 (PR-86).
 *
 * Pure functions that compute per-story branch names + filesystem paths
 * for the v2.5 §24 worktree topology. Helper-only; the actual `git
 * worktree add` invocation is a 2-B-2 follow-on that wires this into the
 * daemon spawn flow.
 *
 *   Per-story branch:  `wip/<storyId>`
 *   Per-story dir:     `/home/ubuntu/worktrees/<project>/<plan>/<storyId>`
 *   Per-explore dir:   `/home/ubuntu/worktrees/<project>/<plan>/explore-<approach>`
 *   Stream branch:     `stream/<name>`
 *   Experiment branch: `experiment/<name>`
 *   Hotfix branch:     `hotfix/<tag>`
 *   Archive branch:    `archive/<plan-id>-<approach>-rejected`
 *
 * Per PR-38 the worktree root is `/home/ubuntu/worktrees/` not under the
 * project tree — keeps it gitignored automatically and on its own EBS
 * budget per v2.5 §24.1.
 */

import { join } from 'path';

const DEFAULT_WORKTREE_ROOT =
  process.env.FUTURATOR_WORKTREE_ROOT || '/home/ubuntu/worktrees';

// Mirrors App.appId regex from Phase 1 PR-1. Used for project/plan/
// approach slugs which are human-authored kebab-case strings — these
// must start with a lowercase letter for stricter URL/folder safety.
const SLUG_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

// 2026-05-20 — Phase 1 worktree rollout hotfix. storyIds are UUIDs
// (e.g. `8bda01c7-0e64-43e0-be6c-be29f859a3f4`) emitted by the PM
// agent's crypto.randomUUID(). UUIDs start with hex digits (including
// `0`-`9`), violate the SLUG_RE leading-letter requirement, and are 36
// chars long. They are NOT path-traversal vectors (only `[a-f0-9-]`)
// but they need a dedicated validator that knows UUID shape.
//
// Accepts the canonical 8-4-4-4-12 hyphenated lowercase UUID form. We
// don't relax `SLUG_RE` itself because project/plan slugs benefit from
// the stricter pattern (operator-typed strings; alphabet-leading
// surfaces better in CLIs / URLs).
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Some legacy storyIds in DDB use kebab-case (e.g. `s1`, `e3-s5` in tests).
// Accept either UUID OR slug shape for storyId arguments.
const STORY_ID_RE = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z][a-z0-9-]{0,38}[a-z0-9])$/;

function assertSlug(label, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`worktree-paths: ${label} must match kebab-case slug regex, got ${JSON.stringify(slug)}`);
  }
}

function assertStoryId(slug) {
  if (typeof slug !== 'string' || !STORY_ID_RE.test(slug)) {
    throw new Error(
      `worktree-paths: storyId must match UUID or kebab-case slug regex, got ${JSON.stringify(slug)}`,
    );
  }
}

/**
 * Per-story worktree path: `<root>/<project>/<plan>/<storyId>`.
 *
 * @param {{ project: string, plan: string, storyId: string, root?: string }} args
 * @returns {string}
 */
export function storyWorktreeDir({ project, plan, storyId, root }) {
  assertSlug('project', project);
  assertSlug('plan', plan);
  assertStoryId(storyId);
  return join(root || DEFAULT_WORKTREE_ROOT, project, plan, storyId);
}

/**
 * Per-explore-branch worktree path (Phase 3-S speculation). Approach
 * label must match the speculation-marker's `approaches[i].id`.
 *
 * `<root>/<project>/<plan>/explore-<approach>`
 */
export function exploreWorktreeDir({ project, plan, approach, root }) {
  assertSlug('project', project);
  assertSlug('plan', plan);
  assertSlug('approach', approach);
  return join(root || DEFAULT_WORKTREE_ROOT, project, plan, `explore-${approach}`);
}

/** Per-story wip branch name. */
export function storyBranchName(storyId) {
  assertStoryId(storyId);
  return `wip/${storyId}`;
}

/** Per-explore-approach branch name. */
export function exploreBranchName({ planId, approach }) {
  assertSlug('planId', planId);
  assertSlug('approach', approach);
  return `explore/${planId}-${approach}`;
}

/** Loser-branch archive name after EVALUATOR declares a winner. */
export function archiveBranchName({ planId, approach }) {
  assertSlug('planId', planId);
  assertSlug('approach', approach);
  return `archive/${planId}-${approach}-rejected`;
}

/** Stream namespace per v2.5 §25. */
export function streamBranchName(name) {
  assertSlug('streamName', name);
  return `stream/${name}`;
}

/** Experiment/prototype-on-top branch per v2.5 §22. */
export function experimentBranchName(name) {
  assertSlug('experimentName', name);
  return `experiment/${name}`;
}

/** Hotfix branch off a production tag per v2.5 §22. */
export function hotfixBranchName(tag) {
  // Tag can contain `.` (semver) so we don't apply the slug regex.
  if (typeof tag !== 'string' || tag.length === 0 || tag.includes('/') || tag.includes('..')) {
    throw new Error(`worktree-paths: hotfix tag is invalid: ${JSON.stringify(tag)}`);
  }
  return `hotfix/${tag}`;
}

/**
 * Validate that a path lies under the worktree root (rejects ../ escape
 * attempts). Returns the normalized absolute path on success.
 */
export function ensureUnderRoot(path, root = DEFAULT_WORKTREE_ROOT) {
  // Lightweight check; the worktree-creation step uses `realpath` for
  // the canonical version. This helper is for invariant assertions in
  // the runner before `git worktree add` fires.
  if (path.includes('..')) {
    throw new Error(`worktree-paths: path contains ..: ${path}`);
  }
  if (!path.startsWith(root)) {
    throw new Error(`worktree-paths: path ${path} not under root ${root}`);
  }
  return path;
}

export const WORKTREE_ROOT_DEFAULT = DEFAULT_WORKTREE_ROOT;
