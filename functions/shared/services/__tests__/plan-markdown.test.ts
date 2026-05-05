import { describe, it, expect } from 'vitest';
import { planToMarkdown, parsePlanMarkdown, resolveEpicLabels } from '../plan-markdown';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow } from '../../types/epic-workflow';

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    name: 'pong-classic',
    intent: 'Create a Pong game',
    description: 'Browser Pong',
    status: 'concept',
    epicIds: ['epic-A', 'epic-B'],
    workingDir: '/home/ubuntu/projects/pong-classic',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-21T10:00:00.000Z',
    updatedAt: '2026-04-21T10:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function baseEpic(id: string, title: string, overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: id,
    title,
    description: `Goal of ${title}`,
    acceptanceCriteria: `AC-1: must work\nAC-2: must build`,
    workingDir: '/home/ubuntu/projects/pong-classic',
    status: 'draft',
    stories: [],
    createdAt: '2026-04-21T10:00:00.000Z',
    updatedAt: '2026-04-21T10:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

describe('planToMarkdown', () => {
  it('renders frontmatter + intent + description + epics header', () => {
    const plan = basePlan();
    const md = planToMarkdown(plan, []);
    expect(md).toContain('planId: plan-1');
    expect(md).toContain('name: pong-classic');
    expect(md).toContain('status: concept');
    expect(md).toContain('# Plan: pong-classic');
    expect(md).toContain('## Intent');
    expect(md).toContain('Create a Pong game');
    expect(md).toContain('## Description');
    expect(md).toContain('Browser Pong');
    expect(md).toContain('## Epics');
  });

  it('renders epics with labels, deps, goal, AC, stories', () => {
    const plan = basePlan();
    const epics = [
      baseEpic('epic-A', 'Foundation'),
      baseEpic('epic-B', 'Game Loop', {
        dependsOnEpics: ['epic-A'],
        stories: [
          {
            storyId: 'story-1',
            order: 1,
            title: 'useGameLoop Hook',
            description: 'Custom hook for the render loop',
            status: 'pending',
            wave: 0,
            touchPoints: ['src/a.ts'],
            complexity: 'standard',
            reviewRigor: 'standard',
          },
          {
            storyId: 'story-2',
            order: 2,
            title: 'useGameState Hook',
            description: 'State management for game',
            status: 'pending',
            wave: 0,
            touchPoints: ['src/b.ts'],
            complexity: 'standard',
            reviewRigor: 'standard',
            dependsOn: ['story-1'],
          },
        ],
      }),
    ];
    const md = planToMarkdown(plan, epics);

    expect(md).toContain('### Epic E1 — Foundation');
    expect(md).toContain('_(no dependencies)_');
    expect(md).toContain('### Epic E2 — Game Loop');
    expect(md).toContain('_(depends: E1)_');
    expect(md).toContain('- **S1 — useGameLoop Hook** _(no dependencies)_');
    expect(md).toContain('- **S2 — useGameState Hook** _(depends: S1)_');
  });
});

describe('parsePlanMarkdown', () => {
  it('extracts frontmatter fields', () => {
    const md = `---
planId: plan-1
name: my-app
status: developing
createdAt: 2026-04-21T10:00:00.000Z
---

# Plan: my-app

## Intent

Build something cool.`;
    const parsed = parsePlanMarkdown(md);
    expect(parsed.frontmatter.planId).toBe('plan-1');
    expect(parsed.frontmatter.name).toBe('my-app');
    expect(parsed.frontmatter.status).toBe('developing');
    expect(parsed.intent).toBe('Build something cool.');
  });

  it('parses epic tree with deps + stories', () => {
    const md = `---
planId: p1
name: my-app
status: concept
createdAt: now
---

# Plan: my-app

## Intent

do stuff.

## Epics

### Epic E1 — Foundation

  _(no dependencies)_

**Goal:** Scaffold it.

**Acceptance Criteria:**

- AC-1: builds
- AC-2: types check

#### Stories

- **S1 — Scaffold** _(no dependencies)_
  Create the initial files.
- **S2 — Core types** _(depends: S1)_
  Define the shared types.

### Epic E2 — Game Loop

  _(depends: E1)_

**Goal:** Implement the loop.

#### Stories

- **S1 — useGameLoop** _(no dependencies)_
`;
    const parsed = parsePlanMarkdown(md);
    expect(parsed.epics).toHaveLength(2);
    expect(parsed.epics[0]).toMatchObject({
      label: 'E1',
      title: 'Foundation',
      dependsOn: [],
      goal: 'Scaffold it.',
    });
    expect(parsed.epics[0].acceptanceCriteria).toBe('AC-1: builds\nAC-2: types check');
    expect(parsed.epics[0].stories).toHaveLength(2);
    expect(parsed.epics[0].stories[1]).toMatchObject({
      label: 'S2',
      title: 'Core types',
      dependsOn: ['S1'],
    });
    expect(parsed.epics[1]).toMatchObject({
      label: 'E2',
      title: 'Game Loop',
      dependsOn: ['E1'],
    });
  });
});

describe('resolveEpicLabels', () => {
  it('maps local labels to real epicIds in order', () => {
    const realIds = ['epic-A', 'epic-B', 'epic-C'];
    expect(resolveEpicLabels(['E1'], realIds)).toEqual(['epic-A']);
    expect(resolveEpicLabels(['E1', 'E3'], realIds)).toEqual(['epic-A', 'epic-C']);
    expect(resolveEpicLabels(['E99'], realIds)).toEqual([]);
  });
});
