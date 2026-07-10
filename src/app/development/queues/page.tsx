'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { QueuesView } from '@/components/development/queues/queues-view';

export default function QueuesPage() {
  return (
    <AuthGuard>
      <AppShell>
        <QueuesView />
      </AppShell>
    </AuthGuard>
  );
}
