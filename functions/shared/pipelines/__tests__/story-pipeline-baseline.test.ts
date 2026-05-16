import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
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
    expect(step?.command).toContain('exit 0');
    expect(step?.command).not.toContain("'EMPTY_DIFF: per-story commit");
  });
});

describe('Task #55 — compile-diff defensive rewrite (no-parent + always exits 0)', () => {
  it('handles first-commit / no-parent case via empty-tree fallback', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-diff');
    // Probe HEAD~1; fall back to empty-tree sha when it doesn't exist.
    expect(step?.command).toContain('git rev-parse --verify HEAD~1');
    expect(step?.command).toContain('git hash-object -t tree /dev/null');
    // The diff uses the resolved BASE_REF variable, not literal HEAD~1.
    expect(step?.command).toContain('git diff --name-status "$BASE_REF" HEAD');
  });

  it('always exits 0 (informational step — failure here must not break the pipeline)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-diff');
    // The terminal statement is an explicit `exit 0`.
    expect(step?.command).toMatch(/;\s*exit 0$/);
    // And the step's onFail.action is NOT 'fail' — the daemon already
    // classifies compile-* failures as non-blocking; the shell now
    // codifies that intent so transient failures don't surface
    // compilation-failed events.
    expect(step?.onFail?.action).toBeUndefined();
  });

  it('survives `cd` failure (working dir missing) without breaking the step', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-diff');
    // `cd ... || exit 0` guard: if the working dir vanished between
    // compile-commit-on-pass and compile-diff (unlikely but possible
    // under cleanup race), we exit cleanly instead of cascade-failing.
    expect(step?.command).toContain(`cd ${workingDir} || exit 0`);
  });

  /**
   * Regression: the array-join('; ') style produced `then;` / `else;` /
   * `fi; if` patterns that are syntax errors in bash. Pipe the generated
   * shell through `bash -n` (syntax-check, no exec) so any future
   * refactor that re-introduces the bug fails immediately at unit-test
   * time instead of waiting for an EC2 plan run to surface it.
   */
  it('compile-diff shell is syntactically valid bash (`bash -n`)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-diff');
    const cmd = (step as { command: string }).command;
    // `bash -n -c '<script>'` parses without executing; exits 0 on valid
    // syntax, non-zero on parse error. The thrown error message includes
    // the line/column for easy diagnosis.
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('compile-commit-on-pass shell is syntactically valid bash (`bash -n`)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
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
    // The story-commit line under mvp+ rigor is now built by the
    // commit-metadata trailer helper (PR-73 + PR-85): the subject lives in
    // `COMMIT_MSG='story: ...'` and the final invocation is
    // `commit -m "$COMMIT_MSG"`. Verify the subject is present and that
    // the story commit is NOT `--allow-empty` (the bootstrap baseline
    // commit DOES keep --allow-empty and stays present).
    expect(step?.command).toContain(`COMMIT_MSG='story: ${story.storyId}`);
    expect(step?.command).toContain('commit -m "$COMMIT_MSG"');
    expect(step?.command).toContain("commit --allow-empty -q -m 'baseline");
    // Belt and suspenders: the story-commit invocation must NOT use --allow-empty.
    expect(step?.command).not.toMatch(/commit --allow-empty -m "\$COMMIT_MSG"/);
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

/**
 * PR-64 (2026-05-15) — test-author integration test contract.
 *
 * spyhunter-1 forensic 2026-05-13: every unit test passed but the production
 * bundle didn't import the integrated modules. Unit tests with mocked DOM
 * cannot catch "module exists but is never imported from the entry point" —
 * only an integration test that boots the real app can. The fix: when a
 * story has browser ACs, the test-author prompt demands at least one
 * integration test that exercises the framework's actual entry, asserts
 * observable state (not mocks), and uses the framework's standard testing
 * harness.
 *
 * Framework-agnostic — the prompt enumerates React, Vue, Solid, Svelte,
 * Canvas/game, and plain-DOM patterns. Any UI project benefits.
 */
describe('PR-64 — test-author integration test contract', () => {
  it('test-author prompt demands integration test when hasBrowserTests is set', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      hasBrowserTests: true,
    });
    const ta = pipeline.steps.find((s) => s.id === 'test-author');
    expect(ta).toBeDefined();
    expect((ta as { prompt: string }).prompt).toContain('integration test contract');
    expect((ta as { prompt: string }).prompt).toMatch(/FRAMEWORK ENTRY POINT/i);
  });

  it('integration test contract is omitted for non-browser stories (no over-prompting)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ta = pipeline.steps.find((s) => s.id === 'test-author');
    expect((ta as { prompt: string }).prompt ?? '').not.toContain('integration test contract');
  });

  it('lists framework-agnostic harness options (React, Vue, Svelte, Canvas, plain DOM)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      hasBrowserTests: true,
    });
    const prompt = (pipeline.steps.find((s) => s.id === 'test-author') as { prompt: string })
      .prompt;
    expect(prompt).toContain('@testing-library/react');
    expect(prompt).toContain('@vue/test-utils');
    expect(prompt).toContain('@testing-library/svelte');
    expect(prompt).toContain('Canvas/game');
    expect(prompt).toContain('Plain DOM');
  });

  it('explicitly forbids the unit-mock anti-pattern', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      hasBrowserTests: true,
    });
    const prompt = (pipeline.steps.find((s) => s.id === 'test-author') as { prompt: string })
      .prompt;
    expect(prompt).toContain('Anti-patterns');
    expect(prompt).toMatch(/function X was called once[\s\S]*unit\s+guarantee/i);
  });
});

