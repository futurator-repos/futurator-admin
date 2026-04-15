'use client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '@/lib/utils';
import { useChartColors } from '@/hooks/use-chart-colors';

interface Props {
  data: { name: string; amount: number }[];
  title?: string;
}

export function ProjectRanking({ data, title }: Props) {
  const colors = useChartColors();
  return (
    <div>
      {title && <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>}
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="vertical">
          <XAxis
            type="number"
            tickFormatter={(v) => `$${v}`}
            tick={{ fontSize: 12, fill: colors.mutedForeground }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 12, fill: colors.mutedForeground }}
            width={120}
          />
          <Tooltip formatter={(value: number) => formatCurrency(value)} />
          <Bar dataKey="amount" fill={colors.chart[0]} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
