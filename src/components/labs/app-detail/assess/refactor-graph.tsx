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
import { useSearchParams } from 'next/navigation';
import {
  GraphCanvas,
  type CanvasNode,
  type CanvasLink,
  type NodeMetric,
} from '@/components/development/graph-canvas';
import { ROLE_META, type GraphRole } from '@/lib/graph/catalog';
import type { AuditHotspot } from '@/types/refactor-audit';
import { useScanReport, type ScanDimension, type ScanFinding } from '@/hooks/use-scan-engine';
import { buildHotspotGraph } from './hotspot-graph';

const S3_BASE = 'https://futurator-knowledge-live-eu.s3.eu-central-1.amazonaws.com/knowledge-live';

// ── Finding-lenses (C-LENS): highlight nodes by assessment concern. ──
// A lens either maps to a finding dimension (severity-weighted score) or to a
// structural property of the node (infra/ai role, test path, git churn).
type LensKey =
  | 'security'
  | 'compliance'
  | 'infra'
  | 'ai'
  | 'tests'
  | 'architecture'
  | 'code-quality'
  | 'correctness'
  | 'churn';

const LENS_META: Record<LensKey, { label: string; color: string; dimension?: ScanDimension }> = {
  security: { label: 'Security', color: '#ef4444', dimension: 'safety-security' },
  compliance: { label: 'Compliance', color: '#eab308', dimension: 'compliance' },
  infra: { label: 'Infrastructure', color: '#f59e0b' },
  ai: { label: 'AI', color: '#a855f7' },
  tests: { label: 'Tests', color: '#10b981' },
  architecture: { label: 'Architecture', color: '#3b82f6', dimension: 'architecture' },
  'code-quality': {
    label: 'Code quality',
    color: '#06b6d4',
    dimension: 'code-quality-refactoring',
  },
  correctness: { label: 'Correctness', color: '#ec4899', dimension: 'correctness' },
  churn: { label: 'Churn', color: '#f97316' },
};
const LENS_KEYS = Object.keys(LENS_META) as LensKey[];

/** dimension → the lens that owns it (for colouring per-finding rows). */
const DIM_LENS: Partial<Record<ScanDimension, LensKey>> = {
  'safety-security': 'security',
  compliance: 'compliance',
  architecture: 'architecture',
  'code-quality-refactoring': 'code-quality',
  correctness: 'correctness',
};

const SEV_WEIGHT: Record<ScanFinding['severity'], number> = {
  High: 3,
  Medium: 2,
  'Low–Med': 1.5,
  Low: 1,
};

const TEST_RE = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\//;

/** relative path of a finding location ("path:line[:col]" → "path"). */
function locPath(loc: string): string {
  return loc.split(':')[0];
}

function parseLensParam(raw: string | null): Set<LensKey> {
  const out = new Set<LensKey>();
  if (!raw) return out;
  for (const t of raw.split(',')) {
    const k = t.trim();
    if (k && k in LENS_META) out.add(k as LensKey);
  }
  return out;
}

interface UiProvider {
  provider: string;
  kind: string;
  residency: string;
}
interface UiGraphNode {
  id: string;
  title: string;
  community: number | null;
  fanIn: number;
  hotspotKinds: string[];
  isHotspot: boolean;
  // architecture/privacy role from the shared detectors (graph-ui.json):
  role?: string | null;
  roleKinds?: string[];
  providers?: UiProvider[];
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
  const [colorBy, setColorBy] = useState<'community' | 'role'>('community');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(1);

  // C-LENS: multi-select finding-lenses, preselectable via ?lens=a,b (deep-link).
  const searchParams = useSearchParams();
  const [lenses, setLenses] = useState<Set<LensKey>>(() =>
    parseLensParam(searchParams.get('lens')),
  );
  const toggleLens = (k: LensKey) =>
    setLenses((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Full scan report (findings + infra + gitEvolution) — same hook the assess
  // tab uses; drives the lens projection below.
  const { data: report } = useScanReport(appId);

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
    const roleCounts: Partial<Record<GraphRole, number>> = {};
    for (const n of nodes) {
      metrics[n.id] = { community: n.community, centrality: n.fanIn, role: n.role ?? null };
      if (n.fanIn > maxCentrality) maxCentrality = n.fanIn;
      if (n.role && n.role in ROLE_META)
        roleCounts[n.role as GraphRole] = (roleCounts[n.role as GraphRole] ?? 0) + 1;
    }
    const searchMatch = mode === 'highlight' ? { matchIds: hotspotIds, neighborIds } : null;
    return {
      data: { nodes: canvasNodes, links: canvasLinks },
      metrics,
      maxCentrality,
      searchMatch,
      hotspotCount: hotspotIds.size,
      roleCounts,
    };
  }, [graph, mode]);

