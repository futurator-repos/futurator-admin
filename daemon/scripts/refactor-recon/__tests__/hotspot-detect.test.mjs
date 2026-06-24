/**
 * hotspot-detect.test.mjs — Refactoring Assessment Module (Epic A regression).
 *
 * Locks the validated detector invariants (NFR2) against a synthetic graph
 * fixture so a future change can't silently regress them:
 *   1. a high-fan-in UI primitive (button.tsx ≥100) → design-system "hub present"
 *   2. framework-convention filenames (route.ts ×N) → NO duplicate-subsystem FP (FR7)
 *   3. a class with ≥12 method out-edges → god-object
 *   4. knip-unused files split into safe-candidate (fan-in 0) vs needs-review (A2)
 *   5. the A4 calibration config is honoured (override raises the god-object floor)
 *
 * Runs the real hotspot-detect.mjs as a child process against a temp fixture dir
 * and asserts on the emitted hotspots.json.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DETECT = path.join(HERE, '..', 'hotspot-detect.mjs');

let dir;

/** Build a synthetic graph.resolved.json + resolved-imports.json + knip.json. */
function writeFixture(target, { calibration } = {}) {
  const nodes = [];
  const links = [];
  const hubs = [];

  // --- 1. design-system: a canonical UI hub + a forked UI dir (2 ui dirs) ---
  nodes.push({ id: 'ui/button', label: 'button.tsx', source_file: 'src/components/ui/button.tsx', community: 1, resolved_in_degree: 130 });
  hubs.push({ file: 'src/components/ui/button.tsx', inDegree: 130 });
  nodes.push({ id: 'ui/card', label: 'card.tsx', source_file: 'src/components/ui/card.tsx', community: 1, resolved_in_degree: 40 });
  hubs.push({ file: 'src/components/ui/card.tsx', inDegree: 40 });
  // forked copy in a second ui dir → triggers design-system-consolidation, rolls up the dup
  nodes.push({ id: 'pe/button', label: 'button.tsx', source_file: 'src/components/profile-editor/components/ui/button.tsx', community: 2, resolved_in_degree: 3 });
  hubs.push({ file: 'src/components/profile-editor/components/ui/button.tsx', inDegree: 3 });

  // --- 2. framework convention: route.ts repeated across dirs (must NOT be a dup) ---
  for (const seg of ['a', 'b', 'c']) {
    nodes.push({ id: `route/${seg}`, label: 'route.ts', source_file: `src/app/${seg}/route.ts`, community: 3, resolved_in_degree: 0 });
  }
  // page.tsx too
  for (const seg of ['x', 'y']) {
    nodes.push({ id: `page/${seg}`, label: 'page.tsx', source_file: `src/app/${seg}/page.tsx`, community: 3, resolved_in_degree: 0 });
  }

  // --- 3. god-object: a class node with 14 method out-edges ---
  nodes.push({ id: 'god', label: 'AWSProfileStorage', source_file: 'src/lib/aws-profile-storage.ts', community: 4, resolved_in_degree: 38 });
  hubs.push({ file: 'src/lib/aws-profile-storage.ts', inDegree: 38 });
  for (let i = 0; i < 14; i++) {
    const mid = `god.m${i}`;
    nodes.push({ id: mid, label: `method${i}`, source_file: 'src/lib/aws-profile-storage.ts', community: 4 });
    links.push({ source: 'god', target: mid, relation: 'method' });
  }

  // --- 4. dead-code: one zero-fan-in (safe) + one with importers (needs-review) ---
  nodes.push({ id: 'deadA', label: 'orphan.ts', source_file: 'src/lib/orphan.ts', community: 5, resolved_in_degree: 0 });
  nodes.push({ id: 'deadB', label: 'used-dynamically.ts', source_file: 'src/lib/used-dynamically.ts', community: 5, resolved_in_degree: 5 });
  hubs.push({ file: 'src/lib/used-dynamically.ts', inDegree: 5 });

  // --- 5. co-located convention files (types.ts ×3) — must NOT be a duplicate ---
  for (const dir of ['feature-a', 'feature-b', 'feature-c']) {
    nodes.push({ id: `types/${dir}`, label: 'types.ts', source_file: `src/components/${dir}/types.ts`, community: 6, resolved_in_degree: 8 });
    hubs.push({ file: `src/components/${dir}/types.ts`, inDegree: 8 });
  }

  // --- 6. version-marked dir (onboarding-v2/** = 4 files) → ONE legacy root, not 4 ---
  for (const f of ['steps/a.ts', 'steps/b.ts', 'audio/c.ts', 'index-x.ts']) {
    nodes.push({ id: `v2/${f}`, label: f.split('/').pop(), source_file: `src/components/onboarding-v2/${f}`, community: 7, resolved_in_degree: 1 });
  }

  // --- 7. a version FAMILY (flow-v1 + flow-v2) → v2 is current (dropped), v1 legacy ---
  nodes.push({ id: 'flowv1', label: 'a.ts', source_file: 'src/components/flow-v1/a.ts', community: 8, resolved_in_degree: 1 });
  nodes.push({ id: 'flowv2', label: 'a.ts', source_file: 'src/components/flow-v2/a.ts', community: 8, resolved_in_degree: 1 });
  // cross-dir family: a v3 FILE in a different dir is the same "onboarding" family
  // as the onboarding-v2 dir below → v3 is current (must NOT be flagged legacy).
  nodes.push({ id: 'onbv3type', label: 'onboarding-v3.ts', source_file: 'src/types/onboarding-v3.ts', community: 8, resolved_in_degree: 2 });
  // a test file with a version marker must NOT be flagged as a legacy root
  nodes.push({ id: 'vtest', label: 'x.test.ts', source_file: 'src/components/onboarding-v2/__tests__/x.test.ts', community: 7, resolved_in_degree: 0 });

  // --- 7b. feature-name + migration markers must NOT be flagged legacy (fix#1) ---
  nodes.push({ id: 'enh', label: 'enhanced-section.ts', source_file: 'src/types/enhanced-section.ts', community: 8, resolved_in_degree: 2 });
  nodes.push({ id: 'hier', label: 'hierarchical-gen.ts', source_file: 'src/lib/ai/hierarchical-gen.ts', community: 8, resolved_in_degree: 2 });
  nodes.push({ id: 'mig', label: 'migrate-to-hierarchical.ts', source_file: 'src/lib/migrations/migrate-to-hierarchical.ts', community: 8, resolved_in_degree: 1 });

  // --- 7c. variants/ siblings sharing a basename must NOT be a dup (fix#2) ---
  nodes.push({ id: 'va', label: 'widget.tsx', source_file: 'src/components/sections/experience/variants/widget.tsx', community: 8, resolved_in_degree: 3 });
  nodes.push({ id: 'vb', label: 'widget.tsx', source_file: 'src/components/sections/projects/variants/widget.tsx', community: 8, resolved_in_degree: 3 });
  hubs.push({ file: 'src/components/sections/experience/variants/widget.tsx', inDegree: 3 });
  hubs.push({ file: 'src/components/sections/projects/variants/widget.tsx', inDegree: 3 });

  // --- 7d. a dup with one copy inside a legacy root (flow-v1) → suppressed (fix#3) ---
  nodes.push({ id: 'ofv1', label: 'OnboardingFlow.tsx', source_file: 'src/components/flow-v1/OnboardingFlow.tsx', community: 8, resolved_in_degree: 2 });
  nodes.push({ id: 'ofv2', label: 'OnboardingFlow.tsx', source_file: 'src/components/flow-v2/OnboardingFlow.tsx', community: 8, resolved_in_degree: 2 });
  hubs.push({ file: 'src/components/flow-v1/OnboardingFlow.tsx', inDegree: 2 });
  hubs.push({ file: 'src/components/flow-v2/OnboardingFlow.tsx', inDegree: 2 });

  // --- 8. a Repository god-object → role-aware advice (NOT "split into repositories") ---
  nodes.push({ id: 'repo', label: 'OrgsRepository', source_file: 'src/db/orgs-table.ts', community: 9, resolved_in_degree: 20 });
  hubs.push({ file: 'src/db/orgs-table.ts', inDegree: 20 });
  for (let i = 0; i < 14; i++) {
    const mid = `repo.m${i}`;
    nodes.push({ id: mid, label: `m${i}`, source_file: 'src/db/orgs-table.ts', community: 9 });
    links.push({ source: 'repo', target: mid, relation: 'method' });
  }

  fs.writeFileSync(path.join(target, 'graph.resolved.json'), JSON.stringify({ nodes, links }));
  fs.writeFileSync(
    path.join(target, 'resolved-imports.json'),
    JSON.stringify({ filesScanned: nodes.length, aliasResolved: 0, aliasUnresolved: 0, hubs }),
  );
  fs.writeFileSync(
    path.join(target, 'knip.json'),
    JSON.stringify({ files: ['src/lib/orphan.ts', 'src/lib/used-dynamically.ts'] }),
  );
  if (calibration) fs.writeFileSync(path.join(target, 'calib.json'), JSON.stringify(calibration));
}

