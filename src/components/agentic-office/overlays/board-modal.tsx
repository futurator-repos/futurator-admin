'use client';
import { useEffect } from 'react';

/**
 * Generic 2D modal overlay for the agentic office "proxy boards" (Epic D).
 *
 * Mounts above the Canvas with a backdrop, Esc-to-close, and a close
 * button. Used for EC2 status, Gantt preview, and Plans list — each
 * content component lives in its own file and is passed via `children`.
 *
 * No iframes. Content is React components mounted directly; existing
 * pages are re-used by importing their inner pieces where possible,
 * falling back to a simplified view when the full page needs AppShell
 * or route-level side effects.
 */
export function BoardModal({
  open,
  onClose,
  title,
  subtitle,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Optional action buttons rendered in the header right slot. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[82%] w-[88%] max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border/60 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
          <div>
            <div className="text-[13px] font-semibold text-white">{title}</div>
            {subtitle && (
              <div className="text-[11px] text-white/50">{subtitle}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border/60 bg-black/40 px-2 py-1 text-[11px] text-white/80 hover:border-border hover:text-white"
            >
              Close ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
