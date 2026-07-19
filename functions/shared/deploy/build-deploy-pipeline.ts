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
  // F29 — the test-harness contract. ONLY the dev artifact is built with
  // `NEXT_PUBLIC_TEST_HARNESS=1`, which makes the scaffold publish the
  // `window.__harness` verifiability seam that headless QA's L2 state probes
  // (assert/force/waitForEvent) read. staging/production build WITHOUT it, so
  // the seam is production-absent by design. Deployment owns injecting the
  // flag; QA owns the seam (registry.ts). dev→staging therefore always REBUILDS
  // (harness ON→OFF, on top of the plan→app base change).
  const harnessEnv = target.environment === 'dev' ? 'NEXT_PUBLIC_TEST_HARNESS=1 ' : '';
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

0. FIRST, before editing ANY file, record the commit you are about to build so QA can pin to it: run \`git -C ${workingDir} rev-parse HEAD\` and remember the 40-character SHA it prints. You will emit it at the end as COMMIT_SHA. Do NOT create any commit yourself at any point — you only edit config, build, and sync.

1. Detect the framework and patch its config so the bundle is served correctly under its base path. Do this BEFORE building — the bundle's asset URLs must be prefixed correctly or the page will 404 its own JS/CSS.
   - If \`${workingDir}/next.config.ts\`, \`.js\`, or \`.mjs\` exists -> NEXT.JS. Edit next.config to ensure: \`output: 'export'\`, \`basePath: '${basePathNoSlash}'\` (NO trailing slash; use an empty string \`''\` if that value is empty — never \`'/'\`), and \`images: { unoptimized: true }\` (required, or \`output: 'export'\` fails the build). Add any of these that are missing; replace any existing \`basePath\`. The build output dir is \`out/\`.
   - Else if \`${workingDir}/vite.config.ts\` or \`.js\` exists -> VITE. Edit vite.config to set \`base: '${basePath}'\` (WITH trailing slash) inside defineConfig({ ... }), replacing any existing \`base\`. The build output dir is \`dist/\`.
   - Else inspect ${workingDir}/package.json: read the \`build\` script to infer the framework and its output dir (commonly \`out\`, \`dist\`, or \`build\`). Patch the relevant config so assets are prefixed with ${basePathNoSlash} (path-style frameworks) or ${basePath} (slash-style).

2. Run the build: \`cd ${workingDir} && ${harnessEnv}npm run build\`.${harnessEnv ? ` The \`${harnessEnv.trim()}\` env prefix is REQUIRED for this (dev) environment — it must be present on every build invocation; do not drop it.` : ''} If build fails because of missing deps, run \`npm install\` and retry the build once with the exact same command. Do not proceed past this step unless the build succeeds.

3. Identify the build output directory (\`out/\` for Next.js, \`dist/\` for Vite, otherwise per the package.json build log). Confirm it exists with \`ls\`. Call it <outputDir>.

4. Sync to S3: \`aws s3 sync <outputDir>/ s3://${s3Bucket}/${s3Prefix} --delete\`${archiveStep}

5. Invalidate CloudFront: \`aws cloudfront create-invalidation --distribution-id ${cloudfrontDistributionId} --paths "${invalidationPath}"\`

6. MANDATORY cleanup — the framework config you edited in step 1 (\`next.config.ts\`/\`.js\`/\`.mjs\` or \`vite.config.ts\`/\`.js\`, whichever exists) is a mutation shared by every future build of this checkout and must NEVER be left committed to disk. Revert it: run \`git -C ${workingDir} checkout -- next.config.ts next.config.js next.config.mjs vite.config.ts vite.config.js 2>/dev/null; true\` (harmless if some of these paths don't exist). Then run \`git -C ${workingDir} status --porcelain\` and inspect its output:
   - If the output is EMPTY, the tree is clean.
   - If the output is NON-EMPTY, the tree is dirty — list the changed paths.
   Do this step even if an earlier step failed, as long as you got past step 1 (i.e. the config was actually edited).

When finished, output these lines EXACTLY — they are machine-parsed:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: success
COMMIT_SHA: <the 40-char SHA you recorded in step 0>
DEPLOY_DETAILS: <one-sentence summary of what you did>
DEPLOY_TREE: clean
(or, if \`git status --porcelain\` was non-empty after the step-6 revert: \`DEPLOY_TREE: dirty <space-separated list of the changed paths>\`)

If ANY step above failed and you cannot recover, instead output:

DEPLOY_URL: ${publicUrl}
DEPLOY_STATUS: failed
COMMIT_SHA: <the 40-char SHA you recorded in step 0, or omit if unknown>
DEPLOY_DETAILS: <which step failed and why>
DEPLOY_TREE: <clean, or dirty <paths>, from step 6 if you reached it — otherwise omit this line>

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
          // QA-Review W2 — the branch-HEAD SHA the dev artifact built from, so
          // QA pins to a frozen commit and Approve promotes exactly that build.
          // Only the EC2 agent can rev-parse; absent line → fail-open (no pin).
          COMMIT_SHA: {
            type: 'regex',
            pattern: '[*_`]*COMMIT_SHA[*_`]*:\\s*[*_`]*([a-f0-9]{40})\\b',
          },
          DEPLOY_DETAILS: {
            type: 'regex',
            pattern: '[*_`]*DEPLOY_DETAILS[*_`]*:\\s*[*_`]*\\s*(.+)',
          },
          // R4 — deploy hygiene. Captures the step-6 cleanup verdict verbatim
          // ('clean' or 'dirty <paths>') so a missing/failed revert of the
          // basePath config mutation (the I13 defect-#9 root cause) is
          // detectable from the job's extracted variables. See treeClean()
          // below to turn this raw string into the writeback boolean.
          DEPLOY_TREE: {
            // Combined char-class (whitespace + markup) in one run, mirroring
            // DEPLOY_URL's tolerant style — a `\s*[*_\`]*\s*` split (like the
            // other extractors below) fails to strip a backtick that wraps
            // the VALUE (e.g. `**DEPLOY_TREE:** \`clean\``), since neither
            // \s* run consumes a backtick.
            type: 'regex',
            pattern: '[*_`]*DEPLOY_TREE[*_`]*:[\\s*_`]*(clean|dirty.*)',
          },
        },
        validations: [
          { type: 'equals', left: 'DEPLOY_STATUS', right: 'success', label: 'Deploy succeeded' },
          // R4 — deploy hygiene, ENFORCED (not prompt-only). Assert the extracted
          // DEPLOY_TREE verdict at the same validation seam DEPLOY_STATUS uses so a
          // dirty tree (the basePath config mutation left uncommitted — the I13
          // defect-#9 root cause) records a FAILED validation + `validation` event
          // instead of passing silently. Fails closed on absence: an omitted
          // DEPLOY_TREE resolves to the literal 'DEPLOY_TREE' != 'clean' → fail,
          // mirroring treeClean()'s never-assume-clean contract.
          {
            type: 'equals',
            left: 'DEPLOY_TREE',
            right: 'clean',
            label: 'Deploy tree clean (basePath config reverted)',
          },
        ],
      },
    ],
  };
}

