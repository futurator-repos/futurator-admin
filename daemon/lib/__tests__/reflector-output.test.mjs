/**
 * R1 (pacman1 audit, 2026-06-12) — the real REFLECTOR brain.
 * Pins the prompt contract (generic, evidence-driven, propose-only) and the
 * tolerant output parser that turns agent text into ReflectionRow bodies.
 */

import { describe, expect, it } from 'vitest';
import {
  buildReflectorAgentPrompt,
  parseReflectorOutput,
} from '../../pipelines/reflector-runner.mjs';

describe('buildReflectorAgentPrompt', () => {
  const prompt = buildReflectorAgentPrompt({
    scope: 'plan',
    projectSlug: 'someapp',
    planSummary: 'Plan someapp-initial · rigor mvp · 11/11 stories done',
    evidenceBlocks: [
      { title: 'Quality-gate failures and agent repairs', body: '- gate stage "test" FAILED' },
      { title: 'Operator attention items raised during the run', body: '- [wave-build-failed/high] Wave build failed' },
    ],
  });

  it('embeds the evidence blocks and plan summary', () => {
    expect(prompt).toContain('11/11 stories done');
    expect(prompt).toContain('## Quality-gate failures and agent repairs');
    expect(prompt).toContain('gate stage "test" FAILED');
  });

  it('is propose-only and read-only by contract', () => {
    expect(prompt).toMatch(/must NOT modify/i);
    expect(prompt).toMatch(/only PROPOSE/i);
  });

  it('demands the exact fenced output block + allows an empty list', () => {
    expect(prompt).toContain('---REFLECTIONS---');
    expect(prompt).toContain('---END_REFLECTIONS---');
    expect(prompt).toMatch(/may be empty/i);
    expect(prompt).toMatch(/AT MOST 5/);
  });

  it('contains no domain-specific examples (generic across projects)', () => {
    // The prompt must describe CATEGORIES, never concrete app content.
    expect(prompt).not.toMatch(/pacman|pong|dino|game|maze/i);
  });
});

describe('parseReflectorOutput', () => {
  const valid = {
    target: 'project-claude-md',
    action: 'append-line',
    content: 'Always regenerate generated wiring before booting the dev server.',
    rationale: 'Two stories failed their smoke until the wiring was regenerated.',
    evidence: ['gate stage "build"', 'AC-X-1'],
    confidence: 0.8,
  };

  it('parses the fenced block', () => {
    const out = parseReflectorOutput(
      `Some reasoning...\n---REFLECTIONS---\n${JSON.stringify([valid])}\n---END_REFLECTIONS---`,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: 'project-claude-md', action: 'append-line' });
    expect(out[0].confidence).toBe(0.8);
  });

  it('falls back to the first JSON array when the fence is missing', () => {
    const out = parseReflectorOutput(`Here you go:\n\`\`\`json\n${JSON.stringify([valid])}\n\`\`\``);
    expect(out).toHaveLength(1);
  });

  it('drops invalid entries (bad target/action, missing content/rationale)', () => {
    const out = parseReflectorOutput(
      `---REFLECTIONS---\n${JSON.stringify([
        valid,
        { ...valid, target: 'rm-rf-everything' },
        { ...valid, action: 'apply-now' },
        { ...valid, content: '' },
        { ...valid, rationale: undefined },
      ])}\n---END_REFLECTIONS---`,
    );
    expect(out).toHaveLength(1);
  });

  it('clamps confidence into [0,1] and defaults to 0.5 when absent', () => {
    const out = parseReflectorOutput(
      `---REFLECTIONS---\n${JSON.stringify([
        { ...valid, confidence: 7 },
        { ...valid, confidence: undefined },
      ])}\n---END_REFLECTIONS---`,
    );
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0.5);
  });

  it('caps at 5 proposals', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...valid, content: `rule ${i}` }));
    expect(
      parseReflectorOutput(`---REFLECTIONS---\n${JSON.stringify(many)}\n---END_REFLECTIONS---`),
    ).toHaveLength(5);
  });

  it('returns [] on garbage, empty output, and honest empty lists', () => {
    expect(parseReflectorOutput('')).toEqual([]);
    expect(parseReflectorOutput('no json here')).toEqual([]);
    expect(parseReflectorOutput('---REFLECTIONS---\nnot json\n---END_REFLECTIONS---')).toEqual([]);
    expect(parseReflectorOutput('---REFLECTIONS---\n[]\n---END_REFLECTIONS---')).toEqual([]);
  });
});
