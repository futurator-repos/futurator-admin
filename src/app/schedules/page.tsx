'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useSchedules, useDeleteSchedule } from '@/hooks/use-schedules';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function SchedulesPage() {
  const { data: schedules, isLoading } = useSchedules();
  const deleteSchedule = useDeleteSchedule();
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <h1 className="text-page-title">Resource Schedules</h1>
          {isLoading ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : (
            <Card>
              <CardContent className="pt-6">
                {schedules && schedules.length > 0 ? (
                  <div className="space-y-2">
                    {schedules.map((s) => (
                      <div
                        key={s.scheduleId}
                        className="flex items-center justify-between rounded border p-3"
                      >
                        <div>
                          <span className="font-medium">{s.resourceId}</span>
                          <div className="flex gap-2 mt-1">
                            <Badge variant="outline">{s.resourceType}</Badge>
                            <Badge variant={s.action === 'start' ? 'default' : 'secondary'}>
                              {s.action}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {s.cronExpression}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={s.enabled ? 'default' : 'secondary'}>
                            {s.enabled ? 'Active' : 'Paused'}
                          </Badge>
                          <button
                            onClick={() => deleteSchedule.mutate(s.scheduleId)}
                            className="text-xs text-destructive hover:text-destructive/80"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">
                    No schedules configured
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
