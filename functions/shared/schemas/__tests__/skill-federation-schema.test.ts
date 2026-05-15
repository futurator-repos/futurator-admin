/**
 * skill-federation-schema.test.ts — Pipeline v2 Phase 3 / Story 3-C-1-1.
 */

import { describe, it, expect } from 'vitest';
import {
  SkillFederationSchema,
  EMBEDDED_DEFAULT_FEDERATION,
  effectiveRefreshCadence,
  type SkillFederation,
} from '../skill-federation-schema';

describe('SkillFederationSchema', () => {
  it('parses the v2.5 §35.1 illustrative manifest', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [
        {
          id: 'anthropic-official',
          url: 'https://github.com/anthropics/skills',
          'auto-trust': true,
          priority: 1,
        },
        {
          id: 'futurator-internal',
          url: 'https://github.com/futurator/futurator-skills',
          'auto-trust': true,
          priority: 2,
        },
        {
          id: 'community',
          url: 'https://github.com/anthropics/skills-community',
          'auto-trust': false,
          priority: 99,
        },
      ],
      'refresh-cadence': 'weekly',
    };

    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects manifest-version != 1', () => {
    const manifest = {
      'manifest-version': 2,
      sources: [{ id: 's', url: 'https://x.com', 'auto-trust': true, priority: 1 }],
      'refresh-cadence': 'weekly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects empty sources array', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [],
      'refresh-cadence': 'weekly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects non-positive priority', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [{ id: 's', url: 'https://x.com', 'auto-trust': true, priority: 0 }],
      'refresh-cadence': 'weekly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects malformed URL', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [{ id: 's', url: 'not-a-url', 'auto-trust': true, priority: 1 }],
      'refresh-cadence': 'weekly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects unknown refresh-cadence', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [{ id: 's', url: 'https://x.com', 'auto-trust': true, priority: 1 }],
      'refresh-cadence': 'fortnightly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('accepts per-source refresh-cadence override', () => {
    const manifest = {
      'manifest-version': 1,
      sources: [
        {
          id: 'community',
          url: 'https://github.com/x',
          'auto-trust': false,
          priority: 99,
          'refresh-cadence': 'daily',
        },
      ],
      'refresh-cadence': 'weekly',
    };
    const result = SkillFederationSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });
});

describe('EMBEDDED_DEFAULT_FEDERATION', () => {
  it('passes its own schema', () => {
    const result = SkillFederationSchema.safeParse(EMBEDDED_DEFAULT_FEDERATION);
    expect(result.success).toBe(true);
  });

  it('contains the three foundational sources', () => {
    const ids = EMBEDDED_DEFAULT_FEDERATION.sources.map((s) => s.id);
    expect(ids).toContain('anthropic-official');
    expect(ids).toContain('futurator-internal');
    expect(ids).toContain('community');
  });

  it('marks community as non-auto-trust at priority 99', () => {
    const community = EMBEDDED_DEFAULT_FEDERATION.sources.find((s) => s.id === 'community');
    expect(community?.['auto-trust']).toBe(false);
    expect(community?.priority).toBe(99);
  });
});

describe('effectiveRefreshCadence', () => {
  const manifest: SkillFederation = {
    'manifest-version': 1,
    sources: [
      {
        id: 'anthropic-official',
        url: 'https://github.com/x',
        'auto-trust': true,
        priority: 1,
      },
      {
        id: 'community',
        url: 'https://github.com/y',
        'auto-trust': false,
        priority: 99,
        'refresh-cadence': 'daily',
      },
    ],
    'refresh-cadence': 'weekly',
  };

  it('returns manifest-level default when source has no override', () => {
    expect(effectiveRefreshCadence(manifest.sources[0]!, manifest)).toBe('weekly');
  });

  it('returns source override when present', () => {
    expect(effectiveRefreshCadence(manifest.sources[1]!, manifest)).toBe('daily');
  });
});
