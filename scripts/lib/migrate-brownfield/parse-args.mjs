/**
 * CLI / env parser for scripts/migrate-brownfield.mjs.
 *
 * Inputs:
 *   --path <dir>          Local clone of the repo to migrate.
 *                         Env: BROWNFIELD_REPO_PATH
 *   --pat-file <path>     File containing the raw GitHub PAT
 *                         (never accepted as a flag string — would land
 *                         in shell history). The file's first line is
 *                         read and trimmed.
 *   --name <slug>         Project name override; defaults to the repo
 *                         basename from `git remote get-url origin`.
 *   --branch <ref>        Branch to track (default: 'main').
 *   --api <url>           Admin API base URL.
 *                         Env: FUTURATOR_ADMIN_API_URL
 *                         (default: https://admin.futurator.ai/api)
 *   --token <jwt>         Admin Bearer JWT.
 *                         Env: FUTURATOR_ADMIN_TOKEN
 *   --refresh             Skip registration; trigger POST /:id/refresh on
 *                         an already-registered brownfield project.
 *   --rotate-pat          Overwrite the existing Secrets Manager secret
 *                         with the PAT in --pat-file. Default behavior is
 *                         to leave the existing secret alone.
 *   --skip-iam-check      Skip the IAM-permission check in Step 3.
 *                         Use when you've already attached the policy
 *                         out-of-band.
 *   --secret-name <name>  AWS Secrets Manager secret name override
 *                         (default: futurator/labs-brownfield-github-pat).
 *   --help, -h            Print help and exit 0.
 *
 * All inputs are POJO; this module performs no I/O. Each caller passes
 * argv/env explicitly so the tests can drive deterministic snapshots.
 */

import { parseArgs } from 'node:util';

const DEFAULT_API_BASE_URL = 'https://admin.futurator.ai/api';
const DEFAULT_SECRET_NAME = 'futurator/labs-brownfield-github-pat';
const DEFAULT_BRANCH = 'main';

const OPTIONS = {
  path: { type: 'string' },
  'pat-file': { type: 'string' },
  name: { type: 'string' },
  branch: { type: 'string' },
  api: { type: 'string' },
  token: { type: 'string' },
  refresh: { type: 'boolean' },
  'rotate-pat': { type: 'boolean' },
  'skip-iam-check': { type: 'boolean' },
  'secret-name': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export const HELP_TEXT = `migrate-brownfield — register an existing private GitHub repo as a Futurator brownfield Party project.

USAGE
  node scripts/migrate-brownfield.mjs --path <local-clone> --pat-file <file> [options]

REQUIRED
  --path <dir>          Local clone of the repo to migrate (must be a git repo
                        with BMAD installed). Env: BROWNFIELD_REPO_PATH
  --pat-file <path>     File whose first line is the fine-grained GitHub PAT.
                        Required unless --refresh is set on an already-registered
                        project.

OPTIONS
  --name <slug>         Project name override. Default: derived from origin remote.
  --branch <ref>        Branch to track. Default: 'main'.
  --api <url>           Admin API base URL. Env: FUTURATOR_ADMIN_API_URL
                        (default: ${DEFAULT_API_BASE_URL})
  --token <jwt>         Admin Bearer JWT. Env: FUTURATOR_ADMIN_TOKEN
  --refresh             Trigger POST /:id/refresh instead of re-registering.
  --rotate-pat          Overwrite existing Secrets Manager secret with --pat-file.
  --skip-iam-check      Skip the EC2-daemon-role IAM permission check.
  --secret-name <name>  Override the Secrets Manager secret name.
                        Default: ${DEFAULT_SECRET_NAME}
  --help, -h            Print this help and exit.

EXAMPLES
  # First-time migration of applicator:
  node scripts/migrate-brownfield.mjs --path ~/code/applicator --pat-file ~/.brownfield-pat

  # Re-fetch updates after pushing from laptop:
  node scripts/migrate-brownfield.mjs --path ~/code/applicator --refresh

  # Rotate the PAT and re-migrate:
  node scripts/migrate-brownfield.mjs --path ~/code/applicator --pat-file ~/.new-pat --rotate-pat
`;

/**
 * Parse argv + env into a typed input object. Pure function — no I/O.
 * @param {string[]} argv  process.argv.slice(2)
 * @param {Record<string,string|undefined>} env  process.env subset
 * @returns {{
 *   path: string|null,
 *   patFile: string|null,
 *   name: string|null,
 *   branch: string|null,
 *   apiBaseUrl: string,
 *   token: string|null,
 *   refresh: boolean,
 *   rotatePat: boolean,
 *   skipIamCheck: boolean,
 *   secretName: string,
 *   help: boolean,
 * }}
 */
export function parseRunnerArgs(argv = [], env = {}) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  return {
    path: values.path || env.BROWNFIELD_REPO_PATH || null,
    patFile: values['pat-file'] || null,
    name: values.name || null,
    branch: values.branch || null,
    apiBaseUrl: values.api || env.FUTURATOR_ADMIN_API_URL || DEFAULT_API_BASE_URL,
    token: values.token || env.FUTURATOR_ADMIN_TOKEN || null,
    refresh: values.refresh === true,
    rotatePat: values['rotate-pat'] === true,
    skipIamCheck: values['skip-iam-check'] === true,
    secretName: values['secret-name'] || DEFAULT_SECRET_NAME,
    help: values.help === true,
  };
}

export const DEFAULTS = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  secretName: DEFAULT_SECRET_NAME,
  branch: DEFAULT_BRANCH,
};
