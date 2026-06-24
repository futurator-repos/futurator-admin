'use client';
/**
 * /labs/ultracode-reverse — the Ultracode-Reverse bench.
 *
 * Runs the SAME intent through two engines under an identical frame (single `claude`,
 * Opus 4.8 · xhigh, on the daemon) — Case 1 = native `ultracode`, Case 2 = our meta-prompt —
 * halts both at "plan produced", and scores them. The only variable is the prompt.
 *
 * Static-export safe: the active run is a `?runId=` query param, never a path param.
 */

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { useUltracodeReverseStore } from '@/stores/ultracode-reverse-store';
import { useUltracodeRun } from '@/hooks/use-ultracode-run';
import { useUltracodeScorecard } from '@/hooks/use-ultracode-scorecard';
import { IntentForm } from '@/components/ultracode-reverse/intent-form';
import { DualLiveView } from '@/components/ultracode-reverse/dual-live-view';
import { ScorecardPanel } from '@/components/ultracode-reverse/scorecard-panel';
import { RunHistory } from '@/components/ultracode-reverse/run-history';

function UltracodeReverseContent() {
  const params = useSearchParams();
  const router = useRouter();
  const urlRunId = params.get('runId');

  const draft = useUltracodeReverseStore((s) => s.draft);
  const activeRunId = useUltracodeReverseStore((s) => s.activeRunId);
  const setActiveRunId = useUltracodeReverseStore((s) => s.setActiveRunId);

  // Keep the store's activeRunId synced with the URL (deep-link / replay).
  useEffect(() => {
    if (urlRunId && urlRunId !== activeRunId) setActiveRunId(urlRunId);
  }, [urlRunId, activeRunId, setActiveRunId]);

  const { run, status, isTerminal, case1Messages, case2Messages, createRun, isCreating } =
    useUltracodeRun(activeRunId);
  const scorecardQuery = useUltracodeScorecard(activeRunId, isTerminal);

  const select = (runId: string) => {
    setActiveRunId(runId);
    router.replace(`/labs/ultracode-reverse?runId=${runId}`);
  };

  const onRun = () => {
    createRun(draft);
  };

  const running =
    isCreating || (!!status && status !== 'COMPLETE' && status !== 'ERROR' && !!activeRunId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-page-title">Ultracode Reverse</h1>
          <p className="text-sm text-muted-foreground">
            Native <code>ultracode</code> vs. our reverse-engineered planner, same frame, scored.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <IntentForm onRun={onRun} disabled={running} />
          <RunHistory activeRunId={activeRunId} onSelect={select} />
        </div>
        <div className="space-y-4 lg:col-span-2">
          <DualLiveView
            run={run}
            case1Status={run?.case1Status ?? 'PENDING'}
            case2Status={run?.case2Status ?? 'PENDING'}
            case1Messages={case1Messages}
            case2Messages={case2Messages}
          />
          <ScorecardPanel run={run} scorecard={scorecardQuery.data?.scorecard} />
        </div>
      </div>
    </div>
  );
}

export default function UltracodeReversePage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <UltracodeReverseContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
