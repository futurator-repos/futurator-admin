// Plan Retrospect — knowledge-graph detector (D-KC1..D-KC6)
//
// Deterministic scorer for the rubric §3.8 "knowledge-compile" criteria. Reads
// the three `knowledge/_graph/` report files (already fetched by the index/repo
// layer into `ctx.graphReports`) plus the separate `.mycelium/ast-facts.json`.
// NO LLM, NO S3 I/O here — the detector is pure over its DetectorContext.
//
// Evidence-source contract (rubric §0.7 / spec §4a CORRECTED graph-read):
//   - orphans.json  {status, orphanCount, byKind}      → D-KC3 (value) / IE17
//   - dead-code.json {nodes[]|count}                   → D-KC3 zombies / IE19
//   - ast-facts.json {fileCount}                       → D-KC2 / IE16
//   - graph-snapshot.json {nodes[], edges[]}           → D-KC5, D-KC6, and the
//       D-KC3 degree-0 FALLBACK when orphans.json is absent.
//
// Honesty guard (spec §4a): any criterion whose evidence is NOT present in the
// DetectorContext emits verdict '⚪', score null, and a
// `[needs-instrumentation: …]` note. We NEVER fabricate a value to avoid ⚪.
//   - D-KC1 (index.md mtime vs last wave-close ts): neither timestamp is in the
//     Lambda inputs → ⚪.
//   - D-KC4 (orphan-invariant SURFACED vs swallowed `exited 3`): the surfaced-
//     vs-swallowed distinction is a DAEMON-LOG fact not present in the Lambda
//     inputs (the report already carries the FAIL `status`; F16 is the fix that
//     surfaces it at the gate). The value can't be derived from reports → ⚪.

import type {
  DetectorContext,
  ScorecardSlice,
  EvidenceRef,
  FixRef,
  GraphSnapshot,
  OrphansReport,
} from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes, ORPHAN_SURFACING_FIX } from '../ie-to-f-map';

// ── slice helpers ────────────────────────────────────────────────────────────

/** Build a fully-populated slice, pulling stage from CRITERIA_META. */
function makeSlice(
  criterionId: string,
  args: {
    score: ScorecardSlice['score'];
    verdict: ScorecardSlice['verdict'];
    value: number | string;
    evidence: EvidenceRef;
    note?: string;
    ieIds?: string[];
    fixIds?: FixRef[];
  },
): ScorecardSlice {
  const meta = CRITERIA_META[criterionId];
  return {
    criterionId,
    stage: meta.stage,
    score: args.score,
    verdict: args.verdict,
    value: args.value,
    evidence: args.evidence,
    ...(args.note ? { note: args.note } : {}),
    ieIds: args.ieIds ?? [],
    fixIds: args.fixIds ?? [],
    engine: 'deterministic',
  };
}

/**
 * Emit a ⚪ needs-instrumentation slice (score null, excluded from the rollup).
 * `missing` describes exactly what input is absent — credibility hinges on this.
 */
function needsInstrumentation(
  criterionId: string,
  missing: string,
  evidence: EvidenceRef,
  links?: { ieIds?: string[]; fixIds?: FixRef[] },
): ScorecardSlice {
  return makeSlice(criterionId, {
    score: null,
    verdict: '⚪',
    value: 'n/a',
    evidence,
    note: `[needs-instrumentation: ${missing}]`,
    ieIds: links?.ieIds,
    fixIds: links?.fixIds,
  });
}

// ── UUID-vs-slug discrimination (D-KC5) ──────────────────────────────────────

/**
 * A node's `projectId` is "UUID-stranded" when it is a bare UUID instead of the
 * canonical slug (rubric §0.6 D-KC5 / IE18). Canonical projectIds are kebab/word
 * slugs (e.g. `pacman3`); a node still carrying a raw UUID never got rewritten to
 * the slug at ingest (the F17 partition-drift bug).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Living-doc node types whose degree-0 floaters D-KC6 flags. */
const LIVING_DOC_TYPES = new Set(['decision', 'system', 'index', 'architecture']);

/**
 * Derive the set of node ids that participate in at least one edge (as source
 * OR target). Used by the D-KC3 orphan fallback and by D-KC6 floater detection.
 */
