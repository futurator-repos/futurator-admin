/**
 * AWS helpers for migrate-brownfield.mjs.
 *
 * Scope: Secrets Manager (ensureSecret) + the IAM-policy hint string.
 *
 * IAM is intentionally NOT automated — the runner prints the exact
 * `aws iam put-role-policy` command for the operator to execute manually.
 * Rationale: avoids requiring IAM-write perms on the operator's AWS
 * profile, avoids adding the `@aws-sdk/client-iam` dependency to the
 * admin app, and removes any "auto-escalating privilege" surprise.
 *
 * Tests inject fake clients via the `client` arg; production code calls
 * `createAwsClients()` to build a real `SecretsManagerClient`.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export const POLICY_NAME = 'BrownfieldPartyPatRead';

/**
 * Build the wildcard-suffix ARN used by both Secrets Manager and the
 * IAM policy. Secrets Manager appends a 6-char random suffix to created
 * secrets, so the IAM resource must end in `-*` to match any version.
 */
export function buildSecretArn(region, accountId, secretName) {
  return `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretName}-*`;
}

export function buildPolicyDocument(secretArn) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: secretArn,
      },
    ],
  };
}

/**
 * Render a copy-pasteable `aws iam put-role-policy` invocation that the
 * operator can run to attach the policy to the daemon's EC2 role.
 * The runner prints this and exits non-zero on first run; the operator
 * runs it once, then re-invokes the runner with `--skip-iam-check` or
 * just lets the daemon attempt the clone (which will succeed if the
 * policy is in place).
 */
export function buildPutRolePolicyCommandHint(roleName, secretName, region, accountId) {
  const arn = buildSecretArn(region, accountId, secretName);
  const doc = JSON.stringify(buildPolicyDocument(arn));
  return [
    `aws iam put-role-policy \\`,
    `  --role-name ${roleName} \\`,
    `  --policy-name ${POLICY_NAME} \\`,
    `  --policy-document '${doc}'`,
  ].join('\n');
}

/**
 * Idempotent secret ensurance.
 *
 * @param {object} args
 * @param {string} args.secretName
 * @param {string} args.pat
 * @param {boolean} args.rotate  if true, overwrite an existing secret
 *                                with `pat` via PutSecretValueCommand
 * @param {SecretsManagerClient|object} args.client  AWS SDK client (or fake)
 * @returns {Promise<{ outcome: 'created'|'exists'|'rotated', arn?: string }>}
 */
export async function ensureSecret({ secretName, pat, rotate, client }) {
  try {
    const existing = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (rotate) {
      await client.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: pat }));
      return { outcome: 'rotated', arn: existing.ARN };
    }
    return { outcome: 'exists', arn: existing.ARN };
  } catch (err) {
    const name = err?.name || err?.Code;
    if (name !== 'ResourceNotFoundException') throw err;
    const created = await client.send(
      new CreateSecretCommand({
        Name: secretName,
        Description: 'Fine-grained PAT for brownfield Party projects (contents:read)',
        SecretString: pat,
      }),
    );
    return { outcome: 'created', arn: created.ARN };
  }
}

/**
 * Build the default AWS client(s). Currently just Secrets Manager —
 * IAM is operator-driven via shell hint. Returns an object so future
 * additions don't break the call site.
 */
export function createAwsClients({ region = 'us-east-1' } = {}) {
  return {
    secretsClient: new SecretsManagerClient({ region }),
  };
}
