'use client';
import { formatDistanceToNow } from 'date-fns';
import { HelpCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { useInlineQuestions } from '@/hooks/use-inline-questions';
import { COLORS } from './tokens';

interface Props {
  sessionId: string | null;
  onJumpTo: (roundId: string) => void;
}

/**
 * Persistent list of inline Q&A — rendered below "Rounds" in the right rail.
 * Each row is clickable; clicking jumps the chat to the round + highlights
 * the original snippet briefly.
 */
export function InlineQuestionsList({ sessionId, onJumpTo }: Props) {
  const { data, isLoading } = useInlineQuestions(sessionId);
  const questions = data?.questions ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="border-t" style={{ borderColor: COLORS.bgDeepest }}>
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{ height: 44 }}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
          <HelpCircle className="h-3.5 w-3.5 opacity-70" />
          Questions
        </span>
        <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
          {questions.length}
        </span>
      </div>

      <div className="space-y-1.5 px-3 pb-3">
        {isLoading && (
          <div className="px-1 py-2 text-[11px] italic" style={{ color: COLORS.textMuted }}>
            Loading…
          </div>
        )}
        {!isLoading && questions.length === 0 && (
          <div
            className="rounded-md border border-dashed px-3 py-2 text-[11px] leading-snug"
            style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
          >
            Highlight any text in a chat bubble and click <strong>Ask a question</strong> to
            store quick clarifications here.
          </div>
        )}
        {questions.map((q) => {
          const isOpen = openId === q.questionId;
          return (
            <div
              key={q.questionId}
              className="overflow-hidden rounded-md"
              style={{
                background: COLORS.bgElevated,
                border: `1px solid ${COLORS.bgDeepest}`,
              }}
            >
              <button
                type="button"
                onClick={() => onJumpTo(q.anchor.roundId)}
                onDoubleClick={() => setOpenId(isOpen ? null : q.questionId)}
                className="block w-full px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                title="Click to jump to the highlighted text in the chat (double-click to expand answer below)"
              >
                <div className="line-clamp-2 text-[12px] font-medium leading-snug" style={{ color: COLORS.textPrimary }}>
                  {q.question}
                </div>
                <div
                  className="mt-1 line-clamp-1 rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px] italic"
                  style={{ color: COLORS.textMuted }}
                  title={q.anchor.snippet}
                >
                  &ldquo;{q.anchor.snippet.slice(0, 80)}{q.anchor.snippet.length > 80 ? '…' : ''}&rdquo;
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px]" style={{ color: COLORS.textMuted }}>
                  <span>
                    Round {q.anchor.roundId.replace(/^r-/, '')}
                    {q.anchor.agentName && ` · ${q.anchor.agentName}`}
                  </span>
                  <span>{formatDistanceToNow(new Date(q.createdAt))} ago</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : q.questionId)}
                className="flex w-full items-center justify-center gap-1 border-t py-0.5 text-[10px] font-mono uppercase tracking-wider hover:bg-white/[0.03]"
                style={{
                  borderColor: COLORS.bgDeepest,
                  color: COLORS.textMuted,
                }}
              >
                {isOpen ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    Hide answer
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    Show answer
                  </>
                )}
              </button>
              {isOpen && (
                <div
                  className="whitespace-pre-wrap border-t px-2.5 py-2 text-[11.5px] leading-relaxed"
                  style={{
                    borderColor: COLORS.bgDeepest,
                    color: COLORS.textPrimary,
                  }}
                >
                  {q.answer}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