function runDetect(target, extraArgs = []) {
  execFileSync('node', [DETECT, target, '--repo', target, ...extraArgs], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(path.join(target, 'hotspots.json'), 'utf8'));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotspot-detect-'));
  writeFixture(dir);
});
afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('hotspot-detect — validated invariants (NFR2 regression lock)', () => {
  it('flags a duplicate design system with the high-fan-in canonical dir', () => {
    const out = runDetect(dir);
    const ds = out.hotspots.find((h) => h.kind === 'design-system-consolidation');
    expect(ds, 'design-system-consolidation hotspot present').toBeTruthy();
    expect(ds.evidence.canonical).toBe('src/components/ui'); // highest-fan-in ui dir wins
    // the forked button.tsx (a UI-dir dup) must roll up under design-system, NOT
    // appear as a standalone duplicate-subsystem (FR7 UI rollup).
    expect(ds.evidence.duplicatedComponents.some((d) => d.name === 'button.tsx')).toBe(true);
    expect(out.hotspots.some((h) => h.kind === 'duplicate-subsystem' && /button\.tsx/.test(h.title))).toBe(false);
  });

  it('does NOT raise a route.ts / page.tsx false positive (FR7 convention exclusion)', () => {
    const out = runDetect(dir);
    const dupTitles = out.hotspots
      .filter((h) => h.kind === 'duplicate-subsystem')
      .map((h) => h.title);
    expect(dupTitles.some((t) => /route\.ts/.test(t))).toBe(false);
    expect(dupTitles.some((t) => /page\.tsx/.test(t))).toBe(false);
  });

  it('does NOT flag co-located convention files (types.ts ×3) as a duplicate subsystem', () => {
    const out = runDetect(dir);
    const dupTitles = out.hotspots
      .filter((h) => h.kind === 'duplicate-subsystem')
      .map((h) => h.title);
    expect(dupTitles.some((t) => /types\.ts/.test(t))).toBe(false);
  });

  it('clusters version-marked dirs into legacy roots (per-dir, not per-file) and excludes the current version + tests', () => {
    const out = runDetect(dir);
    const ver = out.hotspots.find((h) => h.kind === 'duplicate-subsystem' && /legacy root/.test(h.title));
    expect(ver, 'version-root hotspot present').toBeTruthy();
    const rootPaths = ver.evidence.roots.map((r) => r.root);
    // onboarding-v2 (lone, 4 files) collapses to one root; its __tests__ file is excluded
    expect(rootPaths).toContain('src/components/onboarding-v2');
    expect(ver.evidence.roots.find((r) => r.root === 'src/components/onboarding-v2').files).toBe(4);
    // flow family: v1 is legacy (kept), v2 is current (dropped)
    expect(rootPaths).toContain('src/components/flow-v1');
    expect(rootPaths).not.toContain('src/components/flow-v2');
    // cross-dir family: onboarding-v2 (dir) is legacy (kept), onboarding-v3.ts is current (dropped)
    expect(rootPaths).toContain('src/components/onboarding-v2');
    expect(rootPaths).not.toContain('src/types/onboarding-v3.ts');
  });

  it('does NOT flag feature-name (enhanced/hierarchical) or migration files as legacy (fix#1)', () => {
    const out = runDetect(dir);
    const ver = out.hotspots.find((h) => h.kind === 'duplicate-subsystem' && /legacy root/.test(h.title));
    const roots = JSON.stringify(ver?.evidence.roots || []);
    expect(/enhanced|hierarchical|migrate/.test(roots)).toBe(false);
  });

  it('does NOT flag variants/ siblings as a duplicate subsystem (fix#2)', () => {
    const out = runDetect(dir);
    const dupTitles = out.hotspots
      .filter((h) => h.kind === 'duplicate-subsystem')
      .map((h) => h.title);
    expect(dupTitles.some((t) => /widget\.tsx/.test(t))).toBe(false);
  });

  it('suppresses a duplicate whose copy lives in a flagged legacy root (fix#3)', () => {
    const out = runDetect(dir);
    const dupTitles = out.hotspots
      .filter((h) => h.kind === 'duplicate-subsystem')
      .map((h) => h.title);
    // OnboardingFlow.tsx is in flow-v1 (legacy) + flow-v2 (current) → not a standalone dup
    expect(dupTitles.some((t) => /OnboardingFlow\.tsx/.test(t))).toBe(false);
  });

  it('gives role-aware god-object advice (a Repository is not told to "split into repositories")', () => {
    const out = runDetect(dir);
    const repo = out.hotspots.find((h) => h.kind === 'god-object' && /OrgsRepository/.test(h.title));
    expect(repo, 'OrgsRepository god-object present').toBeTruthy();
    expect(repo.evidence.role).toBe('repository');
    expect(repo.suggestedAction).toMatch(/already a repository/i);
    expect(repo.suggestedAction).not.toMatch(/into ~?\d+ domain repositories/);
  });

  it('surfaces toolStatus + detected/shown counts (no silent truncation)', () => {
    const out = runDetect(dir);
    expect(out.toolStatus).toBeTruthy();
    expect(out.toolStatus.knip).toMatch(/ok|empty|unavailable/);
    expect(out.detectedCount).toBe(out.shownCount); // fixture is small — nothing capped
    const total = Object.values(out.counts).reduce((s, n) => s + n, 0);
    expect(total).toBe(out.hotspots.length); // counts match emitted set exactly
  });

  it('detects the god-object by method out-degree', () => {
    const out = runDetect(dir);
    const god = out.hotspots.find((h) => h.kind === 'god-object' && /AWSProfileStorage/.test(h.title));
    expect(god, 'AWSProfileStorage god-object present').toBeTruthy();
    expect(god.evidence.methods).toBe(14);
    expect(god.evidence.importers).toBe(38);
  });

  it('splits dead code into safe-candidate vs needs-review (A2)', () => {
    const out = runDetect(dir);
    const dead = out.hotspots.filter((h) => h.kind === 'dead-code');
    const safe = dead.find((h) => h.evidence.confidence === 'safe-candidate');
    const review = dead.find((h) => h.evidence.confidence === 'needs-review');
    expect(safe, 'safe-candidate hotspot').toBeTruthy();
    expect(safe.evidence.confirmedZeroFanIn).toBe(1); // orphan.ts (fan-in 0)
    expect(review, 'needs-review hotspot').toBeTruthy();
    expect(review.evidence.needsReview).toBe(1); // used-dynamically.ts (fan-in 5)
  });

  it('honours an A4 calibration override (raise god-object floor → drops the god-object)', () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'hotspot-calib-'));
    writeFixture(sub, { calibration: { thresholds: { godObjectMinMethods: 20 } } });
    const out = runDetect(sub, ['--calibration', path.join(sub, 'calib.json')]);
    expect(out.hotspots.some((h) => h.kind === 'god-object')).toBe(false);
    fs.rmSync(sub, { recursive: true, force: true });
  });
});
