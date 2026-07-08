import { describe, it, expect } from 'vitest';
import {
  invariantStatusSchema,
  invariantValidatorSchema,
  invariantSchema,
  storyNodeSchema,
  testBindingStatusSchema,
} from '../plan-spec-schema';

/**
 * Reality-Spine (redesign Part 4 + Part 5 #6/#7): invariants are first-class
 * plan artifacts — planner DECLARES a property of the domain data, the
 * foundation story AUTHORS a validator, the gate RUNS it. These schemas gate
 * the wire shape at ingest.
 */
describe('invariantStatusSchema', () => {
  it('accepts the four lifecycle states', () => {
    for (const s of ['declared', 'authored', 'passing', 'failing']) {
      expect(invariantStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(invariantStatusSchema.safeParse('done').success).toBe(false);
  });
});

describe('invariantValidatorSchema', () => {
  it('defaults status to declared when omitted', () => {
    const parsed = invariantValidatorSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.status).toBe('declared');
  });

  it('accepts a fully-authored validator', () => {
    const parsed = invariantValidatorSchema.safeParse({
      ref: 'scripts/invariants/maze-reachable.mjs',
      kind: 'script',
      status: 'passing',
      lastRunSha: 'abc123',
      lastRunAt: '2026-07-08T00:00:00.000Z',
      detail: 'all pellets reachable',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(invariantValidatorSchema.safeParse({ kind: 'shell-script' }).success).toBe(false);
  });
});

describe('invariantSchema', () => {
  it('requires a non-empty id and a description of at least 5 chars', () => {
    expect(invariantSchema.safeParse({ id: '', description: 'valid enough' }).success).toBe(false);
    expect(invariantSchema.safeParse({ id: 'x', description: 'ab' }).success).toBe(false);
  });

  it('defaults the validator to { status: "declared" } when omitted', () => {
    const parsed = invariantSchema.safeParse({
      id: 'maze-reachable',
      description: 'every pellet is reachable',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.validator).toEqual({ status: 'declared' });
  });
});

describe('testBindingStatusSchema', () => {
  it('accepts the new "misbound" status (no-mock rule for state ACs)', () => {
    expect(testBindingStatusSchema.safeParse('misbound').success).toBe(true);
  });

  it('still accepts the legacy statuses', () => {
    for (const s of ['unbound', 'bound', 'passing', 'failing']) {
      expect(testBindingStatusSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe('storyNodeSchema — invariants + foundation-marker fields', () => {
  const baseStory = {
    storyId: 's1',
    cohort: { epicId: 'quick' },
    title: 'Define the contract types',
    acceptanceCriteria: [
      {
        id: 'ac1',
        text: 'types compile clean',
        testBinding: { status: 'unbound' },
        acClass: 'deterministic',
      },
    ],
    touches: ['src/types.ts'],
  };

  it('defaults invariants to an empty array when omitted', () => {
    const parsed = storyNodeSchema.safeParse(baseStory);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.invariants).toEqual([]);
  });

  it('accepts nodeKind/isFoundation/invariants together', () => {
    const parsed = storyNodeSchema.safeParse({
      ...baseStory,
      nodeKind: 'foundation',
      isFoundation: true,
      invariants: [
        { id: 'maze-reachable', description: 'every pellet cell has a path to the exit' },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.nodeKind).toBe('foundation');
      expect(parsed.data.isFoundation).toBe(true);
      expect(parsed.data.invariants).toHaveLength(1);
      expect(parsed.data.invariants[0].validator.status).toBe('declared');
    }
  });

  it('rejects an unknown nodeKind', () => {
    expect(storyNodeSchema.safeParse({ ...baseStory, nodeKind: 'glue' }).success).toBe(false);
  });

  it('rejects an invariant with too-short a description', () => {
    expect(
      storyNodeSchema.safeParse({ ...baseStory, invariants: [{ id: 'x', description: 'ab' }] })
        .success,
    ).toBe(false);
  });

  it('accepts a testBinding with status "misbound" on a story AC', () => {
    const parsed = storyNodeSchema.safeParse({
      ...baseStory,
      acceptanceCriteria: [
        {
          id: 'ac1',
          text: 'types compile clean',
          testBinding: { status: 'misbound', detail: 'bound test mocks the module under test' },
          acClass: 'deterministic',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
