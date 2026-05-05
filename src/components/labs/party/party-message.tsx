'use client';
import { Avatar } from './avatar';
import { RichText } from './rich-text';
import { agentIdentity } from './agent-identity';

interface Props {
  speaker: string | null;
  text: string;
  streaming?: boolean;
  timestamp?: string;
}

export function PartyMessage({ speaker, text, streaming = false, timestamp = 'just now' }: Props) {
  if (!speaker) {
    // Anonymous block — fall back to a simple card
    return (
      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <RichText text={text} />
        {streaming && <span className="party-stream-cursor" />}
      </div>
    );
  }

  const id = agentIdentity(speaker);
  return (
    <div
      className="relative py-2 pl-[52px] pr-3 rounded-md transition-colors hover:bg-white/[0.015]"
      style={{ paddingTop: 8, paddingBottom: 10 }}
    >
      <div className="absolute left-2 top-2">
        <Avatar speaker={speaker} size={34} active={streaming} />
      </div>
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="text-[14px] font-semibold" style={{ color: id.accentHex }}>
          {speaker}
        </span>
        {id.title && <span className="text-[11px] text-muted-foreground">{id.title}</span>}
        <span className="text-[10.5px] font-mono text-muted-foreground">· {timestamp}</span>
      </div>
      <div>
        <RichText text={text} />
        {streaming && <span className="party-stream-cursor" />}
      </div>
    </div>
  );
}
