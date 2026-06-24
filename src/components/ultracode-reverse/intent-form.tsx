'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUltracodeReverseStore } from '@/stores/ultracode-reverse-store';
import type { UltracodeRigor, UltracodeTarget } from '@/types/ultracode-run';

interface IntentFormProps {
  onRun(): void;
  disabled: boolean;
}

export function IntentForm({ onRun, disabled }: IntentFormProps) {
  const draft = useUltracodeReverseStore((s) => s.draft);
  const setDraft = useUltracodeReverseStore((s) => s.setDraft);
  const tooShort = draft.intent.trim().length < 8;

  return (
    <Card>
      <CardHeader>
        <CardTitle>New bench run</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ur-intent">Intent</Label>
          <Textarea
            id="ur-intent"
            placeholder="e.g. create a production-ready classic pacman with tests"
            rows={3}
            value={draft.intent}
            onChange={(e) => setDraft({ intent: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label>Target</Label>
            <Select
              value={draft.target}
              onValueChange={(v) => setDraft({ target: v as UltracodeTarget })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="greenfield">greenfield</SelectItem>
                <SelectItem value="brownfield">brownfield</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Rigor</Label>
            <Select
              value={draft.rigor}
              onValueChange={(v) => setDraft({ rigor: v as UltracodeRigor })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="prototype">prototype</SelectItem>
                <SelectItem value="mvp">mvp</SelectItem>
                <SelectItem value="production">production</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ur-reps">Reps</Label>
            <Input
              id="ur-reps"
              type="number"
              min={1}
              max={5}
              value={draft.reps}
              onChange={(e) =>
                setDraft({ reps: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })
              }
            />
          </div>
        </div>
        <Button onClick={onRun} disabled={disabled || tooShort} className="w-full">
          {disabled ? 'Running…' : 'Run bench'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Both engines run a single <code>claude</code> at Opus&nbsp;4.8 · xhigh on the daemon —
          Case 1 native <code>ultracode</code>, Case 2 our meta-prompt. The only variable is the
          prompt.
        </p>
      </CardContent>
    </Card>
  );
}
