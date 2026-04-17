import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '../../types/agent-orchestrator';
import { renderFlatLog, filterEvents } from '../flat-log';

function evt(partial: Partial<AgentEvent>): AgentEvent {
  return {
    jobId: 'job-1',
    eventSeq: '000001',
    seq: 1,
    timestamp: '2026-04-17T00:00:00.000Z',
    stepId: '-',
    agentId: 'orchestrator',
    eventType: 'wave_start',
    expireAt: 9_999_999_999,
    ...partial,
  } as AgentEvent;
}

describe('renderFlatLog', () => {
  it('renders hierarchical prefix with all correlation fields populated', () => {
    const out = renderFlatLog([
      evt({
        epicId: 'EPIC-1',
        waveNumber: 2,
        storyId: 'STORY-3',
        role: 'dev',
        attempt: 1,
        eventType: 'subagent_return',
      }),
    ]);
    expect(out).toContain('EPIC-1/wave-2/STORY-3/dev/1/subagent_return');
    expect(out).toMatch(/^2026-04-17T00:00:00\.000Z /);
  });

  it('uses "-" for missing correlation fields', () => {
    const out = renderFlatLog([evt({ epicId: 'EPIC-X', eventType: 'epic_start' })]);
    expect(out).toContain('EPIC-X/-/-/-/-/epic_start');
  });

  it('inlines known scalar payload keys as k=v', () => {
    const out = renderFlatLog([
      evt({
        epicId: 'E',
        waveNumber: 1,
        eventType: 'review_verdict',
        payload: { verdict: 'pass', tier: 'strict' },
      }),
    ]);
    expect(out).toMatch(/verdict=pass.*tier=strict|tier=strict.*verdict=pass/);
  });

  it('quotes inline values containing whitespace', () => {
    const out = renderFlatLog([
      evt({
        epicId: 'E',
        eventType: 'status',
        payload: { reason: 'build failed twice' },
      }),
    ]);
    expect(out).toContain('reason="build failed twice"');
  });

  it('wraps multi-line payload fields with indent under parent line', () => {
    const out = renderFlatLog([
      evt({
        epicId: 'E',
        waveNumber: 1,
        storyId: 'S',
        role: 'reviewer',
        attempt: 1,
        eventType: 'review_verdict',
        payload: {
          verdict: 'fail',
          findings: 'rule-1: failed\nrule-2: failed',
        },
      }),
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('review_verdict');
    expect(lines[1]).toBe('  findings:');
    expect(lines[2]).toBe('    rule-1: failed');
    expect(lines[3]).toBe('    rule-2: failed');
  });

  it('omits timestamp when includeTimestamp is false', () => {
    const out = renderFlatLog([evt({ epicId: 'E', eventType: 'epic_start' })], {
      includeTimestamp: false,
    });
    expect(out.startsWith('E/')).toBe(true);
  });

  it('returns empty string for no events', () => {
    expect(renderFlatLog([])).toBe('');
  });

  it('renders tool_use with tool name inline', () => {
    const out = renderFlatLog([evt({ epicId: 'E', eventType: 'tool_use', toolName: 'Bash' })]);
    expect(out).toContain('tool=Bash');
  });

  it('truncates long inline text', () => {
    const long = 'x'.repeat(300);
    const out = renderFlatLog([evt({ epicId: 'E', eventType: 'text_delta', text: long })]);
    expect(out).toMatch(/text=x{119}…/);
  });

  it('emits one line per event with trailing newline', () => {
    const out = renderFlatLog([
      evt({ epicId: 'E', eventType: 'epic_start', seq: 1, eventSeq: '000001' }),
      evt({ epicId: 'E', eventType: 'wave_start', seq: 2, eventSeq: '000002' }),
    ]);
    expect(out.split('\n')).toHaveLength(3); // 2 events + trailing empty
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('filterEvents', () => {
  const base: AgentEvent[] = [
    evt({
      seq: 1,
      eventSeq: '000001',
      timestamp: '2026-04-17T00:00:00.000Z',
      role: 'orchestrator',
      waveNumber: 1,
      storyId: undefined,
    }),
    evt({
      seq: 2,
      eventSeq: '000002',
      timestamp: '2026-04-17T00:00:01.000Z',
      role: 'dev',
      waveNumber: 1,
      storyId: 'S-1',
    }),
    evt({
      seq: 3,
      eventSeq: '000003',
      timestamp: '2026-04-17T00:00:02.000Z',
      role: 'reviewer',
      waveNumber: 2,
      storyId: 'S-2',
    }),
  ];

  it('filters by since timestamp (inclusive)', () => {
    const out = filterEvents(base, { since: '2026-04-17T00:00:01.000Z' });
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('filters by role', () => {
    const out = filterEvents(base, { role: 'dev' });
    expect(out.map((e) => e.seq)).toEqual([2]);
  });

  it('filters by storyId', () => {
    const out = filterEvents(base, { storyId: 'S-2' });
    expect(out.map((e) => e.seq)).toEqual([3]);
  });

  it('filters by wave number', () => {
    const out = filterEvents(base, { wave: 1 });
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('applies limit', () => {
    const out = filterEvents(base, { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('combines filters', () => {
    const out = filterEvents(base, { wave: 1, role: 'dev' });
    expect(out.map((e) => e.seq)).toEqual([2]);
  });
});
