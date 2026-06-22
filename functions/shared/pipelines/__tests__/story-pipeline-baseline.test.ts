import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('v3 E4-S2 — contract freeze (D2-3 precise whole-project enforcement)', () => {
  it('mvp/production insert api-contract-freeze between api-author and dev', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const ids = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps.map(
        (s) => s.id,
      );
      expect(ids).toContain('api-contract-freeze');
      expect(ids.indexOf('api-contract-freeze')).toBeGreaterThan(ids.indexOf('api-author'));
      expect(ids.indexOf('api-contract-freeze')).toBeLessThan(ids.indexOf('dev'));
    }
  });

  it('D2-3: precise enforcement — absent skips, contract-broken blocks, unrelated noise warns', () => {
    // D2-3 re-hardening (2026-06-22): the contract now lands at its real module
    // dir (D2-2), so it's validated with a WHOLE-PROJECT tsc and ENFORCED —
    // but precisely: only a tsc error that references the contract file blocks;
    // pre-existing/unrelated scaffold errors merely warn (no false wedge).
    const freeze = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    }).steps.find((s) => s.id === 'api-contract-freeze') as unknown as {
      command: string;
      loopTo?: string;
      onFail?: { action: string; injectAs?: string };
      expectExitCode?: number;
    };
    // Absent contract → exit 0 (continue to dev); the old hard-fail markers gone.
    expect(freeze.command).toMatch(/API_CONTRACT_ABSENT[\s\S]*exit 0/);
    expect(freeze.command).not.toMatch(/API_CONTRACT_MISSING/);
    // Contract's OWN surface broken → block (exit 1 + daemon-visible onFail).
    expect(freeze.command).toMatch(/API_CONTRACT_BROKEN[\s\S]*exit 1/);
    expect(freeze.onFail?.action).toBe('fail');
    expect(freeze.onFail?.injectAs).toBe('API_CONTRACT_ERROR');
    expect(freeze.expectExitCode).toBe(0);
    // Project tsc noise NOT referencing the contract → warn only (no wedge).
    expect(freeze.command).toMatch(/API_CONTRACT_TSC_WARN/);
    // Whole-project tsc (no single-file arg), via the LOCAL tsc, never `npx tsc`.
    expect(freeze.command).toMatch(/"\$TSC" --noEmit >/);
    expect(freeze.command).toMatch(/node_modules\/\.bin\/tsc/);
    expect(freeze.command).not.toMatch(/npx tsc/);
    expect(freeze.loopTo).toBeUndefined();
  });

  it('D2-2: contract path + api-author moduleDir are inferred from touch points (not hardcoded src)', () => {
    // Deep, agreeing touch points → the contract lands at their common module
    // boundary, not a top-level `src/index.d.ts`.
    const deepStory = {
      ...story,
      touchPoints: ['functions/api/billing/handler.ts', 'functions/api/billing/schema.ts'],
    } as EpicStory;
    const steps = generateStoryPipeline(deepStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    }).steps as unknown as Array<{ id: string; command?: string; prompt?: string }>;
    const freeze = steps.find((s) => s.id === 'api-contract-freeze');
    expect(freeze?.command).toContain('CONTRACT="functions/api/billing/index.d.ts"');
    expect(freeze?.command).not.toContain('CONTRACT="src/index.d.ts"');
    const apiAuthor = steps.find((s) => s.id === 'api-author');
    expect(apiAuthor?.prompt).toContain('functions/api/billing');
  });

  it('prototype has neither api-author nor the freeze gate', () => {
    const ids = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    }).steps.map((s) => s.id);
    expect(ids).not.toContain('api-author');
    expect(ids).not.toContain('api-contract-freeze');
  });
});

describe('feature descriptor is not a test surface (promote-to-primary disease, 2026-06-22)', () => {
  it('test-author prompt forbids asserting the descriptor — ONLY for feature-registry apps', () => {
    const game = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      boilerplateKind: 'nextjs-canvas-game',
    }).steps.find((s) => s.id === 'test-author') as unknown as { prompt: string };
    expect(game.prompt).toContain('feature DESCRIPTOR is NOT a test surface');
    expect(game.prompt).toMatch(/NEVER write .*feature\.slug\/order\/primary/);

    // A route-based / non-feature-registry app must NOT carry the rule (no descriptor).
    const sst = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      boilerplateKind: 'sst',
    }).steps.find((s) => s.id === 'test-author') as unknown as { prompt: string } | undefined;
    if (sst) expect(sst.prompt).not.toContain('feature DESCRIPTOR is NOT a test surface');
  });

  it('test-fix prompt gives a NARROW carve-out to retire a superseded descriptor test (feature-registry only)', () => {
    const fix = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      boilerplateKind: 'nextjs-canvas-game',
    }).steps.find((s) => s.id === 'test-fix') as unknown as { prompt: string };
    expect(fix.prompt).toMatch(/EXCEPTION \(feature promotion/);
    expect(fix.prompt).toMatch(/SUPERSEDED interim-preview contract/i);
    expect(fix.prompt).toContain('NEVER weaken a behavior test to pass');
    // The blanket "do not edit/delete test files" rule is still present.
    expect(fix.prompt).toContain('Do NOT edit or delete the test files');
  });
});

describe('D3 — dev-scope enforcement gate (D3-1) + measured-set emission (D3-2)', () => {
  // A story whose touch points are deep & specific enough to enforce.
  const scoped = {
    ...story,
    touchPoints: ['src/game/pacman.ts', 'src/game/ghost.ts'],
  } as EpicStory;

  it('inserts capture-predev-baseline before dev and dev-scope-check after it', () => {
    const ids = generateStoryPipeline(scoped, 'Test Epic', workingDir, { rigor: 'mvp' }).steps.map(
      (s) => s.id,
    );
    expect(ids).toContain('capture-predev-baseline');
    expect(ids).toContain('dev-scope-check');
    expect(ids.indexOf('capture-predev-baseline')).toBeLessThan(ids.indexOf('dev'));
    expect(ids.indexOf('dev-scope-check')).toBeGreaterThan(ids.indexOf('dev'));
  });

  it('D3-1: fails the story on out-of-scope source edits (blocking, daemon-visible)', () => {
    const gate = generateStoryPipeline(scoped, 'Test Epic', workingDir, {
      rigor: 'mvp',
    }).steps.find((s) => s.id === 'dev-scope-check') as unknown as {
      command: string;
      expectExitCode?: number;
      onFail?: { action: string; injectAs?: string };
    };
    expect(gate.command).toMatch(/__DEV_SCOPE_VIOLATION__[\s\S]*exit 1/);
    expect(gate.expectExitCode).toBe(0);
    expect(gate.onFail?.action).toBe('fail');
    expect(gate.onFail?.injectAs).toBe('DEV_SCOPE_ERROR');
    // Self-skips when it can't enforce (broad globs / no touch points / no baseline).
    expect(gate.command).toMatch(/__DEV_SCOPE_SKIP__/);
    // Operator escape hatch.
    expect(gate.command).toMatch(/DEV_SCOPE_ENFORCE/);
  });

  it('D3-2: emits the measured edit set for the daemon to persist as actualTouchPoints', () => {
    const gate = generateStoryPipeline(scoped, 'Test Epic', workingDir, {
      rigor: 'mvp',
    }).steps.find((s) => s.id === 'dev-scope-check') as unknown as { command: string };
    expect(gate.command).toContain('__DEV_SCOPE_ACTUAL__');
  });
});

