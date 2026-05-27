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
import { OpenPrAffordance } from './open-pr-affordance';
import { useFreeAgentSession } from '@/hooks/use-free-agent-session';

export function FreeAgentPanel() {
  const session = useFreeAgentSession();

  // "Processing" covers both the in-flight POST AND the daemon-side window
  // until releaseProcessingLock fires. Single source of truth drives the
  // header activity strip, thread typing indicator, and composer disable
  // (which prevents the 409 SESSION_BUSY storm from rapid Cmd+↵ presses
  // observed 2026-05-18).
  const isProcessing = session.isSending || session.status === 'PROCESSING';

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
        isProcessing={isProcessing}
        onCancel={session.cancelTurn}
        isCancelling={session.isCancelling}
      />
      <FreeAgentMessageThread messages={session.messages} isProcessing={isProcessing} />
      <OpenPrAffordance
        sessionId={session.sessionId}
        hasOpenPr={session.hasOpenPr}
        turnCount={session.turnCount}
      />
      <FreeAgentComposer isSending={isProcessing} onSend={session.sendMessage} />
    </div>
  );
}
