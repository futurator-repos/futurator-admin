import { describe, it, expect, afterEach } from 'vitest';
import { resolveDeployTarget, sourceEnvironmentFor } from '../deploy-targets';
import { buildPromotePipeline, buildPromoteJob, buildRollbackJob } from '../build-promote-pipeline';
import { buildDeployPipeline } from '../build-deploy-pipeline';

function promptOf(pipeline: ReturnType<typeof buildPromotePipeline>): string {
  return pipeline.steps[0].prompt ?? '';
}

function deployUrlPattern(pipeline: ReturnType<typeof buildPromotePipeline>): string {
  const extractors = pipeline.steps[0].extractors as
    | { DEPLOY_URL?: { pattern: string } }
    | undefined;
  return extractors?.DEPLOY_URL?.pattern ?? '';
}

describe('DEPLOY_URL extraction (A1 — underscore allowed)', () => {
  // The daemon compiles `new RegExp(pattern, 's')` (dotall). Mirror that here.
  const dev = resolveDeployTarget('brick1', 'dev');
  const staging = resolveDeployTarget('brick1', 'staging');
  const re = (): RegExp =>
    new RegExp(
      deployUrlPattern(buildPromotePipeline('/w/brick1', dev, staging, { smoke: true })),
      's',
    );

  it('extracts a full _dev URL with the underscore intact', () => {
    const m = re().exec('DEPLOY_URL: https://futurator.ai/apps/_dev/brick1/');
    expect(m?.[1]).toBe('https://futurator.ai/apps/_dev/brick1/');
  });

  it('extracts a full _staging URL with the underscore intact', () => {
    const m = re().exec('DEPLOY_URL: https://futurator.ai/apps/_staging/brick1/');
    expect(m?.[1]).toBe('https://futurator.ai/apps/_staging/brick1/');
  });

  it('still extracts a production no-underscore URL fully', () => {
    const m = re().exec('DEPLOY_URL: https://futurator.ai/apps/brick1/');
    expect(m?.[1]).toBe('https://futurator.ai/apps/brick1/');
  });

  it('handles markdown decoration and excludes a trailing backtick', () => {
    const m = re().exec('**DEPLOY_URL:** `https://futurator.ai/apps/_dev/brick1/`');
    expect(m?.[1]).toBe('https://futurator.ai/apps/_dev/brick1/');
  });

  it('the deploy builder copy is proven too (dev target, underscore extracts fully)', () => {
    const dev = resolveDeployTarget('brick1', 'dev'); // fallback: apps/_dev/brick1/
    const pattern =
      buildDeployPipeline('/w/brick1', dev).steps[0].extractors?.DEPLOY_URL?.pattern ?? '';
    const m = new RegExp(pattern, 's').exec('DEPLOY_URL: https://futurator.ai/apps/_dev/brick1/');
    expect(m?.[1]).toBe('https://futurator.ai/apps/_dev/brick1/');
  });
});

describe('framework-aware prompts (A2)', () => {
  it('rebuild-mode prompt is Next.js-aware (next.config, output: export, basePath no trailing slash, out/) and Vite fallback (dist/)', () => {
    const dev = resolveDeployTarget('dino1', 'dev'); // fallback: apps/_dev/
    const staging = resolveDeployTarget('dino1', 'staging'); // fallback: apps/_staging/
    expect(dev.basePath).not.toBe(staging.basePath);
    const prompt = promptOf(buildPromotePipeline('/w/dino1', dev, staging, { smoke: true }));
    expect(prompt).toContain('next.config');
    expect(prompt).toContain("output: 'export'");
    // staging basePath /apps/_staging/dino1/ -> no trailing slash
    expect(prompt).toContain("basePath: '/apps/_staging/dino1'");
    expect(prompt).toContain('out/');
    expect(prompt).toContain('dist/');
  });

  it('copy-mode prompt still says do NOT rebuild and has a single sync', () => {
    process.env.DEPLOY_ENV_SUBDOMAINS = 'on';
    process.env.DEV_ENV_BUCKET = 'futurator-admin-dev-env';
    process.env.DEV_ENV_CF_ID = 'DEVCF';
    process.env.STAGING_ENV_BUCKET = 'futurator-admin-staging-env';
    process.env.STAGING_ENV_CF_ID = 'STGCF';
    const dev = resolveDeployTarget('dino1', 'dev');
    const staging = resolveDeployTarget('dino1', 'staging');
    const prompt = promptOf(buildPromotePipeline('/w/dino1', dev, staging, { smoke: true }));
    expect(prompt).not.toContain('npm run build');
    expect(prompt).toContain('NO rebuild');
    const syncCount = (prompt.match(/aws s3 sync/g) ?? []).length;
    expect(syncCount).toBe(1);
    delete process.env.DEPLOY_ENV_SUBDOMAINS;
    delete process.env.DEV_ENV_BUCKET;
    delete process.env.DEV_ENV_CF_ID;
    delete process.env.STAGING_ENV_BUCKET;
    delete process.env.STAGING_ENV_CF_ID;
  });
});

