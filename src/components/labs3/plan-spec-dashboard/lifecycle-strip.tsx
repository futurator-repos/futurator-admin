'use client';

/**
 * LifecycleStrip — the stage-first NAVIGATOR (design I8 v2).
 *
 * The five macro-stages of a P3 plan ARE the navigation:
 *
 *   CONCEPT ── DEVELOPMENT ── QA REVIEW ── DEPLOYMENT ── PUBLISH
 *
 * Every chip is ALWAYS a clickable button (selection ≠ progress). Each chip
 * carries TWO independent signals:
 *   · progress state (done / active / pending) — derived from `stageForStatus`
 *     ordering, so it reflects where the plan actually SITS.
 *   · selected ring + aria-current — reflects which stage panel is OPEN.
 *
 * The QA chip's sub-label reflects deployed-app QA readiness once reached; the
 * old single "Deployed" chip is split into DEPLOYMENT (dev → staging) and
 * PUBLISH (production live) variants, each with its own reached-state override.
 */

import type { Plan } from '@/types/plan';
import { qaReadiness, type QaReadiness } from '@/hooks/use-p3-qa-report';
import { STAGE_DEFS, stageForStatus, stageIndex, type Labs3Stage } from './constants';

type StageState = 'done' | 'active' | 'pending';

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
 * The DEPLOYMENT stage sub-label reflects the dev/staging preview once reached
 * — `plan.devUrl` present is the live signal that a dev preview exists (the
 * exact URL headless QA tests against). Returns null (default label) otherwise.
 */
export function deployStageOverride(
  plan: Plan,
  stageReached: boolean,
): { sub: string; color: string } | null {
  if (!stageReached) return null;
  if (plan.devUrl) return { sub: 'dev preview live', color: 'var(--success)' };
  return null;
}

/**
 * The PUBLISH stage sub-label reflects real production state once reached —
 * `plan.deployUrl` present is the sole "it's actually live" signal on the row.
 * Returns null (default 'promoted live') when not reached or not yet live.
 */
export function publishStageOverride(
  plan: Plan,
  stageReached: boolean,
): { sub: string; color: string } | null {
  if (!stageReached) return null;
  if (plan.deployUrl) return { sub: 'live · open ↗', color: 'var(--success)' };
  return null;
}

export function LifecycleStrip({
  plan,
  selectedStage,
  onSelectStage,
}: {
  plan: Plan;
  /** The stage whose panel is currently open — gets the selected ring. */
  selectedStage?: Labs3Stage;
  /** Navigate to a stage's panel. Optional → chips render presentational. */
  onSelectStage?: (stage: Labs3Stage) => void;
}) {
  const activeIdx = stageIndex(stageForStatus(plan.status, plan));
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
      {STAGE_DEFS.map((s, i) => {
        const st = stateFor(i, activeIdx);
        const reached = i <= activeIdx;
        const selected = selectedStage === s.id;

        const ov =
          s.id === 'qa'
            ? qaStageOverride(plan, reached)
            : s.id === 'deployment'
              ? deployStageOverride(plan, reached)
              : s.id === 'publish'
                ? publishStageOverride(plan, reached)
                : null;
        const c = ov ? ov.color : COLOR[st];
        const subLabel = ov ? ov.sub : s.sub;

        // Contextual affordances (only once the stage is reached): QA +
        // Deployment surface the dev preview link; Publish the production link.
        const link =
          reached && (s.id === 'qa' || s.id === 'deployment') && devUrl
            ? { href: devUrl, text: 'Open dev ↗' }
            : reached && s.id === 'publish' && liveUrl
              ? { href: liveUrl, text: 'Open live ↗' }
              : null;

        const ring = selected ? `0 0 0 1.5px var(--accent-blue)` : 'none';

        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ position: 'relative', display: 'flex' }}>
              <button
                type="button"
                onClick={onSelectStage ? () => onSelectStage(s.id) : undefined}
                disabled={!onSelectStage}
                aria-current={selected ? 'true' : undefined}
                aria-label={`${s.label} stage — ${subLabel}${selected ? ' (selected)' : ''}`}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '8px 14px',
                  borderRadius: 7,
                  minWidth: 150,
                  textAlign: 'left',
                  cursor: onSelectStage ? 'pointer' : 'default',
                  border: `1px solid color-mix(in srgb, ${c} ${st === 'pending' ? 30 : 55}%, transparent)`,
                  background: `color-mix(in srgb, ${c} ${selected ? 14 : st === 'active' ? 12 : 5}%, transparent)`,
                  boxShadow: ring,
                  opacity: st === 'pending' && !selected ? 0.6 : 1,
                  transition: 'box-shadow 150ms, background 150ms, opacity 150ms',
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
                      fontWeight: st === 'active' || selected ? 600 : 400,
                    }}
                  >
                    {s.label}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{subLabel}</span>
                  {/* reserve room so the overlaid anchor never clips the sublabel */}
                  {link && <span aria-hidden style={{ width: 64, flexShrink: 0 }} />}
                </div>
              </button>
              {/* External link as a DOM sibling (not nested in the button) so the
                  markup stays valid and clicking it never fires stage nav. */}
              {link && (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
                  style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 8,
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
            {i < STAGE_DEFS.length - 1 && (
              <span style={{ color: 'var(--text-faint)', fontSize: 12, flexShrink: 0 }}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
