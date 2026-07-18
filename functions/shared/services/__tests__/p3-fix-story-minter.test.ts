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

  it('mints a fix story from a blocking agentic finding (kind agentic) using the note as seed', () => {
    const rows = mintFixStories({
      plan,
      verdict: {
        ...verdict(),
        // agentic report attached at runtime (schemaless) — not on the typed
        // P3QaVerdict; the minter reads it through a local augmentation.
        agentic: {
          runs: [
            {
              journeyId: 'j-start',
              findings: [
                {
                  severity: 'blocking',
                  note: 'the Start button does nothing — journey cannot begin',
                },
                { severity: 'attention', note: 'minor: score font is small' },
              ],
            },
          ],
        },
      } as P3QaVerdict,
      now,
    });
    expect(rows).toHaveLength(1); // only the blocking finding mints; attention is advisory
    expect(rows[0].title).toMatch(/agentic play-test/i);
    expect(rows[0].intent).toMatch(/Start button does nothing/);
    expect(rows[0].acceptanceCriteria[0].text).toMatch(/Start button does nothing/);
    expect(rows[0].acceptanceCriteria[0].needsBrowser).toBe(true);
    expect(rows[0].state).toBe('ready');
  });

  it('ignores agentic runs with only attention findings', () => {
    const rows = mintFixStories({
      plan,
      verdict: {
        ...verdict({ status: 'uncertain', blocking: false }),
        agentic: { runs: [{ journeyId: 'j', findings: [{ severity: 'attention', note: 'nit' }] }] },
      } as P3QaVerdict,
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

  it('seam-not-mounted → ONE seam story with the wiring contract; redundant journey stories suppressed', () => {
    const rows = mintFixStories({
      plan,
      verdict: verdict({
        journeys: [
          {
            id: 'j1',
            title: 'Play the game',
            acRefs: ['ac1'],
            verdict: 'fail',
            steps: [
              {
                label: 's1',
                action: 'press ArrowUp',
                deterministic: {
                  assertion: 'x moves',
                  passed: false,
                  detail: 'window.__harness seam not mounted on the served app',
                },
              },
            ],
          },
          {
            id: 'j2',
            title: 'Score journey',
            acRefs: ['ac2'],
            verdict: 'fail',
            steps: [
              {
                label: 's2',
                action: 'press Space',
                deterministic: {
                  assertion: 'score grows',
                  passed: false,
                  detail: 'window.__harness seam not mounted on the served app',
                },
              },
            ],
          },
        ],
      }),
      seamHook: 'useGameStateMachine',
      now,
    });
    expect(rows).toHaveLength(1); // one seam story, no per-journey noise
    expect(rows[0].title).toMatch(/Mount the window\.__harness/);
    // The hook name comes from BOILERPLATE metadata (the seamHook arg), never
    // a pipeline constant — passing it must surface it in the story intent.
    expect(rows[0].intent).toMatch(/useGameStateMachine/);
    expect(rows[0].state).toBe('ready');
  });

  it('non-seam failures alongside a seam failure depend_on the seam story (frontier ordering)', () => {
    const rows = mintFixStories({
      plan,
      verdict: verdict({
        journeys: [
          {
            id: 'j1',
            title: 'Seam-blind journey',
            acRefs: ['ac1'],
            verdict: 'fail',
            steps: [
              {
                label: 's1',
                action: 'load',
                deterministic: {
                  assertion: 'seam',
                  passed: false,
                  detail: 'window.__harness seam not mounted on the served app',
                },
              },
            ],
          },
        ],
        wiring: { orphanModules: ['src/game/ghost-ai.ts'], blocking: true },
      }),
      now,
    });
    const seam = rows.find((r) => r.title.startsWith('Mount the window.__harness'))!;
    const orphan = rows.find((r) => r.title.match(/orphan/i))!;
    expect(seam.depends_on).toEqual([]);
    expect(orphan.depends_on).toEqual([seam.storyId]);
    expect(orphan.state).toBe('blocked');
  });
});
