import { describe, it, expect } from 'vitest';
import { compileObservableToAssert, authorProbeFlow, authorProbeFlows } from '../qa-author';
import type { SeamContract } from '../qa-boilerplate-resolver';
import type { VisualTestDef, AcceptanceCriterion } from '../../types/epic-workflow';

// Canvas-game seam shape (mirrors registry CANVAS_GAME_SNAPSHOT_SHAPE).
const GAME_SEAM: SeamContract = {
  snapshotKeys: ['status', 'score', 'tick', 'entities', 'gameOver'],
  statusEnum: ['idle', 'running', 'paused', 'over', 'win'],
  seamHook: 'useGameStateMachine',
};

function ac(partial: Partial<AcceptanceCriterion>): AcceptanceCriterion {
  return { id: 'AC-1', text: 'x', needsBrowser: true, ...partial };
}
function vt(partial: Partial<VisualTestDef>): VisualTestDef {
  return {
    id: 'VT-1',
    criteriaRef: 'AC-1',
    description: 'd',
    setup: 's',
    expect: 'e',
    ...partial,
  };
}

describe('compileObservableToAssert — QAA-2 prose→assert', () => {
  it('maps a GAME OVER synonym to status:over', () => {
    expect(compileObservableToAssert('a red GAME OVER overlay shows', GAME_SEAM)).toEqual({
      expr: 'snapshot.status',
      op: 'eq',
      expected: 'over',
    });
  });

  it('maps a literal enum token to status', () => {
    expect(compileObservableToAssert('the game status becomes paused', GAME_SEAM)).toEqual({
      expr: 'snapshot.status',
      op: 'eq',
      expected: 'paused',
    });
  });

  it('maps victory/win synonyms to status:win', () => {
    expect(compileObservableToAssert('the player wins the level', GAME_SEAM)).toEqual({
      expr: 'snapshot.status',
      op: 'eq',
      expected: 'win',
    });
  });

  it('maps "score is at least 100" to gte', () => {
    expect(compileObservableToAssert('the score is at least 100', GAME_SEAM)).toEqual({
      expr: 'snapshot.score',
      op: 'gte',
      expected: 100,
    });
  });

  it('maps "score increases" (no number) to gt 0', () => {
    expect(compileObservableToAssert('the score increases as you play', GAME_SEAM)).toEqual({
      expr: 'snapshot.score',
      op: 'gt',
      expected: 0,
    });
  });

  it('maps "score is 0" to eq 0', () => {
    expect(compileObservableToAssert('the score is 0 at start', GAME_SEAM)).toEqual({
      expr: 'snapshot.score',
      op: 'eq',
      expected: 0,
    });
  });

  it('RULE-4: does NOT invent a key the seam never publishes', () => {
    // 'lives' isn't in the snapshot shape — must not compile.
    expect(compileObservableToAssert('the player has 3 lives remaining', GAME_SEAM)).toBeNull();
  });

  it('does not map an enum value that the boilerplate did not declare', () => {
    const noWin: SeamContract = { ...GAME_SEAM, statusEnum: ['idle', 'running'] };
    expect(compileObservableToAssert('the player wins', noWin)).toBeNull();
  });

  it('returns null for empty / unmappable prose', () => {
    expect(compileObservableToAssert('', GAME_SEAM)).toBeNull();
    expect(compileObservableToAssert('it looks nice', GAME_SEAM)).toBeNull();
  });
});

describe('authorProbeFlow — QAA-1 flow synthesis', () => {
  it('authors the pamcan6 GAME OVER probe (force → waitForEvent → screenshot → assert)', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({
        verify: 'behavior',
        given: 'a game in progress',
        when: 'the player loses the last life',
        then: 'a red GAME OVER overlay appears',
        thenObservable: 'the game status becomes over',
      }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.level).toBe('L2');
    const flow = r.test.flow!;
    expect(flow[0]).toEqual({ action: 'force', status: 'over' });
    expect(flow[1]).toMatchObject({
      action: 'waitForEvent',
      expr: 'snapshot.status',
      expected: 'over',
    });
    expect(flow.some((s) => s.action === 'screenshot')).toBe(true);
    expect(flow[flow.length - 1]).toEqual({
      action: 'assert',
      expr: 'snapshot.status',
      op: 'eq',
      expected: 'over',
    });
  });

  it('uses a key-press reach when there is no status transition to force', () => {
    const r = authorProbeFlow(
      vt({}),
      ac({
        verify: 'behavior',
        when: 'the player presses the space bar',
        thenObservable: 'the score increases',
      }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.flow![0]).toEqual({ action: 'press', key: 'Space' });
    expect(r.test.flow!.some((s) => s.action === 'assert' && s.expr === 'snapshot.score')).toBe(
      true,
    );
  });

  it('keeps a test that already carries an oracle (DEV did its job)', () => {
    const existing = vt({
      level: 'L2',
      flow: [
        { action: 'press', key: 'Enter' },
        { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'running' },
      ],
    });
    const r = authorProbeFlow(
      existing,
      ac({ verify: 'behavior', thenObservable: 'status over' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('kept');
    expect(r.test).toBe(existing);
  });

  it('leaves an unmappable behavior AC flow-less (CONTRACT_INCOMPLETE will block)', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'the leaderboard shows the top 10 players' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('unmappable');
    expect(r.test.flow).toBeUndefined();
  });

  it('skips non-state/behavior ACs', () => {
    expect(authorProbeFlow(vt({}), ac({ verify: 'appearance' }), GAME_SEAM).action).toBe('skipped');
    expect(authorProbeFlow(vt({}), ac({ verify: 'build' }), GAME_SEAM).action).toBe('skipped');
  });

  it('is a no-op when no seam exists', () => {
    expect(authorProbeFlow(vt({}), ac({ verify: 'behavior' }), undefined).action).toBe('skipped');
  });
});

describe('authorProbeFlows — plan-wide pass', () => {
  it('enriches the right tests and logs authored/unmappable only', () => {
    const tests = [
      vt({ id: 'VT-1', criteriaRef: 'AC-1' }),
      vt({ id: 'VT-2', criteriaRef: 'AC-2' }),
      vt({ id: 'VT-3', criteriaRef: 'AC-3' }),
    ];
    const criteriaByRef = new Map<string, AcceptanceCriterion>([
      ['AC-1', ac({ id: 'AC-1', verify: 'behavior', thenObservable: 'status becomes over' })],
      ['AC-2', ac({ id: 'AC-2', verify: 'appearance' })],
      ['AC-3', ac({ id: 'AC-3', verify: 'state', thenObservable: 'unmappable foo bar' })],
    ]);
    const { tests: out, log } = authorProbeFlows({ tests, criteriaByRef, seam: GAME_SEAM });
    expect(out[0].flow?.length).toBeGreaterThan(0);
    expect(out[1].flow).toBeUndefined(); // appearance untouched
    expect(out[2].flow).toBeUndefined(); // unmappable left flow-less
    expect(log.map((l) => `${l.testId}:${l.action}`)).toEqual(['VT-1:authored', 'VT-3:unmappable']);
  });
});
