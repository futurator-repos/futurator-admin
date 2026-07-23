'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  articleUrl,
  computeCoverage,
  computeIsolated,
  integrityHeadline,
  ISOLATION_COPY,
  maxCentrality,
  type IsolatedNode,
  type DeadCodeReport,
  type OrphanReport,
  type ArchInsights,
  type CapabilityGapReport,
} from '@/lib/graph-insights';
import { DeadCodePanel } from './dead-code-panel';
import { ArchXrayPanel } from './arch-xray-panel';
import { CapabilityGapPanel } from './capability-gap-panel';
import { ArticleViewer, ArticleBody } from './article-viewer';
import { GraphCanvas, type CanvasNode, type CanvasLink } from './graph-canvas';
import { communityColor, type LayoutMode } from '@/lib/graph/catalog';
import { buildAdjacency } from '@/lib/graph/analysis';

const S3_BASE = 'https://futurator-knowledge-live-eu.s3.eu-central-1.amazonaws.com/knowledge-live';
// Article links open in a browser tab — use the CloudFront domain, NOT the raw
// `futurator-ai-website.s3…` hostname (Chrome's safe-browsing flags it as a
// "did you mean futurator.ai?" lookalike). Same content, no warning. Snapshot
// JSON keeps fetching from S3_BASE (CORS already allows the admin origin there).
const ARTICLE_BASE = 'https://futurator.ai/knowledge-live';

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
  REFERENCES: '#2dd4bf', // teal — living doc (decision/architecture/index) → code it describes
  // AST-derived (Slice B)
  DEFINES: '#0ea5e9',
  IMPORTS: '#ec4899',
  CALLS: '#f59e0b',
  RENDERS: '#8b5cf6', // violet — JSX component composition (ts-morph)
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
  // Semantic neighbours from the Voyage embeddings (graph-sync kNN).
  similarTo?: { id: string; score: number }[];
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
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [articleNode, setArticleNode] = useState<GraphNode | null>(null);
  // Focus / local view — isolate the selected node + its neighbourhood.
  const [focusMode, setFocusMode] = useState(false);
  // Graph Viz v2 — layout mode + overlay controls (the new canvas).
  const [layout, setLayout] = useState<LayoutMode>('force');
  const [showZones, setShowZones] = useState(true);
  const [fitToken, setFitToken] = useState(0);
  const [blastEnabled, setBlastEnabled] = useState(false);
  const [showArticleInline, setShowArticleInline] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
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

  // Fetch once when the project loads / changes. Refresh is manual (button) —
  // no polling, so an in-progress compile doesn't yank the canvas out from
  // under you mid-inspection.
  useEffect(() => {
    if (!projectId) return;
    fetchSnapshot(projectId);
  }, [projectId, fetchSnapshot]);

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

  // ── Searcher — highlight matches + their 1-hop neighbors so you can probe the
  // graph's quality by hand. Client-side over the loaded snapshot (Memgraph is
  // VPC-internal, so live Cypher would need a daemon-proxied endpoint — a future
  // step). Supports free-text (matches title/id/name) and `field:value` filters:
  //   kind:file  type:function  status:active  phase:implementation  tag:foo
  // Space-separated terms are AND-ed.
  const [search, setSearch] = useState('');

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

  // ── Epic 2: "Dead code / unreferenced" — graph-integrity reports ─────────
  // Read knowledge/_graph/{dead-code,orphans}.json from the same live S3 mirror
  // the snapshot comes from. Refreshed in lockstep with the snapshot. Additive,
  // non-blocking — a missing report just shows the empty/unknown state.
  const [deadCode, setDeadCode] = useState<DeadCodeReport | null>(null);
  const [orphanReport, setOrphanReport] = useState<OrphanReport | null>(null);
  // ── Epic 3: Architectural X-ray — insights.json (centrality/communities) ──
  const [archInsights, setArchInsights] = useState<ArchInsights | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  // ── Epic 5: capability coverage gaps — capability-gaps.json (--global only) ─
  const [capabilityGaps, setCapabilityGaps] = useState<CapabilityGapReport | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const base = `${S3_BASE}/${encodeURIComponent(projectId)}/_graph`;
    const pull = async <T,>(file: string): Promise<T | null> => {
      try {
        const res = await fetch(`${base}/${file}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    };
    (async () => {
      const [dc, orph, ins, gaps] = await Promise.all([
        pull<DeadCodeReport>('dead-code.json'),
        pull<OrphanReport>('orphans.json'),
        pull<ArchInsights>('insights.json'),
        pull<CapabilityGapReport>('capability-gaps.json'),
      ]);
      if (!cancelled) {
        setDeadCode(dc);
        setOrphanReport(orph);
        setArchInsights(ins);
        setCapabilityGaps(gaps);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, lastFetchedAt]);
  const integrity = useMemo(() => integrityHeadline(orphanReport), [orphanReport]);
  const maxC = useMemo(() => maxCentrality(archInsights), [archInsights]);
  // Overlay is live only when enabled AND the analytics pass produced metrics.
  const overlayActive = overlayEnabled && !!archInsights?.mageAvailable;
  // Per-node centrality/community for the canvas (X-ray sizing, community colour + zones).
  const metrics = useMemo(() => archInsights?.nodeMetrics ?? {}, [archInsights]);

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

  // Resolve a force-graph link endpoint, which react-force-graph mutates from a
  // string id into the node object after the first simulation tick.
  const endpointId = (e: unknown): string =>
    typeof e === 'object' && e !== null ? (e as { id: string }).id : (e as string);

  const searchMatch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const filters: { field: string; value: string }[] = [];
    const terms: string[] = [];
    for (const tok of q.split(/\s+/)) {
      const m = tok.match(/^(kind|type|status|phase|tag|id|title):(.+)$/);
      if (m) filters.push({ field: m[1], value: m[2] });
      else terms.push(tok);
    }
    const matchIds = new Set<string>();
    for (const n of filteredGraphData.nodes as GraphNode[]) {
      const kind = (n.kind ?? n.type ?? '').toLowerCase();
      const hay = `${n.title ?? ''} ${n.id ?? ''} ${n.name ?? ''}`.toLowerCase();
      const okFilters = filters.every((f) => {
        if (f.field === 'kind' || f.field === 'type') return kind.includes(f.value);
        if (f.field === 'status') return (n.status ?? '').toLowerCase().includes(f.value);
        if (f.field === 'phase') return (n.phase ?? '').toLowerCase().includes(f.value);
        if (f.field === 'id') return (n.id ?? '').toLowerCase().includes(f.value);
        if (f.field === 'title') return (n.title ?? '').toLowerCase().includes(f.value);
        if (f.field === 'tag') return (n.tags ?? []).some((t) => t.toLowerCase().includes(f.value));
        return true;
      });
      const okText = terms.length === 0 || terms.every((t) => hay.includes(t));
      if (okFilters && okText) matchIds.add(n.id);
    }
    const neighborIds = new Set<string>();
    for (const e of filteredGraphData.links as GraphEdge[]) {
      const s = endpointId(e.source);
      const t = endpointId(e.target);
      if (matchIds.has(s)) neighborIds.add(t);
      if (matchIds.has(t)) neighborIds.add(s);
    }
    return { matchIds, neighborIds, count: matchIds.size };
  }, [search, filteredGraphData]);

  const SIMILAR = '#e879f9'; // magenta — semantic neighbours of the selected node

  // Focus view: when on + a node is selected, isolate it + its 1-hop neighbours
  // (structural edges AND semantic similarity), hiding the rest of the graph.
  const focusGraphData = useMemo(() => {
    if (!focusMode || !selectedNode) return filteredGraphData;
    const center = selectedNode.id;
    const keep = new Set<string>([center]);
    for (const e of filteredGraphData.links as GraphEdge[]) {
      const s = endpointId(e.source);
      const t = endpointId(e.target);
      if (s === center) keep.add(t);
      if (t === center) keep.add(s);
    }
    for (const s of selectedNode.similarTo ?? []) keep.add(s.id);
    return {
      nodes: (filteredGraphData.nodes as GraphNode[]).filter((n) => keep.has(n.id)),
      links: (filteredGraphData.links as GraphEdge[]).filter(
        (e) => keep.has(endpointId(e.source)) && keep.has(endpointId(e.target)),
      ),
    };
  }, [focusMode, selectedNode, filteredGraphData]);

  // Semantic neighbours of the selected node (from the embedding kNN). Used to
  // ring them on the canvas + list them in the detail panel.
  const similarSet = useMemo(
    () => new Set((selectedNode?.similarTo ?? []).map((s) => s.id)),
    [selectedNode],
  );

  // Adjacency over the full snapshot — powers relationships-by-edge-type in the
  // inspector + the Blast-radius highlight.
  const adjacency = useMemo(() => buildAdjacency(snapshot?.edges ?? [], endpointId), [snapshot]);
  const relsByType = useMemo(() => {
    if (!selectedNode)
      return [] as { type: string; entries: { to: string; dir: 'out' | 'in' }[] }[];
    const groups = new Map<string, { to: string; dir: 'out' | 'in' }[]>();
    for (const a of adjacency.get(selectedNode.id) ?? []) {
      const g = groups.get(a.type) ?? [];
      g.push({ to: a.to, dir: a.dir });
      groups.set(a.type, g);
    }
    return [...groups.entries()]
      .map(([type, entries]) => ({ type, entries }))
      .sort((x, y) => y.entries.length - x.entries.length);
  }, [selectedNode, adjacency]);
  // Blast radius — 2-hop reachable set from the selected node (Pass 3). Reuses
  // the canvas's match/dim machinery: light the node + its blast, dim the rest.
  const blastHighlight = useMemo(() => {
    if (!blastEnabled || !selectedNode) return null;
    const reached = new Set<string>([selectedNode.id]);
    let frontier = [selectedNode.id];
    for (let hop = 0; hop < 2; hop++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const a of adjacency.get(id) ?? [])
          if (!reached.has(a.to)) {
            reached.add(a.to);
            next.push(a.to);
          }
      frontier = next;
    }
    const neighborIds = new Set(reached);
    neighborIds.delete(selectedNode.id);
    return { matchIds: new Set([selectedNode.id]), neighborIds, count: reached.size };
  }, [blastEnabled, selectedNode, adjacency]);
  const effectiveMatch = blastHighlight ?? searchMatch;
  useEffect(() => setShowArticleInline(false), [selectedNode?.id]);

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

      {/* Search + manual refresh — no polling (refreshes on load + this button) */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => projectId && fetchSnapshot(projectId)}
          disabled={!projectId || loading}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <div className="flex flex-1 items-center gap-2 min-w-[280px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search — free text, or kind:file status:active tag:foo"
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            title="Highlights matching nodes + their neighbours. Filters: kind: type: status: phase: tag: id: title:"
          />
          {search && (
            <>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {searchMatch?.count ?? 0} match{(searchMatch?.count ?? 0) === 1 ? '' : 'es'}
              </span>
              <button
                onClick={() => setSearch('')}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs hover:bg-muted"
                title="Clear search"
              >
                ✕
              </button>
            </>
          )}
        </div>
        <button
          onClick={() => setFocusMode((v) => !v)}
          disabled={!selectedNode}
          className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
            focusMode
              ? 'border-accent-blue bg-accent-blue/15 text-accent-blue'
              : 'border-input bg-background hover:bg-muted'
          }`}
          title={
            selectedNode
              ? 'Isolate the selected node + its neighbours'
              : 'Select a node first, then focus on its neighbourhood'
          }
        >
          {focusMode ? 'Focus: on' : 'Focus neighbours'}
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
        </div>
      )}

      {/* Graph Viz v2 — layout modes + overlay controls */}
      {snapshot && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-xs">
            {(
              [
                ['force', 'Force Atlas'],
                ['lanes', 'Layered Lanes'],
                ['community', 'Community Orbit'],
              ] as [LayoutMode, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setLayout(key)}
                className={`rounded px-2.5 py-1 transition-colors ${
                  layout === key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setOverlayEnabled((v) => !v)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              overlayActive
                ? 'border-accent-blue bg-accent-blue/15 text-accent-blue'
                : 'border-input bg-background hover:bg-muted'
            }`}
            title="X-ray — colour by community, size by centrality"
          >
            X-ray
          </button>
          <button
            onClick={() => setShowZones((v) => !v)}
            disabled={!overlayActive}
            className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${
              showZones && overlayActive
                ? 'border-accent-blue bg-accent-blue/15 text-accent-blue'
                : 'border-input bg-background hover:bg-muted'
            }`}
            title="Translucent community zones behind the graph"
          >
            Zones
          </button>
          <button
            onClick={() => setBlastEnabled((v) => !v)}
            disabled={!selectedNode}
            className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${
              blastEnabled && selectedNode
                ? 'border-accent-blue bg-accent-blue/15 text-accent-blue'
                : 'border-input bg-background hover:bg-muted'
            }`}
            title="Blast radius — light the selected node's 2-hop neighbourhood, dim the rest"
          >
            Blast
          </button>
          <button
            onClick={() => setFitToken((t) => t + 1)}
            className="rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-muted"
            title="Fit graph to view"
          >
            Fit
          </button>
        </div>
      )}

      {/* Graph Viz v2 — left rail · graph hero · right rail */}
      <div className="flex flex-col gap-3 lg:h-[760px] lg:flex-row">
        {/* LEFT RAIL — filters */}
        <aside className="flex shrink-0 flex-col gap-3 overflow-auto rounded-md border border-border bg-card p-3 text-xs lg:w-[210px]">
          <div>
            <div className="mb-1.5 font-semibold uppercase tracking-wide text-muted-foreground">
              Layers &amp; kinds
            </div>
            <div className="flex flex-col gap-1">
              {Object.entries(nodeKindBreakdown).map(([k, n]) => {
                const hidden = hiddenKinds.has(k);
                return (
                  <button
                    key={k}
                    onClick={() => toggleKind(k)}
                    className={`flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50 ${hidden ? 'opacity-40 line-through' : ''}`}
                    title={hidden ? `Show ${k}` : `Hide ${k}`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ background: NODE_COLORS_BY_KIND[k] ?? NODE_COLORS_BY_KIND.unknown }}
                    />
                    <span className="flex-1 capitalize">{k}</span>
                    <span className="text-muted-foreground">{n}</span>
                  </button>
                );
              })}
              {!snapshot && <div className="px-1 text-muted-foreground">—</div>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 font-semibold uppercase tracking-wide text-muted-foreground">
              Edge types
            </div>
            <div className="flex flex-col gap-1">
              {Object.entries(edgeTypeBreakdown).map(([t, n]) => {
                const hidden = hiddenEdges.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleEdge(t)}
                    className={`flex items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50 ${hidden ? 'opacity-40 line-through' : ''}`}
                    title={hidden ? `Show ${t}` : `Hide ${t}`}
                  >
                    <span
                      className="inline-block h-2 w-5 flex-shrink-0 rounded"
                      style={{ background: EDGE_COLORS[t] ?? EDGE_COLORS.DEPENDS_ON }}
                    />
                    <span className="flex-1">{t}</span>
                    <span className="text-muted-foreground">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* GRAPH — hero */}
        <div className="relative min-h-[520px] min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-card">
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
            <GraphCanvas
              data={focusGraphData as { nodes: CanvasNode[]; links: CanvasLink[] }}
              layout={layout}
              fitToken={fitToken}
              metrics={metrics}
              maxCentrality={maxC}
              xray={overlayActive}
              zones={showZones && overlayActive}
              searchMatch={effectiveMatch}
              similarSet={similarSet}
              selectedId={selectedNode?.id ?? null}
              onSelect={(n) => setSelectedNode((n as unknown as GraphNode) ?? null)}
            />
          )}
        </div>

        {/* RIGHT RAIL — inspector / insights */}
        <aside className="shrink-0 overflow-auto rounded-md border border-border bg-card p-4 text-sm lg:w-[340px]">
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
              {/* Centrality / community from the analytics pass. */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  <span className="text-muted-foreground">Centrality: </span>
                  {metrics[selectedNode.id]?.centrality != null
                    ? metrics[selectedNode.id]!.centrality!.toFixed(0)
                    : '—'}
                </div>
                <div>
                  <span className="text-muted-foreground">Community: </span>
                  {metrics[selectedNode.id]?.community ?? '—'}
                </div>
              </div>
              {/* Relationships grouped by edge type (click a target to walk the graph). */}
              {relsByType.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase text-muted-foreground">
                    Relationships ({relsByType.reduce((s, r) => s + r.entries.length, 0)})
                  </div>
                  <div className="space-y-1.5">
                    {relsByType.map(({ type, entries }) => (
                      <div key={type}>
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className="inline-block h-2 w-5 flex-shrink-0 rounded"
                            style={{ background: EDGE_COLORS[type] ?? EDGE_COLORS.DEPENDS_ON }}
                          />
                          <span className="font-medium">{type}</span>
                          <span className="text-muted-foreground">{entries.length}</span>
                        </div>
                        <div className="mt-0.5 space-y-0.5 pl-7">
                          {entries.slice(0, 10).map(({ to, dir }, i) => {
                            const tgt = snapshot?.nodes.find((n) => n.id === to);
                            return (
                              <button
                                key={`${to}-${i}`}
                                type="button"
                                onClick={() => tgt && setSelectedNode(tgt)}
                                className="flex w-full items-baseline gap-1 rounded px-1 text-left text-xs hover:bg-muted/40"
                                title={to}
                              >
                                <span className="flex-shrink-0 text-muted-foreground">
                                  {dir === 'out' ? '→' : '←'}
                                </span>
                                <code className="flex-1 break-all">{tgt?.title || to}</code>
                              </button>
                            );
                          })}
                          {entries.length > 10 && (
                            <div className="pl-1 text-[10px] text-muted-foreground">
                              +{entries.length - 10} more
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Semantic neighbours from the embeddings (graph-sync kNN). */}
              {selectedNode.similarTo && selectedNode.similarTo.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase text-muted-foreground">
                    Semantically similar
                  </div>
                  <div className="space-y-1">
                    {selectedNode.similarTo.map((s) => {
                      const target = snapshot?.nodes.find((n) => n.id === s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => target && setSelectedNode(target)}
                          className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted/40"
                          title="Select this semantically-similar node"
                        >
                          <span
                            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                            style={{ background: SIMILAR }}
                          />
                          <code className="flex-1 break-all">{target?.title || s.id}</code>
                          <span className="flex-shrink-0 text-muted-foreground">
                            {s.score.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Knowledge article — rendered inline (expand) or in a large modal. */}
              {projectId && articleUrl(ARTICLE_BASE, projectId, selectedNode) && (
                <div className="border-t border-border pt-2">
                  <div className="mb-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowArticleInline((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    >
                      {showArticleInline ? '▾ Knowledge article' : '▸ Knowledge article'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setArticleNode(selectedNode)}
                      className="text-xs text-muted-foreground underline hover:text-foreground"
                    >
                      expand ↗
                    </button>
                  </div>
                  {showArticleInline && (
                    <div className="max-h-[340px] overflow-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                      <ArticleBody url={articleUrl(ARTICLE_BASE, projectId, selectedNode)!} />
                    </div>
                  )}
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
          ) : (
            <div className="space-y-3 text-xs">
              <div className="text-muted-foreground">
                Click a node to inspect — or scan the insights below.
              </div>
              {integrity && (
                <div
                  className={`rounded-md border p-2 ${
                    integrity.tone === 'fail'
                      ? 'border-warning/50 bg-warning/10'
                      : integrity.tone === 'pass'
                        ? 'border-success/40 bg-success/10'
                        : 'border-border bg-muted/30'
                  }`}
                >
                  <div className="font-semibold text-foreground">{integrity.label}</div>
                  <div className="text-muted-foreground">{integrity.detail}</div>
                </div>
              )}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                    Knowledge coverage
                  </span>
                  <span>{coverage.coveragePct}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-accent-blue"
                    style={{ width: `${coverage.coveragePct}%` }}
                  />
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {coverage.filesWithArticle}/{coverage.files} files documented
                </div>
              </div>
              {archInsights?.godNodes?.length ? (
                <div>
                  <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
                    God-nodes (centrality)
                  </div>
                  <div className="space-y-0.5">
                    {archInsights.godNodes.slice(0, 8).map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          const n = snapshot?.nodes.find((x) => x.id === g.id);
                          if (n) setSelectedNode(n);
                        }}
                        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/40"
                      >
                        <code className="flex-1 break-all">{g.title}</code>
                        <span className="flex-shrink-0 text-muted-foreground">
                          {g.centrality.toFixed(0)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {archInsights?.communities?.length ? (
                <div>
                  <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
                    Communities ({archInsights.communities.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {archInsights.communities.map((c) => (
                      <span
                        key={c.community}
                        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
                        title={`community ${c.community}`}
                      >
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: communityColor(c.community) }}
                        />
                        {c.count}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </aside>
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

      {/* ── Epic 2 — "Dead code / unreferenced" + orphan-invariant status ── */}
      {snapshot && (
        <DeadCodePanel
          deadCode={deadCode}
          integrity={integrity}
          fileColor={NODE_COLORS_BY_KIND.file ?? NODE_COLORS_BY_KIND.unknown}
          onSelect={(nodeId) => {
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node) setSelectedNode(node);
          }}
        />
      )}

      {/* ── Epic 3 — Architectural X-ray: god-nodes, communities, bridges ── */}
      {snapshot && (
        <ArchXrayPanel
          insights={archInsights}
          overlayEnabled={overlayEnabled}
          onToggleOverlay={setOverlayEnabled}
          onSelect={(nodeId) => {
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node) setSelectedNode(node);
          }}
        />
      )}

      {/* ── Epic 5 — Capability coverage gaps (W8, --global federation) ──── */}
      {snapshot && (
        <CapabilityGapPanel
          report={capabilityGaps}
          onSelect={(nodeId) => {
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node) setSelectedNode(node);
          }}
        />
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

      {/* Inline knowledge-article viewer (rendered markdown). */}
      {articleNode && projectId && articleUrl(ARTICLE_BASE, projectId, articleNode) && (
        <ArticleViewer
          url={articleUrl(ARTICLE_BASE, projectId, articleNode)!}
          rawUrl={articleUrl(ARTICLE_BASE, projectId, articleNode)!}
          title={articleNode.title || articleNode.id}
          onClose={() => setArticleNode(null)}
        />
      )}
    </div>
  );
}
