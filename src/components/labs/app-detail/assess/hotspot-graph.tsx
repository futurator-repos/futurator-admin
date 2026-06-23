'use client';

/**
 * Refactoring Assessment — Graph subtab (reuses the shared GraphCanvas).
 *
 * Derives a FOCUSED graph from the recon hotspots already on the job/audit row
 * (no new backend transport, and far more readable than the raw 4307-node
 * graphify dump): each hotspot becomes a cluster — a center node (the god-object
 * class, or a synthetic group for duplicates/design-system/low-cohesion) linked
 * to its implicated files. Reuses GraphCanvas so the same renderer powers the
 * Development graph and this view.
 */

import { useMemo, useState } from 'react';
import {
  GraphCanvas,
  type CanvasNode,
  type CanvasLink,
} from '@/components/development/graph-canvas';
import type { AuditHotspot } from '@/types/refactor-audit';

/** Map a hotspot's center node to a catalog `kind` (drives colour/shape). */
function centerKind(kind: AuditHotspot['kind']): string {
  if (kind === 'god-object') return 'class';
  return 'dir'; // duplicate-subsystem / design-system / low-cohesion / dead-code group
}

/** Build a focused {nodes, links} from the hotspots. Pure + exported for tests. */
export function buildHotspotGraph(hotspots: AuditHotspot[]): {
  nodes: CanvasNode[];
  links: CanvasLink[];
} {
  const nodes = new Map<string, CanvasNode>();
  const links: CanvasLink[] = [];
  const addFile = (path: string) => {
    if (!nodes.has(path)) {
      nodes.set(path, {
        id: path,
        kind: 'file',
        type: 'file',
        title: path.split('/').pop() || path,
      });
    }
  };

  hotspots.forEach((h, i) => {
    const files = (h.files || []).filter(Boolean);
    if (h.kind === 'god-object' && files.length === 1) {
      // a single class node — no synthetic group.
      const id = files[0];
      nodes.set(id, {
        id,
        kind: 'class',
        type: 'class',
        title: h.title.replace(/^God-object:\s*/, ''),
      });
      return;
    }
    // synthetic cluster center → its files (star).
    const centerId = `hotspot:${i}:${h.kind}`;
    nodes.set(centerId, { id: centerId, kind: centerKind(h.kind), type: h.kind, title: h.title });
    for (const f of files.slice(0, 40)) {
      // file entries may be "path (N files)" for version roots — keep the path part.
      const path = f.split('  (')[0];
      addFile(path);
      links.push({ source: centerId, target: path, type: 'CONTAINS' });
    }
  });

  return { nodes: [...nodes.values()], links };
}

export function HotspotGraph({ hotspots }: { hotspots: AuditHotspot[] }) {
  const data = useMemo(() => buildHotspotGraph(hotspots), [hotspots]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(1);

  if (data.nodes.length === 0) {
    return (
      <div
        style={{
          padding: 14,
          fontSize: 12,
          color: 'var(--text-dim)',
          border: '1px dashed var(--border)',
          borderRadius: 10,
        }}
      >
        No graph to draw — no hotspots in this assessment.
      </div>
    );
  }

  return (
    <div data-testid="hotspot-graph" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {data.nodes.length} nodes · {data.links.length} edges — hotspot clusters and their files
        </span>
        <div style={{ flex: 1 }} />
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
          height: 520,
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
      {selectedId && (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          selected: {selectedId}
        </div>
      )}
    </div>
  );
}

const EMPTY_SET = new Set<string>();
