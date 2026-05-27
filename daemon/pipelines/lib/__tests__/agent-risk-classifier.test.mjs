import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDiff,
  loadDangerConfig,
  _resetDangerConfigCache,
  RISK_CLASSES,
} from '../agent-risk-classifier.mjs';

/**
 * 2026-05-27 PR B.b — risk classifier coverage.
 *
 * Covers:
 *   - red branch: each danger pattern from v1 spec → red
 *   - red dominates: red + yellow + green files together → still red
 *   - yellow path branch (functions/api/index.ts, src/components/labs/**)
 *   - yellow line-threshold branch (>50 non-test lines)
 *   - yellow line-threshold IGNORES tests (50 test-file lines stays green)
 *   - green default
 *   - empty touchedPaths → green with reason
 *   - self-referential: changes to the classifier or json file → red
 *   - glob handling: `*` vs `**` boundary cases
 */

let tmpDir;
let configPath;

function writeConfig(json) {
  configPath = join(tmpDir, 'danger.json');
  writeFileSync(configPath, JSON.stringify(json));
  _resetDangerConfigCache();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'risk-test-'));
  writeConfig({
    red_patterns: [
      'daemon/**',
      'functions/cron/**',
      'sst.config.ts',
      'functions/shared/auth-middleware.ts',
      'functions/shared/repositories/**',
      '.github/workflows/**',
      'daemon/lib/agent-danger-paths.json',
      'daemon/pipelines/lib/agent-risk-classifier.mjs',
      'daemon/lib/git-deny-list.json',
    ],
    yellow_path_patterns: ['functions/api/index.ts', 'src/components/labs/**'],
    yellow_line_threshold: 50,
    version: 1,
  });
});

describe('RISK_CLASSES', () => {
  it('exports the three canonical class names', () => {
    expect(RISK_CLASSES).toEqual(['red', 'yellow', 'green']);
  });
});

describe('loadDangerConfig', () => {
  it('parses the json into structured fields', () => {
    const cfg = loadDangerConfig(configPath);
    expect(cfg.redPatterns).toContain('daemon/**');
    expect(cfg.yellowPathPatterns).toContain('functions/api/index.ts');
    expect(cfg.yellowLineThreshold).toBe(50);
  });
});

describe('classifyDiff — red', () => {
  it.each([
    'daemon/agent-daemon.mjs',
    'daemon/pipelines/free-agent-session.mjs',
    'daemon/lib/worktree-reaper.mjs',
    'functions/cron/wave-completion-check.ts',
    'sst.config.ts',
    'functions/shared/auth-middleware.ts',
    'functions/shared/repositories/free-agent-sessions-repository.ts',
    '.github/workflows/ci.yml',
    'daemon/lib/agent-danger-paths.json',
    'daemon/pipelines/lib/agent-risk-classifier.mjs',
    'daemon/lib/git-deny-list.json',
  ])('flags red when touching %s', (path) => {
    const result = classifyDiff({ touchedPaths: [path], additions: 1, deletions: 0 }, configPath);
    expect(result.class).toBe('red');
    expect(result.reasons[0]).toMatch(/red pattern/);
  });

  it('red dominates when a diff also touches yellow + green files', () => {
    const result = classifyDiff(
      {
        touchedPaths: ['docs/notes.md', 'functions/api/index.ts', 'daemon/agent-daemon.mjs'],
        additions: 5,
        deletions: 3,
      },
      configPath,
    );
    expect(result.class).toBe('red');
  });
});

