'use client';
import { useMemo } from 'react';
import { useOfficeStore } from '../store';
import type { PersonaRole } from '../types';

const ROLE_BG: Record<PersonaRole | 'system', string> = {
  pm: 'bg-violet-500/20 text-violet-200 border-violet-400/40',
  orchestrator: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  developer: 'bg-blue-500/20 text-blue-200 border-blue-400/40',
  reviewer: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  tester: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40',
  system: 'bg-slate-500/20 text-slate-300 border-slate-400/40',
};

const ROLE_LABEL: Record<PersonaRole | 'system', string> = {
  pm: 'PM',
  orchestrator: 'ORCH',
  developer: 'DEV',
  reviewer: 'REV',
  tester: 'TEST',
  system: 'SYS',
};

export function OfficeEventLog() {
  const entries = useOfficeStore((s) => s.eventLog);
  const visible = useMemo(() => entries.slice(0, 80), [entries]);

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 w-[320px] rounded-lg border border-border/60 bg-black/70 backdrop-blur-md">
      <div className="border-b border-border/60 px-3 py-1.5 text-[11px] font-semibold text-white">
        Activity · {entries.length}
      </div>
      <div className="max-h-[320px] overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-white/40">
            Waiting for the team to start…
          </div>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-[11px] text-white/85">
                <span
                  className={`inline-flex shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold tracking-wide ${
                    ROLE_BG[e.role]
                  }`}
                >
                  {ROLE_LABEL[e.role]}
                </span>
                <span className="shrink-0 text-white/50">{e.characterName}</span>
                <span className="flex-1 truncate">
                  <span className="mr-1">{e.emoji}</span>
                  {e.message}
                </span>
                <span className="shrink-0 text-[9px] text-white/30">
                  {e.time.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
