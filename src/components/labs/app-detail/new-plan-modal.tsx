'use client';

import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useCreatePlanForApp } from '@/hooks/use-apps';
import { links } from '@/lib/links';

export function NewPlanModal({
  appId,
  hasExistingPlans,
  open,
  onOpenChange,
}: {
  appId: string;
  hasExistingPlans: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const create = useCreatePlanForApp(appId);
  const [intent, setIntent] = useState('');
  const [rigor, setRigor] = useState<'prototype' | 'mvp' | 'production'>('mvp');
  const [slug, setSlug] = useState('');

  // PR-10 #1 — slug is optional. When empty, server generates a unique
  // `${appId}-${kind}-${shortHash}` so multi-plan-per-app stops colliding.
  // When provided, must match `^[a-z][a-z0-9-]{2,40}$` per planNameSchema.
  const slugPattern = /^[a-z][a-z0-9-]{2,40}$/;
  const slugValid = slug.length === 0 || slugPattern.test(slug);

  const canSubmit =
    intent.length >= 10 && intent.length <= 2000 && slugValid && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        kind: hasExistingPlans ? 'change' : 'initial',
        intent,
        rigor,
        ...(slug ? { name: slug } : {}),
      },
      {
        onSuccess: (response) => {
          setIntent('');
          setRigor('mvp');
          setSlug('');
          onOpenChange(false);
          // PR-9: forward pmJobId to the dashboard so it auto-polls + applies
          // the PM output as soon as the agent finishes — operator no longer
          // has to click Regenerate to kick off the work they just submitted.
          // links.plan() already returns `?appId=…&planId=…`, so pmJobId
          // joins with `&` (NOT `?` — that produces a malformed URL).
          const base = links.plan(appId, response.plan.planId);
          const url = response.pmJobId ? `${base}&pmJobId=${response.pmJobId}` : base;
          router.push(url);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {hasExistingPlans ? 'Continue working on this App' : 'Start your first Plan'}
          </DialogTitle>
          <DialogDescription>
            {hasExistingPlans
              ? "What do you want to change in this iteration?"
              : 'Describe what you want to build.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          rows={6}
          placeholder="e.g., Make it work on mobile — touch controls, responsive layout, tap-to-restart."
          maxLength={2000}
        />
        <p className="text-xs text-muted-foreground">
          {intent.length} / 2000 characters · minimum 10
        </p>

        {/* PR-10 #1 — optional plan slug. Multi-plan-per-app needs a unique
            slug to avoid collisions; left blank, server auto-generates one. */}
        <div className="mt-3 space-y-1">
          <label className="text-sm font-medium" htmlFor="plan-slug-input">
            Plan slug <span className="text-xs text-muted-foreground">(optional)</span>
          </label>
          <input
            id="plan-slug-input"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder={
              hasExistingPlans
                ? `e.g., ${appId}-mobile-pass`
                : `e.g., ${appId}-initial`
            }
            className="w-full rounded border border-input bg-transparent px-3 py-2 text-sm font-mono focus:border-foreground focus:outline-none disabled:opacity-50"
            disabled={create.isPending}
          />
          <p className="text-xs text-muted-foreground">
            kebab-case, 3–41 chars, starts with a letter. Leave blank to auto-generate.
            {slug.length > 0 && !slugValid && (
              <span className="ml-1 text-destructive">Slug is invalid.</span>
            )}
          </p>
        </div>

        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium">Rigor</p>
          <div className="grid gap-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 hover:bg-accent has-[:checked]:border-foreground">
              <input
                type="radio"
                name="rigor"
                value="prototype"
                checked={rigor === 'prototype'}
                onChange={() => setRigor('prototype')}
                className="mt-1"
              />
              <div className="text-sm">
                <div className="font-medium">Prototype</div>
                <div className="text-xs text-muted-foreground">
                  Skip tests + tamper-check. Fastest. Manual visual review only.
                </div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 hover:bg-accent has-[:checked]:border-foreground">
              <input
                type="radio"
                name="rigor"
                value="mvp"
                checked={rigor === 'mvp'}
                onChange={() => setRigor('mvp')}
                className="mt-1"
              />
              <div className="text-sm">
                <div className="font-medium">MVP (recommended)</div>
                <div className="text-xs text-muted-foreground">
                  Unit tests + manual visual approval. Balanced default.
                </div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 hover:bg-accent has-[:checked]:border-foreground">
              <input
                type="radio"
                name="rigor"
                value="production"
                checked={rigor === 'production'}
                onChange={() => setRigor('production')}
                className="mt-1"
              />
              <div className="text-sm">
                <div className="font-medium">Production</div>
                <div className="text-xs text-muted-foreground">
                  Full red-green-tamper cycle + auto Playwright visual tests.
                </div>
              </div>
            </label>
          </div>
        </div>
        {create.error && (
          <p className="text-sm text-destructive">{(create.error as Error).message}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? 'Planning…' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
