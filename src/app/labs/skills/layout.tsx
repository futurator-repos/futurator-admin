'use client';
/**
 * /labs/skills — shared layout (Skills FE refactor, 2026-06-16).
 *
 * Owns the AuthGuard + AppShell + tab bar for both Skills routes, so the two
 * pages no longer duplicate those wrappers. Registry is the primary (first)
 * tab and lives at /labs/skills; Usage is /labs/skills/usage. The active tab
 * is derived from the pathname; ?appId is preserved across both links.
 *
 * The Suspense boundary lives here because both child pages read useSearchParams.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';

function SkillsTabBar() {
  const pathname = usePathname() ?? '';
  const params = useSearchParams();
  const appId = params.get('appId') || undefined;
  const query = appId ? `?appId=${encodeURIComponent(appId)}` : '';

  // Registry is the index route; Usage + Growth Inbox are sub-routes. Match
  // exactly (allowing a trailing slash from `trailingSlash: true` static export).
  const isUsage = pathname.startsWith('/labs/skills/usage');
  const isInbox = pathname.startsWith('/labs/skills/growth-inbox');
  const active = isUsage ? 'usage' : isInbox ? 'growth-inbox' : 'registry';

  return (
    <Tabs value={active} className="w-full">
      <TabsList variant="line">
        <TabsTrigger value="registry" render={<Link href={`/labs/skills${query}`} />}>
          Registry
        </TabsTrigger>
        <TabsTrigger
          value="growth-inbox"
          render={<Link href={`/labs/skills/growth-inbox${query}`} />}
        >
          Growth Inbox
        </TabsTrigger>
        <TabsTrigger value="usage" render={<Link href={`/labs/skills/usage${query}`} />}>
          Usage
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-4">
          <Suspense fallback={<Skeleton className="h-8 w-48" />}>
            <SkillsTabBar />
          </Suspense>
          <Suspense
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
      </AppShell>
    </AuthGuard>
  );
}
