'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { FileExplorer } from '@/components/development/file-explorer';

export default function FileExplorerPage() {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <h1 className="text-page-title">File Explorer</h1>
          <FileExplorer />
        </div>
      </AppShell>
    </AuthGuard>
  );
}
