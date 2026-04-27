'use client';
/**
 * Pipeline v1 — Stories 4.5 + 4.6. Cost meters.
 *
 * `<PlanCostMeter />` — per-plan progress bar with raise-ceiling action.
 *   Lives in the plan dashboard header.
 * `<DailyCostWidget />` — 24-hour rolling total. Lives in the admin header.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

interface PlanCostMeterProps {
  planId: string;
  costSoFarUsd: number;
  costCeilingUsd?: number;
}

export function PlanCostMeter({ planId, costSoFarUsd, costCeilingUsd }: PlanCostMeterProps) {
  const ceiling = costCeilingUsd ?? 50;
  const pct = Math.min(100, (costSoFarUsd / ceiling) * 100);
  const [raising, setRaising] = useState(false);
  const [newCeiling, setNewCeiling] = useState(ceiling.toString());
  const queryClient = useQueryClient();

  const raise = useMutation({
    mutationFn: (newCeilingUsd: number) =>
      api.post(`/plans/${planId}/raise-cost-ceiling`, { newCeilingUsd }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      setRaising(false);
    },
  });

  const color = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">
          ${costSoFarUsd.toFixed(2)} / ${ceiling.toFixed(2)}
        </div>
        <div className="w-32 h-1.5 rounded bg-muted overflow-hidden">
          <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>
      {!raising ? (
        <Button size="sm" variant="ghost" onClick={() => setRaising(true)}>
          Raise
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="1"
            value={newCeiling}
            onChange={(e) => setNewCeiling(e.target.value)}
            className="w-20 text-xs px-2 py-1 rounded border bg-background"
          />
          <Button
            size="sm"
            onClick={() => raise.mutate(Number(newCeiling))}
            disabled={raise.isPending}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRaising(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

export function DailyCostWidget() {
  const { data } = useQuery({
    queryKey: ['health', 'cost'],
    queryFn: () => api.get<{ dailyCostUsd: number; dailyCeilingUsd: number }>('/health/cost'),
    refetchInterval: 30_000,
  });
  if (!data) return null;
  const pct = Math.min(100, (data.dailyCostUsd / data.dailyCeilingUsd) * 100);
  const color = pct >= 100 ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary';
  return (
    <div
      className="text-xs flex flex-col gap-0.5"
      title={`Daily: $${data.dailyCostUsd.toFixed(2)} / $${data.dailyCeilingUsd.toFixed(2)}`}
    >
      <div className="text-muted-foreground">${data.dailyCostUsd.toFixed(2)} today</div>
      <div className="w-20 h-1 rounded bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
