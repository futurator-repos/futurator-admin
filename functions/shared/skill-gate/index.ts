/**
 * skill-gate/index.ts — Skills Institution, Story 2.3. The one gate.
 *
 * Every skill — authored by a reflection, hand-written, pasted from a URL, or
 * bulk-acquired — converges on ONE pipeline before a human ever sees it:
 *
 *     merge → scan → label → version → emit proposal
 *
 * Building it once means the security + labeling guarantees can't be bypassed by
 * adding a new entry path: a new source just writes an adapter that produces a
 * `GateInput`. The gate returns a `SkillProposal` ready to persist into the
 * Inbox (Story 3.1); it does NOT write to DynamoDB or GitHub itself (the route
 * persists; ratify publishes) — so it stays pure and unit-testable.
 *
 * A Gate-1 (deterministic scanner) failure does not throw: the proposal is
 * emitted with `status: 'quarantined'` and the scan report attached, so the
 * operator can see exactly what tripped and override if it's a false positive.
 */

import { randomUUID } from 'node:crypto';
import { buildSkillMd } from '../skill-authoring';
import { scanSkill, type BundledScript, type ScanOptions } from './security-scan';
import { labelProposal } from './labeling';
import type {
  SkillIndexEntry,
  ProvenanceClass,
  SkillLineage,
} from '../schemas/skill-index-entry-schema';
import type { SkillProposal, ProposalSource } from '../schemas/skill-proposal-schema';

/** The normalized input every entry adapter produces. */
export interface GateInput {
  source: ProposalSource;
  skillName: string;
  description: string;
  /** The prose body (without frontmatter — the gate re-fences it canonically). */
  body: string;
  kind?: string;
  license?: string;
  scripts?: BundledScript[];
  /** Override the source-inferred provenance class. */
  provenanceClass?: ProvenanceClass;
  /** Partial lineage (e.g. graduatedFrom for a reflect-graduate). */
  lineage?: Partial<SkillLineage>;
}

export interface GateOptions {
  scan?: ScanOptions;
  /** Inject for deterministic tests. */
  idFactory?: () => string;
  now?: () => Date;
}

/** ULID-shape monotonic id (mirrors reflections-service.nextId). */
function defaultId(now: () => Date): string {
  const ts = now()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 14);
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

/** One-line gist for the inbox row: first non-empty prose line, truncated. */
function deriveGist(description: string, body: string): string {
  const fromDesc = description.trim();
  if (fromDesc) return fromDesc.length > 140 ? `${fromDesc.slice(0, 140)}…` : fromDesc;
  const firstLine = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  const g = firstLine ?? '';
  return g.length > 140 ? `${g.slice(0, 140)}…` : g;
}

/**
 * Run a candidate through the gate and emit a ready-to-persist proposal.
 *
 * Steps:
 *  1. merge   — normalize body into the canonical SKILL.md shape.
 *  2. scan    — Gate-1 deterministic scanner over body + bundled scripts.
 *  3. label   — system-owned facets (trustTier always `draft`).
 *  4. version — stamp `version` + lineage onto the proposed index entry.
 *  5. emit    — assemble the SkillProposal (status quarantined iff scan blocked).
 */
export function runGate(input: GateInput, opts: GateOptions = {}): SkillProposal {
  const now = opts.now ?? (() => new Date());
  const idFactory = opts.idFactory ?? (() => defaultId(now));

  // 1. merge — canonical body shape (frontmatter is re-emitted by buildSkillMd).
  const mergedMd = buildSkillMd({
    name: input.skillName,
    description: input.description,
    body: input.body,
  });

  // 2. scan
  const scan = scanSkill({ body: input.body, scripts: input.scripts }, opts.scan);

  // 3. label
  const labels = labelProposal({
    source: input.source,
    securityStatus: scan.securityStatus,
    provenanceClass: input.provenanceClass,
    lineage: input.lineage,
  });

  // 4. version — stamp the proposed index entry.
  const proposedEntry: SkillIndexEntry = {
    name: input.skillName,
    kind: input.kind ?? 'core',
    framework: false,
    version: 'sha:HEAD',
    license: input.license ?? 'UNKNOWN',
    description: input.description,
    provenanceClass: labels.provenanceClass,
    securityStatus: labels.securityStatus,
    qualityGrade: labels.qualityGrade,
    trustTier: labels.trustTier,
    maturity: labels.maturity,
    lineage: labels.lineage,
  };

  // 5. emit — quarantined proposals are surfaced but not ratifiable w/o override.
  const blocked = scan.securityStatus === 'quarantined';
  return {
    proposalId: idFactory(),
    source: input.source,
    skillName: input.skillName,
    kind: input.kind ?? 'core',
    proposedBody: mergedMd,
    proposedEntry,
    gist: deriveGist(input.description, input.body),
    securityStatus: labels.securityStatus,
    scanReport: scan,
    qualityGrade: labels.qualityGrade,
    status: blocked ? 'quarantined' : 'pending',
    createdAt: now().toISOString(),
    lineage: labels.lineage,
  };
}

// ── Entry adapters ──────────────────────────────────────────────────────────
// Thin source-specific normalizers. Each produces a GateInput then defers to
// runGate, so the security + labeling path is identical for every source.

/** Reflect-graduate: a confirmed app reflection promoted to a global skill (FR1). */
export function fromReflection(
  args: {
    skillName: string;
    description: string;
    content: string;
    /** The app/plan slug the lesson came from (lineage.graduatedFrom). */
    graduatedFrom: string;
    adaptedFrom?: string;
    kind?: string;
  },
  opts?: GateOptions,
): SkillProposal {
  return runGate(
    {
      source: 'reflect-graduate',
      skillName: args.skillName,
      description: args.description,
      body: args.content,
      kind: args.kind,
      lineage: { graduatedFrom: args.graduatedFrom, adaptedFrom: args.adaptedFrom ?? null },
    },
    opts,
  );
}

/** Create: operator hand-authored a skill (FR8 / Story 3.4). */
export function fromCreate(
  args: {
    skillName: string;
    description: string;
    body: string;
    kind?: string;
    license?: string;
  },
  opts?: GateOptions,
): SkillProposal {
  return runGate({ source: 'create', ...args }, opts);
}

/** Paste-URL: operator pasted a URL, already extracted to SKILL.md parts (Story 3.4). */
export function fromPasteUrl(
  args: {
    skillName: string;
    description: string;
    body: string;
    sourceUrl: string;
    kind?: string;
    license?: string;
  },
  opts?: GateOptions,
): SkillProposal {
  return runGate(
    {
      source: 'paste-url',
      skillName: args.skillName,
      description: args.description,
      body: args.body,
      kind: args.kind,
      license: args.license,
      lineage: { adaptedFrom: args.sourceUrl },
    },
    opts,
  );
}
