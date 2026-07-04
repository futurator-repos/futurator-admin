import { describe, it, expect } from 'vitest';
import {
  P3_FLAGS,
  P3_FLAG_NAMES,
  resolveFlags,
  rolloutBucket,
  flagMode,
  isEnabled,
  freezeFlagsOntoJob,
} from '../pipeline-flags.mjs';

/**
 * Pipeline-3 flag registry (development-plan §7) unit tests.
 *
 * Invariants under test:
 *   - default OFF for everything (legacy fallback is always reachable)
 *   - invalid env value → coerced to OFF, never throws
 *   - allowlist gates non-default flags to the canary set
 *   - deterministic per-(flag,epic) rollout bucket; stable across calls
 *   - resolved set is frozen; freezeFlagsOntoJob is idempotent
 */

describe('resolveFlags — defaults', () => {
  it('returns every flag at its OFF default with empty env', () => {
    const f = resolveFlags({ epicId: 'e1', env: {} });
    for (const name of P3_FLAG_NAMES) {
      expect(f[name]).toBe(P3_FLAGS[name].default);
    }
  });

  it('coerces an invalid value to the OFF default (no throw)', () => {
    const f = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'banana' } });
    expect(f.P3_GATE_MODE).toBe('off');
  });

  it('freezes the resolved set', () => {
    const f = resolveFlags({ epicId: 'e1', env: {} });
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('P3_QA_REVIEW (W2): defaults off, honors shadow/on, coerces garbage', () => {
    expect(P3_FLAGS.P3_QA_REVIEW.values).toEqual(['off', 'shadow', 'on']);
    expect(resolveFlags({ epicId: 'e1', env: {} }).P3_QA_REVIEW).toBe('off');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'shadow' } }).P3_QA_REVIEW).toBe('shadow');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'on' } }).P3_QA_REVIEW).toBe('on');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'banana' } }).P3_QA_REVIEW).toBe('off');
    expect(isEnabled(resolveFlags({ epicId: 'e1', env: {} }), 'P3_QA_REVIEW')).toBe(false);
    expect(isEnabled(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'on' } }), 'P3_QA_REVIEW')).toBe(true);
  });
});

describe('resolveFlags — allowlist gating', () => {
  it('passes a non-default flag through for an allowlisted epic', () => {
    const f = resolveFlags({
      epicId: 'canary',
      env: { P3_GATE_MODE: 'audit', P3_EPIC_ALLOWLIST: 'canary,other' },
    });
    expect(f.P3_GATE_MODE).toBe('audit');
  });

  it('forces OFF for an epic outside a non-empty allowlist', () => {
    const f = resolveFlags({
      epicId: 'not-canary',
      env: { P3_GATE_MODE: 'audit', P3_EPIC_ALLOWLIST: 'canary' },
    });
    expect(f.P3_GATE_MODE).toBe('off');
  });

  it('empty allowlist means all epics are eligible', () => {
    const f = resolveFlags({ epicId: 'whatever', env: { P3_LAZY_MODE: 'full' } });
    expect(f.P3_LAZY_MODE).toBe('full');
  });
});

describe('resolveFlags — rollout bucketing', () => {
  it('pct=0 forces OFF even when allowlisted', () => {
    const f = resolveFlags({ epicId: 'e1', env: { P3_LAZY_MODE: 'full', P3_ROLLOUT_PCT: '0' } });
    expect(f.P3_LAZY_MODE).toBe('off');
  });

  it('pct=100 lets everything through', () => {
    const f = resolveFlags({ epicId: 'e1', env: { P3_LAZY_MODE: 'full', P3_ROLLOUT_PCT: '100' } });
    expect(f.P3_LAZY_MODE).toBe('full');
  });

  it('bucket is deterministic and stable for a (flag,epic) pair', () => {
    const a = rolloutBucket('P3_GATE_MODE', 'epic-42');
    const b = rolloutBucket('P3_GATE_MODE', 'epic-42');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it('resolution honors the bucket vs pct boundary', () => {
    const epicId = 'epic-42';
    const bucket = rolloutBucket('P3_GATE_MODE', epicId);
    // pct just below the bucket → OFF; pct just above → through.
    const below = resolveFlags({ epicId, env: { P3_GATE_MODE: 'audit', P3_ROLLOUT_PCT: String(bucket) } });
    const above = resolveFlags({ epicId, env: { P3_GATE_MODE: 'audit', P3_ROLLOUT_PCT: String(bucket + 1) } });
    expect(below.P3_GATE_MODE).toBe('off'); // bucket >= pct → off
    expect(above.P3_GATE_MODE).toBe('audit');
  });
});

describe('flagMode / isEnabled', () => {
  const flags = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'enforce' } });
  it('reads a mode out of a resolved set', () => {
    expect(flagMode(flags, 'P3_GATE_MODE')).toBe('enforce');
    expect(flagMode(flags, 'P3_LAZY_MODE')).toBe('off');
  });
  it('isEnabled is true for non-default, false for default/unknown', () => {
    expect(isEnabled(flags, 'P3_GATE_MODE')).toBe(true);
    expect(isEnabled(flags, 'P3_LAZY_MODE')).toBe(false);
    expect(isEnabled(flags, 'NOPE')).toBe(false);
  });
});

describe('freezeFlagsOntoJob', () => {
  it('stamps the resolved set onto a job by epicId', () => {
    const job = { epicId: 'e1' };
    const flags = freezeFlagsOntoJob(job, { env: { P3_LAZY_MODE: 'lite' } });
    expect(job.p3Flags).toBe(flags);
    expect(job.p3Flags.P3_LAZY_MODE).toBe('lite');
  });

  it('is idempotent — an already-frozen job keeps its set even if env changes', () => {
    const job = { epicId: 'e1', p3Flags: Object.freeze({ P3_LAZY_MODE: 'full' }) };
    const flags = freezeFlagsOntoJob(job, { env: { P3_LAZY_MODE: 'off' } });
    expect(flags.P3_LAZY_MODE).toBe('full');
    expect(job.p3Flags.P3_LAZY_MODE).toBe('full');
  });

  it('falls back to cohort.epicId then planId for the bucket key', () => {
    const job = { cohort: { epicId: 'cohort-epic' } };
    freezeFlagsOntoJob(job, { env: { P3_GATE_MODE: 'audit' } });
    expect(job.p3Flags.P3_GATE_MODE).toBe('audit');
  });
});

describe('metrics-csv p3 channel', () => {
  it('round-trips an A/B observation', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { appendP3Metric, readP3Metrics } = await import('../metrics-csv.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-metrics-'));
    appendP3Metric({
      workingDir: dir,
      event: { planId: 'p1', epicId: 'e1', storyId: 's1', flag: 'P3_LAZY_MODE', arm: 'full', metric: 'loc', value: 42, unit: 'lines' },
    });
    appendP3Metric({
      workingDir: dir,
      event: { planId: 'p1', epicId: 'e1', storyId: 's1', flag: 'P3_LAZY_MODE', arm: 'off', metric: 'loc', value: 91 },
    });
    const rows = readP3Metrics(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0].flag).toBe('P3_LAZY_MODE');
    expect(rows[0].arm).toBe('full');
    expect(rows[0].value).toBe('42');
    expect(rows[1].arm).toBe('off');
  });
});
