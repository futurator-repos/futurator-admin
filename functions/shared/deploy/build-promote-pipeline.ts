/**
 * Deployment v2.5 — promotion + rollback pipeline builders.
 *
 * Promotion moves an already-built artifact UP the ladder
 * (dev → staging → production) per the build-once-promote-many principle.
 * Two modes, chosen automatically from the resolved targets:
 *
 *   • COPY mode  (src.basePath === dst.basePath, i.e. both provisioned on
 *     their own subdomain buckets): a pure `aws s3 sync` of the SAME bytes
 *     from source bucket to destination bucket. This is true build-once —
 *     what you tested on dev is byte-identical on staging/prod.
 *
 *   • REBUILD mode (base paths differ, i.e. fallback shared-bucket prefixes):
 *     re-`npm run build` at the destination base path, then sync. Used until
 *     the subdomain infra is provisioned. Functionally promotes, but the
 *     destination bundle is a fresh build (not byte-identical).
 *
 * Promote/rollback jobs reuse the DEPLOY_URL / DEPLOY_STATUS contract, and
 * carry `deployEnvironment = <destination>`, so the daemon's existing
 * `postDeployWriteback` handles the writeback (staging → record stagingUrl;
 * production → record deployUrl + advance main). Rollback sets
 * `skipTrunkAdvance` so restoring old hosting never moves the trunk.
 *
 * See docs/concepts/deployment-v2.5.md §5.
 */

import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import {
  type DeployEnvironment,
  type ResolvedDeployTarget,
  releaseArchivePrefix,
} from './deploy-targets';

const DEPLOY_EXTRACTORS = {
  // Tolerant to markdown decoration the agent sometimes applies.
  DEPLOY_URL: {
    type: 'regex' as const,
    // `_` removed from the excluded class so fallback URLs like
    // `https://futurator.ai/apps/_dev/brick1/` extract fully (A1).
    // Trailing markdown `*`/backtick stay excluded.
    pattern: '[*_`]*DEPLOY_URL[*_`]*:[\\s*_`]*(https?://[^\\s*`]+)',
  },
  DEPLOY_STATUS: {
    type: 'regex' as const,
    pattern: '[*_`]*DEPLOY_STATUS[*_`]*:\\s*[*_`]*\\s*(\\w+)',
  },
  DEPLOY_DETAILS: {
    type: 'regex' as const,
    pattern: '[*_`]*DEPLOY_DETAILS[*_`]*:\\s*[*_`]*\\s*(.+)',
  },
  // Advisory — the smoke check never hard-fails the job (operator decides).
  SMOKE_STATUS: {
    type: 'regex' as const,
    pattern: '[*_`]*SMOKE_STATUS[*_`]*:\\s*[*_`]*\\s*(\\w+)',
  },
};

const DEPLOY_AGENT = {
  name: 'DevOps Deploy',
  allowedTools: 'Bash,Read,Edit,Write,Glob',
  model: 'haiku' as const,
};

/** Smoke-test instruction fragment — curl the live URL, assert it's a real page. */
function smokeFragment(stepNo: number, publicUrl: string): string {
  return `${stepNo}. Smoke test the live URL: \`curl -sS -m 30 -o /tmp/smoke.html -w "%{http_code}" ${publicUrl}\`. The HTTP code MUST be 200 and /tmp/smoke.html MUST contain \`<div id="root"\` or a \`<script\` tag (a real SPA shell, not an S3/CloudFront error or the homepage fallthrough). If both hold, the smoke passed; otherwise it failed.`;
}

/** Archive instruction fragment — snapshot the now-live bundle for rollback. */
function archiveFragment(
  stepNo: number,
  bucket: string,
  livePrefix: string,
  archivePrefix: string,
): string {
  return `${stepNo}. Archive this release for rollback: \`aws s3 sync s3://${bucket}/${livePrefix} s3://${bucket}/${archivePrefix}\` (copy, no --delete).`;
}

/**
 * Build the promote pipeline. `src` is the environment we copy/rebuild FROM,
 * `dst` is where we publish TO. `archiveReleaseId` (set for production)
 * snapshots the release under `apps/_releases/<slug>/<id>/` for rollback.
 */
