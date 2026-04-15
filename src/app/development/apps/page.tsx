'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { AppsTable } from '@/components/development/apps-table';

export default function AppsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-page-title">Apps</h1>
          </div>
          <AppsTable />
        </div>
      </AppShell>
    </AuthGuard>
  );
}
