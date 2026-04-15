'use client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { useChartColors } from '@/hooks/use-chart-colors';

interface Props {
  data: { date: string; amount: number }[];
  title?: string;
}

export function CostTrendLine({ data, title }: Props) {
  const colors = useChartColors();
  return (
    <div>
      {title && <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
          <XAxis dataKey="date" tick={{ fontSize: 12, fill: colors.mutedForeground }} />
          <YAxis
            tick={{ fontSize: 12, fill: colors.mutedForeground }}
            tickFormatter={(v) => `$${v}`}
          />
          <Tooltip formatter={(value: number) => formatCurrency(value)} />
          <Line
            type="monotone"
            dataKey="amount"
            stroke={colors.chart[0]}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
