'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApps, useCreateApp } from '@/hooks/use-apps';
import { links } from '@/lib/links';
import { BoilerplatePicker } from '@/components/labs/boilerplate-picker';
import { IconPicker } from '@/components/labs/apps/icon-picker';
import { getBoilerplateClientView } from '@/lib/boilerplate-registry-client-view';
import type { BoilerplateType } from '@/types/app';

/**
 * Pipeline v2 / Story 1.4.1 — slug regex matches the server's
 * `appCreateInputSchema` (`PV2_APP_SLUG_REGEX`): letter-led kebab-case,
 * 2–40 chars total. Stricter than the legacy App slug rule.
 */
const PV2_SLUG_REGEX = /^[a-z][a-z0-9-]{1,39}$/;
const RESERVED_APP_IDS = new Set(['data', 'media', 'apps', 'knowledge-live', 'admin', 'api']);

type SlugStatus = 'idle' | 'invalid' | 'reserved' | 'taken' | 'available';

export function NewAppModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const { data: apps } = useApps();
  const create = useCreateApp();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [icon, setIcon] = useState('📦');
  // PR-46 (2026-05-06) — orchestrator path retired from the New App form.
  // The brick-breaker-2 run on 2026-05-06 confirmed the step-based pipeline
  // is functional and orchestrator's purpose (driving the legacy epic-dev
  // single-Claude path) is no longer needed. The 'orchestrator' enum value
  // is retained in the type union for back-compat with persisted App rows
  // but no NEW data writes set it.
  //
  // Hardcoded to 'pipeline' — no operator-facing toggle. Re-enable via a
  // hidden flag (e.g. ?legacy=1) if a regression ever requires repro.
  const executionMode = 'pipeline' as const;
  // PR-13 — default starter is `nextjs-base`. Operator picks a derivative
  // (canvas-game, form-app, dashboard) when their intent matches a domain.
  const [boilerplateType, setBoilerplateType] = useState<BoilerplateType>('nextjs-base');
  const [bmadEnabled, setBmadEnabled] = useState<boolean>(true);
  /**
   * Server-side error from the saga (e.g. 409 REPO_EXISTS). Cleared on each
   * field change. Distinct from the React Query mutation error so we can
   * render a slug-specific inline message.
   */
  const [serverError, setServerError] = useState<string | null>(null);

  const selectedView = getBoilerplateClientView(boilerplateType);

  const slugStatus: SlugStatus = useMemo(() => {
    if (!slug) return 'idle';
    if (!PV2_SLUG_REGEX.test(slug)) return 'invalid';
    if (RESERVED_APP_IDS.has(slug)) return 'reserved';
    if (apps?.some((a) => a.appId === slug)) return 'taken';
    return 'available';
  }, [slug, apps]);

  const canSubmit =
    slugStatus === 'available' && displayName.trim().length > 0 && !create.isPending;

  const reset = () => {
    setSlug('');
    setDisplayName('');
    setIcon('📦');
    // PR-46 — executionMode is hardcoded to 'pipeline'; nothing to reset.
    setBoilerplateType('nextjs-base');
    setBmadEnabled(true);
    setServerError(null);
  };

  const handleTypeChange = (next: BoilerplateType) => {
    setBoilerplateType(next);
    // Reset BMAD toggle to the default for the new type:
    //   - wired + supported → ON  (currently only `nextjs`)
    //   - everything else   → OFF
    const view = getBoilerplateClientView(next);
    setBmadEnabled(view.bmadSupported);
    setServerError(null);
  };

  const submit = () => {
    if (!canSubmit) return;
    setServerError(null);
    create.mutate(
      {
        appId: slug,
        displayName: displayName.trim(),
        icon: icon || undefined,
        executionMode,
        boilerplateType,
        bmadEnabled: selectedView.bmadSupported ? bmadEnabled : false,
      },
      {
        onSuccess: (newApp) => {
          reset();
          onOpenChange(false);
          router.push(links.app(newApp.appId));
        },
        onError: (err) => {
          // Saga rollback path: the server returns 409 REPO_EXISTS as a
          // standard AppError envelope. Surface a slug-specific helper.
          const e = err as Error & { status?: number; code?: string };
          if (e.status === 409 && (e.code === 'REPO_EXISTS' || /repo.*exists/i.test(e.message))) {
            setServerError(
              `A repo at github.com/futurator-repos/${slug} already exists. Pick a different name.`,
            );
            return;
          }
          setServerError(e.message || 'Create failed');
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a new App</DialogTitle>
          <DialogDescription>
            An App is the immortal product. You&apos;ll start its first Plan after creating it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="app-slug">Slug *</Label>
            <Input
              id="app-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value.toLowerCase());
                setServerError(null);
              }}
              placeholder="dino3"
              autoComplete="off"
              className={
                slugStatus === 'invalid' || slugStatus === 'reserved' || slugStatus === 'taken'
                  ? 'border-destructive focus-visible:ring-destructive'
                  : undefined
              }
            />
            <p className="text-xs text-muted-foreground">
              {slugStatus === 'idle' &&
                'Becomes futurator.ai/apps/<slug>/ AND github.com/futurator-repos/<slug>. Locked once created.'}
              {slugStatus === 'invalid' && (
                <span className="text-destructive">
                  Slug must be kebab-case starting with a letter (^[a-z][a-z0-9-]{'{1,39}'}$).
                </span>
              )}
              {slugStatus === 'reserved' && (
                <span className="text-destructive">
                  Slug is reserved (collides with homepage S3 paths).
                </span>
              )}
              {slugStatus === 'taken' && (
                <span className="text-destructive">Slug is already in use by another App.</span>
              )}
              {slugStatus === 'available' && <span className="text-success">✓ available</span>}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="app-display-name">Display name *</Label>
            <Input
              id="app-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Dino Runner v3"
              maxLength={80}
            />
          </div>

          <IconPicker value={icon} onChange={setIcon} disabled={create.isPending} />

          <BoilerplatePicker
            value={boilerplateType}
            onChange={handleTypeChange}
            disabled={create.isPending}
          />

          {selectedView.bmadSupported && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bmadEnabled}
                  onChange={(e) => setBmadEnabled(e.target.checked)}
                  disabled={create.isPending}
                />
                BMAD pre-installed
              </Label>
              <p className="text-xs text-muted-foreground">
                Daemon will run the BMAD bootstrap step against the new worktree after the template
                is cloned.
              </p>
            </div>
          )}

          {/* PR-46 — execution mode toggle removed. Pipeline is the only
           * supported path now. The 'orchestrator' enum value remains in
           * the type union for back-compat with persisted App rows but
           * no new App is created with it. */}

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? 'Creating…' : 'Create App'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
