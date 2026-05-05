'use client';
import { agentIdentity } from './agent-identity';

interface Props {
  speaker: string;
  size?: number;
  active?: boolean;
}

export function Avatar({ speaker, size = 32, active = false }: Props) {
  const id = agentIdentity(speaker);
  return (
    <div
      className={active ? 'party-avatar-active' : ''}
      title={id.title ? `${speaker} — ${id.title}` : speaker}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: id.bg,
        color: id.accentHex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.5,
        fontWeight: 600,
        border: `1px solid ${id.accentHex}33`,
        flexShrink: 0,
      }}
    >
      {id.icon ? (
        <span style={{ fontSize: size * 0.52, lineHeight: 1 }}>{id.icon}</span>
      ) : (
        id.fallbackInitials
      )}
    </div>
  );
}
