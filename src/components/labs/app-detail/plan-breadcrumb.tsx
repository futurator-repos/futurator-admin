'use client';

import Link from 'next/link';
import type { App } from '@/types/app';
import type { Plan } from '@/types/plan';
import { links } from '@/lib/links';
import { ChevronRight } from 'lucide-react';

export function PlanBreadcrumb({
  app,
  plan,
  planNumber,
}: {
  app: App;
  plan: Plan;
  planNumber: number;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      <Link
        href={links.apps()}
        className="text-muted-foreground hover:text-foreground"
      >
        Apps
      </Link>
      <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
      <Link
        href={links.app(app.appId)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{app.icon ?? '📦'}</span>
        {app.displayName}
      </Link>
      <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
      <span className="font-medium" aria-current="page">
        Plan #{planNumber}
        {plan.iterationLabel ? ` · ${plan.iterationLabel}` : ''}
      </span>
    </nav>
  );
}
