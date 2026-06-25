'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { forceX, forceY, forceCollide } from 'd3-force';
import {
  communityColor,
  edgeMeta,
  kindMeta,
  laneX,
  LANES,
  roleColor,
  type LayoutMode,
  type NodeShape,
} from '@/lib/graph/catalog';
import { getIconImage } from '@/lib/graph/icons';
import { computeCommunityHulls } from '@/lib/graph/analysis';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const SIMILAR = '#e879f9'; // magenta — semantic neighbours of the selected node

export interface CanvasNode {
  id: string;
  kind?: string;
  type: string;
  title: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}
export interface CanvasLink {
  source: string | CanvasNode;
  target: string | CanvasNode;
  type: string;
}
export interface NodeMetric {
  centrality?: number | null;
  community?: number | null;
  /** architecture/privacy role for the Roles overlay: infra|db|ai|thirdParty. */
  role?: string | null;
}

interface FGInstance {
  d3Force: (
    name: string,
    force?: unknown,
  ) => { strength?: (v: number) => void; distance?: (v: number) => void } | null;
  d3ReheatSimulation: () => void;
  zoomToFit: (ms?: number, px?: number) => void;
}

export interface GraphCanvasProps {
  data: { nodes: CanvasNode[]; links: CanvasLink[] };
  layout: LayoutMode;
  fitToken: number;
  metrics: Record<string, NodeMetric>;
  maxCentrality: number;
  /** colour by community + size by centrality */
  xray: boolean;
  /** when 'role', colour lit nodes by their architecture/privacy role instead of community. */
  colorBy?: 'community' | 'role';
  /** translucent community blobs behind the graph */
  zones: boolean;
  searchMatch: { matchIds: Set<string>; neighborIds: Set<string> } | null;
  similarSet: Set<string>;
  selectedId: string | null;
  onSelect: (node: CanvasNode | null) => void;
  onHover?: (node: CanvasNode | null) => void;
}

