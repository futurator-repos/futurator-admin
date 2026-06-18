'use client';

/**
 * CapabilityGapPanel — Epic 5, Story 5.3 (PRD §7.4.2 / W8). The visible end of
 * "the manual capability seam must not rot silently": a collapsible panel
 * listing components that touch a shared contract but carry NO
 * IMPLEMENTS→capability tag (`knowledge/_graph/capability-gaps.json`).
 *
 * Presentational only — the parent (graph-viewer) owns fetching + node
 * selection. Additive to the Graph tab, alongside the dead-code + arch-xray
 * panels (the story's other panels are a forbidden area).
 */

import { useState } from 'react';
import type { CapabilityGapReport } from '@/lib/graph-insights';

export interface CapabilityGapPanelProps {
  report: CapabilityGapReport | null;
  /** Inspect a node by its graph nodeId (parent resolves it in the snapshot). */
  onSelect?: (nodeId: string) => void;
}

export function CapabilityGapPanel({ report, onSelect }: CapabilityGapPanelProps) {
  const [open, setOpen] = useState(false);

  // No report at all (single-project sync, or no --global run yet) → render
  // nothing; this panel is meaningful only once the federation pass has run.
  if (!report) return null;

  const count = report.gapCount ?? report.gaps.length;
  const badgeClass = count === 0 ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning';

  return (
    <div className="rounded-md border border-border bg-card" data-testid="capability-gap-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="font-semibold">{open ? '▾' : '▸'} Capability coverage gaps</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
          {count}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          components touching a shared contract with no capability tag — the manual seam, audited
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          {count === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No coverage gaps — every component that touches a shared contract is tagged with a
              capability.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto">
              {report.gaps.map((g) => (
                <button
                  key={g.nodeId}
                  type="button"
                  onClick={() => onSelect?.(g.nodeId)}
                  className="flex w-full items-baseline gap-3 border-t border-border px-4 py-2 text-left text-xs first:border-t-0 hover:bg-muted/40"
                  title="Click to inspect this node"
                >
                  <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-warning" />
                  <code className="flex-shrink-0 break-all">{g.title || g.nodeId}</code>
                  <span className="ml-auto flex-shrink-0 text-muted-foreground">
                    {g.contractTouches} contract{g.contractTouches === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
