import { describe, it, expect } from 'vitest';
import { subtabsForStage, defaultSubtabForStage } from '../constants';

describe('subtabsForStage', () => {
  it('concept → plan-stage, graph', () => {
    expect(subtabsForStage('concept')).toEqual(['plan-stage', 'graph']);
  });

  it('developing/fixing → graph, stories, gitgraph, stream, codegraph', () => {
    const expected = ['graph', 'stories', 'gitgraph', 'stream', 'codegraph'];
    expect(subtabsForStage('developing')).toEqual(expected);
    expect(subtabsForStage('fixing')).toEqual(expected);
  });

  it('review → qa, stories, gitgraph, stream, deploy', () => {
    expect(subtabsForStage('review')).toEqual(['qa', 'stories', 'gitgraph', 'stream', 'deploy']);
  });

  it('delivered → deploy, qa, codegraph, gitgraph, growth', () => {
    expect(subtabsForStage('delivered')).toEqual([
      'deploy',
      'qa',
      'codegraph',
      'gitgraph',
      'growth',
    ]);
  });

  it('statuses outside the union (abandoned/archived) show every tab', () => {
    expect(subtabsForStage('abandoned')).toEqual([
      'plan-stage',
      'graph',
      'codegraph',
      'gitgraph',
      'stories',
      'qa',
      'growth',
      'stream',
      'deploy',
    ]);
    expect(subtabsForStage('archived')).toHaveLength(9);
  });
});

describe('defaultSubtabForStage', () => {
  it('is the first tab in each stage set', () => {
    expect(defaultSubtabForStage('concept')).toBe('plan-stage');
    expect(defaultSubtabForStage('developing')).toBe('graph');
    expect(defaultSubtabForStage('review')).toBe('qa');
    expect(defaultSubtabForStage('delivered')).toBe('deploy');
  });
});
