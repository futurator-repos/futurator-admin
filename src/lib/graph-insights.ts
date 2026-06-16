/**
 * graph-insights.ts — pure helpers for the Graph tab's knowledge layer
 * (pacman1 UX pass, 2026-06-12). Computed client-side from the S3
 * graph-snapshot so the viewer can show coverage + isolated-node insight
 * without new backend surface.
 */

export interface InsightNode {
  id: string;
  kind?: string;
  type?: string;
  title?: string | null;
  summary?: string | null;
  maturity?: number | null;
}

export interface InsightEdge {
  source: string;
  target: string;
  type: string;
}

/** A file node "has an article" when the compiler enriched it. */
export function hasArticle(n: InsightNode): boolean {
  return !!(n.summary && String(n.summary).trim().length > 0) || (n.maturity ?? 0) > 0;
}

export interface CoverageStats {
  files: number;
  filesWithArticle: number;
  functions: number;
  classes: number;
  coveragePct: number;
}

export function computeCoverage(nodes: InsightNode[]): CoverageStats {
  let files = 0;
  let filesWithArticle = 0;
  let functions = 0;
  let classes = 0;
  for (const n of nodes) {
    const k = n.kind ?? n.type ?? 'unknown';
    if (k === 'function') functions += 1;
    else if (k === 'class') classes += 1;
    else if (k === 'file' || k === 'decision' || k === 'system' || k === 'requirement') {
      files += 1;
      if (hasArticle(n)) filesWithArticle += 1;
    }
  }
  return {
    files,
    filesWithArticle,
    functions,
    classes,
    coveragePct: files > 0 ? Math.round((filesWithArticle / files) * 100) : 0,
  };
}

export type IsolationReason =
  | 'detached-function'
  | 'article-unlinked'
  | 'unreferenced-file'
  | 'unreferenced';

export interface IsolatedNode {
  node: InsightNode;
  reason: IsolationReason;
}

export const ISOLATION_COPY: Record<IsolationReason, string> = {
  'detached-function':
    'function with no DEFINES edge to its file — usually pre-fix snapshot data; the next compile reconnects it',
  'article-unlinked':
    'has a knowledge article but no resolved code relationships yet — check after the next compile',
  'unreferenced-file':
    'no imports in or out — either a true entry point/config, unresolved pre-fix imports, or a removal candidate',
  unreferenced: 'no relationships recorded',
};

/**
 * Nodes with zero edges (any direction), each with a best-effort reason the
 * operator can act on. Sorted: files first (the actionable ones), then
 * functions.
 */
export function computeIsolated(nodes: InsightNode[], edges: InsightEdge[]): IsolatedNode[] {
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(String(e.source));
    connected.add(String(e.target));
  }
  const out: IsolatedNode[] = [];
  for (const n of nodes) {
    if (connected.has(n.id)) continue;
    const k = n.kind ?? n.type ?? 'unknown';
    let reason: IsolationReason;
    if (k === 'function' || k === 'class') reason = 'detached-function';
    else if (hasArticle(n)) reason = 'article-unlinked';
    else if (k === 'file') reason = 'unreferenced-file';
    else reason = 'unreferenced';
    out.push({ node: n, reason });
  }
  out.sort((a, b) => {
    const fa = a.reason === 'detached-function' ? 1 : 0;
    const fb = b.reason === 'detached-function' ? 1 : 0;
    return fa - fb || a.node.id.localeCompare(b.node.id);
  });
  return out;
}

/**
 * Public URL of a node's knowledge article on the live S3 mirror
 * (`knowledge-live/<projectId>/<nodeId>.md`). Only file-level nodes with an
 * article have one; sub-file nodes (`…#function:x`) never do.
 */
export function articleUrl(s3Base: string, projectId: string, node: InsightNode): string | null {
  if (!hasArticle(node) || node.id.includes('#')) return null;
  return `${s3Base}/${encodeURIComponent(projectId)}/${node.id}.md`;
}

// ── Epic 2: "No Alone Dots" integrity reports ──────────────────────────────
// These mirror the JSON graph-sync writes to knowledge/_graph/ (PRD §4.2):
//   - dead-code.json — files whose only edge is CONTAINS (advisory finding)
//   - orphans.json   — degree-0 nodes; non-`file` orphans are extractor bugs

export interface DeadCodeCandidate {
  id: string;
  updated?: string | null;
  title?: string | null;
}

export interface DeadCodeReport {
  projectId: string;
  generatedAt: string;
  count: number;
  candidates: DeadCodeCandidate[];
}

