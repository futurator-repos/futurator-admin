'use client';
import { Suspense } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ServersView } from '@/components/development/servers/servers-view';

export default function ServersPage() {
  return (
    <AuthGuard>
      <AppShell>
        {/* ServersView reads ?tab= via useSearchParams — Suspense boundary
            is required under output: 'export'. */}
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
          <ServersView />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
