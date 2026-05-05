'use client';
import { useMemo, useState, useEffect, useRef, Fragment } from 'react';
import { useSession, useSessionEvents, useSendMessageMutation } from '@/hooks/use-party-session';
import { useUploadPartyDoc } from '@/hooks/use-party-docs';
import type { PartyEvent } from '@/types/party';
import { SessionHeader } from './session-header';
import { PartyMessage } from './party-message';
import { UserBubble } from './user-bubble';
import { TurnDivider } from './turn-divider';
import { AvatarRail } from './avatar-rail';
import { ProcessingIndicator, type StageLine } from './processing-indicator';
import { Composer } from './composer';
import { DocTray } from './doc-tray';

interface Props {
  sessionId: string;
  onClose: () => void;
}

interface AssistantBlock {
  speaker: string | null;
  text: string;
}

function parseAssistantTokens(events: PartyEvent[]): AssistantBlock[] {
  const merged = events
    .filter((e) => e.eventType === 'party.turn.assistant.token')
    .map((e) => (e as { text?: string }).text ?? '')
    .join('');
  const blocks: AssistantBlock[] = [];
  const parts = merged.split(/\n\n+/);
  for (const part of parts) {
    const m = part.match(/^\*\*([^:*]+):\*\*\s*([\s\S]*)$/);
    if (m) {
      blocks.push({ speaker: m[1].trim(), text: m[2] });
    } else if (part.trim().length > 0) {
      const last = blocks[blocks.length - 1];
      if (last) {
        last.text += '\n\n' + part;
      } else {
        blocks.push({ speaker: null, text: part });
      }
    }
  }
  return blocks;
}

interface Group {
  turn: number;
  kind: 'user' | 'assistant' | 'awaiting' | 'error';
  events: PartyEvent[];
}

function buildGroups(events: PartyEvent[]): Group[] {
  const groups: Group[] = [];
  let turn = 0;
  let currentAssistant: Group | null = null;
  for (const ev of events) {
    if (ev.eventType === 'party.turn.user') {
      turn++;
      if (currentAssistant) {
        groups.push(currentAssistant);
        currentAssistant = null;
      }
      groups.push({ turn, kind: 'user', events: [ev] });
    } else if (String(ev.eventType).startsWith('party.turn.assistant')) {
      if (!currentAssistant) {
        currentAssistant = { turn, kind: 'assistant', events: [] };
      }
      currentAssistant.events.push(ev);
    } else if (ev.eventType === 'party.turn.awaiting_user') {
      if (currentAssistant) {
        groups.push(currentAssistant);
        currentAssistant = null;
      }
      groups.push({ turn, kind: 'awaiting', events: [ev] });
    } else if (ev.eventType === 'party.turn.completed') {
      if (currentAssistant) {
        groups.push(currentAssistant);
        currentAssistant = null;
      }
    } else if (ev.eventType === 'party.turn.error') {
      if (currentAssistant) {
        groups.push(currentAssistant);
        currentAssistant = null;
      }
      groups.push({ turn, kind: 'error', events: [ev] });
    }
  }
  if (currentAssistant) groups.push(currentAssistant);
  return groups;
}

