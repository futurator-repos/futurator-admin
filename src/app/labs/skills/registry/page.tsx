'use client';
/**
 * /labs/skills/registry — legacy redirect (Skills FE refactor, 2026-06-16).
 *
 * The Registry moved to the /labs/skills index. This thin client redirect keeps
 * old bookmarks working, preserving ?appId. AuthGuard / AppShell / Suspense are
 * provided by the shared skills layout.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';

export default function SkillsRegistryRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const appId = params.get('appId');
    const query = appId ? `?appId=${encodeURIComponent(appId)}` : '';
    router.replace(`/labs/skills${query}`);
  }, [router, params]);

  return <Skeleton className="h-40 w-full" />;
}
