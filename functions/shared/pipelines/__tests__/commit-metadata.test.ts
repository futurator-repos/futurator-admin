/**
 * commit-metadata.test.ts — exercises the shell-snippet builder that
 * emits `Skills-Used:` and `Skills-Manifest-Sha:` commit trailers
 * (PR-73 + PR-85), plus the parse helpers analytics consumers use.
 *
 * The snippet is computed by the LAMBDA at job-creation time, so these
 * tests verify the bash string contents — not the runtime behavior. A
 * downstream test plan against a real worktree on EC2 is what proves the
 * trailer actually lands; this test pins the contract.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCommitShellSnippet,
  parseSkillsUsedLine,
  parseSkillsManifestShaLine,
} from '../commit-metadata';

describe('buildCommitShellSnippet — rigor gating', () => {
  it('prototype rigor: only emits subject, no trailers', () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-1',
      storyTitle: 'Add hello',
      rigor: 'prototype',
    });
    expect(snippet).toContain("commit -m 'story: STORY-1 — Add hello'");
    expect(snippet).not.toContain('Skills-Used');
    expect(snippet).not.toContain('Skills-Manifest-Sha');
    expect(snippet).not.toContain('sha256sum');
  });

  it('mvp rigor: emits subject + Skills-Used + Manifest-Sha shell-time computation', () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-2',
      storyTitle: 'Wire feature',
      rigor: 'mvp',
    });
    expect(snippet).toContain('Skills-Used:');
    expect(snippet).toContain('Skills-Manifest-Sha:');
    expect(snippet).toContain('sha256sum .claude/skills.manifest.yaml');
    expect(snippet).toContain('.context/loaded-skills.json');
    expect(snippet).toContain("COMMIT_MSG='story: STORY-2 — Wire feature'");
    expect(snippet).toContain('commit -m "$COMMIT_MSG"');
  });

  it('mvp rigor: wraps trailer logic in a subshell with `;` separators (valid bash)', () => {
    // Regression: an earlier draft joined statements with `&&`, which
    // breaks bash if/then/fi parsing — `then &&` and `fi && if` are
    // syntax errors. Use `(` ... `)` + `;` separators instead so the
    // subshell's exit code propagates the final `git commit`.
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-X',
      storyTitle: 'Bash regression guard',
      rigor: 'mvp',
    });
    expect(snippet.startsWith('( ')).toBe(true);
    expect(snippet.endsWith(' )')).toBe(true);
    expect(snippet).not.toMatch(/then\s*&&/);
    expect(snippet).not.toMatch(/fi\s*&&\s*if/);
    expect(snippet).not.toMatch(/else\s*&&/);
  });

  it('production rigor: same trailer scope as mvp', () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-3',
      storyTitle: 'Prod story',
      rigor: 'production',
    });
    expect(snippet).toContain('Skills-Used:');
    expect(snippet).toContain('Skills-Manifest-Sha:');
  });
});

describe('buildCommitShellSnippet — bash safety', () => {
  it("escapes apostrophes in story titles so the bash 'single-quoted' subject survives", () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-4',
      storyTitle: "Fix Ricky's bug",
      rigor: 'mvp',
    });
    // Bash single-quote escape: '...'\''..'  ↦  closes quote, escapes ', reopens
    expect(snippet).toContain("Fix Ricky'\\''s bug");
  });

  it('skips the manifest line when the file is missing (shell guards with -f)', () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-5',
      storyTitle: 'No manifest yet',
      rigor: 'mvp',
    });
    expect(snippet).toContain('if [ -f .claude/skills.manifest.yaml ]');
  });

  it('falls back to label-only Skills-Used when loaded-skills.json is missing/empty', () => {
    const snippet = buildCommitShellSnippet({
      storyId: 'STORY-6',
      storyTitle: 'Empty skills',
      rigor: 'mvp',
    });
    expect(snippet).toContain('Skills-Used:');
    expect(snippet).toContain('if [ -f .context/loaded-skills.json ]');
  });
});

describe('parseSkillsUsedLine', () => {
  it('extracts the comma-separated list', () => {
    const msg = `story: foo

Skills-Used: a@x, b@y, c@z

Skills-Manifest-Sha: ${'a'.repeat(64)}`;
    expect(parseSkillsUsedLine(msg)).toEqual(['a@x', 'b@y', 'c@z']);
  });

  it('returns [] when the line is label-only', () => {
    expect(parseSkillsUsedLine('subject\n\nSkills-Used:')).toEqual([]);
    expect(parseSkillsUsedLine('subject\n\nSkills-Used:   ')).toEqual([]);
  });

  it('returns [] when the line is absent', () => {
    expect(parseSkillsUsedLine('subject\n\nno trailers here')).toEqual([]);
  });
});

describe('parseSkillsManifestShaLine', () => {
  it('extracts a valid 64-char hex sha', () => {
    const sha = 'deadbeef'.padEnd(64, '0');
    const msg = `subject\n\nSkills-Manifest-Sha: ${sha}`;
    expect(parseSkillsManifestShaLine(msg)).toBe(sha);
  });

  it('returns null for too-short or non-hex shas', () => {
    expect(parseSkillsManifestShaLine('subject\n\nSkills-Manifest-Sha: short')).toBeNull();
    expect(
      parseSkillsManifestShaLine('subject\n\nSkills-Manifest-Sha: ' + 'z'.repeat(64)),
    ).toBeNull();
  });

  it('returns null when the line is absent', () => {
    expect(parseSkillsManifestShaLine('subject only')).toBeNull();
  });
});
