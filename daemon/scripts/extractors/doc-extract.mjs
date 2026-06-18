#!/usr/bin/env node
/**
 * Concept v2 (E6 / Story 6.1 + 6.3 doc↔doc) — the concept-docs extractor.
 *
 * Deterministic, zero-LLM. Reads `<root>/concept/<kind>.md` + `<kind>.sections.json`
 * for kind ∈ {prd, ux, architecture} and emits, per present doc:
 *   • 1 `document`   node — nodeId `doc/<type>/<slug>`
 *   • N `docSection` nodes — nodeId `docSection/<type>/<slug>/<sectionId>`,
 *     carrying the sidecar `contentHash` (the W4-class join key the rest of the
 *     chain — references[], stale-cascade — keys on; NEVER re-derive section ids
 *     from headings, read the sidecar as source of truth).
 *   • DERIVED_FROM edges along the canonical spec chain (architecture → prd, ux;
 *     ux → prd) among the docs that ACTUALLY exist on disk — a non-UI plan has
 *     no ux.md, so no ux node and no ux lineage edge. Lineage comes from the
 *     chain semantics, never from file/listing order.
 *
 * No `concept/` dir (prototype) → emptyEnvelope (nodeCount 0, exit 0).
 * NEVER emits a `readiness` node (it is a gate verdict, not a citable spec, and
 * is not an ArtifactKind).
 *
 * The story→docSection REFERENCES edges and the doc→code GOVERNS/DESCRIBES edges
 * (Stories 6.3-refs / 6.4) need the epic tree + a graph session, so they are
 * derived in `processDocumentFacts` (Story 6.5), not in this stateless pass.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildEnvelope, emptyEnvelope, writeEnvelope } from '../lib/extractor-envelope.mjs';

export const DOC_KINDS = ['prd', 'ux', 'architecture'];
// Canonical spec-chain dependencies (downstream → upstreams) among present docs.
const CHAIN_DEPS = {
  architecture: ['prd', 'ux'],
  ux: ['prd'],
  prd: [],
};

function readFileIfExists(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function slugOf(root) {
  return basename(root.replace(/\/+$/, '')) || 'project';
}

function docNodeId(kind, slug) {
  return `doc/${kind}/${slug}`;
}
function sectionNodeId(kind, slug, sectionId) {
  return `docSection/${kind}/${slug}/${sectionId}`;
}

/**
 * Build the document/docSection nodes + DERIVED_FROM edges for a project dir.
 * Pure (no I/O beyond reading the concept dir) and testable.
 *
 * @param {string} root  the plan working dir
 * @returns {{ nodes: any[], edges: any[], present: string[] }}
 */
export function extractConceptDocs(root) {
  const slug = slugOf(root);
  const conceptDir = join(root, 'concept');
  const nodes = [];
  const edges = [];
  const present = [];

  for (const kind of DOC_KINDS) {
    const md = readFileIfExists(join(conceptDir, `${kind}.md`));
    const sidecarRaw = readFileIfExists(join(conceptDir, `${kind}.sections.json`));
    if (!md || !sidecarRaw) continue;
    let manifest;
    try {
      manifest = JSON.parse(sidecarRaw);
    } catch {
      continue;
    }
    const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
    present.push(kind);

    nodes.push({
      nodeId: docNodeId(kind, slug),
      kind: 'document',
      label: kind,
      docType: kind,
      rev: manifest.rev,
      contentHash: manifest.contentHash,
      sectionCount: sections.length,
      projectId: slug,
    });

    for (const s of sections) {
      if (!s || !s.id) continue;
      nodes.push({
        nodeId: sectionNodeId(kind, slug, s.id),
        kind: 'docSection',
        label: s.title || s.id,
        docType: kind,
        sectionId: s.id,
        contentHash: manifest.contentHash,
        projectId: slug,
      });
    }
  }

  // DERIVED_FROM lineage among the docs that exist (chain semantics, not order).
  const presentSet = new Set(present);
  for (const kind of present) {
    for (const dep of CHAIN_DEPS[kind] ?? []) {
      if (!presentSet.has(dep)) continue;
      edges.push({
        type: 'DERIVED_FROM',
        source: docNodeId(kind, slug),
        target: docNodeId(dep, slug),
        provenance: 'EXTRACTED',
      });
    }
  }

  return { nodes, edges, present };
}

export async function main(argv = process.argv) {
  const root = argv[2] || process.cwd();
  if (!existsSync(join(root, 'concept'))) {
    writeEnvelope(emptyEnvelope({ root, extra: { extractor: 'doc-extract', skipped: 'no concept dir' } }));
    return;
  }
  const { nodes, edges } = extractConceptDocs(root);
  writeEnvelope(buildEnvelope({ root, nodes, edges, extra: { extractor: 'doc-extract' } }));
}

// Run as a CLI when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[doc-extract] ${err.message}`);
    process.exit(1);
  });
}
