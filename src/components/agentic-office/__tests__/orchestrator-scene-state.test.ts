import { describe, expect, it } from 'vitest';
import {
  applyOrchestratorIntent,
  initialOrchestratorSceneState,
  reconcileFromStories,
} from '../scene/orchestrator-scene-state';
import type { OrchestratorAnimationIntent } from '../event-translator';
import type { EpicStory } from '@/types/epic-workflow';

function reduce(intents: OrchestratorAnimationIntent[], now = 1_000) {
  return intents.reduce(
    (s, i) => applyOrchestratorIntent(s, i, now),
    initialOrchestratorSceneState(),
  );
}

describe('orchestrator-scene-state reducer', () => {
  it('starts idle with empty maps', () => {
    const s = initialOrchestratorSceneState();
    expect(s.supervisorStatus).toBe('idle');
    expect(s.activeWaves).toEqual({});
    expect(s.deskStates).toEqual({});
    expect(s.blockerCards).toEqual({});
    expect(s.devs).toEqual({});
    expect(s.reviewers).toEqual({});
  });

  it('supervisor_dispatch updates supervisor status', () => {
    const s = reduce([{ type: 'supervisor_dispatch', status: 'dispatching', epicId: 'E1' }]);
    expect(s.supervisorStatus).toBe('dispatching');
  });

  it('supervisor_complete / supervisor_fail return to idle', () => {
    const s = reduce([
      { type: 'supervisor_dispatch', status: 'dispatching', epicId: 'E1' },
      { type: 'supervisor_complete', epicId: 'E1' },
    ]);
    expect(s.supervisorStatus).toBe('idle');

    const s2 = reduce([
      { type: 'supervisor_dispatch', status: 'dispatching', epicId: 'E1' },
      { type: 'supervisor_fail', epicId: 'E1' },
    ]);
    expect(s2.supervisorStatus).toBe('idle');
  });

  it('wave_band_activate / deactivate tracks active waves', () => {
    const s = reduce([
      { type: 'wave_band_activate', waveNumber: 1, storyIds: ['S1', 'S2'] },
      { type: 'wave_band_activate', waveNumber: 2, storyIds: ['S3'] },
      { type: 'wave_band_deactivate', waveNumber: 1, outcomes: { S1: 'done' } },
    ]);
    expect(Object.keys(s.activeWaves)).toEqual(['2']);
    expect(s.activeWaves[2]).toEqual({ storyIds: ['S3'] });
  });

  it('wave_collision_flash sets flash until now+1500', () => {
    const s = reduce([{ type: 'wave_collision_flash', waveNumber: 1 }], 1_000);
    expect(s.waveFlash).toEqual({ waveNumber: 1, until: 2_500 });
  });

  it('dev_spawn tracks the subagent and updates desk attempt', () => {
    const s = reduce([{ type: 'dev_spawn', storyId: 'S1', subagentId: 'dev-1', attempt: 1 }]);
    expect(s.devs['dev-1']).toEqual({ storyId: 'S1', attempt: 1, isRemediation: false });
    expect(s.deskStates.S1.attempt).toBe(1);
  });

  it('remediation_respawn bumps desk attempt and flags isRemediation', () => {
    const s = reduce([
      { type: 'dev_spawn', storyId: 'S1', subagentId: 'dev-1', attempt: 1 },
      { type: 'remediation_respawn', storyId: 'S1', subagentId: 'dev-2', attempt: 2 },
    ]);
    expect(s.deskStates.S1.attempt).toBe(2);
    expect(s.devs['dev-2']).toEqual({ storyId: 'S1', attempt: 2, isRemediation: true });
  });

  it('reviewer_spawn pairs with the most-recent dev for the same story', () => {
    const s = reduce([
      { type: 'dev_spawn', storyId: 'S1', subagentId: 'dev-1', attempt: 1 },
      { type: 'dev_spawn', storyId: 'S1', subagentId: 'dev-2', attempt: 2 },
      { type: 'reviewer_spawn', storyId: 'S1', subagentId: 'rev-1', attempt: 1 },
    ]);
    expect(s.reviewers['rev-1'].pairedDevSubagentId).toBe('dev-2');
  });

  it('dev_despawn and reviewer_despawn remove the subagents', () => {
    const s = reduce([
      { type: 'dev_spawn', storyId: 'S1', subagentId: 'dev-1', attempt: 1 },
      { type: 'reviewer_spawn', storyId: 'S1', subagentId: 'rev-1', attempt: 1 },
      { type: 'dev_despawn', storyId: 'S1', subagentId: 'dev-1' },
      { type: 'reviewer_despawn', storyId: 'S1', subagentId: 'rev-1' },
    ]);
    expect(s.devs).toEqual({});
    expect(s.reviewers).toEqual({});
  });

  it('blocker_card_place stores the card keyed by storyId', () => {
    const s = reduce(
      [
        {
          type: 'blocker_card_place',
          storyId: 'S1',
          blockerCode: 'ambiguous-ac',
          description: 'AC unclear',
        },
      ],
      5_000,
    );
    expect(s.blockerCards.S1).toEqual({
      storyId: 'S1',
      blockerCode: 'ambiguous-ac',
      description: 'AC unclear',
      placedAt: 5_000,
    });
  });

  it('story_desk_blocked_ring sets blocked flag; blocker_card_remove clears it', () => {
    const blocked = reduce([
      { type: 'blocker_card_place', storyId: 'S1' },
      { type: 'story_desk_blocked_ring', storyId: 'S1' },
    ]);
    expect(blocked.deskStates.S1.blocked).toBe(true);
    expect(blocked.blockerCards.S1).toBeDefined();

    const resolved = applyOrchestratorIntent(blocked, {
      type: 'blocker_card_remove',
      storyId: 'S1',
      action: 'amend',
    });
    expect(resolved.blockerCards.S1).toBeUndefined();
    expect(resolved.deskStates.S1.blocked).toBe(false);
  });

  it('story_desk_terminal_fail flags the desk', () => {
    const s = reduce([{ type: 'story_desk_terminal_fail', storyId: 'S1' }]);
    expect(s.deskStates.S1.terminalFail).toBe(true);
  });

  it('review_verdict_pulse records last verdict on the desk', () => {
    const s = reduce([
      { type: 'review_verdict_pulse', storyId: 'S1', verdict: 'REQUEST_CHANGES', attempt: 1 },
    ]);
    expect(s.deskStates.S1.lastVerdict).toBe('REQUEST_CHANGES');
  });

  it('noop returns the same state reference (no-op)', () => {
    const base = initialOrchestratorSceneState();
    const next = applyOrchestratorIntent(base, { type: 'noop', reason: 'x' });
    expect(next).toBe(base);
  });

  it('touch_points_update is visual-only — state unchanged', () => {
    const base = initialOrchestratorSceneState();
    const next = applyOrchestratorIntent(base, {
      type: 'touch_points_update',
      storyId: 'S1',
      after: ['src/a.ts'],
    });
    expect(next).toBe(base);
  });
});

