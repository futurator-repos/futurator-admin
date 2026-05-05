'use client';
import { useEffect, useState, useRef, type RefObject } from 'react';
import { HelpCircle, Loader2, Send, X } from 'lucide-react';
import { useCreateInlineQuestion } from '@/hooks/use-inline-questions';
import type { InlineQuestionAnchor } from '@/types/inline-question';
import { COLORS } from './tokens';

interface ActiveSelection {
  snippet: string;
  contextBefore: string;
  contextAfter: string;
  roundId: string;
  agentName?: string;
  /** Viewport-relative rect of the selection, used to position the popover. */
  rect: DOMRect;
}

interface Props {
  sessionId: string | null;
  /** The chat scroll container — selection events outside this ref are ignored. */
  scopeRef: RefObject<HTMLElement | null>;
}

/**
 * Floating mini-panel that appears when the user highlights text inside the
 * party chat. One affordance for now: "Ask a question". Submitting fires a
 * direct Anthropic API call (via the Lambda) anchored to the selection's
 * round + snippet, so the resulting Q&A can later be jumped back to from
 * the right-rail Questions list.
 */
export function SelectionPopover({ sessionId, scopeRef }: Props) {
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const [mode, setMode] = useState<'idle' | 'composing' | 'answering'>('idle');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const create = useCreateInlineQuestion(sessionId);

  useEffect(() => {
    function handleMouseUp(ev: MouseEvent) {
      // Don't reset selection just because the user clicked inside our own
      // popover (e.g. focusing the textarea collapses the original selection).
      if (popoverRef.current && popoverRef.current.contains(ev.target as Node)) {
        return;
      }
      const sel = window.getSelection();
      const scope = scopeRef.current;
      if (!sel || !scope || sel.isCollapsed) {
        if (mode === 'idle') setActive(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length < 2) {
        if (mode === 'idle') setActive(null);
        return;
      }
      const anchorNode = sel.anchorNode;
      const focusNode = sel.focusNode;
      if (!anchorNode || !focusNode) return;
      // Bail unless the selection is fully inside the chat scope.
      if (!scope.contains(anchorNode) || !scope.contains(focusNode)) return;

      // Find the closest round anchor (data-round-anchor) and the optional
      // agent-name anchor (data-agent-name).
      const anchorEl =
        anchorNode.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as Element)
          : (anchorNode.parentElement as Element | null);
      if (!anchorEl) return;
      const roundEl = anchorEl.closest('[data-round-anchor]') as HTMLElement | null;
      if (!roundEl) return;
      const roundId = roundEl.getAttribute('data-round-anchor') || '';
      const agentEl = anchorEl.closest('[data-agent-name]') as HTMLElement | null;
      const agentName = agentEl?.getAttribute('data-agent-name') || undefined;

      // Compute ±40 chars of context for disambiguation. Operate on the
      // round's textContent so we span across spans/paragraphs cleanly.
      const roundText = roundEl.textContent || '';
      const idx = roundText.indexOf(text);
      const ctxBefore =
        idx > 0 ? roundText.slice(Math.max(0, idx - 40), idx) : '';
      const ctxAfter = idx >= 0 ? roundText.slice(idx + text.length, idx + text.length + 40) : '';

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setActive({
        snippet: text.slice(0, 4000),
        contextBefore: ctxBefore,
        contextAfter: ctxAfter,
        roundId,
        agentName,
        rect,
      });
      // Don't auto-reset answer — let the user dismiss it explicitly.
    }

    function handleKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        setActive(null);
        setMode('idle');
        setAnswer(null);
        setError(null);
        setQuestion('');
      }
    }

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKey);
    };
  }, [scopeRef, mode]);

  useEffect(() => {
    if (mode === 'composing') inputRef.current?.focus();
  }, [mode]);

  if (!active) return null;

  // Position above the selection by default; flip below if too close to
  // the top edge. Use viewport coords + position:fixed so we don't get
  // confused by scroll containers.
  const top =
    active.rect.top > 80
      ? active.rect.top - 8 // anchor above
      : active.rect.bottom + 8;
  const flippedBelow = active.rect.top <= 80;
  const left = Math.min(
    Math.max(active.rect.left + active.rect.width / 2, 160),
    window.innerWidth - 160,
  );

  function dismiss() {
    setActive(null);
    setMode('idle');
    setAnswer(null);
    setError(null);
    setQuestion('');
    window.getSelection()?.removeAllRanges();
  }

  async function handleSubmit() {
    if (!active || !question.trim() || !sessionId) return;
    setMode('answering');
    setError(null);
    const anchor: InlineQuestionAnchor = {
      roundId: active.roundId,
      agentName: active.agentName,
      snippet: active.snippet,
      contextBefore: active.contextBefore,
      contextAfter: active.contextAfter,
    };
    try {
      const created = await create.mutateAsync({ question: question.trim(), anchor });
      setAnswer(created.answer);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(reason);
      setMode('composing'); // let them retry
    }
  }

  return (
    <div
      ref={popoverRef}
      className="z-50"
      style={{
        position: 'fixed',
        top,
        left,
        transform: flippedBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
        background: COLORS.bgElevated,
        border: `1px solid ${COLORS.bgDeepest}`,
        borderRadius: 10,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        color: COLORS.textPrimary,
      }}
      onMouseDown={(e) => {
        // Prevent the mousedown inside the popover from collapsing the
        // text selection in the chat.
        e.preventDefault();
      }}
    >
      {mode === 'idle' && (
        <div className="flex items-center gap-1 p-1">
          <button
            type="button"
            onClick={() => setMode('composing')}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] hover:bg-white/[0.06]"
            title="Ask a quick question about the selected text"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            Ask a question
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            title="Dismiss (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {(mode === 'composing' || mode === 'answering') && (
        <div className="flex w-[360px] flex-col gap-1.5 p-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
            <span>Ask about &ldquo;{active.snippet.slice(0, 40)}{active.snippet.length > 40 ? '…' : ''}&rdquo;</span>
            <button type="button" onClick={dismiss} className="hover:text-foreground" title="Dismiss (Esc)">
              <X className="h-3 w-3" />
            </button>
          </div>
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (question.trim() && mode === 'composing') void handleSubmit();
              }
            }}
            placeholder="What does this mean?  Why does this matter?  …"
            rows={2}
            disabled={mode === 'answering'}
            className="w-full resize-none rounded-md bg-black/30 px-2 py-1.5 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent-blue/50 disabled:opacity-60"
          />
          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
              {error}
            </div>
          )}
          {answer && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-emerald-400/20 bg-emerald-500/5 px-2.5 py-2 text-[12px] leading-snug text-foreground/90 whitespace-pre-wrap">
              {answer}
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5">
            <span className="mr-auto text-[10px] text-muted-foreground">⌘+↵ to send</span>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!question.trim() || mode === 'answering'}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: COLORS.accentBrand }}
            >
              {mode === 'answering' ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Asking…
                </>
              ) : (
                <>
                  <Send className="h-3 w-3" /> Ask
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
