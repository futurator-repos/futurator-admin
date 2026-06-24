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
  it('Stage A.3 — a GAME OVER terminal-overlay AC routes to the HUMAN tier with a forced evidence frame', () => {
    // Operator's stated workflow (pacman3 Image 19): terminal-overlay states are
    // unreliable to reach+judge → surface for manual approval, with a forced
    // evidence screenshot so the operator has something to look at.
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
    expect(r.action).toBe('human');
    expect(r.test.humanVerify).toBe(true);
    const flow = r.test.flow!;
    expect(flow[0]).toEqual({ action: 'force', status: 'over' });
    expect(flow.some((s) => s.action === 'screenshot')).toBe(true);
    // human evidence is NOT machine-asserted (operator judges)
    expect(flow.some((s) => s.action === 'assert')).toBe(false);
  });

  it('Stage A.3 — a SUBJECTIVE quality AC ("feels responsive") routes to the human tier', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'the controls feel responsive and smooth' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('human');
    expect(r.test.humanVerify).toBe(true);
    expect(r.test.humanVerifyReason).toMatch(/subjective/i);
  });

  it('uses a key-press reach, prefixed with a start reach on a start-gated app', () => {
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
    // Gap 1 — start-gated: press ENTER to leave the start screen first…
    expect(r.test.flow![0]).toEqual({ action: 'press', key: 'Enter' });
    // …then the AC's own key-press reach, and a seam assert.
    expect(r.test.flow!.some((s) => s.action === 'press' && s.key === 'Space')).toBe(true);
    expect(r.test.flow!.some((s) => s.action === 'assert' && s.expr === 'snapshot.score')).toBe(
      true,
    );
  });

  it('does NOT prefix a start reach when the reach forces state directly', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'the game status becomes over' }),
      GAME_SEAM,
    );
    expect(r.test.flow![0]).toEqual({ action: 'force', status: 'over' });
  });

  it('FIX 2 — sets a post-interaction judge on the END state, stripping the "from title to" preamble', () => {
    // pacman3 iconic case: the judge must score the RUNNING state, not the title.
    const r = authorProbeFlow(
      vt({
        level: 'L2',
        expect:
          'After pressing Enter, the game transitions from title to running with maze, dots, pac-man, and ghosts visible',
      }),
      ac({
        verify: undefined,
        text: 'After pressing Enter, the game transitions from title to running with maze, dots, pac-man, and ghosts visible',
      }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.judge).toContain('running with maze, dots, pac-man, and ghosts visible');
    expect(r.test.judge).toMatch(/do NOT expect a title/i);
    // and it must NOT tell the judge to look for the title screen
    expect(r.test.judge).not.toMatch(/transitions from title/i);
  });

  it('Gap 2 — authors an L2-VISION probe (reach → screenshot, no assert) for a visual observable', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({
        verify: 'behavior',
        when: 'clicking the Frightened toggle button',
        thenObservable: 'all four ghosts turn into dark-blue rounded blobs with white dot eyes',
      }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.note).toMatch(/vision/i);
    // start reach (press Enter) then the click on the named control, then a screenshot…
    expect(r.test.flow!.some((s) => s.action === 'click' && s.selector === 'text=Frightened')).toBe(
      true,
    );
    expect(r.test.flow!.some((s) => s.action === 'screenshot')).toBe(true);
    // …and NO assert (the observable is visual, not a seam state).
    expect(r.test.flow!.some((s) => s.action === 'assert')).toBe(false);
  });

  it('Gap 1 — authors a start-reach for a start-gated appearance AC (gameplay content)', () => {
    const r = authorProbeFlow(
      vt({}),
      ac({ verify: 'appearance', text: 'at load the maze shows blue wall tiles' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.level).toBe('L1'); // still the cheap idle judge, just on the started frame
    expect(r.test.flow![0]).toEqual({ action: 'press', key: 'Enter' });
    expect(r.test.flow!.some((s) => s.action === 'screenshot')).toBe(true);
  });

  it('Gap 1 — leaves a start-SCREEN appearance AC idle-judged (no start reach)', () => {
    const r = authorProbeFlow(
      vt({}),
      ac({ verify: 'appearance', text: 'at load the title screen shows "Press ENTER to Start"' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('skipped');
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

  it('on a start-gated app even an unreachable observable gets a start reach (non-idle frame)', () => {
    // pacman3 fix: the floor is "different screenshot, not idle". A behavior AC
    // whose specific observable we cannot reach still gets [press Enter, screenshot]
    // so the judge sees the running game, never the identical idle frame.
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'the leaderboard shows the top 10 players' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.flow![0]).toEqual({ action: 'press', key: 'Enter' });
    expect(r.test.flow!.some((s) => s.action === 'screenshot')).toBe(true);
  });

  it('leaves a behavior AC flow-less ONLY when not start-gated and no reach is derivable', () => {
    const NON_GATED: SeamContract = { snapshotKeys: ['route'], seamHook: 'useAppHarness' };
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'the leaderboard shows the top 10 players' }),
      NON_GATED,
    );
    expect(r.action).toBe('unmappable');
    expect(r.test.flow).toBeUndefined();
  });

  it('skips build ACs, and appearance on a NON-start-gated app', () => {
    const NON_GATED: SeamContract = { snapshotKeys: ['route', 'score'], seamHook: 'useAppHarness' };
    expect(
      authorProbeFlow(vt({}), ac({ verify: 'appearance', text: 'at load a card shows' }), NON_GATED)
        .action,
    ).toBe('skipped');
    expect(authorProbeFlow(vt({}), ac({ verify: 'build' }), GAME_SEAM).action).toBe('skipped');
  });

  it('without a seam, still authors an L2-vision reach when the AC describes one', () => {
    const r = authorProbeFlow(
      vt({}),
      ac({ verify: 'behavior', when: 'the user presses the space bar', thenObservable: 'a thing' }),
      undefined,
    );
    expect(r.action).toBe('authored');
    expect(r.test.flow!.some((s) => s.action === 'press' && s.key === 'Space')).toBe(true);
    expect(r.test.flow!.some((s) => s.action === 'assert')).toBe(false); // no seam → no assert
  });

  it('without a seam and no derivable reach, returns unmappable', () => {
    const r = authorProbeFlow(
      vt({ level: 'L2' }),
      ac({ verify: 'behavior', thenObservable: 'foo bar baz' }),
      undefined,
    );
    expect(r.action).toBe('unmappable');
  });

  it('authors a flow for an OLD-PLAN L2 test with NO verify, from its expect text', () => {
    // pacman3: old plans have no `verify`. The trigger is level:'L2' + prose.
    const r = authorProbeFlow(
      vt({ level: 'L2', expect: 'After pressing ArrowRight, Pac-Man moves rightward from spawn' }),
      ac({ verify: undefined, text: 'After pressing ArrowRight, Pac-Man moves rightward' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.flow![0]).toEqual({ action: 'press', key: 'Enter' }); // start-gate
    expect(r.test.flow!.some((s) => s.action === 'press' && s.key === 'ArrowRight')).toBe(true);
  });

  it('promotes an interaction/temporal-gated test (e.g. "after a few seconds") to a waited L2 flow', () => {
    const r = authorProbeFlow(
      vt({
        level: 'L1',
        expect: 'After the game has been running for a few seconds, ghosts disperse',
      }),
      ac({ verify: undefined, text: 'After a few seconds the ghosts leave the vault' }),
      GAME_SEAM,
    );
    expect(r.action).toBe('authored');
    expect(r.test.level).toBe('L2');
    expect(r.test.flow!.some((s) => s.action === 'wait' && (s.ms ?? 0) >= 3000)).toBe(true);
  });
});

describe('authorProbeFlows — plan-wide pass', () => {
  it('enriches interaction tests, skips static/build/start-screen, logs authored only', () => {
    const tests = [
      vt({ id: 'VT-1', criteriaRef: 'AC-1' }),
      vt({ id: 'VT-2', criteriaRef: 'AC-2' }),
      vt({ id: 'VT-3', criteriaRef: 'AC-3' }),
    ];
    const criteriaByRef = new Map<string, AcceptanceCriterion>([
      // behavior with a status target → authored (force over)
      ['AC-1', ac({ id: 'AC-1', verify: 'behavior', thenObservable: 'status becomes over' })],
      // a start-SCREEN appearance AC stays idle-judged (untouched)
      [
        'AC-2',
        ac({ id: 'AC-2', verify: 'appearance', text: 'the title screen shows Press ENTER' }),
      ],
      // a build AC → skipped (no browser interaction)
      ['AC-3', ac({ id: 'AC-3', verify: 'build', text: 'the module typechecks' })],
    ]);
    const { tests: out, log } = authorProbeFlows({ tests, criteriaByRef, seam: GAME_SEAM });
    expect(out[0].flow?.length).toBeGreaterThan(0); // authored
    expect(out[1].flow).toBeUndefined(); // start-screen appearance untouched
    expect(out[2].flow).toBeUndefined(); // build skipped
    expect(log.map((l) => `${l.testId}:${l.action}`)).toEqual(['VT-1:authored']);
  });
});
