import { describe, it, expect } from 'vitest';
import { selectDeliveryTests, isJourneyTest, type DeliveryTest } from '../qa-delivery-selector';
import type { AcceptanceCriterion } from '../../types/epic-workflow';

function t(partial: Partial<DeliveryTest>): DeliveryTest {
  return {
    id: 'VT-x',
    criteriaRef: 'AC-1',
    description: 'd',
    setup: 's',
    expect: 'e',
    epicId: 'E1',
    ...partial,
  } as DeliveryTest;
}
function ac(partial: Partial<AcceptanceCriterion>): AcceptanceCriterion {
  return { id: 'AC-1', text: 'x', needsBrowser: true, ...partial };
}

describe('isJourneyTest', () => {
  it('keeps interaction-flow, human, and state/behavior tests', () => {
    expect(isJourneyTest(t({ flow: [{ action: 'press', key: 'Enter' }] }), undefined)).toBe(true);
    expect(isJourneyTest(t({ humanVerify: true }), undefined)).toBe(true);
    expect(isJourneyTest(t({}), ac({ verify: 'behavior' }))).toBe(true);
    expect(isJourneyTest(t({}), ac({ verify: 'state' }))).toBe(true);
  });
  it('does NOT auto-keep a static appearance/build test', () => {
    expect(isJourneyTest(t({}), ac({ verify: 'appearance' }))).toBe(false);
    expect(
      isJourneyTest(t({ flow: [{ action: 'screenshot' }] }), ac({ verify: 'appearance' })),
    ).toBe(false);
  });
});

describe('selectDeliveryTests — Stage B curation', () => {
  it('keeps all journeys, caps appearance per epic, defers the overflow', () => {
    const tests: DeliveryTest[] = [
      t({ id: 'beh', criteriaRef: 'AC-beh', flow: [{ action: 'press', key: 'Enter' }] }),
      t({ id: 'app1', criteriaRef: 'AC-a1', epicId: 'E1' }),
      t({ id: 'app2', criteriaRef: 'AC-a2', epicId: 'E1' }),
      t({ id: 'app3', criteriaRef: 'AC-a3', epicId: 'E1' }), // overflow (cap 2)
      t({ id: 'app4', criteriaRef: 'AC-a4', epicId: 'E2' }), // different epic → kept
    ];
    const criteriaByRef = new Map<string, AcceptanceCriterion>([
      ['AC-beh', ac({ id: 'AC-beh', verify: 'behavior' })],
      ['AC-a1', ac({ id: 'AC-a1', verify: 'appearance' })],
      ['AC-a2', ac({ id: 'AC-a2', verify: 'appearance' })],
      ['AC-a3', ac({ id: 'AC-a3', verify: 'appearance' })],
      ['AC-a4', ac({ id: 'AC-a4', verify: 'appearance' })],
    ]);
    const r = selectDeliveryTests({ tests, criteriaByRef, appearanceCapPerEpic: 2 });
    expect(r.selected.map((x) => x.id).sort()).toEqual(['app1', 'app2', 'app4', 'beh']);
    expect(r.deferred.map((x) => x.id)).toEqual(['app3']);
  });

  it("a high cap keeps everything (backward-safe = today's behavior)", () => {
    const tests: DeliveryTest[] = [
      t({ id: 'a', criteriaRef: 'AC-a', epicId: 'E1' }),
      t({ id: 'b', criteriaRef: 'AC-b', epicId: 'E1' }),
      t({ id: 'c', criteriaRef: 'AC-c', epicId: 'E1' }),
    ];
    const criteriaByRef = new Map<string, AcceptanceCriterion>([
      ['AC-a', ac({ id: 'AC-a', verify: 'appearance' })],
      ['AC-b', ac({ id: 'AC-b', verify: 'appearance' })],
      ['AC-c', ac({ id: 'AC-c', verify: 'appearance' })],
    ]);
    const r = selectDeliveryTests({ tests, criteriaByRef, appearanceCapPerEpic: Infinity });
    expect(r.selected).toHaveLength(3);
    expect(r.deferred).toHaveLength(0);
  });

  it('never defers a human or interaction test even past the cap', () => {
    const tests: DeliveryTest[] = [
      t({ id: 'app1', criteriaRef: 'AC-a1', epicId: 'E1' }),
      t({ id: 'app2', criteriaRef: 'AC-a2', epicId: 'E1' }),
      t({ id: 'human', criteriaRef: 'AC-h', epicId: 'E1', humanVerify: true }),
      t({
        id: 'beh',
        criteriaRef: 'AC-b',
        epicId: 'E1',
        flow: [{ action: 'force', status: 'over' }],
      }),
    ];
    const criteriaByRef = new Map<string, AcceptanceCriterion>([
      ['AC-a1', ac({ id: 'AC-a1', verify: 'appearance' })],
      ['AC-a2', ac({ id: 'AC-a2', verify: 'appearance' })],
    ]);
    const r = selectDeliveryTests({ tests, criteriaByRef, appearanceCapPerEpic: 2 });
    expect(r.selected.map((x) => x.id).sort()).toEqual(['app1', 'app2', 'beh', 'human']);
    expect(r.deferred).toHaveLength(0);
  });
});
