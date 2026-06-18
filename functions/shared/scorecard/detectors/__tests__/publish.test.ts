// Tests for detectors/publish.ts — Plan Retrospect P-A1..P-I1 (rubric §0.6).
//
// Asserts: one slice per P criterion in id order, all deterministic & in the
// `publish` stage; the honesty guard (P-X1/P-S1/P-M1/P-I1 are ⚪ + score:null
// because the publish write-manifest is not surfaced to the deterministic
// scorer); and the P-A1 devUrl computation across its bands. P-S1 in particular
// must be ⚪ — never a false-green on an F-forcing safety criterion.

import { describe, it, expect } from 'vitest';
import { scorePublish } from '../publish';
import type { DetectorContext, ScorecardSlice } from '../../types';

// ── synthetic context ────────────────────────────────────────────────────────

function ctx(plan: Partial<DetectorContext['plan']>): DetectorContext {
  return {
    planId: 'plan_test',
    // Only `plan` is read by this detector; the rest are stubbed.
    plan: {
      name: 'brick-breaker',
      workingDir: '/home/ubuntu/projects/brick-breaker',
      ...plan,
    } as DetectorContext['plan'],
    epics: [],
    events: [],
    slices: [],
    aggregate: {} as DetectorContext['aggregate'],
    skills: null,
    cohort: null,
    byCat: () => ({ totalMs: 0, count: 0 }),
  };
}

function byId(slices: ScorecardSlice[]): Record<string, ScorecardSlice> {
  return Object.fromEntries(slices.map((s) => [s.criterionId, s]));
}

// ── shape ────────────────────────────────────────────────────────────────────

describe('scorePublish — shape', () => {
  it('emits exactly one slice per P criterion, in id order, all deterministic/publish', () => {
    const slices = scorePublish(ctx({ devUrl: 'https://brick-breaker.futurator.ai/' }));
    expect(slices.map((s) => s.criterionId)).toEqual(['P-A1', 'P-X1', 'P-S1', 'P-M1', 'P-I1']);
    expect(slices.every((s) => s.engine === 'deterministic')).toBe(true);
    expect(slices.every((s) => s.stage === 'publish')).toBe(true);
  });
});

// ── honesty guard: manifest-only criteria are ⚪ ──────────────────────────────

describe('scorePublish — needs-instrumentation honesty guard', () => {
  it('P-X1 / P-M1 / P-I1 are ⚪ with score null (publish manifest not surfaced)', () => {
    const s = byId(scorePublish(ctx({ devUrl: 'https://brick-breaker.futurator.ai/' })));
    for (const id of ['P-X1', 'P-M1', 'P-I1']) {
      expect(s[id].verdict).toBe('⚪');
      expect(s[id].score).toBeNull();
      expect(s[id].note).toContain('[needs-instrumentation:');
      expect(s[id].ieIds).toEqual([]);
      expect(s[id].fixIds).toEqual([]);
    }
  });

  it('P-S1 is ⚪ (never a false-green on the F-forcing safety criterion)', () => {
    const s = byId(scorePublish(ctx({ devUrl: 'https://brick-breaker.futurator.ai/' })));
    expect(s['P-S1'].verdict).toBe('⚪');
    expect(s['P-S1'].score).toBeNull();
    expect(s['P-S1'].note).toContain('[needs-instrumentation:');
    // The disclaimer must reference the safety-witness gap explicitly.
    expect(s['P-S1'].note).toMatch(/safety|allowlist|index\.html/);
  });
});

// ── P-A1 devUrl computation ──────────────────────────────────────────────────

describe('P-A1 — published URL / devUrl interpolation', () => {
  it('⚪ when no devUrl recorded (nothing published yet)', () => {
    const s = byId(scorePublish(ctx({ devUrl: undefined })));
    expect(s['P-A1'].verdict).toBe('⚪');
    expect(s['P-A1'].score).toBeNull();
  });

  it('🟢 (3) when devUrl is a full URL that names the app slug', () => {
    const s = byId(scorePublish(ctx({ devUrl: 'https://futurator.ai/apps/brick-breaker/' })));
    expect(s['P-A1'].verdict).toBe('🟢');
    expect(s['P-A1'].score).toBe(3);
    // Liveness is disclaimed, not fabricated as a 200.
    expect(s['P-A1'].note).toContain('[needs-instrumentation:');
  });

  it('🔴 (0) when devUrl is not a full http(s) URL (truncated)', () => {
    const s = byId(scorePublish(ctx({ devUrl: 'apps/brick-breaker/' })));
    expect(s['P-A1'].verdict).toBe('🔴');
    expect(s['P-A1'].score).toBe(0);
  });

  it('🔴 (0) when devUrl still carries an un-interpolated slug placeholder', () => {
    const s = byId(scorePublish(ctx({ devUrl: 'https://futurator.ai/apps/<appName>/' })));
    expect(s['P-A1'].verdict).toBe('🔴');
    expect(s['P-A1'].score).toBe(0);
    expect(s['P-A1'].note).toMatch(/placeholder|interpolat/i);
  });

  it('🟡 (1) when a full URL does not contain the app slug (possible wrong app)', () => {
    const s = byId(
      scorePublish(
        ctx({ name: 'brick-breaker', devUrl: 'https://futurator.ai/apps/some-other-app/' }),
      ),
    );
    expect(s['P-A1'].verdict).toBe('🟡');
    expect(s['P-A1'].score).toBe(1);
  });
});
