'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  articleUrl,
  computeCoverage,
  computeIsolated,
  ISOLATION_COPY,
  type IsolatedNode,
} from '@/lib/graph-insights';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
});

const S3_BASE = 'https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live';

// Color palette keyed by node *kind* (Slice B). `kind` distinguishes the
// AST-derived sub-file nodes from the file-level wiki nodes; falls back to
// node.type for legacy snapshots that don't yet carry a `kind` field.
const NODE_COLORS_BY_KIND: Record<string, string> = {
  file: '#3b82f6', // blue — wiki-article / source file
  function: '#22d3ee', // cyan — AST function
  class: '#a855f7', // purple — AST class
  decision: '#f0abfc', // pink — wiki decision article
  system: '#f97316', // orange — wiki system article
  requirement: '#22c55e', // green — wiki requirement article
  unknown: '#64748b',
};

const EDGE_COLORS: Record<string, string> = {
  // Wiki-derived (Compiler [[wikilinks]])
  DEPENDS_ON: '#94a3b8',
  DERIVED_FROM: '#60a5fa',
  REFINES: '#22d3ee',
  VALIDATES: '#34d399',
  SUPERSEDES: '#f87171',
  CONFLICTS_WITH: '#f43f5e',
  ENABLES: '#facc15',
  INFORMS: '#a3a3a3',
  // AST-derived (Slice B)
  DEFINES: '#0ea5e9',
  IMPORTS: '#ec4899',
  CALLS: '#f59e0b',
};

type GraphNode = {
  id: string;
  /** kind comes from Slice B; legacy snapshots omit it, default to type. */
  kind?: string;
  type: string;
  phase: string;
  status: string;
  title: string;
  summary: string;
  maturity: number;
  tags: string[];
  createdByStory: string | null;
  lastMutatedByStory: string | null;
  updated: string | null;
  // Sub-file (AST) extras — present when kind is 'function' or 'class'.
  name?: string;
  parentFile?: string;
  line?: number;
  endLine?: number;
  exported?: boolean;
  params?: string[];
  className?: string | null;
  fnKind?: string;
  extends?: string | null;
};

/** Resolve color for a node — prefer kind, fall back to type. */
function colorForNode(n: GraphNode): string {
  const key = n.kind ?? n.type;
  return NODE_COLORS_BY_KIND[key] ?? NODE_COLORS_BY_KIND.unknown;
}

/** Smaller radius for AST-derived sub-file nodes so files dominate visually. */
function radiusForNode(n: GraphNode): number {
  if (n.kind === 'function' || n.kind === 'class') return 3;
  return 6;
}

type GraphEdge = {
  source: string;
  target: string;
  type: string;
  weight: number;
};

