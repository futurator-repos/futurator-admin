'use client';

import Link from 'next/link';
import type { Plan } from '@/types/plan';
import { Info } from 'lucide-react';
import { links } from '@/lib/links';

export function ConcurrencyBanner({
  appId,
  activePlan,
}: {
  appId: string;
  activePlan: Plan;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-accent-blue/30 bg-accent-blue/5 p-3">
      <Info className="size-4 shrink-0 text-accent-blue" aria-hidden />
      <p className="flex-1 text-sm">
        <strong>{activePlan.iterationLabel ?? activePlan.displayName ?? 'A Plan'}</strong> is in
        progress ({activePlan.status}).
      </p>
      <Link
        href={links.plan(appId, activePlan.planId)}
        className="text-sm font-medium text-accent-blue hover:underline"
      >
        Go to plan →
      </Link>
    </div>
  );
}
