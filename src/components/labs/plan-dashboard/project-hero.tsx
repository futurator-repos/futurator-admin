'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { DashboardPlan } from './adapter';
import { PLAN_STATUS_META } from './constants';
import { useAttentionItems } from '@/hooks/use-attention-items';
import { AttentionDock } from './attention-dock';

export function ProjectHero({
  plan,
  pct,
}: {
  plan: DashboardPlan;
  /** Plan-level progress percentage (from aggregatePlan). */
  pct: number;
}) {
  // Pipeline Enhancement Plan v2 — Phase B: bell opens the right-side dock.
  const attention = useAttentionItems(plan.id);
  const unresolvedCount = attention.data?.unresolvedCount || 0;
  const [dockOpen, setDockOpen] = useState(false);
  const meta = PLAN_STATUS_META[plan.status];
  const totalStories = plan.epics.reduce(
    (n, e) => n + e.waves.reduce((m, w) => m + w.stories.length, 0),
    0,
  );
  const doneStories = plan.epics.reduce(
    (n, e) =>
      n + e.waves.reduce((m, w) => m + w.stories.filter((s) => s.status === 'done').length, 0),
    0,
  );
  return (
    <div style={{ padding: '28px 0 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          color: 'var(--text-faint)',
          marginBottom: 18,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <Link
          href="/labs/"
          style={{
            color: 'var(--text-faint)',
            textDecoration: 'none',
          }}
        >
          ← Labs
        </Link>
        <span>/</span>
        <span>Plans</span>
        <span>/</span>
        <span style={{ color: 'var(--text-dim)' }}>{plan.name}</span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 28,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 320 }}>
          <h2
            style={{
              fontSize: 56,
              fontWeight: 200,
              color: 'var(--foreground)',
              letterSpacing: '-0.02em',
              lineHeight: 1,
              margin: 0,
              fontFamily: 'var(--font-sans)',
            }}
          >
            {plan.name}
          </h2>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginTop: 14,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: meta.color,
                textTransform: 'uppercase',
                letterSpacing: '0.22em',
                padding: '4px 10px',
                borderRadius: 2,
                border: `1px solid ${meta.color}55`,
                background: `color-mix(in srgb, ${meta.color} 5%, transparent)`,
              }}
            >
              {meta.label}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                letterSpacing: '0.04em',
              }}
            >
              {plan.path}
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 32,
            alignItems: 'center',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <HeroMetric label="Stories" value={`${doneStories}/${totalStories}`} />
          <HeroMetric label="Progress" value={`${Math.round(pct)}%`} />
          <HeroMetric label="Cost" value={`$${plan.totalCost.toFixed(2)}`} color="var(--amber)" />
          <AttentionBell count={unresolvedCount} onClick={() => setDockOpen(true)} />
        </div>
      </div>

      <AttentionDock planId={plan.id} open={dockOpen} onClose={() => setDockOpen(false)} />
    </div>
  );
}

function AttentionBell({ count, onClick }: { count: number; onClick: () => void }) {
  const active = count > 0;
  return (
    <button
      type="button"
      aria-label={active ? `${count} unresolved attention items` : 'No attention items'}
      disabled={!active}
      onClick={onClick}
      style={{
        position: 'relative',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 6,
        width: 38,
        height: 38,
        cursor: active ? 'pointer' : 'default',
        color: active ? 'var(--amber)' : 'var(--text-faint)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {active && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: -6,
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            background: 'var(--amber)',
            color: 'var(--background)',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            lineHeight: '18px',
            textAlign: 'center',
            fontWeight: 600,
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

function HeroMetric({
  label,
  value,
  color = 'var(--foreground)',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div
        style={{
          fontSize: 8,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          color,
          fontWeight: 300,
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
    </div>
  );
}
