import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDeployTarget, isDeployEnvironment, DEPLOY_ENVIRONMENTS } from '../deploy-targets';

describe('resolveDeployTarget', () => {
  it('production publishes to the live apps/<slug>/ path', () => {
    const t = resolveDeployTarget('dino1', 'production');
    expect(t.s3Prefix).toBe('apps/dino1/');
    expect(t.basePath).toBe('/apps/dino1/');
    expect(t.publicUrl).toBe('https://futurator.ai/apps/dino1/');
    expect(t.invalidationPath).toBe('/apps/dino1/*');
  });

  it('dev + staging publish to RESERVED prefixes that can never collide with prod', () => {
    const dev = resolveDeployTarget('dino1', 'dev');
    const staging = resolveDeployTarget('dino1', 'staging');
    expect(dev.s3Prefix).toBe('apps/_dev/dino1/');
    expect(staging.s3Prefix).toBe('apps/_staging/dino1/');

    // The whole safety story: a dev/staging deploy must NEVER overwrite the
    // live production bundle. Slugs are kebab-case [a-z0-9-] and cannot begin
    // with an underscore, so `_dev`/`_staging` are unreachable as real slugs.
    const prodPrefix = resolveDeployTarget('dino1', 'production').s3Prefix;
    expect(dev.s3Prefix).not.toBe(prodPrefix);
    expect(staging.s3Prefix).not.toBe(prodPrefix);
    expect(dev.s3Prefix.startsWith(prodPrefix)).toBe(false);
  });

  it('basePath, publicUrl, and invalidationPath are always derived from the same prefix', () => {
    for (const env of DEPLOY_ENVIRONMENTS) {
      const t = resolveDeployTarget('app-x', env);
      expect(t.basePath).toBe(`/${t.s3Prefix}`);
      expect(t.publicUrl.endsWith(t.basePath)).toBe(true);
      expect(t.invalidationPath).toBe(`${t.basePath}*`);
    }
  });
});

describe('deploy identity (F29 — dev keys on plan, staging/prod on app)', () => {
  const ENV = {
    DEPLOY_ENV_SUBDOMAINS: 'on',
    DEV_ENV_BUCKET: 'futurator-admin-dev-env',
    DEV_ENV_CF_ID: 'DEVCF',
    STAGING_ENV_BUCKET: 'futurator-admin-staging-env',
    STAGING_ENV_CF_ID: 'STGCF',
  } as const;
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => {
    for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV];
  });

  it('dev is PLAN-scoped → dev.futurator.ai/<plan>/ (bare root segment, no apps/)', () => {
    const t = resolveDeployTarget({ planSlug: 'cool-plan', appId: 'pacman' }, 'dev');
    expect(t.appName).toBe('cool-plan');
    expect(t.s3Prefix).toBe('cool-plan/');
    expect(t.basePath).toBe('/cool-plan/');
    expect(t.publicUrl).toBe('https://dev.futurator.ai/cool-plan/');
  });

  it('staging + production are APP-scoped and share a base → byte-copy promotable', () => {
    const staging = resolveDeployTarget({ planSlug: 'cool-plan', appId: 'pacman' }, 'staging');
    const prod = resolveDeployTarget({ planSlug: 'cool-plan', appId: 'pacman' }, 'production');
    expect(staging.publicUrl).toBe('https://staging.futurator.ai/apps/pacman/');
    expect(prod.publicUrl).toBe('https://futurator.ai/apps/pacman/');
    // The shared base path is what makes staging→prod a pure S3 copy.
    expect(staging.basePath).toBe(prod.basePath);
    expect(staging.basePath).toBe('/apps/pacman/');
  });

  it('dev base differs from staging → dev→staging is a rebuild, not a copy', () => {
    const dev = resolveDeployTarget({ planSlug: 'cool-plan', appId: 'pacman' }, 'dev');
    const staging = resolveDeployTarget({ planSlug: 'cool-plan', appId: 'pacman' }, 'staging');
    expect(dev.basePath).not.toBe(staging.basePath);
  });

  it('a bare string stays back-compat (planSlug = appId = the string)', () => {
    const dev = resolveDeployTarget('solo', 'dev');
    expect(dev.publicUrl).toBe('https://dev.futurator.ai/solo/');
  });
});

describe('isDeployEnvironment', () => {
  it('accepts only the three known environments', () => {
    expect(isDeployEnvironment('dev')).toBe(true);
    expect(isDeployEnvironment('staging')).toBe(true);
    expect(isDeployEnvironment('production')).toBe(true);
    expect(isDeployEnvironment('prod')).toBe(false);
    expect(isDeployEnvironment(undefined)).toBe(false);
    expect(isDeployEnvironment('')).toBe(false);
  });
});
