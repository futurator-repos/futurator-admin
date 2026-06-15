import { describe, it, expect, afterEach } from 'vitest';
import { resolveDeployTarget, sourceEnvironmentFor } from '../deploy-targets';
import { buildPromotePipeline, buildPromoteJob, buildRollbackJob } from '../build-promote-pipeline';

function promptOf(pipeline: ReturnType<typeof buildPromotePipeline>): string {
  return pipeline.steps[0].prompt ?? '';
}

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
