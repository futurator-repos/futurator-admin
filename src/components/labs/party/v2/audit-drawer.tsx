'use client';
/**
 * Story 22.7 (party-push Epic 22) — Audit drawer.
 *
 * Right-side drawer (same panel layout as file-drawer) that surfaces every
 * audit-relevant party event for the current session in chronological
 * order. Three sections:
 *   - Checkpoints — composed | pushed | blocked | failed (link to PR / commit)
 *   - Agent questions — ASK_HUMAN events with answered/unanswered chip
 *   - Tool default-allows — every party.tool.default-allow audit line
 *     (lets the operator grow the deny-list from real signal per
 *     Free Explorer §13.1)
 *
 * Opens via a small "Audit" button in the session header (Story 22.7 Task 5
 * — wire this where the header has the other rail toggles). For this MVP
 * the drawer is rendered as a controlled component and the parent owns
 * the open/closed state.
 */
import { useState } from 'react';
import {
  Cloud,
  CloudOff,
  GitBranch,
  HelpCircle,
  Loader2,
  ShieldAlert,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react';
import { usePartyAudit } from '@/hooks/use-party-audit';
import { Button } from '@/components/ui/button';
import { COLORS } from './tokens';
import type { PartyEvent } from '@/types/party';

interface Props {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
}

export function AuditDrawer({ sessionId, open, onClose }: Props) {
  const { data, isLoading, error, refetch, isFetching } = usePartyAudit(sessionId, open);
  const [tab, setTab] = useState<'checkpoints' | 'questions' | 'tools'>('checkpoints');

  if (!open || !sessionId) return null;

  const events = data?.events ?? [];
  const checkpoints = events.filter((e) => String(e.eventType).startsWith('party.checkpoint.'));
  const questions = events.filter((e) => e.eventType === 'party.agent.question');
  const tools = events.filter((e) => e.eventType === 'party.tool.default-allow');

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      data-testid="audit-drawer"
    >
      <div className="flex-1 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        className="party-drawer-panel flex flex-col shadow-2xl"
        style={{
          width: 560,
          maxWidth: '100vw',
          background: COLORS.bgContent,
          borderLeft: `1px solid ${COLORS.bgDeepest}`,
        }}
      >
        <header
          className="flex shrink-0 items-center gap-3 px-4"
          style={{
            height: 56,
            borderBottom: `1px solid ${COLORS.bgDeepest}`,
          }}
        >
          <TerminalSquare className="h-4 w-4 shrink-0" style={{ color: COLORS.accentBrand }} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold" style={{ color: COLORS.textPrimary }}>
              Audit · session {sessionId.slice(0, 8)}
            </div>
            {data && (
              <div className="font-mono text-[10.5px]" style={{ color: COLORS.textMuted }}>
                {data.partyBranch ?? '—'}
                {data.tally && (
                  <>
                    {' · '}
                    {data.tally.checkpointsPushed}p / {data.tally.checkpointsComposed}c /{' '}
                    {data.tally.checkpointsBlocked}b / {data.tally.checkpointsFailed}f ·{' '}
                    {data.tally.questions}q · {data.tally.defaultAllows}t
                  </>
                )}
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            disabled={isFetching}
            onClick={() => refetch()}
            data-testid="audit-refresh"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Refresh'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div
          className="flex shrink-0 items-center gap-1 px-3 py-2"
          style={{ borderBottom: `1px solid ${COLORS.bgDeepest}` }}
        >
          <TabButton
            label={`Checkpoints (${checkpoints.length})`}
            active={tab === 'checkpoints'}
            onClick={() => setTab('checkpoints')}
          />
          <TabButton
            label={`Questions (${questions.length})`}
            active={tab === 'questions'}
            onClick={() => setTab('questions')}
          />
          <TabButton
            label={`Tool allows (${tools.length})`}
            active={tab === 'tools'}
            onClick={() => setTab('tools')}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {isLoading && (
            <div
              className="flex items-center gap-2 text-[12px]"
              style={{ color: COLORS.textMuted }}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading audit…
            </div>
          )}
          {error && (
            <div
              className="rounded-md border p-3 text-[12px]"
              style={{
                borderColor: 'color-mix(in srgb, var(--destructive) 30%, transparent)',
                color: 'var(--destructive)',
              }}
            >
              Audit failed: {(error as Error).message}
            </div>
          )}
          {!isLoading && !error && tab === 'checkpoints' && <CheckpointList events={checkpoints} />}
          {!isLoading && !error && tab === 'questions' && <QuestionList events={questions} />}
          {!isLoading && !error && tab === 'tools' && <ToolList events={tools} />}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-1 text-[11.5px] font-medium"
      style={{
        background: active ? COLORS.bgElevated : 'transparent',
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        border: `1px solid ${active ? COLORS.bgDeepest : 'transparent'}`,
      }}
    >
      {label}
    </button>
  );
}

function CheckpointList({ events }: { events: ReadonlyArray<PartyEvent> }) {
  if (events.length === 0) {
    return (
      <div className="text-[12px]" style={{ color: COLORS.textMuted }}>
        No checkpoints yet. Checkpoint events fire when the agent emits
        <code className="ml-1 font-mono">[CHECKPOINT_SUMMARY]</code> at round end.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {events.map((e, i) => {
        const t = String(e.eventType);
        const ev = e as PartyEvent & {
          title?: string;
          summary?: string;
          branch?: string;
          commitSha?: string | null;
          reason?: string;
        };
        const sha = ev.commitSha ? String(ev.commitSha).slice(0, 7) : '—';
        const icon =
          t === 'party.checkpoint.pushed' ? (
            <Cloud className="h-3.5 w-3.5" style={{ color: 'var(--success)' }} />
          ) : t === 'party.checkpoint.composed' ? (
            <CloudOff className="h-3.5 w-3.5" style={{ color: 'var(--accent-purple)' }} />
          ) : t === 'party.checkpoint.blocked' ? (
            <ShieldAlert className="h-3.5 w-3.5" style={{ color: 'var(--destructive)' }} />
          ) : (
            <XCircle className="h-3.5 w-3.5" style={{ color: 'var(--destructive)' }} />
          );
        return (
          <li
            key={i}
            className="rounded-md border p-2"
            style={{ borderColor: COLORS.bgDeepest, background: COLORS.bgElevated }}
          >
            <div className="flex items-center gap-2">
              {icon}
              <span
                className="text-[11px] font-mono uppercase tracking-wider"
                style={{ color: COLORS.textMuted }}
              >
                {t.replace('party.checkpoint.', '')}
              </span>
              <span className="ml-auto font-mono text-[10.5px]" style={{ color: COLORS.textFaint }}>
                {sha}
              </span>
            </div>
            {ev.title && (
              <div className="mt-1 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
                {ev.title}
              </div>
            )}
            {ev.summary && (
              <div
                className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-relaxed"
                style={{ color: COLORS.textBody }}
              >
                {ev.summary}
              </div>
            )}
            {ev.branch && (
              <div
                className="mt-1 inline-flex items-center gap-1 text-[10.5px]"
                style={{ color: COLORS.textMuted }}
              >
                <GitBranch className="h-3 w-3" />
                <span className="font-mono">{ev.branch}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function QuestionList({ events }: { events: ReadonlyArray<PartyEvent> }) {
  if (events.length === 0) {
    return (
      <div className="text-[12px]" style={{ color: COLORS.textMuted }}>
        No agent questions. Agents emit
        <code className="mx-1 font-mono">[ASK_HUMAN]</code>
        when they need operator input.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {events.map((e, i) => {
        const ev = e as PartyEvent & { question?: string; turnCount?: number };
        return (
          <li
            key={i}
            className="rounded-md border p-2"
            style={{ borderColor: COLORS.bgDeepest, background: COLORS.bgElevated }}
          >
            <div className="flex items-center gap-2">
              <HelpCircle className="h-3.5 w-3.5" style={{ color: 'var(--accent-purple)' }} />
              <span className="text-[12px]" style={{ color: COLORS.textPrimary }}>
                {ev.question ?? ''}
              </span>
            </div>
            <div className="mt-0.5 text-[10.5px]" style={{ color: COLORS.textMuted }}>
              Round {Number(ev.turnCount ?? 0) + 1}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ToolList({ events }: { events: ReadonlyArray<PartyEvent> }) {
  if (events.length === 0) {
    return (
      <div className="text-[12px]" style={{ color: COLORS.textMuted }}>
        No default-allow audit lines yet. Each entry here is a Bash command the party-tool-hook fell
        through to allow (no explicit rule matched). Watch this list for patterns that should join
        the deny-list at
        <code className="ml-1 font-mono">daemon/lib/git-deny-list.json</code>.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {events.map((e, i) => {
        const ev = e as PartyEvent & { command?: string };
        return (
          <li
            key={i}
            className="rounded border px-2 py-1 font-mono text-[11px]"
            style={{
              borderColor: COLORS.bgDeepest,
              color: COLORS.textBody,
              background: COLORS.bgElevated,
            }}
          >
            {ev.command ?? '—'}
          </li>
        );
      })}
    </ul>
  );
}
