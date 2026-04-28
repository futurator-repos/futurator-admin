'use client';
/**
 * Settings → GitHub — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Route: /settings/github
 *
 * Shows the GitHub PAT connection status, rate limit, last-rotation timestamp,
 * and a PAT rotation form.
 */

import Link from 'next/link';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { GitHubPanel } from '@/components/settings/github-panel';

function GitHubSettingsContent() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
          <span>/</span>
          <span>GitHub</span>
        </div>
        <h1 className="text-page-title">GitHub Integration</h1>
        <p className="text-sm text-muted-foreground">
          PAT status, rate-limit, and rotation controls for the futurator-repos GitHub org.
        </p>
      </div>

      <GitHubPanel />
    </div>
  );
}

export default function GitHubSettingsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <GitHubSettingsContent />
      </AppShell>
    </AuthGuard>
  );
}
