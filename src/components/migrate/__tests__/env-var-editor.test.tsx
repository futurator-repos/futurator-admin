import { describe, it, expect } from 'vitest';
import { parseEnvText } from '../env-var-editor';

describe('parseEnvText — happy paths', () => {
  it('returns empty result on empty input', () => {
    const r = parseEnvText('');
    expect(r.vars).toEqual({});
    expect(r.errors).toEqual([]);
    expect(r.count).toBe(0);
  });

  it('parses a single KEY=value line', () => {
    const r = parseEnvText('FOO=bar');
    expect(r.vars).toEqual({ FOO: 'bar' });
    expect(r.errors).toEqual([]);
    expect(r.count).toBe(1);
  });

  it('strips surrounding double quotes', () => {
    const r = parseEnvText('FOO="bar baz"');
    expect(r.vars.FOO).toBe('bar baz');
  });

  it('handles values with `=` inside them', () => {
    const r = parseEnvText('FOO=base64=abc=');
    expect(r.vars.FOO).toBe('base64=abc=');
  });

  it('unescapes escaped quotes in quoted values', () => {
    const r = parseEnvText('FOO="he said \\"hi\\""');
    expect(r.vars.FOO).toBe('he said "hi"');
  });

  it('skips blank lines and # comments', () => {
    const r = parseEnvText('# top comment\n\nFOO=bar\n# another\nBAZ=qux\n');
    expect(r.vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(r.errors).toEqual([]);
  });

  it('parses multiple keys', () => {
    const r = parseEnvText('OPENAI_API_KEY=sk-1\nLINKEDIN_API_KEY="li-2"\n');
    expect(r.count).toBe(2);
    expect(r.vars.OPENAI_API_KEY).toBe('sk-1');
    expect(r.vars.LINKEDIN_API_KEY).toBe('li-2');
  });
});

describe('parseEnvText — errors', () => {
  it('reports missing equals', () => {
    const r = parseEnvText('FOO\nBAR=ok');
    expect(r.errors).toEqual([{ line: 1, message: 'missing "="' }]);
    expect(r.vars).toEqual({ BAR: 'ok' });
  });

  it('reports invalid key (lowercase)', () => {
    const r = parseEnvText('foo=bar');
    expect(r.errors[0]).toMatchObject({ line: 1 });
    expect(r.errors[0].message).toMatch(/UPPER_SNAKE_CASE/);
    expect(r.vars).toEqual({});
  });

  it('reports invalid key (starts with digit)', () => {
    const r = parseEnvText('1FOO=bar');
    expect(r.errors[0].message).toMatch(/UPPER_SNAKE_CASE/);
  });

  it('reports invalid key (contains hyphen)', () => {
    const r = parseEnvText('FOO-BAR=baz');
    expect(r.errors[0].message).toMatch(/UPPER_SNAKE_CASE/);
  });

  it('reports duplicate keys', () => {
    const r = parseEnvText('FOO=1\nFOO=2');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2 });
    expect(r.errors[0].message).toMatch(/duplicate/);
    // Last value wins.
    expect(r.vars.FOO).toBe('2');
  });

  it('reports the correct line number despite leading blanks/comments', () => {
    const r = parseEnvText('\n\n# header\n\nfoo=bar');
    expect(r.errors[0].line).toBe(5);
  });
});

describe('parseEnvText — edge cases', () => {
  it('trims surrounding whitespace on key and value', () => {
    const r = parseEnvText('  FOO  =  bar  ');
    expect(r.vars.FOO).toBe('bar');
  });

  it('allows empty values', () => {
    const r = parseEnvText('FOO=');
    expect(r.vars.FOO).toBe('');
    expect(r.errors).toEqual([]);
  });

  it('preserves only ONE level of quote-stripping', () => {
    const r = parseEnvText('FOO="""bar"""');
    // First+last quotes stripped → ""bar"".
    expect(r.vars.FOO).toBe('""bar""');
  });
});
