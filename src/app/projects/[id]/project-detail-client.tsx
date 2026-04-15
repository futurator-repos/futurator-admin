'use client';
import Link from 'next/link';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ProjectTabs } from '@/components/projects/project-tabs';
import { useProject } from '@/hooks/use-projects';
import { Skeleton } from '@/components/ui/skeleton';

export function ProjectDetailClient({ id }: { id: string }) {
  const { data: project, isLoading } = useProject(id);
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Dashboard
            </Link>
            <span>/</span>
            <span className="text-foreground">{project?.name || 'Loading...'}</span>
          </div>
          {isLoading ? (
            <Skeleton className="h-96 w-full rounded-lg" />
          ) : project ? (
            <ProjectTabs project={project} />
          ) : (
            <p>Project not found</p>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
