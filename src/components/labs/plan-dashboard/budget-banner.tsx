'use client';
/**
 * Budget warning banner — Pipeline Enhancement Plan v2, Phase D.1.
 *
 * Loud amber banner when plan.totalCostUsd > rigor-specific threshold.
 * Dismissible per-plan via sessionStorage so it doesn't re-appear on
 * every tab switch within the same session, but comes back on the next
 * session or next overrun beyond the dismissed level.
 */

import { useState } from 'react';
import type { PlanRigor } from '@/types/plan';

const THRESHOLDS: Record<PlanRigor, number> = {
  prototype: 5,
  mvp: 10,
  production: 25,
};

export function BudgetBanner({
  planId,
  rigor,
  totalCostUsd,
}: {
  planId: string;
  rigor?: PlanRigor;
  totalCostUsd: number;
}) {
  const threshold = THRESHOLDS[rigor || 'mvp'];
  const overBy = totalCostUsd - threshold;
  const isOver = overBy > 0;
  const storageKey = `budget-banner-dismissed:${planId}`;

  // Track the cost level at which the user last dismissed. Coming back over
  // the dismissed level re-surfaces the banner — so a $1.23 extra spend
  // after you dismissed at $12 will re-alarm at $13+.
  // Lazy init avoids setState-in-effect and is safe for SSR: the initializer
  // runs only on the client, and reading sessionStorage once on mount is
  // exactly the right shape for this kind of UI-only persistence.
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = window.sessionStorage.getItem(storageKey);
    return raw ? Number(raw) : null;
  });

  if (!isOver) return null;
  // Suppress if dismissed AND spend hasn't grown by more than $1 beyond the
  // dismissed level (tiny stream deltas shouldn't re-alarm constantly).
  if (dismissedAt !== null && totalCostUsd <= dismissedAt + 1) return null;

  const handleDismiss = () => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(storageKey, String(totalCostUsd));
    setDismissedAt(totalCostUsd);
  };

  return (
    <div
      role="alert"
      style={{
        margin: '16px 0 8px',
        padding: '12px 16px',
        background: 'color-mix(in srgb, var(--amber, #f59e0b) 12%, transparent)',
        border: '1px solid var(--amber, #f59e0b)',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        color: 'var(--foreground)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 16,
          color: 'var(--amber, #f59e0b)',
          lineHeight: 1,
        }}
      >
        ⚠
      </span>
      <div style={{ flex: 1, fontSize: 12, lineHeight: 1.45 }}>
        <strong style={{ color: 'var(--amber, #f59e0b)', letterSpacing: '0.05em' }}>
          BUDGET WARNING
        </strong>
        <span style={{ marginLeft: 10, color: 'var(--text-dim)' }}>
          This plan has spent <strong>${totalCostUsd.toFixed(2)}</strong> — over the{' '}
          {rigor || 'mvp'} threshold of <strong>${threshold.toFixed(2)}</strong> by $
          {overBy.toFixed(2)}.
        </span>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          padding: '5px 10px',
          border: '1px solid var(--amber, #f59e0b)',
          background: 'transparent',
          color: 'var(--amber, #f59e0b)',
          cursor: 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
