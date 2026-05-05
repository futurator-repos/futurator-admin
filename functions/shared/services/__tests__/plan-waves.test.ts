import { describe, it, expect } from 'vitest';
import {
  computePlanWaves,
  epicsInPlanWave,
  findFirstPlanWave,
  maxPlanWave,
} from '../plan-waves';
import type { EpicWorkflow } from '../../types/epic-workflow';

function epic(id: string, deps: string[] = []): EpicWorkflow {
  return {
    epicId: id,
    title: id,
    description: '',
    acceptanceCriteria: '',
    workingDir: '/tmp',
    status: 'draft',
    stories: [],
    dependsOnEpics: deps,
    createdAt: 'now',
    updatedAt: 'now',
    createdBy: 't',
  };
}

describe('computePlanWaves', () => {
  it('handles a single epic with no deps (wave 0)', () => {
    const result = computePlanWaves([epic('E1')]);
    expect(result).toEqual({ E1: 0 });
  });

  it('handles linear deps: E1 → E2 → E3 = [0,1,2]', () => {
    const epics = [epic('E1'), epic('E2', ['E1']), epic('E3', ['E2'])];
    expect(computePlanWaves(epics)).toEqual({ E1: 0, E2: 1, E3: 2 });
  });

  it('handles parallel epics with no deps: all wave 0', () => {
    const epics = [epic('E1'), epic('E2'), epic('E3')];
    expect(computePlanWaves(epics)).toEqual({ E1: 0, E2: 0, E3: 0 });
  });

  it('handles diamond: E1→E2, E1→E3, E2+E3→E4 = [0,1,1,2]', () => {
    const epics = [
      epic('E1'),
      epic('E2', ['E1']),
      epic('E3', ['E1']),
      epic('E4', ['E2', 'E3']),
    ];
    expect(computePlanWaves(epics)).toEqual({ E1: 0, E2: 1, E3: 1, E4: 2 });
  });

  it('ignores dep IDs not in the set (legacy/cross-plan refs)', () => {
    const epics = [epic('E1', ['missing-epic']), epic('E2', ['E1'])];
    // E1's dep is filtered → wave 0; E2 → wave 1
    expect(computePlanWaves(epics)).toEqual({ E1: 0, E2: 1 });
  });

  it('throws on cycle', () => {
    const epics = [epic('E1', ['E2']), epic('E2', ['E1'])];
    expect(() => computePlanWaves(epics)).toThrow(/cycle/);
  });
});

describe('epicsInPlanWave', () => {
  it('returns epics at a specific wave number', () => {
    const epics = [
      epic('E1'),
      epic('E2', ['E1']),
      epic('E3', ['E1']),
    ];
    const waves = computePlanWaves(epics);
    expect(epicsInPlanWave(epics, waves, 0)).toHaveLength(1);
    expect(epicsInPlanWave(epics, waves, 1)).toHaveLength(2);
  });
});

describe('findFirstPlanWave + maxPlanWave', () => {
  it('returns 0 + max wave from a set', () => {
    const waves = { a: 0, b: 0, c: 1, d: 2 };
    expect(findFirstPlanWave(waves)).toBe(0);
    expect(maxPlanWave(waves)).toBe(2);
  });

  it('returns 0/-1 for empty set', () => {
    expect(findFirstPlanWave({})).toBe(0);
    expect(maxPlanWave({})).toBe(-1);
  });
});
