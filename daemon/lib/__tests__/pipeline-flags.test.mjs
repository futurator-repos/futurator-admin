import { describe, it, expect } from 'vitest';
import {
  P3_FLAGS,
  P3_FLAG_NAMES,
  resolveFlags,
  rolloutBucket,
  flagMode,
  isEnabled,
  freezeFlagsOntoJob,
  envFlag,
} from '../pipeline-flags.mjs';

/**
 * Pipeline-3 flag registry (development-plan §7; quality-defaults rollout,
 * pipeline-v3 redesign Part 3 §5 / Part 5 #1) unit tests.
 *
 * Invariants under test:
 *   - resolveFlags({env:{}}) reproduces each flag's registry `default`
 *     (which, post-rollout, is the QUALITY posture for the 9 flipped flags
 *     and 'on' for the 2 new gate flags — no longer uniformly "off")
 *   - invalid env value → coerced to the flag's default, never throws
 *   - allowlist/rollout gating still forces non-default values back to
 *     default (the mechanism is unchanged; only which value is "default"
 *     for a given flag moved)
 *   - explicit env override always wins over the registry default
 *   - envFlag() reads straight from env with no allowlist/rollout gating
 *   - resolved set is frozen; freezeFlagsOntoJob is idempotent
 */

const QUALITY_DEFAULTS = {
  P3_GATE_MODE: 'enforce',
  P3_BOUND_AC_GATE: 'on',
  P3_TEST_AUTHOR_SPLIT: 'on',
  P3_QUALITY_GATE: 'on',
  P3_READY_FRONTIER: 'on',
  P3_FRONTIER_MODE: 'contract',
  P3_LIFECYCLE: 'on',
  P3_QA_REVIEW: 'on',
  P3_SELECTIVE_REGRESSION: 'on',
};

const NEW_GATE_FLAGS = {
  P3_FOUNDATION_GATE: 'on',
  P3_GREEN_TRUNK: 'on',
};

const UNTOUCHED_OFF_FLAGS = [
  'P3_LAZY_MODE',
  'P3_COST_CEILING',
  'P3_WORKTREE_CACHE',
  'P3_SESSION_REUSE',
  'P3_COMPACTION',
  'P3_TEST_COVER_EDGES',
  'P3_SEMANTIC_COMPILE',
  'P3_GRAPH_GROWTH_SPLIT',
  'P3_REFLECTOR_SCOPE',
];

describe('P3_FLAGS registry — quality-defaults posture', () => {
  it('flips exactly the 9 named flags to their quality default', () => {
    for (const [name, expected] of Object.entries(QUALITY_DEFAULTS)) {
      expect(P3_FLAGS[name].default).toBe(expected);
    }
  });

  it('adds P3_FOUNDATION_GATE and P3_GREEN_TRUNK, both defaulting on', () => {
    for (const [name, expected] of Object.entries(NEW_GATE_FLAGS)) {
      expect(P3_FLAGS[name]).toBeDefined();
      expect(P3_FLAGS[name].values).toEqual(['off', 'on']);
      expect(P3_FLAGS[name].default).toBe(expected);
    }
  });

  it('B1 (Incident G): registers P3_STORY_BOOT_GATE, values [off,on], default on', () => {
    expect(P3_FLAGS.P3_STORY_BOOT_GATE).toBeDefined();
    expect(P3_FLAGS.P3_STORY_BOOT_GATE.values).toEqual(['off', 'on']);
    expect(P3_FLAGS.P3_STORY_BOOT_GATE.default).toBe('on');
    // resolves to its default on empty env, honors an explicit off override
    expect(resolveFlags({ epicId: 'e1', env: {} }).P3_STORY_BOOT_GATE).toBe('on');
    expect(resolveFlags({ epicId: 'e1', env: { P3_STORY_BOOT_GATE: 'off' } }).P3_STORY_BOOT_GATE).toBe('off');
    expect(envFlag('P3_STORY_BOOT_GATE', {})).toBe('on');
  });

  it('leaves all other flags at their legacy off default', () => {
    for (const name of UNTOUCHED_OFF_FLAGS) {
      expect(P3_FLAGS[name].default).toBe('off');
    }
  });

  it('keeps every values[] array unchanged (only defaults moved)', () => {
    expect(P3_FLAGS.P3_GATE_MODE.values).toEqual(['off', 'audit', 'enforce']);
    expect(P3_FLAGS.P3_READY_FRONTIER.values).toEqual(['off', 'shadow', 'on']);
    expect(P3_FLAGS.P3_FRONTIER_MODE.values).toEqual(['kahn', 'contract', 'green']);
    expect(P3_FLAGS.P3_BOUND_AC_GATE.values).toEqual(['off', 'shadow', 'on']);
    expect(P3_FLAGS.P3_TEST_AUTHOR_SPLIT.values).toEqual(['off', 'on']);
    expect(P3_FLAGS.P3_QUALITY_GATE.values).toEqual(['off', 'shadow', 'on']);
    expect(P3_FLAGS.P3_LIFECYCLE.values).toEqual(['off', 'on']);
    expect(P3_FLAGS.P3_QA_REVIEW.values).toEqual(['off', 'shadow', 'on']);
    expect(P3_FLAGS.P3_SELECTIVE_REGRESSION.values).toEqual(['off', 'shadow', 'on']);
  });
});

