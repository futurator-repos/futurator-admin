'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
});

const S3_BASE = 'https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live';

const NODE_COLORS: Record<string, string> = {
  code: '#3b82f6',
  decision: '#a855f7',
  system: '#f97316',
  requirement: '#22c55e',
  unknown: '#64748b',
};

const EDGE_COLORS: Record<string, string> = {
  DEPENDS_ON: '#94a3b8',
  DERIVED_FROM: '#60a5fa',
  REFINES: '#22d3ee',
  VALIDATES: '#34d399',
  SUPERSEDES: '#f87171',
  CONFLICTS_WITH: '#f43f5e',
  ENABLES: '#facc15',
  INFORMS: '#a3a3a3',
};

type GraphNode = {
  id: string;
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
};

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

  const nodeTypeBreakdown = useMemo(() => {
    if (!snapshot) return {};
    const out: Record<string, number> = {};
    for (const n of snapshot.nodes) {
      out[n.type] = (out[n.type] ?? 0) + 1;
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
          <div className="text-muted-foreground">
            Snapshot: {new Date(snapshot.generatedAt).toLocaleString()}
          </div>
          {lastFetchedAt && (
            <div className="text-muted-foreground">
              Last fetched: {lastFetchedAt.toLocaleTimeString()}
            </div>
          )}
          <div className="ml-auto flex flex-wrap gap-3 text-xs">
            {Object.entries(nodeTypeBreakdown).map(([t, n]) => (
              <span key={t} className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: NODE_COLORS[t] ?? NODE_COLORS.unknown }}
                />
                {t}: {n}
              </span>
            ))}
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
              graphData={graphData}
              width={size.width}
              height={size.height}
              nodeLabel={(n: object) => {
                const g = n as unknown as GraphNode;
                return `${g.title} (${g.type})`;
              }}
              nodeColor={(n: object) => {
                const g = n as unknown as GraphNode;
                return NODE_COLORS[g.type] ?? NODE_COLORS.unknown;
              }}
              nodeRelSize={5}
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
                  <span className="text-muted-foreground">Type: </span>
                  {selectedNode.type}
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
                <div className="font-semibold text-foreground mb-1">Edge types</div>
                {Object.entries(edgeTypeBreakdown).map(([t, n]) => (
                  <div key={t} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-6 rounded"
                      style={{
                        background: EDGE_COLORS[t] ?? EDGE_COLORS.DEPENDS_ON,
                      }}
                    />
                    <span>
                      {t}: {n}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No graph loaded.</div>
          )}
        </div>
      </div>
    </div>
  );
}
