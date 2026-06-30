import { describe, it, expect } from 'vitest';
import { extractAssistantText } from '../stream-json-text.mjs';
import { parseBindingManifest, applyBindings } from '../completion-gate.mjs';

describe('extractAssistantText', () => {
  it('decodes assistant text blocks (unescaping stream-json)', () => {
    const text = 'I built the dino module.\n\n<BINDING>\n{ "AC-S2-1": { "testRef": "src/x/dino.test.ts", "testKind": "unit" } }\n</BINDING>';
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const raw = `{"type":"system","subtype":"init"}\n${line}\n{"type":"result","result":"done","is_error":false}`;
    expect(extractAssistantText(raw)).toBe(text);
  });

  it('falls back to text_delta when no assistant blocks', () => {
    const raw = [
      JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hel' } } }),
      JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'lo' } } }),
    ].join('\n');
    expect(extractAssistantText(raw)).toBe('hello');
  });

  it('tolerates non-JSON log lines + empty', () => {
    expect(extractAssistantText('[INFO] some log\nnot json\n')).toBe('');
    expect(extractAssistantText('')).toBe('');
  });
});

describe('the actual bug: escaped <BINDING> in stream-json → bindings now apply', () => {
  it('raw stream-json fails to bind; decoded text binds', () => {
    const manifest = '<BINDING>\n{ "AC-S2-1": { "testRef": "src/game/entities/__tests__/dino.test.ts", "testKind": "unit" }, "AC-S2-2": { "testRef": "src/game/entities/__tests__/dino.test.ts > initiateJump (AC-S2-2)", "testKind": "unit" } }\n</BINDING>';
    const assistantText = `Implemented the dino entity.\n\n${manifest}`;
    const raw = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } });

    // BEFORE: parsing the raw stream-json (escaped) yields nothing.
    expect(parseBindingManifest(raw)).toEqual({});

    // AFTER: decode first, then the manifest parses and binds both ACs.
    const decoded = extractAssistantText(raw);
    const m = parseBindingManifest(decoded);
    expect(m['AC-S2-1'].testRef).toMatch(/dino\.test\.ts/);
    expect(m['AC-S2-2'].testRef).toMatch(/initiateJump/);

    const acs = applyBindings(
      [
        { id: 'AC-S2-1', text: 'dino exists', acClass: 'deterministic', testBinding: { status: 'unbound' } },
        { id: 'AC-S2-2', text: 'jump arc', acClass: 'deterministic', testBinding: { status: 'unbound' } },
      ],
      m,
    );
    expect(acs[0].testBinding.status).toBe('bound');
    expect(acs[1].testBinding.status).toBe('bound');
  });
});
