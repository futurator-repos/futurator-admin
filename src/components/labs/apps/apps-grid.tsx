'use client';

import { useState } from 'react';
import { useApps } from '@/hooks/use-apps';
import { Button } from '@/components/ui/button';
import { AppCard } from './app-card';
import { AppsGridSkeleton } from './apps-grid-skeleton';
import { EmptyAppsState } from './empty-apps-state';
import { NewAppModal } from './new-app-modal';

export function AppsGrid() {
  const { data: apps, isLoading, error } = useApps();
  const [modalOpen, setModalOpen] = useState(false);

  if (isLoading) return <AppsGridSkeleton />;
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load Apps: {(error as Error).message}
      </div>
    );
  }

  if (!apps || apps.length === 0) {
    return (
      <>
        <EmptyAppsState onCreate={() => setModalOpen(true)} />
        <NewAppModal open={modalOpen} onOpenChange={setModalOpen} />
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-muted-foreground">What you&apos;re building.</p>
        <Button onClick={() => setModalOpen(true)}>+ New App</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {apps.map((app) => (
          <AppCard key={app.appId} app={app} />
        ))}
      </div>
      <NewAppModal open={modalOpen} onOpenChange={setModalOpen} />
    </>
  );
}
