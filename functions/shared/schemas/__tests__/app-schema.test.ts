import { describe, it, expect } from 'vitest';
import {
  APP_SLUG_REGEX,
  RESERVED_APP_IDS,
  appSlugSchema,
  appExecutionModeSchema,
  appWorkingTreeStatusSchema,
  appDerivedStatusSchema,
  appSchema,
  createAppInputSchema,
  updateAppInputSchema,
} from '../app-schema';

describe('APP_SLUG_REGEX', () => {
  it('accepts kebab-case slugs', () => {
    expect(APP_SLUG_REGEX.test('dino3')).toBe(true);
    expect(APP_SLUG_REGEX.test('brick-breaker')).toBe(true);
    expect(APP_SLUG_REGEX.test('a')).toBe(true);
    expect(APP_SLUG_REGEX.test('a1')).toBe(true);
    expect(APP_SLUG_REGEX.test('multi-segment-slug')).toBe(true);
  });

  it('rejects invalid slugs', () => {
    expect(APP_SLUG_REGEX.test('')).toBe(false);
    expect(APP_SLUG_REGEX.test('-leading-hyphen')).toBe(false);
    expect(APP_SLUG_REGEX.test('trailing-hyphen-')).toBe(false);
    expect(APP_SLUG_REGEX.test('double--hyphen')).toBe(false);
    expect(APP_SLUG_REGEX.test('UPPER')).toBe(false);
    expect(APP_SLUG_REGEX.test('has space')).toBe(false);
    expect(APP_SLUG_REGEX.test('has_underscore')).toBe(false);
    expect(APP_SLUG_REGEX.test('../escape')).toBe(false);
  });
});

describe('appSlugSchema', () => {
  it('accepts valid slugs', () => {
    expect(appSlugSchema.safeParse('dino3').success).toBe(true);
    expect(appSlugSchema.safeParse('brick-breaker').success).toBe(true);
  });

  it('rejects empty and over-length slugs', () => {
    expect(appSlugSchema.safeParse('').success).toBe(false);
    expect(appSlugSchema.safeParse('a'.repeat(41)).success).toBe(false);
    expect(appSlugSchema.safeParse('a'.repeat(40)).success).toBe(true);
  });

  it('rejects all reserved slugs', () => {
    for (const reserved of RESERVED_APP_IDS) {
      expect(appSlugSchema.safeParse(reserved).success).toBe(false);
    }
  });

  it('rejects malformed kebab-case', () => {
    expect(appSlugSchema.safeParse('-dino').success).toBe(false);
    expect(appSlugSchema.safeParse('dino-').success).toBe(false);
    expect(appSlugSchema.safeParse('Dino').success).toBe(false);
    expect(appSlugSchema.safeParse('dino--3').success).toBe(false);
  });
});

describe('RESERVED_APP_IDS', () => {
  it('includes the homepage S3 collision paths', () => {
    expect(RESERVED_APP_IDS.has('apps')).toBe(true);
    expect(RESERVED_APP_IDS.has('media')).toBe(true);
    expect(RESERVED_APP_IDS.has('data')).toBe(true);
    expect(RESERVED_APP_IDS.has('knowledge-live')).toBe(true);
    expect(RESERVED_APP_IDS.has('admin')).toBe(true);
    expect(RESERVED_APP_IDS.has('api')).toBe(true);
  });

  it('does NOT block ordinary product slugs', () => {
    expect(RESERVED_APP_IDS.has('dino3')).toBe(false);
    expect(RESERVED_APP_IDS.has('brick-breaker')).toBe(false);
  });
});

describe('appExecutionModeSchema', () => {
  it('accepts the two legal modes', () => {
    expect(appExecutionModeSchema.safeParse('pipeline').success).toBe(true);
    expect(appExecutionModeSchema.safeParse('orchestrator').success).toBe(true);
  });

  it('rejects unknown modes', () => {
    expect(appExecutionModeSchema.safeParse('legacy').success).toBe(false);
    expect(appExecutionModeSchema.safeParse('').success).toBe(false);
  });
});

describe('appWorkingTreeStatusSchema', () => {
  it('accepts the two states', () => {
    expect(appWorkingTreeStatusSchema.safeParse('clean').success).toBe(true);
    expect(
      appWorkingTreeStatusSchema.safeParse('dirty-from-abandoned-plan').success,
    ).toBe(true);
  });

  it('rejects unknown states', () => {
    expect(appWorkingTreeStatusSchema.safeParse('dirty').success).toBe(false);
  });
});

describe('appDerivedStatusSchema', () => {
  it('accepts the four derived states', () => {
    expect(appDerivedStatusSchema.safeParse('live').success).toBe(true);
    expect(appDerivedStatusSchema.safeParse('building').success).toBe(true);
    expect(appDerivedStatusSchema.safeParse('dirty-tree').success).toBe(true);
    expect(appDerivedStatusSchema.safeParse('no-deploy').success).toBe(true);
  });
});

describe('appSchema', () => {
  const valid = {
    appId: 'dino3',
    displayName: 'Dino Runner v3',
    icon: '🦖',
    workingDir: '/home/ubuntu/projects/dino3',
    executionMode: 'orchestrator',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
  } as const;

  it('accepts a minimal valid App', () => {
    expect(appSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a populated currentlyDeployedPlanId', () => {
    expect(
      appSchema.safeParse({ ...valid, currentlyDeployedPlanId: 'p_abc' }).success,
    ).toBe(true);
  });

  it('rejects workingDir outside /home/ubuntu/projects/', () => {
    expect(
      appSchema.safeParse({ ...valid, workingDir: '/tmp/foo' }).success,
    ).toBe(false);
    expect(
      appSchema.safeParse({ ...valid, workingDir: '/home/ubuntu/elsewhere' })
        .success,
    ).toBe(false);
  });

  it('rejects displayName over 80 chars', () => {
    expect(
      appSchema.safeParse({ ...valid, displayName: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
});

describe('createAppInputSchema', () => {
  it('accepts minimal create input', () => {
    expect(
      createAppInputSchema.safeParse({
        appId: 'dino3',
        displayName: 'Dino Runner v3',
      }).success,
    ).toBe(true);
  });

  it('accepts full create input with optional fields', () => {
    expect(
      createAppInputSchema.safeParse({
        appId: 'dino3',
        displayName: 'Dino Runner v3',
        icon: '🦖',
        executionMode: 'orchestrator',
      }).success,
    ).toBe(true);
  });

  it('rejects reserved slug', () => {
    expect(
      createAppInputSchema.safeParse({
        appId: 'apps',
        displayName: 'X',
      }).success,
    ).toBe(false);
  });

  it('rejects missing displayName', () => {
    expect(
      createAppInputSchema.safeParse({ appId: 'dino3' }).success,
    ).toBe(false);
  });
});

describe('updateAppInputSchema', () => {
  it('accepts a partial update with one field', () => {
    expect(
      updateAppInputSchema.safeParse({ displayName: 'New Name' }).success,
    ).toBe(true);
  });

  it('accepts an empty update', () => {
    expect(updateAppInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      updateAppInputSchema.safeParse({ unknownField: 'x' }).success,
    ).toBe(false);
    expect(
      updateAppInputSchema.safeParse({ appId: 'changed' }).success,
    ).toBe(false);
  });

  it('accepts workingTreeStatus mutation', () => {
    expect(
      updateAppInputSchema.safeParse({ workingTreeStatus: 'clean' }).success,
    ).toBe(true);
  });
});
