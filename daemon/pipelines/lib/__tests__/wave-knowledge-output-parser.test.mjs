import { describe, it, expect } from 'vitest';
import {
  parseWaveKnowledgeOutput,
  buildWaveCompilePrompt,
} from '../wave-knowledge-output-parser.mjs';

describe('parseWaveKnowledgeOutput', () => {
  it('parses a clean two-file output', () => {
    const block = `---WAVE_KNOWLEDGE_OUTPUT---
---FILE: knowledge/code/main.js.md---
# main.js
Game loop + canvas bootstrap.
---END_FILE---

---FILE: knowledge/code/dino.js.md---
# dino.js
Dino physics + sprite rendering.
---END_FILE---
---END_WAVE_KNOWLEDGE_OUTPUT---`;

    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].filePath).toBe('knowledge/code/main.js.md');
    expect(entries[0].content).toContain('Game loop');
    expect(entries[1].filePath).toBe('knowledge/code/dino.js.md');
    expect(entries[1].content).toContain('Dino physics');
  });

  it('tolerates the input passed without the outer envelope', () => {
    const block = `---FILE: knowledge/code/foo.js.md---
body
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it('parses an updated index alongside articles', () => {
    const block = `---WAVE_KNOWLEDGE_OUTPUT---
---FILE: knowledge/code/dino.js.md---
# dino.js article body
---END_FILE---
---FILE: knowledge/index.md---
# Knowledge Index

## Code articles
- code/dino.js.md — Dino physics + sprite rendering.
---END_FILE---
---END_WAVE_KNOWLEDGE_OUTPUT---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.filePath).sort()).toEqual([
      'knowledge/code/dino.js.md',
      'knowledge/index.md',
    ]);
  });

  it('rejects absolute paths', () => {
    const block = `---FILE: /etc/passwd---
not allowed
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(entries).toEqual([]);
    expect(errors[0].error).toMatch(/absolute paths/);
  });

  it('rejects `..` segments', () => {
    const block = `---FILE: knowledge/../escape.md---
no
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(entries).toEqual([]);
    expect(errors[0].error).toMatch(/`\.\.` segments/);
  });

  it('rejects paths outside knowledge/', () => {
    const block = `---FILE: src/main.js---
no
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(entries).toEqual([]);
    expect(errors[0].error).toMatch(/must start with "knowledge\/"/);
  });

  it('rejects empty content', () => {
    const block = `---FILE: knowledge/code/foo.js.md---
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(entries).toEqual([]);
    expect(errors[0].error).toBe('empty content');
  });

  it('flags missing closing END_FILE marker as a parse error', () => {
    const block = `---FILE: knowledge/code/foo.js.md---
body
(no end marker)
---FILE: knowledge/code/bar.js.md---
body
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    // First sub-block is unterminated; parser stops walking after it.
    expect(errors.some((e) => e.error.includes('END_FILE'))).toBe(true);
  });

  it('mixes good and bad sub-blocks: writes valid ones, surfaces errors', () => {
    const block = `---FILE: knowledge/code/good.js.md---
good body
---END_FILE---

---FILE: src/escape.js---
bad path
---END_FILE---

---FILE: knowledge/code/another-good.js.md---
another body
---END_FILE---`;
    const { entries, errors } = parseWaveKnowledgeOutput(block);
    expect(entries.map((e) => e.filePath)).toEqual([
      'knowledge/code/good.js.md',
      'knowledge/code/another-good.js.md',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toBe('src/escape.js');
  });

  it('returns "no FILE sub-blocks found" when input has no markers', () => {
    const { entries, errors } = parseWaveKnowledgeOutput('I forgot to emit anything structured');
    expect(entries).toEqual([]);
    expect(errors[0].error).toMatch(/no FILE sub-blocks/);
  });

  it('returns "empty input" for empty / non-string input', () => {
    expect(parseWaveKnowledgeOutput('').errors[0].error).toBe('empty input');
    expect(parseWaveKnowledgeOutput(null).errors[0].error).toBe('empty input');
    expect(parseWaveKnowledgeOutput(undefined).errors[0].error).toBe('empty input');
  });
});

describe('buildWaveCompilePrompt', () => {
  const sampleStories = [
    {
      storyId: 'S-1',
      title: 'Add ground line',
      description: 'Render a horizontal ground line at y = H - 40.',
      touchPoints: ['src/main.js'],
      workSummary:
        '---WORK_SUMMARY---\nAdded drawGround() to src/main.js.\n---END_WORK_SUMMARY---',
    },
    {
      storyId: 'S-2',
      title: 'Spawn cacti',
      description: 'Cactus spawning + scrolling.',
      touchPoints: ['src/obstacle.js'],
      workSummary: 'Created src/obstacle.js with Cactus class.',
    },
  ];

  it('embeds the project_context placeholder at a fixed prefix position', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: sampleStories });
    expect(prompt.startsWith('<project_context>\n{{PROJECT_CONTEXT}}\n</project_context>\n')).toBe(true);
  });

  it('includes every story title + WORK_SUMMARY in <wave_input>', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: sampleStories });
    expect(prompt).toContain('### S-1 — Add ground line');
    expect(prompt).toContain('Added drawGround()');
    expect(prompt).toContain('### S-2 — Spawn cacti');
    expect(prompt).toContain('Cactus class');
  });

  it('strips ---WORK_SUMMARY--- envelope markers from the embedded body', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: [sampleStories[0]] });
    // The marker should not appear (the envelope is stripped).
    expect(prompt).not.toContain('---WORK_SUMMARY---');
    expect(prompt).not.toContain('---END_WORK_SUMMARY---');
    // But the body content is preserved.
    expect(prompt).toContain('Added drawGround()');
  });

  it('embeds a {{WAVE_DIFF}} placeholder + start/end SHA hints', () => {
    const prompt = buildWaveCompilePrompt({
      wave: 2,
      stories: sampleStories,
      waveStartSha: 'abc1234',
      waveEndSha: 'def5678',
    });
    expect(prompt).toContain('git diff abc1234 def5678');
    expect(prompt).toContain('{{WAVE_DIFF}}');
  });

  it('contains the OUTPUT CONTRACT envelope spec', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: sampleStories });
    expect(prompt).toContain('---WAVE_KNOWLEDGE_OUTPUT---');
    expect(prompt).toContain('---FILE: knowledge/code/<slug>.md---');
    expect(prompt).toContain('---END_FILE---');
    expect(prompt).toContain('---END_WAVE_KNOWLEDGE_OUTPUT---');
  });

  it('contains the DISCOVERY rules (no re-Read, no Glob/find/ls)', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: sampleStories });
    expect(prompt).toMatch(/Do NOT re-Read/);
    expect(prompt).toMatch(/Do NOT Read every existing/);
    expect(prompt).toMatch(/Do NOT Glob, find, or Bash ls/);
  });

  it('handles an empty stories array without throwing', () => {
    const prompt = buildWaveCompilePrompt({ wave: 0, stories: [] });
    expect(prompt).toContain('Stories in this wave (0)');
  });
});
