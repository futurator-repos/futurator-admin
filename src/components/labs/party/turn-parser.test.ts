import { describe, it, expect } from 'vitest';
import { parseTurn, resolveRosterName, mergeAssistantTokens } from './turn-parser';

describe('resolveRosterName', () => {
  it('resolves canonical names case-insensitively', () => {
    expect(resolveRosterName('John')).toBe('John');
    expect(resolveRosterName('john')).toBe('John');
    expect(resolveRosterName('SUE RENDER')).toBe('Sue Render');
    expect(resolveRosterName('  bmad master  ')).toBe('BMad Master');
  });

  it('rejects non-roster names (the old false-positive bug)', () => {
    expect(resolveRosterName('My hot take')).toBeNull();
    expect(resolveRosterName('Orchestrator Note')).toBeNull();
    expect(resolveRosterName('The Core Problem')).toBeNull();
  });

  it('tolerates trailing punctuation', () => {
    expect(resolveRosterName('John.')).toBe('John');
    expect(resolveRosterName('Mary,')).toBe('Mary');
  });
});

describe('parseTurn — marker-based (new contract)', () => {
  it('splits on ⟪AGENT:Name⟫ markers', () => {
    const text = [
      '⟪SYSTEM⟫',
      'Welcome back. Bringing in John and Sally.',
      '',
      '⟪AGENT:John⟫',
      'Why do you want it more competitive?',
      '',
      '- Combo multiplier ships fast',
      '- Persistence next',
      '',
      '⟪AGENT:Sally⟫',
      'Two players, same score, different play styles.',
    ].join('\n');

    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'system', speaker: null });
    expect(blocks[0].text).toMatch(/Welcome back/);
    expect(blocks[1]).toMatchObject({ kind: 'agent', speaker: 'John' });
    expect(blocks[1].text).toMatch(/Combo multiplier/);
    expect(blocks[2]).toMatchObject({ kind: 'agent', speaker: 'Sally' });
  });

  it('handles intro before the first marker', () => {
    const text = [
      'Now let me check the project structure.',
      '',
      '⟪AGENT:John⟫',
      'Body here.',
    ].join('\n');
    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'intro', speaker: null });
    expect(blocks[0].text).toMatch(/check the project/);
  });

  it('treats unknown agent name as agent block (best-effort, not dropped)', () => {
    const text = ['⟪AGENT:UnknownPerson⟫', 'Body.'].join('\n');
    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('agent');
    expect(blocks[0].speaker).toBe('UnknownPerson');
  });

  it('handles markers glued to end of previous text (real Claude bug)', () => {
    // Reproduction of session 1772b2b2 (2026-04-26 BMAD analysis): Claude
    // emitted `...systems-level analysis.⟪AGENT:Winston⟫` with no newline
    // before the marker. The old line-anchored parser missed it and ate
    // Winston's content into the system block.
    const text = [
      '⟪SYSTEM⟫',
      'Bringing in Winston (Architect), Ludwig, and Amelia to analyze.⟪AGENT:Winston⟫',
      '',
      'Winston body content here. The architecture is solid.',
      '',
      '⟪AGENT:Ludwig⟫',
      'Ludwig body content here.',
    ].join('\n');
    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'system', speaker: null });
    expect(blocks[0].text).toMatch(/Bringing in Winston/);
    expect(blocks[0].text).not.toMatch(/Winston body content/);
    expect(blocks[1]).toMatchObject({ kind: 'agent', speaker: 'Winston' });
    expect(blocks[1].text).toMatch(/Winston body content/);
    expect(blocks[2]).toMatchObject({ kind: 'agent', speaker: 'Ludwig' });
    expect(blocks[2].text).toMatch(/Ludwig body content/);
  });

  it('handles markers glued mid-sentence (multiple consecutive)', () => {
    const text = 'Intro text.⟪AGENT:John⟫John says hi.⟪AGENT:Sally⟫Sally says hi.⟪SYSTEM⟫Wrap up.';
    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: 'intro' });
    expect(blocks[0].text).toBe('Intro text.');
    expect(blocks[1]).toMatchObject({ kind: 'agent', speaker: 'John', text: 'John says hi.' });
    expect(blocks[2]).toMatchObject({ kind: 'agent', speaker: 'Sally', text: 'Sally says hi.' });
    expect(blocks[3]).toMatchObject({ kind: 'system', text: 'Wrap up.' });
  });

  it('strips a roster table from the intro', () => {
    const text = [
      "Welcome to Party Mode! Here's the roster:",
      '',
      '| Icon | Name | Role |',
      '|------|------|------|',
      '| 📊 | Mary | Business Analyst |',
      '| 📋 | John | Product Manager |',
      '',
      'Bringing in John for this turn.',
      '',
      '⟪AGENT:John⟫',
      'My take.',
    ].join('\n');
    const blocks = parseTurn(text);
    expect(blocks[0].kind).toBe('intro');
    expect(blocks[0].text).not.toMatch(/\|/); // table gone
    expect(blocks[0].text).toMatch(/Welcome to Party Mode/);
    expect(blocks[0].text).toMatch(/Bringing in John/);
  });
});

