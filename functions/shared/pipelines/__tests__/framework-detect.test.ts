import { describe, it, expect } from 'vitest';
import { buildFrameworkDetectSnippet } from '../framework-detect';

/**
 * PR-59 — runtime framework detection.
 *
 * The snippet runs in bash and exports four shell variables. Tests assert
 * on the bash text shape (snapshot-style) — actually executing bash here
 * would require a fixture per framework, which is out of scope. The
 * structural assertions catch the regression class that bit spyhunter-1
 * (--hostname for Vite, port 3000 for Vite, etc.).
 */

describe('PR-59 — framework-detect snippet', () => {
  const cwd = '/home/ubuntu/projects/foo';

  it('emits the four required shell variables', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain('QA_FRAMEWORK=');
    expect(s).toContain('QA_PORT=');
    expect(s).toContain('QA_DEV_CMD=');
    expect(s).toContain('QA_HEALTH_PATH=');
  });

  it('cd to the working directory before reading package.json', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain(`cd ${cwd}`);
    expect(s).toMatch(/-f package\.json/);
  });

  it('detects Next.js → port 3000 + --hostname flag', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toMatch(/grep -q '"next"' package\.json/);
    expect(s).toMatch(/QA_FRAMEWORK=next.*QA_PORT=3000/s);
    // Critical: Next.js wants --hostname, not --host. spyhunter-1 hit the
    // mirror-image bug (--hostname against Vite); guard both directions.
    expect(s).toMatch(/QA_FRAMEWORK=next[\s\S]*?--hostname 0\.0\.0\.0/);
  });

  it('detects Vite → port 5173 + --host flag', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toMatch(/grep -q '"vite"' package\.json/);
    expect(s).toMatch(/QA_FRAMEWORK=vite.*QA_PORT=5173/s);
    // Vite uses --host (no "name"). spyhunter-1 forensic 2026-05-08.
    expect(s).toMatch(/QA_FRAMEWORK=vite[\s\S]*?--host 0\.0\.0\.0/);
    // Make sure we don't accidentally pass --hostname to Vite.
    const viteBlock = s.match(/QA_FRAMEWORK=vite[\s\S]*?fi/)?.[0] ?? '';
    expect(viteBlock).not.toContain('--hostname');
  });

  it('detects Expo → port 19006 + npx expo start --web', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toMatch(/grep -q '"expo"' package\.json/);
    expect(s).toContain('QA_PORT=19006');
    expect(s).toContain('npx expo start --web');
  });

  it('detects Remix, SvelteKit, Nuxt', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain('"@remix-run/dev"');
    expect(s).toContain('"@sveltejs/kit"');
    expect(s).toContain('"nuxt"');
  });

  it('orders Next.js detection before Vite (Next.js apps may transitively pull vite)', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    const nextIdx = s.indexOf('QA_FRAMEWORK=next');
    const viteIdx = s.indexOf('QA_FRAMEWORK=vite');
    expect(nextIdx).toBeGreaterThan(0);
    expect(viteIdx).toBeGreaterThan(0);
    expect(nextIdx).toBeLessThan(viteIdx);
  });

  it('falls back to Vite-flavoured defaults for unknown frameworks', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain('QA_FRAMEWORK=unknown');
    expect(s).toMatch(/QA_FRAMEWORK=unknown[\s\S]*?QA_PORT=5173/);
  });

  it('applies operator-forced port override after framework detection', () => {
    const s = buildFrameworkDetectSnippet({ cwd, forcePort: 4242 });
    expect(s).toContain('QA_PORT=4242');
    // The override must come AFTER the detection branches so it wins.
    const branchIdx = s.indexOf('"vite"');
    const overrideIdx = s.indexOf('QA_PORT=4242');
    expect(overrideIdx).toBeGreaterThan(branchIdx);
  });

  it('emits a single readable echo line for operator logs', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain('[framework-detect]');
    expect(s).toContain('framework=$QA_FRAMEWORK');
    expect(s).toContain('port=$QA_PORT');
  });

  it('errors loud when package.json is missing (no silent unknown-framework rescue)', () => {
    const s = buildFrameworkDetectSnippet({ cwd });
    expect(s).toContain('FRAMEWORK_DETECT_ERROR: package.json not found');
    expect(s).toContain('exit 1');
  });
});

/**
 * 2026-06-17 — base-path detection. A dev-deploy bakes Next `basePath` / Vite
 * `base` into the config the QA branch checks out; QA must navigate THERE, not
 * root (root renders the framework 404 — brick1 "everything failed"). These
 * tests EXECUTE the snippet against fixture configs to validate the bash regex.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runDetect(files: Record<string, string>): { basePath: string; healthPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fw-detect-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
    const snippet = buildFrameworkDetectSnippet({ cwd: dir });
    const out = execSync(
      `bash -c '${snippet.replace(/'/g, `'\\''`)}\necho "RESULT:$QA_BASE_PATH|$QA_HEALTH_PATH"'`,
      {
        encoding: 'utf8',
      },
    );
    const line = out.split('\n').find((l) => l.startsWith('RESULT:')) || 'RESULT:|';
    const [basePath, healthPath] = line.slice('RESULT:'.length).split('|');
    return { basePath, healthPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('framework-detect — base-path detection (the brick1 404 fix)', () => {
  it('extracts Next basePath and routes the health path through it', () => {
    const r = runDetect({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
      'next.config.ts': `const c = { basePath: '/apps/_dev/brick1', output: 'export' };\nexport default c;`,
    });
    expect(r.basePath).toBe('/apps/_dev/brick1');
    expect(r.healthPath).toBe('/apps/_dev/brick1/');
  });

  it('extracts Vite base when no Next config', () => {
    const r = runDetect({
      'package.json': JSON.stringify({ devDependencies: { vite: '5.0.0' } }),
      'vite.config.ts': `export default { base: "/apps/_dev/game/" };`,
    });
    expect(r.basePath).toBe('/apps/_dev/game'); // trailing slash normalized off
    expect(r.healthPath).toBe('/apps/_dev/game/');
  });

  it('no base path → empty QA_BASE_PATH, health stays at root', () => {
    const r = runDetect({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
      'next.config.ts': `export default { output: 'export' };`,
    });
    expect(r.basePath).toBe('');
    expect(r.healthPath).toBe('/');
  });
});
