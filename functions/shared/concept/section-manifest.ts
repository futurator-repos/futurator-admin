import { createHash } from 'node:crypto';

/**
 * Concept v2 (E4.1 / W2) — the LOCKED, shared section-manifest format.
 *
 * Every `prd-gen` / `ux-gen` / `arch-gen` job emits, alongside `<artifact>.md`,
 * a `<artifact>.sections.json` sidecar and mirrors each section `id` as an
 * `<!--§id-->` HTML-comment anchor immediately above its heading. A story's
 * `references[].section` must be a member of `manifest.ids`, and the Story
 * Context Pack inlines the cited section by deterministic line-range slice
 * (no regex). This same format is read by VQA v3's probe compiler (their H9).
 *
 * See `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` §6.2.
 */

export type ArtifactKind = 'prd' | 'architecture' | 'ux';

export interface SectionEntry {
  id: string; // stable slug, immutable across revs where the section persists
  title: string; // heading text
  lineStart: number; // 1-based — the `<!--§id-->` anchor line
  lineEnd: number; // 1-based, inclusive — line before the next anchor (or EOF)
}

export interface SectionManifest {
  artifact: ArtifactKind;
  rev: number; // W1 binding — manifest is tied to one artifact rev
  contentHash: string; // `sha256:…` of the annotated markdown
  sections: SectionEntry[];
}

const ANCHOR_RE = /^<!--§([a-z0-9][a-z0-9-]*)-->$/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

/** Stable kebab-case slug from a heading title. */
export function slugifyHeading(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Generator helper: take raw markdown (ATX headings, no anchors), inject a
 * `<!--§id-->` anchor above every heading (deduping collided slugs), and return
 * the annotated markdown plus its manifest. The generator writes both files.
 */
export function generateSectionManifest(
  rawMarkdown: string,
  opts: { artifact: ArtifactKind; rev: number },
): { markdown: string; manifest: SectionManifest } {
  const inLines = rawMarkdown.split('\n');
  const outLines: string[] = [];
  const seen = new Set<string>();
  // First pass: emit annotated lines, remembering each section's anchor line + title.
  const pending: Array<{ id: string; title: string; anchorLine: number }> = [];
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
      pending.push({ id, title: h[1], anchorLine: outLines.length }); // 1-based
      outLines.push(line);
    } else {
      outLines.push(line);
    }
  }
  const markdown = outLines.join('\n');
  // Second pass: line ranges — each section runs to the line before the next anchor.
  const sections: SectionEntry[] = pending.map((p, i) => ({
    id: p.id,
    title: p.title,
    lineStart: p.anchorLine,
    lineEnd: i + 1 < pending.length ? pending[i + 1].anchorLine - 1 : outLines.length,
  }));
  return {
    markdown,
    manifest: { artifact: opts.artifact, rev: opts.rev, contentHash: sha256(markdown), sections },
  };
}

/** All section ids — the closed set a `references[].section` must belong to. */
export function sectionIds(manifest: SectionManifest): string[] {
  return manifest.sections.map((s) => s.id);
}

/** Set-membership predicate used at decompose (E4.2) and the gate (E9.3). */
export function hasSection(manifest: SectionManifest, id: string): boolean {
  return manifest.sections.some((s) => s.id === id);
}

/**
 * Resolve a cited section to its markdown slice — deterministic line-range, NO
 * regex. Returns null when the id is unknown. This is what the Story Context
 * Pack inlines so the DEV agent reads the contract, not a path (W3 floor).
 */
export function resolveSection(
  markdown: string,
  manifest: SectionManifest,
  id: string,
): string | null {
  const entry = manifest.sections.find((s) => s.id === id);
  if (!entry) return null;
  const lines = markdown.split('\n');
  // 1-based inclusive [lineStart, lineEnd].
  return lines.slice(entry.lineStart - 1, entry.lineEnd).join('\n');
}
