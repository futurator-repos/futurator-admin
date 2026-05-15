import { describe, it, expect } from 'vitest';
import { generateStoryPipeline } from '../story-pipeline';
import type { EpicStory } from '../../types/epic-workflow';

const story: EpicStory = {
  storyId: 'S-1',
  order: 0,
  title: 'A test story',
  description: 'AC: it works.',
  status: 'pending',
  touchPoints: ['src/main.js'],
} as EpicStory;

const workingDir = '/home/ubuntu/projects/foo';

/**
 * PR-36 — baseline-regression step coverage.
 *
 * The step lands between `tamper-check` (production-only) and `review`,
 * runs only at mvp+ rigor (skipped under prototype), and shells out to
 * `scripts/check-regressions.sh` per
 * docs/concepts/pipeline-v2/baseline-diff-design.md §3.2.
 */

describe('PR-52 — compile-diff EMPTY_DIFF graceful (no false attention on retry)', () => {
  it('compile-diff exits 0 with EMPTY_DIFF_BY_DESIGN marker when nothing in scope', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-diff');
    expect(step?.stepType).toBe('shell');
    expect(step?.command).toContain('EMPTY_DIFF_BY_DESIGN');
    // Empty path now exits 0, NOT 1 (the loud-fail).
    expect(step?.command).toContain('exit 0;');
    expect(step?.command).not.toContain("'EMPTY_DIFF: per-story commit");
  });
});

describe('PR-41 — tamper-check promoted to mvp+ rigor (Story 2-A-5-1)', () => {
  it('prototype rigor — tamper-check absent', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('tamper-check');
  });

  it('mvp rigor — tamper-check present (newly enabled by PR-41)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('tamper-check');
  });

  it('production rigor — tamper-check still present (was already enabled)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'production',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('tamper-check');
  });

  it('tamper-check sits between test-verify and baseline-regression', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids.indexOf('tamper-check')).toBeGreaterThan(ids.indexOf('test-verify'));
    expect(ids.indexOf('tamper-check')).toBeLessThan(ids.indexOf('baseline-regression'));
  });
});

describe('PR-40 — single-pass test-verify (Story 2-A-6-1)', () => {
  it('test-verify uses vitest --changed HEAD~1 with npm test fallback', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'test-verify');
    expect(step?.stepType).toBe('shell');
    expect(step?.command).toContain('npx vitest run --changed HEAD~1');
    expect(step?.command).toContain('|| npm test');
  });

  it('DEV prompt forbids running tests (single-pass discipline)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const dev = pipeline.steps.find((s) => s.id === 'dev');
    expect(dev?.prompt).toMatch(/Do NOT run.*npm test/);
    expect(dev?.prompt).toMatch(/single-pass/i);
  });

  it('test-verify still skipped under prototype rigor (no test-on)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('test-verify');
  });
});

describe('PR-36 baseline-regression step', () => {
  it('prototype rigor — step is absent', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('baseline-regression');
  });

  it('mvp rigor — step is present and after dev/test-verify, before review', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('baseline-regression');
    expect(ids.indexOf('baseline-regression')).toBeGreaterThan(ids.indexOf('test-verify'));
    expect(ids.indexOf('baseline-regression')).toBeLessThan(ids.indexOf('review'));
  });

  it('production rigor — step lands after tamper-check, before review', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'production',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('tamper-check');
    expect(ids).toContain('baseline-regression');
    expect(ids).toContain('review');
    expect(ids.indexOf('baseline-regression')).toBeGreaterThan(ids.indexOf('tamper-check'));
    expect(ids.indexOf('baseline-regression')).toBeLessThan(ids.indexOf('review'));
  });

  it('shell command threads PROJECT_DIR + RIGOR env to check-regressions.sh', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'baseline-regression');
    expect(step?.stepType).toBe('shell');
    expect(step?.command).toContain('PROJECT_DIR=' + workingDir);
    expect(step?.command).toContain('RIGOR=mvp');
    expect(step?.command).toContain('scripts/check-regressions.sh');
  });

  it('soft-skips when scripts/check-regressions.sh is missing (brownfield apps)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'baseline-regression');
    // The skip path keeps the gate from blocking apps that pre-date PR-35.
    expect(step?.command).toContain('BASELINE_GATE_SKIPPED');
    expect(step?.command).toContain('exit 0');
  });

  it('captureAs/onFail wired so daemon sees regressions as step failures', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'baseline-regression');
    expect(step?.captureAs).toBe('BASELINE_OUTPUT');
    expect(step?.expectExitCode).toBe(0);
    expect(step?.onFail?.action).toBe('fail');
    expect(step?.onFail?.injectAs).toBe('BASELINE_ERROR');
  });
});

/**
 * PR-67 (2026-05-15) — compile-commit-on-pass non-empty diff guard.
 *
 * spyhunter-1 forensic 2026-05-13: a commit titled "Wire boss spawn..."
 * contained only .pipeline/tamper-input.txt + node_modules/.vite/...
 * + visual-tests.md — zero source code. With --allow-empty the story
 * marked itself done while its implementation sat untracked in the
 * working tree. The guard fails the step when nothing source-y is
 * staged so the orchestrator can't silently mark such a story done.
 */
describe('PR-67 — compile-commit-on-pass non-empty diff guard', () => {
  it('story commit drops --allow-empty (forces failure on empty source diffs)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    expect(step?.stepType).toBe('shell');
    // The story-commit line uses `commit -m ...` without --allow-empty.
    // The baseline-bootstrap commit (earlier in the same command) DOES
    // keep --allow-empty — verify we didn't strip it too aggressively.
    expect(step?.command).toMatch(/commit -m 'story:/);
    expect(step?.command).toContain("commit --allow-empty -q -m 'baseline");
  });

  it('counts staged source changes and fails with STORY_COMMIT_EMPTY when zero', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    expect(step?.command).toContain('SOURCE_CHANGES=');
    expect(step?.command).toContain('STORY_COMMIT_EMPTY');
    // The exclusion regex filters out the directories/files that are not
    // source code (node_modules, pipeline metadata, knowledge, visual-tests,
    // story context). If the count is 0 after that, exit 1.
    expect(step?.command).toMatch(
      /grep -vE.*node_modules.*pipeline.*mycelium.*knowledge.*visual-tests.*context/,
    );
    expect(step?.command).toMatch(/if \[ "\$SOURCE_CHANGES" -eq 0 \]/);
    expect(step?.command).toContain('exit 1');
  });

  it('failure surfaces working-tree + staged paths for diagnosis', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    expect(step?.command).toContain('git status --short');
    expect(step?.command).toContain('git diff --cached --name-only');
  });
});
