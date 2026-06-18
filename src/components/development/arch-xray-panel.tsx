'use client';

/**
 * ArchXrayPanel — Epic 3, Story 3.4. The human architectural overview:
 * god-nodes (centrality), a community legend (color), and the "surprising
 * connections" list (cross-community high-centrality bridges). Plus a toggle
 * to disable the canvas overlay and fall back to the plain kind-colored graph.
 *
 * Presentational only — the parent (graph-viewer) owns fetching `insights.json`,
 * the overlay-enabled state, and node selection. Additive to the page; it does
 * not replace the Story 2.4 dead-code panel.
 */

import { useState } from 'react';
import { communityColor, type ArchInsights } from '@/lib/graph-insights';

export interface ArchXrayPanelProps {
  insights: ArchInsights | null;
  overlayEnabled: boolean;
  onToggleOverlay: (enabled: boolean) => void;
  /** Inspect a node by its graph nodeId (parent resolves it in the snapshot). */
  onSelect?: (nodeId: string) => void;
}

export function ArchXrayPanel({
  insights,
  overlayEnabled,
  onToggleOverlay,
  onSelect,
}: ArchXrayPanelProps) {
  const [open, setOpen] = useState(false);

  const godNodes = insights?.godNodes ?? [];
  const communities = insights?.communities ?? [];
  const surprising = insights?.surprisingConnections ?? [];
  const mageAvailable = insights?.mageAvailable ?? false;

  return (
    <div className="rounded-md border border-border bg-card" data-testid="arch-xray-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="font-semibold">{open ? '▾' : '▸'} Architectural X-ray</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          god-nodes by centrality · communities by color · surprising connections
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-3 text-xs">
          {!mageAvailable ? (
            <p className="text-muted-foreground">
              No analytics for this project yet — the centrality/community pass runs on the next
              compile (it needs at least a few connected nodes). Until then the graph uses its plain
              kind-colored view.
            </p>
          ) : (
            <>
              {/* Overlay toggle */}
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={overlayEnabled}
                  onChange={(e) => onToggleOverlay(e.target.checked)}
                />
                <span>Overlay on graph (size = centrality, color = community)</span>
              </label>

              {/* Community legend */}
              {communities.length > 0 && (
                <div>
                  <div className="mb-1 font-semibold text-muted-foreground">Communities</div>
                  <div className="flex flex-wrap gap-2">
                    {communities.map((c) => (
                      <span key={c.community} className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: communityColor(c.community) }}
                        />
                        <span>
                          #{c.community} <span className="text-muted-foreground">({c.count})</span>
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* God-nodes */}
              {godNodes.length > 0 && (
                <div>
                  <div className="mb-1 font-semibold text-muted-foreground">
                    God-nodes (most structurally critical)
                  </div>
                  <div className="space-y-0.5">
                    {godNodes.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => onSelect?.(g.id)}
                        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/40"
                        title="Click to inspect this node"
                      >
                        <code className="break-all">{g.title || g.id}</code>
                        <span className="ml-auto flex-shrink-0 text-muted-foreground">
                          {g.centrality.toFixed(3)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Surprising connections */}
              <div>
                <div className="mb-1 font-semibold text-muted-foreground">
                  Surprising connections ({surprising.length})
                </div>
                {surprising.length === 0 ? (
                  <p className="text-muted-foreground">
                    No cross-community bridges between high-centrality nodes.
                  </p>
                ) : (
                  <div className="max-h-64 space-y-1 overflow-auto">
                    {surprising.map((s, i) => (
                      <div
                        key={`${s.source}->${s.target}-${i}`}
                        className="flex items-center gap-1.5 border-t border-border py-1 first:border-t-0"
                      >
                        <button
                          type="button"
                          onClick={() => onSelect?.(s.source)}
                          className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted/40"
                          title={`community #${s.sourceCommunity}`}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: communityColor(s.sourceCommunity) }}
                          />
                          <code className="break-all">{s.sourceTitle}</code>
                        </button>
                        <span className="flex-shrink-0 text-muted-foreground">─{s.type}→</span>
                        <button
                          type="button"
                          onClick={() => onSelect?.(s.target)}
                          className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted/40"
                          title={`community #${s.targetCommunity}`}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: communityColor(s.targetCommunity) }}
                          />
                          <code className="break-all">{s.targetTitle}</code>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