describe('resolveFlags — defaults', () => {
  it('returns every flag at its registry default with empty env', () => {
    const f = resolveFlags({ epicId: 'e1', env: {} });
    for (const name of P3_FLAG_NAMES) {
      expect(f[name]).toBe(P3_FLAGS[name].default);
    }
  });

  it('coerces an invalid value to the flag default (no throw)', () => {
    const f = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'banana' } });
    expect(f.P3_GATE_MODE).toBe('enforce');
  });

  it('freezes the resolved set', () => {
    const f = resolveFlags({ epicId: 'e1', env: {} });
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('P3_QA_REVIEW (W2): defaults on, honors shadow/off, coerces garbage to default', () => {
    expect(P3_FLAGS.P3_QA_REVIEW.values).toEqual(['off', 'shadow', 'on']);
    expect(resolveFlags({ epicId: 'e1', env: {} }).P3_QA_REVIEW).toBe('on');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'shadow' } }).P3_QA_REVIEW).toBe('shadow');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'off' } }).P3_QA_REVIEW).toBe('off');
    expect(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'banana' } }).P3_QA_REVIEW).toBe('on');
    expect(isEnabled(resolveFlags({ epicId: 'e1', env: {} }), 'P3_QA_REVIEW')).toBe(false);
    expect(isEnabled(resolveFlags({ epicId: 'e1', env: { P3_QA_REVIEW: 'off' } }), 'P3_QA_REVIEW')).toBe(true);
  });

  it('explicit env override always wins over the registry default (T1 guard)', () => {
    const f = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'off' } });
    expect(f.P3_GATE_MODE).toBe('off');
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

  it('forces the registry default for an epic outside a non-empty allowlist', () => {
    const f = resolveFlags({
      epicId: 'not-canary',
      env: { P3_GATE_MODE: 'audit', P3_EPIC_ALLOWLIST: 'canary' },
    });
    expect(f.P3_GATE_MODE).toBe('enforce');
  });

  it('empty allowlist means all epics are eligible', () => {
    const f = resolveFlags({ epicId: 'whatever', env: { P3_LAZY_MODE: 'full' } });
    expect(f.P3_LAZY_MODE).toBe('full');
  });
});

describe('resolveFlags — rollout bucketing', () => {
  it('pct=0 forces the default even when allowlisted', () => {
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

  it('resolution honors the bucket vs pct boundary, forcing the registry default', () => {
    const epicId = 'epic-42';
    const bucket = rolloutBucket('P3_GATE_MODE', epicId);
    // pct just below the bucket → default; pct just above → through.
    const below = resolveFlags({ epicId, env: { P3_GATE_MODE: 'audit', P3_ROLLOUT_PCT: String(bucket) } });
    const above = resolveFlags({ epicId, env: { P3_GATE_MODE: 'audit', P3_ROLLOUT_PCT: String(bucket + 1) } });
    expect(below.P3_GATE_MODE).toBe('enforce'); // bucket >= pct → registry default
    expect(above.P3_GATE_MODE).toBe('audit');
  });
});

describe('flagMode / isEnabled', () => {
  it('reads a mode out of a resolved set', () => {
    const flags = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'audit' } });
    expect(flagMode(flags, 'P3_GATE_MODE')).toBe('audit');
    expect(flagMode(flags, 'P3_LAZY_MODE')).toBe('off');
  });
  it('isEnabled is true for non-default, false for default/unknown', () => {
    const flags = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'audit' } });
    expect(isEnabled(flags, 'P3_GATE_MODE')).toBe(true);
    expect(isEnabled(flags, 'P3_LAZY_MODE')).toBe(false);
    expect(isEnabled(flags, 'NOPE')).toBe(false);
  });
  it('isEnabled is false when a flag is explicitly set BACK to its own default', () => {
    const flags = resolveFlags({ epicId: 'e1', env: { P3_GATE_MODE: 'enforce' } });
    expect(isEnabled(flags, 'P3_GATE_MODE')).toBe(false);
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

describe('envFlag', () => {
  it('returns the coerced env value when present and valid', () => {
    expect(envFlag('P3_GATE_MODE', { P3_GATE_MODE: 'audit' })).toBe('audit');
  });
  it('returns the registry default when env is absent', () => {
    expect(envFlag('P3_FOUNDATION_GATE', {})).toBe('on');
    expect(envFlag('P3_READY_FRONTIER', {})).toBe('on');
    expect(envFlag('P3_FRONTIER_MODE', {})).toBe('contract');
    expect(envFlag('P3_LIFECYCLE', {})).toBe('on');
  });
  it('returns the registry default when env value is invalid', () => {
    expect(envFlag('P3_GATE_MODE', { P3_GATE_MODE: 'banana' })).toBe('enforce');
  });
  it('returns undefined for an unknown flag name', () => {
    expect(envFlag('NOT_A_REAL_FLAG', {})).toBeUndefined();
  });
  it('skips allowlist/rollout gating entirely (unlike resolveFlags)', () => {
    // Even with a restrictive allowlist that would force resolveFlags() to the
    // default for other epics, envFlag() reads straight through — it has no
    // epic-scoped gating machinery at all.
    expect(envFlag('P3_GATE_MODE', { P3_GATE_MODE: 'audit', P3_EPIC_ALLOWLIST: 'someone-else' })).toBe('audit');
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