describe('reconcileFromStories', () => {
  const baseStory: EpicStory = {
    storyId: 'S1',
    order: 1,
    title: 'Story 1',
    description: 'desc',
    status: 'pending',
  };

  it('matches blocker cards to the stories currently in BLOCKED status', () => {
    const stories: EpicStory[] = [
      {
        ...baseStory,
        storyId: 'S1',
        status: 'blocked',
        blocker: {
          code: 'ambiguous-ac',
          severity: 'hard',
          description: 'AC unclear',
          suggestedResolution: 'clarify',
          attemptsBeforeBlock: 1,
          reportedAt: '2026-04-17T00:00:00Z',
          reportedByAttempt: 1,
          waveNumber: 1,
        },
      },
      { ...baseStory, storyId: 'S2', status: 'done' },
      { ...baseStory, storyId: 'S3', status: 'failed' },
    ];
    const reconciled = reconcileFromStories(initialOrchestratorSceneState(), stories);

    expect(Object.keys(reconciled.blockerCards)).toEqual(['S1']);
    expect(reconciled.blockerCards.S1.blockerCode).toBe('ambiguous-ac');
    expect(reconciled.deskStates.S1.blocked).toBe(true);
    expect(reconciled.deskStates.S2.blocked).toBe(false);
    expect(reconciled.deskStates.S3.terminalFail).toBe(true);
  });

  it('drops cards for stories that are no longer blocked', () => {
    const initial = applyOrchestratorIntent(initialOrchestratorSceneState(), {
      type: 'blocker_card_place',
      storyId: 'S1',
      blockerCode: 'ambiguous-ac',
    });
    const reconciled = reconcileFromStories(initial, [
      { ...baseStory, storyId: 'S1', status: 'done' },
    ]);
    expect(reconciled.blockerCards.S1).toBeUndefined();
    expect(reconciled.deskStates.S1.blocked).toBe(false);
  });

  it('preserves original placedAt on reconcile if the card already exists', () => {
    const initial = applyOrchestratorIntent(
      initialOrchestratorSceneState(),
      { type: 'blocker_card_place', storyId: 'S1', blockerCode: 'ambiguous-ac' },
      42_000,
    );
    const stories: EpicStory[] = [
      {
        ...baseStory,
        storyId: 'S1',
        status: 'blocked',
        blocker: {
          code: 'ambiguous-ac',
          severity: 'hard',
          description: 'AC unclear',
          suggestedResolution: 'clarify',
          attemptsBeforeBlock: 1,
          reportedAt: '2026-04-17T00:00:00Z',
          reportedByAttempt: 1,
          waveNumber: 1,
        },
      },
    ];
    const reconciled = reconcileFromStories(initial, stories);
    expect(reconciled.blockerCards.S1.placedAt).toBe(42_000);
  });
});
