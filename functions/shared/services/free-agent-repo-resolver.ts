/**
 * free-agent-repo-resolver.ts — 2026-05-27 PR B.d.
 *
 * Map a free-agent session's `projectId` → GitHub `{owner, name, repoUrl,
 * defaultBranch}` so the API Lambda can push + open a PR.
 *
 * Two cases:
 *   - `futurator-admin` → futurator-repos/futurator-admin (the admin
 *     codebase itself; matches the bootstrap-self-edit-repo target).
 *   - any other projectId → look up the brownfield row in
 *     `futurator-party-projects` and derive owner/name from `gitRepoUrl`.
 */

import * as partyProjectsRepo from '../repositories/party-projects-repository';

export interface ResolvedRepo {
  owner: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
}

export const FUTURATOR_ADMIN_OWNER = 'futurator-repos';
export const FUTURATOR_ADMIN_REPO_NAME = 'futurator-admin';

/**
 * Parse `owner/name` out of an HTTPS GitHub URL.
 * Accepts both `https://github.com/foo/bar` and `https://github.com/foo/bar.git`.
 */
export function parseOwnerName(repoUrl: string): { owner: string; name: string } | null {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/**
 * Resolve. Throws when the project row is missing/malformed — the caller
 * maps that to a 400 PROJECT_REPO_NOT_RESOLVED at the API layer.
 */
export async function resolveRepo(projectId: string): Promise<ResolvedRepo> {
  if (projectId === 'futurator-admin') {
    return {
      owner: FUTURATOR_ADMIN_OWNER,
      name: FUTURATOR_ADMIN_REPO_NAME,
      repoUrl: `https://github.com/${FUTURATOR_ADMIN_OWNER}/${FUTURATOR_ADMIN_REPO_NAME}.git`,
      defaultBranch: 'main',
    };
  }
  const project = await partyProjectsRepo.getProject(projectId);
  if (!project) {
    throw new Error(`PROJECT_NOT_FOUND: ${projectId}`);
  }
  if (!project.gitRepoUrl) {
    throw new Error(`PROJECT_NO_REPO_URL: ${projectId}`);
  }
  const parsed = parseOwnerName(project.gitRepoUrl);
  if (!parsed) {
    throw new Error(`PROJECT_BAD_REPO_URL: ${projectId} → "${project.gitRepoUrl}"`);
  }
  return {
    owner: parsed.owner,
    name: parsed.name,
    repoUrl: project.gitRepoUrl,
    defaultBranch: project.gitBranch || 'main',
  };
}
