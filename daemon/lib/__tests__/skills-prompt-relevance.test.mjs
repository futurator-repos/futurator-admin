/**
 * skills-prompt-relevance.test.mjs — dossier B3 fix (2026-07-13).
 *
 * Locks the skills-relevance semantics that replaced "prepin-everything defeats
 * the ranking":
 *
 *   1. PIN SEMANTICS — a manifest entry is a PIN only when it carries a
 *      SKILL-SCOUT rationale. Bare installed/available entries (what prepin +
 *      reconcile write) are NOT pins, so they can no longer bypass the ranking.
 *      Regression for the "same alphabetical 3 skills pushed into every agent"
 *      bug: all entries rationale-less + sidecar present → selection is
 *      cosine-ranked, not alphabetical.
 *   2. RANK WITHIN EVERYTHING — a rationale-carrying pin gets a bounded additive
 *      boost that wins CLOSE ties, but a clearly-irrelevant pin still loses to a
 *      clearly-relevant non-pin (never absolute precedence).
 *   3. RELEVANCE FLOOR — only skills clearing P3_SKILLS_MIN_SCORE get a body
 *      pushed; nothing clears it → push NOTHING (flat list, zero bodies).
 *   4. selectPushedSkillNames mirrors buildSkillsPushPrompt EXACTLY.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const embedTextMock = vi.fn();
vi.mock('../../scripts/lib/voyage-embed.mjs', () => ({
  embedText: (...args) => embedTextMock(...args),
}));

const { buildSkillsPushPrompt, selectPushedSkillNames } = await import('../skills-prompt.mjs');

let wd;

function writeSkill(name, body) {
  const dir = join(wd, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${name} does ${name} things\n---\n${body ?? `Body of ${name}.`}\n`;
  writeFileSync(join(dir, 'SKILL.md'), md);
}

function writeSidecar(vectors) {
  writeFileSync(
    join(wd, '.claude', 'index.embeddings.json'),
    JSON.stringify({ model: 'voyage-3', dim: 2, count: Object.keys(vectors).length, vectors }),
  );
}

/** @param {Array<{skill:string, rationale?:string}>} entries */
function writeManifest(entries) {
  let y = 'project: t\nmanifest-version: 1\ncore:\n';
  for (const e of entries) {
    y += `  - source: fed\n    skill: ${e.skill}\n    version: sha:HEAD\n`;
    if (e.rationale) y += `    rationale: ${e.rationale}\n`;
  }
  writeFileSync(join(wd, '.claude', 'skills.manifest.yaml'), y);
}

beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), 'skp-rel-'));
  embedTextMock.mockReset();
  // Opt into the ranking feature-flag under test (loadEmbeddingsSidecar reads
  // the sidecar only when this is 'on'; production keeps it dark by default).
  vi.stubEnv('SKILLS_EMBED_RANK', 'on');
});

