'use client';

/**
 * "What's shipping" card — the release summary snapshot. Lives right below
 * the release strip. Shows plan identity + rigor + stories + cost + QA
 * verdict snapshot + 3 passing screenshots. Links back to QA Review for
 * drill-down.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import type { DeployHandoff } from '@/types/deploy-report';
import type { PlanQaVerdict } from '@/types/qa-report';

const QA_COLOR: Record<PlanQaVerdict, string> = {
  ready: 'var(--success)',
  'needs-attention': 'var(--warning)',
  blocking: 'var(--destructive)',
  'not-run': 'var(--text-mute)',
};

export function WhatsShipping({ handoff }: { handoff: DeployHandoff }) {
  const router = useRouter();
  const params = useSearchParams();

  function openQa() {
    const sp = new URLSearchParams(params.toString());
    sp.set('stage', 'qa');
    router.replace(`/labs/?${sp.toString()}`);
  }

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '18px 20px',
        display: 'flex',
        gap: 20,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 260 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            marginBottom: 6,
          }}
        >
          What&apos;s shipping
        </div>
        <div
          style={{
            fontSize: 17,
            fontWeight: 400,
            color: 'var(--foreground)',
            letterSpacing: '-0.005em',
            marginBottom: 4,
          }}
        >
          {handoff.displayName || handoff.planName}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.04em',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span>
            {handoff.stories.done}/{handoff.stories.total} stories
          </span>
          <span>·</span>
          <span style={{ color: 'var(--amber)' }}>${handoff.costUsd.toFixed(2)}</span>
          <span>·</span>
          <span>
            Rigor <code style={{ color: 'var(--text-dim)' }}>{handoff.rigor}</code>
          </span>
          <span>·</span>
          <span style={{ color: QA_COLOR[handoff.qaVerdict] }}>
            QA {handoff.qaVerdict.replace('-', ' ')}
          </span>
        </div>
      </div>

      {handoff.thumbnailUrls.length > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          {handoff.thumbnailUrls.map((url, i) => (
            <div
              key={url + i}
              style={{
                width: 72,
                height: 48,
                borderRadius: 3,
                border: '1px solid var(--success)',
                overflow: 'hidden',
                background: 'var(--surface)',
                flexShrink: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt="passing screenshot"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
              />
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={openQa}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          padding: '6px 12px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          color: 'var(--text-dim)',
          background: 'transparent',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        View QA Report
        <ArrowUpRight size={11} />
      </button>
    </div>
  );
}
