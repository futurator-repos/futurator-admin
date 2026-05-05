'use client';
import { agentIdentity } from './agent-identity';

interface Props {
  turn: number;
  speakers?: string[];
}

export function TurnDivider({ turn, speakers = [] }: Props) {
  const names = speakers.map((s) => {
    const id = agentIdentity(s);
    return id.displayName;
  });
  return (
    <div className="party-turn-divider">
      <span className="party-turn-divider-line" />
      <span className="party-turn-divider-label">Turn {String(turn).padStart(2, '0')}</span>
      {names.length > 0 && (
        <span className="font-sans text-muted-foreground normal-case tracking-normal">
          {names.length} {names.length === 1 ? 'speaker' : 'speakers'}: {names.join(', ')}
        </span>
      )}
      <span className="party-turn-divider-line" />
    </div>
  );
}
