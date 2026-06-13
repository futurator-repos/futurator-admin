/**
 * git-graph-insights tests — dino1 UX pass (2026-06-13). Uses the real commit
 * subjects observed in the dino1 GitGraph.
 */

import { describe, expect, it } from 'vitest';
import {
  buildStoryMap,
  classifyCommit,
  groupByEpicWave,
  type StoryMap,
} from '../git-graph-insights';

const S_TYPES = '205b1d69-17d2-4df4-8ce9-6d81319aa3ab';
const S_FOOD = '56505641-c1dc-4642-b96c-22b1f4b22b8c';
const S_ASSEMBLE = '1e1e0eea-729d-4f77-aaf7-731a510d9104';

const storyMap: StoryMap = buildStoryMap([
  {
    epicId: 'E1',
    title: 'Snake Domain Foundation',
    order: 0,
    stories: [{ storyId: S_TYPES, title: 'Define Snake types & constants', order: 0 }],
  },
  {
    epicId: 'E3',
    title: 'Visual & Audio Components',
    order: 2,
    stories: [{ storyId: S_FOOD, title: 'Food pellet & grid renderer', order: 0 }],
  },
  {
    epicId: 'E4',
    title: 'Game Assembly',
    order: 3,
    stories: [{ storyId: S_ASSEMBLE, title: 'Assemble full Snake game', order: 0 }],
  },
]);

describe('classifyCommit — plain-language labels', () => {
  it('story commit → title substituted, not the UUID', () => {
    const c = classifyCommit(
      `story: ${S_TYPES} — Define Snake domain types and game constants`,
      storyMap,
    );
    expect(c.kind).toBe('story');
    expect(c.icon).toBe('✍️');
    expect(c.label).toBe('Built — Define Snake types & constants');
    expect(c.label).not.toContain(S_TYPES);
    expect(c.isMachine).toBe(false);
    expect(c.epicId).toBe('E1');
  });

  it('merge commit → friendly, story title, drops the verbose conflict list', () => {
    const c = classifyCommit(
      `merge story ${S_FOOD} into wave [auto-resolved: src/components/canvas/BackgroundRender.tsx; mechanical: .mycelium/ast-facts.json (theirs)]\n\nWave: 0\nEpic-Id: E3`,
      storyMap,
    );
    expect(c.kind).toBe('merge');
    expect(c.label).toBe('Merged into wave — Food pellet & grid renderer');
    expect(c.label).not.toContain('BackgroundRender');
    expect(c.wave).toBe(0);
    expect(c.epicId).toBe('E3');
  });

  it('knowledge commit is classified as a hidden machine commit', () => {
    const c = classifyCommit(`knowledge: story ${S_FOOD} compile artifacts`, storyMap);
    expect(c.kind).toBe('knowledge');
    expect(c.isMachine).toBe(true);
  });

  it('wave-level commits resolve epic from the Epic-Id trailer', () => {
    const buildFix = classifyCommit(
      'wave 0: agentic build-fix (attempt 1)\n\nEpic-Id: E3\nWave: 0',
      storyMap,
    );
    expect(buildFix.kind).toBe('build-fix');
    expect(buildFix.label).toBe('Auto-fixed the build');
    expect(buildFix.epicId).toBe('E3');

    const vqa = classifyCommit(
      'wave 0: vqa report — 5 verdict(s), 1 fix(es), 0 fix-forward\n\nEpic-Id: E4\nWave: 0',
      storyMap,
    );
    expect(vqa.kind).toBe('vqa');
    expect(vqa.icon).toBe('👁️');

    const regen = classifyCommit('wave 0: regenerated files from post-merge validation', storyMap);
    expect(regen.kind).toBe('regenerated');
    expect(regen.isMachine).toBe(true);
  });

  it('lifecycle commits get friendly milestones', () => {
    expect(classifyCommit('Initial commit').label).toBe('Project created');
    expect(classifyCommit('chore: post-create scaffold (__APP_SLUG__ -> dino1)').kind).toBe(
      'scaffold',
    );
    expect(classifyCommit('chore(skills): operator-confirm — 2 proposal(s)').kind).toBe('skills');
  });

  it('unknown story id falls back to a short hash, never crashes', () => {
    const c = classifyCommit('story: 00000000-0000-0000-0000-000000000000 — Some title', {});
    expect(c.label).toBe('Built — Some title');
    const k = classifyCommit(
      'knowledge: story 00000000-0000-0000-0000-000000000000 compile artifacts',
      {},
    );
    expect(k.label).toBe('Saved knowledge — #00000000');
  });
});

describe('groupByEpicWave', () => {
  it('groups commits Epic → Wave, epics in order, setup commits first', () => {
    const metas = [
      classifyCommit('Initial commit'),
      classifyCommit(`story: ${S_ASSEMBLE} — Assemble`, storyMap), // E4
      classifyCommit(`story: ${S_TYPES} — Types`, storyMap), // E1
      classifyCommit(`story: ${S_FOOD} — Food`, storyMap), // E3
    ];
    const groups = groupByEpicWave(metas);
    expect(groups.map((g) => g.epicTitle)).toEqual([
      'Setup & lifecycle',
      'Snake Domain Foundation',
      'Visual & Audio Components',
      'Game Assembly',
    ]);
    expect(groups[0].epicId).toBeNull();
  });

  it('within an epic, waves are newest-first and indices preserved', () => {
    const metas = [
      classifyCommit(`story: ${S_FOOD} — Food\n\nWave: 1\nEpic-Id: E3`, storyMap),
      classifyCommit(`merge story ${S_FOOD} into wave\n\nWave: 0\nEpic-Id: E3`, storyMap),
    ];
    const groups = groupByEpicWave(metas);
    const e3 = groups.find((g) => g.epicId === 'E3')!;
    expect(e3.waves.map((w) => w.wave)).toEqual([1, 0]);
    expect(e3.commitCount).toBe(2);
  });
});
