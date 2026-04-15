'use client';
import { useOfficeStore } from '@/stores/office-store';

export function OfficeControls() {
  const isPaused = useOfficeStore((s) => s.isPaused);
  const speed = useOfficeStore((s) => s.speed);
  const togglePause = useOfficeStore((s) => s.togglePause);
  const setSpeed = useOfficeStore((s) => s.setSpeed);
  const workers = useOfficeStore((s) => s.workers);

  const workerCount = workers.size;
  const deskAssignments = useOfficeStore((s) => s.deskAssignments);
  const desksUsed = deskAssignments.filter((d) => d !== null).length;

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-end gap-3">
      {/* Stats badges */}
      <div className="pointer-events-none flex gap-2">
        <Badge label="Workers" count={workerCount} color="#4a90d9" />
        <Badge label="Desks" count={`${desksUsed}/10`} color="#d9a04a" />
      </div>

      {/* Controls */}
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-white/10 bg-[#12122aee] px-3 py-2 backdrop-blur-sm">
        <button
          onClick={togglePause}
          className="rounded px-2.5 py-1 text-[11px] font-medium tracking-wide transition"
          style={{
            background: isPaused ? 'rgba(217,74,106,0.15)' : 'rgba(74,217,150,0.15)',
            color: isPaused ? '#d94a6a' : '#4ad996',
            border: `1px solid ${isPaused ? 'rgba(217,74,106,0.3)' : 'rgba(74,217,150,0.3)'}`,
          }}
        >
          {isPaused ? '▶ RESUME' : '⏸ PAUSE'}
        </button>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/40">Speed</span>
          <input
            type="range"
            min="0.2"
            max="3"
            step="0.1"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="h-1 w-20 accent-blue-500"
          />
          <span className="min-w-[30px] text-right text-[11px] text-blue-400">
            {speed.toFixed(1)}x
          </span>
        </div>
      </div>
    </div>
  );
}

function Badge({ label, count, color }: { label: string; count: number | string; color: string }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px]"
      style={{
        background: `${color}15`,
        border: `1px solid ${color}30`,
        color,
      }}
    >
      <div className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {count} {label}
    </div>
  );
}
