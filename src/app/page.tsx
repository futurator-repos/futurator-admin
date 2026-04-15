'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ProjectCard } from '@/components/projects/project-card';
import { useProjects } from '@/hooks/use-projects';
import { useCostOverview } from '@/hooks/use-costs';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: costOverview } = useCostOverview();

  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div>
            <h1 className="text-page-title">Portfolio Dashboard</h1>
            {costOverview && (
              <p className="text-lg text-muted-foreground">
                Monthly spend:{' '}
                <span className="font-semibold text-foreground">
                  {formatCurrency(costOverview.totalMonthly)}
                </span>
              </p>
            )}
          </div>

          {projectsLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects?.map((project) => (
                <ProjectCard key={project.projectId} project={project} />
              ))}
            </div>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