describe('parseTurn — legacy fallback (no markers)', () => {
  it('splits on emoji **Name:** headers, validating against roster', () => {
    const text = [
      "Now let me check the codebase. Welcome to Party Mode! Bringing in John and Sally.",
      '',
      '---',
      '',
      '📋 **John:**',
      '',
      'Why do you want it more competitive?',
      '',
      '---',
      '',
      '🎨 **Sally:**',
      '',
      'Let me paint a picture.',
    ].join('\n');
    const blocks = parseTurn(text);
    const agentBlocks = blocks.filter((b) => b.kind === 'agent');
    expect(agentBlocks).toHaveLength(2);
    expect(agentBlocks[0].speaker).toBe('John');
    expect(agentBlocks[1].speaker).toBe('Sally');
    expect(agentBlocks[0].text).toMatch(/Why do you want/);
    expect(agentBlocks[1].text).toMatch(/Let me paint/);
  });

  it('does NOT mistreat **My hot take:** as an agent (the old bug)', () => {
    const text = [
      '⚡ **Sue Render:**',
      '',
      'My take on motion.',
      '',
      '**My hot take:**',
      '',
      "Don't just add bricks, add systems.",
    ].join('\n');
    const blocks = parseTurn(text);
    const speakers = blocks.filter((b) => b.kind === 'agent').map((b) => b.speaker);
    expect(speakers).toEqual(['Sue Render']);
    // The "My hot take" line should be inside Sue's body.
    const sue = blocks.find((b) => b.speaker === 'Sue Render');
    expect(sue?.text).toMatch(/My hot take/);
    expect(sue?.text).toMatch(/Don't just add bricks/);
  });

  it('promotes **Orchestrator Note:** to a system block', () => {
    const text = [
      '📋 **John:**',
      '',
      'My PM take.',
      '',
      '**Orchestrator Note:** Strong consensus on combo multiplier.',
    ].join('\n');
    const blocks = parseTurn(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'agent', speaker: 'John' });
    expect(blocks[1]).toMatchObject({ kind: 'system', speaker: null });
    expect(blocks[1].text).toMatch(/Strong consensus/);
  });

  it('handles glued boundary (intro running into first agent header)', () => {
    // Real failure mode: `...for this first round.Here are your four perspectives:\n\n---\n\n📋 **John:**`
    // The current/old parser fails because the leading emoji defeats `^**`.
    // The new legacy parser handles this because it scans line-by-line and
    // accepts emoji-prefixed `**Name:**` rows.
    const text = [
      'Some intro text. Here are your four perspectives:',
      '',
      '---',
      '',
      '📋 **John:**',
      '',
      'My take.',
    ].join('\n');
    const blocks = parseTurn(text);
    const agents = blocks.filter((b) => b.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0].speaker).toBe('John');
  });

  it('does not split inside a code block containing **foo:** patterns', () => {
    // ``` fences aren't preserved across the line-based split today, but
    // **anything that isn't a roster name** is rejected even at line start,
    // so code-block content with `**fakeAgent:**` won't false-positive.
    const text = [
      '📋 **John:**',
      '',
      '```ts',
      'const data = `**Mock:** value`;',
      '```',
      '',
      'And here is more body text.',
    ].join('\n');
    const blocks = parseTurn(text);
    const agents = blocks.filter((b) => b.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0].speaker).toBe('John');
  });
});

describe('mergeAssistantTokens', () => {
  it('concatenates only assistant.token text events', () => {
    const events = [
      { eventType: 'party.turn.user', text: 'ignored' },
      { eventType: 'party.turn.assistant.token', text: 'Hello ' },
      { eventType: 'party.turn.assistant.token', text: 'world.' },
      { eventType: 'party.turn.completed' },
      // tool-use events have no `text` field — must be skipped
      { eventType: 'party.turn.assistant.token' },
    ];
    expect(mergeAssistantTokens(events)).toBe('Hello world.');
  });
});
