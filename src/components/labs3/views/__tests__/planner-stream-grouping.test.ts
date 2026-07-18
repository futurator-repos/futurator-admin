/**
 * groupAgentTextByPhase — pure grouping helper behind the planner
 * live-stream pane (I8 planner-stream wire). Filters `agent_text` events and
 * accumulates each phase's text in first-seen phase order.
 */

import { describe, it, expect } from 'vitest';
import { groupAgentTextByPhase } from '../planning-view';

describe('groupAgentTextByPhase', () => {
  it('ignores non-agent_text events', () => {
    const groups = groupAgentTextByPhase([
      { eventType: 'status', stepId: 'planner', text: 'should be dropped' },
      { eventType: 'agent_text', stepId: 'planner', text: 'kept' },
    ]);
    expect(groups).toEqual([{ phase: 'planner', text: 'kept' }]);
  });

  it('drops agent_text events with no text', () => {
    const groups = groupAgentTextByPhase([{ eventType: 'agent_text', stepId: 'planner' }]);
    expect(groups).toEqual([]);
  });

  it('accumulates multiple chunks within the same phase, in arrival order', () => {
    const groups = groupAgentTextByPhase([
      { eventType: 'agent_text', stepId: 'planner', text: 'Hello ' },
      { eventType: 'agent_text', stepId: 'planner', text: 'world.' },
    ]);
    expect(groups).toEqual([{ phase: 'planner', text: 'Hello world.' }]);
  });

  it('keeps separate phases distinct and orders groups by first-seen phase', () => {
    const groups = groupAgentTextByPhase([
      { eventType: 'agent_text', stepId: 'planner', text: 'planning...' },
      { eventType: 'agent_text', stepId: 'critique', text: 'critiquing...' },
      { eventType: 'agent_text', stepId: 'planner', text: ' more.' },
    ]);
    expect(groups).toEqual([
      { phase: 'planner', text: 'planning... more.' },
      { phase: 'critique', text: 'critiquing...' },
    ]);
  });

  it('falls back to phase "planner" when stepId is absent', () => {
    const groups = groupAgentTextByPhase([{ eventType: 'agent_text', text: 'no stepId' }]);
    expect(groups).toEqual([{ phase: 'planner', text: 'no stepId' }]);
  });
});
