'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ServersView } from '@/components/development/servers/servers-view';

export default function ServersPage() {
  return (
    <AuthGuard>
      <AppShell>
        <ServersView />
      </AppShell>
    </AuthGuard>
  );
}
