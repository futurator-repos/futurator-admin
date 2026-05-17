/**
 * widget.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Root component for the global free-agent chat widget. Reads `isOpen` from
 * the Zustand store; renders the FAB when closed, the Panel when open.
 *
 * Auth-gated: returns null when the user is not authenticated, so the widget
 * never appears on /login or other pre-auth surfaces. Mounted globally from
 * src/app/layout.tsx via the Providers wrapper.
 */

'use client';

import { useFreeAgentStore } from '@/stores/free-agent-store';
import { useAuthStore } from '@/stores/auth-store';
import { useFreeAgentScope } from './use-free-agent-scope';
import { FreeAgentFab } from './fab';
import { FreeAgentPanel } from './panel';

export function FreeAgentWidget() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isOpen = useFreeAgentStore((s) => s.isOpen);

  // Keep the store's scope in sync with the route — always wired even when
  // the panel is closed, so the header label is correct the instant the
  // operator opens it (AC #8: "no flicker").
  useFreeAgentScope();

  if (!isAuthenticated) return null;

  return isOpen ? <FreeAgentPanel /> : <FreeAgentFab />;
}
