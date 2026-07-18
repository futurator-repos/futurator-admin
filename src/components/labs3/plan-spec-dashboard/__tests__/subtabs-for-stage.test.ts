import { describe, it, expect } from 'vitest';
import {
  STAGE_DEFS,
  STAGE_ORDER,
  stageIndex,
  stageDef,
  stageForStatus,
  stageForSubtab,
  isStage,
  isSubtab,
  type Labs3Stage,
} from '../constants';
import type { Plan } from '@/types/plan';

function plan(over: Partial<Plan> = {}): Plan {
  return { planId: 'p1', name: 'p1', status: 'developing', epicIds: [], ...over } as Plan;
}

describe('STAGE_DEFS — the stage-first model', () => {
  it('declares the five lifecycle stages in order', () => {
    expect(STAGE_ORDER).toEqual(['concept', 'development', 'qa', 'deployment', 'publish']);
  });

  it('each stage default subtab is a member of its own subtab set', () => {
    for (const s of STAGE_DEFS) {
      expect(s.subtabs).toContain(s.defaultSubtab);
    }
  });

  it('concept owns [plan-stage, graph] defaulting to the planner', () => {
    const c = stageDef('concept');
    expect(c.subtabs).toEqual(['plan-stage', 'graph']);
    expect(c.defaultSubtab).toBe('plan-stage');
  });

  it('development owns the six build surfaces defaulting to stories', () => {
    const d = stageDef('development');
    expect(d.subtabs).toEqual(['stories', 'graph', 'gitgraph', 'codegraph', 'stream', 'growth']);
    expect(d.defaultSubtab).toBe('stories');
  });

  it('qa / deployment / publish are single-surface stages', () => {
    expect(stageDef('qa').subtabs).toEqual(['qa']);
    expect(stageDef('deployment').subtabs).toEqual(['deploy']);
    expect(stageDef('publish').subtabs).toEqual(['publish']);
  });

  it('stageIndex mirrors lifecycle order', () => {
    expect(stageIndex('concept')).toBe(0);
    expect(stageIndex('development')).toBe(1);
    expect(stageIndex('qa')).toBe(2);
    expect(stageIndex('deployment')).toBe(3);
    expect(stageIndex('publish')).toBe(4);
  });
});

describe('stageForStatus — progress position', () => {
  it('maps concept/developing/fixing/review', () => {
    expect(stageForStatus('concept')).toBe('concept');
    expect(stageForStatus('developing')).toBe('development');
    expect(stageForStatus('fixing')).toBe('development');
    expect(stageForStatus('review')).toBe('qa');
  });

  it('delivered splits on deployUrl: deployment without, publish with', () => {
    expect(stageForStatus('delivered', plan({ status: 'delivered' }))).toBe('deployment');
    expect(
      stageForStatus(
        'delivered',
        plan({ status: 'delivered', deployUrl: 'https://x.futurator.ai/' }),
      ),
    ).toBe('publish');
  });

  it('abandoned/archived/unknown anchor at concept', () => {
    expect(stageForStatus('abandoned')).toBe('concept');
    expect(stageForStatus('archived')).toBe('concept');
  });
});

describe('stageForSubtab — legacy ?subtab= back-compat', () => {
  it('resolves each subtab to the earliest owning stage', () => {
    const cases: [string, Labs3Stage][] = [
      ['plan-stage', 'concept'],
      ['graph', 'concept'], // present in concept AND development → earliest wins
      ['stories', 'development'],
      ['gitgraph', 'development'],
      ['codegraph', 'development'],
      ['stream', 'development'],
      ['growth', 'development'],
      ['qa', 'qa'],
      ['deploy', 'deployment'],
      ['publish', 'publish'],
    ];
    for (const [subtab, stage] of cases) {
      expect(stageForSubtab(subtab as never)).toBe(stage);
    }
  });
});

describe('isStage / isSubtab narrowing', () => {
  it('accepts valid ids, rejects junk and null', () => {
    expect(isStage('development')).toBe(true);
    expect(isStage('nope')).toBe(false);
    expect(isStage(null)).toBe(false);
    expect(isSubtab('publish')).toBe(true);
    expect(isSubtab('bogus')).toBe(false);
    expect(isSubtab(undefined)).toBe(false);
  });
});
