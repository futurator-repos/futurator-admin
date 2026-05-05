'use client';
import { Plus } from 'lucide-react';
import { Avatar } from './avatar';
import { agentIdentity } from './agent-identity';

interface Props {
  speakers: string[];
  currentSpeaker?: string | null;
}

export function AvatarRail({ speakers, currentSpeaker }: Props) {
  if (speakers.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-2.5 py-2 w-14 border-r border-border shrink-0">
      <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
        Room
      </div>
      {speakers.map((s) => {
        const id = agentIdentity(s);
        const active = currentSpeaker?.toLowerCase() === s.toLowerCase();
        return (
          <div key={s} className="relative" title={`${s}${id.title ? ` · ${id.title}` : ''}`}>
            <Avatar speaker={s} size={34} active={active} />
            {active && (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
                style={{ background: id.accentHex, borderColor: 'var(--background)' }}
              />
            )}
          </div>
        );
      })}
      <div className="h-px w-6 bg-border my-0.5" />
      <button
        type="button"
        disabled
        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/50 cursor-not-allowed"
        title="Add agent (coming soon)"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