function connectedNodeIds(snapshot: GraphSnapshot): Set<string> {
  const connected = new Set<string>();
  for (const e of snapshot.edges) {
    if (e.source) connected.add(e.source);
    if (e.target) connected.add(e.target);
  }
  return connected;
}

/**
 * Count degree-0 `code/*` nodes from a snapshot — the FALLBACK for D-KC3 when
 * `orphans.json` is absent (rubric §0.7: "a `code/*` node whose `id` appears in
 * no `snap.edges[].source` and no `snap.edges[].target`").
 */
function deriveCodeOrphanCount(snapshot: GraphSnapshot): number {
  const connected = connectedNodeIds(snapshot);
  let orphans = 0;
  for (const n of snapshot.nodes) {
    const kind = String(n.type ?? '');
    const isCode = kind === 'code' || kind.startsWith('code');
    if (isCode && !connected.has(n.id)) orphans++;
  }
  return orphans;
}

/** Extract a zombie/dead-node count from dead-code.json (count or nodes[].length). */
function deadCodeCount(deadCode: { nodes?: unknown[]; count?: number }): number {
  if (typeof deadCode.count === 'number') return deadCode.count;
  if (Array.isArray(deadCode.nodes)) return deadCode.nodes.length;
  return 0;
}

// ── individual criteria ──────────────────────────────────────────────────────

/**
 * D-KC1 — Knowledge written per story/wave-close.
 * Evidence: `knowledge/index.md` mtime vs last wave-close ts.
 * Neither the index.md mtime nor a wave-close timestamp is present in the Lambda
 * inputs (DetectorContext / graphReports) → ⚪ needs-instrumentation.
 */
function scoreDKC1(): ScorecardSlice {
  return needsInstrumentation(
    'D-KC1',
    'knowledge/index.md mtime + last wave-close ts not in Lambda inputs (no _graph index mtime / wave-close timestamp captured)',
    { kind: 'graph', ref: 'knowledge/index.md#mtime' },
  );
}

/**
 * D-KC2 — AST-facts completeness: persisted facts cover the FULL project, not
 * just the last worktree.
 * Evidence: `.mycelium/ast-facts.json` fileCount ÷ projectSourceFileCount.
 * Thresholds: 🟢 ≥0.95; 🟡 0.5–0.95; 🔴 <0.5. (IE16 → F14)
 */
function scoreDKC2(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'graph', ref: '.mycelium/ast-facts.json#fileCount' };
  const ie = CRITERIA_META['D-KC2'].ieLink; // ['IE16']
  const fixIds = mapIeToFixes('IE16');

  const astFacts = ctx.graphReports?.astFacts;
  const denom = ctx.graphReports?.projectSourceFileCount;

  if (!astFacts || typeof astFacts.fileCount !== 'number') {
    return needsInstrumentation(
      'D-KC2',
      'ast-facts.json absent or has no numeric fileCount',
      evidence,
      { ieIds: ie, fixIds },
    );
  }
  if (typeof denom !== 'number' || denom <= 0) {
    return needsInstrumentation(
      'D-KC2',
      'projectSourceFileCount (independent source-file witness) not available — cannot form coverage ratio',
      evidence,
      { ieIds: ie, fixIds },
    );
  }

  const ratio = astFacts.fileCount / denom;
  const value = Number(ratio.toFixed(4));
  // 🟢 ≥0.95 → 4; 🟡 0.5–0.95 → 2; 🔴 <0.5 → 0.
  if (ratio >= 0.95) {
    return makeSlice('D-KC2', { score: 4, verdict: '🟢', value, evidence, ieIds: [], fixIds: [] });
  }
  if (ratio >= 0.5) {
    return makeSlice('D-KC2', { score: 2, verdict: '🟡', value, evidence, ieIds: ie, fixIds });
  }
  return makeSlice('D-KC2', { score: 0, verdict: '🔴', value, evidence, ieIds: ie, fixIds });
}

/**
 * D-KC3 — Graph orphan rate: code nodes with zero edges at snapshot.
 * Evidence: orphans.json `orphanCount` + `status`; dead-code.json for zombies.
 * Thresholds: 🟢 status=='pass' ∧ orphanCount==0; 🟡 1–5; 🔴 status=='fail' ∨ >5.
 * Fallback: when orphans.json absent, derive degree-0 code nodes from snapshot.
 * (IE17, IE19 → F14, F15, F17)
 */
