'use client';

import type { AppDerivedStatus } from '@/types/app';

const labels: Record<AppDerivedStatus, string> = {
  live: 'live',
  building: 'building',
  'dirty-tree': 'needs cleanup',
  'no-deploy': 'no deploy yet',
};

const classNames: Record<AppDerivedStatus, string> = {
  live: 'bg-success/15 text-success',
  building: 'bg-accent-blue/15 text-accent-blue',
  'dirty-tree': 'bg-warning/15 text-warning',
  'no-deploy': 'bg-muted text-muted-foreground',
};

export function AppStatusPill({ status }: { status: AppDerivedStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${classNames[status]}`}
    >
      <span
        className={`size-1.5 rounded-full ${
          status === 'building'
            ? 'animate-pulse bg-accent-blue motion-reduce:animate-none'
            : status === 'dirty-tree'
              ? 'bg-warning'
              : status === 'live'
                ? 'bg-success'
                : 'bg-muted-foreground'
        }`}
        aria-hidden
      />
      {labels[status]}
    </span>
  );
}
