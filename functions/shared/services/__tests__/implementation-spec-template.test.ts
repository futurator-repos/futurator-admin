/**
 * implementation-spec-template.test.ts — Pipeline v2 Phase 2-D / Story 2-D-8-1 (PR-101).
 */

import { describe, it, expect } from 'vitest';
import {
  getImplementationSpecEpics,
  buildImplementationSpecPlanPayload,
  gateFiresUnder,
} from '../implementation-spec-template';

describe('getImplementationSpecEpics', () => {
  it('returns 5 epics in v2.5 §27.3 order', () => {
    const epics = getImplementationSpecEpics();
    expect(epics).toHaveLength(5);
    expect(epics.map((e) => e.id)).toEqual(['arch-1', 'arch-2', 'arch-3', 'arch-4', 'arch-5']);
  });

  it('first epic is ARCHITECT manifest delta', () => {
    const epics = getImplementationSpecEpics();
    expect(epics[0].primaryRole).toBe('ARCHITECT');
    expect(epics[0].title).toContain('manifest delta');
    expect(epics[0].confirmationGate).toBe('operator-always');
  });

  it('CDK synth is auto-gated (no operator wait)', () => {
    const epics = getImplementationSpecEpics();
    const synth = epics.find((e) => e.id === 'arch-3');
    expect(synth?.confirmationGate).toBe('auto');
  });

  it('CDK diff + deploy are operator-production gated', () => {
    const epics = getImplementationSpecEpics();
    const diff = epics.find((e) => e.id === 'arch-4');
    const deploy = epics.find((e) => e.id === 'arch-5');
    expect(diff?.confirmationGate).toBe('operator-production');
    expect(deploy?.confirmationGate).toBe('operator-production');
  });

  it('returns fresh array (mutation-safe)', () => {
    const a = getImplementationSpecEpics();
    a[0].title = 'mutated';
    const b = getImplementationSpecEpics();
    expect(b[0].title).not.toBe('mutated');
  });
});

describe('buildImplementationSpecPlanPayload', () => {
  it('shapes a plan payload with the template epics', () => {
    const payload = buildImplementationSpecPlanPayload({
      appSlug: 'songster',
      intent: 'Add Stripe billing infrastructure',
      planSlug: 'songster-stripe-infra',
      rigor: 'mvp',
    });
    expect(payload.kind).toBe('implementation-spec');
    expect(payload.appSlug).toBe('songster');
    expect(payload.name).toBe('songster-stripe-infra');
    expect(payload.epics).toHaveLength(5);
    expect(payload.templated).toBe(true);
  });
});

describe('gateFiresUnder', () => {
  it('auto never fires', () => {
    expect(gateFiresUnder('auto', 'prototype')).toBe(false);
    expect(gateFiresUnder('auto', 'mvp')).toBe(false);
    expect(gateFiresUnder('auto', 'production')).toBe(false);
  });

  it('operator-always fires for every rigor', () => {
    expect(gateFiresUnder('operator-always', 'prototype')).toBe(true);
    expect(gateFiresUnder('operator-always', 'mvp')).toBe(true);
    expect(gateFiresUnder('operator-always', 'production')).toBe(true);
  });

  it('operator-production only fires under production', () => {
    expect(gateFiresUnder('operator-production', 'prototype')).toBe(false);
    expect(gateFiresUnder('operator-production', 'mvp')).toBe(false);
    expect(gateFiresUnder('operator-production', 'production')).toBe(true);
  });

  it('operator-prototype-mvp fires under prototype + mvp only', () => {
    expect(gateFiresUnder('operator-prototype-mvp', 'prototype')).toBe(true);
    expect(gateFiresUnder('operator-prototype-mvp', 'mvp')).toBe(true);
    expect(gateFiresUnder('operator-prototype-mvp', 'production')).toBe(false);
  });
});
