import { describe, it, expect } from 'vitest';

import {
  composeAgentCommit,
  validateTitle,
  validateSummary,
  sanitize,
} from '../agent-commit-composer.mjs';

/**
 * Story 19.5 AC 7 — required tests for the agent-commit-composer module.
 */

describe('sanitize — §12.1.3 control + zero-width strip', () => {
  it('strips C0 control chars (null byte fixture)', () => {
    expect(sanitize('hello\x00world')).toBe('helloworld');
  });

  it('strips DEL (0x7f)', () => {
    expect(sanitize('a\x7fb')).toBe('ab');
  });

  it('strips zero-width chars (U+200B fixture — "hello​world")', () => {
    expect(sanitize('hello​world')).toBe('helloworld');
  });

  it('strips zero-width joiner / non-joiner / LTR-RTL marks / BOM', () => {
    expect(sanitize('a‌b‍c‎d‏e﻿f')).toBe('abcdef');
  });

  it('trims trailing whitespace', () => {
    expect(sanitize('hello   \t\n')).toBe('hello');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitize(null)).toBe('');
    expect(sanitize(undefined)).toBe('');
  });
});

describe('validateTitle — noise / empty / short detection', () => {
  it('flags empty titles', () => {
    expect(validateTitle('').warnings).toContain('title-empty');
    expect(validateTitle('   ').warnings).toContain('title-empty');
    expect(validateTitle('\x00\x00').warnings).toContain('title-empty');
  });

  it('flags noise titles (Update / Fix / WIP / untitled)', () => {
    expect(validateTitle('Update').warnings).toContain('title-noise');
    expect(validateTitle('fix').warnings).toContain('title-noise');
    expect(validateTitle('WIP').warnings).toContain('title-noise');
    expect(validateTitle('untitled').warnings).toContain('title-noise');
    expect(validateTitle('Change').warnings).toContain('title-noise');
  });

  it('flags titles with fewer than 3 words as title-too-short', () => {
    expect(validateTitle('one').warnings).toContain('title-too-short');
    expect(validateTitle('two words').warnings).toContain('title-too-short');
  });

  it('passes a normal three-word title with no warnings', () => {
    const r = validateTitle('wire chord overlay');
    expect(r.warnings).toEqual([]);
    expect(r.clean).toBe('wire chord overlay');
  });
});

describe('validateSummary', () => {
  it('returns empty for empty input', () => {
    expect(validateSummary('').clean).toBe('');
    expect(validateSummary(undefined).clean).toBe('');
  });

  it('strips control chars per line and preserves paragraph structure', () => {
    const r = validateSummary('line one\x00\nline two​');
    expect(r.lines).toEqual(['line one', 'line two']);
  });
});

