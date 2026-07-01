import { describe, it, expect } from 'vitest';
import {
  buildQuickPlanspecPrompt,
  parseQuickPlanspec,
  buildStoryNodeRows,
} from '../quick-planspec.mjs';

const SPEC = JSON.stringify({
  stories: [
    { title: 'Define game types and constants', intent: 'foundation', touches: ['src/types.ts'],
      acceptanceCriteria: [{ text: 'types compile with no tsc errors', verify: 'build' }], complexity: 'standard' },
    { title: 'Implement the dino entity', intent: 'feature', touches: ['src/dino.ts'],
      acceptanceCriteria: [{ text: 'dino jumps when Space pressed', verify: 'state', needsBrowser: true,
        when: 'press Space', thenObservable: "snapshot.status equals 'running'" }] },
    { title: 'Assemble the complete game', intent: 'integration', touches: ['src/app.tsx'],
      acceptanceCriteria: [{ text: 'the game renders and runs end to end', verify: 'behavior', needsBrowser: true }] },
  ],
});

describe('buildQuickPlanspecPrompt', () => {
  it('embeds the idea, the harness contract, and the PLAN_SPEC output tags', () => {
    const p = buildQuickPlanspecPrompt({ intent: 'a dino runner game', appSlug: 'dino9' });
    expect(p).toContain('a dino runner game');
    expect(p).toContain('window.__harness');
    expect(p).toContain('<PLAN_SPEC>');
    expect(p).toMatch(/NO epics/i);
  });
});

describe('parseQuickPlanspec', () => {
  it('extracts stories, assigns ids, and derives foundation→feature→integration deps', () => {
    const { stories, errors } = parseQuickPlanspec(`chatter…\n<PLAN_SPEC>${SPEC}</PLAN_SPEC>\nmore`);
    expect(errors).toEqual([]);
    expect(stories).toHaveLength(3);
    const [found, feat, integ] = stories;
    expect(found.storyId).toMatch(/[0-9a-f-]{36}/);
    expect(found.depends_on).toEqual([]); // foundation
    expect(feat.depends_on).toEqual([found.storyId]); // feature → foundation
    expect(integ.depends_on.sort()).toEqual([found.storyId, feat.storyId].sort()); // integration → all
    // AC coercion
    expect(feat.acceptanceCriteria[0].needsBrowser).toBe(true);
    expect(feat.acceptanceCriteria[0].acClass).toBe('deterministic');
    expect(found.acceptanceCriteria[0].testBinding.status).toBe('unbound');
  });

  it('tolerates a bare/fenced JSON object (no tags)', () => {
    const { stories } = parseQuickPlanspec('```json\n' + SPEC + '\n```');
    expect(stories).toHaveLength(3);
  });

  it('reports an error when there is no parseable spec', () => {
    const { stories, errors } = parseQuickPlanspec('the model refused and wrote prose only');
    expect(stories).toEqual([]);
    expect(errors[0]).toMatch(/no <PLAN_SPEC>/);
  });

  it('appearance ACs become advisory-taste; missing ACs synthesize one', () => {
    const { stories } = parseQuickPlanspec(
      `<PLAN_SPEC>${JSON.stringify({ stories: [
        { title: 'Show splash', acceptanceCriteria: [{ text: 'the splash looks right', verify: 'appearance', needsBrowser: true }] },
        { title: 'No criteria story' },
      ] })}</PLAN_SPEC>`,
    );
    expect(stories[0].acceptanceCriteria[0].acClass).toBe('advisory-taste');
    expect(stories[1].acceptanceCriteria).toHaveLength(1); // synthesized
  });
});

describe('buildStoryNodeRows', () => {
  it('assigns cohortBatch levels + ready/blocked from the derived DAG', () => {
    const { stories } = parseQuickPlanspec(`<PLAN_SPEC>${SPEC}</PLAN_SPEC>`);
    const { rows, summary } = buildStoryNodeRows({ stories, planId: 'p1', appId: 'a1', now: () => 'T' });
    expect(summary).toEqual({ stories: 3, ready: 1, blocked: 2, maxBatch: 2 });
    const byBatch = rows.map((r) => r.cohortBatch).sort();
    expect(byBatch).toEqual([0, 1, 2]);
    const found = rows.find((r) => r.title.includes('types'));
    expect(found.state).toBe('ready');
    expect(found.unblockedDepsCount).toBe(0);
    expect(found.planId).toBe('p1');
    expect(found.createdAt).toBe('T');
  });
});
