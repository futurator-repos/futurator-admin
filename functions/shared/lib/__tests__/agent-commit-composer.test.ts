import { describe, it, expect } from 'vitest';

import {
  composeAgentCommit,
  validateTitle,
  validateSummary,
  sanitize,
  buildPipelineStructuredTrailers,
} from '../agent-commit-composer';

/**
 * Story 20.13 — TypeScript composer parity tests.
 *
 * Mirror the daemon-side .mjs suite's coverage. The two implementations
 * MUST emit byte-identical output for the same input (the daemon's
 * party-checkpoint script and the Lambda's commit-metadata shell snippet
 * both rely on this).
 */

describe('sanitize', () => {
  it('strips C0 controls + DEL + zero-width, preserves \\n and \\t', () => {
    expect(sanitize('hello\x00world')).toBe('helloworld');
    expect(sanitize('a\x7fb')).toBe('ab');
    expect(sanitize('hello​world')).toBe('helloworld');
    expect(sanitize('line one\nline two')).toBe('line one\nline two');
    expect(sanitize('a\tb')).toBe('a\tb');
  });
});

describe('validateTitle', () => {
  it('flags empty / noise / too-short', () => {
    expect(validateTitle('').warnings).toContain('title-empty');
    expect(validateTitle('WIP').warnings).toContain('title-noise');
    expect(validateTitle('two words').warnings).toContain('title-too-short');
    expect(validateTitle('wire chord overlay').warnings).toEqual([]);
  });
});

describe('validateSummary', () => {
  it('splits lines + strips trailing whitespace', () => {
    expect(validateSummary('first   \nsecond  ').lines).toEqual(['first', 'second']);
  });
});

describe('composeAgentCommit — pipeline shape', () => {
  const input = {
    kind: 'pipeline' as const,
    title: 'wire chord overlay',
    summary: 'Adds the overlay + tests.',
    storyId: 'STORY-123',
    planId: 'plan-abc',
    plan: 'music',
    epicId: 'epic-7',
    wave: 2,
    agent: 'DEV',
  };
  it('emits canonical subject + all v2.5 §23 trailers + footer', () => {
    const { message } = composeAgentCommit(input);
    expect(message.split('\n')[0]).toBe('story: STORY-123 — wire chord overlay');
    expect(message).toMatch(/^Agent: DEV$/m);
    expect(message).toMatch(/^Plan-Id: plan-abc$/m);
    expect(message).toMatch(/^Plan: music$/m);
    expect(message).toMatch(/^Epic-Id: epic-7$/m);
    expect(message).toMatch(/^Wave: 2$/m);
    expect(message).toMatch(/^Story: STORY-123$/m);
    expect(message).toMatch(/🤖 Generated with Claude Code via the Futurator pipeline$/);
  });
});

describe('composeAgentCommit — party shape', () => {
  it('emits canonical subject + party trailers + BMad Master coauthor', () => {
    const { message, coAuthors } = composeAgentCommit({
      kind: 'party',
      title: 'routing agreed',
      summary: 'PM + Architect aligned.',
      sessionId: 'a1b2c3d4-1111-2222-3333-444455556666',
      projectId: 'applicator',
      round: 3,
      trigger: 'operator-checkpoint',
      participants: ['John (PM)'],
    });
    expect(message.split('\n')[0]).toBe('party(applicator/round-3): routing agreed');
    expect(message).toMatch(/^Agent: PARTY-ORCHESTRATOR$/m);
    expect(message).toMatch(/^Session-Id: a1b2c3d4-1111-2222-3333-444455556666$/m);
    expect(coAuthors[0]).toContain('<party+bmad-master@futurator.ai>');
    expect(coAuthors[1]).toMatch(/John \(PM\).*party\+john-pm@/);
  });
});

describe('buildPipelineStructuredTrailers', () => {
  it('emits trailers in v2.5 §23 canonical order (Agent, Plan-Id, Plan, Epic-Id, Wave, Story)', () => {
    const out = buildPipelineStructuredTrailers({
      storyId: 'STORY-1',
      agent: 'DEV',
      planId: 'plan-a',
      plan: 'a-slug',
      epicId: 'epic-1',
      wave: 2,
    });
    expect(out).toBe(
      [
        'Agent: DEV',
        'Plan-Id: plan-a',
        'Plan: a-slug',
        'Epic-Id: epic-1',
        'Wave: 2',
        'Story: STORY-1',
      ].join('\n'),
    );
  });

  it('omits Plan-Id / Plan / Epic-Id / Wave when undefined; Story always present', () => {
    const out = buildPipelineStructuredTrailers({ storyId: 'STORY-only' });
    expect(out).toBe('Agent: DEV\nStory: STORY-only');
  });

  it('collapses newlines in trailer values to spaces (single-line per v2.5 §23 spec)', () => {
    const out = buildPipelineStructuredTrailers({
      storyId: 'X',
      plan: 'bad\nslug',
    });
    expect(out).toContain('Plan: bad slug');
    expect(out).not.toContain('Plan: bad\nslug');
  });

  it('sanitizes control + zero-width chars in trailer values', () => {
    const out = buildPipelineStructuredTrailers({
      storyId: 'X',
      planId: 'plan\x00​abc',
    });
    expect(out).toContain('Plan-Id: planabc');
  });
});

describe('snapshot — Story 20.13 byte-parity', () => {
  it('produces stable canonical pipeline message for known input', () => {
    const { message } = composeAgentCommit({
      kind: 'pipeline',
      title: 'add OAuth login flow',
      summary: 'Wires Identity Broker OTP + bearer JWT exchange + login form.',
      storyId: 'AUTH-12',
      planId: 'plan-7e1a',
      plan: 'auth-rollout',
      epicId: 'epic-3',
      wave: 1,
    });
    expect(message).toMatchInlineSnapshot(`
      "story: AUTH-12 — add OAuth login flow

      Wires Identity Broker OTP + bearer JWT exchange + login form.

      Agent: DEV
      Plan-Id: plan-7e1a
      Plan: auth-rollout
      Epic-Id: epic-3
      Wave: 1
      Story: AUTH-12

      🤖 Generated with Claude Code via the Futurator pipeline"
    `);
  });
});