describe('composeAgentCommit — pipeline shape (AC 4)', () => {
  const input = {
    kind: 'pipeline',
    title: 'wire chord overlay',
    summary: 'Adds the overlay component and unit tests covering keypress + label rendering.',
    storyId: 'STORY-123',
    planId: 'plan-abc-def',
    plan: 'music-overlay',
    epicId: 'epic-7',
    wave: 2,
    agent: 'DEV',
    skillsUsed: 'music-theory-engine@futurator-internal',
    skillsManifestSha: 'a3f9c2e1' + '0'.repeat(56),
  };

  it('produces the canonical subject', () => {
    const { message } = composeAgentCommit(input);
    expect(message.split('\n')[0]).toBe('story: STORY-123 — wire chord overlay');
  });

  it('emits all v2.5 §23 trailer keys', () => {
    const { message } = composeAgentCommit(input);
    expect(message).toMatch(/^Agent: DEV$/m);
    expect(message).toMatch(/^Plan-Id: plan-abc-def$/m);
    expect(message).toMatch(/^Plan: music-overlay$/m);
    expect(message).toMatch(/^Epic-Id: epic-7$/m);
    expect(message).toMatch(/^Wave: 2$/m);
    expect(message).toMatch(/^Story: STORY-123$/m);
    expect(message).toMatch(/^Skills-Used: music-theory-engine@futurator-internal$/m);
    expect(message).toMatch(/^Skills-Manifest-Sha: a3f9c2e1/m);
  });

  it('emits the pipeline footer', () => {
    const { message } = composeAgentCommit(input);
    expect(message).toMatch(/🤖 Generated with Claude Code via the Futurator pipeline$/);
  });

  it('returns no coAuthors and no warnings for a valid pipeline input', () => {
    const r = composeAgentCommit(input);
    expect(r.coAuthors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('omits Skills-Used / Skills-Manifest-Sha when not provided', () => {
    const { skillsUsed, skillsManifestSha, ...minimal } = input;
    void skillsUsed;
    void skillsManifestSha;
    const { message } = composeAgentCommit(minimal);
    expect(message).not.toMatch(/^Skills-Used:/m);
    expect(message).not.toMatch(/^Skills-Manifest-Sha:/m);
  });
});

describe('composeAgentCommit — party shape (AC 5)', () => {
  const input = {
    kind: 'party',
    title: 'agreed on routing strategy',
    summary: 'BMad Master + PM agreed on hash-based routing as the MVP.',
    sessionId: 'a1b2c3d4-1111-2222-3333-444455556666',
    projectId: 'applicator',
    round: 3,
    trigger: 'operator-checkpoint',
    debate: 'routing-strategy',
    participants: ['John (PM)', 'Sara (Architect)'],
  };

  it('produces the canonical party subject', () => {
    const { message } = composeAgentCommit(input);
    expect(message.split('\n')[0]).toBe(
      'party(applicator/round-3): agreed on routing strategy',
    );
  });

  it('emits Agent / Session-Id / Project / Round / Trigger trailers', () => {
    const { message } = composeAgentCommit(input);
    expect(message).toMatch(/^Agent: PARTY-ORCHESTRATOR$/m);
    expect(message).toMatch(/^Session-Id: a1b2c3d4-1111-2222-3333-444455556666$/m);
    expect(message).toMatch(/^Project: applicator$/m);
    expect(message).toMatch(/^Round: 3$/m);
    expect(message).toMatch(/^Trigger: operator-checkpoint$/m);
    expect(message).toMatch(/^Debate: routing-strategy$/m);
    expect(message).toMatch(/^Participants: John \(PM\), Sara \(Architect\)$/m);
  });

  it('generates co-authors with BMad Master first, then participants in order', () => {
    const { coAuthors, message } = composeAgentCommit(input);
    expect(coAuthors[0]).toBe(
      'Co-authored-by: BMad Master (Party) <party+bmad-master@futurator.ai>',
    );
    expect(coAuthors[1]).toMatch(/Co-authored-by: John \(PM\).*<party\+john-pm@futurator\.ai>/);
    expect(coAuthors[2]).toMatch(
      /Co-authored-by: Sara \(Architect\).*<party\+sara-architect@futurator\.ai>/,
    );
    expect(message).toContain(coAuthors[0]);
    expect(message).toContain(coAuthors[1]);
  });

  it('emits the party footer', () => {
    const { message } = composeAgentCommit(input);
    expect(message).toMatch(/🤖 Generated by Futurator Party Mode$/);
  });

  it('emits no participant co-authors when participants is empty (BMad Master still present)', () => {
    const { coAuthors, message } = composeAgentCommit({ ...input, participants: [] });
    expect(coAuthors).toEqual([
      'Co-authored-by: BMad Master (Party) <party+bmad-master@futurator.ai>',
    ]);
    expect(message).not.toMatch(/^Participants:/m);
  });

  it('warns on co-author email collision (duplicate slug)', () => {
    // Two participants slugify to the same key — "John" twice.
    const { coAuthors, warnings } = composeAgentCommit({
      ...input,
      participants: ['John', 'John'],
    });
    // First "John" emits; second is dropped + warning fires.
    const johnLines = coAuthors.filter((l) => l.includes('<party+john@futurator.ai>'));
    expect(johnLines).toHaveLength(1);
    expect(warnings.some((w) => w.startsWith('coauthor-collision:'))).toBe(true);
  });
});

describe('composeAgentCommit — input validation', () => {
  it('throws on missing input', () => {
    expect(() => composeAgentCommit(null)).toThrow(/input/);
  });

  it('throws on unknown kind', () => {
    expect(() => composeAgentCommit({ kind: 'unknown', title: 'x' })).toThrow(
      /unknown kind/,
    );
  });
});
