'use client';

/**
 * Refactoring Assessment — Graph subtab. Renders the REAL graphify analysis: the
 * file-level code graph (alias-resolved import edges + Leiden communities) the
 * daemon projects to S3 (knowledge-live/<appId>/_refactor/graph.json). Reuses the
 * shared GraphCanvas. Hotspots are a FILTER/overlay over the real structure
 * (full graph · highlight hotspots · hotspots-only), not the graph itself.
 *
 * Falls back to the hotspot-cluster sketch (buildHotspotGraph) when the S3 graph
 * isn't available yet (pre-deploy audits, or upload failed) — with a note.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GraphCanvas,
  type CanvasNode,
  type CanvasLink,
  type NodeMetric,
} from '@/components/development/graph-canvas';
import type { AuditHotspot } from '@/types/refactor-audit';
import { buildHotspotGraph } from './hotspot-graph';

const S3_BASE = 'https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live';

interface UiGraphNode {
  id: string;
  title: string;
  community: number | null;
  fanIn: number;
  hotspotKinds: string[];
  isHotspot: boolean;
}
interface UiGraph {
  nodeCount: number;
  edgeCount: number;
  communities: number;
  capped: boolean;
  totalFiles: number;
  nodes: UiGraphNode[];
  links: { source: string; target: string; type: string }[];
}

type FilterMode = 'full' | 'highlight' | 'only';

export function RefactorGraph({
  appId,
  hotspots,
  graphAvailable,
}: {
  appId: string;
  hotspots: AuditHotspot[];
  graphAvailable?: boolean;
}) {
  const [mode, setMode] = useState<FilterMode>('highlight');
  const [zones, setZones] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(1);

  const { data: graph, isLoading } = useQuery({
    queryKey: ['refactor-graph', appId],
    queryFn: async (): Promise<UiGraph | null> => {
      const res = await fetch(
        `${S3_BASE}/${encodeURIComponent(appId)}/_refactor/graph.json?t=${Date.now()}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as UiGraph;
    },
    enabled: !!appId && graphAvailable !== false,
    staleTime: 60_000,
    retry: false,
  });

  // Build CanvasNode/CanvasLink + metrics (community colour + fan-in size) from
  // the real graph, applying the hotspot filter.
  const view = useMemo(() => {
    if (!graph) return null;
    const hotspotIds = new Set(graph.nodes.filter((n) => n.isHotspot).map((n) => n.id));
    // neighbours of hotspot nodes (for highlight + hotspots-only context)
    const neighborIds = new Set<string>();
    for (const l of graph.links) {
      if (hotspotIds.has(l.source)) neighborIds.add(l.target);
      if (hotspotIds.has(l.target)) neighborIds.add(l.source);
    }

    let nodes = graph.nodes;
    let links = graph.links;
    if (mode === 'only') {
      const keep = new Set<string>([...hotspotIds, ...neighborIds]);
      nodes = nodes.filter((n) => keep.has(n.id));
      links = links.filter((l) => keep.has(l.source) && keep.has(l.target));
    }

    const canvasNodes: CanvasNode[] = nodes.map((n) => ({
      id: n.id,
      kind: 'file',
      type: 'file',
      title: n.title,
    }));
    const canvasLinks: CanvasLink[] = links.map((l) => ({
      source: l.source,
      target: l.target,
      type: l.type,
    }));
    const metrics: Record<string, NodeMetric> = {};
    let maxCentrality = 1;
    for (const n of nodes) {
      metrics[n.id] = { community: n.community, centrality: n.fanIn };
      if (n.fanIn > maxCentrality) maxCentrality = n.fanIn;
    }
    const searchMatch = mode === 'highlight' ? { matchIds: hotspotIds, neighborIds } : null;
    return {
      data: { nodes: canvasNodes, links: canvasLinks },
      metrics,
      maxCentrality,
      searchMatch,
      hotspotCount: hotspotIds.size,
    };
  }, [graph, mode]);

  // ── Fallback: no real graph yet → the hotspot-cluster sketch. ──
  if (!isLoading && !graph) {
    const fallback = buildHotspotGraph(hotspots);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--warning)' }}>
          Full code graph not available for this audit yet — showing hotspot clusters. Re-assess to
          generate the graphify code graph (communities + import edges).
        </div>
        <FallbackCanvas data={fallback} />
      </div>
    );
  }

  if (isLoading || !view) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>Loading code graph…</div>
    );
  }

  return (
    <div data-testid="refactor-graph" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {graph!.nodeCount} files · {graph!.edgeCount} imports · {graph!.communities} communities ·{' '}
          {view.hotspotCount} hotspot files
          {graph!.capped ? ` (capped from ${graph!.totalFiles})` : ''}
        </span>
        <div style={{ flex: 1 }} />
        {/* hotspot filter */}
        <div
          style={{
            display: 'inline-flex',
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          {(
            [
              ['full', 'Full graph'],
              ['highlight', 'Highlight hotspots'],
              ['only', 'Hotspots only'],
            ] as [FilterMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              data-testid={`graph-filter-${m}`}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: mode === m ? 'var(--background)' : 'var(--text-dim)',
                background: mode === m ? 'var(--foreground)' : 'transparent',
                border: 'none',
                padding: '4px 10px',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} />{' '}
          communities
        </label>
        <button
          type="button"
          onClick={() => setFitToken((t) => t + 1)}
          style={{
            fontSize: 11,
            color: 'var(--foreground)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 9px',
            cursor: 'pointer',
          }}
        >
          Fit
        </button>
      </div>
      <div
        style={{
          height: 560,
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--bg-elev)',
          overflow: 'hidden',
        }}
      >
        <GraphCanvas
          data={view.data}
          layout="force"
          fitToken={fitToken}
          metrics={view.metrics}
          maxCentrality={view.maxCentrality}
          xray
          zones={zones}
          searchMatch={view.searchMatch}
          similarSet={EMPTY_SET}
          selectedId={selectedId}
          onSelect={(n) => setSelectedId(n?.id ?? null)}
        />
      </div>
      {selectedId && (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          {selectedId}
          {(() => {
            const n = graph!.nodes.find((x) => x.id === selectedId);
            return n
              ? ` — community ${n.community ?? '?'} · fan-in ${n.fanIn}${n.hotspotKinds.length ? ` · ${n.hotspotKinds.join(', ')}` : ''}`
              : '';
          })()}
        </div>
      )}
    </div>
  );
}

function FallbackCanvas({ data }: { data: { nodes: CanvasNode[]; links: CanvasLink[] } }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(1);
  if (data.nodes.length === 0) {
    return (
      <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)' }}>
        No hotspots to graph.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        onClick={() => setFitToken((t) => t + 1)}
        style={{
          alignSelf: 'flex-end',
          fontSize: 11,
          color: 'var(--foreground)',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 9px',
          cursor: 'pointer',
        }}
      >
        Fit
      </button>
      <div
        style={{
          height: 480,
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--bg-elev)',
          overflow: 'hidden',
        }}
      >
        <GraphCanvas
          data={data}
          layout="force"
          fitToken={fitToken}
          metrics={{}}
          maxCentrality={1}
          xray={false}
          zones={false}
          searchMatch={null}
          similarSet={EMPTY_SET}
          selectedId={selectedId}
          onSelect={(n) => setSelectedId(n?.id ?? null)}
        />
      </div>
    </div>
  );
}

const EMPTY_SET = new Set<string>();
