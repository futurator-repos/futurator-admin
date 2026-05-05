'use client';
import { useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useReauthorizeEc2, type ReauthError } from '@/hooks/use-ec2-daemon';

interface Props {
  /** Compact variant for use inline next to status badges. */
  compact?: boolean;
  /** Optional label override. */
  label?: string;
}

// One-click button that asks the local Mac helper (scripts/mac-oauth-server.mjs)
// to push fresh Keychain OAuth to EC2. Falls back to install instructions if
// the helper isn't running.
export function ReauthorizeButton({ compact = false, label }: Props) {
  const reauth = useReauthorizeEc2();
  const [showHelp, setShowHelp] = useState(false);
  const error = reauth.error as ReauthError | null;

  const baseText = label || (compact ? 'Re-auth' : 'Re-authorize EC2');
  const text = reauth.isPending
    ? 'Pushing OAuth…'
    : reauth.isSuccess
      ? 'Pushed ✓'
      : baseText;

  return (
    <>
      <button
        onClick={() => {
          reauth.reset();
          setShowHelp(false);
          reauth.mutate(undefined, {
            onError: (err: ReauthError) => {
              if (err.kind === 'helper_not_running') setShowHelp(true);
            },
          });
        }}
        disabled={reauth.isPending}
        title="Push fresh OAuth from your Mac Keychain to EC2 (calls local helper on 127.0.0.1:9876)"
        className={`inline-flex items-center gap-1 rounded transition-colors disabled:opacity-50 ${
          compact
            ? 'h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary/50'
            : 'px-3 py-1 text-xs bg-blue-900/40 text-blue-300 hover:bg-blue-900/70'
        }`}
      >
        {reauth.isSuccess ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : (
          <RefreshCw className={`h-3 w-3 ${reauth.isPending ? 'animate-spin' : ''}`} />
        )}
        {text}
      </button>

      {error?.kind === 'sync_failed' && (
        <span
          className="inline-flex items-center gap-1 text-[10px] text-red-400"
          title={error.stderr || error.message}
        >
          <AlertTriangle className="h-3 w-3" /> {error.message}
        </span>
      )}

      {showHelp && (
        <HelperInstallDialog onClose={() => setShowHelp(false)} />
      )}
    </>
  );
}

function HelperInstallDialog({ onClose }: { onClose: () => void }) {
  const cmd =
    'cd /Users/ricardoarayafarias/GetReal/Futurator-Admin && ./scripts/install-mac-oauth-sync.sh';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-background p-4 shadow-xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Mac OAuth helper not running</h3>
        <p className="text-xs text-muted-foreground">
          The Re-authorize button needs a tiny background process on your Mac that pushes Keychain
          OAuth tokens to EC2. It listens on{' '}
          <code className="font-mono">http://127.0.0.1:9876</code> and runs at every login.
        </p>
        <p className="text-xs text-muted-foreground">Install once, in your terminal:</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded bg-muted px-2 py-1.5 text-[11px] font-mono select-all break-all">
            {cmd}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(cmd)}
            className="rounded bg-secondary px-2 py-1.5 text-[10px] hover:bg-secondary/80 shrink-0"
          >
            Copy
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          After installing, click Re-authorize again. The helper auto-syncs every 5 minutes too, so
          OAuth on EC2 stays fresh hands-off.
        </p>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
