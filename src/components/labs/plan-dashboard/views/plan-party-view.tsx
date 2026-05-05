'use client';
import { useMemo } from 'react';
import { Party } from '@/components/labs/party';
import { BootstrapProgress } from '@/components/labs/party/bootstrap-progress';
import { Button } from '@/components/ui/button';
import { usePartyProject, useInstallBmadForPlan } from '@/hooks/use-party-projects';
import type { Plan } from '@/types/plan';
import type { BmadStatus } from '@/types/party';
import { Sparkles, CircleAlert, Loader2 } from 'lucide-react';

/**
 * Plan-scoped Party Mode view — rendered when the user clicks "Party Mode" on
 * the plan pipeline. Bridges the plan's `bmadEnabled` flag + the PartyProject
 * row (keyed by `plan.name`) into one cohesive panel:
 *
 *   • bmadEnabled = false           → "Enable Party Mode" CTA (retroactive)
 *   • INSTALLING / just-created     → live bootstrap progress
 *   • HEALTHY / DRIFTED             → full Party chat scoped to this plan
 *   • FAILED / CORRUPTED / MISSING  → install-failed surface + "Retry install"
 *
 * The chat itself re-uses `<Party projectIdOverride={plan.name} />` so all the
 * existing rendering (avatar rail, rich markdown, doc tray) comes for free.
 */
export function PlanPartyView({ plan }: { plan: Plan }) {
  const bmadEnabled = plan.bmadEnabled !== false;
  const { data: project, isLoading, error } = usePartyProject(bmadEnabled ? plan.name : null);
  const install = useInstallBmadForPlan();

  // A 404 on the party-project row is expected for older plans that were
  // created before `bmadEnabled` existed. Treat it the same as a fresh
  // MISSING row so the user gets the "install BMAD" CTA rather than a
  // blank screen.
  const rowNotFound =
    !!error && error instanceof Error && /404|not found/i.test(error.message);

  const bmadStatus: BmadStatus | 'NOT_ENABLED' | 'PENDING' = !bmadEnabled
    ? 'NOT_ENABLED'
    : isLoading && !project
      ? 'PENDING'
      : rowNotFound
        ? 'MISSING'
        : (project?.bmadStatus ?? 'MISSING');

  // The bootstrap job to watch: either the one we just kicked off, or whatever
  // the server has recorded as the last one on the project row.
  const liveJobId = useMemo(() => {
    if (install.data?.bmadJobId) return install.data.bmadJobId;
    if (project?.lastBootstrapJobId && project.bmadStatus === 'INSTALLING') {
      return project.lastBootstrapJobId;
    }
    return null;
  }, [install.data?.bmadJobId, project?.lastBootstrapJobId, project?.bmadStatus]);

  // Healthy / Drifted → show the chat. (Drifted still lets you chat; the
  // drift badge is informational until the user clicks "Re-sync".)
  if (bmadStatus === 'HEALTHY' || bmadStatus === 'DRIFTED') {
    return (
      <div className="space-y-3">
        {bmadStatus === 'DRIFTED' && (
          <div className="flex items-center gap-2 rounded-md border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[12px] text-yellow-300">
            <CircleAlert className="h-3.5 w-3.5" />
            Custom agents have drifted from the source. Party Mode still works,
            but click Re-sync to refresh the roster.
          </div>
        )}
        <Party projectIdOverride={plan.name} />
      </div>
    );
  }

  if (bmadStatus === 'NOT_ENABLED') {
    return (
      <EmptyCta
        title="Party Mode isn't enabled for this plan"
        body="Install BMAD and the 8 custom agents so the team can read this codebase and debate it here. Takes about 60 seconds."
        actionLabel={install.isPending ? 'Enabling…' : 'Enable Party Mode'}
        onAction={() => install.mutate(plan.planId)}
        actionDisabled={install.isPending}
        error={install.error instanceof Error ? install.error.message : null}
      />
    );
  }

  if (bmadStatus === 'INSTALLING' || liveJobId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Installing BMAD + the 14-agent roster on{' '}
          <span className="font-mono">{plan.workingDir}</span>
        </div>
        {liveJobId && <BootstrapProgress jobId={liveJobId} />}
      </div>
    );
  }

  if (bmadStatus === 'FAILED' || bmadStatus === 'CORRUPTED') {
    return (
      <EmptyCta
        title={
          bmadStatus === 'FAILED'
            ? 'BMAD install failed on this plan'
            : 'BMAD install is corrupted'
        }
        body={
          project?.failureReason ||
          'The last install pipeline failed. Retry to try again — this re-runs the install, custom-agent sync, and manifest rebuild.'
        }
        actionLabel={install.isPending ? 'Retrying…' : 'Retry install'}
        onAction={() => install.mutate(plan.planId)}
        actionDisabled={install.isPending}
        intent="danger"
      />
    );
  }

  if (bmadStatus === 'PENDING') {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        Checking Party Mode status…
      </div>
    );
  }

  // MISSING covers both "plan was created without BMAD and the row has a
  // MISSING status" and "plan pre-dates bmadEnabled and has no row at all".
  // Both resolve with the same one-click install.
  return (
    <EmptyCta
      title="Party Mode needs a quick install on this plan"
      body="Install BMAD + the 8 custom agents (Ludwig, Pedrock, Sue Render, Rick, and co.) so the team can read this codebase and debate it here. Takes about 60 seconds."
      actionLabel={install.isPending ? 'Installing…' : 'Install BMAD & enable Party Mode'}
      onAction={() => install.mutate(plan.planId)}
      actionDisabled={install.isPending}
      error={install.error instanceof Error ? install.error.message : null}
    />
  );
}

interface EmptyCtaProps {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
  error?: string | null;
  intent?: 'primary' | 'danger';
}

function EmptyCta({
  title,
  body,
  actionLabel,
  onAction,
  actionDisabled,
  error,
  intent = 'primary',
}: EmptyCtaProps) {
  return (
    <div
      style={{
        border: `1px ${intent === 'danger' ? 'solid' : 'dashed'} var(--border-2)`,
        borderRadius: 12,
        padding: '56px 32px',
        textAlign: 'center',
        background:
          intent === 'danger'
            ? 'color-mix(in srgb, var(--destructive) 4%, transparent)'
            : 'linear-gradient(180deg, color-mix(in srgb, var(--accent-purple) 6%, transparent), transparent)',
      }}
    >
      <div
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
        style={{
          background:
            intent === 'danger'
              ? 'color-mix(in srgb, var(--destructive) 18%, transparent)'
              : 'color-mix(in srgb, var(--accent-purple) 18%, transparent)',
          color: intent === 'danger' ? 'var(--destructive)' : 'var(--accent-purple)',
        }}
      >
        {intent === 'danger' ? (
          <CircleAlert className="h-6 w-6" />
        ) : (
          <Sparkles className="h-6 w-6" />
        )}
      </div>
      <h3 className="text-[17px] font-semibold text-foreground">{title}</h3>
      <p
        className="mx-auto mt-2 max-w-[520px] text-[13px] leading-[1.55]"
        style={{ color: 'var(--text-dim)' }}
      >
        {body}
      </p>
      {error && (
        <p className="mx-auto mt-3 max-w-[520px] text-[12px] text-destructive">{error}</p>
      )}
      <div className="mt-5 flex justify-center">
        <Button
          size="sm"
          onClick={onAction}
          disabled={actionDisabled}
          variant={intent === 'danger' ? 'destructive' : 'default'}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
