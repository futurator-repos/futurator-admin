// @ts-nocheck
/**
 * Agentic Document Center (E1.3, daemon half) — atomic shard + projection writer.
 *
 * A god doc is assembled from per-subsystem SHARDS (one shard per module
 * boundary, keyed `§sys:<path>` by `subsystem-extract.mjs`). Each shard's prose
 * is generated independently (arch-shard-compile) and written here as the
 * artifact of record:
 *
 *   <projectDir>/<docType>/shards/<safeKey>.md           — the shard markdown
 *   <projectDir>/<docType>/shards/<safeKey>.sections.json — its manifest sidecar
 *
 * and the assembled whole-document PROJECTION (built by `doc-assembler.mjs`):
 *
 *   <projectDir>/<docType>/<docType>.md
 *   <projectDir>/<docType>/<docType>.sections.json
 *
 * The projection's section anchors are `<!--§<shardKey>-->` — i.e. the section
 * `id` of a shard's top anchor IS its shardKey, so the graph join (godDoc
 * CONTAINS docShard, docSection ≡ shard) is byte-exact with the
 * `subsystem-extract` key. This is the deliberate twist on the
 * `section-manifest.ts` model: most docs slug their headings; a god doc's
 * sections are keyed by subsystem identity, not heading text.
 *
 * This module REIMPLEMENTS the locked slugifier + `contentHash` from
 * `functions/shared/concept/section-manifest.ts` (a daemon `.mjs` cannot import
 * the `.ts` at runtime — same constraint as `concept-artifact-writeback.mjs` and
 * the inline `resolveSection` in `story-context-pack.mjs`). The reimplementation
 * is kept byte-identical to the TS by the shared-fixture parity test.
 */

import { createHash } from 'node:crypto';
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';

// MUST stay byte-identical to section-manifest.ts (parity test enforces).
const ANCHOR_RE = /^<!--§([a-z0-9][a-z0-9-]*)-->$/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

/** Stable kebab-case slug from a heading title. Mirror of TS slugifyHeading. */
export function slugifyHeading(title) {
  const base = String(title)
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

/** `sha256:<hex>` over the annotated markdown. Mirror of TS sha256. */
export function contentHash(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A shardKey (`§sys:src--auth`) is not filesystem-safe (the `§` + `:`), so a
 * shard's on-disk basename is derived deterministically: strip the `§sys:`
 * prefix, keep the already-`--`-encoded tail. `§sys:src--auth` → `src--auth`.
 * The shardKey itself (with prefix) remains the graph + anchor id.
 */
export function shardFileBase(shardKey) {
  return String(shardKey).replace(/^§sys:/, '').replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * Mirror of TS `generateSectionManifest` for a SLUGGED document (every ATX
 * heading gets a `<!--§slug-->` anchor). Used for an individual shard's own
 * internal manifest. Returns `{ markdown, manifest }`.
 */
export function generateSectionManifest(rawMarkdown, opts = {}) {
  const inLines = String(rawMarkdown).split('\n');
  const outLines = [];
  const seen = new Set();
  const pending = [];
  for (const line of inLines) {
    const h = line.match(HEADING_RE);
    if (h && !ANCHOR_RE.test(line)) {
      let id = slugifyHeading(h[1]);
      if (seen.has(id)) {
        let n = 2;
        while (seen.has(`${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      seen.add(id);
      outLines.push(`<!--§${id}-->`);
      pending.push({ id, title: h[1], anchorLine: outLines.length });
      outLines.push(line);
    } else {
      outLines.push(line);
    }
  }
  const markdown = outLines.join('\n');
  const sections = pending.map((p, i) => ({
    id: p.id,
    title: p.title,
    lineStart: p.anchorLine,
    lineEnd: i + 1 < pending.length ? pending[i + 1].anchorLine - 1 : outLines.length,
  }));
  return {
    markdown,
    manifest: {
      artifact: opts.artifact ?? 'shard',
      rev: opts.rev ?? 0,
      contentHash: contentHash(markdown),
      sections,
    },
  };
}

/**
 * Two-phase atomic write: tmp → fsync → atomic rename. A mid-write crash leaves
 * the prior file (or nothing) — never a half-written artifact. Identical to the
 * helper in concept-artifact-writeback.mjs.
 */
function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function serializeManifest(manifest) {
  // Deterministic serialization so a re-run with identical content is byte-identical.
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Land ONE generated subsystem shard + its manifest sidecar on disk,
 * idempotently and atomically.
 *
 * @param {string} projectDir        the plan working directory
 * @param {string} docType           e.g. 'architecture' (the god-doc family)
 * @param {string} shardKey          '§sys:<path>' (the subsystem-extract key)
 * @param {string} md                the shard's generated markdown (no anchors)
 * @param {{ rev?: number, provenance?: string }} [opts]
 * @returns {{ mdPath, sidecarPath, manifest, markdown, shardKey, base }}
 */
export function writeShard(projectDir, docType, shardKey, md, opts = {}) {
  if (!projectDir) throw new Error('writeShard: projectDir is required');
  if (!docType) throw new Error('writeShard: docType is required');
  if (!shardKey) throw new Error('writeShard: shardKey is required');
  const rev = Number.isFinite(opts.rev) ? opts.rev : 0;

  const { markdown, manifest } = generateSectionManifest(md ?? '', { artifact: docType, rev });
  // Stamp shard identity + provenance onto the manifest so the assembler + graph
  // ingest can key on it without re-parsing the filename.
  manifest.shardKey = shardKey;
  if (opts.provenance) manifest.provenance = opts.provenance;

  const dir = join(projectDir, docType, 'shards');
  ensureDir(dir);

  const base = shardFileBase(shardKey);
  const mdPath = join(dir, `${base}.md`);
  const sidecarPath = join(dir, `${base}.sections.json`);

  atomicWrite(mdPath, markdown);
  atomicWrite(sidecarPath, serializeManifest(manifest));

  return { mdPath, sidecarPath, manifest, markdown, shardKey, base };
}

/**
 * Land the assembled whole-document PROJECTION (from `doc-assembler.mjs`) on
 * disk. The projection `.md` already carries `<!--§<shardKey>-->` anchors (ids
 * === shard keys), and `sectionsJson` is its manifest; we write both atomically.
 *
 * @param {string} projectDir
 * @param {string} docType
 * @param {{ md: string, sectionsJson: object }} projection
 * @param {{ rev?: number, provenance?: string }} [opts]
 * @returns {{ mdPath, sidecarPath, manifest, markdown }}
 */
export function writeProjection(projectDir, docType, projection, opts = {}) {
  if (!projectDir) throw new Error('writeProjection: projectDir is required');
  if (!docType) throw new Error('writeProjection: docType is required');
  if (!projection || typeof projection.md !== 'string') {
    throw new Error('writeProjection: projection.md is required');
  }
  const manifest = { ...(projection.sectionsJson || {}) };
  if (Number.isFinite(opts.rev)) manifest.rev = opts.rev;
  if (opts.provenance) manifest.provenance = opts.provenance;
  // Keep the manifest's contentHash honest against the bytes we actually write.
  manifest.contentHash = contentHash(projection.md);

  const dir = join(projectDir, docType);
  ensureDir(dir);

  const mdPath = join(dir, `${docType}.md`);
  const sidecarPath = join(dir, `${docType}.sections.json`);

  atomicWrite(mdPath, projection.md);
  atomicWrite(sidecarPath, serializeManifest(manifest));

  return { mdPath, sidecarPath, manifest, markdown: projection.md };
}
