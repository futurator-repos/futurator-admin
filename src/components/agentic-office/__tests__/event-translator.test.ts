import { describe, expect, it, vi, afterEach } from 'vitest';
import { translateOrchestratorIntent } from '../event-translator';
import type { OrchestratorEvent } from '@/types/agent-orchestrator';

function buildEvent(
  partial: Partial<OrchestratorEvent> & { eventType: string },
): OrchestratorEvent {
  return {
    jobId: 'job-1',
    ts: 1,
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('translateOrchestratorIntent', () => {
  it('epic_start → supervisor_dispatch with dispatching status', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'epic_start',
        epicId: 'EPIC-1',
        payload: { maxParallel: 4, storyCount: 6, totalWaves: 2 },
      }),
    );
    expect(intent).toEqual({
      type: 'supervisor_dispatch',
      status: 'dispatching',
      epicId: 'EPIC-1',
      maxParallel: 4,
      storyCount: 6,
      totalWaves: 2,
    });
  });

  it('epic_complete → supervisor_complete carries the summary', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'epic_complete',
        epicId: 'EPIC-1',
        payload: { storyResults: { 'STORY-1': 'done' }, totalWaves: 2 },
      }),
    );
    expect(intent).toEqual({
      type: 'supervisor_complete',
      epicId: 'EPIC-1',
      summary: { 'STORY-1': 'done' },
    });
  });

  it('epic_failed → supervisor_fail with reason', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'epic_failed',
        epicId: 'EPIC-1',
        payload: { reason: 'daemon crashed' },
      }),
    );
    expect(intent).toEqual({ type: 'supervisor_fail', epicId: 'EPIC-1', reason: 'daemon crashed' });
  });

  it('wave_start → wave_band_activate with story ids', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'wave_start',
        payload: { waveNumber: 1, storyIds: ['S1', 'S2'] },
      }),
    );
    expect(intent).toEqual({ type: 'wave_band_activate', waveNumber: 1, storyIds: ['S1', 'S2'] });
  });

  it('wave_complete → wave_band_deactivate with outcomes', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'wave_complete',
        payload: { waveNumber: 2, outcomes: { S1: 'done', S2: 'blocked' } },
      }),
    );
    expect(intent).toEqual({
      type: 'wave_band_deactivate',
      waveNumber: 2,
      outcomes: { S1: 'done', S2: 'blocked' },
    });
  });

  it('wave_split → wave_collision_flash with subWaves', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'wave_split',
        payload: { waveNumber: 1, subWaves: [['S1'], ['S2', 'S3']] },
      }),
    );
    expect(intent).toEqual({
      type: 'wave_collision_flash',
      waveNumber: 1,
      subWaves: [['S1'], ['S2', 'S3']],
    });
  });

  it('wave_collision → wave_collision_flash with files + sibling', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'wave_collision',
        storyId: 'S1',
        payload: {
          waveNumber: 1,
          siblingStoryId: 'S2',
          offendingFiles: ['src/a.ts', 'src/b.ts'],
        },
      }),
    );
    expect(intent).toEqual({
      type: 'wave_collision_flash',
      waveNumber: 1,
      storyId: 'S1',
      siblingStoryId: 'S2',
      offendingFiles: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('touch_points_expanded → touch_points_update', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'touch_points_expanded',
        storyId: 'S1',
        payload: {
          before: ['src/a.ts'],
          after: ['src/a.ts', 'src/b.ts'],
          source: 'dev-blocker',
        },
      }),
    );
    expect(intent).toEqual({
      type: 'touch_points_update',
      storyId: 'S1',
      before: ['src/a.ts'],
      after: ['src/a.ts', 'src/b.ts'],
      source: 'dev-blocker',
    });
  });

  it('subagent_dispatch (role=dev, attempt=1) → dev_spawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_dispatch',
        storyId: 'S1',
        role: 'dev',
        subagentId: 'dev-1',
        attempt: 1,
      }),
    );
    expect(intent).toEqual({
      type: 'dev_spawn',
      storyId: 'S1',
      subagentId: 'dev-1',
      attempt: 1,
    });
  });

  it('subagent_dispatch (role=dev, attempt=2) → remediation_respawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_dispatch',
        storyId: 'S1',
        role: 'dev',
        subagentId: 'dev-2',
        attempt: 2,
      }),
    );
    expect(intent).toEqual({
      type: 'remediation_respawn',
      storyId: 'S1',
      subagentId: 'dev-2',
      attempt: 2,
    });
  });

  it('subagent_dispatch (role=reviewer) → reviewer_spawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_dispatch',
        storyId: 'S1',
        role: 'reviewer',
        subagentId: 'rev-1',
        attempt: 1,
      }),
    );
    expect(intent).toEqual({
      type: 'reviewer_spawn',
      storyId: 'S1',
      subagentId: 'rev-1',
      attempt: 1,
    });
  });

  it('subagent_return (role=dev) → dev_despawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_return',
        storyId: 'S1',
        role: 'dev',
        subagentId: 'dev-1',
        payload: { durationMs: 12_345 },
      }),
    );
    expect(intent).toEqual({
      type: 'dev_despawn',
      storyId: 'S1',
      subagentId: 'dev-1',
      durationMs: 12_345,
    });
  });

  it('subagent_return (role=reviewer) → reviewer_despawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_return',
        storyId: 'S1',
        role: 'reviewer',
        subagentId: 'rev-1',
      }),
    );
    expect(intent).toEqual({
      type: 'reviewer_despawn',
      storyId: 'S1',
      subagentId: 'rev-1',
      durationMs: undefined,
    });
  });

  it('remediation_start → remediation_respawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'remediation_start',
        storyId: 'S1',
        subagentId: 'dev-2',
        attempt: 2,
      }),
    );
    expect(intent).toEqual({
      type: 'remediation_respawn',
      storyId: 'S1',
      subagentId: 'dev-2',
      attempt: 2,
    });
  });

  it('review_verdict → review_verdict_pulse with findings', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'review_verdict',
        storyId: 'S1',
        attempt: 1,
        payload: {
          verdict: 'REQUEST_CHANGES',
          findings: [{ severity: 'major', ruleId: 'R-TEST-001' }],
        },
      }),
    );
    expect(intent).toEqual({
      type: 'review_verdict_pulse',
      storyId: 'S1',
      verdict: 'REQUEST_CHANGES',
      attempt: 1,
      findings: [{ severity: 'major', ruleId: 'R-TEST-001' }],
    });
  });

  it('dev_blocker_reported → blocker_card_place', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'dev_blocker_reported',
        storyId: 'S1',
        payload: {
          blockerCode: 'ambiguous-ac',
          blockerDescription: 'AC is unclear',
        },
      }),
    );
    expect(intent).toEqual({
      type: 'blocker_card_place',
      storyId: 'S1',
      blockerCode: 'ambiguous-ac',
      description: 'AC is unclear',
    });
  });

  it('story_blocked → story_desk_blocked_ring', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'story_blocked',
        storyId: 'S1',
        payload: {
          blockerCode: 'ambiguous-ac',
          suggestedResolution: 'Specify UTC',
        },
      }),
    );
    expect(intent).toEqual({
      type: 'story_desk_blocked_ring',
      storyId: 'S1',
      blockerCode: 'ambiguous-ac',
      suggestedResolution: 'Specify UTC',
    });
  });

  it('blocker_resolved (action=amend) → blocker_card_remove', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'blocker_resolved',
        storyId: 'S1',
        payload: { action: 'amend', reason: 'clarified AC' },
      }),
    );
    expect(intent).toEqual({ type: 'blocker_card_remove', storyId: 'S1', action: 'amend' });
  });

  it('blocker_resolved with unknown action → action omitted (undefined)', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'blocker_resolved',
        storyId: 'S1',
        payload: { action: 'garbage' },
      }),
    );
    expect(intent).toEqual({ type: 'blocker_card_remove', storyId: 'S1', action: undefined });
  });

  it('story_failed_terminally → story_desk_terminal_fail', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'story_failed_terminally',
        storyId: 'S1',
        payload: { reason: 'exhausted remediation' },
      }),
    );
    expect(intent).toEqual({
      type: 'story_desk_terminal_fail',
      storyId: 'S1',
      reason: 'exhausted remediation',
    });
  });

  it('unknown event type → noop + console.warn (never throws)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const intent = translateOrchestratorIntent(buildEvent({ eventType: 'totally_made_up_event' }));
    expect(intent).toEqual({
      type: 'noop',
      reason: 'unknown event type: totally_made_up_event',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[orchestrator-translator] unknown event type: totally_made_up_event',
    );
  });

  it('subagent_dispatch with missing role defaults to dev_spawn', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'subagent_dispatch',
        storyId: 'S1',
        subagentId: 'dev-x',
      }),
    );
    expect(intent.type).toBe('dev_spawn');
  });

  it('wave_start without storyIds array defaults to []', () => {
    const intent = translateOrchestratorIntent(
      buildEvent({
        eventType: 'wave_start',
        payload: { waveNumber: 3 },
      }),
    );
    expect(intent).toEqual({ type: 'wave_band_activate', waveNumber: 3, storyIds: [] });
  });
});
