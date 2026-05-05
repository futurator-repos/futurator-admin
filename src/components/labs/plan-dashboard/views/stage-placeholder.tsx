'use client';

/**
 * Placeholder content for pipeline stages we haven't specced yet (QA Review,
 * Deploy, Published). Keeps the navigation traversable while we nail down
 * what lives here.
 */
export function StagePlaceholder({
  stage,
  note,
}: {
  stage: string;
  note: string;
}) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-2)',
        borderRadius: 8,
        padding: '48px 32px',
        textAlign: 'center',
        color: 'var(--text-mute)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
          marginBottom: 10,
        }}
      >
        {stage} — coming soon
      </div>
      <p
        style={{
          fontSize: 14,
          color: 'var(--text-dim)',
          lineHeight: 1.55,
          margin: 0,
          maxWidth: 520,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {note}
      </p>
    </div>
  );
}
