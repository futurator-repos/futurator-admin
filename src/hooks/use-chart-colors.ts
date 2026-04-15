'use client';
import { useMemo } from 'react';
import { useTheme } from 'next-themes';

export interface ChartColors {
  chart: [string, string, string, string, string];
  border: string;
  mutedForeground: string;
}

const FALLBACK: ChartColors = {
  chart: [
    'oklch(0.646 0.222 41.116)',
    'oklch(0.6 0.118 184.704)',
    'oklch(0.398 0.07 227.392)',
    'oklch(0.828 0.189 84.429)',
    'oklch(0.769 0.188 70.08)',
  ],
  border: 'oklch(0.922 0 0)',
  mutedForeground: 'oklch(0.556 0 0)',
};

function readVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolves shadcn/ui chart CSS custom properties (--chart-1..5, --border, --muted-foreground)
 * into concrete color strings for Recharts, which does not consume CSS variables in its
 * fill/stroke props. Re-computes whenever the active theme changes.
 */
export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();

  const colors = useMemo((): ChartColors => {
    // resolvedTheme is read here so the memo re-runs when the theme changes,
    // which causes the CSS custom properties to resolve to new values.
    void resolvedTheme;
    const chart1 = readVar('--chart-1') || FALLBACK.chart[0];
    const chart2 = readVar('--chart-2') || FALLBACK.chart[1];
    const chart3 = readVar('--chart-3') || FALLBACK.chart[2];
    const chart4 = readVar('--chart-4') || FALLBACK.chart[3];
    const chart5 = readVar('--chart-5') || FALLBACK.chart[4];
    const border = readVar('--border') || FALLBACK.border;
    const mutedForeground = readVar('--muted-foreground') || FALLBACK.mutedForeground;

    return {
      chart: [chart1, chart2, chart3, chart4, chart5],
      border,
      mutedForeground,
    };
  }, [resolvedTheme]);

  return colors;
}