describe('v3 E4-S3 — AC-coverage gate consumes AC_TEST_MAP', () => {
  it('mvp/production insert ac-coverage-gate after stage-test-files and before dev', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const ids = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps.map(
        (s) => s.id,
      );
      expect(ids).toContain('ac-coverage-gate');
      expect(ids.indexOf('ac-coverage-gate')).toBeGreaterThan(ids.indexOf('stage-test-files'));
      expect(ids.indexOf('ac-coverage-gate')).toBeLessThan(ids.indexOf('dev'));
    }
    const gate = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    }).steps.find((s) => s.id === 'ac-coverage-gate') as unknown as { command: string };
    expect(gate.command).toMatch(/AC_TEST_MAP/);
    expect(gate.command).toMatch(/AC_COVERAGE_FAILED/);
  });

  it('prototype omits the ac-coverage gate', () => {
    const ids = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    }).steps.map((s) => s.id);
    expect(ids).not.toContain('ac-coverage-gate');
  });
});

describe('VQA v3 E8.1 — QA-AUTHOR probe model in the DEV VISUAL_TESTS prompt', () => {
  const browserStory: EpicStory = {
    storyId: 'S-9',
    order: 0,
    title: 'Ball bounces',
    description: 'AC: the ball moves.',
    status: 'pending',
    touchPoints: ['src/features/ball.feature.tsx'],
    hasBrowserTests: true,
    criteria: [
      {
        id: 'AC-S9-1',
        text: 'the ball changes direction at the wall',
        needsBrowser: true,
        verify: 'behavior',
      },
    ],
  } as unknown as EpicStory;

  function devPrompt(boilerplateKind?: string) {
    const pipeline = generateStoryPipeline(browserStory, 'Game', workingDir, {
      rigor: 'mvp',
      hasBrowserTests: true,
      ...(boilerplateKind ? { boilerplateKind: boilerplateKind as never } : {}),
    });
    const dev = pipeline.steps.find((s) => s.id === 'dev');
    return (dev as { prompt: string }).prompt;
  }

  it('canvas-game (has seam) — DEV prompt teaches the reach→act→assert probe model + seam keys', () => {
    const p = devPrompt('nextjs-canvas-game');
    expect(p).toContain('probe model');
    expect(p).toContain('window.__harness');
    expect(p).toContain('assert');
    expect(p).toContain('clock');
    // It routes by verify intent and lists the seam snapshot keys.
    expect(p).toMatch(/\[verify=behavior\]/);
    expect(p).toContain('snapshot.status');
  });

  it('seam-less boilerplate (nextjs-base) — no probe section injected (back-compat)', () => {
    const p = devPrompt('nextjs-base');
    expect(p).not.toContain('reach→act→assert');
    expect(p).not.toContain('VQA v3 probe model');
  });
});

describe('VQA v3 E5.5 — seam-tamper-check (generator-owned __harness.schema.json)', () => {
  it('prototype rigor — seam-tamper-check absent (tamper tier off)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor: 'prototype' });
    expect(pipeline.steps.map((s) => s.id)).not.toContain('seam-tamper-check');
  });

  it('mvp+ — seam-tamper-check present, right after the test tamper-check', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const ids = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps.map(
        (s) => s.id,
      );
      expect(ids).toContain('seam-tamper-check');
      expect(ids.indexOf('seam-tamper-check')).toBe(ids.indexOf('tamper-check') + 1);
    }
  });

  it('reverts edits to __harness.schema.json from HEAD and fails the step', () => {
    const step = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor: 'mvp' }).steps.find(
      (s) => s.id === 'seam-tamper-check',
    );
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('__harness.schema.json');
    expect(cmd).toContain('git checkout HEAD -- __harness.schema.json');
    expect(cmd).toContain('__SEAM_TAMPER_DETECTED__');
    // No-op when the app has no seam (file absent / untracked).
    expect(cmd).toContain('__SEAM_TAMPER_SKIP__');
    expect((step as { onFail?: { action: string } }).onFail?.action).toBe('fail');
  });

  it('seam-tamper-check shell is syntactically valid bash (`bash -n`)', () => {
    const step = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor: 'mvp' }).steps.find(
      (s) => s.id === 'seam-tamper-check',
    );
    const cmd = (step as { command: string }).command;
    expect(() => execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' })).not.toThrow();
  });
});

describe('2026-05-19 — tamper-check baseline is the index (snake-4 fix)', () => {
  it('stage-test-files step is present at mvp+ and runs right after test-author', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('stage-test-files');
    expect(ids.indexOf('stage-test-files')).toBeGreaterThan(ids.indexOf('test-author'));
    expect(ids.indexOf('stage-test-files')).toBeLessThan(ids.indexOf('tamper-check'));
  });

  it('stage-test-files absent under prototype (no tamper-check, nothing to stage for)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('stage-test-files');
  });

  it('tamper-check diffs against the index (no HEAD ref)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'tamper-check');
    const cmd = (step as { command: string }).command;
    // Pre-fix: `git diff --name-only HEAD -- $(cat ...)` (baseline=prior story HEAD).
    // Post-fix: `git diff --name-only -- $(cat ...)` (baseline=index, post-stage-test-files).
    expect(cmd).toContain('git --no-pager diff --name-only -- $(cat /tmp/tamper-expected.txt)');
    expect(cmd).not.toContain('git --no-pager diff --name-only HEAD --');
  });

  it('tamper-check revert restores the staged blob (checkout-index, not checkout)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'tamper-check');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('git checkout-index -f --');
    // Old `git checkout -- $(cat /tmp/tamper-dirty.txt)` would revert to HEAD,
    // which is the prior-story commit — clobbering test-author's legitimate
    // edits. Make sure that exact construct is gone.
    expect(cmd).not.toContain('git checkout -- $(cat /tmp/tamper-dirty.txt)');
  });

  it('stage-test-files + tamper-check shells are syntactically valid bash', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    for (const id of ['stage-test-files', 'tamper-check']) {
      const step = pipeline.steps.find((s) => s.id === id);
      const cmd = (step as { command: string }).command;
      expect(() => {
        execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
      }, `bash -n failed for step ${id}`).not.toThrow();
    }
  });
});

