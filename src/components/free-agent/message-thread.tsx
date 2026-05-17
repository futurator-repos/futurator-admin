/**
 * message-thread.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Scrollable thread area. Story 18.4 only wires the empty-state placeholder
 * + the bubble rendering shape. Streaming wiring (TanStack subscription to
 * SSE) lands in Story 18.5.
 */

'use client';

import type { ReactNode } from 'react';

export interface FreeAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Optional ISO-8601 timestamp; rendered as a tiny label below the bubble. */
  timestamp?: string;
}

interface FreeAgentMessageThreadProps {
  messages?: FreeAgentMessage[];
}

export function FreeAgentMessageThread({ messages = [] }: FreeAgentMessageThreadProps) {
  if (messages.length === 0) {
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
      className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      data-testid="free-agent-thread"
    >
      {messages.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}
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

  const isUser = message.role === 'user';
  return (
    <div
      className={`flex max-w-[85%] flex-col gap-1 ${
        isUser ? 'self-end items-end' : 'self-start items-start'
      }`}
      data-testid={isUser ? 'free-agent-user-bubble' : 'free-agent-assistant-bubble'}
    >
      <div
        className={`rounded-2xl px-3 py-2 text-sm ${
          isUser ? 'bg-[color:var(--accent-blue,#3b82f6)] text-white' : 'bg-muted text-foreground'
        }`}
      >
        {renderInline(message.content)}
      </div>
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
