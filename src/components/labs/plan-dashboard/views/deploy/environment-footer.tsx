'use client';

/**
 * Environment footer — collapsed operator info. Shows the S3 bucket,
 * prefix, and CloudFront distribution for the current plan. Useful for
 * on-call debugging ("which bucket did we just push to?") but not primary
 * content — visually low-emphasis.
 */

import type { DeployTarget } from '@/types/deploy-report';

export function EnvironmentFooter({ target }: { target: DeployTarget }) {
  const rows: Array<{ label: string; value: string; code?: boolean }> = [
    { label: 'Public URL', value: target.publicUrl },
    { label: 'S3 bucket', value: target.s3Bucket, code: true },
    { label: 'S3 prefix', value: target.s3Prefix, code: true },
  ];
  if (target.cloudfrontDistributionId) {
    rows.push({ label: 'CloudFront', value: target.cloudfrontDistributionId, code: true });
  }
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '14px 18px',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
          marginBottom: 10,
        }}
      >
        Environment
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 6, rowGap: 8 }}>
        {rows.map((r) => (
          <>
            <div
              key={`${r.label}-label`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-mute)',
                letterSpacing: '0.06em',
              }}
            >
              {r.label}
            </div>
            <div
              key={`${r.label}-value`}
              style={{
                fontFamily: r.code ? 'var(--font-mono)' : 'inherit',
                fontSize: r.code ? 11 : 12,
                color: 'var(--text-dim)',
                letterSpacing: '0.02em',
                wordBreak: 'break-all',
              }}
            >
              {r.value}
            </div>
          </>
        ))}
      </div>
    </div>
  );
}
