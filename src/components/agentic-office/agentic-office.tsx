'use client';
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AppEntry } from '@/hooks/use-epic-workflow';
import { useOfficeStore } from '@/stores/office-store';
import { EpicTracker } from './epic-tracker';
import { OfficeScene } from './scene/office-scene';
import { KanbanBoard } from './overlays/kanban-board';
import { OfficeControls } from './overlays/office-controls';
import { OfficeEventLog } from './overlays/office-event-log';

export function AgenticOffice() {
  // Poll for apps every 5s so we discover new epics quickly
  const { data: apps } = useQuery({
    queryKey: ['published-apps'],
    queryFn: () => api.get<AppEntry[]>('/apps'),
    refetchInterval: 5000,
  });
  const setActiveEpics = useOfficeStore((s) => s.setActiveEpics);

  const activeEpicIds = useMemo(() => {
    if (!apps) return [];
    return apps.filter((a) => a.appStatus === 'in_development').map((a) => a.epicId);
  }, [apps]);

  useEffect(() => {
    setActiveEpics(activeEpicIds);
  }, [activeEpicIds, setActiveEpics]);

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full overflow-hidden rounded-lg border border-border bg-background">
      {/* Headless data trackers — one per active epic */}
      {activeEpicIds.map((id) => (
        <EpicTracker key={id} epicId={id} />
      ))}

      {/* Three.js 3D office */}
      <OfficeScene />

      {/* HTML overlays */}
      <KanbanBoard />
      <OfficeControls />
      <OfficeEventLog />
    </div>
  );
}
