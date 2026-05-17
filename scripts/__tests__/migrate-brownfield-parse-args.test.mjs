import { describe, it, expect } from 'vitest';
import { parseRunnerArgs, DEFAULTS, HELP_TEXT } from '../lib/migrate-brownfield/parse-args.mjs';

describe('parseRunnerArgs — defaults', () => {
  it('returns null path + null patFile when neither flag nor env is provided', () => {
    const out = parseRunnerArgs([], {});
    expect(out.path).toBeNull();
    expect(out.patFile).toBeNull();
    expect(out.token).toBeNull();
  });

  it('uses default apiBaseUrl and default secretName', () => {
    const out = parseRunnerArgs([], {});
    expect(out.apiBaseUrl).toBe(DEFAULTS.apiBaseUrl);
    expect(out.secretName).toBe(DEFAULTS.secretName);
  });

  it('booleans default to false', () => {
    const out = parseRunnerArgs([], {});
    expect(out.refresh).toBe(false);
    expect(out.rotatePat).toBe(false);
    expect(out.skipIamCheck).toBe(false);
    expect(out.help).toBe(false);
  });
});

describe('parseRunnerArgs — flag-driven', () => {
  it('parses --path, --pat-file, --name, --branch', () => {
    const out = parseRunnerArgs(
      [
        '--path',
        '/home/u/code/applicator',
        '--pat-file',
        '/home/u/.brownfield-pat',
        '--name',
        'applicator',
        '--branch',
        'develop',
      ],
      {},
    );
    expect(out.path).toBe('/home/u/code/applicator');
    expect(out.patFile).toBe('/home/u/.brownfield-pat');
    expect(out.name).toBe('applicator');
    expect(out.branch).toBe('develop');
  });

  it('parses --api override', () => {
    const out = parseRunnerArgs(['--api', 'http://localhost:3000/api'], {});
    expect(out.apiBaseUrl).toBe('http://localhost:3000/api');
  });

  it('parses --token', () => {
    const out = parseRunnerArgs(['--token', 'jwt.abc.def'], {});
    expect(out.token).toBe('jwt.abc.def');
  });

  it('parses boolean flags --refresh, --rotate-pat, --skip-iam-check', () => {
    const out = parseRunnerArgs(['--refresh', '--rotate-pat', '--skip-iam-check'], {});
    expect(out.refresh).toBe(true);
    expect(out.rotatePat).toBe(true);
    expect(out.skipIamCheck).toBe(true);
  });

  it('parses --secret-name override', () => {
    const out = parseRunnerArgs(['--secret-name', 'my-team/brownfield-pat'], {});
    expect(out.secretName).toBe('my-team/brownfield-pat');
  });

  it('parses -h short flag', () => {
    const out = parseRunnerArgs(['-h'], {});
    expect(out.help).toBe(true);
  });

  it('parses --help long flag', () => {
    const out = parseRunnerArgs(['--help'], {});
    expect(out.help).toBe(true);
  });
});

describe('parseRunnerArgs — env-driven fallbacks', () => {
  it('falls back to BROWNFIELD_REPO_PATH for --path', () => {
    const out = parseRunnerArgs([], { BROWNFIELD_REPO_PATH: '/env/path' });
    expect(out.path).toBe('/env/path');
  });

  it('falls back to FUTURATOR_ADMIN_API_URL for --api', () => {
    const out = parseRunnerArgs([], { FUTURATOR_ADMIN_API_URL: 'http://x/api' });
    expect(out.apiBaseUrl).toBe('http://x/api');
  });

  it('falls back to FUTURATOR_ADMIN_TOKEN for --token', () => {
    const out = parseRunnerArgs([], { FUTURATOR_ADMIN_TOKEN: 'jwt.env.tok' });
    expect(out.token).toBe('jwt.env.tok');
  });

  it('flag overrides env when both are set', () => {
    const out = parseRunnerArgs(['--path', '/flag/path', '--token', 'flag-tok'], {
      BROWNFIELD_REPO_PATH: '/env/path',
      FUTURATOR_ADMIN_TOKEN: 'env-tok',
    });
    expect(out.path).toBe('/flag/path');
    expect(out.token).toBe('flag-tok');
  });
});

describe('parseRunnerArgs — safety', () => {
  it('does NOT accept a raw --pat flag (would leak via shell history)', () => {
    // parseArgs throws on unknown flags by default. We assert that
    // attempting to pass --pat doesn't smuggle the value somewhere.
    expect(() => parseRunnerArgs(['--pat', 'github_pat_secret'], {})).toThrow();
  });
});

describe('HELP_TEXT', () => {
  it('mentions all required and optional flags', () => {
    expect(HELP_TEXT).toContain('--path');
    expect(HELP_TEXT).toContain('--pat-file');
    expect(HELP_TEXT).toContain('--refresh');
    expect(HELP_TEXT).toContain('BROWNFIELD_REPO_PATH');
    expect(HELP_TEXT).toContain('FUTURATOR_ADMIN_TOKEN');
  });

  it('includes at least one example invocation', () => {
    expect(HELP_TEXT).toContain('EXAMPLES');
    expect(HELP_TEXT).toContain('scripts/migrate-brownfield.mjs');
  });
});
