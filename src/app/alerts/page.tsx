'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useAlerts } from '@/hooks/use-alerts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-destructive/20 text-destructive',
  warning: 'bg-warning/20 text-warning',
  info: 'bg-accent-blue/20 text-accent-blue',
};

export default function AlertsPage() {
  const { data: alerts, isLoading } = useAlerts();
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <h1 className="text-page-title">Alerts</h1>
          {isLoading ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : (
            <Card>
              <CardContent className="pt-6">
                {alerts && alerts.length > 0 ? (
                  <div className="space-y-2">
                    {alerts.map((a) => (
                      <div key={`${a.alertId}-${a.timestamp}`} className="rounded border p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge className={SEVERITY_COLORS[a.severity]}>{a.severity}</Badge>
                            <span className="font-medium">{a.title}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{a.projectId}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatDate(a.timestamp)}
                            </span>
                          </div>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">No alerts</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
