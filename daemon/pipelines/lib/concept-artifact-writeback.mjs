// @ts-nocheck
/**
 * Concept v2 (E1.2 / W1) — daemon-side artifact write-back.
 *
 * When an autopilot generator (prd-gen / ux-gen / arch-gen) or an interactive
 * convergence Approve produces a markdown document, the daemon must land it on
 * disk as the ARTIFACT OF RECORD: `concept/<kind>.md` plus its
 * `<kind>.sections.json` manifest sidecar, with a `<!--§id-->` anchor above
 * every ATX heading. The `.md` (not a job variable) is the source of truth —
 * this sidesteps the ~400KB `stripTransientVars` DDB cap and gives the apply
 * service (E1.3) a stable, re-readable file to register against.
 *
 * This file REIMPLEMENTS the locked section-manifest contract from
 * `functions/shared/concept/section-manifest.ts` because a daemon `.mjs` cannot
 * import the `.ts` at runtime (same constraint as the inline `resolveSection` in
 * `story-context-pack.mjs`). The reimplementation is kept byte-identical to the
 * TS by the shared-fixture parity test in `__tests__/concept-manifest-parity.test.mjs`
 * — a slugifier/contentHash divergence is caught the same wave it is introduced.
 *
 * See `docs/concepts/pipeline-v2/concept-doc-engine-epics.md` Story 1.2.
 */

import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The on-disk home for concept artifacts, relative to a plan's projectDir. */
export const CONCEPT_DIR_REL = 'concept';

// MUST stay byte-identical to section-manifest.ts (parity test enforces).
const ANCHOR_RE = /^<!--§([a-z0-9][a-z0-9-]*)-->$/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

/** Stable kebab-case slug from a heading title. Mirror of the TS slugifyHeading. */
export function slugifyHeading(title) {
  const base = String(title)
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'section';
}

function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pipeline v3 (E1-S2) — deterministically extract the PRD's functional-
 * requirement ids from its markdown. The PRD prompt numbers them `FR1.`,
 * `FR2.`, … under `## Functional Requirements` (prd-gen-prompt.ts), so a plain
 * `\bFR\d+\b` scan over the whole document is sufficient and order/dup-stable.
 * Returns a unique, NUMERICALLY-sorted list (FR2 before FR10) — the gate only
 * uses it for set membership, but a stable order keeps the persisted plan row
 * diff-friendly. Mirror of the TS `extractRequirementIds`; the shared-fixture
 * parity test guards against divergence.
 *
 * @param {string} markdown  the raw PRD markdown
 * @returns {string[]}
 */
export function extractRequirementIds(markdown) {
  const matches = String(markdown ?? '').match(/\bFR\d+\b/g) ?? [];
  const unique = [...new Set(matches)];
  return unique.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/**
 * Mirror of TS `generateSectionManifest`: inject a `<!--§id-->` anchor above
 * every ATX heading (deduping collided slugs), compute 1-based inclusive line
 * ranges, and hash the ANNOTATED markdown. Returns `{ markdown, manifest }`.
 */
export function generateSectionManifest(rawMarkdown, opts) {
  const inLines = String(rawMarkdown).split('\n');
  const outLines = [];
  const seen = new Set();
  const pending = []; // { id, title, anchorLine }
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
  const sections = pending.map((p, i) => ({
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

/**
 * Two-phase atomic write: write to a sibling tmp file, fsync the bytes to disk,
 * then atomically rename over the target. A mid-write crash leaves the prior
 * file (or nothing) — never a half-written artifact.
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

/**
 * Land a generated markdown artifact + its manifest sidecar on disk,
 * idempotently and atomically.
 *
 * @param {string} projectDir  the plan's working directory
 * @param {'prd'|'ux'|'architecture'} kind
 * @param {string} rawMd  the generator's raw markdown (no anchors)
 * @param {{ rev: number }} opts
 * @returns {{ mdPath: string, sidecarPath: string, manifest: object, markdown: string }}
 */
export function writeConceptArtifact(projectDir, kind, rawMd, opts) {
  if (!projectDir) throw new Error('writeConceptArtifact: projectDir is required');
  if (!kind) throw new Error('writeConceptArtifact: kind is required');
  const rev = opts && Number.isFinite(opts.rev) ? opts.rev : 0;

  const { markdown, manifest } = generateSectionManifest(rawMd ?? '', { artifact: kind, rev });

  const dir = join(projectDir, CONCEPT_DIR_REL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const mdPath = join(dir, `${kind}.md`);
  const sidecarPath = join(dir, `${kind}.sections.json`);

  // Deterministic serialization so a re-run with identical content is byte-identical.
  const sidecar = JSON.stringify(manifest, null, 2) + '\n';

  atomicWrite(mdPath, markdown);
  atomicWrite(sidecarPath, sidecar);

  return { mdPath, sidecarPath, manifest, markdown };
}
