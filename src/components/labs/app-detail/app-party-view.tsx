'use client';
import { useMemo } from 'react';
import { Sparkles, CircleAlert, Loader2 } from 'lucide-react';
import { Party } from '@/components/labs/party';
import { BootstrapProgress } from '@/components/labs/party/bootstrap-progress';
import { Button } from '@/components/ui/button';
import { usePartyProject, useBootstrapMutation } from '@/hooks/use-party-projects';
import type { App } from '@/types/app';
import type { BmadStatus } from '@/types/party';

/**
 * App-scoped Party Mode view — rendered inside the App detail "Party" tab.
 *
 * The party-projects DDB row is keyed by `appId` (which equals the working-dir
 * slug under `/home/ubuntu/projects/`). For Apps that haven't enabled Party
 * yet — including Apps bootstrapped through the boilerplate saga, which today
 * intentionally skips the party-projects upsert — we surface a clean
 * "Enable Party" CTA instead of dropping the user into the legacy chooser.
 *
 *   • no row / MISSING                  → "Enable Party Mode" CTA
 *   • INSTALLING                        → live BootstrapProgress
 *   • HEALTHY / DRIFTED                 → full Party chat scoped to this App
 *   • FAILED / CORRUPTED                → "Retry install" CTA
 */
export function AppPartyView({ app }: { app: App }) {
  const projectId = app.appId;
  const { data: project, isLoading, error } = usePartyProject(projectId);
  const bootstrap = useBootstrapMutation();

  const rowNotFound = !!error && error instanceof Error && /404|not found/i.test(error.message);

  const status: BmadStatus | 'PENDING' =
    isLoading && !project
      ? 'PENDING'
      : rowNotFound
        ? 'MISSING'
        : (project?.bmadStatus ?? 'MISSING');

  const liveJobId = useMemo(() => {
    if (bootstrap.data?.jobId) return bootstrap.data.jobId;
    if (project?.lastBootstrapJobId && project.bmadStatus === 'INSTALLING') {
      return project.lastBootstrapJobId;
    }
    return null;
  }, [bootstrap.data?.jobId, project?.lastBootstrapJobId, project?.bmadStatus]);

  const installError = bootstrap.error instanceof Error ? bootstrap.error.message : null;

  if (status === 'HEALTHY' || status === 'DRIFTED') {
    return (
      <div className="space-y-3">
        {status === 'DRIFTED' && (
          <div className="flex items-center gap-2 rounded-md border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[12px] text-yellow-300">
            <CircleAlert className="h-3.5 w-3.5" />
            Custom agents have drifted from the source. Party Mode still works,
            but click Re-sync to refresh the roster.
          </div>
        )}
        <Party projectIdOverride={projectId} />
      </div>
    );
  }

  if (status === 'INSTALLING' || liveJobId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Installing BMAD on{' '}
          <span className="font-mono">{app.workingDir}</span>
        </div>
        {liveJobId && <BootstrapProgress jobId={liveJobId} />}
      </div>
    );
  }

  if (status === 'FAILED' || status === 'CORRUPTED') {
    return (
      <EmptyCta
        title={
          status === 'FAILED' ? 'BMAD install failed for this App' : 'BMAD install is corrupted'
        }
        body={
          project?.failureReason ||
          'The last install pipeline failed. Retry to re-run the install, custom-agent sync, and manifest rebuild.'
        }
        actionLabel={bootstrap.isPending ? 'Retrying…' : 'Retry install'}
        onAction={() =>
          bootstrap.mutate({ projectId, forceReinstall: true, createFolder: true })
        }
        actionDisabled={bootstrap.isPending}
        intent="danger"
        error={installError}
      />
    );
  }

  if (status === 'PENDING') {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
        <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
        Checking Party Mode status…
      </div>
    );
  }

  return (
    <EmptyCta
      title="Enable Party Mode for this App"
      body={
        <>
          Stand up the BMAD agents on this App&rsquo;s working tree
          (<span className="font-mono">{app.workingDir}</span>) so the team can
          read the codebase and debate it here. Sessions persist per App and can
          be resumed any time. Takes about 60 seconds.
        </>
      }
      actionLabel={bootstrap.isPending ? 'Enabling…' : 'Enable Party Mode'}
      onAction={() => bootstrap.mutate({ projectId, createFolder: true })}
      actionDisabled={bootstrap.isPending}
      error={installError}
    />
  );
}

interface EmptyCtaProps {
  title: string;
  body: React.ReactNode;
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
        className="mx-auto mt-2 max-w-[560px] text-[13px] leading-[1.55]"
        style={{ color: 'var(--text-dim)' }}
      >
        {body}
      </p>
      {error && (
        <p className="mx-auto mt-3 max-w-[560px] text-[12px] text-destructive">{error}</p>
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
