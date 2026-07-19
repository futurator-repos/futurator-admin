import { describe, it, expect, afterEach } from 'vitest';
import { resolveDeployTarget, sourceEnvironmentFor } from '../deploy-targets';
import { buildPromotePipeline, buildPromoteJob, buildRollbackJob } from '../build-promote-pipeline';
import { buildDeployPipeline, treeClean } from '../build-deploy-pipeline';

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

  it('copy-mode prompt (staging→prod build-once) says do NOT rebuild and has a single sync', () => {
    // F29 — the byte-copy hop is staging→prod (shared /apps/<app>/ base), NOT
    // dev→staging (dev is plan-scoped at a different base, so it rebuilds).
    process.env.DEPLOY_ENV_SUBDOMAINS = 'on';
    process.env.DEV_ENV_BUCKET = 'futurator-admin-dev-env';
    process.env.DEV_ENV_CF_ID = 'DEVCF';
    process.env.STAGING_ENV_BUCKET = 'futurator-admin-staging-env';
    process.env.STAGING_ENV_CF_ID = 'STGCF';
    const staging = resolveDeployTarget('dino1', 'staging');
    const prod = resolveDeployTarget('dino1', 'production');
    expect(staging.basePath).toBe('/apps/dino1/');
    expect(prod.basePath).toBe('/apps/dino1/');
    const prompt = promptOf(buildPromotePipeline('/w/dino1', staging, prod, { smoke: true }));
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

describe('test-harness contract (F29 Part C)', () => {
  it('the DEV build sets NEXT_PUBLIC_TEST_HARNESS=1 (publishes window.__harness for QA)', () => {
    const dev = resolveDeployTarget('dino1', 'dev');
    const prompt = buildDeployPipeline('/w/dino1', dev).steps[0].prompt ?? '';
    expect(prompt).toContain('NEXT_PUBLIC_TEST_HARNESS=1 npm run build');
  });

  it('staging + production builds do NOT set the harness flag (production-absent by design)', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = resolveDeployTarget('dino1', env);
      const prompt = buildDeployPipeline('/w/dino1', t).steps[0].prompt ?? '';
      expect(prompt).not.toContain('NEXT_PUBLIC_TEST_HARNESS');
      expect(prompt).toContain('npm run build');
    }
  });
});

