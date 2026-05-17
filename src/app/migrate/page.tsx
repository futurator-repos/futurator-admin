'use client';
/**
 * Migrate — Operator UI for brownfield Party migrations.
 *
 * Route shape (static-export-safe — query params only):
 *   /migrate                       → list of every migration
 *   /migrate?highlight=<projectId> → list with one card highlighted
 *                                     (used by the wizard after success)
 *
 * The wizard for creating a NEW migration is a modal opened from this
 * page's `+ New migration` button. PATCH/Delete on an existing
 * migration are inline actions on each card.
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus, Truck } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Button } from '@/components/ui/button';
import { MigrationsList } from '@/components/migrate/migrations-list';
import { MigrationWizard } from '@/components/migrate/migration-wizard';

function MigrateContent() {
  const params = useSearchParams();
  const highlight = params.get('highlight');
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-page-title flex items-center gap-2">
            <Truck className="h-6 w-6 text-accent-purple" />
            Migrate
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Bring existing private GitHub repos into Futurator as brownfield Party projects. Each
            migration has its own GitHub PAT and runtime env vars.
          </p>
        </div>
        <Button size="sm" onClick={() => setWizardOpen(true)} data-testid="new-migration-button">
          <Plus className="mr-1 h-3.5 w-3.5" />
          New migration
        </Button>
      </div>

      <MigrationsList highlight={highlight} />
      <MigrationWizard open={wizardOpen} onOpenChange={setWizardOpen} />
    </div>
  );
}

export default function MigratePage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <MigrateContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
