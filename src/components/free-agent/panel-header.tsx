/**
 * panel-header.tsx — Story 18.4 (Epic 18: Free Claude Code Agent),
 *                    extended in Story 18.5 with real model selector + cost editor.
 *
 * Top bar of the expanded chat panel:
 *   - Lens label: `Assistant — <scope-label>`
 *   - Model selector dropdown (Haiku / Sonnet / Opus) — last-used-sticky via localStorage
 *   - Live cost-burn readout with inline cap editor (click → type → enter)
 *   - Hamburger menu (placeholder, Story 18.6)
 *   - Close button
 *
 * Scope-change callout (Story 18.4) remains.
 */

'use client';

import { useState, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { useFreeAgentStore } from '@/stores/free-agent-store';
import { formatScopeLabel } from './use-free-agent-scope';
import { ThreadListDropdown } from './thread-list-dropdown';

interface FreeAgentPanelHeaderProps {
  /** Story 18.5 — live state piped from useFreeAgentSession. */
  costUsdAccumulated?: number;
  costCapUsd?: number;
  currentModel?: string;
  onChangeModel?: (model: string) => void;
  onChangeCostCap?: (capUsd: number) => void;
  /** Story 18.6 — thread-list dropdown actions. */
  onLoadSession?: (sessionId: string) => void;
  onNewConversation?: () => void;
  /** True while a daemon turn is in flight — drives the activity strip. */
  isProcessing?: boolean;
}

const MODEL_OPTIONS: Array<{ value: string; label: string; fullId: string }> = [
  { value: 'haiku', label: 'Haiku (fast/cheap)', fullId: 'claude-haiku-4-5' },
  { value: 'sonnet', label: 'Sonnet (default)', fullId: 'claude-sonnet-4-6' },
  { value: 'opus', label: 'Opus (deep work)', fullId: 'claude-opus-4-7' },
];

export function FreeAgentPanelHeader({
  costUsdAccumulated = 0,
  costCapUsd = 10,
  currentModel = 'sonnet',
  onChangeModel,
  onChangeCostCap,
  onLoadSession,
  onNewConversation,
  isProcessing = false,
}: FreeAgentPanelHeaderProps = {}) {
  const scope = useFreeAgentStore((s) => s.currentScope);
  const close = useFreeAgentStore((s) => s.close);
  const scopeChanged = useFreeAgentStore((s) => s.scopeChangedSinceLastSend);
  const acknowledgeScopeChange = useFreeAgentStore((s) => s.acknowledgeScopeChange);

  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState<string>(costCapUsd.toFixed(2));

  const label = formatScopeLabel(scope);
  const utilization = costCapUsd > 0 ? costUsdAccumulated / costCapUsd : 0;
  const capColor =
    utilization >= 1
      ? 'text-red-500'
      : utilization >= 0.8
        ? 'text-amber-500'
        : 'text-muted-foreground';

  const handleCapKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const parsed = Number.parseFloat(capDraft);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) {
        onChangeCostCap?.(parsed);
      }
      setEditingCap(false);
    } else if (e.key === 'Escape') {
      setCapDraft(costCapUsd.toFixed(2));
      setEditingCap(false);
    }
  };

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
          {/* Model selector — Story 18.5 AC #4 */}
          <select
            aria-label="Model selector"
            data-testid="free-agent-model-selector"
            value={currentModel}
            onChange={(e) => onChangeModel?.(e.target.value)}
            className="rounded border bg-background px-1 py-0.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} title={opt.fullId}>
                {opt.value}
              </option>
            ))}
          </select>

          {/* Cost-burn + inline cap editor — Story 18.5 AC #7, #8 */}
          {editingCap ? (
            <span className="flex items-center gap-1 font-mono text-[11px]">
              <span className={capColor}>${costUsdAccumulated.toFixed(2)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-muted-foreground">$</span>
              <input
                aria-label="Cost cap"
                data-testid="free-agent-cost-cap-input"
                type="number"
                step="0.01"
                min="0.01"
                max="1000"
                value={capDraft}
                onChange={(e) => setCapDraft(e.target.value)}
                onKeyDown={handleCapKeyDown}
                onBlur={() => {
                  setCapDraft(costCapUsd.toFixed(2));
                  setEditingCap(false);
                }}
                autoFocus
                className="w-16 rounded border bg-background px-1 py-0 text-[11px]"
              />
            </span>
          ) : (
            <button
              type="button"
              aria-label="Edit cost cap"
              data-testid="free-agent-cost-display"
              onClick={() => {
                setCapDraft(costCapUsd.toFixed(2));
                setEditingCap(true);
              }}
              className={`font-mono text-[11px] hover:underline ${capColor}`}
              title="Click to edit cost cap"
            >
              ${costUsdAccumulated.toFixed(2)} / ${costCapUsd.toFixed(2)}
            </button>
          )}

          {/* Story 18.6 — real thread-list dropdown (replaces placeholder). */}
          {onLoadSession && onNewConversation ? (
            <ThreadListDropdown
              onLoadSession={onLoadSession}
              onNewConversation={onNewConversation}
            />
          ) : null}
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

      {isProcessing && (
        <div
          className="flex items-center gap-2 border-t border-[color:var(--accent-blue,#3b82f6)]/30 bg-[color:var(--accent-blue,#3b82f6)]/10 px-3 py-1"
          data-testid="free-agent-processing-strip"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3 w-3 animate-spin text-[color:var(--accent-blue,#3b82f6)]" />
          <span className="text-[11px] text-[color:var(--accent-blue,#3b82f6)]">
            {currentModel.charAt(0).toUpperCase() + currentModel.slice(1)} is working…
          </span>
        </div>
      )}

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

      {/* Budget-exhausted callout — Story 18.5 AC #8 */}
      {utilization >= 1 && (
        <div
          className="flex items-center justify-between gap-2 border-t border-red-500/30 bg-red-500/10 px-3 py-1.5"
          data-testid="free-agent-budget-exhausted-callout"
        >
          <span className="text-[11px] text-red-700 dark:text-red-300">
            Budget exhausted — raise cap or end session
          </span>
        </div>
      )}
    </div>
  );
}
