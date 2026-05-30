/**
 * parse-repo-url.ts — resolve {owner, repo} for an App (2026-05-30).
 *
 * The Labs UI historically hardcoded the `futurator-repos` org. Brownfield
 * migrations store the App's REAL repo (any org) in `App.githubRepoUrl`
 * (e.g. https://github.com/Get-Really-Real/applicator.git). This helper
 * resolves the owner/repo to query, falling back to `futurator-repos/<appId>`
 * for greenfield apps that have no explicit URL.
 */

export const DEFAULT_GITHUB_OWNER = 'futurator-repos';

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Parse an `owner/repo` out of a GitHub URL. Accepts:
 *   https://github.com/<owner>/<repo>(.git)?
 *   git@github.com:<owner>/<repo>(.git)?
 * Returns null if it can't be parsed.
 */
export function parseGithubRepoUrl(url: string | null | undefined): RepoRef | null {
  if (!url) return null;
  const cleaned = url.trim();
  // https / http
  const m = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/**
 * Resolve the {owner, repo} to query for an App. Prefers the App's explicit
 * `githubRepoUrl` (brownfield, any org); else falls back to
 * `futurator-repos/<appId>` (greenfield convention).
 */
export function resolveRepoRef(appId: string, githubRepoUrl?: string | null): RepoRef {
  return parseGithubRepoUrl(githubRepoUrl) ?? { owner: DEFAULT_GITHUB_OWNER, repo: appId };
}