/**
 * PR-65 (2026-05-15) — review-runtime step.
 *
 * For browser-AC stories at mvp+ rigor, boot the dev server, take one
 * screenshot, ask Haiku per-AC. UNCERTAIN passes (foundation stories
 * don't yet render). FAIL loops to retry. SKIPPED on dev-server boot
 * failure. Framework-agnostic via buildFrameworkDetectSnippet.
 */
describe('PR-65 — review-runtime step', () => {
  const browserStory = {
    ...story,
    hasBrowserTests: true,
    criteria: [{ id: 'AC-1', text: 'A button labelled Save is visible.', needsBrowser: true }],
  } as unknown as EpicStory;

  it('is inserted only when story has browser ACs', () => {
    const noBrowser = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    expect(noBrowser.steps.map((s) => s.id)).not.toContain('review-runtime');

    const withBrowser = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    expect(withBrowser.steps.map((s) => s.id)).toContain('review-runtime');
  });

  it('is skipped under prototype rigor (no testsOn) to avoid Haiku spend on smoke runs', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    expect(pipeline.steps.map((s) => s.id)).not.toContain('review-runtime');
  });

  it('sits between review and retry; loopTo retry on failure (dev fix path)', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('review-runtime'));
    expect(ids.indexOf('review-runtime')).toBeLessThan(ids.indexOf('retry'));
    const step = pipeline.steps.find((s) => s.id === 'review-runtime');
    expect((step as { loopTo?: string }).loopTo).toBe('retry');
    expect((step as { onFail?: { targetStep: string } }).onFail?.targetStep).toBe('retry');
  });

  it('SKIPPED on dev-server boot failure (foundation stories pass cleanly)', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'review-runtime');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain('RUNTIME_REVIEW_SKIPPED: dev server did not boot');
  });

  it('inlines only browser ACs as JSON (filters out internal ACs)', () => {
    const mixed = {
      ...story,
      hasBrowserTests: true,
      criteria: [
        { id: 'AC-1', text: 'Browser visible thing', needsBrowser: true },
        { id: 'AC-2', text: 'Internal contract', needsBrowser: false },
      ],
    } as unknown as EpicStory;
    const pipeline = generateStoryPipeline(mixed, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const cmd = String(
      (pipeline.steps.find((s) => s.id === 'review-runtime') as { command: string }).command,
    );
    expect(cmd).toContain('"AC-1"');
    expect(cmd).toContain('Browser visible thing');
    expect(cmd).not.toContain('AC-2');
    expect(cmd).not.toContain('Internal contract');
  });

  it('spawns claude haiku with --print + reads prompt from stdin', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const cmd = String(
      (pipeline.steps.find((s) => s.id === 'review-runtime') as { command: string }).command,
    );
    expect(cmd).toContain("spawn('claude'");
    expect(cmd).toContain("'--model'");
    expect(cmd).toContain("'haiku'");
    expect(cmd).toContain('child.stdin.write(prompt)');
    expect(cmd).toContain('child.stdin.end()');
  });

  it('UNCERTAIN passes; FAIL exits 1 with the screenshot URL surfaced', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const cmd = String(
      (pipeline.steps.find((s) => s.id === 'review-runtime') as { command: string }).command,
    );
    expect(cmd).toContain("v.verdict === 'FAIL'");
    expect(cmd).toContain('RUNTIME_REVIEW_FAILED');
    expect(cmd).toContain('Screenshot: ');
    expect(cmd).toContain('process.exit(1)');
    // UNCERTAIN is mentioned in the verdict rules but is NOT used to fail.
    expect(cmd).toMatch(/UNCERTAIN[\s\S]*future state|UNCERTAIN[\s\S]*foundation/);
  });

  it('uses framework-detect so any web stack works (no hard-coded port 5173)', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const cmd = String(
      (pipeline.steps.find((s) => s.id === 'review-runtime') as { command: string }).command,
    );
    expect(cmd).toContain('$QA_PORT');
    expect(cmd).toContain('$QA_DEV_CMD');
    expect(cmd).toContain('$QA_HEALTH_PATH');
  });
});
