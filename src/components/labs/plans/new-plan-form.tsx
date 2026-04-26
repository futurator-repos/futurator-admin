'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreatePlanFromIntent, useCreateEmptyBmadPlan } from '@/hooks/use-plans';
import { ChevronDown, Loader2 } from 'lucide-react';

const PLAN_NAME_REGEX = /^[a-z][a-z0-9-]{2,40}$/;

/**
 * Slugify any free-form string (display name OR intent) into a kebab-case
 * candidate that matches PLAN_NAME_REGEX. Prefixes with `plan-` if the input
 * is too short or starts with a non-letter.
 */
function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (PLAN_NAME_REGEX.test(base)) return base;
  const safe = `plan-${base}`.slice(0, 40).replace(/-+$/, '');
  return PLAN_NAME_REGEX.test(safe) ? safe : '';
}

export function NewPlanForm({ onCreated }: { onCreated?: (planId: string) => void }) {
  const router = useRouter();
  // Field order is now: (1) Plan name (display), (2) App name (slug),
  // (3) Intent. App name auto-derives from Plan name until the user edits it.
  const [displayName, setDisplayName] = useState('');
  const [appName, setAppName] = useState('');
  const [appNameDirty, setAppNameDirty] = useState(false);
  const [intent, setIntent] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [executionMode, setExecutionMode] = useState<'pipeline' | 'orchestrator'>('pipeline');
  const [devModel, setDevModel] = useState('sonnet');
  const [reviewerModel, setReviewerModel] = useState('haiku');
  // Phase C.2: TEST agent (Tier 1) defaults to sonnet. Exposed in the
  // model selector row alongside Dev and Reviewer.
  const [testModel, setTestModel] = useState('sonnet');
  const [yoloMode, setYoloMode] = useState(true);
  // Phase C.1: Rigor dial. mvp is the balanced default.
  const [rigor, setRigor] = useState<'prototype' | 'mvp' | 'production'>('mvp');
  // Phase C.2: Playwright toggle. Default derives from rigor (off for
  // prototype, on for mvp/production) but user can override.
  const [browserTestsDirty, setBrowserTestsDirty] = useState(false);
  const [browserTestsRaw, setBrowserTestsRaw] = useState(true);
  const browserTestsDefault = rigor !== 'prototype';
  const hasBrowserTests = browserTestsDirty ? browserTestsRaw : browserTestsDefault;
  // QA Review — auto-enqueue QA once the last dev wave completes. Rigor-
  // derived default (production=on, everything else=off). Editable manually.
  const [autoRunQaDirty, setAutoRunQaDirty] = useState(false);
  const [autoRunQaRaw, setAutoRunQaRaw] = useState(false);
  const autoRunQaDefault = rigor === 'production';
  const autoRunQa = autoRunQaDirty ? autoRunQaRaw : autoRunQaDefault;
  // Party Mode (BMAD) — install the 14-agent roster at plan creation so the
  // Party Mode stage can host codebase discussions. Defaults ON.
  const [bmadEnabled, setBmadEnabled] = useState(true);
  // Empty BMAD mode — skip the PM job entirely. Creates the plan + BMAD
  // skeleton with no auto-generated epics. Useful when the user wants a
  // blank canvas to drive themselves.
  const [emptyMode, setEmptyMode] = useState(false);

  const create = useCreatePlanFromIntent();
  const createEmpty = useCreateEmptyBmadPlan();
  const submitting = create.isPending || createEmpty.isPending;
  const submitError = (create.error || createEmpty.error) as Error | null;

  const suggestedAppName = useMemo(() => slugify(displayName), [displayName]);
  const effectiveAppName = appNameDirty ? appName : suggestedAppName;

  const appNameValid = PLAN_NAME_REGEX.test(effectiveAppName);
  const displayNameValid = displayName.trim().length > 0;
  // Empty mode skips the PM, so the intent textarea is optional. The API
  // schema still requires intent.length >= 10, so we substitute a placeholder
  // when the field is blank.
  const intentValid = emptyMode ? true : intent.trim().length >= 10;
  const canSubmit = displayNameValid && appNameValid && intentValid && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      if (emptyMode) {
        const { plan } = await createEmpty.mutateAsync({
          name: effectiveAppName,
          displayName: displayName.trim(),
          intent: intent.trim() || 'Empty BMAD scaffold — no PM-generated epics.',
          executionMode,
          devModel,
          reviewerModel,
          testModel,
          yoloMode,
          rigor,
          testingProfile: { hasBrowserTests },
          autoRunQa,
          bmadEnabled: true,
        });
        onCreated?.(plan.planId);
        router.push(`/labs/?planId=${plan.planId}`);
        return;
      }
      const { plan, pmJobId } = await create.mutateAsync({
        name: effectiveAppName,
        displayName: displayName.trim(),
        intent,
        executionMode,
        devModel,
        reviewerModel,
        testModel,
        yoloMode,
        rigor,
        testingProfile: { hasBrowserTests },
        autoRunQa,
        bmadEnabled,
      });
      // Notify the parent (e.g. to close the form) then ALWAYS navigate to
      // the new plan's dashboard. The old behavior of only navigating when
      // onCreated is absent stranded users on the Plans list.
      onCreated?.(plan.planId);
      router.push(`/labs/?planId=${plan.planId}&pmJobId=${pmJobId}`);
    } catch (err) {
      console.error('[NewPlanForm]', err);
    }
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>Start a new plan</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 1. Plan name — free-form display label. */}
          <div className="space-y-1">
            <Label htmlFor="displayName">Plan name</Label>
            <Input
              id="displayName"
              placeholder="Brick Breaker Game"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Human-readable label. Shown in the sidebar and the project hero.
            </p>
          </div>

          {/* 2. App name — kebab-case slug derived from Plan name, editable. */}
          <div className="space-y-1">
            <Label htmlFor="appName">App name</Label>
            <Input
              id="appName"
              placeholder={suggestedAppName || 'my-cool-app'}
              value={appNameDirty ? appName : suggestedAppName}
              onChange={(e) => {
                setAppName(e.target.value);
                setAppNameDirty(true);
              }}
              disabled={submitting}
            />
            {effectiveAppName && !appNameValid && (
              <p className="text-xs text-destructive">
                Must be kebab-case: start with a letter, 3–41 chars, a-z, 0-9, and hyphens.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Becomes the folder <code>/home/ubuntu/projects/{effectiveAppName || '…'}</code> and
              the deploy URL. Auto-derived from the plan name — edit only if you need a specific
              slug.
            </p>
          </div>

          {/* 3. Intent — the long-form brief passed to the PM. Optional in empty mode. */}
          <div className="space-y-1">
            <Label htmlFor="intent">
              What are you building?
              {emptyMode && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (optional in empty mode)
                </span>
              )}
            </Label>
            <Textarea
              id="intent"
              rows={emptyMode ? 4 : 8}
              placeholder={
                emptyMode
                  ? 'Optional — leave blank for a truly empty BMAD scaffold.'
                  : 'Describe your product intent…\nExample: "Create a classic brick-breaker game with keyboard paddle controls, 5 levels, and a score counter."'
              }
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              className="resize-y"
              disabled={submitting}
            />
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="-ml-2 flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-muted/50">
              <ChevronDown
                className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              />
              Advanced settings
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3 rounded-md border border-border bg-muted/30 p-3">
              {/* Phase C.1: Rigor dial. Full-width so each option's
                  explanation has room to breathe. */}
              <div className="space-y-1">
                <Label>Rigor level</Label>
                <Select
                  value={rigor}
                  onValueChange={(v) => v && setRigor(v as 'prototype' | 'mvp' | 'production')}
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
                <p className="text-xs text-muted-foreground">
                  {rigor === 'prototype' && 'Fastest. No tests, lenient review, skip tamper check.'}
                  {rigor === 'mvp' &&
                    'Balanced. Unit tests + basic Playwright smoke if browser tests are on.'}
                  {rigor === 'production' &&
                    'Strict. Full TEST agent gate, red-green-tamper cycle, tamper-check with auto-revert.'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Execution mode</Label>
                  <Select
                    value={executionMode}
                    onValueChange={(v) => v && setExecutionMode(v as 'pipeline' | 'orchestrator')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pipeline">Pipeline (step-based)</SelectItem>
                      <SelectItem value="orchestrator">Orchestrator (single Claude)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {/* Phase C.2: Playwright toggle. Default follows rigor
                    (off for prototype, on for mvp/production). */}
                <div className="flex-1 space-y-1">
                  <Label>Browser tests (Playwright)</Label>
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={hasBrowserTests}
                      onCheckedChange={(v) => {
                        setBrowserTestsRaw(v);
                        setBrowserTestsDirty(true);
                      }}
                    />
                    <span className="ml-2 text-xs text-muted-foreground">
                      {hasBrowserTests
                        ? 'Run Playwright smoke tests after each wave'
                        : 'Skip Playwright tests'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>YOLO mode</Label>
                  <div className="flex h-9 items-center">
                    <Switch checked={yoloMode} onCheckedChange={setYoloMode} />
                    <span className="ml-2 text-xs text-muted-foreground">
                      {yoloMode ? 'Auto-advance between phases' : 'Pause between phases'}
                    </span>
                  </div>
                </div>
                {/* Auto-run QA Review once the last Developing wave completes.
                    Default follows rigor (production=on, else off). */}
                <div className="space-y-1">
                  <Label>Auto-run QA Review</Label>
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={autoRunQa}
                      onCheckedChange={(v) => {
                        setAutoRunQaRaw(v);
                        setAutoRunQaDirty(true);
                      }}
                    />
                    <span className="ml-2 text-xs text-muted-foreground">
                      {autoRunQa
                        ? 'Auto-enqueue Visual QA when Dev finishes'
                        : 'Manual only — click Run QA Review'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Party Mode (BMAD) — installs the 14-agent roster so the Party
                  Mode stage can host debates about this codebase. */}
              <div className="space-y-1">
                <Label>Party Mode (BMAD)</Label>
                <div className="flex h-9 items-center">
                  <Switch
                    checked={emptyMode ? true : bmadEnabled}
                    onCheckedChange={setBmadEnabled}
                    disabled={emptyMode}
                  />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {emptyMode
                      ? 'Forced ON — empty mode always installs BMAD'
                      : bmadEnabled
                        ? 'Install BMAD + 8 custom agents — agents can read this project and debate it in Party Mode'
                        : 'No BMAD — Party Mode will offer a one-click install later'}
                  </span>
                </div>
              </div>

              {/* Empty BMAD — skip the PM job and create a blank-canvas plan
                  with just the BMAD skeleton. Use when you want to drive the
                  workflow yourself instead of letting the PM agent generate
                  epics from your intent. */}
              <div className="space-y-1">
                <Label>Empty BMAD (skip PM)</Label>
                <div className="flex h-9 items-center">
                  <Switch checked={emptyMode} onCheckedChange={setEmptyMode} />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {emptyMode
                      ? 'No PM job — creates plan + BMAD scaffold only, zero epics'
                      : 'PM agent generates epics from your intent (default)'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label>Dev model</Label>
                  <Select value={devModel} onValueChange={(v) => v && setDevModel(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sonnet">Sonnet</SelectItem>
                      <SelectItem value="opus">Opus</SelectItem>
                      <SelectItem value="haiku">Haiku</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Reviewer model</Label>
                  <Select value={reviewerModel} onValueChange={(v) => v && setReviewerModel(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="haiku">Haiku</SelectItem>
                      <SelectItem value="sonnet">Sonnet</SelectItem>
                      <SelectItem value="opus">Opus</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Test model</Label>
                  <Select value={testModel} onValueChange={(v) => v && setTestModel(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sonnet">Sonnet</SelectItem>
                      <SelectItem value="haiku">Haiku</SelectItem>
                      <SelectItem value="opus">Opus</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {submitError && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {submitError.message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="submit" disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitting
                ? emptyMode
                  ? 'Creating plan + installing BMAD…'
                  : 'Creating plan + spawning PM agent…'
                : emptyMode
                  ? 'Create Empty BMAD Plan'
                  : 'Generate Plan'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
