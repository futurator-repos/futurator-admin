import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSkillEmbedTexts, runEmbedSkills } from '../embed-skills.mjs';

let dir;
const skill = (name, body) => {
  const d = join(dir, '.claude', 'skills', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), body);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'embed-skills-'));
  skill('alpha', '---\nname: alpha\ndescription: does alpha things\n---\nbody a');
  skill('beta', '---\nname: beta\ndescription: does beta things\n---\nbody b');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VOYAGE_API_KEY;
});

describe('collectSkillEmbedTexts', () => {
  it('collects one text per on-disk skill, deterministically sorted', () => {
    const { names, texts } = collectSkillEmbedTexts(dir);
    expect(names).toEqual(['alpha', 'beta']);
    expect(texts[0]).toMatch(/alpha/);
    expect(texts).toHaveLength(2);
  });
  it('returns empty for a dir with no skills', () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    expect(collectSkillEmbedTexts(empty).names).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('runEmbedSkills', () => {
  it('skips (never throws) when VOYAGE_API_KEY is absent', async () => {
    const r = await runEmbedSkills({ worktreeDir: dir });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no-api-key');
    expect(existsSync(join(dir, '.claude', 'index.embeddings.json'))).toBe(false);
  });

  it('writes a name-keyed sidecar with matching model/dim header', async () => {
    process.env.VOYAGE_API_KEY = 'test';
    const embed = async (texts) => texts.map(() => new Array(1024).fill(0.1));
    const r = await runEmbedSkills({ worktreeDir: dir, embed });
    expect(r.count).toBe(2);
    const sc = JSON.parse(readFileSync(join(dir, '.claude', 'index.embeddings.json'), 'utf8'));
    expect(sc.model).toBe('voyage-3-large');
    expect(sc.dim).toBe(1024);
    expect(Object.keys(sc.vectors).sort()).toEqual(['alpha', 'beta']);
    expect(sc.vectors.alpha).toHaveLength(1024);
  });

  it('skips on a dim mismatch rather than writing a poisoned sidecar', async () => {
    process.env.VOYAGE_API_KEY = 'test';
    const embed = async (texts) => texts.map(() => new Array(512).fill(0.1)); // wrong dim
    const r = await runEmbedSkills({ worktreeDir: dir, embed });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('bad-dim');
    expect(existsSync(join(dir, '.claude', 'index.embeddings.json'))).toBe(false);
  });

  it('swallows an embedder throw (non-blocking)', async () => {
    process.env.VOYAGE_API_KEY = 'test';
    const embed = async () => { throw new Error('voyage 429'); };
    const r = await runEmbedSkills({ worktreeDir: dir, embed });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/voyage 429/);
  });
});
