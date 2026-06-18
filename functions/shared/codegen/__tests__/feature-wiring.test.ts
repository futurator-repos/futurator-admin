/**
 * Tests for feature-wiring.ts (Story D — agentic-integration).
 *
 * Covers the pure generator + a no-drift guarantee: the SHIPPED generator
 * script (the string augmented into every app) is executed against a temp
 * dir and its output is asserted byte-equal to `generatePageSource`, so the
 * two implementations can never silently diverge.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  generatePageSource,
  sortFeatures,
  FEATURE_WIRING_GENERATOR_MJS,
  GITATTRIBUTES_GENERATED,
  type FeatureDescriptor,
} from '../feature-wiring';

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const desc = (slug: string, order: number): FeatureDescriptor => ({
  slug,
  order,
  importPath: `../features/${slug}.feature`,
  componentName: `${slug[0].toUpperCase()}${slug.slice(1)}Feature`,
});

describe('sortFeatures', () => {
  it('orders by `order` then slug, deterministically', () => {
    const out = sortFeatures([desc('zebra', 10), desc('alpha', 10), desc('first', 1)]);
    expect(out.map((f) => f.slug)).toEqual(['first', 'alpha', 'zebra']);
  });
});

describe('generatePageSource', () => {
  it('renders an empty-state page when no features are registered', () => {
    const src = generatePageSource([]);
    expect(src).toContain('@generated');
    expect(src).toContain('No features registered yet');
    expect(src).toContain('export default function Page()');
  });

  it('imports and mounts every feature in deterministic order', () => {
    const src = generatePageSource([desc('ghost', 20), desc('pacman', 10)]);
    // pacman (order 10) before ghost (order 20)
    expect(src.indexOf('PacmanFeature')).toBeLessThan(src.indexOf('GhostFeature'));
    expect(src).toContain("import PacmanFeature from '../features/pacman.feature';");
    expect(src).toContain('<PacmanFeature />');
    expect(src).toContain('<GhostFeature />');
  });

  // v2.6 wave-gate VQA — the page is the verification surface: anchored
  // sections + ?feature=<slug> isolation (pacman2: scroll-0 screenshot
  // captured a sibling's stacked preview; the judge graded the wrong pixels).
  it('wraps each feature in an anchored, data-tagged section', () => {
    const src = generatePageSource([desc('ghost', 20), desc('pacman', 10)]);
    expect(src).toContain('<section id="feature-pacman" data-feature="pacman">');
    expect(src).toContain('<section id="feature-ghost" data-feature="ghost">');
  });

  it('honors ?feature=<slug> via a client-side filter that stays static-export safe', () => {
    const src = generatePageSource([desc('pacman', 10)]);
    // Client read under Suspense — a server-component `searchParams` read
    // would force the route dynamic and break `output: 'export'` builds.
    expect(src).toContain("'use client';");
    expect(src).toContain("const only = useSearchParams().get('feature');");
    expect(src).toContain("{(!only || only === 'pacman') && (");
    expect(src).toContain('<Suspense fallback={null}>');
    expect(src).toContain("<main data-feature-filter={only ?? 'all'}>");
  });

  it('is a pure function of the feature set (byte-stable across calls)', () => {
    const a = generatePageSource([desc('a', 1), desc('b', 2)]);
    const b = generatePageSource([desc('b', 2), desc('a', 1)]); // different input order
    expect(a).toBe(b);
  });
});

describe('FEATURE_WIRING_GENERATOR_MJS (shipped script) — no drift', () => {
  function runShippedGenerator(features: Array<{ file: string; body: string }>): string {
    const dir = mkdtempSync(join(tmpdir(), 'fw-'));
    tmps.push(dir);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'src', 'features'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'generate-wiring.mjs'), FEATURE_WIRING_GENERATOR_MJS);
    for (const f of features) writeFileSync(join(dir, 'src', 'features', f.file), f.body);

    const r = spawnSync('node', ['scripts/generate-wiring.mjs'], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(join(dir, 'src', 'app', 'page.tsx'), 'utf8');
  }

  it('produces byte-identical output to generatePageSource (2 features)', () => {
    const out = runShippedGenerator([
      {
        file: 'pacman.feature.tsx',
        body: 'export const feature = { slug: "pacman", order: 10 };\nexport default function P(){return null;}',
      },
      {
        file: 'ghost.feature.tsx',
        body: 'export const feature = { slug: "ghost", order: 20 };\nexport default function G(){return null;}',
      },
    ]);
    const expected = generatePageSource([desc('pacman', 10), desc('ghost', 20)]);
    expect(out).toBe(expected);
  });

  it('writes the empty-state page when src/features has no feature files', () => {
    const out = runShippedGenerator([]);
    expect(out).toBe(generatePageSource([]));
  });

  it('defaults missing `order` to 100', () => {
    const out = runShippedGenerator([
      {
        file: 'solo.feature.tsx',
        body: 'export const feature = { slug: "solo" };\nexport default function S(){return null;}',
      },
    ]);
    expect(out).toBe(generatePageSource([desc('solo', 100)]));
  });

  it('parses `primary: true` and matches generatePageSource (primary surface)', () => {
    const out = runShippedGenerator([
      {
        file: 'pacman.feature.tsx',
        body: 'export const feature = { slug: "pacman", order: 0, primary: true };\nexport default function P(){return null;}',
      },
      {
        file: 'pacman-chars.feature.tsx',
        body: 'export const feature = { slug: "pacman-chars", order: 10 };\nexport default function C(){return null;}',
      },
    ]);
    // Build expected with the SAME PascalCase the shipped generator uses for
    // multi-word slugs (pacman-chars → PacmanCharsFeature); the naive `desc`
    // helper only upper-cases the first char, so spell it out here.
    const expected = generatePageSource([
      {
        slug: 'pacman',
        order: 0,
        primary: true,
        importPath: '../features/pacman.feature',
        componentName: 'PacmanFeature',
      },
      {
        slug: 'pacman-chars',
        order: 10,
        importPath: '../features/pacman-chars.feature',
        componentName: 'PacmanCharsFeature',
      },
    ]);
    expect(out).toBe(expected);
    // Sanity: previews are isolated, primary is at bare /.
    expect(out).toContain("{(!only || only === 'pacman') && (");
    expect(out).toContain("{(only === 'pacman-chars') && (");
  });
});

// pacman2 (2026-06-18) — final QA shot the bare `/` PREVIEW GALLERY (all
// features stacked) instead of the assembled game, so every test saw the same
// character-sheet frame. A `primary` feature makes `/` the real app.
describe('generatePageSource — primary feature surface (pacman2 fix)', () => {
  const primaryDesc = (slug: string, order: number): FeatureDescriptor => ({
    ...desc(slug, order),
    primary: true,
  });

  it('renders only the primary feature at bare / and isolates previews under ?feature=', () => {
    const src = generatePageSource([
      primaryDesc('pacman', 0),
      desc('pacman-chars', 10),
      desc('pacman-hud', 20),
    ]);
    // primary keeps the bare-/ branch
    expect(src).toContain("{(!only || only === 'pacman') && (");
    // previews reachable ONLY via ?feature=<slug> (no bare-/ branch)
    expect(src).toContain("{(only === 'pacman-chars') && (");
    expect(src).toContain("{(only === 'pacman-hud') && (");
    expect(src).not.toContain("{(!only || only === 'pacman-chars') && (");
    expect(src).not.toContain("{(!only || only === 'pacman-hud') && (");
  });

  it('falls back to stacking all features at / when none is primary', () => {
    const src = generatePageSource([desc('pacman-chars', 10), desc('pacman-hud', 20)]);
    expect(src).toContain("{(!only || only === 'pacman-chars') && (");
    expect(src).toContain("{(!only || only === 'pacman-hud') && (");
  });
});

describe('GITATTRIBUTES_GENERATED — Story E Tier 0 (merge=union)', () => {
  it('marks the generated wiring file as generated', () => {
    expect(GITATTRIBUTES_GENERATED).toContain('src/app/page.tsx linguist-generated=true');
  });

  it('declares merge=union for CLAUDE.md (the dino1 #1 conflict file)', () => {
    expect(GITATTRIBUTES_GENERATED).toMatch(/^CLAUDE\.md merge=union$/m);
  });

  it('applies union only to append-only prose logs, never structured/JSON', () => {
    // Guardrail: union is line-based and would corrupt structured files.
    expect(GITATTRIBUTES_GENERATED).not.toMatch(/package\.json\s+merge=union/);
    expect(GITATTRIBUTES_GENERATED).not.toMatch(/\.json\s+merge=union/);
    // The append-log doc paths are covered.
    expect(GITATTRIBUTES_GENERATED).toMatch(/docs\/decisions\/\*\.md merge=union/);
  });
});
