'use client';

/**
 * DevUrlCard — QA-Review W2, top of the QA Review tab.
 *
 * Surfaces the exact dev-preview URL headless QA (Lane 1 journeys + Lane 2
 * VQA) ran against, pinned to the frozen commit (`plan.qaCommitSha`). Mirrors
 * the link affordance in `lifecycle-strip.tsx` (Open dev ↗) but promoted to a
 * standalone card since W2 is a dedicated tab, not a lifecycle sub-stage.
 *
 * Presentational only — no data fetching. `status` reflects the dev-preview
 * BUILD (deploying the static bundle to dev.futurator.ai/<appId>), not the
 * QA verdict (that's VerdictStrip's job).
 */

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';

export type DevPreviewStatus = 'deploying' | 'live' | 'failed';

export interface DevUrlCardProps {
  devUrl: string;
  qaCommitSha: string;
  status: DevPreviewStatus;
}

// ── Pure helpers (exported + unit-tested) ────────────────────────────

/** First 7 chars of a commit SHA — the conventional "short SHA" length. */
export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '—';
}

interface StatusMeta {
  label: string;
  color: string;
  help: string;
}

/** Maps a dev-preview build status to its display label/color/tooltip. */
export function devPreviewStatusMeta(status: DevPreviewStatus): StatusMeta {
  switch (status) {
    case 'live':
      return {
        label: 'Live',
        color: 'var(--success)',
        help: 'The dev preview is deployed and reachable at the URL below.',
      };
    case 'failed':
      return {
        label: 'Build failed',
        color: 'var(--destructive)',
        help: 'The dev-preview build failed — the link below may be stale or unreachable.',
      };
    case 'deploying':
    default:
      return {
        label: 'Deploying',
        color: 'var(--warning)',
        help: 'The dev preview is building — the link below is not ready yet.',
      };
  }
}

// ── Component ────────────────────────────────────────────────────────

export function DevUrlCard({ devUrl, qaCommitSha, status }: DevUrlCardProps) {
  const meta = devPreviewStatusMeta(status);
  const sha = shortSha(qaCommitSha);
  // Not-yet-live previews are visually de-emphasized but the href always
  // points at the exact URL QA ran against — never swapped for undefined.
  const notReady = status !== 'live';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '16px 20px',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Harness-ON badge */}
          <span
            title="The dev preview mounts window.__harness — QA drives it through reach/act/observe seams, not blind pixel scraping."
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--accent-blue)',
              border: '1px solid color-mix(in srgb, var(--accent-blue) 55%, transparent)',
              background: 'color-mix(in srgb, var(--accent-blue) 9%, transparent)',
              borderRadius: 3,
              padding: '2px 8px',
            }}
          >
            harness · ON
          </span>

          {/* Dev-preview build status badge */}
          <span
            title={meta.help}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: meta.color,
              border: `1px solid color-mix(in srgb, ${meta.color} 55%, transparent)`,
              background: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
              borderRadius: 3,
              padding: '2px 8px',
            }}
          >
            {status === 'deploying' && (
              <Loader2 size={10} className="animate-spin" aria-hidden data-testid="spinner" />
            )}
            {status === 'live' && <CheckCircle2 size={10} aria-hidden />}
            {status === 'failed' && <XCircle size={10} aria-hidden />}
            {meta.label}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)' }}>
            {sha}
          </code>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            QA ran against this frozen commit
          </span>
        </div>
      </div>

      {/* Primary "Open dev ↗" link — href is always the exact URL QA ran against. */}
      <a
        href={devUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={notReady ? 'The dev preview may not be ready yet' : 'Open the dev preview'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '0.02em',
          color: notReady ? 'var(--text-mute)' : 'var(--accent-blue)',
          textDecoration: 'none',
          border: `1px solid ${notReady ? 'var(--border-2)' : 'var(--accent-blue)'}`,
          background: notReady
            ? 'transparent'
            : 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
          borderRadius: 6,
          padding: '10px 18px',
          opacity: notReady ? 0.75 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        Open dev ↗
      </a>
    </div>
  );
}
