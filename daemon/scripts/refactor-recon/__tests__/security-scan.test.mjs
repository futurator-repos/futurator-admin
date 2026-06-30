/**
 * security-scan.test.mjs — deterministic security & secrets/env-hygiene detector.
 * Covers the operator's concerns: hardcoded secrets, committed .env, public-prefix
 * leaks, weak fallbacks, dangerous sinks, and env-config hygiene.
 */

import { describe, it, expect } from 'vitest';
import { buildSecurityReport, scanContent, envTemplateKeys } from '../security-scan.mjs';

const f = (rel, content) => ({ rel, content });
const has = (r, check) => r.findings.some((x) => x.evidence?.check === check);
const get = (r, check) => r.findings.filter((x) => x.evidence?.check === check);

describe('scanContent — secrets, leaks, sinks', () => {
  it('flags hardcoded provider keys + private keys + conn strings', () => {
    const out = scanContent('src/cfg.ts', [
      'const a = "AKIA1234567890ABCDEF";',
      'const k = "sk-ant-api03-abcdefghijklmnopqrstuv";',
      'const db = "postgres://admin:s3cr3tpw@db.example.com:5432/app";',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\n'));
    const kinds = out.map((o) => o.evidence.kind);
    expect(kinds).toEqual(expect.arrayContaining(['aws-akid', 'anthropic', 'conn-string', 'private-key']));
    expect(out.every((o) => o.severity === 'High')).toBe(true);
  });

  it('flags generic secret assignment but ignores placeholders / env refs', () => {
    const real = scanContent('src/a.ts', 'const password = "hunter2real";');
    expect(has({ findings: real }, 'hardcoded-secret')).toBe(true);
    const placeholder = scanContent('src/b.ts', 'const password = "your-password-here";\nconst apiKey = process.env.API_KEY;');
    expect(placeholder.length).toBe(0);
  });

  it('flags public-prefixed secrets (browser-exposed) even in env templates', () => {
    const out = scanContent('.env.example', 'NEXT_PUBLIC_STRIPE_SECRET=\nVITE_AUTH_TOKEN=', { isTemplate: true });
    const leaks = get({ findings: out }, 'public-prefix-secret');
    expect(leaks.length).toBe(2);
    expect(leaks.every((x) => x.severity === 'High')).toBe(true);
  });

  it('flags weak hardcoded fallback secrets + dangerous sinks', () => {
    const out = scanContent('src/auth.ts', [
      "const s = process.env.JWT_SECRET || 'dev-secret-fallback';",
      'el.innerHTML = userInput;',
      'eval(payload);',
    ].join('\n'));
    expect(has({ findings: out }, 'weak-fallback-secret')).toBe(true);
    expect(has({ findings: out }, 'inner-html')).toBe(true);
    expect(has({ findings: out }, 'eval')).toBe(true);
  });
});

describe('buildSecurityReport — repo-level env hygiene', () => {
  it('flags a committed .env not covered by .gitignore', () => {
    const r = buildSecurityReport([
      f('.env', 'DATABASE_URL=postgres://u:p@h/db\nANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx'),
      f('.gitignore', 'node_modules\ndist'),
    ]);
    expect(has(r, 'committed-env')).toBe(true);
    expect(has(r, 'gitignore-env')).toBe(true);
    expect(r.summary.env.committedEnvFiles).toBe(1);
    expect(r.summary.env.gitignoreCoversEnv).toBe(false);
  });

  it('does NOT flag gitignore-env when .env* is ignored', () => {
    const r = buildSecurityReport([
      f('.env', 'X=1'),
      f('.gitignore', 'node_modules\n.env*\n!.env.example'),
    ]);
    expect(has(r, 'committed-env')).toBe(true); // still committed (present in tree)
    expect(has(r, 'gitignore-env')).toBe(false); // but at least ignored going forward
    expect(r.summary.env.gitignoreCoversEnv).toBe(true);
  });

  it('flags missing .env.example + undocumented keys', () => {
    const noExample = buildSecurityReport([f('src/a.ts', 'const x = process.env.FOO; const y = process.env.BAR;')]);
    expect(has(noExample, 'no-env-example')).toBe(true);

    const withExample = buildSecurityReport([
      f('.env.example', 'FOO=\n'),
      f('src/a.ts', 'const x = process.env.FOO; const y = process.env.BAR;'),
    ]);
    expect(has(withExample, 'no-env-example')).toBe(false);
    expect(has(withExample, 'undocumented-env')).toBe(true); // BAR used, not documented
  });

  it('flags a committed credential file + missing lockfile', () => {
    const r = buildSecurityReport([
      f('serviceAccount.json', '{"private_key":"-----BEGIN PRIVATE KEY-----"}'),
      f('package.json', '{"name":"x"}'),
    ]);
    expect(has(r, 'committed-secret-file')).toBe(true);
    expect(has(r, 'no-lockfile')).toBe(true);
  });

  it('clean repo → no findings', () => {
    const r = buildSecurityReport([
      f('.env.example', 'API_KEY=\nDATABASE_URL=\n'),
      f('.gitignore', '.env*\n!.env.example\nnode_modules'),
      f('package.json', '{}'),
      f('package-lock.json', '{}'),
      f('src/a.ts', 'const k = process.env.API_KEY; const d = process.env.DATABASE_URL;'),
    ]);
    expect(r.findings).toHaveLength(0);
  });

  it('envTemplateKeys parses key names only', () => {
    expect([...envTemplateKeys('export FOO=bar\nBAZ=\n# c\nQUX="x"')]).toEqual(['FOO', 'BAZ', 'QUX']);
  });
});
