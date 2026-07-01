'use client';

import Link from 'next/link';
import type { PlanWithEpics } from '@/hooks/use-plans';
import type { StoryGraphModel } from './adapter';
import { PLAN_STATUS_META } from '@/components/labs/plan-dashboard/constants';

/**
 * Labs3 project hero — mirrors legacy ProjectHero (breadcrumb · oversized
 * wordmark · plan-status pill · metric rail) but the metrics are rolled up
 * from the StoryNode graph model rather than the epic→wave tree. Cost still
 * comes from the canonical plan row. No attention-bell — that surface belongs
 * to the legacy attention-item model.
 */
export function ProjectHero({ plan, model }: { plan: PlanWithEpics; model: StoryGraphModel }) {
  const name = plan.displayName || plan.name;
  const meta = PLAN_STATUS_META[plan.status] ?? { label: plan.status, color: 'var(--text-mute)' };

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
        <Link href="/labs/" style={{ color: 'var(--text-faint)', textDecoration: 'none' }}>
          ← Labs
        </Link>
        <span>/</span>
        <span>Plan Spec</span>
        <span>/</span>
        <span style={{ color: 'var(--text-dim)' }}>{name}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, flexWrap: 'wrap' }}>
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
            {name}
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
              {plan.workingDir}
            </span>
          </div>
        </div>

        <div
          style={{ display: 'flex', gap: 32, alignItems: 'center', fontFamily: 'var(--font-mono)' }}
        >
          <HeroMetric label="Stories" value={`${model.done}/${model.total}`} />
          <HeroMetric label="Progress" value={`${model.pct}%`} />
          <HeroMetric label="Frontier" value={String(model.frontier.length)} />
          <HeroMetric
            label="Cost"
            value={`$${(plan.totalCostUsd ?? 0).toFixed(2)}`}
            color="var(--amber)"
          />
        </div>
      </div>
    </div>
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
      <div style={{ fontSize: 22, color, fontWeight: 300, letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}
