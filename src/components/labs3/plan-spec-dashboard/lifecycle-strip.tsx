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
 * headless QA tests against.
 *
 * CLICKABLE (2026-07-06 — legacy parity): each stage navigates to the Labs3
 * subtab that shows it, mirroring the legacy plan-dashboard's clickable
 * pipeline stages. `onSelectStage` is optional so the component still renders
 * pure/presentational when the caller has no navigation to offer.
 */

import type { Plan, PlanStatus } from '@/types/plan';
import { qaReadiness, type QaReadiness } from '@/hooks/use-p3-qa-report';
import type { Labs3Subtab } from './constants';

type StageState = 'done' | 'active' | 'pending';

interface Stage {
  id: string;
  label: string;
  sub: string;
  /** The Labs3 subtab this stage navigates to when clicked. */
  subtab: Labs3Subtab;
}

const STAGES: Stage[] = [
  { id: 'concept', label: 'Concept', sub: 'intent → plan', subtab: 'plan-stage' },
  { id: 'development', label: 'Development', sub: 'stories build', subtab: 'stories' },
  { id: 'qa', label: 'QA Review', sub: 'assembled + tested', subtab: 'qa' },
  { id: 'deployed', label: 'Deployed', sub: 'promoted live', subtab: 'deploy' },
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

/**
 * The QA REVIEW stage sub-label + dot color reflect the deployed-app QA
 * readiness (the FROZEN CONTRACT isDeliverable rule) once the plan has reached
 * that stage — verified/blocking/unverified, not merely "assembled + tested".
 * Returns null when the stage hasn't been reached (keeps the default label).
 */
export function qaStageOverride(
  plan: Plan,
  stageReached: boolean,
): { sub: string; color: string } | null {
  if (!stageReached) return null;
  const readiness: QaReadiness = qaReadiness({
    qaVerifiedAt: plan.qaVerifiedAt,
    p3QaVerdict: plan.p3QaVerdict,
  });
  switch (readiness) {
    case 'verified':
      return { sub: 'QA verified', color: 'var(--success)' };
    case 'blocking':
      return { sub: 'QA blocking', color: 'var(--destructive)' };
    default:
      return { sub: 'QA unverified', color: 'var(--warning)' };
  }
}

/**
 * The DEPLOYED stage sub-label + dot color reflect real deploy state once
 * reached, replacing the previously-static 'promoted live' string. Kept
 * purely plan-row-driven (design U5-override): `plan.deployUrl` present is
 * the sole live signal available on the row today — richer promoting/failed
 * states are DeployView's job (B/A5 slice), this override only upgrades the
 * "it's actually live" case. Returns null (falls back to the default label)
 * when the stage hasn't been reached or no deploy URL exists yet.
 */
export function deployStageOverride(
  plan: Plan,
  stageReached: boolean,
): { sub: string; color: string } | null {
  if (!stageReached) return null;
  if (plan.deployUrl) return { sub: 'live · open ↗', color: 'var(--success)' };
  return null;
}

export function LifecycleStrip({
  plan,
  onSelectStage,
}: {
  plan: Plan;
  /** Navigate to the subtab that shows this stage (legacy pipeline parity). */
  onSelectStage?: (subtab: Labs3Subtab) => void;
}) {
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
        // QA REVIEW stage reflects deployed-app QA readiness once reached;
        // DEPLOYED stage reflects real deploy state once reached.
        const qaOv = s.id === 'qa' ? qaStageOverride(plan, i <= active) : null;
        const deployOv = s.id === 'deployed' ? deployStageOverride(plan, i <= active) : null;
        const ov = qaOv ?? deployOv;
        const c = ov ? ov.color : COLOR[st];
        const subLabel = ov ? ov.sub : s.sub;
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
              role={onSelectStage ? 'button' : undefined}
              tabIndex={onSelectStage ? 0 : undefined}
              onClick={onSelectStage ? () => onSelectStage(s.subtab) : undefined}
              onKeyDown={
                onSelectStage
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectStage(s.subtab);
                      }
                    }
                  : undefined
              }
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '8px 14px',
                borderRadius: 7,
                minWidth: 150,
                cursor: onSelectStage ? 'pointer' : undefined,
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
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{subLabel}</span>
                {link && (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
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
