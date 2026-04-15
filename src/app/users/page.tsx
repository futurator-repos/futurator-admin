'use client';
import { useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useUsers } from '@/hooks/use-users';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function UsersPage() {
  const [projectFilter] = useState<string | undefined>();
  const { data: users, isLoading } = useUsers(projectFilter);
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <h1 className="text-page-title">User Directory</h1>
          {isLoading ? (
            <Skeleton className="h-64 rounded-lg" />
          ) : (
            <Card>
              <CardContent className="pt-6">
                {users && users.length > 0 ? (
                  <div className="space-y-2">
                    {users.map((u) => (
                      <div
                        key={u.userId}
                        className="flex items-center justify-between rounded border p-3"
                      >
                        <div>
                          <span className="font-medium">{u.name}</span>
                          <p className="text-sm text-muted-foreground">{u.email}</p>
                        </div>
                        <div className="flex gap-1">
                          {Object.keys(u.projects || {}).map((p) => (
                            <Badge key={p} variant="outline" className="text-xs">
                              {p}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground">No users found</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
