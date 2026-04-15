'use client';
import { useState } from 'react';
import { useOfficeStore } from '@/stores/office-store';

const ROLE_LABELS: Record<string, string> = {
  DEV: 'Dev',
  REVIEWER: 'Rev',
  PM: 'PM',
  PO: 'PO',
  DEPLOY: 'Ops',
};

export function OfficeEventLog() {
  const [isOpen, setIsOpen] = useState(true);
  const eventLog = useOfficeStore((s) => s.eventLog);

  const panelWidth = isOpen ? 280 : 0;

  return (
    <>
      {/* Toggle */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="absolute z-20 flex h-14 w-6 items-center justify-center border border-white/10 bg-[#12122a] text-sm text-white/40 transition-all hover:text-white/60"
        style={{
          right: panelWidth,
          top: '50%',
          transform: 'translateY(-50%)',
          borderRadius: isOpen ? '6px 0 0 6px' : '0 6px 6px 0',
          borderRight: isOpen ? 'none' : undefined,
        }}
      >
        {isOpen ? '›' : '‹'}
      </button>

      {/* Panel */}
      <div
        className="absolute bottom-0 right-0 top-0 z-10 flex flex-col overflow-hidden border-l border-white/[0.06] bg-[#12122a] transition-all"
        style={{ width: panelWidth, maxWidth: panelWidth, minWidth: panelWidth }}
      >
        {isOpen && (
          <>
            <div className="border-b border-white/[0.06] px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[2px] text-white/40">
                  Event Log
                </span>
                <span className="text-[9px] text-white/20">{eventLog.length}</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2">
              {eventLog.length === 0 && (
                <div className="py-8 text-center text-[11px] text-white/20">
                  Waiting for agent activity...
                </div>
              )}
              {eventLog.map((evt, i) => (
                <div
                  key={i}
                  className="mb-1 rounded px-2.5 py-2 transition-opacity"
                  style={{
                    borderLeft: `2px solid #${evt.color.toString(16).padStart(6, '0')}`,
                    background: i === 0 ? 'rgba(74,144,217,0.06)' : 'transparent',
                    opacity: Math.max(0.3, 1 - i * 0.03),
                  }}
                >
                  <div className="mb-0.5 flex items-center justify-between">
                    <span
                      className="text-[11px] font-semibold"
                      style={{ color: `#${evt.color.toString(16).padStart(6, '0')}` }}
                    >
                      {evt.emoji} {evt.worker}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-white/5 px-1 py-px text-[8px] text-white/30">
                        {ROLE_LABELS[evt.role] ?? evt.role}
                      </span>
                      <span className="text-[9px] text-white/25">{evt.time}</span>
                    </div>
                  </div>
                  <div className="text-[10px] text-white/50">{evt.message}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
