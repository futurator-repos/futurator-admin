/**
 * connector.ts — GitHub REST API connector (Pipeline v2 Phase 1)
 *
 * Single source of truth for communicating with api.github.com. Pure functions,
 * no React, no Hono imports. All calls flow through `githubFetch()` so rate-limit
 * headers are captured in one place.
 *
 * Token acquisition: always delegates to `loadPat()` from load-pat.ts.
 * Never reads process.env.GITHUB_PAT directly.
 *
 * Error contract: every non-2xx throws GitHubError(message, status, rateLimit).
 * Callers (Hono routes) translate GitHubError into HTTP responses.
 *
 * Rate-limit envelope shape:
 *   { limit: number, remaining: number, reset: number }
 *   - limit:     total quota for this window
 *   - remaining: requests left
 *   - reset:     Unix timestamp (seconds) when the window resets
 *   The Hono routes (Story 1.2.4) forward `rateLimit` verbatim in the JSON
 *   body alongside `data` so the UI can display "X / 5000 remaining".
 */

import { loadPat } from './load-pat';
import { GITHUB_OWNER, GITHUB_OWNER_IS_ORG } from './constants';
import { GitHubError } from './types';
import type {
  RateLimit,
  GitHubUser,
  GitHubRepo,
  TreeEntry,
  FileContent,
  FileTooLarge,
  ConnectorResult,
  GitHubCommit,
  GitHubBranch,
  GitHubPullRequest,
} from './types';

// Re-export everything so consumers only need one import path
export { GitHubError } from './types';
export type {
  RateLimit,
  GitHubUser,
  GitHubRepo,
  TreeEntry,
  FileContent,
  FileTooLarge,
  ConnectorResult,
  GitHubCommit,
  GitHubBranch,
  GitHubPullRequest,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'Futurator-Admin-GitHub/1.0';
const ONE_MB = 1_048_576; // bytes — files larger than this are returned as tooLarge

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract and normalise the three rate-limit headers GitHub always returns. */
function parseRateLimit(headers: Headers): RateLimit {
  return {
    limit: Number(headers.get('X-RateLimit-Limit') ?? 0),
    remaining: Number(headers.get('X-RateLimit-Remaining') ?? 0),
    reset: Number(headers.get('X-RateLimit-Reset') ?? 0),
  };
}

/**
 * Resolve the PAT via loadPat(). Wraps any loadPat() error into a
 * GitHubError(401) so callers only have to handle one error type.
 */
function resolvePat(): string {
  try {
    return loadPat();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'GitHub PAT unavailable';
    throw new GitHubError(msg, 401);
  }
}

/** Build the standard GitHub request headers. Calls resolvePat(). */
function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const pat = resolvePat();
  return {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${pat}`,
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Core fetch primitive
// ---------------------------------------------------------------------------

/**
 * githubFetch<T> — every connector function calls this.
 *
 * - Prepends GITHUB_API to `path`.
 * - Injects auth + UA headers (calls loadPat via buildHeaders).
 * - On success: returns `{ data: T, rateLimit }`.
 * - On non-2xx: throws GitHubError with the response `message` field (if
 *   present in the JSON body) and rate-limit headers from the failing response.
 * - 204 No Content: returns `{ data: undefined as T, rateLimit }`.
 *
 * @param path  Path starting with `/`, e.g. `/user` or `/repos/owner/name`
 * @param init  Standard RequestInit (method, body, etc.). Auth headers merged.
 */
export async function githubFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<ConnectorResult<T>> {
  const { headers: initHeaders, ...restInit } = init ?? {};

  const mergedHeaders: Record<string, string> = {
    ...buildHeaders(),
    ...(initHeaders as Record<string, string> | undefined),
  };

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...restInit,
    headers: mergedHeaders,
  });

  const rateLimit = parseRateLimit(response.headers);

  if (!response.ok) {
    let body: { message?: string } = {};
    try {
      body = (await response.json()) as { message?: string };
    } catch {
      // ignore JSON parse failures — fall back to status text
    }
    const message = body.message ?? response.statusText;
    throw new GitHubError(message, response.status, rateLimit);
  }

  // 204 No Content (e.g. DELETE) — no body to parse
  if (response.status === 204) {
    return { data: undefined as T, rateLimit };
  }

  const data = (await response.json()) as T;
  return { data, rateLimit };
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

/**
 * Parse GitHub's Link response header to extract the `rel="next"` URL.
 * Returns null when there is no next page.
 *
 * Example header:
 *   <https://api.github.com/user/repos?page=2>; rel="next", ...
 */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Story 1.2.1 — base + status
// ---------------------------------------------------------------------------

/**
 * getUser — GET /user
 *
 * Authenticate and retrieve the authenticated user's public profile.
 */
export async function getUser(): Promise<ConnectorResult<GitHubUser>> {
  return githubFetch<GitHubUser>('/user');
}

/**
 * checkConnection — wraps getUser(), swallows GitHubError into `error` field.
 *
 * Returns `{ connected: true, login, rateLimit }` on success.
 * Returns `{ connected: false, error, rateLimit? }` on any GitHubError.
 * Never throws — used by the status Hono route.
 */
export async function checkConnection(): Promise<{
  connected: boolean;
  login?: string;
  error?: string;
  rateLimit?: RateLimit;
}> {
  try {
    const { data, rateLimit } = await getUser();
    return { connected: true, login: data.login, rateLimit };
  } catch (err) {
    if (err instanceof GitHubError) {
      return { connected: false, error: err.message, rateLimit: err.rateLimit };
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { connected: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Story 1.2.2 — read surface
// ---------------------------------------------------------------------------

/**
 * listRepos — list pipeline-managed repos for GITHUB_OWNER.
 *
 * For Org accounts: GET /orgs/{owner}/repos?per_page=100&sort=pushed
 * For User accounts: GET /user/repos?per_page=100&sort=pushed&affiliation=owner
 *   (the User-Repos endpoint scopes to the authenticated user's owned repos,
 *   which matches "all repos under this account" — and works because the PAT
 *   belongs to that user).
 *
 * Auto-paginates by following Link rel="next" until exhausted.
 * Merges pages into a single array. The returned `rateLimit` is from the
 * final page response.
 *
 * @param opts.perPage  Items per page (default 100, GitHub max 100).
 */
export async function listRepos(opts?: {
  perPage?: number;
}): Promise<ConnectorResult<GitHubRepo[]>> {
  const perPage = opts?.perPage ?? 100;
  const allRepos: GitHubRepo[] = [];
  let rateLimit: RateLimit = { limit: 0, remaining: 0, reset: 0 };

  const pat = resolvePat();
  let nextUrl: string | null = GITHUB_OWNER_IS_ORG
    ? `${GITHUB_API}/orgs/${GITHUB_OWNER}/repos?per_page=${perPage}&sort=pushed`
    : `${GITHUB_API}/user/repos?per_page=${perPage}&sort=pushed&affiliation=owner`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${pat}`,
        'User-Agent': USER_AGENT,
      },
    });

    rateLimit = parseRateLimit(response.headers);

    if (!response.ok) {
      let body: { message?: string } = {};
      try {
        body = (await response.json()) as { message?: string };
      } catch {
        // ignore
      }
      throw new GitHubError(body.message ?? response.statusText, response.status, rateLimit);
    }

    const page = (await response.json()) as GitHubRepo[];
    allRepos.push(...page);

    nextUrl = parseNextLink(response.headers.get('Link'));
  }

  return { data: allRepos, rateLimit };
}

