'use client';
/**
 * /labs/reflections — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * Cross-project Reflection Inbox. Per-project view lives under the App
 * detail's "Reflections" tab (3-E-3 follow-on).
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { ReflectionInbox } from '@/components/labs/reflection-inbox/reflection-inbox';

function ReflectionsPageContent() {
  const params = useSearchParams();
  const projectSlug = params.get('projectSlug') || undefined;
  return <ReflectionInbox projectSlug={projectSlug} />;
}

export default function ReflectionsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading…</p>}>
          <ReflectionsPageContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