describe('R4 — deploy hygiene: mandatory config-revert + DEPLOY_TREE contract', () => {
  const dev = resolveDeployTarget('dino1', 'dev');
  const prompt = buildDeployPipeline('/w/dino1', dev).steps[0].prompt ?? '';

  it('prompt has a mandatory step-6 cleanup that reverts the framework config via git checkout --', () => {
    expect(prompt).toContain('MANDATORY cleanup');
    expect(prompt).toMatch(
      /git -C \/w\/dino1 checkout -- next\.config\.ts next\.config\.js next\.config\.mjs vite\.config\.ts vite\.config\.js/,
    );
  });

  it('prompt requires running git status --porcelain after the revert', () => {
    expect(prompt).toContain('git -C /w/dino1 status --porcelain');
  });

  it('prompt tells the agent to emit a DEPLOY_TREE line on both success and failure', () => {
    expect(prompt).toContain('DEPLOY_TREE: clean');
    expect(prompt).toMatch(/DEPLOY_TREE:.*dirty/);
    // present in the failure-branch instructions too, not just success
    const failureBranch = prompt.slice(prompt.indexOf('DEPLOY_STATUS: failed'));
    expect(failureBranch).toContain('DEPLOY_TREE');
  });

  it('emits a DEPLOY_TREE extractor alongside DEPLOY_URL/COMMIT_SHA', () => {
    const extractors = buildDeployPipeline('/w/dino1', dev).steps[0].extractors as
      | Record<string, { pattern: string }>
      | undefined;
    expect(extractors?.DEPLOY_TREE?.pattern).toBeTruthy();
    expect(extractors?.DEPLOY_URL?.pattern).toBeTruthy();
    expect(extractors?.COMMIT_SHA?.pattern).toBeTruthy();
  });

  it('DEPLOY_TREE extractor parses a clean verdict', () => {
    const pattern = buildDeployPipeline('/w/dino1', dev).steps[0].extractors?.DEPLOY_TREE
      ?.pattern as string;
    const m = new RegExp(pattern, 's').exec('DEPLOY_TREE: clean');
    expect(m?.[1]).toBe('clean');
  });

  it('DEPLOY_TREE extractor parses a dirty verdict with the file list', () => {
    const pattern = buildDeployPipeline('/w/dino1', dev).steps[0].extractors?.DEPLOY_TREE
      ?.pattern as string;
    const m = new RegExp(pattern, 's').exec('DEPLOY_TREE: dirty next.config.ts');
    expect(m?.[1]).toBe('dirty next.config.ts');
  });

  it('DEPLOY_TREE extractor tolerates markdown decoration like the other extractors', () => {
    const pattern = buildDeployPipeline('/w/dino1', dev).steps[0].extractors?.DEPLOY_TREE
      ?.pattern as string;
    const m = new RegExp(pattern, 's').exec('**DEPLOY_TREE:** `clean`');
    expect(m?.[1]).toBe('clean');
  });

  it('treeClean() parses the extracted variable into the writeback boolean', () => {
    expect(treeClean('clean')).toBe(true);
    expect(treeClean('  clean  ')).toBe(true);
    expect(treeClean('dirty next.config.ts')).toBe(false);
  });

  it('treeClean() fails closed (false) when DEPLOY_TREE is absent — never assume clean', () => {
    expect(treeClean(undefined)).toBe(false);
    expect(treeClean(null)).toBe(false);
    expect(treeClean('')).toBe(false);
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

  it('COPIES (build-once) when base paths match — staging→prod on provisioned buckets', () => {
    process.env.DEPLOY_ENV_SUBDOMAINS = 'on';
    process.env.DEV_ENV_BUCKET = 'futurator-admin-dev-env';
    process.env.DEV_ENV_CF_ID = 'DEVCF';
    process.env.STAGING_ENV_BUCKET = 'futurator-admin-staging-env';
    process.env.STAGING_ENV_CF_ID = 'STGCF';
    const staging = resolveDeployTarget('dino1', 'staging');
    const prod = resolveDeployTarget('dino1', 'production');
    expect(staging.basePath).toBe('/apps/dino1/');
    expect(prod.basePath).toBe('/apps/dino1/');
    const prompt = promptOf(buildPromotePipeline('/w/dino1', staging, prod, { smoke: true }));
    expect(prompt).not.toContain('npm run build');
    expect(prompt).toContain('aws s3 sync s3://futurator-admin-staging-env/apps/dino1/');
    expect(prompt).toContain('s3://futurator-ai-website/apps/dino1/');
  });

  it('REBUILDS dev→staging in subdomain mode (plan→app base change), dev is plan-scoped', () => {
    process.env.DEPLOY_ENV_SUBDOMAINS = 'on';
    process.env.DEV_ENV_BUCKET = 'futurator-admin-dev-env';
    process.env.DEV_ENV_CF_ID = 'DEVCF';
    process.env.STAGING_ENV_BUCKET = 'futurator-admin-staging-env';
    process.env.STAGING_ENV_CF_ID = 'STGCF';
    const dev = resolveDeployTarget({ planSlug: 'my-plan', appId: 'dino1' }, 'dev');
    const staging = resolveDeployTarget({ planSlug: 'my-plan', appId: 'dino1' }, 'staging');
    expect(dev.publicUrl).toBe('https://dev.futurator.ai/my-plan/');
    expect(staging.publicUrl).toBe('https://staging.futurator.ai/apps/dino1/');
    expect(dev.basePath).not.toBe(staging.basePath);
    const prompt = promptOf(buildPromotePipeline('/w/dino1', dev, staging, { smoke: true }));
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('REBUILD');
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