/**
 * getRepo — GET /repos/{owner}/{name}
 *
 * Returns the full repo metadata including `default_branch`, `clone_url`,
 * `is_template`.
 */
export async function getRepo(owner: string, name: string): Promise<ConnectorResult<GitHubRepo>> {
  return githubFetch<GitHubRepo>(`/repos/${owner}/${name}`);
}

/**
 * getRepoTree — GET /repos/{owner}/{name}/git/trees/{branch}?recursive=1
 *
 * Fetches the full recursive file tree for a branch. If `branch` is omitted,
 * resolves the default branch via getRepo() first.
 *
 * When GitHub truncates the response (>100k entries or >7MB), returns
 * `{ tree, truncated: true, count: tree.length }`.
 */
export async function getRepoTree(
  owner: string,
  name: string,
  branch?: string,
): Promise<ConnectorResult<{ tree: TreeEntry[]; truncated: boolean; count: number }>> {
  let resolvedBranch = branch;
  let branchResolutionRateLimit: RateLimit | undefined;

  if (!resolvedBranch) {
    const { data: repo, rateLimit } = await getRepo(owner, name);
    resolvedBranch = repo.default_branch;
    branchResolutionRateLimit = rateLimit;
  }

  const { data, rateLimit } = await githubFetch<{
    sha: string;
    url: string;
    tree: TreeEntry[];
    truncated: boolean;
  }>(`/repos/${owner}/${name}/git/trees/${resolvedBranch}?recursive=1`);

  // Prefer the tree fetch's rate limit; fall back to the repo fetch's limit
  const finalRateLimit = rateLimit ??
    branchResolutionRateLimit ?? { limit: 0, remaining: 0, reset: 0 };

  return {
    data: {
      tree: data.tree,
      truncated: data.truncated,
      count: data.tree.length,
    },
    rateLimit: finalRateLimit,
  };
}

