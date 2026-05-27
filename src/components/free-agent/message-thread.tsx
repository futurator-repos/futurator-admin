/**
 * message-thread.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Scrollable thread area. Bubbles for user/assistant/system roles, plus a
 * typing indicator surfaced when the daemon is processing a turn but hasn't
 * streamed the first token yet.
 *
 * Auto-scrolls to the bottom whenever new content arrives so the operator
 * sees streaming tokens land in real time without manual scrolling.
 */

'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { MergeApprovalCard } from './merge-approval-card';

export interface FreeAgentMergeRequest {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  riskClass: 'red' | 'yellow' | 'green';
  riskReasons: string[];
  diffSummary: { additions: number; deletions: number; filesChanged: number };
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /**
   * 2026-05-27 PR D.e — when the open-pr was a fix-retry against a
   * pipeline-v2 wave failure, the merge-request carries the wave coords
   * so the inline card can render the [Retry wave N] button after
   * merge.completed.
   */
  targetWaveFailure?: { planId: string; waveNumber: number };
}

export interface FreeAgentMessage {
  id: string;
  /**
   * 2026-05-27 PR B.e — added `merge` role for the inline approval card.
   * Renders the MergeApprovalCard component in lieu of a text bubble.
   */
  role: 'user' | 'assistant' | 'system' | 'tool' | 'merge';
  content: string;
  /** Optional ISO-8601 timestamp; rendered as a tiny label below the bubble. */
  timestamp?: string;
  /** For role='tool': raw tool name (Bash, Read, Edit, …) — used for the chip color. */
  toolName?: string;
  /** For role='tool': the full input payload, rendered in an expandable details. */
  toolInput?: Record<string, unknown>;
  /** For role='user': blob URLs (from Cmd+V paste) rendered as thumbnails
   *  above the text. Ephemeral — survive only until the page is reloaded. */
  imagePreviewUrls?: string[];
  /** For role='merge': the inline-approval-card payload. */
  mergeRequest?: FreeAgentMergeRequest;
}

interface FreeAgentMessageThreadProps {
  messages?: FreeAgentMessage[];
  /** True while the daemon is mid-turn — drives the typing indicator. */
  isProcessing?: boolean;
}

export function FreeAgentMessageThread({
  messages = [],
  isProcessing = false,
}: FreeAgentMessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new tokens / typing indicator changes. Smooth so it doesn't
  // jank when streaming long replies. Guard against jsdom (used in tests),
  // where Element.scrollTo isn't implemented.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof el.scrollTo !== 'function') return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, isProcessing]);

  // Show the typing indicator when the daemon is working AND the last bubble
  // is the user's message (no assistant tokens have arrived yet). Once tokens
  // start streaming we hide the dots — the live-growing assistant bubble is
  // its own activity indicator.
  const last = messages[messages.length - 1];
  const showTyping = isProcessing && (!last || last.role !== 'assistant');

  if (messages.length === 0 && !isProcessing) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center p-6 text-center"
        data-testid="free-agent-thread-empty"
      >
        <p className="text-sm text-muted-foreground">Send a message to start</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      data-testid="free-agent-thread"
    >
      {messages.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}
      {showTyping && <TypingIndicator />}
    </div>
  );
}

function TypingIndicator() {
  // Reuses the existing party-typing-bounce keyframe from globals.css so the
  // animation cadence stays consistent with the rest of the app's chat surfaces.
  return (
    <div
      className="flex max-w-[85%] flex-col items-start gap-1 self-start"
      data-testid="free-agent-typing-indicator"
      aria-label="Agent is typing"
      role="status"
    >
      <div className="flex items-center gap-1.5 rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-0" aria-hidden="true">
          <span className="party-typing-dot" />
          <span className="party-typing-dot" />
          <span className="party-typing-dot" />
        </span>
        <span className="sr-only">Agent is thinking…</span>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: FreeAgentMessage }) {
  if (message.role === 'system') {
    return (
      <div className="self-center">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  if (message.role === 'tool') {
    return <ToolBubble message={message} />;
  }

  if (message.role === 'merge' && message.mergeRequest) {
    return (
      <div className="max-w-[85%] self-start">
        <MergeApprovalCard {...message.mergeRequest} />
      </div>
    );
  }

  const isUser = message.role === 'user';
  const hasImages =
    isUser && Array.isArray(message.imagePreviewUrls) && message.imagePreviewUrls.length > 0;
  return (
    <div
      className={`flex max-w-[85%] flex-col gap-1 ${
        isUser ? 'self-end items-end' : 'self-start items-start'
      }`}
      data-testid={isUser ? 'free-agent-user-bubble' : 'free-agent-assistant-bubble'}
    >
      {hasImages && (
        <div className="flex flex-wrap justify-end gap-1.5" data-testid="free-agent-bubble-images">
          {message.imagePreviewUrls!.map((url, idx) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${message.id}-img-${idx}`}
              src={url}
              alt={`Attachment ${idx + 1}`}
              className="max-h-40 max-w-[200px] rounded-lg border object-cover shadow-sm"
            />
          ))}
        </div>
      )}
      {message.content && (
        <div
          className={`rounded-2xl px-3 py-2 text-sm ${
            isUser ? 'bg-[color:var(--accent-blue,#3b82f6)] text-white' : 'bg-muted text-foreground'
          }`}
        >
          {renderInline(message.content)}
        </div>
      )}
      {message.timestamp && (
        <span className="text-[10px] text-muted-foreground">{formatTime(message.timestamp)}</span>
      )}
    </div>
  );
}

function ToolBubble({ message }: { message: FreeAgentMessage }) {
  // Tool calls render as a compact terminal-style entry. Inline-bash gets a
  // monospace shell hint; other tools (Read, Edit, …) just show the tool name
  // and a truncated input preview. Details expandable on click.
  const isBash = (message.toolName || '').toLowerCase() === 'bash';
  const previewMax = 200;
  const preview =
    message.content.length > previewMax
      ? message.content.slice(0, previewMax) + '…'
      : message.content;
  const fullInputJson = message.toolInput ? JSON.stringify(message.toolInput, null, 2) : null;

  return (
    <div
      className="flex max-w-full flex-col gap-1 self-start"
      data-testid="free-agent-tool-bubble"
      data-tool={message.toolName || 'unknown'}
    >
      <details className="group rounded-md border border-dashed bg-background/60 px-2 py-1.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
          <span className="rounded bg-[color:var(--accent-blue,#3b82f6)]/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[color:var(--accent-blue,#3b82f6)]">
            {isBash ? '$ Bash' : message.toolName || 'Tool'}
          </span>
          <span className="truncate font-mono">{preview}</span>
        </summary>
        {fullInputJson && (
          <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono text-[10px] leading-tight">
            {fullInputJson}
          </pre>
        )}
      </details>
      {message.timestamp && (
        <span className="text-[10px] text-muted-foreground">{formatTime(message.timestamp)}</span>
      )}
    </div>
  );
}

function renderInline(text: string): ReactNode {
  // For v1 just preserve newlines. Markdown rendering (code blocks, lists,
  // links) is a Story-18.5+ concern when we know what shapes the agent emits.
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
