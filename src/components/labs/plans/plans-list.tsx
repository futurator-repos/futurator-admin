'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PlanStatusBadge } from './plan-status-badge';
import { NewPlanForm } from './new-plan-form';
import { DeletePlanModal } from './delete-plan-modal';
import { usePlansList, useArchivePlan, useRestorePlan } from '@/hooks/use-plans';
import type { PlanStatus, PlanSummary } from '@/types/plan';
import { ChevronDown, Trash2, Plus, MoreVertical } from 'lucide-react';
import Link from 'next/link';

const PRIMARY_STATUSES: PlanStatus[] = ['concept', 'developing', 'fixing', 'review', 'delivered'];

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const ms = now - then;
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function PlanRow({
  plan,
  onDelete,
}: {
  plan: PlanSummary;
  onDelete: (plan: PlanSummary) => void;
}) {
  const href = `/labs/?planId=${plan.planId}`;
  const progress =
    plan.totalStories > 0 ? `${plan.doneStories}/${plan.totalStories} stories` : 'no stories yet';
  const archive = useArchivePlan(plan.planId);
  const restore = useRestorePlan(plan.planId);

  return (
    <Card className="p-4 transition-colors hover:bg-muted/30">
      <div className="flex items-center justify-between gap-4">
        <Link href={href} className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold">
              {plan.displayName || plan.name}
            </span>
            {plan.displayName && plan.displayName !== plan.name && (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {plan.name}
              </span>
            )}
            <PlanStatusBadge status={plan.status} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {plan.intent.slice(0, 120)}
            {plan.intent.length > 120 ? '…' : ''}
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex flex-col items-end text-right">
            <span className="text-xs text-muted-foreground">{progress}</span>
            <span className="text-xs text-muted-foreground">
              ${plan.totalCostUsd.toFixed(2)} · {formatRelativeTime(plan.updatedAt)}
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded hover:bg-muted"
                  aria-label="Actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link href={href} />}>Open</DropdownMenuItem>
              {plan.status === 'archived' ? (
                <DropdownMenuItem
                  onClick={() => {
                    restore.mutate();
                  }}
                >
                  Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() => {
                    archive.mutate();
                  }}
                >
                  Archive
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(plan)}
              >
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </Card>
  );
}

export function PlansList() {
  const { data: plans = [], isLoading } = usePlansList();
  const [activeFilters, setActiveFilters] = useState<Set<PlanStatus>>(new Set(PRIMARY_STATUSES));
  const [showNewForm, setShowNewForm] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PlanSummary | null>(null);

  const activePlans = plans.filter((p) => p.status !== 'archived');
  const archivedPlans = plans.filter((p) => p.status === 'archived');
  const filteredActive = activePlans.filter((p) => activeFilters.has(p.status));

  // Empty-state: if there are no active plans AND no archived plans, render
  // the New Plan form directly (no cards, no noise).
  if (!isLoading && activePlans.length === 0 && archivedPlans.length === 0) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Labs</h1>
        </div>
        <NewPlanForm />
      </div>
    );
  }

  function toggleFilter(s: PlanStatus) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Labs</h1>
        <Button onClick={() => setShowNewForm((v) => !v)}>
          <Plus className="mr-1 h-4 w-4" />
          {showNewForm ? 'Close' : 'New Plan'}
        </Button>
      </div>

      {showNewForm && <NewPlanForm onCreated={() => setShowNewForm(false)} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {PRIMARY_STATUSES.map((s) => {
          const active = activeFilters.has(s);
          return (
            <button
              key={s}
              onClick={() => toggleFilter(s)}
              className={`rounded-full border px-3 py-1 transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/30'
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-4">
              <div className="space-y-2">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Active plans */}
      <div className="space-y-2">
        {filteredActive.length === 0 && !isLoading && activePlans.length > 0 && (
          <p className="text-sm text-muted-foreground">
            No plans match the current filters. Toggle more status chips above.
          </p>
        )}
        {filteredActive.map((p) => (
          <PlanRow key={p.planId} plan={p} onDelete={setDeleteTarget} />
        ))}
      </div>

      {/* Archived (collapsed) */}
      {archivedPlans.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
          <CollapsibleTrigger className="flex items-center gap-2 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted/50">
            <ChevronDown
              className={`h-4 w-4 transition-transform ${archivedOpen ? 'rotate-180' : ''}`}
            />
            <Trash2 className="h-4 w-4" />
            Archived ({archivedPlans.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {archivedPlans.map((p) => (
              <PlanRow key={p.planId} plan={p} onDelete={setDeleteTarget} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      <DeletePlanModal
        plan={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      />
    </div>
  );
}
