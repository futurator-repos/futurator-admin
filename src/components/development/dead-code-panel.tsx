'use client';

/**
 * DeadCodePanel — Epic 2, Story 2.4. The visible end of the "no alone dots"
 * guarantee: a collapsible side panel listing dead-code candidates from the
 * latest sync (`knowledge/_graph/dead-code.json`) plus the orphan-invariant
 * status badge (`orphans.json`).
 *
 * Presentational only — the parent (graph-viewer) owns fetching and node
 * selection. Kept out of the canvas/graph render path on purpose (additive
 * panel, per the story's forbidden areas).
 */

import { useState } from 'react';
import type { DeadCodeReport, IntegrityHeadline } from '@/lib/graph-insights';

export interface DeadCodePanelProps {
  deadCode: DeadCodeReport | null;
  integrity: IntegrityHeadline;
  /** Inspect a node by its graph nodeId (parent resolves it in the snapshot). */
  onSelect?: (nodeId: string) => void;
  /** Marker color for a file node (reuses the viewer's palette). */
  fileColor?: string;
}

export function DeadCodePanel({
  deadCode,
  integrity,
  onSelect,
  fileColor = '#3b82f6',
}: DeadCodePanelProps) {
  const [open, setOpen] = useState(false);
  const count = deadCode?.count ?? 0;

  const badgeClass =
    integrity.tone === 'fail'
      ? 'bg-destructive/15 text-destructive'
      : integrity.tone === 'pass'
        ? 'bg-success/15 text-success'
        : 'bg-muted text-muted-foreground';

  return (
    <div className="rounded-md border border-border bg-card" data-testid="dead-code-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="font-semibold">
          {open ? '▾' : '▸'} Dead code / unreferenced ({count})
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}
          title={integrity.detail}
        >
          {integrity.label}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          files whose only edge is containment — candidates for removal, never auto-pruned
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          {count === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No dead code detected — every file is referenced or references something live.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto">
              {deadCode!.candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect?.(c.id)}
                  className="flex w-full items-baseline gap-3 border-t border-border px-4 py-2 text-left text-xs first:border-t-0 hover:bg-muted/40"
                  title="Click to inspect this node"
                >
                  <span
                    className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: fileColor }}
                  />
                  <code className="flex-shrink-0 break-all">{c.title || c.id}</code>
                  {c.updated && (
                    <span className="ml-auto flex-shrink-0 text-muted-foreground">
                      updated {c.updated}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
