import type { Plan } from '../types/plan';
import type { ArtifactKind, SectionManifest } from '../concept/section-manifest';
import { generateSectionManifest, sectionIds } from '../concept/section-manifest';
import {
  applyEdit,
  staleCascade,
  type ConceptArtifact,
  type ArtifactStatus,
} from '../concept/artifact-version';

/**
 * Concept v2 (E1.3 / W1) — the generic apply-service for a generated artifact.
 *
 * A sibling of `concept-route-service.ts`: an idempotent parse→validate→persist
 * funnel that registers a generated `prd`/`ux`/`architecture` document onto the
 * Plan row's `conceptArtifacts[]` version registry (E1.1). It does NOT decide
 * applicability (the Router did, E7.1) and does NOT approve (autopilot
 * auto-approve and interactive Approve are owned by E3/E4) — it only advances
 * the matching `ConceptArtifact` row's `rev`/`contentHash`/`status` when fresh
 * content lands, running the W1 stale cascade so any already-approved dependent
 * flips `stale`.
 *
 * The markdown is prose, not JSON — there is no Zod schema. Validation is:
 * non-empty + the section manifest builds with ≥1 section.
 *
 * CONTENT-HASH PARITY: the registered `contentHash` MUST equal the on-disk
 * artifact of record (Story 1.2 wrote `<kind>.md` + `<kind>.sections.json`). The
 * manifest's `contentHash` is computed over the ANNOTATED markdown, so callers
 * must hand this service EITHER the on-disk sidecar manifest (canonical — never
 * re-annotated) OR the RAW generator markdown (annotated exactly once here, byte
 * -identical to the daemon's write-back). Never feed it already-annotated md, or
 * the double-anchored hash would diverge from disk.
 */

export interface ConceptArtifactApplyDeps {
  updatePlanFields: (planId: string, patch: Partial<Plan>) => Promise<void>;
}

/** What the caller hands the service: a prebuilt manifest (preferred) or raw markdown. */
export type ArtifactSource =
  | { manifest: SectionManifest; rawMarkdown?: never }
  | { rawMarkdown: string; manifest?: never };

export interface ApplyArtifactResult {
  kind: ArtifactKind;
  rev: number;
  contentHash: string;
  status: ArtifactStatus;
  /** false when the apply was a no-op (replay / identical content) — cron-safe. */
  changed: boolean;
}

/**
 * Resolve the source into a validated manifest. Throws on empty / no-sections.
 * - `manifest` path: trust the on-disk sidecar's contentHash verbatim.
 * - `rawMarkdown` path: build the manifest once (annotate raw), matching the
 *   daemon write-back byte-for-byte.
 */
function resolveManifest(kind: ArtifactKind, source: ArtifactSource): SectionManifest {
  if (source.manifest) {
    const m = source.manifest;
    if (!m.contentHash || !Array.isArray(m.sections) || m.sections.length === 0) {
      throw new Error(`${kind} manifest is empty — no sections to register.`);
    }
    return m;
  }
  const raw = source.rawMarkdown ?? '';
  if (!raw.trim()) {
    throw new Error(`${kind} markdown is empty — generator produced no document.`);
  }
  const { manifest } = generateSectionManifest(raw, { artifact: kind, rev: 0 });
  if (sectionIds(manifest).length === 0) {
    throw new Error(`${kind} markdown has no ATX headings — manifest would be empty.`);
  }
  return manifest;
}

/**
 * Register the generated artifact onto `plan.conceptArtifacts`, idempotently.
 *
 * - First landing of a seeded `rev:0` row → bumps to `rev:1`, `status:'draft'`,
 *   sets `contentHash`, runs `staleCascade`.
 * - Re-apply with IDENTICAL content (same `contentHash`, `rev>0`) → no-op (no
 *   double rev bump, status untouched) — the cron/daemon can replay freely.
 * - Re-apply with NEW content (regenerate) → bumps rev again + cascade.
 * - Missing row (legacy/defensive) → appends a `rev:1` draft row + cascade.
 *
 * Never records approval. The conditional `updatePlanFields` (skipped on no-op)
 * keeps replay free of writes.
 */
export async function applyConceptArtifactOutput(
  plan: Pick<Plan, 'planId' | 'conceptArtifacts'>,
  kind: ArtifactKind,
  source: ArtifactSource,
  deps: ConceptArtifactApplyDeps,
): Promise<ApplyArtifactResult> {
  const manifest = resolveManifest(kind, source);
  const newHash = manifest.contentHash;

  const registry: ConceptArtifact[] = (plan.conceptArtifacts ?? []).map((a) => ({ ...a }));
  const existing = registry.find((a) => a.kind === kind);

  // Idempotent: identical content already registered → no write, no rev bump.
  if (existing && existing.rev > 0 && existing.contentHash === newHash) {
    return {
      kind,
      rev: existing.rev,
      contentHash: existing.contentHash,
      status: existing.status,
      changed: false,
    };
  }

  let next: ConceptArtifact[];
  if (existing) {
    // applyEdit bumps rev, sets the new hash, resets status→draft, runs cascade.
    next = applyEdit(registry, kind, newHash);
  } else {
    // Defensive: no seeded row (legacy plan / out-of-band gen). Append + cascade.
    const appended: ConceptArtifact = {
      kind,
      rev: 1,
      contentHash: newHash,
      status: 'draft',
      dependsOn: [],
    };
    next = staleCascade([...registry, appended]);
  }

  await deps.updatePlanFields(plan.planId, { conceptArtifacts: next });

  const updated = next.find((a) => a.kind === kind)!;
  return {
    kind,
    rev: updated.rev,
    contentHash: updated.contentHash,
    status: updated.status,
    changed: true,
  };
}