describe('2026-05-19 — Phase 0.2a — capture-dev-baseline step', () => {
  it('mvp rigor — capture-dev-baseline is the FIRST step (before any agent)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('capture-dev-baseline');
    expect(ids.indexOf('capture-dev-baseline')).toBeLessThan(ids.indexOf('dev'));
    // pacman1 root-cause (2026-06-11): the baseline must precede api-author
    // and test-author so the contract `.d.ts`, vitest config, and
    // package.json edits they write are INSIDE the story's commit delta.
    // (The old post-test-author placement silently excluded them — the
    // story validated against files it never shipped.)
    expect(ids.indexOf('capture-dev-baseline')).toBe(0);
    expect(ids.indexOf('capture-dev-baseline')).toBeLessThan(ids.indexOf('test-author'));
  });

  it('writes baseline files under .pipeline/ keyed by storyId', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'capture-dev-baseline');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain(`.pipeline/${story.storyId}-baseline-dirty.txt`);
    expect(cmd).toContain(`.pipeline/${story.storyId}-baseline-untracked.txt`);
    expect(cmd).toContain('git diff --name-only');
    expect(cmd).toContain('git ls-files --others --exclude-standard');
  });

  it('survives a non-git working tree (bootstrap path)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'capture-dev-baseline');
    const cmd = (step as { command: string }).command;
    // The capture is gated on `git rev-parse --is-inside-work-tree` so the
    // bootstrap path (no repo yet) emits BASELINE_SKIPPED_NOT_A_REPO
    // instead of erroring.
    expect(cmd).toContain('git rev-parse --is-inside-work-tree');
    expect(cmd).toContain('BASELINE_SKIPPED_NOT_A_REPO');
  });

  it('shell is syntactically valid bash', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'capture-dev-baseline');
    const cmd = (step as { command: string }).command;
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('absent under prototype rigor (no DEV-baseline contract there)', () => {
    // Currently the step is included regardless of rigor because the DEV
    // step is always present. If we ever gate it on testsOn, this test
    // will catch the drift.
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    // Today the step IS present under prototype too (it's pure shell, no
    // test dependency). Asserting that to lock the current contract:
    expect(ids).toContain('capture-dev-baseline');
  });
});

describe('2026-05-19 — Phase 0.2b — compile-commit-on-pass uses snapshot-diff', () => {
  it('reads the per-story baseline files', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain(`.pipeline/${story.storyId}-baseline-dirty.txt`);
    expect(cmd).toContain(`.pipeline/${story.storyId}-baseline-untracked.txt`);
  });

  it('uses comm -23 to compute post − baseline delta', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('comm -23');
  });

  it('falls back to git add -A when baseline files are missing', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('SNAPSHOT_DIFF_FALLBACK');
    expect(cmd).toContain('git add -A');
  });

  it('always stages infra paths regardless of delta (cross-wave knowledge updates)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('git add -- .mycelium');
    expect(cmd).toContain('git add -- knowledge');
    expect(cmd).toContain('git add -- .context');
  });

  it('preserves the SOURCE_CHANGES non-empty guard (PR-67 contract)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain('STORY_COMMIT_EMPTY');
    expect(cmd).toContain('SOURCE_CHANGES');
    expect(cmd).toContain('exit 1');
  });

  it('step retains onFail.action="fail" so daemon (Phase 0.1) can block the job', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    expect(step?.onFail?.action).toBe('fail');
  });

  it('shell is syntactically valid bash (with + without planSlug)', () => {
    for (const planSlug of [undefined, 'snake-4-change-x']) {
      const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
        rigor: 'mvp',
        planSlug,
      });
      const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
      const cmd = (step as { command: string }).command;
      expect(
        () => {
          execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
        },
        `bash -n failed (planSlug=${planSlug ?? 'undefined'})`,
      ).not.toThrow();
    }
  });
});

describe('2026-05-19 — plan-branch checkout in compile-commit-on-pass (brownfield safety)', () => {
  it('absent when planSlug not provided (legacy behaviour, commits to current branch)', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).not.toContain('PLAN_BRANCH=');
    expect(cmd).not.toContain('plan/');
  });

  it('present when planSlug provided — checks out plan/<slug> idempotently', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      planSlug: 'snake-4-change-ilunx',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(cmd).toContain("PLAN_BRANCH='plan/snake-4-change-ilunx'");
    // Idempotent: try plain checkout first, fall back to -b for first story.
    expect(cmd).toContain('git checkout "$PLAN_BRANCH"');
    expect(cmd).toContain('git checkout -b "$PLAN_BRANCH"');
    // Guarded by symbolic-ref equality so we don't churn the worktree on
    // every story.
    expect(cmd).toContain('git symbolic-ref --short HEAD');
  });

  it('compile-commit-on-pass shell with planSlug is syntactically valid bash', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
      rigor: 'mvp',
      planSlug: 'snake-4-change-ilunx',
    });
    const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
    const cmd = (step as { command: string }).command;
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  // 2026-05-27 (brick-breaker-11 fix) — per-story-worktree compatibility.
  // The plan-branch checkout MUST be skipped when the worktree is already
  // on a wip/* branch (Slice C per-story worktrees), or N parallel wave
  // stories collide on `git checkout plan/<slug>` (only one worktree may
  // hold a branch). See story-pipeline.ts compile-commit-on-pass comment.
  describe('per-story-worktree branch collision guard', () => {
    function commitStep(planSlug: string) {
      const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
        rigor: 'mvp',
        planSlug,
      });
      const step = pipeline.steps.find((s) => s.id === 'compile-commit-on-pass');
      return (step as { command: string }).command;
    }

    it('skips plan/<slug> checkout when already on a wip/* branch (case guard present)', () => {
      const cmd = commitStep('brick-breaker-11');
      // The CUR_BRANCH probe + case statement that short-circuits wip/* must
      // be present — that is the collision guard.
      expect(cmd).toContain('CUR_BRANCH=');
      expect(cmd).toMatch(/case "\$CUR_BRANCH" in/);
      expect(cmd).toContain('wip/*) : ;;');
    });

    it('only the non-wip branch path runs the plan/<slug> checkout', () => {
      const cmd = commitStep('brick-breaker-11');
      // The checkout lines must sit inside the `*)` (non-wip) arm, AFTER
      // the wip/* no-op arm — structurally, the wip/* arm precedes the
      // checkout commands.
      const wipArm = cmd.indexOf('wip/*) : ;;');
      const checkout = cmd.indexOf('git checkout "$PLAN_BRANCH"');
      expect(wipArm).toBeGreaterThan(-1);
      expect(checkout).toBeGreaterThan(wipArm);
    });

    it('remains valid bash with the case guard', () => {
      const cmd = commitStep('brick-breaker-11');
      expect(() => {
        execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
      }).not.toThrow();
    });

    // Behavioural check: simulate a wip/* worktree and confirm the guard
    // would NOT attempt the plan-branch checkout. We extract just the
    // branch-selection fragment and run it against a fake git shim.
    it('case guard leaves HEAD untouched when on wip/<storyId> (simulated)', () => {
      // Minimal repro of the guard. Newline-joined — a `case` statement
      // cannot be `&&`-chained between `in` and its first pattern.
      const guard = [
        `PLAN_BRANCH='plan/brick-breaker-11'`,
        `CUR_BRANCH='wip/story-abc'`, // stub: pretend we're on wip/<story>
        `CHECKED_OUT=no`,
        `case "$CUR_BRANCH" in`,
        `  wip/*) : ;;`,
        `  *) CHECKED_OUT=yes ;;`,
        `esac`,
        `echo "$CHECKED_OUT"`,
      ].join('\n');
      const out = execSync(guard, { shell: '/bin/bash', encoding: 'utf8' }).trim();
      expect(out).toBe('no'); // wip/* → checkout skipped
    });

    it('case guard DOES check out when on main (legacy shared-worktree, simulated)', () => {
      const guard = [
        `PLAN_BRANCH='plan/brick-breaker-11'`,
        `CUR_BRANCH='main'`,
        `CHECKED_OUT=no`,
        `case "$CUR_BRANCH" in`,
        `  wip/*) : ;;`,
        `  *) if [ "$CUR_BRANCH" != "$PLAN_BRANCH" ]; then CHECKED_OUT=yes; fi ;;`,
        `esac`,
        `echo "$CHECKED_OUT"`,
      ].join('\n');
      const out = execSync(guard, { shell: '/bin/bash', encoding: 'utf8' }).trim();
      expect(out).toBe('yes'); // main → plan/<slug> checkout runs
    });
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
 * PR-65 (2026-05-15), reshaped by v2.6 M3 (2026-06-11) — review-runtime is
 * now a STORY SMOKE: boot the dev server, one screenshot, ONE Haiku call
 * classifying PAGE_STATE only. NO per-AC judging in the story worktree —
 * judged verification moved to the wave gate (the story tree is a partial
 * world; three generations of per-story judging graded the wrong pixels).
 * blank/error-overlay exits 1 into the retry loop WITH the dev-server log
 * (the dino1 environmental-recovery path, kept). Framework-agnostic via
 * buildFrameworkDetectSnippet.
 */
