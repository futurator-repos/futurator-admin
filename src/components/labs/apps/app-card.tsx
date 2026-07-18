'use client';

import Link from 'next/link';
import type { AppCardData } from '@/types/app';
import { Card } from '@/components/ui/card';
import { AppStatusPill } from './app-status-pill';
import { links } from '@/lib/links';

export function AppCard({ app, href }: { app: AppCardData; href?: string }) {
  return (
    <Link href={href ?? links.app(app.appId)} className="block">
      <Card className="h-full cursor-pointer p-4 transition-shadow duration-150 ease-out hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0">
        <div className="flex items-start justify-between">
          <div className="text-3xl">{app.icon ?? '📦'}</div>
          <AppStatusPill status={app.derivedStatus} />
        </div>
        <h3 className="mt-3 text-lg font-semibold">{app.displayName}</h3>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">{app.appId}</p>
        <div className="mt-3 text-sm">
          {app.currentlyLiveLabel ? (
            <span>
              <span className="text-success">●</span> live · {app.currentlyLiveLabel}
            </span>
          ) : (
            <span className="text-muted-foreground">no deploy yet</span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {app.planCount} {app.planCount === 1 ? 'plan' : 'plans'}
        </div>
      </Card>
    </Link>
  );
}
