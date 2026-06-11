'use client';
/**
 * Story 21.5 + 22.5 (party-push Epic 21 + Epic 22) — Checkpoint card.
 *
 * Renders one of four checkpoint event variants emitted by party-turn.mjs:
 *   - composed: commit landed locally; push gated off (project.pushEnabled=false)
 *   - pushed:   commit landed AND pushed to GitHub
 *   - blocked:  secrets scan stopped the commit
 *   - failed:   non-zero exit from party-checkpoint.sh
 *
 * Three operator actions (the "downstream automation surface" from plan.md §1):
 *   1. Open PR    — calls POST /api/party/sessions/:id/checkpoints/:sha/pr
 *                    (Story 22.3 endpoint). Shown on `pushed` cards AND on
 *                    `composed` cards once the project has opted into push
 *                    (2026-06-11): the endpoint pushes the branch first, so a
 *                    locally-committed checkpoint can still become a PR. The
 *                    `composed` variant is labelled "Push & open PR".
 *   2. Continue   — closes the card; the operator drives more turns in the
 *      locally       same session. Always visible.
 *   3. Start      — deep-links to /labs?createPlanForApp=<projectId>&sourceCommitSha=<sha>&sourceBranch=<branch>
 *      story-      so the existing plan-creation flow opens with the source
 *      pipeline    fields pre-populated (Story 22.4 plumbing).
 *
 * "Elicit further" is deferred per Free Explorer §9.2.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Cloud,
  CloudOff,
  GitBranch,
  GitPullRequest,
  Loader2,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOpenCheckpointPr } from '@/hooks/use-party-audit';
import type { RoundCheckpoint } from '../turn-adapter';
import { COLORS } from './tokens';

interface Props {
  sessionId: string;
  projectId: string;
  /** Per-project gitBranch + pushEnabled drive button visibility. */
  pushEnabled: boolean;
  checkpoint: RoundCheckpoint;
}

