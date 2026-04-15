'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { AgenticOffice } from '@/components/agentic-office/agentic-office';

export default function AgenticOfficePage() {
  return (
    <AuthGuard>
      <AppShell>
        <AgenticOffice />
      </AppShell>
    </AuthGuard>
  );
}
