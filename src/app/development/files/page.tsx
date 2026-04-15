'use client';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { FileExplorer } from '@/components/development/file-explorer';
import { Ec2Control } from '@/components/development/ec2-control';

export default function FileExplorerPage() {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-page-title">File Explorer</h1>
            <Ec2Control />
          </div>
          <FileExplorer />
        </div>
      </AppShell>
    </AuthGuard>
  );
}
