import { describe, it, expect } from 'vitest';
import { dispatchReadyFrontier } from '../ready-frontier.mjs';

// A → B. A is 'merging' (integrate committed, not done). B is blocked.
const nodes = () => [
  { storyId: 'A', depends_on: [], state: 'merging' },
  { storyId: 'B', depends_on: ['A'], state: 'blocked' },
];

describe('dispatchReadyFrontier — frontierMode', () => {
  it('kahn (default) does NOT surface B while A is only merging', async () => {
    const r = await dispatchReadyFrontier({ nodes: nodes(), mode: 'shadow' });
    expect(r.frontier).toEqual([]); // B needs A done under kahn
  });

  it('contract surfaces B once A is merging (contract committed)', async () => {
    const r = await dispatchReadyFrontier({ nodes: nodes(), mode: 'shadow', frontierMode: 'contract' });
    expect(r.frontier).toEqual(['B']);
  });

  it('green does NOT surface B at merging (needs verifying)', async () => {
    const r = await dispatchReadyFrontier({ nodes: nodes(), mode: 'shadow', frontierMode: 'green' });
    expect(r.frontier).toEqual([]);
  });
});
