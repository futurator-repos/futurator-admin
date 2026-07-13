/**
 * skills-prompt-ranking.test.mjs — F27 (P2).
 *
 * Covers the relevance-ranked loadout variant: when the embeddings sidecar
 * AND story text are present, the non-pinned tail is reordered by cosine
 * similarity (pins stay first); absent/unreadable sidecar or a failing
 * embed call falls back to the plain readdir ordering without throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the Voyage embed call so the test is deterministic + offline.
const embedTextMock = vi.fn();
vi.mock('../../scripts/lib/voyage-embed.mjs', () => ({
  embedText: (...args) => embedTextMock(...args),
}));

const { buildSkillsPromptLine, buildSkillsPromptLineRanked } = await import('../skills-prompt.mjs');

let wd;

function writeSkill(name, desc) {
  const dir = join(wd, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
}

function writeSidecar(vectors) {
  writeFileSync(
    join(wd, '.claude', 'index.embeddings.json'),
    JSON.stringify({ model: 'voyage-3', dim: 2, count: Object.keys(vectors).length, vectors }),
  );
}

beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), 'skp-rank-'));
  embedTextMock.mockReset();
  // Ranking (sidecar read) is gated behind SKILLS_EMBED_RANK=on in production;
  // opt in so the re-rank assertions actually exercise the ranked path.
  vi.stubEnv('SKILLS_EMBED_RANK', 'on');
});

afterEach(() => {
  rmSync(wd, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('buildSkillsPromptLineRanked', () => {
  it('falls back to the sync builder when no story text is given', async () => {
    writeSkill('alpha', 'alpha desc');
    writeSkill('zeta', 'zeta desc');
    const ranked = await buildSkillsPromptLineRanked(wd, '');
    expect(ranked).toBe(buildSkillsPromptLine(wd));
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('returns the plain section (no embed) when the sidecar is absent', async () => {
    writeSkill('alpha', 'alpha desc');
    writeSkill('zeta', 'zeta desc');
    const ranked = await buildSkillsPromptLineRanked(wd, 'build a zeta thing');
    expect(ranked).toContain('alpha');
    expect(ranked).toContain('zeta');
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('re-ranks the non-pinned tail by cosine similarity to the story text', async () => {
    // readdir order is alphabetical: alpha, zeta. The query vector is closest
    // to zeta, so after ranking zeta must precede alpha in the section.
    writeSkill('alpha', 'alpha desc');
    writeSkill('zeta', 'zeta desc');
    writeSidecar({ alpha: [1, 0], zeta: [0, 1] });
    embedTextMock.mockResolvedValue([0, 1]); // query ~ zeta

    const ranked = await buildSkillsPromptLineRanked(wd, 'a zeta-flavored story');
    expect(embedTextMock).toHaveBeenCalledOnce();
    expect(embedTextMock.mock.calls[0][1]).toBe('query');
    expect(ranked.indexOf('zeta')).toBeLessThan(ranked.indexOf('alpha'));
  });

  it('falls back to readdir order when embedText throws (e.g. no API key)', async () => {
    writeSkill('alpha', 'alpha desc');
    writeSkill('zeta', 'zeta desc');
    writeSidecar({ alpha: [1, 0], zeta: [0, 1] });
    embedTextMock.mockRejectedValue(new Error('VOYAGE_API_KEY not set'));

    const ranked = await buildSkillsPromptLineRanked(wd, 'zeta task');
    // No throw, alphabetical readdir order preserved.
    expect(ranked.indexOf('alpha')).toBeLessThan(ranked.indexOf('zeta'));
  });

  it('keeps pinned skills first even when an unpinned skill ranks higher', async () => {
    writeSkill('alpha', 'alpha desc');
    writeSkill('zeta', 'zeta desc');
    // Pin alpha via the manifest — a genuine pin now requires a SKILL-SCOUT
    // rationale (dossier B3: bare installed entries are no longer pins). zeta
    // is the relevance winner but must stay in the "Also vendored" section,
    // after the pinned alpha.
    writeFileSync(
      join(wd, '.claude', 'skills.manifest.yaml'),
      'core:\n  - source: x\n    skill: alpha\n    rationale: Alpha carries curated project conventions.\n',
    );
    writeSidecar({ alpha: [1, 0], zeta: [0, 1] });
    embedTextMock.mockResolvedValue([0, 1]); // query ~ zeta

    const ranked = await buildSkillsPromptLineRanked(wd, 'zeta story');
    expect(ranked).toContain('Pinned for this project');
    expect(ranked.indexOf('alpha')).toBeLessThan(ranked.indexOf('zeta'));
  });
});
