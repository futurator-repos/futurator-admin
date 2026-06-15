/**
 * Deployment v2.5 — the deploy pipeline + job builders.
 *
 * Extracted from the inline pipeline that used to live in the
 * `POST /api/epic-workflows/:id/deploy` handler so that BOTH the manual
 * deploy endpoint AND the cron auto-trigger (dev deploy on plan→review)
 * construct the exact same agentic job from one source of truth.
 *
 * Everything environment-specific (bucket, key prefix, Vite base path,
 * public URL, CloudFront distribution + invalidation path) comes from a
 * pre-resolved `ResolvedDeployTarget` — this builder is environment-agnostic.
 *
 * See docs/concepts/deployment-v2.5.md §1, §5.
 */

import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import { type ResolvedDeployTarget, releaseArchivePrefix } from './deploy-targets';

/**
 * Build the single-step headless DEPLOY pipeline for `workingDir`, publishing
 * to `target`. The prompt is fully parameterized by the target so a dev build
 * patches Vite `base` to the dev base path and syncs to the dev prefix.
 *
 * `opts.archiveReleaseId` (set for production publishes) snapshots the freshly
 * deployed bundle under `apps/_releases/<slug>/<id>/` so it can be rolled back
 * to later.
 */
export function buildDeployPipeline(
  workingDir: string,
  target: ResolvedDeployTarget,
  opts: { archiveReleaseId?: string } = {},
): PipelineDefinition {
  const { s3Bucket, s3Prefix, basePath, publicUrl, cloudfrontDistributionId, invalidationPath } =
    target;
  const archiveStep = opts.archiveReleaseId
    ? `\n\n4b. Archive this release for rollback: \`aws s3 sync s3://${s3Bucket}/${s3Prefix} s3://${s3Bucket}/${releaseArchivePrefix(target.appName, opts.archiveReleaseId)}\` (copy, no --delete).`
    : '';

  return {
    maxIterations: 1,
    agents: {
      DEPLOY: {
        name: 'DevOps Deploy',
        // Edit + Write are required because vite.config.ts usually needs a
        // base path patch before `npm run build` can produce a correctly-
        // prefixed bundle. Without these the agent halts asking for approval.
        allowedTools: 'Bash,Read,Edit,Write,Glob',
        model: 'haiku',
      },
    },
    steps: [
      {
        id: 'deploy',
        agentId: 'DEPLOY',
        prompt: `You are a headless DevOps automation. You run non-interactively — there is NO human to grant permission. Do not ask for confirmation. Do not suggest commands for a human to run. Use the tools directly.

Goal: build and publish the React/Vite app at ${workingDir} to s3://${s3Bucket}/${s3Prefix} so it is reachable at ${publicUrl}.

Steps (execute in order, each step must succeed before the next):

1. Read ${workingDir}/vite.config.ts (or .js). If it does not contain \`base: '${basePath}'\`, Edit the file to set that exact base inside defineConfig({ ... }) (replace any existing \`base\` entry). Do this BEFORE building — the bundle's asset URLs must be prefixed with ${basePath} or the page will 404 its own JS/CSS.

2. Run the build: \`cd ${workingDir} && npm run build\`. If build fails because of missing deps, run \`npm install\` and retry the build once. Do not proceed past this step unless the build succeeds.

3. Identify the build output directory (Vite defaults to \`dist\`, but check the build log). Confirm it exists with \`ls\`.

4. Sync to S3: \`aws s3 sync <outputDir>/ s3://${s3Bucket}/${s3Prefix} --delete\`${archiveStep}

5. Invalidate CloudFront: \`aws cloudfront create-invalidation --distribution-id ${cloudfrontDistributionId} --paths "${invalidationPath}"\`

When finished, output these three lines EXACTLY — they are machine-parsed:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: success
DEPLOY_DETAILS: <one-sentence summary of what you did>

If ANY step above failed and you cannot recover, instead output:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: failed
DEPLOY_DETAILS: <which step failed and why>

Never end the session without emitting a DEPLOY_STATUS line. Never ask for permission.`,
        extractors: {
          // Tolerant to markdown decoration the agent sometimes applies
          // despite the "plain text" instruction (the dev-server agent did
          // exactly this on 2026-04-21 with `**DEV_SERVER_URL:**`).
          DEPLOY_URL: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_URL[*_`]*:\\s*[*_`]*\\s*(https?://[^\\s*_`]+)',
          },
          DEPLOY_STATUS: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_STATUS[*_`]*:\\s*[*_`]*\\s*(\\w+)',
          },
          DEPLOY_DETAILS: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_DETAILS[*_`]*:\\s*[*_`]*\\s*(.+)',
          },
        },
        validations: [
          { type: 'equals', left: 'DEPLOY_STATUS', right: 'success', label: 'Deploy succeeded' },
        ],
      },
    ],
  };
}

/**
 * Build a complete PENDING deploy `AgentJob` row for the daemon to pick up.
 *
 * `epicId` MUST be set — the daemon's `postDeployWriteback` bails on a missing
 * epicId, which would skip the entire post-deploy chain (Plan/App writebacks
 * and, for production, the merge-to-main delivery). The job carries
 * `deployEnvironment` so the daemon knows whether to advance `main` (only on
 * production) or just record a preview URL (dev/staging).
 */
export function buildDeployJob(params: {
  jobId: string;
  epicId: string;
  workingDir: string;
  createdBy: string;
  nowIso: string;
  target: ResolvedDeployTarget;
  /** When set (production), snapshot the release for rollback. Pass the jobId. */
  archiveReleaseId?: string;
}): AgentJob {
  const { jobId, epicId, workingDir, createdBy, nowIso, target, archiveReleaseId } = params;
  return {
    jobId,
    status: 'PENDING',
    epicId,
    deployEnvironment: target.environment,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy,
    workingDir,
    pipeline: buildDeployPipeline(workingDir, target, { archiveReleaseId }),
  };
}