function scoreDKC3(ctx: DetectorContext): ScorecardSlice {
  const ieMeta = CRITERIA_META['D-KC3'].ieLink; // ['IE17','IE19']
  // Reconciled fixes: union of IE17 + IE19 maps (deduped on id).
  const fixIds = dedupeFixes([...mapIeToFixes('IE17'), ...mapIeToFixes('IE19')]);
  const orphans = ctx.graphReports?.orphans as OrphansReport | undefined;
  const snapshot = ctx.graphReports?.snapshot;
  const deadCode = ctx.graphReports?.deadCode;
  const zombies = deadCode ? deadCodeCount(deadCode) : 0;

  // Primary path: read orphans.json directly (zero log-parsing).
  if (orphans && typeof orphans.orphanCount === 'number' && orphans.status) {
    const evidence: EvidenceRef = { kind: 'graph', ref: 'orphans.json#orphanCount' };
    const n = orphans.orphanCount;
    const note = zombies > 0 ? `dead-code zombies: ${zombies} (dead-code.json#count)` : undefined;
    if (orphans.status === 'pass' && n === 0) {
      return makeSlice('D-KC3', { score: 4, verdict: '🟢', value: 0, evidence, note });
    }
    if (orphans.status === 'fail' || n > 5) {
      return makeSlice('D-KC3', {
        score: 0,
        verdict: '🔴',
        value: n,
        evidence,
        note,
        ieIds: ieMeta,
        fixIds,
      });
    }
    // 1–5 orphans → 🟡.
    return makeSlice('D-KC3', {
      score: 2,
      verdict: '🟡',
      value: n,
      evidence,
      note,
      ieIds: ieMeta,
      fixIds,
    });
  }

  // Fallback path: derive degree-0 code orphans from the snapshot.
  if (snapshot && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges)) {
    const evidence: EvidenceRef = {
      kind: 'graph',
      ref: 'graph-snapshot.json#derived-degree0-code',
    };
    const n = deriveCodeOrphanCount(snapshot);
    const note =
      'orphans.json absent — derived from snapshot degree-0 code nodes (fallback)' +
      (zombies > 0 ? `; dead-code zombies: ${zombies}` : '');
    if (n === 0) {
      return makeSlice('D-KC3', { score: 4, verdict: '🟢', value: 0, evidence, note });
    }
    if (n > 5) {
      return makeSlice('D-KC3', {
        score: 0,
        verdict: '🔴',
        value: n,
        evidence,
        note,
        ieIds: ieMeta,
        fixIds,
      });
    }
    return makeSlice('D-KC3', {
      score: 2,
      verdict: '🟡',
      value: n,
      evidence,
      note,
      ieIds: ieMeta,
      fixIds,
    });
  }

  // Neither report nor snapshot available.
  return needsInstrumentation(
    'D-KC3',
    'neither orphans.json nor graph-snapshot.json available to compute orphan rate',
    { kind: 'graph', ref: 'orphans.json#orphanCount' },
    { ieIds: ieMeta, fixIds },
  );
}

/**
 * D-KC4 — Orphan-invariant SURFACED vs swallowed.
 * Evidence: graph-sync exit-code handling; daemon `exited 3 (non-blocking)` vs
 * surfaced/gated. The whole point of D-KC4 is the LOG fact — the report already
 * carries the FAIL `status`; F16 is the fix that surfaces it at the wave-close
 * gate. The surfaced-vs-swallowed distinction is a daemon-log signal NOT present
 * in the Lambda inputs → ⚪. (IE17 → F16 via ORPHAN_SURFACING_FIX.)
 */
function scoreDKC4(): ScorecardSlice {
  return needsInstrumentation(
    'D-KC4',
    'graph-sync exit-code handling (daemon `exited 3 (non-blocking)` vs surfaced/gated) is a daemon-log fact not present in Lambda inputs',
    { kind: 'log', ref: 'graph-sync#exit-code' },
    { ieIds: CRITERIA_META['D-KC4'].ieLink, fixIds: ORPHAN_SURFACING_FIX },
  );
}

