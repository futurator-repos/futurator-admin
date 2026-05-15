/**
 * oidc-role-naming.ts — Pipeline v2 Phase 2-D / Story 2-D-5-1 (PR-94).
 *
 * Helpers for the GitHub Actions OIDC deploy flow per v2.5 §34. Naming +
 * trust-policy templates the daemon's deploy step + ARCHITECT brownfield
 * audit both consume.
 *
 * Role naming (PR-42 confirmed):
 *   futurator-pipeline-<appSlug>-<env>
 *
 * Trust policy per-env (v2.5 §34.1):
 *   dev        → repo:futurator-repos/<appSlug>:ref:refs/heads/main
 *   staging    → repo:futurator-repos/<appSlug>:ref:refs/tags/<appSlug>-plan-*
 *   production → repo:futurator-repos/<appSlug>:ref:refs/tags/<appSlug>-v*
 *
 * OIDC provider is the standard GitHub Actions one — token.actions
 * .githubusercontent.com.
 */

export type DeployEnv = 'dev' | 'staging' | 'production';

const SLUG_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

function assertSlug(label: string, slug: string) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(
      `oidc-role-naming: ${label} must match slug regex, got ${JSON.stringify(slug)}`,
    );
  }
}

/**
 * Compute the OIDC role name for the given app + env.
 *
 *   futurator-pipeline-<appSlug>-<env>
 *
 * Max length 64 chars (IAM cap); slug is bounded ≤ 40 and prefix +
 * suffix is ≤ 24 so the result is always ≤ 64.
 */
export function oidcRoleName(appSlug: string, env: DeployEnv): string {
  assertSlug('appSlug', appSlug);
  return `futurator-pipeline-${appSlug}-${env}`;
}

/**
 * Compute the GitHub repo-and-ref `sub` constraint for the trust policy
 * per env.
 *
 * @returns the value of the `token.actions.githubusercontent.com:sub`
 *          condition key.
 */
export function oidcTrustSubject(appSlug: string, env: DeployEnv): string {
  assertSlug('appSlug', appSlug);
  const repo = `futurator-repos/${appSlug}`;
  switch (env) {
    case 'dev':
      return `repo:${repo}:ref:refs/heads/main`;
    case 'staging':
      return `repo:${repo}:ref:refs/tags/${appSlug}-plan-*`;
    case 'production':
      return `repo:${repo}:ref:refs/tags/${appSlug}-v*`;
  }
}

/**
 * Build the full IAM trust policy JSON for the OIDC role. The daemon's
 * deploy step writes this verbatim during `cdk bootstrap` /
 * brownfield-audit setup.
 *
 * @param args.accountId AWS account id (12 digits)
 */
export function buildTrustPolicy(args: {
  appSlug: string;
  env: DeployEnv;
  accountId: string;
}): object {
  assertSlug('appSlug', args.appSlug);
  if (!/^\d{12}$/.test(args.accountId)) {
    throw new Error(
      `oidc-role-naming: accountId must be 12 digits, got ${JSON.stringify(args.accountId)}`,
    );
  }
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: `arn:aws:iam::${args.accountId}:oidc-provider/token.actions.githubusercontent.com`,
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': oidcTrustSubject(args.appSlug, args.env),
          },
        },
      },
    ],
  };
}

/**
 * Build the path the per-env deploy workflow lives at in the app repo.
 * v2.5 §34.1 — `.github/workflows/deploy-<env>.yml`.
 */
export function deployWorkflowPath(env: DeployEnv): string {
  return `.github/workflows/deploy-${env}.yml`;
}

/**
 * All three env names. Useful for iterating to provision all OIDC roles
 * at once during brownfield audit (Story 3-F-2).
 */
export const DEPLOY_ENVS: readonly DeployEnv[] = ['dev', 'staging', 'production'] as const;
