/**
 * composer.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Textarea-based composer with keyboard handling per AC #6:
 *   - Cmd+Enter (Mac) / Ctrl+Enter (other) → send
 *   - Shift+Enter and bare Enter → newline (prevents accidental sends)
 *
 * Send wiring lands in Story 18.5; for now `onSend` is optional and the
 * button just clears the composer when fired (so manual testing of the
 * shell still feels coherent).
 */

'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { useFreeAgentStore } from '@/stores/free-agent-store';

interface FreeAgentComposerProps {
  /** Set by Story 18.5 once a turn is in flight. */
  isSending?: boolean;
  /** Set by Story 18.5 to wire the real submit path. */
  onSend?: (text: string) => void;
}

const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;

export function FreeAgentComposer({ isSending = false, onSend }: FreeAgentComposerProps) {
  const text = useFreeAgentStore((s) => s.composerText);
  const setText = useFreeAgentStore((s) => s.setComposerText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to MAX_ROWS lines, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = MAX_ROWS * LINE_HEIGHT_PX + 16; // padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !isSending;

  const handleSend = () => {
    if (!canSend) return;
    if (onSend) onSend(text);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd+Enter (Mac) or Ctrl+Enter (other) → send.
    // Shift+Enter and bare Enter → default newline.
    const isMeta = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && isMeta) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t bg-background">
      <div className="flex items-end gap-2 p-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={MIN_ROWS}
          placeholder="Send a message (⌘↵ or Ctrl+↵ to send, Shift+↵ for newline)"
          aria-label="Message composer"
          data-testid="free-agent-composer"
          className="flex-1 resize-none rounded border bg-background px-2 py-1 text-sm leading-5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          aria-label="Send message"
          data-testid="free-agent-send"
          disabled={!canSend}
          onClick={handleSend}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors ${
            canSend
              ? 'bg-[color:var(--accent-blue,#3b82f6)] text-white hover:opacity-90'
              : 'cursor-not-allowed bg-muted text-muted-foreground'
          }`}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
