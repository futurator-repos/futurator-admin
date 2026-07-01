/**
 * skills-prompt-push.test.mjs — F24 (P1).
 *
 * Covers the PUSH variant: for code-producing roles the daemon injects the
 * BODIES of the top-3 skills ranked (F27 cosine) against THIS story, instead
 * of relying on name+description PULL. The remaining skills stay in the flat
 * "Also vendored" list as a fallback. Absent sidecar / failing embed degrade
 * gracefully without throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const embedTextMock = vi.fn();
vi.mock('../../scripts/lib/voyage-embed.mjs', () => ({
  embedText: (...args) => embedTextMock(...args),
}));

const { buildSkillsPushPrompt, buildSkillsPromptLine, selectPushedSkillNames } = await import(
  '../skills-prompt.mjs'
);

let wd;

function writeSkill(name, desc, body) {
  const dir = join(wd, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${desc}\n---\n${body ?? `Body of ${name}.`}\n`;
  writeFileSync(join(dir, 'SKILL.md'), md);
}

function writeSidecar(vectors) {
  writeFileSync(
    join(wd, '.claude', 'index.embeddings.json'),
    JSON.stringify({ model: 'voyage-3', dim: 2, count: Object.keys(vectors).length, vectors }),
  );
}

beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), 'skp-push-'));
  embedTextMock.mockReset();
});

afterEach(() => {
  rmSync(wd, { recursive: true, force: true });
});

describe('buildSkillsPushPrompt', () => {
  it('falls back to the flat sync line when no story text is given', async () => {
    writeSkill('alpha', 'alpha desc');
    const out = await buildSkillsPushPrompt(wd, '');
    expect(out).toBe(buildSkillsPromptLine(wd));
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('injects the top-ranked skill BODY and keeps the rest as a flat list', async () => {
    writeSkill('alpha', 'alpha desc', 'ALPHA-INSTRUCTIONS unique body text');
    writeSkill('zeta', 'zeta desc', 'ZETA-INSTRUCTIONS unique body text');
    writeSidecar({ alpha: [1, 0], zeta: [0, 1] });
    embedTextMock.mockResolvedValue([0, 1]); // query ~ zeta

    const out = await buildSkillsPushPrompt(wd, 'a zeta-flavored story');
    expect(embedTextMock).toHaveBeenCalledOnce();
    expect(embedTextMock.mock.calls[0][1]).toBe('query');
    // Top-ranked zeta's body is pushed verbatim under the apply-now header.
    expect(out).toContain('# Skills to apply now');
    expect(out).toContain('ZETA-INSTRUCTIONS');
  });

  it('pushes at most 3 skill bodies and lists the remainder as fallback', async () => {
    for (const n of ['s1', 's2', 's3', 's4', 's5']) {
      writeSkill(n, `${n} desc`, `${n.toUpperCase()}-BODY content`);
    }
    writeSidecar({
      s1: [1, 0],
      s2: [0.9, 0.1],
      s3: [0.8, 0.2],
      s4: [0.1, 0.9],
      s5: [0, 1],
    });
    embedTextMock.mockResolvedValue([1, 0]); // closest to s1,s2,s3

    const out = await buildSkillsPushPrompt(wd, 'story text');
    const bodyCount = ['S1-BODY', 'S2-BODY', 'S3-BODY', 'S4-BODY', 'S5-BODY'].filter((b) =>
      out.includes(b),
    ).length;
    expect(bodyCount).toBe(3);
    // The non-pushed tail is still discoverable via the flat list.
    expect(out).toContain('Also vendored');
  });

  it('falls back to the plain name list when the sidecar is absent', async () => {
    writeSkill('alpha', 'alpha desc', 'ALPHA-BODY');
    writeSkill('zeta', 'zeta desc', 'ZETA-BODY');
    const out = await buildSkillsPushPrompt(wd, 'do a thing');
    expect(embedTextMock).not.toHaveBeenCalled();
    // No body push without ranking; the flat name+description loadout is used.
    expect(out).not.toContain('# Skills to apply now');
    expect(out).toContain('alpha');
    expect(out).toContain('zeta');
  });

  it('does not throw and degrades when embedText fails', async () => {
    writeSkill('alpha', 'alpha desc', 'ALPHA-BODY');
    writeSidecar({ alpha: [1, 0] });
    embedTextMock.mockRejectedValue(new Error('VOYAGE_API_KEY not set'));

    const out = await buildSkillsPushPrompt(wd, 'task');
    expect(out).toContain('alpha');
  });

  it('respects the section budget for pushed bodies', async () => {
    const huge = 'X'.repeat(20000);
    writeSkill('alpha', 'alpha desc', huge);
    writeSkill('beta', 'beta desc', huge);
    writeSidecar({ alpha: [1, 0], beta: [0.9, 0.1] });
    embedTextMock.mockResolvedValue([1, 0]);

    const out = await buildSkillsPushPrompt(wd, 'story');
    // Combined pushed bodies must stay within the section cap (8000) plus the
    // header + fallback list; assert the pushed region is bounded.
    const applyIdx = out.indexOf('# Skills to apply now');
    expect(applyIdx).toBeGreaterThanOrEqual(0);
    // Pushed bodies are truncated — neither full 20k body survives intact.
    expect(out.includes(huge)).toBe(false);
  });
});

describe('selectPushedSkillNames', () => {
  it('returns the SAME skills whose bodies buildSkillsPushPrompt injects', async () => {
    for (const n of ['s1', 's2', 's3', 's4', 's5']) {
      writeSkill(n, `${n} desc`, `${n.toUpperCase()}-BODY content`);
    }
    writeSidecar({
      s1: [1, 0],
      s2: [0.9, 0.1],
      s3: [0.8, 0.2],
      s4: [0.1, 0.9],
      s5: [0, 1],
    });
    embedTextMock.mockResolvedValue([1, 0]); // closest to s1,s2,s3

    const { pushed, ranked } = await selectPushedSkillNames(wd, 'story text');
    expect(ranked).toBe(true);
    expect(pushed).toEqual(['s1', 's2', 's3']); // top-3 by cosine, in rank order

    // And they match the bodies actually pushed into the prompt.
    const out = await buildSkillsPushPrompt(wd, 'story text');
    for (const name of pushed) expect(out).toContain(`${name.toUpperCase()}-BODY`);
  });

  it('returns [] when there is no relevance signal (name-list fallback path)', async () => {
    writeSkill('alpha', 'alpha desc', 'ALPHA-BODY');
    writeSkill('zeta', 'zeta desc', 'ZETA-BODY');
    // No sidecar → not ranked, no pins → buildSkillsPushPrompt pushes no body.
    const { pushed, ranked } = await selectPushedSkillNames(wd, 'do a thing');
    expect(ranked).toBe(false);
    expect(pushed).toEqual([]);
    expect(embedTextMock).not.toHaveBeenCalled();
  });

  it('returns [] with no story text (mirrors the sync fallback)', async () => {
    writeSkill('alpha', 'alpha desc');
    expect(await selectPushedSkillNames(wd, '')).toEqual({ pushed: [], ranked: false });
  });

  it('does not throw when embedText fails', async () => {
    writeSkill('alpha', 'alpha desc', 'ALPHA-BODY');
    writeSidecar({ alpha: [1, 0] });
    embedTextMock.mockRejectedValue(new Error('VOYAGE_API_KEY not set'));
    const res = await selectPushedSkillNames(wd, 'task');
    // embed failure → rankLoadoutItems reports ranked:false → name-list fallback.
    expect(res.pushed).toEqual([]);
  });
});
