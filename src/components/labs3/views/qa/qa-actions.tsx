'use client';

/**
 * QaActions — QA-Review W2 verdict strip + Approve / Send-back CTAs.
 *
 * Renders the plan-level P3QaVerdict as a compact verdict pill (ready /
 * blocking / stale / no-report) plus the two operator actions:
 *
 *   Approve   — blesses the pinned `qaCommitSha` so W3 (a separate pipeline
 *               stage) dispatches the promotion of exactly that commit —
 *               this button only records the operator's decision, it does
 *               NOT deploy. Disabled whenever the verdict is BLOCKING (a
 *               real journey/VQA/wiring failure) or STALE (the verdict ran
 *               against a commit that is no longer the plan's current
 *               qaCommitSha — re-run QA first). The disabled reason is
 *               always shown, never a silent no-op.
 *   Send back — always available; mints fix stories from the failing
 *               journeys/VQA/wiring findings via useSendBackP3Qa. Unlike
 *               Approve it is NOT gated on staleness — an operator can bounce
 *               a stale-but-obviously-bad build back to dev without waiting
 *               on a re-run.
 *
 * Presentational except for the two plan-keyed mutations it wires directly
 * (useApproveP3Qa/useSendBackP3Qa), per the W2 contract. COPIES the
 * Approve/Send-back button idiom from the legacy verdict strip
 * (src/components/labs/plan-dashboard/views/qa/verdict-strip.tsx) — border/
 * background/color-by-state, Loader2 spinner, disabled cursor/opacity — but
 * targets the P3-native P3QaVerdict shape instead of the legacy QaReport.
 */

import { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Send, ShieldCheck } from 'lucide-react';
import { useApproveP3Qa, useSendBackP3Qa } from '@/hooks/use-p3-qa-report';
import type { P3QaVerdict } from '@/types/qa-review-p3';
import { shortSha } from './dev-url-card';

export interface QaActionsProps {
  planId: string;
  /** plan.p3QaVerdict — null when QA has never run against this plan. */
  verdict: P3QaVerdict | null;
  /** plan.qaCommitSha — the plan's CURRENT frozen commit (used to detect staleness). */
  currentQaCommitSha: string;
}

// ── Pure helpers (exported + unit-tested) ────────────────────────────

export type QaActionState = 'no-report' | 'stale' | 'blocking' | 'ready';

/**
 * Derive the Approve gate state purely from the verdict + the plan's current
 * pinned commit. `stale` beats `blocking` — a verdict computed against a
 * commit that's no longer current is untrustworthy regardless of what it
 * says; it must be re-run before being trusted either way.
 */
export function deriveQaActionState(
  verdict: P3QaVerdict | null,
  currentQaCommitSha: string,
): QaActionState {
  if (!verdict) return 'no-report';
  if (verdict.ranAtSha !== currentQaCommitSha) return 'stale';
  if (verdict.blocking) return 'blocking';
  return 'ready';
}

/**
 * Human-readable reason Approve is disabled, or `null` when it's enabled.
 * Never a silent disable — the operator always sees WHY.
 */
export function approveBlockReason(
  state: QaActionState,
  verdict: P3QaVerdict | null,
  currentQaCommitSha: string,
): string | null {
  if (state === 'ready') return null;

  if (state === 'no-report') {
    return 'No QA verdict yet — run QA against the assembled app before approving.';
  }

  if (state === 'stale') {
    return `QA verdict is stale — it ran against ${shortSha(
      verdict?.ranAtSha ?? '',
    )}, but the plan's current commit is ${shortSha(currentQaCommitSha)}. Re-run QA before approving.`;
  }

  // state === 'blocking'
  const reasons: string[] = [];
  const failedJourneys = verdict?.journeys.filter((j) => j.verdict === 'fail').length ?? 0;
  if (failedJourneys > 0) {
    reasons.push(`${failedJourneys} journey${failedJourneys === 1 ? '' : 's'} failed`);
  }
  const failedVqa = verdict?.vqa.filter((v) => v.verdict === 'fail').length ?? 0;
  if (failedVqa > 0) {
    reasons.push(`${failedVqa} VQA fail${failedVqa === 1 ? '' : 's'}`);
  }
  const orphanCount = verdict?.wiring.orphanModules.length ?? 0;
  if (verdict?.wiring.blocking && orphanCount > 0) {
    reasons.push(`${orphanCount} orphan module${orphanCount === 1 ? '' : 's'}`);
  }
  return reasons.length > 0 ? reasons.join(' · ') : 'Blocking issues present.';
}

const STATE_META: Record<QaActionState, { label: string; color: string }> = {
  ready: { label: 'All pass', color: 'var(--success)' },
  blocking: { label: 'Blocking', color: 'var(--destructive)' },
  stale: { label: 'Stale', color: 'var(--warning)' },
  'no-report': { label: 'No verdict', color: 'var(--text-mute)' },
};