export function buildPromotePipeline(
  workingDir: string,
  src: ResolvedDeployTarget,
  dst: ResolvedDeployTarget,
  opts: { smoke: boolean; archiveReleaseId?: string },
): PipelineDefinition {
  const copyMode = src.basePath === dst.basePath;
  // Next.js `basePath` form (no trailing slash, never '/') for the rebuild
  // branch; Vite keeps `dst.basePath` as-is (A2).
  const dstBasePathNoSlash = dst.basePath.replace(/\/$/, '');
  const archivePrefix = opts.archiveReleaseId
    ? releaseArchivePrefix(dst.appName, opts.archiveReleaseId)
    : undefined;

  // Assemble the numbered steps for whichever mode we're in.
  const lines: string[] = [];
  let n = 1;
  if (copyMode) {
    lines.push(
      `${n++}. Copy the built bundle (NO rebuild — this is build-once promotion): \`aws s3 sync s3://${src.s3Bucket}/${src.s3Prefix} s3://${dst.s3Bucket}/${dst.s3Prefix} --delete\``,
    );
  } else {
    lines.push(
      `${n++}. Detect the framework and patch its config to the DESTINATION base path (source and destination differ, so this promotion REBUILDS at the destination base):\n   - If \`${workingDir}/next.config.ts\`, \`.js\`, or \`.mjs\` exists -> NEXT.JS. Ensure next.config has \`output: 'export'\`, \`basePath: '${dstBasePathNoSlash}'\` (NO trailing slash; empty string \`''\` if that value is empty — never \`'/'\`), and \`images: { unoptimized: true }\` (required for static export). Replace any existing \`basePath\`. Build output dir is \`out/\`.\n   - Else if \`${workingDir}/vite.config.ts\` or \`.js\` exists -> VITE. Set \`base: '${dst.basePath}'\` (WITH trailing slash), replacing any existing base. Build output dir is \`dist/\`.\n   - Else inspect package.json build script and infer the output dir (\`out\`, \`dist\`, or \`build\`).`,
    );
    lines.push(
      `${n++}. Build: \`cd ${workingDir} && npm run build\`. If it fails on missing deps, run \`npm install\` and retry once. Identify the output dir (\`out/\` for Next.js, \`dist/\` for Vite, else per the build log). Call it <outputDir>.`,
    );
    lines.push(
      `${n++}. Sync to the destination: \`aws s3 sync <outputDir>/ s3://${dst.s3Bucket}/${dst.s3Prefix} --delete\``,
    );
  }
  if (archivePrefix) lines.push(archiveFragment(n++, dst.s3Bucket, dst.s3Prefix, archivePrefix));
  lines.push(
    `${n++}. Invalidate CloudFront: \`aws cloudfront create-invalidation --distribution-id ${dst.cloudfrontDistributionId} --paths "${dst.invalidationPath}"\``,
  );
  if (opts.smoke) lines.push(smokeFragment(n++, dst.publicUrl));

  const smokeLine = opts.smoke ? `\nSMOKE_STATUS: <pass|fail>` : '';

  return {
    maxIterations: 1,
    agents: { DEPLOY: DEPLOY_AGENT },
    steps: [
      {
        id: 'promote',
        agentId: 'DEPLOY',
        prompt: `You are a headless DevOps automation. You run non-interactively — there is NO human to grant permission. Do not ask for confirmation. Use the tools directly.

Goal: promote the ${src.environment} build of the app at ${workingDir} to ${dst.environment}, published at ${dst.publicUrl}. ${copyMode ? 'Source and destination share a base path, so promote by COPYING the already-built bytes — do NOT rebuild.' : 'Source and destination differ in base path, so REBUILD at the destination base before syncing.'}

Steps (execute in order, each must succeed before the next):

${lines.join('\n\n')}

When finished, output these lines EXACTLY — they are machine-parsed:

DEPLOY_URL: ${dst.publicUrl}
DEPLOY_STATUS: success
DEPLOY_DETAILS: <one-sentence summary>${smokeLine}

If a required step (copy/build/sync/invalidate) failed and you cannot recover, output DEPLOY_STATUS: failed with DEPLOY_DETAILS naming the failed step. A failed SMOKE_STATUS does NOT make the deploy failed — still emit DEPLOY_STATUS: success and report SMOKE_STATUS: fail so the operator can decide.

Never end the session without a DEPLOY_STATUS line. Never ask for permission.`,
        extractors: DEPLOY_EXTRACTORS,
        validations: [
          { type: 'equals', left: 'DEPLOY_STATUS', right: 'success', label: 'Promotion succeeded' },
        ],
      },
    ],
  };
}