describe('sourceEnvironmentFor', () => {
  it('maps the promotion ladder dev → staging → production', () => {
    expect(sourceEnvironmentFor('staging')).toBe('dev');
    expect(sourceEnvironmentFor('production')).toBe('staging');
    expect(sourceEnvironmentFor('dev')).toBeNull();
  });
});

describe('buildPromotePipeline mode selection', () => {
  it('REBUILDS when base paths differ (fallback prefixes — dev /apps/_dev/ vs staging /apps/_staging/)', () => {
    const dev = resolveDeployTarget('dino1', 'dev'); // fallback: apps/_dev/
    const staging = resolveDeployTarget('dino1', 'staging'); // fallback: apps/_staging/
    expect(dev.basePath).not.toBe(staging.basePath);
    const prompt = promptOf(buildPromotePipeline('/w/dino1', dev, staging, { smoke: true }));
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('REBUILD');
  });

  it('COPIES (build-once) when base paths match — provisioned subdomain buckets', () => {
    process.env.DEPLOY_ENV_SUBDOMAINS = 'on';
    process.env.DEV_ENV_BUCKET = 'futurator-admin-dev-env';
    process.env.DEV_ENV_CF_ID = 'DEVCF';
    process.env.STAGING_ENV_BUCKET = 'futurator-admin-staging-env';
    process.env.STAGING_ENV_CF_ID = 'STGCF';
    const dev = resolveDeployTarget('dino1', 'dev');
    const staging = resolveDeployTarget('dino1', 'staging');
    expect(dev.basePath).toBe('/apps/dino1/');
    expect(staging.basePath).toBe('/apps/dino1/');
    const prompt = promptOf(buildPromotePipeline('/w/dino1', dev, staging, { smoke: true }));
    expect(prompt).not.toContain('npm run build');
    expect(prompt).toContain('aws s3 sync s3://futurator-admin-dev-env/apps/dino1/');
    expect(prompt).toContain('s3://futurator-admin-staging-env/apps/dino1/');
  });

  it('archives the release on production promotion', () => {
    const staging = resolveDeployTarget('dino1', 'staging');
    const prod = resolveDeployTarget('dino1', 'production');
    const prompt = promptOf(
      buildPromotePipeline('/w/dino1', staging, prod, { smoke: true, archiveReleaseId: 'job-7' }),
    );
    expect(prompt).toContain('apps/_releases/dino1/job-7/');
  });

  afterEach(() => {
    delete process.env.DEPLOY_ENV_SUBDOMAINS;
    delete process.env.DEV_ENV_BUCKET;
    delete process.env.DEV_ENV_CF_ID;
    delete process.env.STAGING_ENV_BUCKET;
    delete process.env.STAGING_ENV_CF_ID;
  });
});

describe('promote/rollback jobs', () => {
  it('promote job carries the DESTINATION as deployEnvironment (so the daemon writeback routes correctly)', () => {
    const job = buildPromoteJob({
      jobId: 'j1',
      epicId: 'E-1',
      workingDir: '/w/dino1',
      createdBy: 'u1',
      nowIso: '2026-06-15T00:00:00Z',
      src: resolveDeployTarget('dino1', 'staging'),
      dst: resolveDeployTarget('dino1', 'production'),
      smoke: true,
      archiveReleaseId: 'j1',
    });
    expect(job.deployEnvironment).toBe('production');
    expect(job.status).toBe('PENDING');
    expect(job.epicId).toBe('E-1');
  });

  it('rollback job is production + skipTrunkAdvance (never moves main)', () => {
    const job = buildRollbackJob({
      jobId: 'r1',
      epicId: 'E-1',
      workingDir: '/w/dino1',
      createdBy: 'u1',
      nowIso: '2026-06-15T00:00:00Z',
      prod: resolveDeployTarget('dino1', 'production'),
      releaseId: 'old-release',
    });
    expect(job.deployEnvironment).toBe('production');
    expect(job.skipTrunkAdvance).toBe(true);
    expect(job.pipeline?.steps[0].prompt).toContain('apps/_releases/dino1/old-release/');
  });
});
