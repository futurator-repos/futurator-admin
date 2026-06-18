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
  // Next.js `basePath` must NOT have a trailing slash (and never be '/'); Vite
  // `base` keeps the trailing slash. Compute the Next.js form once (A2).
  const basePathNoSlash = basePath.replace(/\/$/, '');
  const archiveStep = opts.archiveReleaseId
    ? `\n\n4b. Archive this release for rollback: \`aws s3 sync s3://${s3Bucket}/${s3Prefix} s3://${s3Bucket}/${releaseArchivePrefix(target.appName, opts.archiveReleaseId)}\` (copy, no --delete).`
    : '';

  return {
    maxIterations: 1,
    agents: {
      DEPLOY: {
        name: 'DevOps Deploy',
        // Edit + Write are required because the framework config (next.config
        // or vite.config) usually needs a base-path patch before the build can
        // produce a correctly-prefixed bundle. Without these the agent halts
        // asking for approval.
        allowedTools: 'Bash,Read,Edit,Write,Glob',
        model: 'haiku',
      },
    },
    steps: [
      {
        id: 'deploy',
        agentId: 'DEPLOY',
        prompt: `You are a headless DevOps automation. You run non-interactively — there is NO human to grant permission. Do not ask for confirmation. Do not suggest commands for a human to run. Use the tools directly.

Goal: build and publish the web app at ${workingDir} to s3://${s3Bucket}/${s3Prefix} so it is reachable at ${publicUrl}.

Steps (execute in order, each step must succeed before the next):

1. Detect the framework and patch its config so the bundle is served correctly under its base path. Do this BEFORE building — the bundle's asset URLs must be prefixed correctly or the page will 404 its own JS/CSS.
   - If \`${workingDir}/next.config.ts\`, \`.js\`, or \`.mjs\` exists -> NEXT.JS. Edit next.config to ensure: \`output: 'export'\`, \`basePath: '${basePathNoSlash}'\` (NO trailing slash; use an empty string \`''\` if that value is empty — never \`'/'\`), and \`images: { unoptimized: true }\` (required, or \`output: 'export'\` fails the build). Add any of these that are missing; replace any existing \`basePath\`. The build output dir is \`out/\`.
   - Else if \`${workingDir}/vite.config.ts\` or \`.js\` exists -> VITE. Edit vite.config to set \`base: '${basePath}'\` (WITH trailing slash) inside defineConfig({ ... }), replacing any existing \`base\`. The build output dir is \`dist/\`.
   - Else inspect ${workingDir}/package.json: read the \`build\` script to infer the framework and its output dir (commonly \`out\`, \`dist\`, or \`build\`). Patch the relevant config so assets are prefixed with ${basePathNoSlash} (path-style frameworks) or ${basePath} (slash-style).

2. Run the build: \`cd ${workingDir} && npm run build\`. If build fails because of missing deps, run \`npm install\` and retry the build once. Do not proceed past this step unless the build succeeds.

3. Identify the build output directory (\`out/\` for Next.js, \`dist/\` for Vite, otherwise per the package.json build log). Confirm it exists with \`ls\`. Call it <outputDir>.

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
            // `_` removed from the excluded class so fallback URLs like
            // `https://futurator.ai/apps/_dev/brick1/` extract fully (A1).
            // Trailing markdown `*`/backtick stay excluded.
            pattern: '[*_`]*DEPLOY_URL[*_`]*:[\\s*_`]*(https?://[^\\s*`]+)',
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
