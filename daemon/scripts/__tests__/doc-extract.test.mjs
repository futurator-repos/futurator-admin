import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { extractConceptDocs } from '../extractors/doc-extract.mjs';

function project() {
  return mkdtempSync(join(tmpdir(), 'doc-extract-'));
}
function writeArtifact(root, kind, sectionIds, hash = `sha256:${kind}`) {
  mkdirSync(join(root, 'concept'), { recursive: true });
  writeFileSync(join(root, 'concept', `${kind}.md`), `# ${kind}\n\nbody`, 'utf8');
  writeFileSync(
    join(root, 'concept', `${kind}.sections.json`),
    JSON.stringify({
      artifact: kind,
      rev: 1,
      contentHash: hash,
      sections: sectionIds.map((id) => ({ id, title: id, lineStart: 1, lineEnd: 2 })),
    }),
    'utf8',
  );
}

describe('doc-extract (Story 6.1 — document + docSection nodes)', () => {
  it('emits 1 document + N docSection nodes; every section id from the sidecar', () => {
    const root = project();
    try {
      writeArtifact(root, 'prd', ['fr-1', 'fr-2', 'goals']);
      const { nodes } = extractConceptDocs(root);
      const slug = basename(root);
      const docs = nodes.filter((n) => n.kind === 'document');
      const secs = nodes.filter((n) => n.kind === 'docSection');
      expect(docs).toHaveLength(1);
      expect(docs[0].nodeId).toBe(`doc/prd/${slug}`);
      expect(secs).toHaveLength(3);
      expect(secs.map((s) => s.sectionId).sort()).toEqual(['fr-1', 'fr-2', 'goals']);
      // contentHash propagates from the sidecar (the join key).
      expect(secs.every((s) => s.contentHash === 'sha256:prd')).toBe(true);
      expect(secs[0].nodeId).toBe(`docSection/prd/${slug}/fr-1`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a deduped section id (goals-2) carries through verbatim', () => {
    const root = project();
    try {
      writeArtifact(root, 'prd', ['goals', 'goals-2']);
      const { nodes } = extractConceptDocs(root);
      const ids = nodes.filter((n) => n.kind === 'docSection').map((s) => s.sectionId);
      expect(ids).toContain('goals-2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no concept dir → no nodes (prototype path)', () => {
    const root = project();
    try {
      const { nodes, edges } = extractConceptDocs(root);
      expect(nodes).toHaveLength(0);
      expect(edges).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never emits a readiness node', () => {
    const root = project();
    try {
      writeArtifact(root, 'prd', ['fr-1']);
      writeArtifact(root, 'architecture', ['decision-summary-table']);
      const { nodes } = extractConceptDocs(root);
      expect(nodes.some((n) => n.docType === 'readiness' || n.nodeId.includes('readiness'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('doc-extract (Story 6.3 — DERIVED_FROM doc↔doc lineage)', () => {
  it('UI chain: architecture DERIVED_FROM prd + ux; ux DERIVED_FROM prd', () => {
    const root = project();
    try {
      writeArtifact(root, 'prd', ['fr-1']);
      writeArtifact(root, 'ux', ['journeys']);
      writeArtifact(root, 'architecture', ['state-model']);
      const { edges } = extractConceptDocs(root);
      const slug = basename(root);
      const lineage = edges.filter((e) => e.type === 'DERIVED_FROM').map((e) => `${e.source}→${e.target}`);
      expect(lineage).toContain(`doc/architecture/${slug}→doc/prd/${slug}`);
      expect(lineage).toContain(`doc/architecture/${slug}→doc/ux/${slug}`);
      expect(lineage).toContain(`doc/ux/${slug}→doc/prd/${slug}`);
      expect(edges.every((e) => e.provenance === 'EXTRACTED')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-UI: no ux node, no ux lineage edge', () => {
    const root = project();
    try {
      writeArtifact(root, 'prd', ['fr-1']);
      writeArtifact(root, 'architecture', ['state-model']);
      const { nodes, edges } = extractConceptDocs(root);
      expect(nodes.some((n) => n.docType === 'ux')).toBe(false);
      const lineage = edges.filter((e) => e.type === 'DERIVED_FROM');
      expect(lineage.some((e) => e.target.includes('/ux/'))).toBe(false);
      // architecture still derives from prd.
      const slug = basename(root);
      expect(lineage.map((e) => `${e.source}→${e.target}`)).toContain(
        `doc/architecture/${slug}→doc/prd/${slug}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