export function SessionChat({ sessionId, onClose }: Props) {
  const { data: session } = useSession(sessionId);
  const { events } = useSessionEvents(sessionId, session?.status);
  const sendMessage = useSendMessageMutation(sessionId);
  const uploadDoc = useUploadPartyDoc(session?.projectId ?? null);
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  async function handleAttach(files: File[]) {
    for (const file of files) {
      try {
        await uploadDoc.mutateAsync(file);
      } catch (err) {
        console.error('[Party] doc upload failed:', file.name, err);
      }
    }
  }

  const groups = useMemo(() => buildGroups(events), [events]);

  const isProcessing = session?.status === 'PROCESSING' || sendMessage.isPending;
  const isErrored = session?.status === 'ERROR';

  // Find the in-flight assistant group (last assistant group while session is PROCESSING)
  const lastAssistantIdx = [...groups].reverse().findIndex((g) => g.kind === 'assistant');
  const inflightAssistantIdx =
    isProcessing && lastAssistantIdx !== -1 ? groups.length - 1 - lastAssistantIdx : -1;

  // Aggregate all speakers seen so far → for AvatarRail
  const allSpeakers = useMemo(() => {
    const seen = new Set<string>();
    for (const g of groups) {
      if (g.kind !== 'assistant') continue;
      for (const b of parseAssistantTokens(g.events)) {
        if (b.speaker) seen.add(b.speaker);
      }
    }
    return [...seen];
  }, [groups]);

  // Current speaker = last speaker in the in-flight assistant group
  const currentSpeaker = useMemo(() => {
    if (inflightAssistantIdx === -1) return null;
    const blocks = parseAssistantTokens(groups[inflightAssistantIdx].events);
    return blocks[blocks.length - 1]?.speaker ?? null;
  }, [groups, inflightAssistantIdx]);

  // Auto-scroll on new events
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [events.length]);

  // Did the daemon already spawn Claude? The `party.turn.started` event is
  // emitted immediately after spawn() so we can distinguish "queued, waiting
  // for daemon" from "Claude is live, waiting on first token". This
  // replaces the old single generic indicator that made it feel like the
  // UI was unresponsive during Claude's 5–15 s cold start.
  // MUST live above the `if (!session) return` early-return below — hook
  // order has to be stable across renders.
  const claudeStartedForThisTurn = useMemo(() => {
    // Count events in reverse — the latest user event starts a new turn; a
    // started event after it applies to the current in-flight turn.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.eventType === 'party.turn.user') return false;
      if (ev.eventType === 'party.turn.started') return true;
    }
    return false;
  }, [events]);

  // Precompute: which groups should show a turn divider + each turn's speakers.
  const dividerInfo = useMemo(() => {
    const showAt = new Set<number>();
    const speakersByTurn = new Map<number, string[]>();
    let lastTurn = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.kind === 'user' && g.turn !== lastTurn) {
        showAt.add(i);
        lastTurn = g.turn;
      }
    }
    for (const g of groups) {
      if (g.kind !== 'assistant') continue;
      const set = speakersByTurn.get(g.turn) || [];
      for (const b of parseAssistantTokens(g.events)) {
        if (b.speaker && !set.includes(b.speaker)) set.push(b.speaker);
      }
      speakersByTurn.set(g.turn, set);
    }
    return { showAt, speakersByTurn };
  }, [groups]);

  async function handleSend() {
    const content = draft.trim();
    if (!content) return;
    if (new TextEncoder().encode(content).length > 8192) return;
    setDraft('');
    try {
      await sendMessage.mutateAsync(content);
    } catch {
      /* surface via session polling */
    }
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
        Loading session…
      </div>
    );
  }

  // Determine if we should show a top-level processing indicator (pre-streaming)
  const hasInflightTokens =
    inflightAssistantIdx !== -1 &&
    groups[inflightAssistantIdx].events.some((e) => e.eventType === 'party.turn.assistant.token');

  // Pre-stream indicator — shown ONLY when the job is in flight and no tokens
  // have arrived yet. We keep it short and honest: we don't actually know what
  // the router is doing, and faking multi-stage progress is misleading when
  // the first token often lands within 2 seconds.
  let topIndicator: { stage: string; lines: StageLine[] } | null = null;
  if (sendMessage.isPending) {
    topIndicator = { stage: 'Sending message…', lines: [] };
  } else if (isProcessing && !hasInflightTokens) {
    topIndicator = {
      stage: claudeStartedForThisTurn
        ? 'Claude subprocess live — waiting on first token (up to ~15 s cold start)'
        : 'BMad Master is routing — agents will start streaming any moment',
      lines: [],
    };
  }

  return (
    <div className="flex flex-col h-full min-h-[480px]" data-testid="session-chat">
      <SessionHeader session={session} onClose={onClose} />

      <div className="flex flex-1 min-h-0">
        <AvatarRail speakers={allSpeakers} currentSpeaker={currentSpeaker} />

        <div className="flex flex-1 flex-col min-w-0">
          <div ref={threadRef} className="flex-1 overflow-y-auto px-5 pt-3 pb-1" aria-live="polite">
            {groups.length === 0 && (
              <div className="py-8 text-center text-xs italic text-muted-foreground">
                Pick a topic and introduce yourself to the room. The PM, Analyst, Architect, and
                more are listening.
              </div>
            )}

            {groups.map((group, gi) => {
              const showDivider = dividerInfo.showAt.has(gi);
              const turnSpeakers = showDivider
                ? dividerInfo.speakersByTurn.get(group.turn) || []
                : [];

              return (
                <Fragment key={gi}>
                  {showDivider && group.turn > 0 && (
                    <TurnDivider turn={group.turn} speakers={turnSpeakers} />
                  )}

                  {group.kind === 'user' && (
                    <UserBubble
                      content={(group.events[0] as { content?: string }).content || ''}
                    />
                  )}

                  {group.kind === 'assistant' && (
                    <div className="space-y-1">
                      {parseAssistantTokens(group.events).map((b, bi, arr) => {
                        const isLast = bi === arr.length - 1;
                        const streaming = gi === inflightAssistantIdx && isLast;
                        return (
                          <PartyMessage
                            key={bi}
                            speaker={b.speaker}
                            text={b.text}
                            streaming={streaming}
                          />
                        );
                      })}
                    </div>
                  )}

                  {group.kind === 'awaiting' && (
                    <div className="my-2 ml-[52px] rounded-md border border-yellow-900/60 bg-yellow-900/20 px-3 py-2 text-[11px] text-yellow-300">
                      Agent asked you a question → reply below.
                    </div>
                  )}

                  {group.kind === 'error' && (
                    <div className="my-2 ml-[52px] text-[11px] text-red-400">
                      Turn error (
                      {String((group.events[0] as { reason?: string }).reason || 'unknown')}).
                    </div>
                  )}
                </Fragment>
              );
            })}

            {topIndicator && (
              <div className="mt-3 ml-[52px]">
                <ProcessingIndicator stage={topIndicator.stage} lines={topIndicator.lines} />
              </div>
            )}
          </div>

          <div className="border-t border-border bg-background px-5 pb-3.5 pt-3">
            {isErrored && (
              <div className="mb-2 text-[11px] text-red-400">
                Session is in ERROR state. Send a message to attempt recovery (last turn may have
                timed out).
              </div>
            )}
            {session.projectId && <DocTray projectId={session.projectId} />}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => void handleSend()}
              isProcessing={isProcessing}
              disabled={false}
              onAttach={handleAttach}
              isUploading={uploadDoc.isPending}
              acceptedTypes=".md,.markdown,.txt,.pdf,.json,.csv,.yml,.yaml"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