describe('PR-65 / v2.6 M3 — review-runtime (story smoke) step', () => {
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

  it('SKIPPED on dev-server boot failure with a machine-grepable cause marker (Step-0.4)', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const step = pipeline.steps.find((s) => s.id === 'review-runtime');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain('RUNTIME_REVIEW_SKIPPED: cause=dev-server-no-boot');
    // Every skip path carries a cause= token so the daemon can write a
    // story-vqa-skipped attention item instead of a silent pass.
    expect(cmd).toContain('cause=screenshot-failed');
    expect(cmd).toContain('cause=page-state-crash');
    expect(cmd).toContain('cause=page-state-unparseable');
  });

  it('v2.6 M3 — NO AC judging in the story worktree (moved to the wave gate)', () => {
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
    // The judge half is GONE: no AC payload, no verdict block, no
    // suite-asserted bypass, no coverage-gap marker, no per-AC verdicts.
    expect(cmd).not.toContain('STORY_BROWSER_ACS_B64');
    expect(cmd).not.toContain('---RUNTIME_REVIEW---');
    expect(cmd).not.toContain('AC_COVERAGE_GAP');
    expect(cmd).not.toContain('AC_TEST_MAP');
    expect(cmd).not.toContain('RUNTIME_REVIEW_UNVERIFIABLE');
    // The old judged-FAIL marker is gone too — a smoke failure uses its own
    // marker so the daemon's story-vqa-failed card never fires for env loops.
    expect(cmd).not.toContain('RUNTIME_REVIEW_FAILED');
    expect(cmd).toContain('STORY_SMOKE_FAILED');
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

  it('v2.6 M3 — smoke fails ONLY on blank/error-overlay, with the dev-server log attached', () => {
    const pipeline = generateStoryPipeline(browserStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    const cmd = String(
      (pipeline.steps.find((s) => s.id === 'review-runtime') as { command: string }).command,
    );
    // PAGE_STATE classification kept (the dino blank-page class is a real
    // defect); rendered exits 0 pointing at the wave gate.
    expect(cmd).toContain('PAGE_STATE');
    expect(cmd).toMatch(/blank.*error-overlay|error-overlay.*blank/);
    expect(cmd).toContain('STORY_SMOKE_OK');
    expect(cmd).toContain('wave gate');
    // Environmental recovery path kept verbatim in spirit: server log tail
    // travels with the failure so the fix-cycle DEV diagnoses the
    // ENVIRONMENT instead of mutating correct product code.
    expect(cmd).toContain('STORY_SMOKE_FAILED');
    expect(cmd).toContain('devserver.log');
    expect(cmd).toContain('do NOT change product code for an infra crash');
    expect(cmd).toContain('vqa-observations.txt');
    expect(cmd).toContain('Screenshot: ');
    expect(cmd).toContain('process.exit(1)');
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

/**
 * P1 (pong1 2026-06-12) — commit-staging contract.
 *
 * pong1 wave-0 forensic: a RETRY job reused the first attempt's worktree, so
 * capture-dev-baseline recorded the first attempt's untracked output AS the
 * baseline. comm -23 then subtracted it forever: the smoke validated
 * src/features/court-preview.feature.tsx on disk while the commit shipped
 * without it (validated ≠ shipped). The fix: declared touchPoints are the
 * story's ship contract — staged unconditionally AFTER the snapshot-diff —
 * and a post-commit tripwire (STORY_COMMIT_INCOMPLETE) hard-fails if any
 * touchPoint on disk is still absent from HEAD.
 */
describe('P1 — commit-staging contract (touchPoints always ship)', () => {
  function commitCmd(s: EpicStory = story) {
    const pipeline = generateStoryPipeline(s, 'Test Epic', workingDir, { rigor: 'mvp' });
    return (pipeline.steps.find((st) => st.id === 'compile-commit-on-pass') as { command: string })
      .command;
  }

  it('stages declared touchPoints unconditionally, AFTER snapshot-diff, BEFORE the empty guard', () => {
    const cmd = commitCmd();
    expect(cmd).toContain(`TOUCHPOINTS_STAGED story=${story.storyId} declared=1`);
    expect(cmd).toContain(`'src/main.js'`);
    // Ordering: snapshot-diff fallback → touchPoint staging → SOURCE_CHANGES guard.
    const snapshotIdx = cmd.indexOf('SNAPSHOT_DIFF_FALLBACK');
    const stageIdx = cmd.indexOf('TOUCHPOINTS_STAGED');
    const guardIdx = cmd.indexOf('SOURCE_CHANGES=');
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(snapshotIdx);
    expect(guardIdx).toBeGreaterThan(stageIdx);
    // gitignored touchPoints are skipped on purpose (not force-added).
    expect(cmd).toContain('git check-ignore -q "$TP"');
  });

  it('post-commit tripwire: touchPoint on disk but missing from HEAD → STORY_COMMIT_INCOMPLETE + exit 1', () => {
    const cmd = commitCmd();
    const commitIdx = cmd.indexOf('commit -m "$COMMIT_MSG"');
    const tripIdx = cmd.indexOf('STORY_COMMIT_INCOMPLETE');
    expect(commitIdx).toBeGreaterThan(-1);
    expect(tripIdx).toBeGreaterThan(commitIdx);
    expect(cmd).toContain('git ls-tree --name-only HEAD --');
    expect(cmd).toContain('missing_touchpoints:');
  });

  it('sentinel touchPoints (<EPIC_WIDE>) emit no staging loop and no tripwire', () => {
    const cmd = commitCmd({ ...story, touchPoints: ['<EPIC_WIDE>'] } as EpicStory);
    expect(cmd).not.toContain('TOUCHPOINTS_STAGED');
    expect(cmd).not.toContain('STORY_COMMIT_INCOMPLETE');
  });

  it('touchPoints with apostrophes survive shell quoting (bash -n clean)', () => {
    const cmd = commitCmd({ ...story, touchPoints: ["src/it's-a-file.ts"] } as EpicStory);
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('compile-commit-on-pass remains valid bash with the P1 additions', () => {
    for (const planSlug of [undefined, 'pong-2']) {
      const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, {
        rigor: 'mvp',
        planSlug,
      });
      const cmd = (
        pipeline.steps.find((s) => s.id === 'compile-commit-on-pass') as { command: string }
      ).command;
      expect(() => {
        execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
      }).not.toThrow();
    }
  });

  // Behavioural repro of the pong1 retry disease: the touchPoint sits
  // untracked on disk AND is listed in the captured baseline (first
  // attempt's output). Pre-P1 the snapshot-diff subtracted it and the
  // commit shipped without it; post-P1 it must land in HEAD.
  it('retry scenario: baseline-subtracted touchPoint still ships (end-to-end in a temp repo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-commit-'));
    try {
      execSync(
        'git init -q && git -c user.email=t@t.local -c user.name=T commit --allow-empty -q -m base',
        { cwd: dir, shell: '/bin/bash' },
      );
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/main.js'), 'export const x = 1;\n');
      mkdirSync(join(dir, '.pipeline'), { recursive: true });
      writeFileSync(join(dir, `.pipeline/${story.storyId}-baseline-dirty.txt`), '');
      writeFileSync(
        join(dir, `.pipeline/${story.storyId}-baseline-untracked.txt`),
        'src/main.js\n',
      );
      const pipeline = generateStoryPipeline(story, 'Test Epic', dir, { rigor: 'mvp' });
      const cmd = (
        pipeline.steps.find((s) => s.id === 'compile-commit-on-pass') as { command: string }
      ).command;
      execSync(cmd, { cwd: dir, shell: '/bin/bash', stdio: 'pipe' });
      const inHead = execSync('git ls-tree --name-only HEAD -- src/main.js', {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      expect(inHead).toBe('src/main.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tripwire fragment flags an on-disk file absent from HEAD (simulated)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p1-trip-'));
    try {
      execSync(
        'git init -q && git -c user.email=t@t.local -c user.name=T commit --allow-empty -q -m base',
        { cwd: dir, shell: '/bin/bash' },
      );
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/ghost.js'), 'never committed\n');
      const frag =
        `cd ${dir} && MISSING_TP=""; for TP in 'src/ghost.js'; do ` +
        `if [ -e "$TP" ] && ! git check-ignore -q "$TP" 2>/dev/null && ! git ls-tree --name-only HEAD -- "$TP" 2>/dev/null | grep -q .; then MISSING_TP="$MISSING_TP $TP"; fi; ` +
        `done; if [ -n "$MISSING_TP" ]; then echo "STORY_COMMIT_INCOMPLETE missing_touchpoints:$MISSING_TP" >&2; exit 1; fi`;
      let failed = false;
      let stderr = '';
      try {
        execSync(frag, { cwd: dir, shell: '/bin/bash', stdio: 'pipe' });
      } catch (e) {
        failed = true;
        stderr = String((e as { stderr?: Buffer }).stderr ?? '');
      }
      expect(failed).toBe(true);
      expect(stderr).toContain('STORY_COMMIT_INCOMPLETE');
      expect(stderr).toContain('src/ghost.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 2026-05-27 (brick-breaker-11 Bug 3) — Epic 5 claude-md-append-decision
// shell-quoting fix. The step only emits for milestone stories (wave 0 OR
// AC starts with "Architecture:"). Pre-fix it inlined JSON-with-quotes into
// a double-quoted `node -e "..."` → bash `syntax error near unexpected token
// '('` (exit 2). Fix: base64-encode the args + single-quote the node script.
describe('Epic 5 — claude-md-append-decision shell-quoting (Bug 3)', () => {
  const milestoneStory: EpicStory = {
    storyId: 'story-abc-123',
    order: 0,
    wave: 0,
    title: "Define core game domain types (it's a milestone)",
    description: 'AC: exports Ball, Paddle, Brick, GameStatus, GameState.',
    status: 'pending',
    touchPoints: ['src/types/index.ts'],
  } as EpicStory;

  function appendStep() {
    const pipeline = generateStoryPipeline(milestoneStory, 'Test Epic', workingDir, {
      rigor: 'mvp',
    });
    return pipeline.steps.find((s) => s.id === 'claude-md-append-decision') as
      | { command: string }
      | undefined;
  }

  it('emits the step for a wave-0 milestone story', () => {
    expect(appendStep()).toBeDefined();
  });

  it('does NOT emit for a non-milestone story (wave>0, no Architecture: prefix)', () => {
    const pipeline = generateStoryPipeline(
      { ...milestoneStory, wave: 2, description: 'AC: regular feature.' } as EpicStory,
      'Test Epic',
      workingDir,
      { rigor: 'mvp' },
    );
    expect(pipeline.steps.find((s) => s.id === 'claude-md-append-decision')).toBeUndefined();
  });

  it('command is syntactically valid bash (`bash -n`) — the actual Bug 3 regression', () => {
    const cmd = appendStep()!.command;
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('passes args base64-encoded, NOT as inline JSON (no bare {" in the command)', () => {
    const cmd = appendStep()!.command;
    // The defect was an inline JSON object inside double quotes.
    expect(cmd).not.toContain('{"workingDir"');
    expect(cmd).toContain('Buffer.from(');
    expect(cmd).toContain('"base64"');
    // node script is single-quoted for the shell.
    expect(cmd).toContain("node -e '");
  });

  it('the embedded base64 round-trips to the correct args (decode + JSON.parse)', () => {
    const cmd = appendStep()!.command;
    const m = cmd.match(/Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\)/);
    expect(m).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(m![1], 'base64').toString('utf8'));
    expect(decoded.workingDir).toBe('.');
    expect(decoded.storyId).toBe('story-abc-123');
    // Apostrophe in the title survives the base64 round-trip cleanly.
    expect(decoded.storyTitle).toContain("it's a milestone");
    expect(decoded.decision).toContain('Define core game domain types');
    expect(typeof decoded.rationale).toBe('string');
  });

  it('imports the writer via file:// URL (unambiguous absolute dynamic import)', () => {
    const cmd = appendStep()!.command;
    expect(cmd).toContain('import("file:///opt/futurator-daemon/lib/claude-md-writer.mjs")');
  });
});

/**
 * pacman1 F1 (2026-06-12) — lint at construction time. The pacman1
 * final-assembly story shipped a react-hooks/refs ERROR no story-level step
 * could see (lint lived only at the wave gate), stranding the fix on the
 * gate's bounded fixer. lint-verify runs eslint --fix in the story worktree
 * right after test-verify; failures inject LINT_ERROR into the DEV retry.
 */
describe('pacman1 F1 — lint-verify at construction time (mvp+)', () => {
  function lintStep(rigor: 'prototype' | 'mvp' | 'production') {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor });
    return pipeline.steps.find((s) => s.id === 'lint-verify') as
      | { command: string; onFail?: { action: string; injectAs?: string } }
      | undefined;
  }

  it('absent at prototype (rigor philosophy: loose), present at mvp + production', () => {
    expect(lintStep('prototype')).toBeUndefined();
    expect(lintStep('mvp')).toBeDefined();
    expect(lintStep('production')).toBeDefined();
  });

  it('runs right after test-verify, before tamper-check', () => {
    const pipeline = generateStoryPipeline(story, 'Test Epic', workingDir, { rigor: 'mvp' });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids.indexOf('lint-verify')).toBe(ids.indexOf('test-verify') + 1);
    expect(ids.indexOf('lint-verify')).toBeLessThan(ids.indexOf('tamper-check'));
  });

  it('mvp: --fix + errors block, warnings tolerated (no --max-warnings flag)', () => {
    const cmd = lintStep('mvp')!.command;
    expect(cmd).toContain('npx eslint --fix');
    expect(cmd).not.toContain('--max-warnings');
    expect(cmd).toContain('LINT_VERIFY_FAILED');
    expect(cmd).toContain('do NOT disable rules');
  });

  // dino1 (2026-06-13) — lint is SCOPED to the story's own files, never the
  // whole repo. `npx eslint .` would fail a types-only story on pre-existing
  // errors in scaffold files it never touched (and can't fix).
  it('scopes lint to the per-story delta + touch points (never whole-repo)', () => {
    const cmd = lintStep('mvp')!.command;
    expect(cmd).not.toContain('eslint . --fix'); // no whole-repo lint
    expect(cmd).toContain('-baseline-dirty.txt'); // baseline-subtraction (same as commit step)
    expect(cmd).toContain("for TP in 'src/main.js'"); // touch points are candidates
    expect(cmd).toContain('xargs -0 npx eslint'); // lints an explicit file list
    expect(cmd).toContain('no changed source files for this story'); // empty-delta skip
  });

  it('production: zero warnings (--max-warnings 0), matching the gate tier', () => {
    expect(lintStep('production')!.command).toContain('--max-warnings 0');
  });

  it('file-guarded for brownfield apps without eslint.config.mjs', () => {
    const cmd = lintStep('mvp')!.command;
    expect(cmd).toContain('[ -f eslint.config.mjs ]');
    expect(cmd).toContain('LINT_VERIFY_SKIPPED');
  });

  it('failure injects LINT_ERROR for the DEV retry (same mechanics as test-verify)', () => {
    const step = lintStep('mvp')!;
    expect(step.onFail?.action).toBe('fail');
    expect(step.onFail?.injectAs).toBe('LINT_ERROR');
  });

  it('shell is valid bash at both rigors', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const cmd = lintStep(rigor)!.command;
      expect(() => {
        execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' });
      }).not.toThrow();
    }
  });

  it('behavioral: passes on clean code, fails listing the error on lint-red code', () => {
    // Host the fixture INSIDE the repo (node_modules/.cache) so `npx eslint`
    // resolves the repo's local eslint instantly — a tmpdir outside the repo
    // makes npx cold-download eslint, which is slow and flaky in CI.
    mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'f1-lint-'));
    try {
      // Minimal flat eslint config with one rule that errors on `var`.
      writeFileSync(
        join(dir, 'eslint.config.mjs'),
        'export default [{ files: ["**/*.js"], rules: { "no-var": "error" } }];\n',
      );
      const pipeline = generateStoryPipeline(story, 'Test Epic', dir, { rigor: 'mvp' });
      const cmd = (pipeline.steps.find((s) => s.id === 'lint-verify') as { command: string })
        .command;

      // dino1 (2026-06-13) — lint is scoped to the story's files, so the
      // fixture must live at a declared touch point (story.touchPoints =
      // ['src/main.js']). Writing index.js would be (correctly) skipped.
      mkdirSync(join(dir, 'src'), { recursive: true });
      const target = join(dir, 'src', 'main.js');
      writeFileSync(target, 'let ok = 1;\nconsole.log(ok);\n');
      execSync(cmd, { cwd: dir, shell: '/bin/bash', stdio: 'pipe' }); // green

      writeFileSync(target, 'var bad = 1;\nconsole.log(bad);\n');
      let failed = false;
      let out = '';
      try {
        execSync(cmd, { cwd: dir, shell: '/bin/bash', stdio: 'pipe' });
      } catch (e) {
        failed = true;
        out = String((e as { stdout?: Buffer }).stdout ?? '');
      }
      // `var` is auto-fixable by --fix, so eslint repairs it silently — the
      // step must then PASS (auto-fixables ride the commit, like the gate's
      // mechanical tier). Verify the file was fixed in place.
      if (failed) {
        // If eslint version doesn't autofix here, the failure must at least
        // carry the marker + the rule output for the DEV retry.
        expect(out).toContain('LINT_VERIFY_FAILED');
        expect(out).toContain('no-var');
      } else {
        expect(String(execSync('cat src/main.js', { cwd: dir }))).toContain('let bad');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * dino1 (2026-06-13) — the construction gates (test-verify, lint-verify) must
 * loop the DEV back IN-PIPELINE carrying the captured error, not hard-fail into
 * a fresh daemon-retry job that loses the error context (the retry DEV then
 * sees the buggy file already on disk and concludes "no changes needed").
 */
describe('dino1 — construction gates loop to a DEV fixer that sees the error', () => {
  function steps(rigor: 'mvp' | 'production' = 'mvp') {
    return generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps as Array<{
      id: string;
      agentId?: string;
      resumeFromStep?: string;
      loopTo?: string;
      prompt?: string;
    }>;
  }

  it('lint-verify loops to lint-fix; test-verify loops to test-fix', () => {
    const s = steps();
    expect(s.find((x) => x.id === 'lint-verify')?.loopTo).toBe('lint-fix');
    expect(s.find((x) => x.id === 'test-verify')?.loopTo).toBe('test-fix');
  });

  it('lint-fix resumes the DEV session and surfaces LINT_ERROR + the react-hooks hint', () => {
    const fix = steps().find((x) => x.id === 'lint-fix')!;
    expect(fix.agentId).toBe('DEV');
    expect(fix.resumeFromStep).toBe('dev'); // reuse DEV context, don't re-implement cold
    expect(fix.prompt).toContain('{{LINT_ERROR}}');
    expect(fix.prompt).toContain('Cannot access refs during render'); // the dino1 failure class
    expect(fix.prompt).toContain('eslint-disable'); // explicitly forbids suppression
  });

  it('test-fix resumes the DEV session and surfaces TEST_VERIFY_ERROR', () => {
    const fix = steps().find((x) => x.id === 'test-fix')!;
    expect(fix.agentId).toBe('DEV');
    expect(fix.resumeFromStep).toBe('dev');
    expect(fix.prompt).toContain('{{TEST_VERIFY_ERROR}}');
  });

  it('fixer steps are loop-only (every loopTo target resolves to a real step)', () => {
    const s = steps();
    const ids = new Set(s.map((x) => x.id));
    for (const target of s.map((x) => x.loopTo).filter(Boolean)) {
      expect(ids.has(target as string)).toBe(true);
    }
    // the two new fixers exist as targets
    expect(ids.has('lint-fix')).toBe(true);
    expect(ids.has('test-fix')).toBe(true);
  });
});

/**
 * C1 (pacman1 audit, 2026-06-12) — the compiler's output must SHIP. The
 * COMPILER writes knowledge/ + .mycelium AFTER the story commit; per-story
 * worktrees are reaped post-merge, so without this step every article was
 * lost (pacman1 plan branch had zero knowledge files while
 * compile-knowledge completed on every story).
 */
describe('C1 — compile-knowledge-commit (compiler output ships)', () => {
  function steps(rigor: 'prototype' | 'mvp' = 'mvp') {
    return generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps;
  }

  it('sits AFTER compile-sync and BEFORE compile-push', () => {
    const ids = steps().map((s) => s.id);
    expect(ids).toContain('compile-knowledge-commit');
    expect(ids.indexOf('compile-knowledge-commit')).toBeGreaterThan(ids.indexOf('compile-sync'));
    expect(ids.indexOf('compile-knowledge-commit')).toBeLessThan(ids.indexOf('compile-push'));
  });

  it('stages knowledge + .mycelium + .context, commits only when staged, never blocks', () => {
    const step = steps().find((s) => s.id === 'compile-knowledge-commit') as {
      command: string;
      onFail?: { action: string };
    };
    expect(step.command).toContain('knowledge .mycelium .context');
    expect(step.command).toContain('KNOWLEDGE_COMMIT_SKIPPED');
    expect(step.command).toContain('KNOWLEDGE_COMMITTED');
    // Ship-tripwire: wiki on disk but not in HEAD is loud.
    expect(step.command).toContain('KNOWLEDGE_COMMIT_WARN');
    expect(step.onFail?.action).toBe('continue');
  });

  it('shell is valid bash', () => {
    const step = steps().find((s) => s.id === 'compile-knowledge-commit') as { command: string };
    expect(() => {
      execSync(`bash -n -c ${JSON.stringify(step.command)}`, { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('behavioral: commits compiler artifacts written AFTER the story commit (the pacman1 loss)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c1-knowledge-'));
    try {
      execSync(
        'git init -q && git -c user.email=t@t.local -c user.name=T commit --allow-empty -q -m "story: S-1 done"',
        { cwd: dir, shell: '/bin/bash' },
      );
      // The COMPILER writes the wiki post-commit (the lost state).
      mkdirSync(join(dir, 'knowledge', 'code'), { recursive: true });
      writeFileSync(join(dir, 'knowledge', 'code', 'src--main.js.md'), '# main\nPurpose: entry\n');
      mkdirSync(join(dir, '.mycelium'), { recursive: true });
      writeFileSync(join(dir, '.mycelium', 'ast-facts.json'), '{"fileCount":1}');

      const pipeline = generateStoryPipeline(story, 'Test Epic', dir, { rigor: 'mvp' });
      const cmd = (
        pipeline.steps.find((s) => s.id === 'compile-knowledge-commit') as { command: string }
      ).command;
      const out = execSync(cmd, { cwd: dir, shell: '/bin/bash', encoding: 'utf8' });
      expect(out).toContain('KNOWLEDGE_COMMITTED story=S-1');

      const inHead = execSync('git ls-tree -r --name-only HEAD -- knowledge', {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(inHead).toContain('knowledge/code/src--main.js.md');

      // Idempotent: nothing new → skip, no error.
      const out2 = execSync(cmd, { cwd: dir, shell: '/bin/bash', encoding: 'utf8' });
      expect(out2).toContain('KNOWLEDGE_COMMIT_SKIPPED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * pacman4 deadlock fix (2026-06-19) — a lint/parse error INSIDE a test file
 * is an unbreakable loop: lint-verify catches it → routes to lint-fix (DEV) →
 * DEV edits the test file → tamper-check reverts the edit and fails →
 * lint-verify catches it again … until retries exhaust. The collision story
 * `it('returns X when pac-man's tile …')` (apostrophe closing a single-quoted
 * string) hit exactly this. Three coordinated changes break it:
 *   A. stage-test-files lint-validates the authored test files and loops any
 *      failure back to test-fix-author (the contract owner), never DEV.
 *   A'. lint-verify drops tamper-frozen test files from its per-story set.
 *   B. test-verify propagates the runner's real exit code (was always 0).
 */
describe('pacman4 — test-file lint deadlock fix', () => {
  function steps(rigor: 'prototype' | 'mvp' | 'production' = 'mvp') {
    return generateStoryPipeline(story, 'Test Epic', workingDir, { rigor }).steps as Array<{
      id: string;
      agentId?: string;
      resumeFromStep?: string;
      loopTo?: string;
      prompt?: string;
      command?: string;
      expectExitCode?: number;
      onFail?: { action: string; injectAs?: string };
      extractors?: Record<string, unknown>;
    }>;
  }
  const stage = (rigor: 'mvp' | 'production' = 'mvp') =>
    steps(rigor).find((s) => s.id === 'stage-test-files')!;

  // ── A: stage-test-files lint-validates the contract before freezing it ──
  it('stage-test-files runs eslint --fix on the authored test files (flat-config guarded)', () => {
    const cmd = stage().command!;
    expect(cmd).toContain('[ -f eslint.config.mjs ]');
    expect(cmd).toContain('xargs -0 npx eslint --fix');
    expect(cmd).toContain('TEST_AUTHOR_LINT_FAILED');
  });

  it('stage-test-files is now a hard gate that loops to test-fix-author', () => {
    const s = stage();
    expect(s.expectExitCode).toBe(0);
    expect(s.onFail?.action).toBe('fail');
    expect(s.onFail?.injectAs).toBe('TEST_LINT_ERROR');
    expect(s.loopTo).toBe('test-fix-author');
  });

  it('preserves the no-test-files skip (exit 0) so non-test stories never loop', () => {
    expect(stage().command!).toContain('STAGE_TEST_FILES_SKIPPED');
  });

  it('stage-test-files shell is valid bash at mvp + production', () => {
    for (const rigor of ['mvp', 'production'] as const) {
      const cmd = stage(rigor).command!;
      expect(() => execSync(`bash -n -c ${JSON.stringify(cmd)}`, { stdio: 'pipe' })).not.toThrow();
    }
  });

  // ── A: the fixer is the TEST agent, not DEV (DEV may never touch tests) ──
  it('test-fix-author resumes the TEST session and carries the eslint error', () => {
    const fix = steps().find((s) => s.id === 'test-fix-author');
    expect(fix).toBeDefined();
    expect(fix!.agentId).toBe('TEST');
    expect(fix!.resumeFromStep).toBe('test-author');
    expect(fix!.prompt).toContain('{{TEST_LINT_ERROR}}');
    // Teaches the exact pacman4 failure + re-emits the contract for re-staging.
    expect(fix!.prompt).toMatch(/apostrophe[\s\S]*single-quoted/i);
    expect(fix!.prompt).toContain('---TEST_FILES---');
    expect(fix!.extractors).toHaveProperty('TEST_FILES');
  });

  it('test-fix-author is loop-only and present only at mvp+ (with stage-test-files)', () => {
    expect(steps('prototype').find((s) => s.id === 'test-fix-author')).toBeUndefined();
    const ids = new Set(steps().map((s) => s.id));
    // every loopTo target resolves to a real step (incl. the new one)
    for (const t of steps()
      .map((s) => s.loopTo)
      .filter(Boolean)) {
      expect(ids.has(t as string)).toBe(true);
    }
    expect(ids.has('test-fix-author')).toBe(true);
  });

  // ── A': lint-verify no longer lints tamper-frozen test files ──
  it('lint-verify excludes test/spec/__tests__/e2e/tests from its per-story set', () => {
    const cmd = steps().find((s) => s.id === 'lint-verify')!.command!;
    expect(cmd).toContain("grep -vE '\\.(test|spec)\\.[jt]sx?$|(^|/)__tests__/|^e2e/|^tests/'");
  });

  // ── B: test-verify propagates the runner exit code ──
  it('test-verify captures the runner status and exits with it (no `|| true` swallow)', () => {
    const cmd = steps().find((s) => s.id === 'test-verify')!.command!;
    expect(cmd).toContain('RC=0');
    expect(cmd).toContain('|| RC=$?');
    expect(cmd).toMatch(/exit \$RC$/);
    // PR-40 contract preserved: vitest --changed with npm test fallback.
    expect(cmd).toContain('npx vitest run --changed HEAD~1');
    expect(cmd).toContain('|| npm test');
    // The exact bug shape — a trailing `tail … || true` — must be gone.
    expect(cmd).not.toMatch(/tail -80 \/tmp\/test-verify\.log \|\| true/);
  });

  it('behavioral: the RC-propagation pattern returns non-zero when the runner fails', () => {
    // Mirror the test-verify shape with `false` standing in for a failing run.
    const fail = `RC=0; ( false > /tmp/tv.log 2>&1 || false > /tmp/tv.log 2>&1 ) || RC=$?; : ; exit $RC`;
    let code = 0;
    try {
      execSync(fail, { shell: '/bin/bash', stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? 0;
    }
    expect(code).not.toBe(0);
    // …and zero when either path passes.
    expect(() =>
      execSync(`RC=0; ( false || true ) || RC=$?; exit $RC`, { shell: '/bin/bash', stdio: 'pipe' }),
    ).not.toThrow();
  });

  // ── End-to-end: the exact pacman4 trigger now fails at the contract author,
  //    not in a tamper loop; the corrected file lints clean and gets staged. ──
  it('behavioral: apostrophe-in-single-quote test file fails stage-test-files, double-quote passes + stages', () => {
    // Host inside node_modules/.cache so `npx eslint` resolves the repo's local
    // eslint instantly (same trick as the lint-verify behavioral test).
    mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'pacman4-stage-'));
    try {
      execSync(
        'git init -q && git -c user.email=t@t.local -c user.name=T commit --allow-empty -q -m base',
        { cwd: dir, shell: '/bin/bash' },
      );
      writeFileSync(
        join(dir, 'eslint.config.mjs'),
        'export default [{ files: ["**/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "module" } }];\n',
      );
      mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
      const testPath = 'src/__tests__/collision.test.js';

      const rawCmd = (
        generateStoryPipeline(story, 'Test Epic', dir, { rigor: 'mvp' }).steps.find(
          (s) => s.id === 'stage-test-files',
        ) as { command: string }
      ).command;
      // Substitute the {{TEST_FILES}} placeholder the daemon fills at runtime.
      const cmd = rawCmd.replace(
        '{{TEST_FILES}}',
        `---TEST_FILES---\n${testPath}\n---END_TEST_FILES---`,
      );

      // (1) The pacman4 defect: the apostrophe in pac-man's closes the string.
      writeFileSync(
        join(dir, testPath),
        `it('returns dot when pac-man's tile has a dot', () => {});\n`,
      );
      let failed = false;
      let out = '';
      try {
        execSync(cmd, { cwd: dir, shell: '/bin/bash', stdio: 'pipe' });
      } catch (e) {
        failed = true;
        out =
          String((e as { stdout?: Buffer }).stdout ?? '') +
          String((e as { stderr?: Buffer }).stderr ?? '');
      }
      expect(failed).toBe(true);
      expect(out).toContain('TEST_AUTHOR_LINT_FAILED');
      // The broken file was NOT staged (never became a baseline).
      expect(
        execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf8' }),
      ).not.toContain(testPath);

      // (2) test-author's fix (double quotes) lints clean → stages → exit 0.
      writeFileSync(
        join(dir, testPath),
        `it("returns dot when pac-man's tile has a dot", () => {});\n`,
      );
      const ok = execSync(cmd, { cwd: dir, shell: '/bin/bash', encoding: 'utf8' });
      expect(ok).toContain('STAGE_TEST_FILES_OK');
      expect(execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf8' })).toContain(
        testPath,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
