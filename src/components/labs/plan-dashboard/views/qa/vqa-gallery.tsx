'use client';

/**
 * Visual QA gallery — full-page grid of every screenshot the QA agent
 * captured (overview + per-test). Filter chips (all / failures only).
 * Thumbnails annotated with VT id + pass/fail border + story chip.
 *
 * Click a failing thumb → drawer. Click a passing thumb → lightbox.
 */

import { useState } from 'react';
import type { VqaExecuteStatus, VqaRollup, VqaTestResult } from '@/types/qa-report';

type Filter = 'all' | 'failures';

interface Props {
  rollup: VqaRollup;
  onSelectFailure: (t: VqaTestResult) => void;
}

export function VqaGallery({ rollup, onSelectFailure }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Use the full per-test result list (`results`) — `thumbnails` is the
  // 6-cap strip surfaced in the pillar card and would silently truncate
  // the gallery (was the cause of "0/8 pending" header but ALL (6) chip).
  // Fall back to `thumbnails` for older payloads, then to `failures`.
  const allThumbs =
    rollup.results && rollup.results.length > 0
      ? rollup.results
      : rollup.thumbnails.length > 0
        ? rollup.thumbnails
        : rollup.failures;
  const shown = filter === 'failures' ? allThumbs.filter((t) => t.status === 'fail') : allThumbs;

  if (rollup.total === 0 && !rollup.overviewUrl) return null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Visual QA gallery
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          {rollup.pass} pass · {rollup.fail} fail · {rollup.pending} pending
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <FilterChip
            label={`All (${allThumbs.length})`}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <FilterChip
            label={`Failures (${rollup.failures.length})`}
            active={filter === 'failures'}
            onClick={() => setFilter('failures')}
            disabled={rollup.failures.length === 0}
          />
        </div>
      </div>

      <div style={{ padding: 14 }}>
        {rollup.overviewUrl && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                color: 'var(--text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.22em',
                marginBottom: 6,
              }}
            >
              Overview
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={rollup.overviewUrl}
              alt="overview"
              onClick={() => rollup.overviewUrl && setLightboxUrl(rollup.overviewUrl)}
              style={{
                width: '100%',
                maxHeight: 260,
                objectFit: 'contain',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'zoom-in',
                display: 'block',
              }}
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
            />
          </div>
        )}

        {shown.length === 0 ? (
          <div
            style={{
              padding: 28,
              textAlign: 'center',
              color: 'var(--text-mute)',
              fontSize: 12,
            }}
          >
            {filter === 'failures' ? '— no failures —' : '— no visual tests captured —'}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 10,
            }}
          >
            {shown.map((t) => (
              <Thumb
                key={`${t.epicId}-${t.testId}`}
                thumb={t}
                executeStatus={rollup.executeStatus}
                onClick={() => {
                  if (t.status === 'fail') onSelectFailure(t);
                  else if (t.screenshotUrl) setLightboxUrl(t.screenshotUrl);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxUrl(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 400,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            cursor: 'zoom-out',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="screenshot"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: '100%', maxWidth: '100%', borderRadius: 6 }}
          />
        </div>
      )}
    </div>
  );
}

function Thumb({
  thumb,
  executeStatus,
  onClick,
}: {
  thumb: VqaTestResult;
  executeStatus: VqaExecuteStatus;
  onClick: () => void;
}) {
  // Color by status: pending = amber (no screenshot yet), pass = green, fail = red.
  // 'never-run' pendings are grey instead of amber — nothing is in flight,
  // there's just no data yet.
  const borderColor =
    thumb.status === 'pending'
      ? executeStatus === 'never-run'
        ? 'var(--border-2)'
        : 'var(--warning)'
      : thumb.status === 'pass'
        ? 'var(--success)'
        : 'var(--destructive)';
  // Pending badge is honest about why a screenshot is missing:
  //   queued-contract → 'awaiting review' (operator must approve the gate)
  //   queued-execute  → 'queued'          (daemon hasn't started yet)
  //   running         → 'running'         (qa-execute in flight)
  //   never-run       → 'no run'          (no QA initiated)
  //   rejected        → 'skipped'         (operator declined)
  //   done            → 'pending'         (rare: per-test pending in a
  //                                        completed run — judge no-result)
  const badgeLabel =
    thumb.status === 'pending'
      ? executeStatus === 'queued-contract'
        ? 'awaiting review'
        : executeStatus === 'queued-execute'
          ? 'queued'
          : executeStatus === 'running'
            ? 'running'
            : executeStatus === 'never-run'
              ? 'no run'
              : executeStatus === 'rejected'
                ? 'skipped'
                : 'pending'
      : thumb.status === 'pass'
        ? 'pass'
        : 'fail';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 10',
          background: 'var(--background)',
          overflow: 'hidden',
        }}
      >
        {thumb.screenshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb.screenshotUrl}
            alt={thumb.testId}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-faint)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            no screenshot
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            top: 6,
            left: 6,
            padding: '2px 6px',
            borderRadius: 2,
            background: 'color-mix(in srgb, var(--background) 70%, transparent)',
            backdropFilter: 'blur(4px)',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--foreground)',
            letterSpacing: '0.04em',
          }}
        >
          {thumb.testId}
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 6,
            right: 6,
            padding: '2px 6px',
            borderRadius: 2,
            background: `color-mix(in srgb, ${borderColor} 22%, transparent)`,
            border: `1px solid ${borderColor}`,
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: borderColor,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            fontWeight: 600,
          }}
        >
          {badgeLabel}
        </div>
      </div>
      <div
        style={{
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-mute)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        <span>{thumb.storyId}</span>
      </div>
    </button>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '5px 10px',
        border: `1px solid ${active ? 'var(--foreground)' : 'var(--border-2)'}`,
        borderRadius: 2,
        background: active
          ? 'color-mix(in srgb, var(--foreground) 6%, transparent)'
          : 'transparent',
        color: active ? 'var(--foreground)' : 'var(--text-dim)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
}