// ── Component ────────────────────────────────────────────────────────

export function QaActions({ planId, verdict, currentQaCommitSha }: QaActionsProps) {
  const approve = useApproveP3Qa(planId);
  const sendBack = useSendBackP3Qa(planId);
  const [note, setNote] = useState('');

  const state = useMemo(
    () => deriveQaActionState(verdict, currentQaCommitSha),
    [verdict, currentQaCommitSha],
  );
  const reason = useMemo(
    () => approveBlockReason(state, verdict, currentQaCommitSha),
    [state, verdict, currentQaCommitSha],
  );
  const meta = STATE_META[state];
  const sha = shortSha(currentQaCommitSha);
  const approveDisabled = state !== 'ready' || approve.isPending;

  const approveErr = approve.isError
    ? approve.error instanceof Error
      ? approve.error.message
      : String(approve.error)
    : null;
  const sendBackErr = sendBack.isError
    ? sendBack.error instanceof Error
      ? sendBack.error.message
      : String(sendBack.error)
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 18px',
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {/* Verdict pill */}
        <div
          title={reason ?? 'All journeys, VQA, and wiring checks passed against this commit.'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 16px',
            border: `1px solid ${meta.color}`,
            background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
            borderRadius: 2,
          }}
        >
          <span
            style={{
              background: meta.color,
              width: 8,
              height: 8,
              borderRadius: '50%',
              display: 'inline-block',
              boxShadow: state === 'blocking' ? `0 0 10px ${meta.color}` : 'none',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: meta.color,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 500,
            }}
          >
            {meta.label}
          </span>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={() => {
              if (!approveDisabled) approve.mutate();
            }}
            disabled={approveDisabled}
            aria-label={
              approveDisabled ? `Approve disabled: ${reason}` : `Approve and promote ${sha}`
            }
            title={
              reason ??
              `Blesses ${sha} so W3 promotes exactly this commit. Dispatch happens in W3, not here.`
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '8px 16px',
              border: `1px solid ${approveDisabled ? 'var(--border-2)' : 'var(--success)'}`,
              borderRadius: 2,
              color: approveDisabled ? 'var(--text-faint)' : 'var(--success)',
              background: approveDisabled
                ? 'transparent'
                : 'color-mix(in srgb, var(--success) 10%, transparent)',
              fontWeight: 500,
              cursor: approveDisabled ? 'not-allowed' : 'pointer',
              opacity: approveDisabled ? 0.55 : 1,
            }}
          >
            {approve.isPending ? (
              <Loader2 size={11} className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck size={11} aria-hidden />
            )}
            Approve · promote {sha}
          </button>

          <button
            type="button"
            onClick={() => {
              if (!sendBack.isPending) sendBack.mutate({ note: note.trim() || undefined });
            }}
            disabled={sendBack.isPending}
            title="Sends the assembled app back to dev and mints fix stories from the failing journeys/VQA/wiring findings."
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '8px 16px',
              border: '1px solid var(--destructive)',
              borderRadius: 2,
              color: 'var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
              fontWeight: 500,
              cursor: sendBack.isPending ? 'not-allowed' : 'pointer',
              opacity: sendBack.isPending ? 0.6 : 1,
            }}
          >
            {sendBack.isPending ? (
              <Loader2 size={11} className="animate-spin" aria-hidden />
            ) : (
              <Send size={11} aria-hidden />
            )}
            Send back
          </button>
        </div>
      </div>

      {/* Blocking/stale reason — always visible, never a silent disable */}
      {reason && (
        <div
          role="alert"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            color: state === 'stale' ? 'var(--warning)' : 'var(--destructive)',
            background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
            borderRadius: 5,
            padding: '8px 11px',
          }}
        >
          {reason}
        </div>
      )}

      {/* Optional send-back note */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8.5,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
          }}
        >
          Send-back note (optional)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Context for the fix stories the send-back mints…"
          style={{
            resize: 'vertical',
            fontSize: 12,
            fontFamily: 'inherit',
            padding: '6px 8px',
            border: '1px solid var(--border-2)',
            borderRadius: 4,
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        />
      </label>

      {(approveErr || sendBackErr) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {approveErr && (
            <span role="alert" style={{ fontSize: 10.5, color: 'var(--destructive)' }}>
              Approve failed: {approveErr}
            </span>
          )}
          {sendBackErr && (
            <span role="alert" style={{ fontSize: 10.5, color: 'var(--destructive)' }}>
              Send-back failed: {sendBackErr}
            </span>
          )}
        </div>
      )}

      {approve.isSuccess && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10.5,
            color: 'var(--success)',
          }}
        >
          <CheckCircle2 size={11} aria-hidden />
          Approved — {sha} blessed for W3 promotion.
        </span>
      )}
    </div>
  );
}
