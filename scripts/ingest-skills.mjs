/**
 * ingest-skills.mjs — bulk-import Claude Code skills into the futurator-skills
 * registry (skills-management Phase 4, 2026-06-17).
 *
 * The registry was a metadata-only catalog (index.json) with NO skill bodies —
 * so the Registry UI showed "No body on file" and there was nothing to embed for
 * retrieval. This pipeline turns it into a real content store:
 *
 *   1. Shallow-clone each curated source repo.
 *   2. Walk for SKILL.md, parse frontmatter (name + description), read the body.
 *   3. Normalize the name to a slug; first-source-wins on collision (logged);
 *      stamp license + provenance (source repo + path).
 *   4. VENDOR: write skills/<name>/SKILL.md and a rebuilt index.json into a dest
 *      working copy of futurator-skills.
 *   5. EMBED (optional): Voyage-embed name+description+body-head into
 *      index.embeddings.json — the retrieval sidecar SKILL-SCOUT queries.
 *
 * Usage:
 *   node scripts/ingest-skills.mjs --dry-run
 *   node scripts/ingest-skills.mjs --out /tmp/futurator-skills [--embed]
 *
 * Pure-ish data tool: clones to a temp dir, never mutates the source repos, and
 * only writes under --out. License compliance: we ingest only the curated,
 * permissively-licensed sources below and record provenance per skill.
 */

import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { parseFrontmatter } from './gen-skill-index.mjs';

// ── Curated sources (operator-approved 2026-06-17) ─────────────────────────
// kind: a coarse bucket for UI filtering. licenseHint: fallback when the repo
// carries no per-skill frontmatter license.
const SOURCES = [
  { repo: 'anthropics/skills', kind: 'core', licenseHint: 'Anthropic (see LICENSE.txt)' },
  { repo: 'vercel-labs/agent-skills', kind: 'frontend', licenseHint: 'MIT' },
  { repo: 'obra/superpowers', kind: 'workflow', licenseHint: 'MIT' },
  { repo: 'trailofbits/skills', kind: 'security', licenseHint: 'see-source' },
  { repo: 'remotion-dev/skills', kind: 'media', licenseHint: 'see-source' },
  { repo: 'mattpocock/skills', kind: 'core', licenseHint: 'MIT' },
  { repo: 'coreyhaines31/marketingskills', kind: 'marketing', licenseHint: 'see-source' },
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TMP = '/tmp/skill-sources';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const doEmbed = args.includes('--embed');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Recursively find every SKILL.md path under dir. */
function findSkillMds(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) findSkillMds(p, out);
    else if (entry === 'SKILL.md') out.push(p);
  }
  return out;
}

