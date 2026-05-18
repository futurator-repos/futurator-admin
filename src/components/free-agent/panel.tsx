/**
 * panel.tsx — Story 18.4 (Epic 18: Free Claude Code Agent),
 *             wired in Story 18.5 to consume useFreeAgentSession.
 *
 * Fixed bottom-right, ~400×600px desktop, full-width drawer up to 90vh
 * on mobile (<768px). No modal backdrop — the dashboard behind remains
 * interactable.
 */

'use client';

import { FreeAgentPanelHeader } from './panel-header';
import { FreeAgentMessageThread } from './message-thread';
import { FreeAgentComposer } from './composer';
import { useFreeAgentSession } from '@/hooks/use-free-agent-session';

export function FreeAgentPanel() {
  const session = useFreeAgentSession();

  return (
    <div
      role="dialog"
      aria-label="Free agent chat"
      data-testid="free-agent-panel"
      className="fixed bottom-6 right-6 z-50 flex max-h-[90vh] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl sm:right-6 sm:w-[400px]"
      style={{ height: 'min(600px, 90vh)' }}
    >
      <FreeAgentPanelHeader
        costUsdAccumulated={session.costUsdAccumulated}
        costCapUsd={session.costCapUsd}
        currentModel={session.currentModel}
        onChangeModel={session.changeModel}
        onChangeCostCap={session.setCostCapUsd}
        onLoadSession={session.loadSession}
        onNewConversation={session.resetSession}
      />
      <FreeAgentMessageThread messages={session.messages} />
      {/* Treat both the in-flight POST AND the daemon-side PROCESSING window
          as "sending" so the operator can't fire a second message that the API
          would reject with 409 SESSION_BUSY. The daemon typically takes 5-15s
          per turn; without this gate, rapid Cmd+↵ presses produced a stream
          of 409s (2026-05-18 incident). */}
      <FreeAgentComposer
        isSending={session.isSending || session.status === 'PROCESSING'}
        onSend={session.sendMessage}
      />
    </div>
  );
}
