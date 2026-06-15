import { describe, it, expect } from 'vitest';
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