/**
 * getFileContent — GET /repos/{owner}/{name}/contents/{path}?ref={ref}
 *
 * Files ≤ 1MB: decodes base64 → utf-8, returns `{ content, encoding: 'utf-8', sha, size }`.
 * Files  > 1MB: returns `{ tooLarge: true, size }` — caller must use the raw
 *               download URL if they truly need the content.
 *
 * @param ref  Commit SHA, branch name, or tag. Omit for the repo's default branch.
 */
export async function getFileContent(
  owner: string,
  name: string,
  filePath: string,
  ref?: string,
): Promise<ConnectorResult<FileContent | FileTooLarge>> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const { data: raw, rateLimit } = await githubFetch<{
    content: string;
    encoding: string;
    sha: string;
    size: number;
    type: string;
  }>(`/repos/${owner}/${name}/contents/${filePath}${qs}`);

  if (raw.size > ONE_MB) {
    return { data: { tooLarge: true, size: raw.size }, rateLimit };
  }

  let content = raw.content;
  let encoding: 'utf-8' | 'base64' = 'base64';

  if (raw.encoding === 'base64') {
    // GitHub returns base64 with embedded newlines — strip them before decoding
    content = Buffer.from(raw.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    encoding = 'utf-8';
  }

  return {
    data: { content, encoding, sha: raw.sha, size: raw.size },
    rateLimit,
  };
}

// ---------------------------------------------------------------------------
// Story 1.2.3 — write surface
// ---------------------------------------------------------------------------

/**
 * is422NameTaken — determine whether a 422 response body means
 * "repo name already taken" vs. some other validation error.
 *
 * WARNING: GitHub's error messages can change without notice. This helper
 * checks both the top-level `message` field and the nested `errors[].message`
 * array so that a change on one surface does not silently bypass the
 * idempotency path. When in doubt, we fall through to throwing GitHubError
 * rather than swallowing an unexpected 422.
 *
 * Known patterns (as of 2026):
 *   body.errors[0].message: "name already exists on this account"
 *   body.errors[0].message: "name is already taken"
 *   body.message: "Repository creation failed." (less specific — only used
 *                 as a fallback when errors[] is empty or absent)
 */
export function is422NameTaken(body: {
  message?: string;
  errors?: Array<{ message?: string; resource?: string; field?: string; code?: string }>;
}): boolean {
  const nameTakenPatterns = [
    'name already exists',
    'name is already taken',
    'already exists on this account',
  ];

  // Check nested errors first — more reliable signal
  if (Array.isArray(body.errors)) {
    for (const e of body.errors) {
      const msg = (e.message ?? '').toLowerCase();
      if (nameTakenPatterns.some((p) => msg.includes(p))) return true;
    }
  }

  // Fallback: top-level message
  const topMessage = (body.message ?? '').toLowerCase();
  if (nameTakenPatterns.some((p) => topMessage.includes(p))) return true;

  return false;
}

/**
 * createRepoFromTemplate — POST /repos/{templateOwner}/{templateRepo}/generate
 *
 * Creates a new private repo under GITHUB_OWNER from a GitHub template.
 *
 * Success: returns `{ data: GitHubRepo, rateLimit }`.
 *
 * Idempotency (saga-safe): if GitHub returns 422 with a "name already taken"
 * body, fetches the existing repo via getRepo() and returns
 * `{ data: { existing: true, repo: GitHubRepo }, rateLimit }` instead of
 * throwing. This lets the app-bootstrap saga re-run a failed step without
 * treating "repo already exists" as an error.
 *
 * Any other non-2xx: throws GitHubError.
 */
