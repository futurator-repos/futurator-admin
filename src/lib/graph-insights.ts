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
