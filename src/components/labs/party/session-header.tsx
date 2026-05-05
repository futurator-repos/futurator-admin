'use client';
import { Download, Settings, X } from 'lucide-react';
import type { PartySession } from '@/types/party';

interface Props {
  session: PartySession;
  onClose: () => void;
}

export function SessionHeader({ session, onClose }: Props) {
  const live = session.status === 'PROCESSING' || session.status === 'ACTIVE';
  return (
    <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[14px] font-semibold text-foreground">
          {session.topic || `Party: ${session.projectId}`}
        </span>
        {live && (
          <span className="inline-flex items-center rounded-full border border-green-900/60 bg-green-900/30 px-2 py-0 text-[10.5px] font-medium text-green-400">
            live
          </span>
        )}
        <span className="text-[11px] font-mono text-muted-foreground truncate">
          turn {String(session.turnCount).padStart(2, '0')}
          {session.claudeSessionId && ` · claude:${session.claudeSessionId.slice(0, 8)}`}
        </span>
      </div>
      <span className="flex-1" />
      <HeaderBtn title="Export transcript (coming soon)">
        <Download className="h-3.5 w-3.5" />
      </HeaderBtn>
      <HeaderBtn title="Session settings (coming soon)">
        <Settings className="h-3.5 w-3.5" />
      </HeaderBtn>
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-1 text-[12px] text-foreground hover:bg-white/[0.04] transition-colors"
      >
        <X className="h-3 w-3" />
        Close
      </button>
    </div>
  );
}

function HeaderBtn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled
      title={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
