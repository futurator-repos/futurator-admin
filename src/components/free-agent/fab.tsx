/**
 * fab.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Floating Action Button that opens the free-agent chat panel.
 *
 * - 56×56px circular, fixed bottom-right, z-index 50.
 * - Disabled + greyed when Fleet mode (remote daemon) is off (read from
 *   localStorage to match the existing Ec2Toggle source-of-truth pattern at
 *   `src/components/labs/ec2-toggle.tsx:7-19`).
 *
 * Motion polish (breathing pulse) deferred to Story 18.7.
 */

'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, Sparkles } from 'lucide-react';
import { useFreeAgentStore } from '@/stores/free-agent-store';

// Storage key + value are load-bearing wire values shared with
// DAEMON_SOURCE/QueueTarget/concurrency flags — do NOT rename either.
const EC2_MODE_STORAGE_KEY = 'futurator.labs.runtimeMode';

function readRemoteMode(): 'local' | 'ec2' {
  if (typeof window === 'undefined') return 'local';
  return (window.localStorage.getItem(EC2_MODE_STORAGE_KEY) as 'local' | 'ec2') || 'local';
}

export function FreeAgentFab() {
  const open = useFreeAgentStore((s) => s.open);

  // Mirror the Ec2Toggle storage so we don't import its component-local state.
  // Lazy initializer reads localStorage once on first render (SSR-safe — no
  // window access inside the initializer thanks to readRemoteMode's typeof
  // guard). Effects only respond to *external* changes (storage events /
  // window focus).
  const [remoteMode, setRemoteMode] = useState<'local' | 'ec2'>(readRemoteMode);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === EC2_MODE_STORAGE_KEY) setRemoteMode(readRemoteMode());
    };
    const onFocus = () => setRemoteMode(readRemoteMode());
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const isDisabled = remoteMode !== 'ec2';

  const handleClick = () => {
    if (isDisabled) return;
    open();
  };

  return (
    <button
      type="button"
      aria-label="Open free agent"
      title={isDisabled ? 'Switch to Fleet (remote daemon)…' : 'Open free agent'}
      data-testid="free-agent-fab"
      data-disabled={isDisabled ? 'true' : 'false'}
      onClick={handleClick}
      className={`fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background ${
        isDisabled
          ? 'cursor-not-allowed bg-muted text-muted-foreground opacity-60 ring-muted'
          : 'cursor-pointer bg-[color:var(--accent-blue,#3b82f6)] text-white hover:scale-105 focus:ring-[color:var(--accent-blue,#3b82f6)]'
      }`}
    >
      <span className="relative inline-flex">
        <MessageSquare className="h-6 w-6" strokeWidth={2.25} aria-hidden="true" />
        <Sparkles
          className="absolute -bottom-1 -right-1 h-3 w-3"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </span>
    </button>
  );
}
