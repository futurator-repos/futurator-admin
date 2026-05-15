/**
 * reflector-runner.test.mjs — Pipeline v2 Phase 3 / Story 3-E-2-1 + 3-E-2-2.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseInboxFrontmatter,
  renderInboxAfterReflection,
  renderNewGitLog,
  buildPipelineArgs,
  shouldFireReflection,
  buildForensicEvent,
} from '../reflector-runner.mjs';

describe('parseInboxFrontmatter', () => {
  it('returns null cursor on empty / null input', () => {
    expect(parseInboxFrontmatter(null)).toEqual({
      lastSeenSha: null,
      lastReflectionAt: null,
      body: '',
    });
    expect(parseInboxFrontmatter('')).toEqual({
      lastSeenSha: null,
      lastReflectionAt: null,
      body: '',
    });
  });

  it('parses frontmatter when present', () => {
    const raw = `---\nlast-seen-sha: a3f9c2e\nlast-reflection-at: 2026-04-26T14:00:00Z\n---\nbody content\n`;
    const result = parseInboxFrontmatter(raw);
    expect(result.lastSeenSha).toBe('a3f9c2e');
    expect(result.lastReflectionAt).toBe('2026-04-26T14:00:00Z');
    expect(result.body).toContain('body content');
  });

  it('handles null-valued fields (from PR-77 provisioning seed)', () => {
    const raw = `---\nlast-seen-sha: null\nlast-update-at: null\n---\n`;
    const result = parseInboxFrontmatter(raw);
    expect(result.lastSeenSha).toBeNull();
    expect(result.lastReflectionAt).toBeNull();
  });

  it('falls back to null cursor on malformed frontmatter', () => {
    const raw = 'no frontmatter here\nat all\n';
    const result = parseInboxFrontmatter(raw);
    expect(result.lastSeenSha).toBeNull();
    expect(result.body).toBe(raw);
  });

  it('falls back to null cursor on broken yaml inside frontmatter', () => {
    const raw = `---\nbroken: [\n  bad: yaml\n---\nbody\n`;
    const result = parseInboxFrontmatter(raw);
    expect(result.lastSeenSha).toBeNull();
  });
});

describe('renderInboxAfterReflection', () => {
  it('produces a head + previous body + new block', () => {
    const out = renderInboxAfterReflection({
      lastSeenSha: 'def5678',
      lastReflectionAt: '2026-05-15T20:30:00Z',
      previousBody: '\n(previous notes)',
      newReflectionBlock: '---REFLECTION---\n{...}\n---END_REFLECTION---',
    });
    expect(out).toMatch(/^---\nlast-seen-sha: def5678\nlast-reflection-at: 2026-05-15T20:30:00Z\n---\n/);
    expect(out).toContain('(previous notes)');
    expect(out).toContain('---REFLECTION---');
    expect(out).toContain('---END_REFLECTION---');
  });

  it('handles empty previous body cleanly', () => {
    const out = renderInboxAfterReflection({
      lastSeenSha: 'abc',
      lastReflectionAt: 'now',
      previousBody: '',
      newReflectionBlock: '---REFLECTION---\n{}\n---END_REFLECTION---',
    });
    expect(out).toContain('---REFLECTION---');
    // No extra blank lines between head and new block when previous is empty
    expect(out.split('\n---REFLECTION---')[0]).toMatch(/^---\nlast-seen-sha/);
  });

  it('ensures trailing newline on the block', () => {
    const out = renderInboxAfterReflection({
      lastSeenSha: 'a',
      lastReflectionAt: 't',
      previousBody: 'x',
      newReflectionBlock: '---REFLECTION---\n{}\n---END_REFLECTION---',
    });
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('renderNewGitLog', () => {
  it('runs git log lastSeenSha..HEAD when cursor present', () => {
    const calls = [];
    const gitFn = vi.fn((cwd, args) => {
      calls.push({ cwd, args });
      return 'abc1234 first\ndef5678 second';
    });
    const out = renderNewGitLog({ repoPath: '/repo', lastSeenSha: 'cursor', gitFn });
    expect(out).toBe('abc1234 first\ndef5678 second');
    expect(calls[0].args).toContain('cursor..HEAD');
  });

  it('runs git log HEAD when no cursor', () => {
    const gitFn = vi.fn().mockReturnValue('xyz1234 latest');
    const out = renderNewGitLog({ repoPath: '/repo', lastSeenSha: null, gitFn });
    expect(out).toBe('xyz1234 latest');
    expect(gitFn).toHaveBeenCalledWith('/repo', expect.arrayContaining(['HEAD']));
  });

  it('falls back to HEAD when cursor SHA does not exist', () => {
    let firstCall = true;
    const gitFn = vi.fn(() => {
      if (firstCall) {
        firstCall = false;
        throw new Error('fatal: bad revision');
      }
      return 'recovery 12345 fallback';
    });
    const out = renderNewGitLog({ repoPath: '/repo', lastSeenSha: 'gone', gitFn });
    expect(out).toContain('fallback');
    expect(gitFn).toHaveBeenCalledTimes(2);
  });

  it('returns empty on total failure', () => {
    const gitFn = vi.fn(() => {
      throw new Error('not a git repo');
    });
    const out = renderNewGitLog({ repoPath: '/nope', lastSeenSha: null, gitFn });
    expect(out).toBe('');
  });

  it('applies the limit flag', () => {
    const gitFn = vi.fn().mockReturnValue('');
    renderNewGitLog({ repoPath: '/r', lastSeenSha: null, limit: 25, gitFn });
    expect(gitFn).toHaveBeenCalledWith('/r', expect.arrayContaining(['-n', '25']));
  });
});

describe('buildPipelineArgs', () => {
  it('returns the shape the TS pipeline definition expects', () => {
    const args = buildPipelineArgs({
      scope: 'plan',
      planId: 'p1',
      projectSlug: 'dino',
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      inboxRaw: `---\nlast-seen-sha: abc\nlast-reflection-at: 2026-01-01T00:00:00Z\n---\nbody\n`,
      newGitLog: 'def5678 new',
      projectClaudeMd: '# Project',
    });
    expect(args.scope).toBe('plan');
    expect(args.planId).toBe('p1');
    expect(args.lastSeenSha).toBe('abc');
    expect(args.lastReflectionAt).toBe('2026-01-01T00:00:00Z');
    expect(args.newGitLog).toBe('def5678 new');
    expect(args.projectClaudeMd).toBe('# Project');
    expect(args.existingInbox).toContain('body');
  });

  it('handles missing inbox + missing claude-md gracefully', () => {
    const args = buildPipelineArgs({
      scope: 'wave',
      planId: 'p1',
      projectSlug: 'dino',
      boilerplateKind: 'nextjs-base',
      rigor: 'prototype',
      inboxRaw: null,
      newGitLog: '',
      projectClaudeMd: null,
    });
    expect(args.lastSeenSha).toBeNull();
    expect(args.existingInbox).toBe('');
    expect(args.projectClaudeMd).toBe('');
  });
});

describe('shouldFireReflection', () => {
  it('story scope: production only', () => {
    expect(shouldFireReflection({ rigor: 'production', scope: 'story' }).shouldFire).toBe(true);
    expect(shouldFireReflection({ rigor: 'mvp', scope: 'story' }).shouldFire).toBe(false);
    expect(shouldFireReflection({ rigor: 'prototype', scope: 'story' }).shouldFire).toBe(false);
  });

  it('wave scope: fires under all rigors', () => {
    for (const rigor of ['prototype', 'mvp', 'production']) {
      expect(shouldFireReflection({ rigor, scope: 'wave' }).shouldFire).toBe(true);
    }
  });

  it('plan scope: fires under all rigors', () => {
    for (const rigor of ['prototype', 'mvp', 'production']) {
      expect(shouldFireReflection({ rigor, scope: 'plan' }).shouldFire).toBe(true);
    }
  });

  it('brownfield-cycle: fires under all rigors', () => {
    expect(
      shouldFireReflection({ rigor: 'prototype', scope: 'brownfield-cycle' }).shouldFire,
    ).toBe(true);
  });
});

describe('buildForensicEvent', () => {
  it('emits step.reflector.<scope> with proposal count', () => {
    const ev = buildForensicEvent({
      scope: 'plan',
      output: { planId: 'p1', proposals: [{}, {}] },
      durationMs: 5000,
    });
    expect(ev.eventType).toBe('step.reflector.plan');
    expect(ev.payload.proposalCount).toBe(2);
    expect(ev.payload.planId).toBe('p1');
  });

  it('handles error path with no output', () => {
    const ev = buildForensicEvent({
      scope: 'wave',
      output: null,
      error: 'agent crashed',
    });
    expect(ev.payload.proposalCount).toBe(0);
    expect(ev.payload.error).toBe('agent crashed');
  });
});
