/**
 * Agentic Document Center (E4.2) — the god-doc assembler.
 *
 * Concatenates the per-subsystem SHARDS (each `{ shardKey, md }`) into one
 * projection — the assembled god doc — with a `<!--§<shardKey>-->` anchor above
 * each shard's content. The anchor id IS the shardKey, so the projection's
 * section manifest joins byte-exactly with `subsystem-extract`'s docShard nodes
 * (godDoc CONTAINS docShard ≡ projection section).
 *
 * Ordering is the STABLE containment-backbone order: shards are emitted in
 * ascending shardKey order (which, because shardKeys are the `/`→`--`-encoded
 * boundary paths, is the same lexical order the directory partition produces).
 * Determinism contract: the SAME shard set in → byte-identical projection out,
 * and an UNCHANGED shard's bytes are reproduced verbatim (no re-wrapping, no
 * re-slugging) so a single changed shard never perturbs its neighbors' bytes.
 *
 * Pure — no I/O. The caller (`processDocumentFacts` / a compile pipeline) reads
 * each shard's `.md` off disk, passes them here, and writes the result via
 * `doc-shard-writer.writeProjection`.
 */

import { createHash } from 'node:crypto';

/** `sha256:<hex>` over the projection markdown. Mirror of section-manifest.ts. */
function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A shard's anchor line — the projection section id is the shardKey itself. */
function anchorFor(shardKey) {
  return `<!--§${shardKey}-->`;
}

/**
 * Assemble shards into a god-doc projection.
 *
 * @param {Array<{ shardKey: string, md: string, title?: string }>} shards
 * @param {{ heading?: string }} [opts]  optional top-of-doc H1 (default none)
 * @returns {{ md: string, sectionsJson: object }}
 *   - md: the projection markdown with `<!--§shardKey-->` anchors
 *   - sectionsJson: a section manifest whose section ids === shard keys, with
 *     1-based inclusive line ranges and a contentHash over `md`.
 */
export function assembleProjection(shards, opts = {}) {
  const list = Array.isArray(shards) ? shards.filter((s) => s && s.shardKey) : [];
  // Stable containment-backbone order: ascending shardKey.
  list.sort((a, b) => String(a.shardKey).localeCompare(String(b.shardKey)));

  const outLines = [];
  const pending = []; // { id, title, anchorLine (1-based) }

  if (opts.heading) {
    outLines.push(`# ${opts.heading}`);
    outLines.push('');
  }

  for (const shard of list) {
    outLines.push(anchorFor(shard.shardKey));
    const anchorLine = outLines.length; // 1-based: the anchor line just pushed
    // Reproduce the shard body VERBATIM — byte-for-byte, no transformation — so
    // an unchanged shard contributes identical bytes regardless of its neighbors.
    const body = String(shard.md ?? '');
    // Split preserving the body exactly; a trailing newline in the body becomes
    // its own empty line, which the next anchor follows. We DON'T trim so the
    // round-trip is lossless.
    for (const line of body.split('\n')) outLines.push(line);
    // One blank separator line between shards (stable, part of the contract).
    outLines.push('');
    pending.push({ id: shard.shardKey, title: shard.title || shard.shardKey, anchorLine });
  }

  // Drop the final trailing separator so re-assembly is idempotent.
  if (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();

  const md = outLines.join('\n');

  const sections = pending.map((p, i) => ({
    id: p.id,
    title: p.title,
    lineStart: p.anchorLine,
    lineEnd: i + 1 < pending.length ? pending[i + 1].anchorLine - 1 : outLines.length,
  }));

  return {
    md,
    sectionsJson: {
      artifact: 'godDoc',
      rev: 0,
      contentHash: sha256(md),
      shardKeys: list.map((s) => s.shardKey),
      sections,
    },
  };
}
