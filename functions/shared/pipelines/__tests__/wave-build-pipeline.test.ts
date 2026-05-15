import { describe, it, expect } from 'vitest';
import { generateWaveBuildPipeline } from '../wave-build-pipeline';

/**
 * PR-68 (2026-05-15) — bundle-source-check.
 *
 * After `npm run build` succeeds, scan production sourcemaps' `.sources[]`
 * for every required touch point. Missing → fail the wave loud. Catches
 * "file exists in src/ but is orphaned (no import reachable from entry)".
 * spyhunter-1 forensic 2026-05-13: src/components/GameScene.ts and
 * src/app/page.ts existed but src/main.ts (Vite entry) never imported
 * them; the production bundle had only main.ts's stub draw().
 *
 * Framework-agnostic: works on Vite, Rollup, Webpack, esbuild, Turbopack,
 * SvelteKit — they all emit sourcemaps with a `.sources` array.
 */
const workingDir = '/home/ubuntu/projects/foo';

describe('PR-68 — bundle-source-check', () => {
  it('is omitted from the pipeline when requiredSources is empty', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], []);
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('bundle-source-check');
  });

  it('is omitted when requiredSources is undefined (back-compat for legacy callers)', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1']);
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).not.toContain('bundle-source-check');
  });

  it('is inserted between build-check and server-check when requiredSources is provided', () => {
    const pipeline = generateWaveBuildPipeline(
      workingDir,
      0,
      ['s1'],
      ['src/components/GameScene.ts'],
    );
    const ids = pipeline.steps.map((s) => s.id);
    const buildIdx = ids.indexOf('build-check');
    const bundleIdx = ids.indexOf('bundle-source-check');
    const serverIdx = ids.indexOf('server-check');
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(bundleIdx).toBeGreaterThan(buildIdx);
    expect(serverIdx).toBeGreaterThan(bundleIdx);
  });

  it('command detects every common bundler output directory', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    expect(step?.stepType).toBe('shell');
    const cmd = String((step as { command: string }).command);
    // Framework-agnostic detection — order matters (Next.js before plain
    // `out/`, SvelteKit/Remix before Vite's `dist/`).
    expect(cmd).toContain('out/_next/static/chunks');
    expect(cmd).toContain('.next/static/chunks');
    expect(cmd).toContain('.svelte-kit/output/client/_app');
    expect(cmd).toContain('build/client/_app');
    expect(cmd).toContain('dist');
    expect(cmd).toContain('out');
    expect(cmd).toContain('build');
  });

  it('skips cleanly when no recognised output dir exists (no false-positive failure)', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain('BUNDLE_CHECK_SKIPPED: no recognised build output dir');
  });

  it('skips cleanly when build was emitted without sourcemaps', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain('BUNDLE_CHECK_SKIPPED: no .js.map files found');
  });

  it('inlines the required-sources list as JSON into the node script', () => {
    const sources = ['src/main.ts', 'src/components/Form.tsx', 'src/hooks/useChart.ts'];
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], sources);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain(JSON.stringify(sources));
  });

  it('matches by suffix so sourcemap-relative paths like "../../src/foo.ts" still resolve', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toMatch(/endsWith\(.*norm\)/);
  });

  it('fails loud with BUNDLE_ORPHAN_FILES + actionable diagnosis when any source is missing', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    const cmd = String((step as { command: string }).command);
    expect(cmd).toContain('BUNDLE_ORPHAN_FILES');
    expect(cmd).toContain('not reachable from the build entry');
    expect(cmd).toContain('process.exit(1)');
    expect(cmd).toContain('Likely cause');
  });

  it('onFail wired so the daemon treats orphans as step failures', () => {
    const pipeline = generateWaveBuildPipeline(workingDir, 0, ['s1'], ['src/x.ts']);
    const step = pipeline.steps.find((s) => s.id === 'bundle-source-check');
    expect((step as { onFail?: { action: string } }).onFail?.action).toBe('fail');
  });
});