describe('classifyDiff — yellow', () => {
  it('flags yellow when touching functions/api/index.ts (no red files)', () => {
    const result = classifyDiff(
      { touchedPaths: ['functions/api/index.ts'], additions: 5, deletions: 1 },
      configPath,
    );
    expect(result.class).toBe('yellow');
    expect(result.reasons.some((r) => r.includes('yellow pattern'))).toBe(true);
  });

  it('flags yellow for new src/components/labs/** files', () => {
    const result = classifyDiff(
      { touchedPaths: ['src/components/labs/widgets/new-thing.tsx'], additions: 30, deletions: 0 },
      configPath,
    );
    expect(result.class).toBe('yellow');
  });

  it('flags yellow when non-test diff exceeds the line threshold', () => {
    const result = classifyDiff(
      { touchedPaths: ['src/foo.ts'], additions: 60, deletions: 5 },
      configPath,
    );
    expect(result.class).toBe('yellow');
    expect(result.reasons.some((r) => r.includes('exceeds yellow threshold'))).toBe(true);
  });

  it('stays green when only test-file lines exceed the threshold', () => {
    const result = classifyDiff(
      {
        touchedPaths: ['src/__tests__/big.test.ts', 'src/foo.test.ts'],
        additions: 200,
        deletions: 0,
      },
      configPath,
    );
    expect(result.class).toBe('green');
  });

  it('counts threshold lines when both test and non-test files are present', () => {
    // 80 lines across one non-test file + one test file → still triggers
    // the line-threshold rule because at least one non-test file is in
    // the diff.
    const result = classifyDiff(
      {
        touchedPaths: ['src/foo.ts', 'src/__tests__/foo.test.ts'],
        additions: 80,
        deletions: 0,
      },
      configPath,
    );
    expect(result.class).toBe('yellow');
  });
});

describe('classifyDiff — green', () => {
  it('returns green for docs-only diffs', () => {
    const result = classifyDiff(
      { touchedPaths: ['docs/foo.md', 'README.md'], additions: 12, deletions: 4 },
      configPath,
    );
    expect(result.class).toBe('green');
    expect(result.reasons).toEqual([]);
  });

  it('returns green for small non-danger src changes', () => {
    const result = classifyDiff(
      { touchedPaths: ['src/lib/util.ts'], additions: 8, deletions: 2 },
      configPath,
    );
    expect(result.class).toBe('green');
  });

  it('returns green with explicit reason when touchedPaths is empty', () => {
    const result = classifyDiff(
      { touchedPaths: [], additions: 0, deletions: 0 },
      configPath,
    );
    expect(result.class).toBe('green');
    expect(result.reasons[0]).toBe('no touched paths');
  });
});

describe('classifyDiff — glob edge cases', () => {
  it('matches `daemon/**` against deeply nested files', () => {
    const result = classifyDiff(
      { touchedPaths: ['daemon/pipelines/lib/foo/bar/baz.mjs'], additions: 1, deletions: 0 },
      configPath,
    );
    expect(result.class).toBe('red');
  });

  it('does not match `daemon/**` against unrelated paths', () => {
    const result = classifyDiff(
      { touchedPaths: ['daemons/foo.mjs', 'docs/daemon-notes.md'], additions: 1, deletions: 0 },
      configPath,
    );
    expect(result.class).toBe('green');
  });

  it('exact-path pattern only matches the exact path', () => {
    // `sst.config.ts` is an exact match, not a glob
    const stillExact = classifyDiff(
      { touchedPaths: ['sst.config.ts'], additions: 1, deletions: 0 },
      configPath,
    );
    expect(stillExact.class).toBe('red');
    const closeNope = classifyDiff(
      { touchedPaths: ['sst.config.test.ts'], additions: 1, deletions: 0 },
      configPath,
    );
    expect(closeNope.class).toBe('green');
  });
});

describe('classifyDiff — self-reference', () => {
  it('classifies edits to the classifier source as red', () => {
    const result = classifyDiff(
      {
        touchedPaths: ['daemon/pipelines/lib/agent-risk-classifier.mjs'],
        additions: 5,
        deletions: 1,
      },
      configPath,
    );
    expect(result.class).toBe('red');
  });

  it('classifies edits to the danger-paths json as red', () => {
    const result = classifyDiff(
      { touchedPaths: ['daemon/lib/agent-danger-paths.json'], additions: 1, deletions: 0 },
      configPath,
    );
    expect(result.class).toBe('red');
  });
});

describe('default v1 config — sanity', () => {
  it('the shipped config classifies the canonical red paths correctly', async () => {
    _resetDangerConfigCache();
    // Use the real config file (no override) — sanity-check the file the
    // operator + agent will actually see in production.
    const result = classifyDiff({
      touchedPaths: ['daemon/agent-daemon.mjs'],
      additions: 1,
      deletions: 0,
    });
    expect(result.class).toBe('red');
  });
});

afterAll(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
