'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { CostPieChart } from '@/components/charts/cost-pie-chart';
import { ProjectRanking } from '@/components/charts/project-ranking';
import { useCostOverview, useCostProviders } from '@/hooks/use-costs';
import { useUIStore } from '@/stores/ui-store';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function CostsPage() {
  const { data: overview, isLoading } = useCostOverview();
  const { data: providers } = useCostProviders();
  const { costProvider, setCostProvider } = useUIStore();

  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-page-title">Cost Explorer</h1>
            <div className="flex gap-2">
              {(['aws', 'all'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCostProvider(p)}
                  className={`rounded-md px-3 py-1 text-sm ${costProvider === p ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
                >
                  {p === 'aws' ? 'AWS Only' : 'All Providers'}
                </button>
              ))}
            </div>
          </div>
          {isLoading ? (
            <div className="grid gap-4 md:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          ) : overview ? (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Total Monthly Cost
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">{formatCurrency(overview.totalMonthly)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Projects</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">{overview.projects.length}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Top Service</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold">
                      {overview.topServices[0]?.service || 'N/A'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {overview.topServices[0]
                        ? formatCurrency(overview.topServices[0].amount)
                        : ''}
                    </p>
                  </CardContent>
                </Card>
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardContent className="pt-6">
                    <ProjectRanking
                      data={overview.projects.map((p) => ({ name: p.projectId, amount: p.amount }))}
                      title="Cost by Project"
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <CostPieChart
                      data={overview.topServices.map((s) => ({ name: s.service, value: s.amount }))}
                      title="Cost by Service"
                    />
                  </CardContent>
                </Card>
              </div>
              {providers && providers.length > 1 && (
                <Card>
                  <CardContent className="pt-6">
                    <CostPieChart
                      data={providers.map((p) => ({ name: p.provider, value: p.amount }))}
                      title="Cost by Provider"
                    />
                  </CardContent>
                </Card>
              )}
            </>
          ) : null}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