type GraphSnapshot = {
  projectId: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const RECENT_PROJECTS = [
  'dino-runner-1',
  '18a2d3da-a2ba-40e3-98cd-3c77bb9dd85c',
  '8eff885b-2d96-4a3a-8e11-163f0b545fb7',
];

const AUTO_REFRESH_MS = 5000;

export function GraphViewer({
  projectId: lockedProjectId,
}: {
  /** When set, locks the viewer to this project and hides the picker. */
  projectId?: string;
} = {}) {
  const [projectId, setProjectId] = useState<string>(lockedProjectId ?? '');
  const [inputValue, setInputValue] = useState<string>(lockedProjectId ?? '');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const locked = !!lockedProjectId;

  // Initialize from ?projectId= query string (standalone page only).
  // When locked, projectId comes from the prop and may change if the parent
  // re-renders with a different value (e.g. user switches plans).
  useEffect(() => {
    if (locked) {
      setProjectId(lockedProjectId ?? '');
      setInputValue(lockedProjectId ?? '');
      return;
    }
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const qp = params.get('projectId');
    if (qp) {
      setProjectId(qp);
      setInputValue(qp);
    }
  }, [locked, lockedProjectId]);

  // Track container size for the graph canvas
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width, height: Math.max(height, 400) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fetchSnapshot = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const url = `${S3_BASE}/${encodeURIComponent(pid)}/_graph/graph-snapshot.json?t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          throw new Error(
            `No graph snapshot found for "${pid}" yet. (Snapshots are written by compile-sync after the first story passes review.)`,
          );
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data: GraphSnapshot = await res.json();
      setSnapshot(data);
      setLastFetchedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when projectId changes, and on auto-refresh interval
  useEffect(() => {
    if (!projectId) return;
    fetchSnapshot(projectId);
    if (!autoRefresh) return;
    const id = setInterval(() => fetchSnapshot(projectId), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [projectId, autoRefresh, fetchSnapshot]);

  const graphData = useMemo(() => {
    if (!snapshot) return { nodes: [], links: [] };
    return {
      nodes: snapshot.nodes.map((n) => ({ ...n })),
      links: snapshot.edges.map((e) => ({ ...e })),
    };
  }, [snapshot]);

  const handleLoadProject = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setProjectId(trimmed);
    setSelectedNode(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('projectId', trimmed);
      window.history.replaceState({}, '', url.toString());
    }
  };

  // Filter state — toggles per node kind + edge type. Defaults to "show
  // everything" so first impression matches reality. The function-density
  // can be hidden via the "function" toggle when the graph is too busy.
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenEdges, setHiddenEdges] = useState<Set<string>>(new Set());

  const nodeKindBreakdown = useMemo(() => {
    if (!snapshot) return {};
    const out: Record<string, number> = {};
    for (const n of snapshot.nodes) {
      const k = n.kind ?? n.type;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }, [snapshot]);

  const edgeTypeBreakdown = useMemo(() => {
    if (!snapshot) return {};
    const out: Record<string, number> = {};
    for (const e of snapshot.edges) {
      out[e.type] = (out[e.type] ?? 0) + 1;
    }
    return out;
  }, [snapshot]);

  // ── pacman1 UX — knowledge layer derived insights ──────────────────
  const coverage = useMemo(() => computeCoverage(snapshot?.nodes ?? []), [snapshot]);
  const isolated = useMemo(
    () => computeIsolated(snapshot?.nodes ?? [], snapshot?.edges ?? []),
    [snapshot],
  );
  const [isolatedOpen, setIsolatedOpen] = useState(false);

  // Compiler activity feed — the wiki's log.md from the live S3 mirror.
  const [logTail, setLogTail] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    if (!projectId || !logOpen || logTail !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${S3_BASE}/${encodeURIComponent(projectId)}/log.md?t=${Date.now()}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setLogTail(text.split('\n').slice(-60).join('\n'));
      } catch {
        if (!cancelled)
          setLogTail(
            'No compilation log mirrored yet — log.md appears after the first story compiles (and ships after the knowledge-commit fix).',
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, logOpen, logTail]);

  // Apply filters to graphData
  const filteredGraphData = useMemo(() => {
    const allNodes = graphData.nodes as GraphNode[];
    const visibleNodes = allNodes.filter((n) => !hiddenKinds.has(n.kind ?? n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleLinks = (graphData.links as GraphEdge[]).filter(
      (e) =>
        !hiddenEdges.has(e.type) &&
        visibleIds.has(e.source as unknown as string) &&
        visibleIds.has(e.target as unknown as string),
    );
    return { nodes: visibleNodes, links: visibleLinks };
  }, [graphData, hiddenKinds, hiddenEdges]);

  function toggleKind(k: string) {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function toggleEdge(t: string) {
    setHiddenEdges((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Controls — picker hidden when projectId is locked from a parent */}
      {!locked && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-4">
          <div className="flex flex-1 items-center gap-2 min-w-[300px]">
            <label htmlFor="projectId" className="text-sm font-medium">
              Project / Plan ID:
            </label>
            <input
              id="projectId"
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLoadProject();
              }}
              placeholder="e.g. dino-runner-1 or a plan UUID"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={handleLoadProject}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Load
            </button>
          </div>
        </div>
      )}

      {/* Auto-refresh + manual refresh — shown in both modes */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (5s)
        </label>
        <button
          onClick={() => projectId && fetchSnapshot(projectId)}
          disabled={!projectId || loading}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh now'}
        </button>
        {locked && projectId && (
          <span className="text-xs text-muted-foreground font-mono">project: {projectId}</span>
        )}
      </div>

      {/* Quick-pick recent projects — only on standalone page */}
      {!locked && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Recent:</span>
          {RECENT_PROJECTS.map((pid) => (
            <button
              key={pid}
              onClick={() => {
                setInputValue(pid);
                setProjectId(pid);
                setSelectedNode(null);
                if (typeof window !== 'undefined') {
                  const url = new URL(window.location.href);
                  url.searchParams.set('projectId', pid);
                  window.history.replaceState({}, '', url.toString());
                }
              }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs font-mono hover:bg-muted"
            >
              {pid.length > 18 ? pid.slice(0, 8) + '…' + pid.slice(-4) : pid}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md border border-warning bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
          {error}
        </div>
      )}

      {/* Stats */}
      {snapshot && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-card p-3 text-sm">
          <div>
            <span className="font-semibold">{snapshot.nodeCount}</span> nodes
          </div>
          <div>
            <span className="font-semibold">{snapshot.edgeCount}</span> edges
          </div>
          {/* pacman1 UX — knowledge coverage at a glance. */}
          <div
            title="Files whose knowledge article the compiler has written (purpose, decisions, signals)"
            className="text-muted-foreground"
          >
            knowledge:{' '}
            <span
              className="font-semibold"
              style={{ color: coverage.coveragePct >= 70 ? 'var(--success)' : 'var(--warning)' }}
            >
              {coverage.filesWithArticle}/{coverage.files} files ({coverage.coveragePct}%)
            </span>
          </div>
          <div className="text-muted-foreground">
            Snapshot: {new Date(snapshot.generatedAt).toLocaleString()}
          </div>
          {lastFetchedAt && (
            <div className="text-muted-foreground">
              Last fetched: {lastFetchedAt.toLocaleTimeString()}
            </div>
          )}
          <div className="ml-auto flex flex-wrap gap-2 text-xs">
            {Object.entries(nodeKindBreakdown).map(([k, n]) => {
              const hidden = hiddenKinds.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  className={`flex items-center gap-1 rounded-md border px-2 py-0.5 transition-opacity ${
                    hidden ? 'opacity-40 line-through' : ''
                  }`}
                  style={{
                    borderColor: NODE_COLORS_BY_KIND[k] ?? NODE_COLORS_BY_KIND.unknown,
                  }}
                  title={hidden ? `Show ${k}` : `Hide ${k}`}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{
                      background: NODE_COLORS_BY_KIND[k] ?? NODE_COLORS_BY_KIND.unknown,
                    }}
                  />
                  {k}: {n}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Graph + details */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div
          ref={containerRef}
          className="relative h-[600px] overflow-hidden rounded-md border border-border bg-card"
        >
          {!projectId && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Enter a project / plan ID above to load its graph.
            </div>
          )}
          {projectId && !snapshot && !error && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          )}
          {snapshot && (
            <ForceGraph2D
              graphData={filteredGraphData}
              width={size.width}
              height={size.height}
              nodeLabel={(n: object) => {
                const g = n as unknown as GraphNode;
                const kind = g.kind ?? g.type;
                return `${g.title} (${kind})`;
              }}
              nodeColor={(n: object) => colorForNode(n as unknown as GraphNode)}
              nodeVal={(n: object) => radiusForNode(n as unknown as GraphNode)}
              nodeRelSize={3}
              linkColor={(l: object) => {
                const e = l as unknown as GraphEdge;
                return EDGE_COLORS[e.type] ?? EDGE_COLORS.DEPENDS_ON;
              }}
              linkLabel={(l: object) => {
                const e = l as unknown as GraphEdge;
                return e.type;
              }}
              linkDirectionalArrowLength={4}
              linkDirectionalArrowRelPos={0.95}
              onNodeClick={(n) => setSelectedNode(n as unknown as GraphNode)}
              cooldownTicks={120}
            />
          )}
        </div>

        {/* Details side panel */}
        <div className="rounded-md border border-border bg-card p-4 text-sm">
          {selectedNode ? (
            <div className="space-y-3">
              <div>
                <div className="text-xs uppercase text-muted-foreground">Node</div>
                <div className="font-mono text-xs break-all">{selectedNode.id}</div>
              </div>
              <div>
                <div className="font-semibold">{selectedNode.title}</div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  <span className="text-muted-foreground">Kind: </span>
                  {selectedNode.kind ?? selectedNode.type}
                </div>
                <div>
                  <span className="text-muted-foreground">Phase: </span>
                  {selectedNode.phase}
                </div>
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  {selectedNode.status}
                </div>
                <div>
                  <span className="text-muted-foreground">Maturity: </span>
                  {selectedNode.maturity}
                </div>
              </div>
              {/* AST-specific fields for function/class nodes (Slice B) */}
              {(selectedNode.kind === 'function' || selectedNode.kind === 'class') && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
                  {selectedNode.parentFile && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Parent file: </span>
                      <span className="font-mono">{selectedNode.parentFile}</span>
                    </div>
                  )}
                  {selectedNode.line ? (
                    <div>
                      <span className="text-muted-foreground">Lines: </span>
                      {selectedNode.line}
                      {selectedNode.endLine ? `–${selectedNode.endLine}` : ''}
                    </div>
                  ) : null}
                  {selectedNode.kind === 'function' && (
                    <div>
                      <span className="text-muted-foreground">Exported: </span>
                      {selectedNode.exported ? 'yes' : 'no'}
                    </div>
                  )}
                  {selectedNode.className && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Class: </span>
                      <span className="font-mono">{selectedNode.className}</span>
                    </div>
                  )}
                  {selectedNode.kind === 'class' && selectedNode.extends && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Extends: </span>
                      <span className="font-mono">{selectedNode.extends}</span>
                    </div>
                  )}
                  {selectedNode.kind === 'function' &&
                    selectedNode.params &&
                    selectedNode.params.length > 0 && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Params: </span>
                        <span className="font-mono">({selectedNode.params.join(', ')})</span>
                      </div>
                    )}
                </div>
              )}
              {selectedNode.tags && selectedNode.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedNode.tags.map((t) => (
                    <span key={t} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {selectedNode.summary && (
                <div>
                  <div className="text-xs uppercase text-muted-foreground mb-1">Summary</div>
                  <div className="text-xs whitespace-pre-wrap">{selectedNode.summary}</div>
                </div>
              )}
              {/* pacman1 UX — open the compiler's full article for this node. */}
              {projectId && articleUrl(S3_BASE, projectId, selectedNode) && (
                <a
                  href={articleUrl(S3_BASE, projectId, selectedNode)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  View knowledge article ↗
                </a>
              )}
              {(selectedNode.createdByStory || selectedNode.lastMutatedByStory) && (
                <div className="border-t border-border pt-2 text-xs text-muted-foreground">
                  {selectedNode.createdByStory && (
                    <div>Created by: {selectedNode.createdByStory}</div>
                  )}
                  {selectedNode.lastMutatedByStory &&
                    selectedNode.lastMutatedByStory !== selectedNode.createdByStory && (
                      <div>Last mutated by: {selectedNode.lastMutatedByStory}</div>
                    )}
                  {selectedNode.updated && <div>Updated: {selectedNode.updated}</div>}
                </div>
              )}
            </div>
          ) : snapshot ? (
            <div className="space-y-3 text-xs text-muted-foreground">
              <div>Click a node to inspect.</div>
              <div className="border-t border-border pt-2">
                <div className="font-semibold text-foreground mb-1">
                  Edge types (click to filter)
                </div>
                {Object.entries(edgeTypeBreakdown).map(([t, n]) => {
                  const hidden = hiddenEdges.has(t);
                  return (
                    <button
                      key={t}
                      onClick={() => toggleEdge(t)}
                      className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-opacity hover:bg-muted ${
                        hidden ? 'opacity-40 line-through' : ''
                      }`}
                      title={hidden ? `Show ${t}` : `Hide ${t}`}
                    >
                      <span
                        className="inline-block h-2 w-6 rounded"
                        style={{
                          background: EDGE_COLORS[t] ?? EDGE_COLORS.DEPENDS_ON,
                        }}
                      />
                      <span>
                        {t}: {n}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No graph loaded.</div>
          )}
        </div>
      </div>

      {/* ── pacman1 UX — unconnected nodes (the operator's cleanup radar) ── */}
      {snapshot && isolated.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <button
            type="button"
            onClick={() => setIsolatedOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40"
            aria-expanded={isolatedOpen}
          >
            <span className="font-semibold">
              {isolatedOpen ? '▾' : '▸'} Unconnected nodes ({isolated.length})
            </span>
            <span className="text-xs text-muted-foreground">
              nodes with no relationships — most reconnect after the next compile; persistent ones
              are removal candidates
            </span>
          </button>
          {isolatedOpen && (
            <div className="max-h-64 overflow-auto border-t border-border">
              {isolated.map(({ node, reason }: IsolatedNode) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelectedNode(node as unknown as GraphNode)}
                  className="flex w-full items-baseline gap-3 border-t border-border px-4 py-2 text-left text-xs first:border-t-0 hover:bg-muted/40"
                  title="Click to inspect this node"
                >
                  <span
                    className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                    style={{
                      background:
                        NODE_COLORS_BY_KIND[node.kind ?? node.type ?? 'unknown'] ??
                        NODE_COLORS_BY_KIND.unknown,
                    }}
                  />
                  <code className="flex-shrink-0 break-all">{node.id}</code>
                  <span className="text-muted-foreground">{ISOLATION_COPY[reason]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── pacman1 UX — compiler activity (knowledge/log.md tail) ───────── */}
      {snapshot && (
        <div className="rounded-md border border-border bg-card">
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40"
            aria-expanded={logOpen}
          >
            <span className="font-semibold">{logOpen ? '▾' : '▸'} Compiler activity</span>
            <span className="text-xs text-muted-foreground">
              the knowledge compiler&apos;s per-story log (what it cataloged, when)
            </span>
          </button>
          {logOpen && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs text-muted-foreground">
              {logTail ?? 'Loading…'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
