import { describe, it, expect, vi } from 'vitest';
import { resolveQaContext, resolveHasSeam } from '../qa-boilerplate-resolver';
import type { Plan } from '../../types/plan';
import type { App } from '../../types/app';

function plan(extras: Partial<Plan> & { appId?: string } = {}): Plan {
  return {
    planId: 'p-1',
    name: 'demo',
    intent: 'x',
    description: '',
    status: 'review',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/demo',
    executionMode: 'orchestrator',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '',
    updatedAt: '',
    createdBy: 'tester',
    ...extras,
  };
}

function app(boilerplateType?: App['boilerplateType']): App {
  return {
    appId: 'app-1',
    displayName: 'Demo',
    workingDir: '/home/ubuntu/projects/demo',
    executionMode: 'orchestrator',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    boilerplateType,
    createdAt: '',
    updatedAt: '',
  };
}

describe('resolveQaContext', () => {
  it('returns Next.js qaContext (port 3000) for boilerplateType=nextjs', async () => {
    const getApp = vi.fn(async () => app('nextjs'));
    const ctx = await resolveQaContext(plan({ appId: 'app-1' }), { getApp });
    expect(ctx?.defaultPort).toBe(3000);
    expect(ctx?.devCommand).toContain('--hostname');
  });

  it('returns Vite qaContext (port 5173) for boilerplateType=vite', async () => {
    const getApp = vi.fn(async () => app('vite'));
    const ctx = await resolveQaContext(plan({ appId: 'app-1' }), { getApp });
    expect(ctx?.defaultPort).toBe(5173);
    expect(ctx?.devCommand).toContain('--host');
  });

  it('returns Expo qaContext (port 19006) for boilerplateType=mobile', async () => {
    const getApp = vi.fn(async () => app('mobile'));
    const ctx = await resolveQaContext(plan({ appId: 'app-1' }), { getApp });
    expect(ctx?.defaultPort).toBe(19006);
  });

  it('returns undefined when plan has no appId (legacy pre-v1 plan)', async () => {
    const getApp = vi.fn();
    const ctx = await resolveQaContext(plan(), { getApp });
    expect(ctx).toBeUndefined();
    expect(getApp).not.toHaveBeenCalled();
  });

  it('returns undefined when app row is missing', async () => {
    const getApp = vi.fn(async () => null);
    const ctx = await resolveQaContext(plan({ appId: 'gone' }), { getApp });
    expect(ctx).toBeUndefined();
  });

  it('returns undefined when app has no boilerplateType (legacy bootstrap)', async () => {
    const getApp = vi.fn(async () => app(undefined));
    const ctx = await resolveQaContext(plan({ appId: 'app-1' }), { getApp });
    expect(ctx).toBeUndefined();
  });
});

describe('resolveHasSeam (VQA v3 — E2/E4)', () => {
  it('true for the canvas-game boilerplate (ships __harness)', async () => {
    const getApp = vi.fn(async () => app('nextjs-canvas-game' as App['boilerplateType']));
    expect(await resolveHasSeam(plan({ appId: 'app-1' }), { getApp })).toBe(true);
  });

  it('false for a seam-less boilerplate (nextjs-base)', async () => {
    const getApp = vi.fn(async () => app('nextjs' as App['boilerplateType']));
    expect(await resolveHasSeam(plan({ appId: 'app-1' }), { getApp })).toBe(false);
  });

  it('false for a legacy plan with no appId (no lookup)', async () => {
    const getApp = vi.fn();
    expect(await resolveHasSeam(plan(), { getApp })).toBe(false);
    expect(getApp).not.toHaveBeenCalled();
  });
});
