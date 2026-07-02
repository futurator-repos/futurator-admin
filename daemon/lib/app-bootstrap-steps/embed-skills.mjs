// embed-skills — W1.1 (implementation-plan). Build the per-project skill
// embeddings sidecar `.claude/index.embeddings.json` so `buildSkillsPushPrompt`
// can cosine-rank and PUSH the most relevant skill BODIES for a story. Without
// this sidecar the ranker returns `ranked:false` and agents get skill NAMES,
// not instructions.
//
// SAFETY: the sidecar is only READ when SKILLS_EMBED_RANK=on (gated in
// skills-prompt.mjs), so writing it here is dark by default. This step is also
// NON-BLOCKING: any failure (absent VOYAGE_API_KEY, API/dim error) returns
// `{ skipped }` — a Voyage outage can never brick the app-bootstrap infra job.
//
// The embedder MUST match the query embedder (voyage-3-large / dim 1024,
// `voyage-embed.mjs`) or cosine similarity is meaningless — asserted in the
// sidecar header.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { embedBatch, VOYAGE_MODEL, EMBEDDING_DIM } from '../../scripts/lib/voyage-embed.mjs';

const HEAD_CHARS = 2000; // name + frontmatter (desc) + body head — enough to characterize a skill

/**
 * Pure: collect `{ names, texts }` for every `.claude/skills/<name>/SKILL.md`
 * under the worktree. Text = dir name + the SKILL.md head. Deterministic order.
 */
export function collectSkillEmbedTexts(worktreeDir) {
  const skillsDir = join(worktreeDir, '.claude', 'skills');
  const names = [];
  const texts = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { names, texts, skillsDir };
  }
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const md = join(skillsDir, e.name, 'SKILL.md');
    if (!existsSync(md)) continue;
    let head = '';
    try {
      head = readFileSync(md, 'utf8').slice(0, HEAD_CHARS);
    } catch {
      continue;
    }
    names.push(e.name);
    texts.push(`${e.name}\n${head}`);
  }
  return { names, texts, skillsDir };
}

/**
 * @param {{ worktreeDir: string, onOutput?: (s:string)=>void, embed?: typeof embedBatch }} args
 * @returns {Promise<{ skipped?: boolean, reason?: string, count?: number, model?: string, dim?: number }>}
 */
export async function runEmbedSkills({ worktreeDir, onOutput, embed = embedBatch } = {}) {
  const say = (m) => { if (typeof onOutput === 'function') onOutput(m + '\n'); };
  try {
    if (!process.env.VOYAGE_API_KEY) {
      say('embed-skills: no VOYAGE_API_KEY — skipping (sidecar not written)');
      return { skipped: true, reason: 'no-api-key' };
    }
    const { names, texts, skillsDir } = collectSkillEmbedTexts(worktreeDir);
    if (names.length === 0) {
      say('embed-skills: no on-disk skills — skipping');
      return { skipped: true, reason: 'no-skills' };
    }

    const vecs = await embed(texts, 'document');
    if (!Array.isArray(vecs) || vecs.length !== names.length) {
      say(`embed-skills: embedder returned ${vecs?.length} vectors for ${names.length} skills — skipping`);
      return { skipped: true, reason: 'count-mismatch' };
    }

    const vectors = {};
    let dim = 0;
    for (let i = 0; i < names.length; i++) {
      const v = vecs[i];
      if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
        say(`embed-skills: bad vector dim for ${names[i]} (got ${v?.length}, want ${EMBEDDING_DIM}) — skipping`);
        return { skipped: true, reason: 'bad-dim' };
      }
      vectors[names[i]] = v;
      dim = v.length;
    }

    const sidecar = {
      model: VOYAGE_MODEL, // MUST equal the query embedder or cosine is meaningless
      dim,
      count: names.length,
      generatedAt: new Date().toISOString(),
      vectors,
    };
    // Sidecar sits one level up from .claude/skills (loadEmbeddingsSidecar reads
    // `<skillsDir>/../index.embeddings.json`).
    writeFileSync(join(skillsDir, '..', 'index.embeddings.json'), JSON.stringify(sidecar));
    say(`embed-skills: wrote ${names.length} skill vectors (${VOYAGE_MODEL}/${dim})`);
    return { count: names.length, model: VOYAGE_MODEL, dim };
  } catch (err) {
    // Total backstop (D2) — never throw out of app-bootstrap.
    say(`embed-skills: failed (non-blocking): ${err?.message || err}`);
    return { skipped: true, reason: String(err?.message || err) };
  }
}
