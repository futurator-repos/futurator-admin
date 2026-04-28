'use client';

import type { App } from '@/types/app';
import { Button } from '@/components/ui/button';
import { ExternalLink, Settings, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RepositoryBadge } from './repository-badge';
import { PerformanceBadge } from './performance-badge';

export function AppDetailHeader({
  app,
  onOpenSettings,
  onOpenDelete,
}: {
  app: App;
  onOpenSettings: () => void;
  onOpenDelete: () => void;
}) {
  const liveUrl = `https://futurator.ai/apps/${app.appId}/`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-4">
        <div className="text-5xl" aria-hidden>
          {app.icon ?? '📦'}
        </div>
        <div>
          <h1 className="text-page-title">{app.displayName}</h1>
          <p className="font-mono text-xs text-muted-foreground">{app.appId}</p>
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-accent-blue hover:underline"
          >
            {liveUrl}
            <ExternalLink className="size-3" />
          </a>
          {/* Story 1.5.1 — GitHub repository badge (hidden for legacy apps) */}
          <div className="mt-2">
            <RepositoryBadge app={app} />
          </div>
          {/* Story 1.8.5 — Performance badge (hidden when < 2 delivered plans) */}
          <div className="mt-2">
            <PerformanceBadge app={app} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <a
          href={liveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
        >
          ▶ Preview
        </a>
        <Button variant="ghost" size="icon" onClick={onOpenSettings} aria-label="Settings">
          <Settings className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent"
                aria-label="More"
              >
                <MoreVertical className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpenDelete} className="text-destructive">
              Delete App
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
