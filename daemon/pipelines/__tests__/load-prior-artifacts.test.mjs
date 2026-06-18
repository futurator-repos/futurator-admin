import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPriorArtifacts,
  loadCitableSections,
  conceptKindForStepId,
} from '../lib/story-context-pack.mjs';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'prior-artifacts-'));
  mkdirSync(join(dir, 'concept'), { recursive: true });
  return dir;
}
function writeDoc(dir, kind, body) {
  writeFileSync(join(dir, 'concept', `${kind}.md`), body, 'utf8');
}
function writeSidecar(dir, kind, ids) {
  const manifest = { artifact: kind, rev: 1, contentHash: `sha256:${kind}`, sections: ids.map((id) => ({ id, title: id, lineStart: 1, lineEnd: 2 })) };
  writeFileSync(join(dir, 'concept', `${kind}.sections.json`), JSON.stringify(manifest), 'utf8');
}

describe('conceptKindForStepId (Story 3.2a)', () => {
  it('maps generator step ids to kinds', () => {
    expect(conceptKindForStepId('prd-gen')).toBe('prd');
    expect(conceptKindForStepId('ux-gen')).toBe('ux');
    expect(conceptKindForStepId('arch-gen')).toBe('architecture');
    expect(conceptKindForStepId('something-else')).toBeNull();
  });
});

describe('loadPriorArtifacts (Story 3.2a — daemon fills {{PRIOR_ARTIFACTS}})', () => {
  it('ux-gen inlines the PRD body only', () => {
    const dir = project();
    try {
      writeDoc(dir, 'prd', '# PRD\n\nThe product does X.');
      const out = loadPriorArtifacts(dir, 'ux');
      expect(out).toContain('PRD (approved upstream');
      expect(out).toContain('The product does X.');
      expect(out).not.toContain('UX Specification');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arch-gen inlines PRD + UX bodies in chain order', () => {
    const dir = project();
    try {
      writeDoc(dir, 'prd', '# PRD\n\nscope text');
      writeDoc(dir, 'ux', '# UX\n\njourney text');
      const out = loadPriorArtifacts(dir, 'architecture');
      expect(out.indexOf('scope text')).toBeLessThan(out.indexOf('journey text'));
      expect(out).toContain('PRD (approved upstream');
      expect(out).toContain('UX Specification (approved upstream');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-UI arch-gen (no ux.md on disk) inlines PRD only', () => {
    const dir = project();
    try {
      writeDoc(dir, 'prd', '# PRD\n\nbackend scope');
      const out = loadPriorArtifacts(dir, 'architecture');
      expect(out).toContain('backend scope');
      expect(out).not.toContain('UX Specification');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prd-gen (chain head) has no upstream → skeleton instruction', () => {
    const dir = project();
    try {
      expect(loadPriorArtifacts(dir, 'prd')).toMatch(/No approved upstream/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing upstream docs → defensive skeleton, never throws', () => {
    const dir = project();
    try {
      expect(loadPriorArtifacts(dir, 'architecture')).toMatch(/No approved upstream/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadCitableSections (Story 5.2 — fills {{CITABLE_SECTIONS}})', () => {
  it('returns only present sources with their closed-set ids (sorted source keys)', () => {
    const dir = project();
    try {
      writeSidecar(dir, 'prd', ['fr-3', 'fr-4']);
      writeSidecar(dir, 'architecture', ['state-model']);
      // ux absent
      const out = loadCitableSections(dir);
      expect(out).toContain('prd: fr-3, fr-4');
      expect(out).toContain('architecture: state-model');
      expect(out).not.toContain('ux:');
      // sorted source keys → architecture before prd
      expect(out.indexOf('architecture:')).toBeLessThan(out.indexOf('prd:'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no manifests (prototype/legacy) → defer-references instruction', () => {
    const dir = project();
    try {
      expect(loadCitableSections(dir)).toMatch(/do NOT emit references/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