export async function createRepoFromTemplate(
  templateOwner: string,
  templateRepo: string,
  newRepoName: string,
  opts?: { private?: boolean; description?: string },
): Promise<ConnectorResult<GitHubRepo | { existing: true; repo: GitHubRepo }>> {
  const pat = resolvePat();

  const requestBody = JSON.stringify({
    owner: GITHUB_OWNER,
    name: newRepoName,
    private: opts?.private ?? true,
    include_all_branches: false,
    ...(opts?.description !== undefined ? { description: opts.description } : {}),
  });

  // Use raw fetch so we can inspect the 422 body before deciding to throw
  const response = await fetch(`${GITHUB_API}/repos/${templateOwner}/${templateRepo}/generate`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${pat}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  const rateLimit = parseRateLimit(response.headers);

  if (!response.ok) {
    let responseBody: {
      message?: string;
      errors?: Array<{ message?: string }>;
    } = {};
    try {
      responseBody = await response.json();
    } catch {
      // ignore JSON parse failures
    }

    if (response.status === 422 && is422NameTaken(responseBody)) {
      // Saga idempotency path — repo already exists, fetch and return it
      const { data: existingRepo, rateLimit: existingRateLimit } = await getRepo(
        GITHUB_OWNER,
        newRepoName,
      );
      return {
        data: { existing: true, repo: existingRepo },
        rateLimit: existingRateLimit,
      };
    }

    const message = responseBody.message ?? response.statusText;
    throw new GitHubError(message, response.status, rateLimit);
  }

  const data = (await response.json()) as GitHubRepo;
  return { data, rateLimit };
}

/**
 * deleteRepo — DELETE /repos/{owner}/{name}
 *
 * Used by the app-bootstrap saga rollback (Story 1.4.4) to remove a partially-
 * created repo when a later saga step fails.
 *
 * Returns `{ data: { deleted: true }, rateLimit }` on 204 No Content.
 * Throws GitHubError on any other non-2xx (including 404 if already gone).
 */
export async function deleteRepo(
  owner: string,
  name: string,
): Promise<ConnectorResult<{ deleted: true }>> {
  const { rateLimit } = await githubFetch<undefined>(`/repos/${owner}/${name}`, {
    method: 'DELETE',
  });
  return { data: { deleted: true }, rateLimit };
}

// ---------------------------------------------------------------------------
// Git graph surface — commits / branches / pull requests
// ---------------------------------------------------------------------------

/**
 * listCommits — GET /repos/{owner}/{name}/commits
 *
 * Returns commits reachable from `opts.sha` (defaults to the repo's default
 * branch). Newest first. Caps at GitHub's per_page=100.
 */
export async function listCommits(
  owner: string,
  name: string,
  opts: { sha?: string; perPage?: number } = {},
): Promise<ConnectorResult<GitHubCommit[]>> {
  const perPage = Math.min(Math.max(opts.perPage ?? 30, 1), 100);
  const qs = new URLSearchParams({ per_page: String(perPage) });
  if (opts.sha) qs.set('sha', opts.sha);
  return githubFetch<GitHubCommit[]>(`/repos/${owner}/${name}/commits?${qs.toString()}`);
}

/**
 * listBranches — GET /repos/{owner}/{name}/branches
 *
 * Returns up to 100 branches (one page). Sufficient for the GitGraph view —
 * we only ever render a handful of branch lanes.
 */
export async function listBranches(
  owner: string,
  name: string,
): Promise<ConnectorResult<GitHubBranch[]>> {
  return githubFetch<GitHubBranch[]>(`/repos/${owner}/${name}/branches?per_page=100`);
}

/**
 * listPullRequests — GET /repos/{owner}/{name}/pulls
 *
 * `state` defaults to 'all' so we can show both open and merged PRs in the
 * graph (the prototype displays both). Sorted by recently updated first.
 */
export async function listPullRequests(
  owner: string,
  name: string,
  opts: { state?: 'open' | 'closed' | 'all'; perPage?: number; head?: string } = {},
): Promise<ConnectorResult<GitHubPullRequest[]>> {
  const state = opts.state ?? 'all';
  const perPage = Math.min(Math.max(opts.perPage ?? 30, 1), 100);
  const qs = new URLSearchParams({
    state,
    per_page: String(perPage),
    sort: 'updated',
    direction: 'desc',
  });
  if (opts.head) qs.set('head', opts.head);
  return githubFetch<GitHubPullRequest[]>(`/repos/${owner}/${name}/pulls?${qs.toString()}`);
}

/**
 * Story 22.3 — createPullRequest — POST /repos/{owner}/{name}/pulls
 *
 * Opens a PR from `head` (the source branch, e.g. `party/applicator/sid12345`)
 * into `base` (the target branch, typically `main`). Used by the party-push
 * checkpoint card's "Open PR" action.
 *
 * Requires the PAT scope `contents:write` AND `pull_requests:write`. The
 * party-push Epic 21 toggle (Story 21.2) prompts for a PAT with both
 * scopes when the operator enables push.
 */
export async function createPullRequest(
  owner: string,
  name: string,
  input: {
    title: string;
    head: string;
    base: string;
    body?: string;
    /** Default true; set false for ready-for-review PRs. */
    draft?: boolean;
  },
): Promise<ConnectorResult<GitHubPullRequest>> {
  const body = JSON.stringify({
    title: input.title,
    head: input.head,
    base: input.base,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
  });
  return githubFetch<GitHubPullRequest>(`/repos/${owner}/${name}/pulls`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 2026-05-27 PR B.d — mergePullRequest — PUT /repos/{owner}/{name}/pulls/{n}/merge
 *
 * Merge an open PR. Used by the Free Agent's `/approve-merge` endpoint once
 * the operator approves the inline card. Default merge method is `squash`
 * for self-edit clean-history (matches party-push convention).
 *
 * Requires the same `contents:write` + `pull_requests:write` PAT scopes as
 * createPullRequest.
 */
export async function mergePullRequest(
  owner: string,
  name: string,
  prNumber: number,
  input?: {
    /** Defaults to 'squash'. */
    method?: 'merge' | 'squash' | 'rebase';
    /** Commit title override; GitHub picks PR title by default. */
    commit_title?: string;
    commit_message?: string;
  },
): Promise<ConnectorResult<{ sha: string; merged: boolean; message: string }>> {
  const body = JSON.stringify({
    merge_method: input?.method ?? 'squash',
    ...(input?.commit_title ? { commit_title: input.commit_title } : {}),
    ...(input?.commit_message ? { commit_message: input.commit_message } : {}),
  });
  return githubFetch<{ sha: string; merged: boolean; message: string }>(
    `/repos/${owner}/${name}/pulls/${prNumber}/merge`,
    { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * 2026-06-12 — markPullRequestReadyForReview (GraphQL).
 *
 * A draft PR cannot be merged via the REST merge API (405). GitHub only
 * exposes "clear draft" through the GraphQL `markPullRequestReadyForReview`
 * mutation, which takes the PR's global node id (REST PR object → `node_id`).
 *
 * Best-effort + idempotent: if the PR is already ready, GitHub returns a
 * GraphQL error ("not a draft") which we swallow — the caller proceeds to
 * merge regardless. Returns true when the PR ends up non-draft.
 */
export async function markPullRequestReadyForReview(nodeId: string): Promise<boolean> {
  const query =
    'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}';
  try {
    const res = await githubFetch<{
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } };
      errors?: Array<{ message: string }>;
    }>('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables: { id: nodeId } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const isDraft = res.data?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft;
    // isDraft === false → cleared. errors (e.g. already-ready) → treat as ready.
    return isDraft === false || !!res.data?.errors;
  } catch {
    // Network/permission hiccup — let the caller attempt the merge anyway;
    // the merge call surfaces a clear error if the PR is still a draft.
    return false;
  }
}

/**
 * 2026-05-27 PR B.d — compareCommits — GET /repos/{owner}/{name}/compare/{base}...{head}
 *
 * Returns the file list + line counts between two refs. Used by the open-pr
 * flow to derive `additions` / `deletions` / `filesChanged` inputs to the
 * agent-risk-classifier BEFORE the PR is opened, so the classification
 * result can land in the PR body verbatim.
 *
 * GitHub URL-encodes `:` in `base...head` for refs that include them; head
 * refs of shape `assist/<proj>/<sid8>` are slash-only and safe.
 */
export interface CompareCommitsResponse {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    changes: number;
    status: string;
  }>;
}

export async function compareCommits(
  owner: string,
  name: string,
  base: string,
  head: string,
): Promise<ConnectorResult<CompareCommitsResponse>> {
  const safeBase = encodeURIComponent(base);
  const safeHead = encodeURIComponent(head);
  return githubFetch<CompareCommitsResponse>(
    `/repos/${owner}/${name}/compare/${safeBase}...${safeHead}`,
  );
}

/**
 * 2026-05-27 PR B.d — closePullRequest — PATCH /repos/{owner}/{name}/pulls/{n}
 *
 * Close (reject) an open PR without merging. Used by the Free Agent's
 * `/reject-merge` endpoint. Reason gets injected back into the chat as the
 * next user-turn so the agent can revise.
 */
export async function closePullRequest(
  owner: string,
  name: string,
  prNumber: number,
): Promise<ConnectorResult<GitHubPullRequest>> {
  const body = JSON.stringify({ state: 'closed' });
  return githubFetch<GitHubPullRequest>(`/repos/${owner}/${name}/pulls/${prNumber}`, {
    method: 'PATCH',
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}
