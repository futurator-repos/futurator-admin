/**
 * story-skills-inject.test.mjs — G2 unit tests.
 *
 * Tests the glue layer that wires skills injection, activation tracking,
 * commit trailer flags, and per-story reset into the P3 story-dev path.
 *
 * Hermetic: heavy dependencies (buildSkillsPushPrompt, buildInjection) are
 * mocked so tests run without embedding endpoints or full skill loadouts.
 * Tracker + commit flag functions use real temp-dir filesystem I/O (mirrors
 * the loaded-skills-tracker tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock heavy dependencies before importing the module under test ────────────

const mockBuildInjection = vi.fn();
const mockClaudeCodeAppendArgs = vi.fn();
const mockBuildSkillsPushPrompt = vi.fn();
const mockSelectPushedSkillNames = vi.fn();

vi.mock('../../../lib/subagent-start.mjs', () => ({
  buildInjection: (...a) => mockBuildInjection(...a),
  claudeCodeAppendArgs: (...a) => mockClaudeCodeAppendArgs(...a),
}));

vi.mock('../../../lib/skills-prompt.mjs', () => ({
  buildSkillsPushPrompt: (...a) => mockBuildSkillsPushPrompt(...a),
  selectPushedSkillNames: (...a) => mockSelectPushedSkillNames(...a),
}));

// loaded-skills-tracker and commit-metadata are NOT mocked — real I/O.

const {
  buildSkillsInjection,
  trackSkillActivations,
  buildStoryCommitFlags,
  resetStorySkills,
  readStoryLoadedSkills,
} = await import('../story-skills-inject.mjs');

// integrateStory is NOT mocked — import at top level so the regression
// describe block can reference it without an async describe callback.
const { integrateStory } = await import('../../../lib/story-integrate.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MANIFEST = `project: my-app
manifest-version: 1
core:
  - source: anthropic-official
    skill: frontend-design
    version: tag:v1
stack:
  - source: vercel-web
    skill: best-practices
    version: tag:v2
domain: []
vendor: []
plans: {}
gaps: []
`;

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'ssi-'));
}

function withManifest(dir) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills.manifest.yaml'), MANIFEST, 'utf-8');
  return dir;
}

function withLoadedSkills(dir, skills) {
  mkdirSync(join(dir, '.context'), { recursive: true });
  writeFileSync(
    join(dir, '.context', 'loaded-skills.json'),
    JSON.stringify(skills),
    'utf-8',
  );
  return dir;
}

// ── buildSkillsInjection ─────────────────────────────────────────────────────

describe('buildSkillsInjection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: base injection returns empty, skills returns null, adapter returns []
    mockBuildInjection.mockReturnValue('');
    mockBuildSkillsPushPrompt.mockResolvedValue(null);
    mockSelectPushedSkillNames.mockResolvedValue({ pushed: [], ranked: false });
    mockClaudeCodeAppendArgs.mockImplementation((text) =>
      text && text.trim() ? ['--append-system-prompt', text] : [],
    );
  });

  it('primary path: combines base + skills into ONE --append-system-prompt', async () => {
    mockBuildInjection.mockReturnValue('LAZY-RULES');
    mockBuildSkillsPushPrompt.mockResolvedValue('SKILLS-PUSH');

    const args = await buildSkillsInjection({
      workingDir: '/wd',
      storyText: 'implement accordion',
      p3Flags: { P3_LAZY_MODE: 'lite' },
    });

    // claudeCodeAppendArgs was called with the joined text
    expect(mockClaudeCodeAppendArgs).toHaveBeenCalledWith('LAZY-RULES\n\n---\n\nSKILLS-PUSH');
    // returns the adapter output
    expect(args).toEqual(['--append-system-prompt', 'LAZY-RULES\n\n---\n\nSKILLS-PUSH']);
  });

  it('skills-only: no base injection + skills present', async () => {
    mockBuildInjection.mockReturnValue('');
    mockBuildSkillsPushPrompt.mockResolvedValue('SKILLS-ONLY');

    const args = await buildSkillsInjection({ workingDir: '/wd', storyText: 'story' });

    expect(mockClaudeCodeAppendArgs).toHaveBeenCalledWith('SKILLS-ONLY');
    expect(args).toEqual(['--append-system-prompt', 'SKILLS-ONLY']);
  });

  it('base-only: skills build throws → falls back gracefully', async () => {
    mockBuildInjection.mockReturnValue('BASE-ONLY');
    mockBuildSkillsPushPrompt.mockRejectedValue(new Error('embed API down'));

    const args = await buildSkillsInjection({ workingDir: '/wd', storyText: 'story' });

    expect(mockClaudeCodeAppendArgs).toHaveBeenCalledWith('BASE-ONLY');
    expect(args).toEqual(['--append-system-prompt', 'BASE-ONLY']);
  });

  it('both empty → returns []', async () => {
    mockBuildInjection.mockReturnValue('');
    mockBuildSkillsPushPrompt.mockResolvedValue(null);
    mockClaudeCodeAppendArgs.mockReturnValue([]);

    const args = await buildSkillsInjection({ workingDir: '/wd', storyText: '' });

    expect(args).toEqual([]);
  });

  it('total failure in buildInjection → returns [] without throwing', async () => {
    mockBuildInjection.mockImplementation(() => { throw new Error('boom'); });

    await expect(buildSkillsInjection({ workingDir: '/wd', storyText: 'x' })).resolves.toEqual([]);
  });

  it('passes p3Flags to buildInjection', async () => {
    mockBuildInjection.mockReturnValue('');
    mockBuildSkillsPushPrompt.mockResolvedValue(null);

    const flags = { P3_LAZY_MODE: 'full', OTHER: 'val' };
    await buildSkillsInjection({ workingDir: '/wd', storyText: 'x', p3Flags: flags });

    expect(mockBuildInjection).toHaveBeenCalledWith({ p3Flags: flags });
  });

  it('passes workingDir + storyText to buildSkillsPushPrompt', async () => {
    mockBuildInjection.mockReturnValue('');
    mockBuildSkillsPushPrompt.mockResolvedValue(null);

    await buildSkillsInjection({ workingDir: '/my/wd', storyText: 'the story text' });

    expect(mockBuildSkillsPushPrompt).toHaveBeenCalledWith('/my/wd', 'the story text');
  });
});

// ── trackSkillActivations ────────────────────────────────────────────────────

describe('trackSkillActivations', () => {
  let dir;

  beforeEach(() => {
    dir = withManifest(makeDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('primary path: records Skill tool_use from assistant message content', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } },
        ],
      },
    };
    const rawOutput = JSON.stringify(event) + '\n';

    const r = trackSkillActivations({ workingDir: dir, rawOutput });

    expect(r.recorded).toBe(1);
    const skills = JSON.parse(readFileSync(join(dir, '.context', 'loaded-skills.json'), 'utf-8'));
    expect(skills).toEqual([{ skill: 'frontend-design', source: 'anthropic-official' }]);
  });

  it('records top-level tool_use Skill event', () => {
    const event = {
      type: 'tool_use',
      name: 'Skill',
      input: { skill: 'best-practices' },
    };
    const rawOutput = JSON.stringify(event) + '\n';

    const r = trackSkillActivations({ workingDir: dir, rawOutput });

    expect(r.recorded).toBe(1);
  });

  it('skips non-Skill tool_use events', () => {
    const lines = [
      JSON.stringify({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] } }),
    ].join('\n');

    const r = trackSkillActivations({ workingDir: dir, rawOutput: lines });

    expect(r.recorded).toBe(0);
  });

  it('handles non-JSON lines gracefully (returns recorded=0)', () => {
    const rawOutput = 'not json\n{also not}\nmore garbage\n';

    expect(() => trackSkillActivations({ workingDir: dir, rawOutput })).not.toThrow();
    const r = trackSkillActivations({ workingDir: dir, rawOutput });
    expect(r.recorded).toBe(0);
  });

  it('records multiple skills across multiple events', () => {
    const lines = [
      JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } }),
      JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'best-practices' } }),
    ].join('\n');

    const r = trackSkillActivations({ workingDir: dir, rawOutput: lines });

    expect(r.recorded).toBe(2);
  });

  it('deduplicates: re-recording same skill is not counted again', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } });
    const rawOutput = line + '\n' + line + '\n';

    const r = trackSkillActivations({ workingDir: dir, rawOutput });

    expect(r.recorded).toBe(1);
  });

  it('returns { recorded: 0 } when rawOutput is empty', () => {
    expect(trackSkillActivations({ workingDir: dir, rawOutput: '' })).toEqual({ recorded: 0 });
  });

  it('returns { recorded: 0 } when workingDir is falsy', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } });
    expect(trackSkillActivations({ workingDir: null, rawOutput: line })).toEqual({ recorded: 0 });
  });

  it('falls back to source=unknown for skills not in manifest', () => {
    const line = JSON.stringify({ type: 'tool_use', name: 'Skill', input: { skill: 'mystery-skill' } });

    const r = trackSkillActivations({ workingDir: dir, rawOutput: line });

    expect(r.recorded).toBe(1);
    const skills = JSON.parse(readFileSync(join(dir, '.context', 'loaded-skills.json'), 'utf-8'));
    expect(skills[0].source).toBe('unknown');
  });
});

// ── buildStoryCommitFlags ────────────────────────────────────────────────────

describe('buildStoryCommitFlags', () => {
  let dir;

  beforeEach(() => {
    dir = withManifest(makeDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prototype rigor → empty array even with loaded skills', () => {
    withLoadedSkills(dir, [{ skill: 'frontend-design', source: 'anthropic-official' }]);

    const flags = buildStoryCommitFlags({ workingDir: dir, rigor: 'prototype' });

    expect(flags).toEqual([]);
  });

  it('mvp rigor + loaded skills → Skills-Used + Skills-Manifest-Sha lines', () => {
    withLoadedSkills(dir, [{ skill: 'frontend-design', source: 'anthropic-official' }]);

    const flags = buildStoryCommitFlags({ workingDir: dir, rigor: 'mvp' });

    expect(flags.length).toBe(2);
    expect(flags[0]).toBe('Skills-Used: frontend-design@anthropic-official');
    expect(flags[1]).toMatch(/^Skills-Manifest-Sha: [a-f0-9]{64}$/);
  });

  it('mvp rigor + no loaded skills → Skills-Used: (label only) + Sha line', () => {
    // No .context/loaded-skills.json written → readLoadedSkills returns []

    const flags = buildStoryCommitFlags({ workingDir: dir, rigor: 'mvp' });

    expect(flags[0]).toBe('Skills-Used:');
  });

  it('production rigor → emits both lines', () => {
    withLoadedSkills(dir, [{ skill: 'best-practices', source: 'vercel-web' }]);

    const flags = buildStoryCommitFlags({ workingDir: dir, rigor: 'production' });

    expect(flags).toHaveLength(2);
    expect(flags[0]).toContain('best-practices@vercel-web');
  });

  it('never throws on bad workingDir', () => {
    expect(() => buildStoryCommitFlags({ workingDir: '/no/such/dir', rigor: 'mvp' })).not.toThrow();
  });
});

// ── resetStorySkills ─────────────────────────────────────────────────────────

describe('resetStorySkills', () => {
  let dir;

  beforeEach(() => {
    dir = makeDir();
    mkdirSync(join(dir, '.context'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears the loaded-skills file to []', () => {
    writeFileSync(
      join(dir, '.context', 'loaded-skills.json'),
      '[{"skill":"x","source":"y"}]',
      'utf-8',
    );

    resetStorySkills(dir);

    const contents = JSON.parse(readFileSync(join(dir, '.context', 'loaded-skills.json'), 'utf-8'));
    expect(contents).toEqual([]);
  });

  it('is a no-op when no file exists (does not throw)', () => {
    expect(() => resetStorySkills(dir)).not.toThrow();
  });

  it('is a no-op with undefined workingDir', () => {
    expect(() => resetStorySkills(undefined)).not.toThrow();
  });
});

// ── integrateStory extraCommitFlagBodies (regression from story-integrate.mjs edit) ────

describe('integrateStory extraCommitFlagBodies', () => {
  function fakeGit(script) {
    const calls = [];
    const git = async (args, _cwd) => {
      calls.push([...args]);
      const key = args.slice(0, 2).join(' ');
      const r = script[key] ?? script[args[0]] ?? { code: 0, stdout: '', stderr: '' };
      return typeof r === 'function' ? r(args) : r;
    };
    return { git, calls };
  }

  it('appends extraCommitFlagBodies as -m pairs in array args (no shell-quoting)', async () => {
    const { git, calls } = fakeGit({
      add: { code: 0 },
      'diff --cached': { code: 0, stdout: 'x.ts\n' },
      commit: { code: 0 },
      'rev-parse': { code: 0, stdout: 'sha1\n' },
    });

    await integrateStory({
      repoDir: '/r',
      touches: ['x.ts'],
      storyId: 's1',
      title: 'Wire it',
      git,
      extraCommitFlagBodies: ['Skills-Used: frontend-design@anthropic-official', 'Skills-Manifest-Sha: ' + 'a'.repeat(64)],
    });

    const commitCall = calls.find((a) => a[0] === 'commit');
    expect(commitCall).toBeDefined();
    // Expect array structure: ['commit', '-m', subject, '-m', body1, '-m', body2]
    const mPairs = [];
    for (let i = 0; i < commitCall.length; i++) {
      if (commitCall[i] === '-m') mPairs.push(commitCall[i + 1]);
    }
    expect(mPairs.length).toBe(3); // subject + 2 extra bodies
    expect(mPairs[1]).toBe('Skills-Used: frontend-design@anthropic-official');
    expect(mPairs[2]).toBe('Skills-Manifest-Sha: ' + 'a'.repeat(64));
  });

  it('no extraCommitFlagBodies → only subject -m flag (backward compat)', async () => {
    const { git, calls } = fakeGit({
      add: { code: 0 },
      'diff --cached': { code: 0, stdout: 'x.ts\n' },
      commit: { code: 0 },
      'rev-parse': { code: 0, stdout: 'sha2\n' },
    });

    await integrateStory({ repoDir: '/r', touches: ['x.ts'], storyId: 's2', git });

    const commitCall = calls.find((a) => a[0] === 'commit');
    const mPairs = [];
    for (let i = 0; i < commitCall.length; i++) {
      if (commitCall[i] === '-m') mPairs.push(commitCall[i + 1]);
    }
    expect(mPairs.length).toBe(1); // subject only
  });
});

// ── pushed-skill recording (G2 parity fix) ────────────────────────────────────
// PUSH-injected skill bodies never fire a `Skill` tool_use event, so
// buildSkillsInjection must record the pushed set itself — otherwise the
// forensic Skills tab + the commit trailer report zero for every P3 story.

describe('buildSkillsInjection — records pushed skills', () => {
  let dir;
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildInjection.mockReturnValue('BASE');
    mockBuildSkillsPushPrompt.mockResolvedValue('PUSH');
    mockSelectPushedSkillNames.mockResolvedValue({ pushed: [], ranked: false });
    mockClaudeCodeAppendArgs.mockImplementation((text) =>
      text && text.trim() ? ['--append-system-prompt', text] : [],
    );
    dir = withManifest(makeDir());
  });
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('records the pushed skills to loaded-skills.json with manifest sources', async () => {
    mockSelectPushedSkillNames.mockResolvedValue({
      pushed: ['frontend-design', 'best-practices'],
      ranked: true,
    });

    await buildSkillsInjection({ workingDir: dir, storyText: 'build a form' });

    const loaded = JSON.parse(readFileSync(join(dir, '.context', 'loaded-skills.json'), 'utf-8'));
    const byKey = new Set(loaded.map((e) => `${e.skill}@${e.source}`));
    expect(byKey.has('frontend-design@anthropic-official')).toBe(true);
    expect(byKey.has('best-practices@vercel-web')).toBe(true);
  });

  it('records nothing when no skill is pushed (name-list fallback)', async () => {
    mockSelectPushedSkillNames.mockResolvedValue({ pushed: [], ranked: false });

    await buildSkillsInjection({ workingDir: dir, storyText: 'trivial change' });

    expect(existsSync(join(dir, '.context', 'loaded-skills.json'))).toBe(false);
  });

  it('a selectPushedSkillNames failure never blocks injection', async () => {
    mockSelectPushedSkillNames.mockRejectedValue(new Error('embed down'));

    const args = await buildSkillsInjection({ workingDir: dir, storyText: 'x' });
    expect(args).toEqual(['--append-system-prompt', 'BASE\n\n---\n\nPUSH']);
  });
});

// ── readStoryLoadedSkills (persistence accessor) ──────────────────────────────

describe('readStoryLoadedSkills', () => {
  let dir;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns the persisted {skill,source} refs', () => {
    dir = withLoadedSkills(makeDir(), [
      { skill: 'lazy-dev', source: 'org' },
      { skill: 'ui', source: 'anthropic-official' },
    ]);
    expect(readStoryLoadedSkills(dir)).toEqual([
      { skill: 'lazy-dev', source: 'org' },
      { skill: 'ui', source: 'anthropic-official' },
    ]);
  });

  it('returns [] when no loaded-skills file exists', () => {
    dir = makeDir();
    expect(readStoryLoadedSkills(dir)).toEqual([]);
  });
});
