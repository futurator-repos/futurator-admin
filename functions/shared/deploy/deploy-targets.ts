/**
 * Deployment v2.5 — environment target resolution.
 *
 * The single seam that maps a (appName, environment) pair to *where* its
 * built bundle is hosted: S3 bucket + key prefix, Vite base path, public URL,
 * and the CloudFront distribution to invalidate.
 *
 * ── Two hosting modes ────────────────────────────────────────────────
 *
 * 1. SUBDOMAIN mode (the target design — build-once promotion). When the
 *    per-environment buckets + distributions are provisioned (their coords
 *    are surfaced to the Lambda via env vars), every environment hosts apps
 *    under the SAME base path `/apps/<slug>/` on its OWN bucket+domain:
 *
 *      production → futurator-ai-website         → https://futurator.ai/apps/<slug>/
 *      dev        → $DEV_ENV_BUCKET              → https://dev.futurator.ai/apps/<slug>/
 *      staging    → $STAGING_ENV_BUCKET          → https://staging.futurator.ai/apps/<slug>/
 *
 *    Identical base path across envs is what makes a build promotable as a
 *    pure S3 copy — the bytes built for dev are byte-identical to prod.
 *
 * 2. FALLBACK mode (before the subdomain infra is deployed — ZERO new infra).
 *    dev/staging share the existing public bucket under RESERVED prefixes:
 *
 *      dev        → apps/_dev/<slug>/     → https://futurator.ai/apps/_dev/<slug>/
 *      staging    → apps/_staging/<slug>/ → https://futurator.ai/apps/_staging/<slug>/
 *
 *    `_dev`/`_staging` are SAFE reservations: app slugs are kebab-case
 *    `[a-z0-9-]` and cannot begin with an underscore, so they never collide
 *    with a real app folder. In this mode each env has a DIFFERENT base path,
 *    so promotion rebuilds at the destination instead of copying (see
 *    build-promote-pipeline.ts). The dev preview (Phase 1) works unchanged.
 *
 * Provision the subdomain infra by following the SST appendix in
 * docs/concepts/deployment-v2.5.md, then `sst deploy`. deploy-targets picks
 * up the env vars automatically and upgrades dev/staging to copy-promotion.
 */

export type DeployEnvironment = 'dev' | 'staging' | 'production';

export const DEPLOY_ENVIRONMENTS: readonly DeployEnvironment[] = ['dev', 'staging', 'production'];

export function isDeployEnvironment(v: unknown): v is DeployEnvironment {
  return v === 'dev' || v === 'staging' || v === 'production';
}

/**
 * The environment an app is promoted FROM to reach `to`. The promotion ladder
 * is dev → staging → production, so a build-once artifact only ever moves one
 * rung up. `dev` has no source (it's where the single build lands).
 */
export function sourceEnvironmentFor(to: DeployEnvironment): DeployEnvironment | null {
  if (to === 'staging') return 'dev';
  if (to === 'production') return 'staging';
  return null;
}

/** A fully-resolved place to publish/copy a build for one environment. */
export interface ResolvedDeployTarget {
  environment: DeployEnvironment;
  /** Working-dir leaf; doubles as the URL segment and the deploy slug. */
  appName: string;
  s3Bucket: string;
  /** Trailing-slash S3 key prefix, e.g. `apps/dino1/` or `apps/_dev/dino1/`. */
  s3Prefix: string;
  /** Vite `base` value, e.g. `/apps/dino1/` (always `/` + s3Prefix). */
  basePath: string;
  /** Public URL the environment is reachable at. */
  publicUrl: string;
  cloudfrontDistributionId: string;
  /** CloudFront invalidation path, e.g. `/apps/dino1/*`. */
  invalidationPath: string;
  /**
   * True when this environment runs on its own provisioned bucket+distribution
   * (subdomain mode). When false (fallback prefix mode) build-once copy
   * promotion is unavailable for this env — promotion rebuilds instead.
   */
  provisioned: boolean;
}

interface EnvHosting {
  bucket: string;
  cloudfrontDistributionId: string;
  /** URL origin without trailing slash, e.g. `https://futurator.ai`. */
  origin: string;
  /** Key prefix BEFORE the slug, trailing slash, e.g. `apps/` or `apps/_dev/`. */
  pathPrefix: string;
  provisioned: boolean;
}

// Public homepage bucket + distribution (externally managed — see CLAUDE.md
// deploy-safety section). We only ever write the scoped `apps/*` prefix here.
const PUBLIC_BUCKET = 'futurator-ai-website';
const PUBLIC_CF_DISTRIBUTION_ID = 'E1BI1YWMTLSDTE';
const PUBLIC_ORIGIN = 'https://futurator.ai';

/**
 * Resolve per-environment hosting. Read from env vars at CALL time (not module
 * load) so the same code degrades gracefully: with the subdomain coords set it
 * uses them; without, it falls back to shared-bucket prefixes.
 */
function envHosting(): Record<DeployEnvironment, EnvHosting> {
  const devBucket = process.env.DEV_ENV_BUCKET;
  const devCf = process.env.DEV_ENV_CF_ID;
  const stagingBucket = process.env.STAGING_ENV_BUCKET;
  const stagingCf = process.env.STAGING_ENV_CF_ID;

  return {
    production: {
      bucket: PUBLIC_BUCKET,
      cloudfrontDistributionId: PUBLIC_CF_DISTRIBUTION_ID,
      origin: PUBLIC_ORIGIN,
      pathPrefix: 'apps/',
      provisioned: true,
    },
    dev:
      devBucket && devCf
        ? {
            bucket: devBucket,
            cloudfrontDistributionId: devCf,
            origin: 'https://dev.futurator.ai',
            pathPrefix: 'apps/',
            provisioned: true,
          }
        : {
            bucket: PUBLIC_BUCKET,
            cloudfrontDistributionId: PUBLIC_CF_DISTRIBUTION_ID,
            origin: PUBLIC_ORIGIN,
            pathPrefix: 'apps/_dev/',
            provisioned: false,
          },
    staging:
      stagingBucket && stagingCf
        ? {
            bucket: stagingBucket,
            cloudfrontDistributionId: stagingCf,
            origin: 'https://staging.futurator.ai',
            pathPrefix: 'apps/',
            provisioned: true,
          }
        : {
            bucket: PUBLIC_BUCKET,
            cloudfrontDistributionId: PUBLIC_CF_DISTRIBUTION_ID,
            origin: PUBLIC_ORIGIN,
            pathPrefix: 'apps/_staging/',
            provisioned: false,
          },
  };
}

/**
 * Resolve where to publish `appName` for `environment`. `appName` should be
 * the working-dir leaf (the same slug the deploy agent has always used:
 * `epic.workingDir.split('/').pop()`).
 */
export function resolveDeployTarget(
  appName: string,
  environment: DeployEnvironment,
): ResolvedDeployTarget {
  const h = envHosting()[environment];
  const s3Prefix = `${h.pathPrefix}${appName}/`;
  const basePath = `/${s3Prefix}`;
  return {
    environment,
    appName,
    s3Bucket: h.bucket,
    s3Prefix,
    basePath,
    publicUrl: `${h.origin}${basePath}`,
    cloudfrontDistributionId: h.cloudfrontDistributionId,
    invalidationPath: `${basePath}*`,
    provisioned: h.provisioned,
  };
}

/** S3 key prefix where a production release snapshot is archived for rollback. */
export function releaseArchivePrefix(appName: string, releaseId: string): string {
  return `apps/_releases/${appName}/${releaseId}/`;
}
