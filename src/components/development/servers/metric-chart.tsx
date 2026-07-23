'use client';

export function MetricChart({
  label,
  timestamps,
  values,
  unit,
  thresholds,
}: {
  label: string;
  timestamps: string[];
  values: number[];
  unit: string;
  thresholds?: { warn: number; crit: number };
}) {
  if (timestamps.length === 0) {
    return <div className="text-xs text-muted-foreground italic">No data for this period</div>;
  }

  const max = Math.max(...values, thresholds?.crit || 100);
  const latest = values[values.length - 1];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...values);

  const color = thresholds
    ? latest > thresholds.crit
      ? 'text-red-500'
      : latest > thresholds.warn
        ? 'text-yellow-500'
        : 'text-green-500'
    : 'text-blue-400';

  const barColor = thresholds
    ? latest > thresholds.crit
      ? 'bg-red-500'
      : latest > thresholds.warn
        ? 'bg-yellow-500'
        : 'bg-green-500'
    : 'bg-blue-500';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            avg: {avg.toFixed(1)}
            {unit}
          </span>
          <span>
            peak: {peak.toFixed(1)}
            {unit}
          </span>
          <span className={`font-medium ${color}`}>
            now: {latest.toFixed(1)}
            {unit}
          </span>
        </div>
      </div>

      {/* Sparkline-style bar chart */}
      <div className="flex items-end gap-px h-16 bg-muted/20 rounded overflow-hidden">
        {values.map((v, i) => {
          const height = Math.max(1, (v / max) * 100);
          const isLast = i === values.length - 1;
          const bColor = thresholds
            ? v > thresholds.crit
              ? 'bg-red-500'
              : v > thresholds.warn
                ? 'bg-yellow-500'
                : 'bg-green-600'
            : 'bg-blue-500';
          return (
            <div
              key={i}
              className={`flex-1 min-w-[2px] ${bColor} ${isLast ? 'opacity-100' : 'opacity-70'} transition-all`}
              style={{ height: `${height}%` }}
              title={`${new Date(timestamps[i]).toLocaleTimeString()}: ${v.toFixed(1)}${unit}`}
            />
          );
        })}
      </div>

      {/* Current value bar */}
      {thresholds && (
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${Math.min(100, (latest / max) * 100)}%` }}
          />
        </div>
      )}

      {/* Time range labels */}
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>{timestamps.length > 0 ? new Date(timestamps[0]).toLocaleTimeString() : ''}</span>
        <span>
          {timestamps.length > 0
            ? new Date(timestamps[timestamps.length - 1]).toLocaleTimeString()
            : ''}
        </span>
      </div>
    </div>
  );
}