/**
 * R4 — deploy hygiene. Parse the extracted `DEPLOY_TREE` variable (raw text
 * captured by the extractor above, e.g. `'clean'` or `'dirty next.config.ts'`)
 * into the boolean the job writeback shape wants to surface as `treeClean`.
 *
 * Fail-closed on absence: a job that never reached (or never emitted) the
 * step-6 cleanup is NOT assumed clean — an undefined/empty value parses to
 * `treeClean: false` so the dirty-tree defect (I13) can't silently regress
 * into "assume it was fine".
 *
 * NOTE: the actual job-writeback consumer that stamps this onto the
 * Plan/App record lives in `daemon/agent-daemon.mjs` (`postDeployWriteback`),
 * not in this file — this helper only defines the parsing contract; wiring
 * it into the daemon writeback is out of this slice's file ownership.
 */
export function treeClean(deployTreeVar: string | undefined | null): boolean {
  return typeof deployTreeVar === 'string' && deployTreeVar.trim().toLowerCase() === 'clean';
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
  /** Legacy plans key deploys on an epic; empty string for P3 (plan-keyed). */
  epicId: string;
  workingDir: string;
  createdBy: string;
  nowIso: string;
  target: ResolvedDeployTarget;
  /** When set (production), snapshot the release for rollback. Pass the jobId. */
  archiveReleaseId?: string;
  /**
   * QA-Review W1 — P3 (epic-less) plans stamp `planId` directly so the daemon's
   * postDeployWriteback resolves the plan without an epic hop. Omit for legacy.
   */
  planId?: string;
}): AgentJob {
  const { jobId, epicId, workingDir, createdBy, nowIso, target, archiveReleaseId, planId } = params;
  return {
    jobId,
    status: 'PENDING',
    epicId,
    ...(planId ? { planId } : {}),
    deployEnvironment: target.environment,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy,
    workingDir,
    pipeline: buildDeployPipeline(workingDir, target, { archiveReleaseId }),
  };
}
