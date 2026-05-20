/**
 * reflector-scheduler.test.mjs — Pipeline v2 Phase 3-C Epic 6 (2026-05-20).
 *
 * Tests the temporal-eligibility gate for REFLECTOR. Hermetic.
 */

import { describe, it, expect } from 'vitest';
import {
  decidePlanCloseReflection,
  decideWaveCloseReflection,
  buildReflectorJobPayload,
} from '../reflector-scheduler.mjs';

const planFresh = (over = {}) => ({
  planId: 'plan-1',
  rigor: 'mvp',
  status: 'review',
  reflectorPlanCloseFiredAt: null,
  ...over,
});

describe('decidePlanCloseReflection', () => {
  it('fires on review status + mvp rigor with no prior fire', () => {
    const r = decidePlanCloseReflection({ plan: planFresh() });
    expect(r.shouldFire).toBe(true);
  });

  it('fires on delivered status too', () => {
    const r = decidePlanCloseReflection({ plan: planFresh({ status: 'delivered' }) });
    expect(r.shouldFire).toBe(true);
  });

  it('does not fire when status is not terminal-for-reflector', () => {
    const r = decidePlanCloseReflection({ plan: planFresh({ status: 'developing' }) });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toContain('not eligible');
  });

  it('does not re-fire when already stamped', () => {
    const r = decidePlanCloseReflection({
      plan: planFresh({ reflectorPlanCloseFiredAt: '2026-05-20T00:00:00Z' }),
    });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toBe('already-fired');
  });

  it('respects the rigor-matrix gate function (returning shouldFire=false)', () => {
    const r = decidePlanCloseReflection({
      plan: planFresh(),
      shouldFireReflectionFn: () => ({ shouldFire: false, reason: 'matrix said no' }),
    });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toBe('matrix said no');
  });

  it('handles missing plan', () => {
    const r = decidePlanCloseReflection({ plan: null });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toBe('plan-missing');
  });
});

describe('decideWaveCloseReflection', () => {
  const epicFresh = (over = {}) => ({
    epicId: 'epic-1',
    reflectorWaveCloseFiredAt: null,
    status: 'in_progress',
    ...over,
  });

  it('fires for mvp rigor on a fresh wave', () => {
    const r = decideWaveCloseReflection({
      plan: planFresh({ status: 'developing' }),
      epic: epicFresh(),
      waveNumber: 0,
    });
    expect(r.shouldFire).toBe(true);
  });

  it('does not fire under prototype rigor', () => {
    const r = decideWaveCloseReflection({
      plan: planFresh({ rigor: 'prototype', status: 'developing' }),
      epic: epicFresh(),
      waveNumber: 0,
    });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toContain('mvp+ rigor');
  });

  it('does not re-fire when wave already stamped', () => {
    const r = decideWaveCloseReflection({
      plan: planFresh({ status: 'developing' }),
      epic: epicFresh({ reflectorWaveCloseFiredAt: { '0': '2026-05-20T00:00:00Z' } }),
      waveNumber: 0,
    });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toBe('already-fired');
  });

  it('fires for a NEW wave even when a prior wave was already stamped', () => {
    const r = decideWaveCloseReflection({
      plan: planFresh({ status: 'developing' }),
      epic: epicFresh({ reflectorWaveCloseFiredAt: { '0': '2026-05-20T00:00:00Z' } }),
      waveNumber: 1,
    });
    expect(r.shouldFire).toBe(true);
  });

  it('handles invalid waveNumber', () => {
    const r = decideWaveCloseReflection({
      plan: planFresh(),
      epic: epicFresh(),
      waveNumber: -1,
    });
    expect(r.shouldFire).toBe(false);
    expect(r.reason).toBe('waveNumber-invalid');
  });
});

describe('buildReflectorJobPayload', () => {
  it('builds a PENDING reflector job row with the right payload shape', () => {
    const ids = ['uuid-1'];
    const job = buildReflectorJobPayload({
      scope: 'plan',
      plan: { planId: 'plan-1', name: 'snake-5', rigor: 'mvp', workingDir: '/x', appId: 'snake-app' },
      jobIdFactory: () => ids.shift(),
    });
    expect(job.jobId).toBe('uuid-1');
    expect(job.jobType).toBe('reflector');
    expect(job.status).toBe('PENDING');
    expect(job.workingDir).toBe('/x');
    expect(job.reflectorPayload.scope).toBe('plan');
    expect(job.reflectorPayload.planId).toBe('plan-1');
    expect(job.reflectorPayload.planSlug).toBe('snake-5');
    expect(job.reflectorPayload.projectSlug).toBe('snake-app');
    expect(job.reflectorPayload.rigor).toBe('mvp');
    expect(job.reflectorPayload.epicId).toBeNull();
    expect(job.reflectorPayload.waveNumber).toBeNull();
  });

  it('stamps epic + wave fields when scope=wave', () => {
    const job = buildReflectorJobPayload({
      scope: 'wave',
      plan: { planId: 'p', name: 'n', rigor: 'production' },
      epic: { epicId: 'epic-1' },
      waveNumber: 2,
      jobIdFactory: () => 'u',
    });
    expect(job.reflectorPayload.epicId).toBe('epic-1');
    expect(job.reflectorPayload.waveNumber).toBe(2);
  });

  it('throws on missing planId', () => {
    expect(() =>
      buildReflectorJobPayload({ scope: 'plan', plan: {}, jobIdFactory: () => 'x' }),
    ).toThrow(/planId required/);
  });

  it('throws on invalid scope', () => {
    expect(() =>
      buildReflectorJobPayload({
        scope: 'rogue',
        plan: { planId: 'p' },
        jobIdFactory: () => 'x',
      }),
    ).toThrow(/invalid scope/);
  });
});
