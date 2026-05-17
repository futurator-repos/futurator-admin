/**
 * thread-list-dropdown.tsx — Story 18.6 (Epic 18: Free Claude Code Agent)
 *
 * Panel-header hamburger dropdown. Shows the operator's recent sessions for
 * the current scope + a "New conversation" entry at the top. Click a row →
 * resume that session.
 */

'use client';

import { useState, useEffect, useRef } from 'react';
import { MoreVertical, MessageSquarePlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  useFreeAgentConversations,
  type FreeAgentConversationSummary,
} from '@/hooks/use-free-agent-conversations';

interface ThreadListDropdownProps {
  /** Called when the operator clicks a recent-session row. */
  onLoadSession: (sessionId: string) => void;
  /** Called when the operator clicks "New conversation". */
  onNewConversation: () => void;
}

export function ThreadListDropdown({ onLoadSession, onNewConversation }: ThreadListDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { conversations, isLoading } = useFreeAgentConversations();

  // Click-outside to close.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const handleNew = () => {
    setIsOpen(false);
    onNewConversation();
  };

  const handleLoad = (sessionId: string) => {
    setIsOpen(false);
    onLoadSession(sessionId);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Conversation menu"
        data-testid="free-agent-thread-list-trigger"
        onClick={() => setIsOpen((v) => !v)}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        title="Conversations"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label="Conversations menu"
          data-testid="free-agent-thread-list-dropdown"
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border bg-background shadow-2xl"
        >
          {/* New conversation */}
          <button
            type="button"
            data-testid="free-agent-new-conversation"
            onClick={handleNew}
            className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted focus:outline-none focus:bg-muted"
          >
            <MessageSquarePlus className="h-4 w-4 text-[color:var(--accent-blue,#3b82f6)]" />
            <span className="font-medium">New conversation</span>
          </button>

          {/* Recent sessions */}
          {isLoading ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              No prior conversations in this scope yet.
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {conversations.map((c) => (
                <ConversationRow key={c.sessionId} conversation={c} onClick={handleLoad} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  conversation,
  onClick,
}: {
  conversation: FreeAgentConversationSummary;
  onClick: (sessionId: string) => void;
}) {
  const preview =
    conversation.firstUserMessagePreview || `Session ${conversation.sessionId.slice(0, 8)}`;
  const relative = formatRelative(conversation.lastActivityAt);
  return (
    <button
      type="button"
      data-testid="free-agent-thread-list-item"
      onClick={() => onClick(conversation.sessionId)}
      className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-muted focus:outline-none focus:bg-muted"
    >
      <span className="truncate text-sm">{preview}</span>
      <span className="text-[10px] text-muted-foreground">
        {relative} · {conversation.model} · {conversation.turnCount} turn
        {conversation.turnCount === 1 ? '' : 's'}
      </span>
    </button>
  );
}

function formatRelative(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