export function CheckpointCard({ sessionId, projectId, pushEnabled, checkpoint }: Props) {
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const openPr = useOpenCheckpointPr();

  const { kind, title, summary, branch, commitSha, reason } = checkpoint;
  const sha = commitSha?.slice(0, 7) ?? '';
  const isErrorVariant = kind === 'blocked' || kind === 'failed';

  async function handleOpenPr() {
    if (!commitSha) return;
    setPrError(null);
    try {
      const result = await openPr.mutateAsync({
        sessionId,
        sha: commitSha,
        title: title ? `party(${projectId}): ${title}` : undefined,
      });
      setPrUrl(result.prUrl);
    } catch (err) {
      setPrError((err as Error).message);
    }
  }

  const accent =
    kind === 'pushed'
      ? 'var(--success)'
      : kind === 'blocked' || kind === 'failed'
        ? 'var(--destructive)'
        : 'var(--accent-purple)';

  const icon =
    kind === 'pushed' ? (
      <Cloud className="h-4 w-4" style={{ color: accent }} />
    ) : kind === 'composed' ? (
      <CloudOff className="h-4 w-4" style={{ color: accent }} />
    ) : kind === 'blocked' ? (
      <ShieldAlert className="h-4 w-4" style={{ color: accent }} />
    ) : (
      <XCircle className="h-4 w-4" style={{ color: accent }} />
    );

  const headline =
    kind === 'pushed'
      ? 'Checkpoint pushed'
      : kind === 'composed'
        ? 'Checkpoint committed locally'
        : kind === 'blocked'
          ? 'Checkpoint blocked'
          : 'Checkpoint failed';

  return (
    <div
      className="mx-6 mb-4 rounded-md border p-3"
      data-testid={`checkpoint-card-${kind}`}
      style={{
        background: isErrorVariant
          ? 'color-mix(in srgb, var(--destructive) 6%, transparent)'
          : 'color-mix(in srgb, var(--accent-purple) 6%, transparent)',
        borderColor: isErrorVariant
          ? 'color-mix(in srgb, var(--destructive) 30%, transparent)'
          : 'color-mix(in srgb, var(--accent-purple) 30%, transparent)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span
          className="text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: accent }}
        >
          {headline}
        </span>
        {sha && (
          <span
            className="ml-auto rounded-full border px-2 py-0.5 font-mono text-[10.5px]"
            style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
            title={commitSha || undefined}
          >
            {sha}
          </span>
        )}
      </div>

      {title && (
        <div className="mb-1 text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
          {title}
        </div>
      )}
      {summary && (
        <div
          className="mb-2 whitespace-pre-wrap text-[12px] leading-relaxed"
          style={{ color: COLORS.textBody }}
        >
          {summary}
        </div>
      )}

      <div
        className="mt-2 flex flex-wrap items-center gap-2 text-[11px]"
        style={{ color: COLORS.textMuted }}
      >
        {branch && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{branch}</span>
          </span>
        )}
        {reason &&
          reason !== (kind === 'pushed' ? 'PUSHED' : kind === 'composed' ? 'COMPOSED' : '') && (
            <span
              className="rounded border px-1.5 py-px font-mono uppercase tracking-wider"
              style={{ borderColor: COLORS.bgDeepest }}
            >
              {reason}
            </span>
          )}
      </div>

      {/* Actions */}
      {(kind === 'pushed' || kind === 'composed') && commitSha && (
        <div
          className="mt-3 flex flex-wrap gap-2 border-t pt-2"
          style={{ borderColor: COLORS.bgDeepest }}
        >
          {/* Open-PR is available on pushed cards always, and on composed
              cards once push is enabled — the endpoint pushes the local
              branch first. The label tells the operator which will happen. */}
          {(kind === 'pushed' || (kind === 'composed' && pushEnabled)) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleOpenPr}
              disabled={openPr.isPending || !!prUrl}
              className="h-7 text-[11px]"
              data-testid="checkpoint-open-pr"
            >
              {openPr.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {!openPr.isPending && <GitPullRequest className="mr-1 h-3 w-3" />}
              {prUrl ? 'PR opened' : kind === 'composed' ? 'Push & open PR' : 'Open PR'}
            </Button>
          )}
          {/* composed + push NOT enabled → point the operator at the consent
              gate instead of silently hiding the path (the gate is correct;
              the missing affordance was the bug). */}
          {kind === 'composed' && !pushEnabled && (
            <Link
              href="/migrate"
              className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-purple) 35%, transparent)',
                color: COLORS.accentOrch,
              }}
              data-testid="checkpoint-enable-push"
              title="This commit is local-only. Enable push for the project to open a PR from it."
            >
              <GitPullRequest className="h-3 w-3" />
              Enable push to open PR →
            </Link>
          )}
          {prUrl && (
            <Link
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center rounded-md border px-2 text-[11px]"
              style={{
                borderColor: COLORS.bgDeepest,
                color: COLORS.inlineLink,
              }}
              data-testid="checkpoint-pr-link"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" />
              View PR ↗
            </Link>
          )}
          <Link
            href={`/labs?createPlanForApp=${encodeURIComponent(projectId)}&sourceCommitSha=${commitSha}${branch ? `&sourceBranch=${encodeURIComponent(branch)}` : ''}`}
            className="inline-flex h-7 items-center rounded-md border px-2 text-[11px]"
            style={{
              borderColor: COLORS.bgDeepest,
              color: COLORS.textMuted,
            }}
            data-testid="checkpoint-start-pipeline"
            title="Open the plan-creation modal pre-populated with this commit as the source"
          >
            Start story-pipeline →
          </Link>
        </div>
      )}

      {prError && (
        <div
          className="mt-2 rounded border px-2 py-1 text-[11px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--destructive) 30%, transparent)',
            color: 'var(--destructive)',
          }}
          data-testid="checkpoint-pr-error"
        >
          Open PR failed: {prError}
        </div>
      )}
    </div>
  );
}
