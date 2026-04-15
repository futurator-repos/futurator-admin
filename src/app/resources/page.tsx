'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useResourceSummary } from '@/hooks/use-resources';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ResourcesPage() {
  const { data: summary, isLoading } = useResourceSummary();
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <h1 className="text-page-title">Resource Map</h1>
          {isLoading ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : summary ? (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Total Resources</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">{summary.totalResources}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Tag Compliance</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">{summary.overallCompliance}%</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Service Types</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-bold">
                      {Object.keys(summary.byServiceType).length}
                    </p>
                  </CardContent>
                </Card>
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>Resources by Service</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {Object.entries(summary.byServiceType)
                      .sort(([, a], [, b]) => b - a)
                      .map(([service, count]) => (
                        <div
                          key={service}
                          className="flex items-center justify-between rounded border p-2"
                        >
                          <span className="text-sm capitalize">{service}</span>
                          <Badge variant="outline">{count}</Badge>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Compliance by Project</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {summary.byProject.map((p) => (
                      <div
                        key={p.projectId}
                        className="flex items-center justify-between rounded border p-2"
                      >
                        <span className="text-sm">{p.projectId}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {p.resourceCount} resources
                          </span>
                          <Badge variant={p.complianceScore >= 80 ? 'default' : 'destructive'}>
                            {p.complianceScore}%
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
