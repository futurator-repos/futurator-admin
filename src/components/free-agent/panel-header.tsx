/**
 * panel-header.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Top bar of the expanded chat panel:
 *   - Lens label: `Assistant — <scope-label>`
 *   - Placeholders for model selector (Story 18.5), cost-burn (Story 18.5),
 *     hamburger thread-list menu (Story 18.6).
 *   - Close button (X).
 *
 * AC #8 — when scope changes mid-session, the header shows a callout
 *         "Scope changed — start new conversation?"
 */

'use client';

import { X, MoreVertical } from 'lucide-react';
import { useFreeAgentStore } from '@/stores/free-agent-store';
import { formatScopeLabel } from './use-free-agent-scope';

export function FreeAgentPanelHeader() {
  const scope = useFreeAgentStore((s) => s.currentScope);
  const close = useFreeAgentStore((s) => s.close);
  const scopeChanged = useFreeAgentStore((s) => s.scopeChangedSinceLastSend);
  const acknowledgeScopeChange = useFreeAgentStore((s) => s.acknowledgeScopeChange);

  const label = formatScopeLabel(scope);

  return (
    <div className="flex flex-col border-b bg-muted/30">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="truncate text-sm font-medium text-foreground"
            data-testid="free-agent-lens-label"
            title={`Assistant — ${label}`}
          >
            Assistant — {label}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Model selector placeholder — Story 18.5 */}
          <span
            className="rounded border bg-background px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
            title="Model selector (Story 18.5)"
          >
            model
          </span>
          {/* Cost-burn placeholder — Story 18.5 */}
          <span
            className="font-mono text-[11px] text-muted-foreground"
            title="Cost burn (Story 18.5)"
          >
            $0.00 / $10.00
          </span>
          {/* Hamburger placeholder — Story 18.6 */}
          <button
            type="button"
            aria-label="Conversation menu"
            disabled
            title="Conversation list (Story 18.6)"
            className="rounded p-1 text-muted-foreground opacity-50 hover:bg-muted"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {/* Close */}
          <button
            type="button"
            aria-label="Close free agent"
            data-testid="free-agent-close"
            onClick={close}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {scopeChanged && (
        <div
          className="flex items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5"
          data-testid="free-agent-scope-changed-callout"
        >
          <span className="text-[11px] text-amber-700 dark:text-amber-300">
            Scope changed — start new conversation?
          </span>
          <button
            type="button"
            onClick={acknowledgeScopeChange}
            className="rounded border border-amber-500/40 bg-background px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
          >
            Start new
          </button>
        </div>
      )}
    </div>
  );
}
