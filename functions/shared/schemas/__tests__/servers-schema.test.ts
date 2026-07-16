import { describe, it, expect } from 'vitest';
import {
  createServerSchema,
  dispatchPolicySchema,
  providerCredentialsSchema,
} from '../servers-schema';

describe('servers-schema', () => {
  it('accepts a valid createServer payload', () => {
    const r = createServerSchema.safeParse({
      name: 'hetzner-fsn-1',
      provider: 'hetzner',
      serviceType: 'vm',
      region: 'fsn1',
      size: 'cax11',
      arch: 'arm64',
      maxConcurrent: 2,
      costPerHour: 0.008,
    });
    expect(r.success).toBe(true);
  });

  it('rejects serverless serviceType in v1', () => {
    const r = createServerSchema.safeParse({
      name: 'x',
      provider: 'gcp',
      serviceType: 'serverless',
      region: 'europe-west3',
      size: 'cloud-run',
      arch: 'x86_64',
      maxConcurrent: 1,
      costPerHour: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects maxConcurrent outside 1-16', () => {
    const base = {
      name: 'x',
      provider: 'hetzner',
      serviceType: 'vm',
      region: 'fsn1',
      size: 'cax11',
      arch: 'arm64',
      costPerHour: 0,
    };
    expect(createServerSchema.safeParse({ ...base, maxConcurrent: 0 }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...base, maxConcurrent: 17 }).success).toBe(false);
  });

  it('validates dispatch policy', () => {
    const r = dispatchPolicySchema.safeParse({
      mode: 'weighted',
      priorityOrder: ['srv_a', 'srv_b'],
      weights: { srv_a: 50, srv_b: 50 },
    });
    expect(r.success).toBe(true);
    expect(
      dispatchPolicySchema.safeParse({ mode: 'random', priorityOrder: [], weights: {} }).success,
    ).toBe(false);
  });

  it('validates provider credentials per provider', () => {
    expect(
      providerCredentialsSchema.safeParse({ provider: 'hetzner', credentials: { token: 'abc' } })
        .success,
    ).toBe(true);
    expect(
      providerCredentialsSchema.safeParse({ provider: 'hetzner', credentials: {} }).success,
    ).toBe(false);
  });
});
