'use client';

import { useState } from 'react';
import type { App } from '@/types/app';
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
import { useUpdateApp } from '@/hooks/use-apps';

export function AppSettingsDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const update = useUpdateApp(app.appId);
  const [displayName, setDisplayName] = useState(app.displayName);
  const [icon, setIcon] = useState(app.icon ?? '📦');
  // PR-46 — executionMode is no longer operator-editable. Pipeline is the
  // only supported path; pre-existing Apps with executionMode='orchestrator'
  // continue to work (their persisted value is honored at runtime) but the
  // settings dialog no longer surfaces the toggle.

  const submit = () => {
    update.mutate(
      { displayName: displayName.trim(), icon: icon || undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>App settings</DialogTitle>
          <DialogDescription>
            Slug ({app.appId}) is locked — only display fields are mutable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-display-name">Display name</Label>
            <Input
              id="settings-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-icon">Icon</Label>
            <Input
              id="settings-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={4}
              className="w-20 text-center text-xl"
            />
          </div>
          {/* PR-46 — Execution mode toggle removed. Pipeline is the only
           * supported path. Apps created before PR-46 retain their
           * persisted executionMode at runtime; they just can't be
           * toggled via this dialog anymore. */}
          {update.error && (
            <p className="text-sm text-destructive">{(update.error as Error).message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending || !displayName.trim()}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
