'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { STATUS_COLORS, CATEGORY_LABELS } from '@/lib/constants';
import type { Project } from '@/types/project';
import Image from 'next/image';
import Link from 'next/link';
import { Pencil } from 'lucide-react';

interface ProjectListRowProps {
  project: Project;
  onEdit: (projectId: string) => void;
}

export function ProjectListRow({ project, onEdit }: ProjectListRowProps) {
  const brief = project.descriptions?.brief || '';
  const published = project.publishedToHomepage;
  const media = project.media || [];

  return (
    <div className="grid grid-cols-[120px_1fr_90px_100px_1.2fr_44px_44px] items-center gap-2 border-b border-border px-4 py-3 transition-colors hover:bg-accent/50">
      {/* Thumbnails */}
      <div className="flex gap-1">
        {media.slice(0, 3).map((m, i) => (
          <div
            key={m.id || i}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted text-[10px] text-muted-foreground"
          >
            {m.url ? (
              <Image
                src={m.url}
                alt={m.alt || ''}
                width={36}
                height={36}
                className="h-full w-full rounded-md object-cover"
                unoptimized
              />
            ) : (
              'img'
            )}
          </div>
        ))}
        {media.length === 0 && (
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted text-[10px] text-muted-foreground">
            —
          </div>
        )}
      </div>

      {/* Name */}
      <Link
        href={`/projects/${project.projectId}`}
        className="truncate text-sm text-foreground hover:text-accent-blue"
      >
        {project.name}
      </Link>

      {/* Status */}
      <Badge
        className={`${STATUS_COLORS[project.status] || 'bg-muted text-muted-foreground'} text-badge w-fit`}
      >
        {project.status}
      </Badge>

      {/* Category */}
      <span className="truncate text-xs text-muted-foreground">
        {CATEGORY_LABELS[project.category] || project.category}
      </span>

      {/* Brief */}
      <span className="truncate text-xs text-muted-foreground">{brief}</span>

      {/* Published dot */}
      <div className="flex justify-center">
        <div
          className={`h-2 w-2 rounded-full ${published ? 'bg-success shadow-[0_0_8px_rgba(52,211,153,0.4)]' : 'bg-muted-foreground/40'}`}
          aria-label={published ? 'Published to homepage' : 'Not published to homepage'}
        />
      </div>

      {/* Edit */}
      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            onEdit(project.projectId);
          }}
          aria-label={`Edit ${project.name}`}
          className="h-7 w-7 text-muted-foreground hover:bg-accent-blue/10 hover:text-accent-blue"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function ProjectListRowSkeleton() {
  return (
    <div className="grid grid-cols-[120px_1fr_90px_100px_1.2fr_44px_44px] items-center gap-2 border-b border-border px-4 py-3">
      <div className="flex gap-1">
        <Skeleton className="h-9 w-9 rounded-md" />
        <Skeleton className="h-9 w-9 rounded-md" />
      </div>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-5 w-16 rounded-full" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="mx-auto h-2 w-2 rounded-full" />
      <Skeleton className="mx-auto h-7 w-7 rounded-md" />
    </div>
  );
}
