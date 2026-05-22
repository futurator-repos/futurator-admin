'use client';
/**
 * Story 22.6 (party-push Epic 22) — ASK_HUMAN inbox card.
 *
 * Surfaces every `party.agent.question` event for the session in the right
 * rail as a pinned tier-1 list (the agent is waiting on the operator —
 * highest-priority signal). Per Free Explorer §13.4 three-tier visual
 * treatment: tier-1 (blocking) is the bright accent card, tier-2 + tier-3
 * are the existing inline-questions list (lower priority, less visual
 * weight).
 *
 * Questions are answered by the operator sending the next message in the
 * chat — there is no dedicated reply UI. We mark each question as
 * "answered" client-side by remembering which question text+turn already
 * has a subsequent user turn after it. This is best-effort because
 * questions don't get a server-side answered flag; the daemon could add
 * one later (party.agent.question.answered event) and the card would
 * pick it up.
 */
import { useMemo, useState } from 'react';
import { HelpCircle, MessageSquare, X } from 'lucide-react';
import type { PartyEvent } from '@/types/party';
import { COLORS } from './tokens';

interface Props {
  events: ReadonlyArray<PartyEvent>;
  /** When set, clicking a question scrolls the main pane to the round. */
  onJumpToRound?: (roundN: number) => void;
}

interface AgentQuestion {
  question: string;
  turnCount: number;
  timestamp: string;
  /** Heuristic: true if a `party.turn.user` event with seq > this one exists. */
  answered: boolean;
}

function extractQuestions(events: ReadonlyArray<PartyEvent>): AgentQuestion[] {
  // Walk events twice: once to collect ASK_HUMAN, once to mark answered.
  const questions: Array<AgentQuestion & { eventSeq: string }> = [];
  for (const e of events) {
    if (e.eventType === 'party.agent.question') {
      const q = e as PartyEvent & { question?: string; turnCount?: number };
      questions.push({
        question: String(q.question ?? '').slice(0, 500),
        turnCount: Number(q.turnCount ?? 0),
        timestamp: e.timestamp,
        eventSeq: String(e.eventSeq ?? '000000'),
        answered: false,
      });
    }
  }
  if (questions.length === 0) return [];
  // Mark answered: any user turn with a later eventSeq counts.
  const userTurnSeqs = events
    .filter((e) => e.eventType === 'party.turn.user')
    .map((e) => String(e.eventSeq ?? '000000'));
  return questions.map((q) => ({
    ...q,
    answered: userTurnSeqs.some((s) => s > q.eventSeq),
  }));
}

export function AgentQuestionsCard({ events, onJumpToRound }: Props) {
  const [dismissedAnswered, setDismissedAnswered] = useState(true);
  const questions = useMemo(() => extractQuestions(events), [events]);
  const visible = dismissedAnswered ? questions.filter((q) => !q.answered) : questions;

  if (questions.length === 0) return null;

  const blocking = visible.filter((q) => !q.answered).length;

  return (
    <div
      className="border-t"
      style={{ borderColor: COLORS.bgDeepest }}
      data-testid="agent-questions-card"
    >
      <div className="flex shrink-0 items-center justify-between px-4" style={{ height: 44 }}>
        <span
          className="flex items-center gap-1.5 text-[13px] font-semibold"
          style={{ color: blocking > 0 ? 'var(--accent-purple)' : COLORS.textPrimary }}
        >
          <HelpCircle className="h-3.5 w-3.5" />
          Agent waiting
          {blocking > 0 && (
            <span
              className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold"
              style={{
                background: 'var(--accent-purple)',
                color: 'white',
              }}
            >
              {blocking}
            </span>
          )}
        </span>
        <button
          type="button"
          className="text-[10px] underline-offset-2 hover:underline"
          style={{ color: COLORS.textMuted }}
          onClick={() => setDismissedAnswered((v) => !v)}
          title={dismissedAnswered ? 'Show answered questions too' : 'Hide answered questions'}
        >
          {dismissedAnswered ? `Show all (${questions.length})` : 'Hide answered'}
        </button>
      </div>

      <div className="space-y-1.5 px-3 pb-3">
        {visible.length === 0 ? (
          <div
            className="rounded-md border border-dashed px-3 py-2 text-[11px]"
            style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
          >
            All caught up — every agent question has been answered.
          </div>
        ) : (
          visible.map((q, i) => (
            <button
              key={`${q.timestamp}-${i}`}
              type="button"
              onClick={() => onJumpToRound?.(q.turnCount)}
              className="party-hover-tint block w-full overflow-hidden rounded-md px-2.5 py-2 text-left"
              style={{
                background: q.answered
                  ? COLORS.bgElevated
                  : 'color-mix(in srgb, var(--accent-purple) 8%, transparent)',
                border: q.answered
                  ? `1px solid ${COLORS.bgDeepest}`
                  : '1px solid color-mix(in srgb, var(--accent-purple) 35%, transparent)',
              }}
              data-testid={`agent-question-${i}`}
            >
              <div className="flex items-start gap-2">
                {q.answered ? (
                  <X
                    className="mt-0.5 h-3 w-3 shrink-0 opacity-60"
                    style={{ color: COLORS.textMuted }}
                  />
                ) : (
                  <MessageSquare
                    className="mt-0.5 h-3 w-3 shrink-0"
                    style={{ color: 'var(--accent-purple)' }}
                  />
                )}
                <span
                  className="text-[12px] leading-snug"
                  style={{
                    color: q.answered ? COLORS.textMuted : COLORS.textPrimary,
                    textDecoration: q.answered ? 'line-through' : 'none',
                  }}
                >
                  {q.question}
                </span>
              </div>
              <div
                className="mt-1 flex items-center justify-between text-[10px]"
                style={{ color: COLORS.textMuted }}
              >
                <span>Round {q.turnCount + 1}</span>
                <span>{q.answered ? 'answered' : 'awaiting reply'}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