afterEach(() => {
  rmSync(wd, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('pin semantics — rationale-less manifest entries are NOT pins', () => {
  it('regression: all entries rationale-less → cosine-ranked, not alphabetical', async () => {
    // Six skills, ALL written into the manifest with NO rationale (exactly what
    // prepin-default-skills + reconcile-skills-manifest emit). The alphabetically
    // FIRST three (a1,a2,a3) are irrelevant; the last three (z1,z2,z3) match the
    // story. Old bug: all 6 counted as pins → placed first unranked (alphabetical)
    // → the a's were pushed into every agent. Fixed: rationale-less → not pinned →
    // cosine drives selection → the z's are pushed.
    for (const n of ['a1', 'a2', 'a3', 'z1', 'z2', 'z3']) writeSkill(n, `${n.toUpperCase()}-BODY`);
    writeManifest([
      { skill: 'a1' }, { skill: 'a2' }, { skill: 'a3' },
      { skill: 'z1' }, { skill: 'z2' }, { skill: 'z3' },
    ]);
    writeSidecar({
      a1: [0, 1], a2: [0, 1], a3: [0, 1],
      z1: [1, 0], z2: [0.99, 0.01], z3: [0.98, 0.02],
    });
    embedTextMock.mockResolvedValue([1, 0]); // query ~ the z's

    const { pushed } = await selectPushedSkillNames(wd, 'a z-flavored story');
    expect(pushed).toEqual(['z1', 'z2', 'z3']);

    const out = await buildSkillsPushPrompt(wd, 'a z-flavored story');
    for (const z of ['Z1-BODY', 'Z2-BODY', 'Z3-BODY']) expect(out).toContain(z);
    // The alphabetically-first (irrelevant) skills are NOT pushed as bodies.
    for (const a of ['A1-BODY', 'A2-BODY', 'A3-BODY']) expect(out).not.toContain(a);
  });
});

describe('relevance floor', () => {
  it('nothing clears the floor → zero pushed bodies (flat list only)', async () => {
    writeSkill('one', 'ONE-BODY');
    writeSkill('two', 'TWO-BODY');
    writeSidecar({ one: [0, 1], two: [0.05, 0.99] });
    embedTextMock.mockResolvedValue([1, 0]); // orthogonal to both → cos ~0 < floor

    const out = await buildSkillsPushPrompt(wd, 'unrelated story');
    expect(out).not.toContain('# Skills to apply now');
    // Still discoverable via the flat name list (fallback PULL).
    expect(out).toContain('one');
    expect(out).toContain('two');

    const { pushed } = await selectPushedSkillNames(wd, 'unrelated story');
    expect(pushed).toEqual([]);
  });

  it('P3_SKILLS_MIN_SCORE override lets a modest-relevance skill through', async () => {
    writeSkill('mid', 'MID-BODY');
    writeSidecar({ mid: [0.5, 0.866] }); // cos to [1,0] ≈ 0.5
    embedTextMock.mockResolvedValue([1, 0]);

    // Default floor 0.30 < 0.5 so it already passes; tighten the floor above
    // its score and it must drop out — proving the env gate is honored.
    vi.stubEnv('P3_SKILLS_MIN_SCORE', '0.6');
    const dropped = await selectPushedSkillNames(wd, 's');
    expect(dropped.pushed).toEqual([]);

    vi.stubEnv('P3_SKILLS_MIN_SCORE', '0.4');
    const kept = await selectPushedSkillNames(wd, 's');
    expect(kept.pushed).toEqual(['mid']);
  });
});

describe('pin boost is bounded, not absolute', () => {
  it('a rationale pin wins a CLOSE tie via the boost', async () => {
    writeSkill('pinClose', 'PINCLOSE-BODY');
    writeSkill('nonCloser', 'NONCLOSER-BODY');
    writeManifest([{ skill: 'pinClose', rationale: 'Curated for this project core work.' }]);
    // nonCloser has the marginally higher raw cosine; the pin's +0.10 boost
    // flips the order so the curated skill leads.
    writeSidecar({ pinClose: [0.9, 0.1], nonCloser: [0.95, 0.05] });
    embedTextMock.mockResolvedValue([1, 0]);

    const { pushed } = await selectPushedSkillNames(wd, 'core story');
    expect(pushed).toEqual(['pinClose', 'nonCloser']); // boost tipped the tie
  });

  it('a clearly-irrelevant pin loses to a clearly-relevant non-pin AND is not pushed', async () => {
    writeSkill('pinIrrelevant', 'PINIRRELEVANT-BODY');
    writeSkill('nonRelevant', 'NONRELEVANT-BODY');
    writeManifest([{ skill: 'pinIrrelevant', rationale: 'Pinned but off-topic for this story.' }]);
    writeSidecar({ pinIrrelevant: [0, 1], nonRelevant: [1, 0] });
    embedTextMock.mockResolvedValue([1, 0]); // query ~ nonRelevant

    const { pushed } = await selectPushedSkillNames(wd, 'on-topic story');
    // pin cos 0 + 0.10 boost = 0.10 < floor 0.30 → excluded; relevant non-pin in.
    expect(pushed).toEqual(['nonRelevant']);

    const out = await buildSkillsPushPrompt(wd, 'on-topic story');
    expect(out).toContain('NONRELEVANT-BODY');
    expect(out).not.toContain('## pinIrrelevant\n');
  });
});

describe('selectPushedSkillNames parity with buildSkillsPushPrompt', () => {
  it('records EXACTLY the skills whose bodies are injected', async () => {
    for (const n of ['s1', 's2', 's3', 's4', 's5']) writeSkill(n, `${n.toUpperCase()}-BODY`);
    // Mixed manifest: some rationale pins, some bare — none of it should let an
    // irrelevant skill in, and the recorded set must equal the injected set.
    writeManifest([
      { skill: 's4', rationale: 'Pinned but far from this story.' },
      { skill: 's1' },
    ]);
    writeSidecar({
      s1: [1, 0], s2: [0.9, 0.1], s3: [0.8, 0.2], s4: [0, 1], s5: [0, 1],
    });
    embedTextMock.mockResolvedValue([1, 0]);

    const { pushed } = await selectPushedSkillNames(wd, 'story');
    const out = await buildSkillsPushPrompt(wd, 'story');
    expect(pushed.length).toBeGreaterThan(0);
    for (const name of pushed) expect(out).toContain(`## ${name}\n`);
    // Every ## body block in the prompt corresponds to a recorded skill.
    const injected = [...out.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
    expect(injected).toEqual(pushed);
  });
});
