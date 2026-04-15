'use client';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/utils';

interface Props {
  used: number;
  limit: number;
}

export function BudgetBar({ used, limit }: Props) {
  const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-500">
        <span>
          {formatCurrency(used)} / {formatCurrency(limit)}
        </span>
        <span>{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            percent > 100 ? 'bg-red-500' : percent > 80 ? 'bg-yellow-500' : 'bg-green-500',
          )}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}