function endpointId(v: string | CanvasNode): string {
  return typeof v === 'object' ? v.id : v;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: NodeShape,
  x: number,
  y: number,
  r: number,
) {
  ctx.beginPath();
  switch (shape) {
    case 'roundRect': {
      const s = r * 1.7;
      const rad = Math.min(3, s / 4);
      const left = x - s / 2;
      const top = y - s / 2;
      ctx.moveTo(left + rad, top);
      ctx.arcTo(left + s, top, left + s, top + s, rad);
      ctx.arcTo(left + s, top + s, left, top + s, rad);
      ctx.arcTo(left, top + s, left, top, rad);
      ctx.arcTo(left, top, left + s, top, rad);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      const s = r * 1.4;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      break;
    }
    case 'hex': {
      const s = r * 1.25;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + s * Math.cos(a);
        const py = y + s * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'doc': {
      const w = r * 1.5;
      const h = r * 1.9;
      const fold = r * 0.55;
      ctx.moveTo(x - w / 2, y - h / 2);
      ctx.lineTo(x + w / 2 - fold, y - h / 2);
      ctx.lineTo(x + w / 2, y - h / 2 + fold);
      ctx.lineTo(x + w / 2, y + h / 2);
      ctx.lineTo(x - w / 2, y + h / 2);
      ctx.closePath();
      break;
    }
    default:
      ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
}

/** Reactively track the app's dark/light class on <html>. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const read = () => setDark(document.documentElement.classList.contains('dark'));
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function GraphCanvas(props: GraphCanvasProps) {
  const {
    data,
    layout,
    fitToken,
    metrics,
    maxCentrality,
    xray,
    colorBy = 'community',
    zones,
    searchMatch,
    similarSet,
    selectedId,
    onSelect,
    onHover,
  } = props;
  const fgRef = useRef<FGInstance | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const dark = useIsDark();

  const theme = useMemo(
    () =>
      dark
        ? {
            dim: 'rgba(148,163,184,0.10)',
            stroke: 'rgba(255,255,255,0.55)',
            icon: '#ffffff',
            label: 'rgba(226,232,240,0.92)',
            labelBg: 'rgba(8,12,20,0.78)',
            zoneCore: '33',
            contain: 'rgba(148,163,184,0.18)',
          }
        : {
            dim: 'rgba(100,116,139,0.12)',
            stroke: 'rgba(15,23,42,0.45)',
            icon: '#1e293b',
            label: 'rgba(15,23,42,0.92)',
            labelBg: 'rgba(255,255,255,0.82)',
            zoneCore: '3a',
            contain: 'rgba(100,116,139,0.22)',
          },
    [dark],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setDims({ w: Math.floor(cr.width), h: Math.floor(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const communityOf = (n: CanvasNode): number | null | undefined => metrics[n.id]?.community;

  // Community centroids on a ring — drives the Community Orbit layout.
  const centroids = useMemo(() => {
    const comms = [
      ...new Set(data.nodes.map((n) => communityOf(n)).filter((c): c is number => c != null)),
    ].sort((a, b) => a - b);
    const R = Math.max(320, comms.length * 95);
    const map = new Map<number, { x: number; y: number }>();
    comms.forEach((c, i) => {
      const a = (i / Math.max(1, comms.length)) * 2 * Math.PI;
      map.set(c, { x: Math.cos(a) * R, y: Math.sin(a) * R });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, metrics]);

  // Configure d3 forces per layout, then reheat + fit.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    for (const n of data.nodes) {
      n.fx = undefined;
      n.fy = undefined;
    }
    const charge = fg.d3Force('charge');
    const link = fg.d3Force('link');
    if (layout === 'lanes') {
      for (const n of data.nodes) n.fx = laneX(kindMeta(n.kind, n.type).layer);
      charge?.strength?.(-34);
      link?.distance?.(34);
      link?.strength?.(0.12);
      fg.d3Force('x', null);
      fg.d3Force('y', forceY(0).strength(0.015));
      fg.d3Force('collide', forceCollide(3));
    } else if (layout === 'community') {
      charge?.strength?.(-32);
      link?.distance?.(16);
      link?.strength?.(0.05);
      fg.d3Force(
        'x',
        forceX((n: CanvasNode) => centroids.get(communityOf(n) ?? -1)?.x ?? 0).strength(0.45),
      );
      fg.d3Force(
        'y',
        forceY((n: CanvasNode) => centroids.get(communityOf(n) ?? -1)?.y ?? 0).strength(0.45),
      );
      fg.d3Force('collide', forceCollide(4));
    } else {
      charge?.strength?.(-70);
      link?.distance?.(34);
      fg.d3Force('x', null);
      fg.d3Force('y', null);
      fg.d3Force('collide', forceCollide(2));
    }
    fg.d3ReheatSimulation();
    const t = setTimeout(() => fg.zoomToFit(500, 70), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, data, centroids]);

  useEffect(() => {
    if (fitToken > 0) fgRef.current?.zoomToFit(500, 70);
  }, [fitToken]);

  const isLit = (id: string): boolean => {
    if (!searchMatch) return true;
    return searchMatch.matchIds.has(id) || searchMatch.neighborIds.has(id);
  };

  const radiusFor = (n: CanvasNode): number => {
    const meta = kindMeta(n.kind, n.type);
    let r = meta.base;
    if (xray && maxCentrality > 0)
      r = meta.base + ((metrics[n.id]?.centrality ?? 0) / maxCentrality) * 16;
    if (searchMatch?.matchIds.has(n.id)) r *= 2.0;
    if (selectedId === n.id) r = Math.max(r, 8);
    return r;
  };

  const colorFor = (n: CanvasNode): string => {
    if (!isLit(n.id)) return theme.dim;
    if (!searchMatch && similarSet.has(n.id)) return SIMILAR;
    // Roles overlay: colour by architecture/privacy role (infra/db/ai/thirdParty);
    // role-less nodes stay dim so the tagged classes stand out.
    if (colorBy === 'role') return roleColor(metrics[n.id]?.role) ?? theme.dim;
    const comm = communityOf(n);
    if ((xray || layout === 'community') && comm != null) return communityColor(comm);
    return kindMeta(n.kind, n.type).color;
  };

  const nodePaint = (raw: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = raw as CanvasNode;
    const meta = kindMeta(n.kind, n.type);
    const r = radiusFor(n);
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const lit = isLit(n.id);
    ctx.globalAlpha = 1;
    if (!lit) {
      drawShape(ctx, meta.shape, x, y, r);
      ctx.fillStyle = theme.dim;
      ctx.fill();
      return;
    }
    // selection / similarity ring
    if (selectedId === n.id) {
      drawShape(ctx, meta.shape, x, y, r + 4);
      ctx.lineWidth = 1.8 / globalScale;
      ctx.strokeStyle = '#38e0d2';
      ctx.stroke();
    } else if (!searchMatch && similarSet.has(n.id)) {
      drawShape(ctx, meta.shape, x, y, r + 4);
      ctx.lineWidth = 1.4 / globalScale;
      ctx.strokeStyle = SIMILAR;
      ctx.stroke();
    }
    // body
    drawShape(ctx, meta.shape, x, y, r);
    ctx.fillStyle = colorFor(n);
    ctx.fill();
    ctx.lineWidth = 0.6 / globalScale;
    ctx.strokeStyle = theme.stroke;
    ctx.stroke();
    // icon when on-screen radius is big enough
    if (r * globalScale > 3.5) {
      const img = getIconImage(meta.icon, theme.icon);
      if (img && img.complete && img.naturalWidth) {
        const s = r * 1.35;
        ctx.globalAlpha = 0.92;
        try {
          ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
        } catch {
          /* image not ready */
        }
        ctx.globalAlpha = 1;
      }
    }
    // label
    const matched = !!searchMatch?.matchIds.has(n.id);
    if (matched || selectedId === n.id || globalScale > 1.7 || (xray && r > 14)) {
      const fontSize = Math.max(2.6, 10 / globalScale);
      ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = n.title || n.id;
      const padY = r + 1.5;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = theme.labelBg;
      ctx.fillRect(x - tw / 2 - 1.5, y + padY - 0.5, tw + 3, fontSize + 1.5);
      ctx.fillStyle = matched ? '#67e8f9' : theme.label;
      ctx.fillText(label, x, y + padY);
    }
  };

  const nodePointerPaint = (raw: object, color: string, ctx: CanvasRenderingContext2D) => {
    const n = raw as CanvasNode;
    const meta = kindMeta(n.kind, n.type);
    ctx.fillStyle = color;
    drawShape(ctx, meta.shape, n.x ?? 0, n.y ?? 0, radiusFor(n) + 2);
    ctx.fill();
  };

  const linkColor = (raw: object): string => {
    const e = raw as CanvasLink;
    const s = endpointId(e.source);
    const t = endpointId(e.target);
    if (searchMatch && !(isLit(s) && isLit(t))) return theme.dim;
    if (e.type === 'CONTAINS') return theme.contain;
    return edgeMeta(e.type).color;
  };
  const linkWidth = (raw: object): number => ((raw as CanvasLink).type === 'CONTAINS' ? 0.4 : 0.9);

  // Community zones (and lane headers) painted behind the graph.
  const renderPre = (ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (zones) {
      const hulls = computeCommunityHulls(data.nodes, communityOf);
      for (const h of hulls) {
        const col = communityColor(h.community);
        const grad = ctx.createRadialGradient(h.cx, h.cy, h.r * 0.15, h.cx, h.cy, h.r);
        grad.addColorStop(0, col + theme.zoneCore);
        grad.addColorStop(1, col + '00');
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, h.r, 0, 2 * Math.PI);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }
    if (layout === 'lanes') {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const n of data.nodes) {
        if (n.y == null) continue;
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
      }
      if (!isFinite(minY)) {
        minY = -200;
        maxY = 200;
      }
      const fontSize = 13 / globalScale;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui`;
      ctx.fillStyle = theme.label;
      for (const lane of LANES) {
        const x = laneX(lane.layer);
        ctx.fillText(lane.label, x, minY - 60);
      }
      ctx.restore();
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {dims.w > 0 && (
        <ForceGraph2D
          ref={fgRef as never}
          width={dims.w}
          height={dims.h}
          graphData={data as never}
          nodeId="id"
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={140}
          d3VelocityDecay={0.28}
          linkCurvature={0.18}
          nodeCanvasObject={nodePaint as never}
          nodePointerAreaPaint={nodePointerPaint as never}
          onRenderFramePre={renderPre as never}
          linkColor={linkColor as never}
          linkWidth={linkWidth as never}
          linkDirectionalArrowLength={3.2}
          linkDirectionalArrowRelPos={0.96}
          linkDirectionalArrowColor={linkColor as never}
          nodeLabel={
            ((raw: object) => {
              const n = raw as CanvasNode;
              return `${n.title} (${n.kind ?? n.type})`;
            }) as never
          }
          onNodeClick={((raw: object) => onSelect(raw as CanvasNode)) as never}
          onNodeHover={
            ((raw: object | null) => onHover?.(raw ? (raw as CanvasNode) : null)) as never
          }
          onBackgroundClick={(() => onSelect(null)) as never}
        />
      )}
    </div>
  );
}
