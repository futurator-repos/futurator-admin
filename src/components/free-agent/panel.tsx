/**
 * panel.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Expanded chat panel. Fixed bottom-right, ~400×600px desktop, full-width
 * drawer up to 90vh on mobile (<768px). No modal backdrop — the dashboard
 * behind remains interactable.
 */

'use client';

import { FreeAgentPanelHeader } from './panel-header';
import { FreeAgentMessageThread } from './message-thread';
import { FreeAgentComposer } from './composer';

export function FreeAgentPanel() {
  return (
    <div
      role="dialog"
      aria-label="Free agent chat"
      data-testid="free-agent-panel"
      className="fixed bottom-6 right-6 z-50 flex max-h-[90vh] w-[400px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl sm:right-6 sm:w-[400px]"
      style={{ height: 'min(600px, 90vh)' }}
    >
      <FreeAgentPanelHeader />
      <FreeAgentMessageThread />
      <FreeAgentComposer />
    </div>
  );
}
