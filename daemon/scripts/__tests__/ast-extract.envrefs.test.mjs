/**
 * ast-extract.envrefs.test.mjs — Story SG-1.6.
 *
 * The process.env.X / Resource.X scan that feeds graph-sync's env-join. Must
 * capture BOTH the dotted (`Resource.GithubPat.value`) and the real-world
 * bracket (`Resource['GithubPat'].value`) forms — and ignore comments.
 */

import { describe, it, expect } from 'vitest';
import { loadTsParser, parseSource } from '../lib/extractor-envelope.mjs';
import { extractFromTree } from '../ast-extract.mjs';

async function scan(src) {
  const { Parser, tsLang } = await loadTsParser('test');
  const parser = new Parser();
  parser.setLanguage(tsLang);
  return extractFromTree(parseSource(parser, src)).envRefs;
}

describe('ast-extract — process.env / Resource scan (SG-1.6)', () => {
  it('captures dotted process.env.X', async () => {
    const refs = await scan(`const t = process.env.COSTS_TABLE || 'x';`);
    expect(refs.env).toContain('COSTS_TABLE');
  });

  it('captures the real bracket form Resource[\'X\'].value (W7)', async () => {
    const refs = await scan(`
      const { Resource } = require('sst');
      export function loadPat() { return Resource['GithubPat'].value; }
    `);
    expect(refs.resource).toContain('GithubPat');
  });

  it('captures dotted Resource.X.value', async () => {
    const refs = await scan(`const v = Resource.AnthropicApiKey.value;`);
    expect(refs.resource).toContain('AnthropicApiKey');
  });

  it('captures process.env[\'X\'] bracket form', async () => {
    const refs = await scan(`const p = process.env['GITHUB_PAT'];`);
    expect(refs.env).toContain('GITHUB_PAT');
  });

  it('ignores references that only appear in comments', async () => {
    const refs = await scan(`
      // reads from Resource.GhostSecret.value at runtime
      const x = 1;
    `);
    expect(refs.resource).not.toContain('GhostSecret');
  });

  it('does not alter existing outputs (functions/imports still extracted)', async () => {
    const { Parser, tsLang } = await loadTsParser('test');
    const parser = new Parser();
    parser.setLanguage(tsLang);
    const facts = extractFromTree(
      parseSource(parser, `import { z } from 'zod';\nexport function foo() { return process.env.A; }`),
    );
    expect(facts.functions.some((f) => f.name === 'foo')).toBe(true);
    expect(facts.imports.some((i) => i.source === 'zod')).toBe(true);
    expect(facts.envRefs.env).toContain('A');
  });
});
