'use client';

import Link from 'next/link';
import type { Plan } from '@/types/plan';
import { links } from '@/lib/links';
import { NewPlanCta } from './new-plan-cta';

export function PlanTimeline({
  appId,
  plans,
  canStartNew,
  blockReason,
  onStartNew,
}: {
  appId: string;
  plans: Plan[];
  canStartNew: boolean;
  blockReason?: string;
  onStartNew: () => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Plan Timeline</h2>
      <ol className="flex flex-col gap-4 md:flex-row md:items-stretch md:gap-2 md:overflow-x-auto">
        {plans.map((plan, idx) => (
          <PlanTimelineNode
            key={plan.planId}
            plan={plan}
            index={idx + 1}
            appId={appId}
            isLast={idx === plans.length - 1}
          />
        ))}
        <li className="flex md:items-center">
          <NewPlanCta
            canStart={canStartNew}
            blockReason={blockReason}
            isFirst={plans.length === 0}
            onClick={onStartNew}
          />
        </li>
      </ol>
    </div>
  );
}

function PlanTimelineNode({
  plan,
  index,
  appId,
  isLast,
}: {
  plan: Plan;
  index: number;
  appId: string;
  isLast: boolean;
}) {
  const glyph = nodeGlyphFor(plan);
  return (
    <li className="flex flex-1 items-center gap-2 md:flex-col md:items-start md:gap-1.5">
      <Link
        href={links.plan(appId, plan.planId)}
        className="block min-w-[180px] rounded-md border p-3 transition-shadow hover:shadow-md md:flex-1"
      >
        <div className="flex items-center gap-2">
          <span className={`text-xl ${glyph.className}`} aria-hidden>
            {glyph.symbol}
          </span>
          <div>
            <p className="text-xs font-medium">Plan #{index}</p>
            <p className="text-xs text-muted-foreground">{plan.kind ?? 'change'}</p>
          </div>
        </div>
        <p className="mt-2 text-sm">
          {plan.iterationLabel ?? plan.displayName ?? '(no label)'}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{plan.status}</p>
      </Link>
      {!isLast && <span className="hidden text-muted-foreground md:inline">━</span>}
    </li>
  );
}

function nodeGlyphFor(plan: Plan): { symbol: string; className: string } {
  switch (plan.status) {
    case 'delivered':
      return { symbol: '●', className: 'text-success' };
    case 'abandoned':
      return { symbol: '⊗', className: 'text-muted-foreground' };
    case 'archived':
      return { symbol: '⊘', className: 'text-muted-foreground' };
    case 'concept':
    case 'developing':
    case 'review':
    case 'fixing':
      return { symbol: '⊙', className: 'animate-pulse text-accent-blue motion-reduce:animate-none' };
    default:
      return { symbol: '○', className: 'text-muted-foreground' };
  }
}