export interface OrphanReport {
  projectId: string;
  generatedAt: string;
  status: 'pass' | 'fail';
  orphanCount: number;
  hardFailCount: number;
  byKind: Record<string, string[]>;
  orphans: Array<{ id: string; kind: string }>;
  hardFail: Array<{ id: string; kind: string }>;
}

export type IntegrityTone = 'pass' | 'fail' | 'unknown';

export interface IntegrityHeadline {
  tone: IntegrityTone;
  label: string;
  detail: string;
}

// ── Epic 3: Architectural X-Ray — centrality, communities, surprising links ─
// Mirrors knowledge/_graph/insights.json written by the post-sync analytics
// pass (PRD §5.4 / Appendix D). The Graph tab reads it to size nodes by
// centrality, color them by community, and list surprising connections.

export interface GodNode {
  id: string;
  kind: string;
  title: string;
  centrality: number;
}

export interface CommunityCount {
  community: number;
  count: number;
}

export interface SurprisingConnection {
  source: string;
  sourceTitle: string;
  type: string;
  target: string;
  targetTitle: string;
  sourceCommunity: number | null;
  targetCommunity: number | null;
  score: number | null;
}

export interface NodeMetric {
  centrality: number | null;
  community: number | null;
}

export interface ArchInsights {
  projectId: string;
  generatedAt: string;
  mageAvailable: boolean;
  centralityAvailable: boolean;
  communityAvailable: boolean;
  threshold: number;
  godNodes: GodNode[];
  communities: CommunityCount[];
  surprisingConnections: SurprisingConnection[];
  nodeMetrics: Record<string, NodeMetric>;
}

/**
 * Color-blind-safe community palette (Okabe–Ito) — eight hues distinguishable
 * across the common color-vision deficiencies. Communities cycle through it.
 */
export const COMMUNITY_PALETTE = [
  '#0072B2', // blue
  '#E69F00', // orange
  '#009E73', // bluish green
  '#CC79A7', // reddish purple
  '#56B4E9', // sky blue
  '#D55E00', // vermillion
  '#F0E442', // yellow
  '#999999', // gray
];

/** Stable color for a community id (or neutral slate when unassigned). */
export function communityColor(community: number | null | undefined): string {
  if (community == null) return '#64748b';
  const L = COMMUNITY_PALETTE.length;
  return COMMUNITY_PALETTE[((community % L) + L) % L];
}

/**
 * Node radius scaled by betweenness centrality, normalized against the run's
 * max so god-nodes dominate. Falls back to `base` when there's no centrality
 * (e.g. MAGE unavailable, or a node on no shortest path).
 */
export function centralityRadius(
  centrality: number | null | undefined,
  max: number,
  base = 4,
): number {
  if (!centrality || centrality <= 0 || max <= 0) return base;
  return base + (centrality / max) * 16;
}

/** Largest centrality in the run (0 when none) — the normalization denominator. */
export function maxCentrality(insights: ArchInsights | null): number {
  if (!insights) return 0;
  let m = 0;
  for (const id in insights.nodeMetrics) {
    const c = insights.nodeMetrics[id].centrality;
    if (typeof c === 'number' && c > m) m = c;
  }
  return m;
}

/**
 * The orphan-invariant status line for the Dead-code panel. `fail` means a
 * non-`file` orphan survived (an extractor dropped an edge) — a real
 * wave-gate-blocking bug, not a finding. `unknown` when no report exists yet
 * (older sync, or the project never ran the integrity step).
 */
export function integrityHeadline(orphan: OrphanReport | null): IntegrityHeadline {
  if (!orphan) {
    return {
      tone: 'unknown',
      label: 'Orphan invariant: not reported',
      detail: 'no orphans.json in the latest sync',
    };
  }
  if (orphan.status === 'fail') {
    return {
      tone: 'fail',
      label: `Orphan invariant: FAIL (${orphan.hardFailCount})`,
      detail: 'non-file orphan(s) — an extractor dropped an edge; this blocks the wave gate',
    };
  }
  return {
    tone: 'pass',
    label: 'Orphan invariant: pass',
    detail: 'no structural orphans — every node has at least one edge by construction',
  };
}

// ── Epic 5: Cross-project contract spine — capability coverage gaps (W8) ─────
// Mirrors knowledge/_graph/capability-gaps.json written by the `--global`
// federation pass. A gap = a component that touches a shared contract
// (table/endpoint/event) yet has no IMPLEMENTS→capability tag — a
// suspected-but-untagged capability, surfaced so the manual seam is audited.

export interface CapabilityGap {
  nodeId: string;
  title: string;
  contractTouches: number;
}

export interface CapabilityGapReport {
  projectId: string;
  generatedAt: string;
  gapCount: number;
  gaps: CapabilityGap[];
}
