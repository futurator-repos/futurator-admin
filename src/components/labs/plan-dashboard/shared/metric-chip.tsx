'use client';

interface MetricChipProps {
  label: string;
  value: string;
  color?: string;
}

export function MetricChip({ label, value, color = 'var(--foreground)' }: MetricChipProps) {
  return (
    <div className="inline-flex flex-col items-start leading-tight">
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 7,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color,
          fontWeight: 400,
          marginTop: 3,
          letterSpacing: '0.02em',
        }}
      >
        {value}
      </span>
    </div>
  );
}
