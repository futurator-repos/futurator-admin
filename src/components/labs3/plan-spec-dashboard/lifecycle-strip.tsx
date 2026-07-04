'use client';

/**
 * LifecycleStrip — the plan-level lifecycle (QA-Review W1).
 *
 * The four macro-stages of a P3 plan, above the batch-level PipelineStrip:
 *
 *   CONCEPT ─── DEVELOPMENT ─── QA REVIEW ─── DEPLOYED
 *
 * Driven purely by `plan.status` (the daemon's P3_LIFECYCLE driver advances it:
 * concept→developing→review; a production deploy → delivered). When a dev
 * preview exists the QA REVIEW stage grows an "Open dev ↗" link — the exact URL
 * headless QA tests against. Pure/presentational; no data fetching.
 */

import type { Plan, PlanStatus } from '@/types/plan';

type StageState = 'done' | 'active' | 'pending';

interface Stage {
  id: string;
  label: string;
  sub: string;
}

const STAGES: Stage[] = [
  { id: 'concept', label: 'Concept', sub: 'intent → plan' },
  { id: 'development', label: 'Development', sub: 'stories build' },
  { id: 'qa', label: 'QA Review', sub: 'assembled + tested' },
  { id: 'deployed', label: 'Deployed', sub: 'promoted live' },
];

/** Map plan.status → the index of the CURRENTLY-active lifecycle stage. */
export function activeStageIndex(status: PlanStatus): number {
  switch (status) {
    case 'concept':
      return 0;
    case 'developing':
    case 'fixing':
      return 1;
    case 'review':
      return 2;
    case 'delivered':
      return 3;
    default:
      return 0; // archived / unknown → show at concept
  }
}

function stateFor(i: number, active: number): StageState {
  if (i < active) return 'done';
  if (i === active) return 'active';
  return 'pending';
}

const COLOR: Record<StageState, string> = {
  done: 'var(--success)',
  active: 'var(--accent-blue)',
  pending: 'var(--text-faint)',
};

export function LifecycleStrip({ plan }: { plan: Plan }) {
  const active = activeStageIndex(plan.status);
  const devUrl = plan.devUrl;
  const liveUrl = plan.deployUrl;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 6,
        margin: '4px 0 14px',
        flexWrap: 'wrap',
      }}
    >
      {STAGES.map((s, i) => {
        const st = stateFor(i, active);
        const c = COLOR[st];
        // Contextual affordance: the QA stage surfaces the dev preview link; the
        // Deployed stage surfaces the live link.
        const link =
          s.id === 'qa' && devUrl
            ? { href: devUrl, text: 'Open dev ↗' }
            : s.id === 'deployed' && liveUrl
              ? { href: liveUrl, text: 'Open live ↗' }
              : null;
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '8px 14px',
                borderRadius: 7,
                minWidth: 150,
                border: `1px solid color-mix(in srgb, ${c} ${st === 'pending' ? 30 : 55}%, transparent)`,
                background: `color-mix(in srgb, ${c} ${st === 'active' ? 12 : 5}%, transparent)`,
                opacity: st === 'pending' ? 0.55 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: c,
                    flexShrink: 0,
                    ...(st === 'active' ? { animation: 'pulse 1.4s infinite' } : {}),
                  }}
                />
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--foreground)',
                    fontWeight: st === 'active' ? 600 : 400,
                  }}
                >
                  {s.label}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{s.sub}</span>
                {link && (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      color: 'var(--accent-blue)',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {link.text}
                  </a>
                )}
              </div>
            </div>
            {i < STAGES.length - 1 && (
              <span style={{ color: 'var(--text-faint)', fontSize: 12, flexShrink: 0 }}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
