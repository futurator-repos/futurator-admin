import { describe, it, expect } from 'vitest';
import { selectNext, resolveTiers, tierIndexOf, type PriorityJob } from '../job-priority';
import { DEFAULT_JOB_PRIORITY_TIERS, type JobPriorityTier } from '../../types/compute-server';

// A tiny helper so each test reads as "these jobs, in this order".
function job(jobType: string | undefined, createdAt?: string): PriorityJob & { id: string } {
  return { id: `${jobType ?? 'none'}@${createdAt ?? '-'}`, jobType, createdAt };
}

describe('resolveTiers', () => {
  it('falls back to the operator default when policy is absent', () => {
    expect(resolveTiers()).toBe(DEFAULT_JOB_PRIORITY_TIERS);
    expect(resolveTiers(null)).toBe(DEFAULT_JOB_PRIORITY_TIERS);
    expect(resolveTiers({})).toBe(DEFAULT_JOB_PRIORITY_TIERS);
  });

  it('falls back when jobPriority is an empty array', () => {
    expect(resolveTiers({ jobPriority: [] })).toBe(DEFAULT_JOB_PRIORITY_TIERS);
  });

  it('uses the configured tiers when present', () => {
    const custom: JobPriorityTier[] = [{ id: 'only', label: 'Only', jobTypes: ['x'] }];
    expect(resolveTiers({ jobPriority: custom })).toBe(custom);
  });
});

describe('tierIndexOf', () => {
  it('returns the index of the first tier that lists the jobType', () => {
    expect(tierIndexOf('free-agent-session', DEFAULT_JOB_PRIORITY_TIERS)).toBe(0);
    expect(tierIndexOf('wave-merge', DEFAULT_JOB_PRIORITY_TIERS)).toBe(1);
    expect(tierIndexOf('story-dev', DEFAULT_JOB_PRIORITY_TIERS)).toBe(2);
    expect(tierIndexOf('scan-engine', DEFAULT_JOB_PRIORITY_TIERS)).toBe(3);
    expect(tierIndexOf('ultracode-bench', DEFAULT_JOB_PRIORITY_TIERS)).toBe(4);
  });

  it('maps an unknown jobType to the last tier (everything-else band)', () => {
    const last = DEFAULT_JOB_PRIORITY_TIERS.length - 1;
    expect(tierIndexOf('totally-new-job', DEFAULT_JOB_PRIORITY_TIERS)).toBe(last);
    expect(tierIndexOf(undefined, DEFAULT_JOB_PRIORITY_TIERS)).toBe(last);
  });

  it('returns 0 for every job when the tier list is empty', () => {
    expect(tierIndexOf('anything', [])).toBe(0);
    expect(tierIndexOf(undefined, [])).toBe(0);
  });
});

describe('selectNext — empty / trivial', () => {
  it('returns null for an empty pool', () => {
    expect(selectNext([])).toBeNull();
  });

  it('returns the only job when the pool has one', () => {
    const only = job('story-dev', '2026-01-01T00:00:00Z');
    expect(selectNext([only])).toBe(only);
  });
});

describe('selectNext — tier ordering (default tiers)', () => {
  it('prefers a higher tier even when it arrived later', () => {
    const dev = job('story-dev', '2026-01-01T00:00:00Z'); // tier 2, earlier
    const interactive = job('free-agent-session', '2026-01-01T05:00:00Z'); // tier 0, later
    const bench = job('ultracode-bench', '2025-12-01T00:00:00Z'); // tier 4, earliest
    expect(selectNext([dev, interactive, bench])).toBe(interactive);
  });

  it('ranks the full ladder interactive > critical-path > dev > assess > bench', () => {
    const same = '2026-01-01T00:00:00Z';
    const bench = job('dual-agent-compare', same);
    const assess = job('refactor-audit', same);
    const dev = job('epic-dev', same);
    const critical = job('integrator', same);
    const interactive = job('party-turn', same);
    // Same createdAt across all → tier alone decides; input order shuffled.
    expect(selectNext([bench, assess, dev, critical, interactive])).toBe(interactive);
    expect(selectNext([bench, assess, dev, critical])).toBe(critical);
    expect(selectNext([bench, assess, dev])).toBe(dev);
    expect(selectNext([bench, assess])).toBe(assess);
    expect(selectNext([bench])).toBe(bench);
  });
});

describe('selectNext — within-tier FIFO', () => {
  it('picks the earliest createdAt among jobs in the same tier', () => {
    const early = job('story-dev', '2026-01-01T00:00:00Z');
    const mid = job('quick-planspec', '2026-01-01T01:00:00Z'); // same tier (dev)
    const late = job('epic-dev', '2026-01-01T02:00:00Z'); // same tier (dev)
    expect(selectNext([late, mid, early])).toBe(early);
  });

  it('keeps input order on an exact tier+timestamp tie (stable)', () => {
    const ts = '2026-01-01T00:00:00Z';
    const a = job('story-dev', ts);
    const b = job('quick-planspec', ts);
    expect(selectNext([a, b])).toBe(a);
    expect(selectNext([b, a])).toBe(b);
  });
});

describe('selectNext — unknown jobType → lowest tier', () => {
  it('loses to any recognised, higher-tier job', () => {
    const unknown = job('brand-new-type', '2020-01-01T00:00:00Z'); // last tier, ancient
    const dev = job('story-dev', '2026-06-01T00:00:00Z'); // tier 2, recent
    expect(selectNext([unknown, dev])).toBe(dev);
  });

  it('shares the last tier with bench jobs, so FIFO decides between them', () => {
    const unknownEarly = job('brand-new-type', '2026-01-01T00:00:00Z');
    const bench = job('ultracode-bench', '2026-01-01T02:00:00Z');
    // Same (last) tier → earlier createdAt wins.
    expect(selectNext([bench, unknownEarly])).toBe(unknownEarly);
  });
});

describe('selectNext — custom + empty tier configs', () => {
  it('honours a custom tier ordering', () => {
    const policy = {
      jobPriority: [
        { id: 'top', label: 'Top', jobTypes: ['ultracode-bench'] },
        { id: 'bottom', label: 'Bottom', jobTypes: ['free-agent-session'] },
      ] satisfies JobPriorityTier[],
    };
    const bench = job('ultracode-bench', '2026-01-01T05:00:00Z');
    const interactive = job('free-agent-session', '2026-01-01T00:00:00Z');
    // Custom config flips the default ranking: bench now outranks interactive.
    expect(selectNext([interactive, bench], policy)).toBe(bench);
  });

  it('degrades to pure FIFO when the tier list is empty', () => {
    const policy = { jobPriority: [] };
    // Empty jobPriority resolves to the DEFAULT tiers (not "no tiers"), so this
    // documents the fallback rather than a truly-flat config.
    const interactive = job('free-agent-session', '2026-01-01T02:00:00Z');
    const dev = job('story-dev', '2026-01-01T00:00:00Z');
    expect(selectNext([dev, interactive], policy)).toBe(interactive);
  });
});