/**
 * D-KC5 — projectId partition integrity: every node carries the canonical slug.
 * Evidence: snap.nodes[].projectId distribution — count nodes whose projectId is
 * a UUID, not the slug. Threshold: 4=uuidStrandedCount==0; 0=≥1. (IE18 → F17 shipped)
 */
function scoreDKC5(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'graph', ref: 'graph-snapshot.json#nodes[].projectId' };
  const ie = CRITERIA_META['D-KC5'].ieLink; // ['IE18']
  const fixIds = mapIeToFixes('IE18'); // F17 (shipped 0d5dd6a)
  const snapshot = ctx.graphReports?.snapshot;

  if (!snapshot || !Array.isArray(snapshot.nodes)) {
    return needsInstrumentation(
      'D-KC5',
      'graph-snapshot.json absent — cannot inspect node projectId distribution',
      evidence,
      { ieIds: ie, fixIds },
    );
  }

  let uuidStranded = 0;
  for (const n of snapshot.nodes) {
    if (isUuid(n.projectId)) uuidStranded++;
  }

  if (uuidStranded === 0) {
    return makeSlice('D-KC5', { score: 4, verdict: '🟢', value: 0, evidence });
  }
  return makeSlice('D-KC5', {
    score: 0,
    verdict: '🔴',
    value: uuidStranded,
    evidence,
    note: `${uuidStranded} node(s) carry a UUID projectId instead of the canonical slug`,
    ieIds: ie,
    fixIds,
  });
}

/**
 * D-KC6 — Living-doc connectivity: architecture/decision/index/system docs link
 * to the code they describe.
 * Evidence: degree-0 snapshot nodes with type∈{decision,system,index,architecture}.
 * Threshold: 4=livingDocFloaterCount==0; 0=≥1. (— / F18 shipped 0445e6a)
 */
function scoreDKC6(ctx: DetectorContext): ScorecardSlice {
  const evidence: EvidenceRef = { kind: 'graph', ref: 'graph-snapshot.json#degree0-livingdoc' };
  // D-KC6 has no IE row of its own; F18 is its fixLink (shipped). Surface it.
  const fixIds: FixRef[] = [{ id: 'F18', kind: 'F', status: 'shipped', sha: '0445e6a' }];
  const snapshot = ctx.graphReports?.snapshot;

  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    return needsInstrumentation(
      'D-KC6',
      'graph-snapshot.json absent — cannot derive degree-0 living-doc floaters',
      evidence,
      { fixIds },
    );
  }

  const connected = connectedNodeIds(snapshot);
  let floaters = 0;
  for (const n of snapshot.nodes) {
    if (LIVING_DOC_TYPES.has(String(n.type ?? '')) && !connected.has(n.id)) floaters++;
  }

  if (floaters === 0) {
    return makeSlice('D-KC6', { score: 4, verdict: '🟢', value: 0, evidence });
  }
  return makeSlice('D-KC6', {
    score: 0,
    verdict: '🔴',
    value: floaters,
    evidence,
    note: `${floaters} living-doc node(s) float unconnected to the code they describe`,
    fixIds,
  });
}

// ── util ─────────────────────────────────────────────────────────────────────

/** Dedupe a FixRef[] on id, preserving first occurrence (keeps shipped state). */
function dedupeFixes(fixes: FixRef[]): FixRef[] {
  const seen = new Set<string>();
  const out: FixRef[] = [];
  for (const f of fixes) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

// ── entrypoint ───────────────────────────────────────────────────────────────

/**
 * Score the knowledge-compile / system-graph criteria (D-KC1..D-KC6) over a
 * DetectorContext. Returns one ScorecardSlice per criterion (engine
 * 'deterministic'). Criteria whose evidence is missing emit ⚪ + a
 * needs-instrumentation note — never a fabricated value.
 */
export function scoreKnowledgeGraph(ctx: DetectorContext): ScorecardSlice[] {
  return [scoreDKC1(), scoreDKC2(ctx), scoreDKC3(ctx), scoreDKC4(), scoreDKC5(ctx), scoreDKC6(ctx)];
}