function clone(repo) {
  const dest = join(TMP, repo.replace('/', '__'));
  rmSync(dest, { recursive: true, force: true });
  execFileSync('git', ['clone', '--depth', '1', '-q', `https://github.com/${repo}`, dest], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return dest;
}

// ── 1-3. Collect skills from all sources ───────────────────────────────────
const collected = new Map(); // slug -> skill
const collisions = [];
const skipped = [];

for (const src of SOURCES) {
  let root;
  try {
    root = clone(src.repo);
  } catch (e) {
    skipped.push(`${src.repo}: clone failed (${e.message})`);
    continue;
  }
  const mds = findSkillMds(root);
  for (const mdPath of mds) {
    const rel = mdPath.slice(root.length + 1);
    // Skip templates/examples that aren't real skills.
    if (/(^|\/)(template|example|examples|fixtures?)(\/|$)/i.test(rel)) {
      skipped.push(`${src.repo}/${rel}: template/example`);
      continue;
    }
    const md = readFileSync(mdPath, 'utf8');
    const fm = parseFrontmatter(md);
    const rawName = (fm.name && String(fm.name)) || dirname(rel).split('/').pop();
    const description = (fm.description && String(fm.description).trim()) || '';
    const slug = SLUG_RE.test(rawName) ? rawName : slugify(rawName);
    if (!slug || !description) {
      skipped.push(`${src.repo}/${rel}: missing name/description`);
      continue;
    }
    if (collected.has(slug)) {
      collisions.push(`${slug}: ${collected.get(slug).provenance} kept; dropped ${src.repo}/${rel}`);
      continue;
    }
    collected.set(slug, {
      name: slug,
      description,
      body: md,
      kind: src.kind,
      framework: false,
      version: 'sha:HEAD',
      license: (fm.license && String(fm.license)) || src.licenseHint,
      provenance: `github.com/${src.repo}/${rel}`,
    });
  }
}

const skills = [...collected.values()].sort((a, b) => a.name.localeCompare(b.name));

// ── Report ─────────────────────────────────────────────────────────────────
const byKind = {};
for (const s of skills) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
console.log(`\n=== INGEST REPORT ===`);
console.log(`sources:       ${SOURCES.length}`);
console.log(`skills:        ${skills.length}`);
console.log(`by kind:       ${JSON.stringify(byKind)}`);
console.log(`collisions:    ${collisions.length}`);
console.log(`skipped:       ${skipped.length}`);
if (collisions.length) console.log(`  ` + collisions.slice(0, 20).join('\n  '));
if (skipped.length) console.log(`skipped detail:\n  ` + skipped.slice(0, 30).join('\n  '));

if (dryRun || !outDir) {
  console.log(`\n(dry-run — nothing written. Pass --out <dir> to vendor.)`);
  process.exit(0);
}

// ── 4. Vendor bodies + rebuild index.json (MERGE with existing) ─────────────
const indexPath = join(outDir, 'index.json');
const existing = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { skills: [] };
const existingByName = new Map((existing.skills || []).map((s) => [s.name, s]));

let wrote = 0;
for (const s of skills) {
  const dir = join(outDir, 'skills', s.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), s.body.endsWith('\n') ? s.body : s.body + '\n');
  wrote += 1;
  existingByName.set(s.name, {
    name: s.name,
    kind: s.kind,
    framework: s.framework,
    version: s.version,
    license: s.license,
    description: s.description,
    provenance: s.provenance,
  });
}

const mergedSkills = [...existingByName.values()].sort((a, b) => a.name.localeCompare(b.name));
const nextIndex = {
  'index-version': (existing['index-version'] || 1),
  'generated-by': 'ingest-skills.mjs (skills-management Phase 4)',
  skills: mergedSkills,
};
writeFileSync(indexPath, JSON.stringify(nextIndex, null, 2) + '\n');
console.log(`\nvendored ${wrote} SKILL.md bodies; index.json now lists ${mergedSkills.length} skills.`);

// ── 5. Embeddings sidecar (Voyage) ──────────────────────────────────────────
if (doEmbed) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    console.error('--embed set but VOYAGE_API_KEY missing; skipping embeddings.');
    process.exit(0);
  }
  const MODEL = 'voyage-3';
  const texts = mergedSkills.map((s) => {
    const body =
      existsSync(join(outDir, 'skills', s.name, 'SKILL.md'))
        ? readFileSync(join(outDir, 'skills', s.name, 'SKILL.md'), 'utf8')
        : '';
    return `${s.name}\n${s.description}\n${body}`.slice(0, 8000);
  });
  const vectors = {};
  let dim = 0;
  for (let i = 0; i < mergedSkills.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: batch, model: MODEL, input_type: 'document' }),
    });
    if (!res.ok) {
      console.error(`Voyage HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
    const data = await res.json();
    for (let j = 0; j < data.data.length; j += 1) {
      const vec = data.data[j].embedding;
      vectors[mergedSkills[i + j].name] = vec;
      dim = vec.length;
    }
    console.log(`embedded ${Math.min(i + 64, mergedSkills.length)}/${mergedSkills.length}`);
  }
  writeFileSync(
    join(outDir, 'index.embeddings.json'),
    JSON.stringify({ model: MODEL, dim, count: Object.keys(vectors).length, vectors }) + '\n',
  );
  console.log(`wrote index.embeddings.json (${MODEL}, dim=${dim}, ${Object.keys(vectors).length} vecs).`);
}
