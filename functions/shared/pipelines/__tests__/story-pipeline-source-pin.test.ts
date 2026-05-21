import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { generateStoryPipeline } from '../story-pipeline';
import type { EpicStory } from '../../types/epic-workflow';

/**
 * Story 20.12 tests — `sourceCommitSha` injects a `git checkout <sha>` into
 * the compile-commit-on-pass step BEFORE the plan-branch checkout, so the
 * plan branch starts at the pinned SHA instead of main's current HEAD.
 *
 * Verifies:
 *   - Pin emitted only when sourceCommitSha is set.
 *   - Pin appears in the shell BEFORE the plan-branch checkout block.
 *   - Without sourceCommitSha: current behavior preserved (no pin).
 *   - bash -n passes for both shell variants (no syntax regression).
 */

const story: EpicStory = {
  storyId: 'S-pin-1',
  order: 0,
  title: 'A test story',
  description: 'AC: it works.',
  status: 'pending',
  touchPoints: ['src/main.js'],
} as EpicStory;

const workingDir = '/home/ubuntu/projects/foo';
const VALID_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function findCompileCommit(pipeline: ReturnType<typeof generateStoryPipeline>) {
  const step = pipeline.steps.find((s) => 'id' in s && s.id === 'compile-commit-on-pass');
  if (!step || step.stepType !== 'shell') {
    throw new Error('compile-commit-on-pass shell step not found in pipeline');
  }
  return step.command as string;
}

describe('Story 20.12 — sourceCommitSha pin in compile-commit-on-pass', () => {
  it('emits `git checkout <sha>` BEFORE the plan-branch checkout when sourceCommitSha is set', () => {
    const pipeline = generateStoryPipeline(story, 'My epic', workingDir, {
      planSlug: 'my-plan',
      sourceCommitSha: VALID_SHA,
    });
    const shell = findCompileCommit(pipeline);

    expect(shell).toContain(`git checkout ${VALID_SHA}`);
    // Pin must precede the plan-branch block ("PLAN_BRANCH='plan/...'").
    const pinIdx = shell.indexOf(`git checkout ${VALID_SHA}`);
    const planBranchIdx = shell.indexOf("PLAN_BRANCH='plan/my-plan'");
    expect(pinIdx).toBeGreaterThanOrEqual(0);
    expect(planBranchIdx).toBeGreaterThan(pinIdx);
  });

  it('does NOT emit a pin when sourceCommitSha is absent (current behavior preserved)', () => {
    const pipeline = generateStoryPipeline(story, 'My epic', workingDir, {
      planSlug: 'my-plan',
    });
    const shell = findCompileCommit(pipeline);

    expect(shell).not.toMatch(/git checkout [a-f0-9]{40}/);
    expect(shell).toContain("PLAN_BRANCH='plan/my-plan'");
  });

  it('emits the pin even without a planSlug (pin-only, no plan-branch)', () => {
    const pipeline = generateStoryPipeline(story, 'My epic', workingDir, {
      sourceCommitSha: VALID_SHA,
    });
    const shell = findCompileCommit(pipeline);

    expect(shell).toContain(`git checkout ${VALID_SHA}`);
    expect(shell).not.toContain('PLAN_BRANCH=');
  });

  it('passes `bash -n` syntax check with sourceCommitSha set', () => {
    const pipeline = generateStoryPipeline(story, 'My epic', workingDir, {
      planSlug: 'my-plan',
      sourceCommitSha: VALID_SHA,
    });
    const shell = findCompileCommit(pipeline);
    expect(() => execSync(`bash -n -c ${JSON.stringify(shell)}`, { stdio: 'pipe' })).not.toThrow();
  });

  it('passes `bash -n` syntax check WITHOUT sourceCommitSha (no regression)', () => {
    const pipeline = generateStoryPipeline(story, 'My epic', workingDir, {
      planSlug: 'my-plan',
    });
    const shell = findCompileCommit(pipeline);
    expect(() => execSync(`bash -n -c ${JSON.stringify(shell)}`, { stdio: 'pipe' })).not.toThrow();
  });
});