/** Build the rollback pipeline — restore a previously-archived production release. */
export function buildRollbackPipeline(
  prod: ResolvedDeployTarget,
  releaseId: string,
): PipelineDefinition {
  const archivePrefix = releaseArchivePrefix(prod.appName, releaseId);
  return {
    maxIterations: 1,
    agents: { DEPLOY: DEPLOY_AGENT },
    steps: [
      {
        id: 'rollback',
        agentId: 'DEPLOY',
        prompt: `You are a headless DevOps automation. You run non-interactively. Use the tools directly; never ask for permission.

Goal: roll PRODUCTION back to the archived release ${releaseId}, restoring it at ${prod.publicUrl}.

Steps (in order):

1. Restore the archived bundle over the live one: \`aws s3 sync s3://${prod.s3Bucket}/${archivePrefix} s3://${prod.s3Bucket}/${prod.s3Prefix} --delete\`. If the archive prefix is empty/missing, output DEPLOY_STATUS: failed and stop.

2. Invalidate CloudFront: \`aws cloudfront create-invalidation --distribution-id ${prod.cloudfrontDistributionId} --paths "${prod.invalidationPath}"\`

3. ${smokeFragment(3, prod.publicUrl).slice(3)}

When finished, output EXACTLY:

DEPLOY_URL: ${prod.publicUrl}
DEPLOY_STATUS: success
DEPLOY_DETAILS: rolled back to ${releaseId}
SMOKE_STATUS: <pass|fail>

On unrecoverable failure output DEPLOY_STATUS: failed with the reason. Never end without a DEPLOY_STATUS line.`,
        extractors: DEPLOY_EXTRACTORS,
        validations: [
          { type: 'equals', left: 'DEPLOY_STATUS', right: 'success', label: 'Rollback succeeded' },
        ],
      },
    ],
  };
}

/** Build a PENDING promote AgentJob row. `deployEnvironment` = destination. */
export function buildPromoteJob(params: {
  jobId: string;
  epicId: string;
  workingDir: string;
  createdBy: string;
  nowIso: string;
  src: ResolvedDeployTarget;
  dst: ResolvedDeployTarget;
  smoke: boolean;
  archiveReleaseId?: string;
}): AgentJob {
  const { jobId, epicId, workingDir, createdBy, nowIso, src, dst, smoke, archiveReleaseId } =
    params;
  return {
    jobId,
    status: 'PENDING',
    epicId,
    deployEnvironment: dst.environment,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy,
    workingDir,
    pipeline: buildPromotePipeline(workingDir, src, dst, { smoke, archiveReleaseId }),
  };
}

/** Build a PENDING rollback AgentJob row. Restores hosting WITHOUT advancing main. */
export function buildRollbackJob(params: {
  jobId: string;
  epicId: string;
  workingDir: string;
  createdBy: string;
  nowIso: string;
  prod: ResolvedDeployTarget;
  releaseId: string;
}): AgentJob {
  const { jobId, epicId, workingDir, createdBy, nowIso, prod, releaseId } = params;
  return {
    jobId,
    status: 'PENDING',
    epicId,
    deployEnvironment: 'production' as DeployEnvironment,
    // Rollback restores prior hosting; it must NOT fast-forward main.
    skipTrunkAdvance: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy,
    workingDir,
    pipeline: buildRollbackPipeline(prod, releaseId),
  };
}