  // ── C-LENS: project the scan findings onto the graph nodes by file path. ──
  // Matching nodes glow (module colour, intensity ∝ severity-weighted score);
  // non-matching nodes dim (handled in GraphCanvas). Union across selected lenses.
  const lensView = useMemo(() => {
    if (!graph || lenses.size === 0) return null;
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

    // findings grouped by file (relative path) for per-file lists + dim scores.
    const findingsByFile = new Map<string, ScanFinding[]>();
    for (const f of report?.findings ?? []) {
      const p = locPath(f.location);
      const arr = findingsByFile.get(p);
      if (arr) arr.push(f);
      else findingsByFile.set(p, [f]);
    }

    // infra / AI service files from the infra inventory.
    const infraFiles = new Set<string>();
    const aiServiceFiles = new Set<string>();
    for (const s of report?.infra?.services ?? []) {
      for (const file of s.files ?? []) {
        infraFiles.add(file);
        if (s.kind === 'ai') aiServiceFiles.add(file);
      }
    }
    const churnByFile = report?.gitEvolution?.churnByFile ?? {};

    // raw score for one node under one lens (0 = no match).
    const scoreFor = (nodeId: string, lens: LensKey): number => {
      const meta = LENS_META[lens];
      if (meta.dimension) {
        let s = 0;
        for (const f of findingsByFile.get(nodeId) ?? [])
          if (f.dimension === meta.dimension) s += SEV_WEIGHT[f.severity] ?? 1;
        return s;
      }
      const node = nodeById.get(nodeId);
      if (lens === 'infra') {
        const roleHit =
          node?.role === 'infra' ||
          node?.role === 'db' ||
          !!node?.roleKinds?.some((k) => k === 'infra' || k === 'db');
        return roleHit || infraFiles.has(nodeId) ? 1 : 0;
      }
      if (lens === 'ai') return node?.role === 'ai' || aiServiceFiles.has(nodeId) ? 1 : 0;
      if (lens === 'tests') return TEST_RE.test(nodeId) ? 1 : 0;
      if (lens === 'churn') return churnByFile[nodeId] ?? 0;
      return 0;
    };

    const selected = LENS_KEYS.filter((k) => lenses.has(k));

    // per-lens raw max, to normalise glow intensity across nodes.
    const lensMax: Partial<Record<LensKey, number>> = {};
    for (const k of selected) {
      let m = 0;
      for (const n of graph.nodes) m = Math.max(m, scoreFor(n.id, k));
      lensMax[k] = m;
    }

    const color: Record<string, string> = {};
    const score: Record<string, number> = {};
    const litFilesByLens: Record<string, Set<string>> = {};
    for (const k of selected) litFilesByLens[k] = new Set();

    for (const n of graph.nodes) {
      let bestIntensity = 0;
      let chosen: LensKey | null = null;
      for (const k of selected) {
        const raw = scoreFor(n.id, k);
        if (raw <= 0) continue;
        litFilesByLens[k].add(n.id);
        const max = lensMax[k] ?? 0;
        const norm = max > 0 ? raw / max : 1;
        // first matching lens (toolbar order) owns the colour; intensity = strongest.
        if (chosen == null) chosen = k;
        if (norm > bestIntensity) bestIntensity = norm;
      }
      if (chosen) {
        color[n.id] = LENS_META[chosen].color;
        score[n.id] = bestIntensity;
      }
    }

    const legend = selected.map((k) => {
      const meta = LENS_META[k];
      const findings = meta.dimension
        ? (report?.findings ?? []).filter((f) => f.dimension === meta.dimension).length
        : null;
      return {
        key: k,
        label: meta.label,
        color: meta.color,
        files: litFilesByLens[k].size,
        findings,
      };
    });

    // findings for the selected finding-dimension lenses whose file is NOT a node.
    const selectedDims = new Set(
      selected.map((k) => LENS_META[k].dimension).filter(Boolean) as ScanDimension[],
    );
    let notOnGraph = 0;
    if (selectedDims.size) {
      for (const f of report?.findings ?? [])
        if (selectedDims.has(f.dimension) && !nodeIds.has(locPath(f.location))) notOnGraph++;
    }

    return {
      overlay: { color, score },
      legend,
      notOnGraph,
      findingsByFile,
      selectedDims,
    };
  }, [graph, report, lenses]);

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
        {/* colour-by: community (Leiden) vs architecture/privacy role */}
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
              ['community', 'Communities'],
              ['role', 'Roles'],
            ] as ['community' | 'role', string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setColorBy(m)}
              data-testid={`graph-color-${m}`}
              title={
                m === 'role'
                  ? 'Colour by architecture/privacy role: infra · data store · AI · 3rd-party'
                  : 'Colour by Leiden community'
              }
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: colorBy === m ? 'var(--background)' : 'var(--text-dim)',
                background: colorBy === m ? 'var(--foreground)' : 'transparent',
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
        {/* C-LENS: multi-select finding-lenses (highlight nodes by concern) */}
        <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Lenses:</span>
          {LENS_KEYS.map((k) => {
            const on = lenses.has(k);
            const m = LENS_META[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleLens(k)}
                data-testid={`graph-lens-${k}`}
                title={`Highlight ${m.label} on the graph`}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: on ? '#fff' : 'var(--text-dim)',
                  background: on ? m.color : 'transparent',
                  border: `1px solid ${on ? m.color : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '3px 8px',
                  cursor: 'pointer',
                }}
              >
                {m.label}
              </button>
            );
          })}
          {lenses.size > 0 && (
            <button
              type="button"
              onClick={() => setLenses(new Set())}
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              clear
            </button>
          )}
        </div>
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
          colorBy={colorBy}
          zones={zones}
          lens={lensView?.overlay ?? null}
          searchMatch={lensView ? null : view.searchMatch}
          similarSet={EMPTY_SET}
          selectedId={selectedId}
          onSelect={(n) => setSelectedId(n?.id ?? null)}
        />
      </div>
      {/* role legend — only meaningful in the Roles overlay */}
      {colorBy === 'role' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11 }}>
          {(Object.keys(ROLE_META) as GraphRole[]).map((r) => (
            <span
              key={r}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                color: 'var(--text-dim)',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: ROLE_META[r].color,
                  display: 'inline-block',
                }}
              />
              {ROLE_META[r].label}
              {view.roleCounts[r] ? ` (${view.roleCounts[r]})` : ''}
            </span>
          ))}
          <span style={{ color: 'var(--text-dim)', opacity: 0.6 }}>· untagged = dim</span>
        </div>
      )}
      {/* C-LENS legend — per-lens file/finding counts + off-graph tally */}
      {lensView && lensView.legend.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11 }}>
          {lensView.legend.map((l) => (
            <span
              key={l.key}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                color: 'var(--text-dim)',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: l.color,
                  display: 'inline-block',
                }}
              />
              {l.label} ({l.files} file{l.files === 1 ? '' : 's'}
              {l.findings != null ? ` · ${l.findings} finding${l.findings === 1 ? '' : 's'}` : ''})
            </span>
          ))}
          {lensView.notOnGraph > 0 && (
            <span style={{ color: 'var(--warning)' }}>
              {lensView.notOnGraph} finding{lensView.notOnGraph === 1 ? '' : 's'} not on graph
            </span>
          )}
        </div>
      )}
      {/* C-LENS: findings on the clicked node for the active lens(es) */}
      {selectedId &&
        lensView &&
        (() => {
          const rows = (lensView.findingsByFile.get(selectedId) ?? []).filter(
            (f) => lensView.selectedDims.size === 0 || lensView.selectedDims.has(f.dimension),
          );
          if (rows.length === 0) return null;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
              <div style={{ color: 'var(--text-dim)', fontWeight: 600 }}>
                {rows.length} finding{rows.length === 1 ? '' : 's'} on {selectedId} (active lenses)
              </div>
              {rows.slice(0, 12).map((f) => (
                <div key={f.id} style={{ color: 'var(--text-dim)', display: 'flex', gap: 6 }}>
                  <span
                    style={{
                      color: LENS_META[DIM_LENS[f.dimension] ?? 'security'].color,
                      fontWeight: 600,
                      minWidth: 54,
                    }}
                  >
                    {f.severity}
                  </span>
                  <span>{f.issue}</span>
                </div>
              ))}
              {rows.length > 12 && (
                <div style={{ color: 'var(--text-dim)', opacity: 0.6 }}>
                  +{rows.length - 12} more…
                </div>
              )}
            </div>
          );
        })()}
      {selectedId && (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          {selectedId}
          {(() => {
            const n = graph!.nodes.find((x) => x.id === selectedId);
            if (!n) return '';
            const providers = (n.providers ?? []).map((p) => `${p.provider} [${p.residency}]`);
            return ` — community ${n.community ?? '?'} · fan-in ${n.fanIn}${
              n.role ? ` · role: ${n.role}` : ''
            }${providers.length ? ` · ${providers.join(', ')}` : ''}${
              n.hotspotKinds.length ? ` · ${n.hotspotKinds.join(', ')}` : ''
            }`;
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
