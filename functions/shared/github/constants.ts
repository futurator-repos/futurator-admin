/**
 * GitHub identity constants for Pipeline v2.
 *
 * GITHUB_OWNER is the user account (or org) that hosts every pipeline-managed
 * repo. Today: `futurator-repos` (a personal user account, not an org).
 * If this changes (e.g. migration to an Organization-type account), update
 * here only — every consumer reads from this constant.
 */

export const GITHUB_OWNER = 'futurator-repos';

/**
 * `true` if GITHUB_OWNER is an Organization, `false` if a User account.
 * Some GitHub API endpoints differ (e.g. `/orgs/{org}/repos` vs `/user/repos`).
 * The connector branches on this where necessary.
 */
export const GITHUB_OWNER_IS_ORG = false;
