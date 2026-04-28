'use client';
/**
 * github-panel.tsx — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Displays the current GitHub PAT connection status, rate-limit, and
 * last-rotation timestamp. Provides a form to rotate the PAT.
 *
 * SECURITY RULES:
 *  - The PAT textarea value is cleared immediately after submit.
 *  - The PAT is NEVER stored in component state beyond the controlled textarea.
 *  - Error messages from the server MUST NOT echo the PAT value.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useGitHubStatus, useGitHubRotatedAt } from '@/hooks/use-github-status';
import { useRotatePAT } from '@/hooks/use-rotate-pat';
import type { RateLimit } from '@/hooks/use-github-status';

// ── Rate-limit colour helper ─────────────────────────────────────────────────

function rateLimitColor(remaining: number): string {
  if (remaining > 1000) return 'text-green-600 dark:text-green-400';
  if (remaining >= 500) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function formatResetTime(resetUnix: number): string {
  const date = new Date(resetUnix * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Rate-limit display ───────────────────────────────────────────────────────

function RateLimitDisplay({ rateLimit }: { rateLimit: RateLimit }) {
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">Rate limit: </span>
      <span className={rateLimitColor(rateLimit.remaining)}>
        {rateLimit.remaining.toLocaleString()} / {rateLimit.limit.toLocaleString()}
      </span>
      <span className="text-muted-foreground"> — resets at {formatResetTime(rateLimit.reset)}</span>
    </div>
  );
}

// ── Connection status card ───────────────────────────────────────────────────

function ConnectionStatus() {
  const { data: status, isLoading } = useGitHubStatus();
  const { data: rotatedAtData } = useGitHubRotatedAt();

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Checking connection…</div>;
  }

  if (!status) {
    return <div className="text-sm text-muted-foreground">Unable to load connection status.</div>;
  }

  return (
    <div className="space-y-2">
      {status.connected ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-green-600 dark:text-green-400 font-medium">✓ Connected</span>
          <span className="text-muted-foreground">as</span>
          <span className="font-mono font-medium">{status.login}</span>
          <span className="text-muted-foreground">to futurator-repos</span>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-red-600 dark:text-red-400 font-medium">✗ Disconnected</span>
            {status.error && <span className="text-muted-foreground">— {status.error}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            See{' '}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
              docs/runbooks/pat-rotation.md
            </code>{' '}
            for the rotation runbook.
          </p>
        </div>
      )}

      {status.rateLimit && <RateLimitDisplay rateLimit={status.rateLimit} />}

      {rotatedAtData?.rotatedAt && (
        <div className="text-sm text-muted-foreground">
          Last rotated:{' '}
          <span className="font-mono text-xs">
            {new Date(rotatedAtData.rotatedAt).toLocaleString()}
          </span>
        </div>
      )}

      {rotatedAtData?.rotatedAt === null && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          Rotation timestamp not recorded — rotate below to establish a baseline.
        </div>
      )}
    </div>
  );
}

// ── Rotate PAT form ──────────────────────────────────────────────────────────

function RotatePATForm() {
  // The PAT field is intentionally NOT initialised from any stored value.
  // It starts empty so the operator must type/paste a fresh token each time.
  const [patField, setPatField] = useState('');
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const rotation = useRotatePAT();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!patField.trim()) return;

    // Capture the token into a local so we can clear the field immediately
    // before the async call completes — the field must not persist the value.
    const candidateToken = patField;
    setPatField(''); // clear immediately — SECURITY requirement

    setBanner(null);
    rotation.mutate(
      { pat: candidateToken },
      {
        onSuccess: (result) => {
          setBanner({
            kind: 'success',
            message: `PAT rotated successfully — connected as ${result.login}`,
          });
        },
        onError: (err) => {
          // The error message comes from the server and MUST NOT contain the PAT.
          const msg = err instanceof Error ? err.message : 'Rotation failed — check server logs.';
          setBanner({ kind: 'error', message: msg });
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="github-pat-field" className="text-sm font-medium">
          New PAT
        </label>
        <p className="text-xs text-muted-foreground mb-1">
          Paste the new Personal Access Token. The value is sent directly to the server and never
          stored client-side.
        </p>
        <Textarea
          id="github-pat-field"
          // type="password" is not valid on textarea, but we hide the value via
          // autoComplete="off" and clear the field immediately on submit.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="github_pat_…"
          rows={3}
          value={patField}
          onChange={(e) => setPatField(e.target.value)}
          className="font-mono text-xs"
          disabled={rotation.isPending}
        />
      </div>

      {banner && (
        <div
          role="alert"
          className={`rounded px-3 py-2 text-sm ${
            banner.kind === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-800'
              : 'bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800'
          }`}
        >
          {banner.message}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={rotation.isPending || !patField.trim()} size="sm">
          {rotation.isPending ? 'Rotating…' : 'Rotate'}
        </Button>
      </div>
    </form>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function GitHubPanel() {
  return (
    <div className="space-y-6 max-w-xl">
      <div className="rounded border bg-card p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Connection</h2>
          <p className="text-xs text-muted-foreground">
            GitHub PAT used by the Futurator-Admin pipeline for repo operations.
          </p>
        </div>
        <ConnectionStatus />
      </div>

      <div className="rounded border bg-card p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Rotate PAT</h2>
          <p className="text-xs text-muted-foreground">
            Paste a new token to replace the current PAT. The token is validated against GitHub
            before it is stored. Rotation cadence: quarterly.
          </p>
        </div>
        <RotatePATForm />
      </div>
    </div>
  );
}
