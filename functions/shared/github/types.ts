/**
 * types.ts — GitHub connector shared types (Pipeline v2 Phase 1)
 *
 * All types used by connector.ts and by the Hono routes that consume it.
 * No runtime code here — pure type declarations.
 */

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

export interface RateLimit {
  /** Total request quota for the window (from X-RateLimit-Limit) */
  limit: number;
  /** Requests remaining this window (from X-RateLimit-Remaining) */
  remaining: number;
  /** Unix timestamp when the window resets (from X-RateLimit-Reset) */
  reset: number;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * GitHubError is thrown for every non-2xx response from the GitHub API.
 *
 * The `rateLimit` field is populated even on error responses because GitHub
 * returns rate-limit headers on 4xx/5xx as well, and callers may want to
 * inspect how many requests remain before deciding whether to retry.
 */
export class GitHubError extends Error {
  readonly status: number;
  readonly rateLimit?: RateLimit;

  constructor(message: string, status: number, rateLimit?: RateLimit) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

// ---------------------------------------------------------------------------
// Resource shapes
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  id: number;
  name?: string | null;
  email?: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number };
  private: boolean;
  description: string | null;
  default_branch: string;
  clone_url: string;
  html_url: string;
  is_template: boolean;
  pushed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Present in org list responses; may be missing in template-generate responses */
  topics?: string[];
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Present for blobs; absent for trees */
  size?: number;
  url: string;
}

/** Returned by getFileContent when the file is within the 1MB threshold */
export interface FileContent {
  content: string;
  encoding: 'utf-8' | 'base64';
  sha: string;
  size: number;
}

/** Returned by getFileContent when the file exceeds the 1MB threshold */
export interface FileTooLarge {
  tooLarge: true;
  size: number;
}

// ---------------------------------------------------------------------------
// Git graph shapes (commits / branches / pull requests)
// ---------------------------------------------------------------------------

export interface GitHubCommit {
  sha: string;
  parents: { sha: string }[];
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  /** Null when the committer email isn't tied to a GitHub user. */
  author: { login: string; avatar_url: string } | null;
  html_url: string;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

export interface GitHubPullRequest {
  number: number;
  /** GraphQL global node id — needed to mark a draft PR ready for review. */
  node_id?: string;
  /** True while the PR is a draft (REST includes this on the PR object). */
  draft?: boolean;
  title: string;
  state: 'open' | 'closed';
  /** Convenience flag GitHub adds on `closed` PRs that were merged. */
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string; avatar_url: string } | null;
  html_url: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Connector return envelope
// ---------------------------------------------------------------------------

/**
 * Every connector function returns `{ data, rateLimit }`.
 * Hono routes extract `data` and forward `rateLimit` inside the JSON body.
 */
export interface ConnectorResult<T> {
  data: T;
  rateLimit: RateLimit;
}
