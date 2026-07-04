import { describe, it, expect } from 'vitest';
import { mintFixStories } from '../p3-fix-story-minter';
import type { Plan } from '../../types/plan';
import type { P3QaVerdict } from '../../types/qa-review-p3';

const plan = { planId: '0372760b-e410-4288', appId: 'pacman3-746c20' } as Plan;
const now = () => '2026-07-04T00:00:00.000Z';

const verdict = (over: Partial<P3QaVerdict> = {}): P3QaVerdict => ({
  status: 'fail',
  blocking: true,
  ranAtSha: 'abcdef1234567890abcdef1234567890abcdef12',
  journeys: [],
  vqa: [],
  wiring: { orphanModules: [], blocking: false },
  ...over,
});

describe('mintFixStories', () => {
  it('mints a wiring fix story listing the orphan modules (pacman3 class)', () => {
    const rows = mintFixStories({
      plan,
      verdict: verdict({
        wiring: {
          orphanModules: ['src/game/pacman/ghost-ai.ts', 'src/game/pacman/reducer.ts'],
          blocking: true,
        },
      }),
      now,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/orphan/i);
    expect(rows[0].touches).toContain('src/game/pacman/ghost-ai.ts');
    expect(rows[0].acceptanceCriteria[0].needsBrowser).toBe(true);
    expect(rows[0].state).toBe('ready');
    expect(rows[0].depends_on).toEqual([]);
  });

  it('mints one story per blocking journey with a browser-verify AC', () => {
    const rows = mintFixStories({
      plan,
      verdict: verdict({
        journeys: [
          {
            id: 'j1',
            title: 'Move the pacman',
            acRefs: ['ac1'],
            verdict: 'fail',
            steps: [
              {
                label: 'press ArrowUp',
                action: 'press ArrowUp',
                deterministic: {
                  assertion: 'pacman y decreased',
                  passed: false,
                  detail: 'position unchanged',
                },
              },
            ],
          },
        ],
      }),
      now,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toMatch(/position unchanged/);
    expect(rows[0].acceptanceCriteria[0].verify).toBe('behavior');
  });

  it('ignores non-blocking (passing/uncertain) findings', () => {
    const rows = mintFixStories({
      plan,
      verdict: verdict({
        journeys: [{ id: 'j', title: 'ok', acRefs: [], verdict: 'pass', steps: [] }],
        vqa: [
          {
            journeyId: 'j',
            stepLabel: 's',
            verdict: 'uncertain',
            rationale: 'unsure',
            beforeShotUrl: '',
            afterShotUrl: '',
          },
        ],
      }),
      now,
    });
    expect(rows).toHaveLength(0);
  });

  it('is deterministic — same verdict yields the same story ids', () => {
    const v = verdict({ wiring: { orphanModules: ['a.ts'], blocking: true } });
    const a = mintFixStories({ plan, verdict: v, now });
    const b = mintFixStories({ plan, verdict: v, now });
    expect(a[0].storyId).toBe(b[0].storyId);
  });
});
