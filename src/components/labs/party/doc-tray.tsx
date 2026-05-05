'use client';
import { FileText, X, Loader2 } from 'lucide-react';
import { usePartyDocs, useDeletePartyDoc, type PartyDoc } from '@/hooks/use-party-docs';

interface Props {
  projectId: string;
  /**
   * Optional click-on-chip handler. When provided, each chip becomes a
   * button that calls `onPickDoc(filename)` — used by the V2 chat to drop
   * a `./docs/<filename>` reference into the composer so the agents see
   * the file on the next turn.
   */
  onPickDoc?: (filename: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocTray({ projectId, onPickDoc }: Props) {
  const { data, isLoading } = usePartyDocs(projectId);
  const del = useDeletePartyDoc(projectId);

  if (isLoading) return null;
  const docs: PartyDoc[] = data?.docs ?? [];
  if (docs.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
      <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        Docs
      </span>
      {docs.map((doc) => {
        const baseClass =
          'inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-[11px]';
        const interactiveClass = onPickDoc
          ? 'cursor-pointer transition-colors hover:bg-muted/70 hover:border-accent-blue/40'
          : '';
        const tooltip = onPickDoc
          ? `Click to insert ./docs/${doc.filename} into your message · ${formatBytes(doc.size)}`
          : `${doc.filename} · ${formatBytes(doc.size)}`;
        const inner = (
          <>
            <FileText className="h-3 w-3 text-muted-foreground" />
            <span className="max-w-[160px] truncate font-mono">{doc.filename}</span>
            <span className="text-[10px] text-muted-foreground">{formatBytes(doc.size)}</span>
            {/* Close affordance — `span role="button"` so it doesn't nest a
                <button> inside the chip's <button> wrapper. */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                if (!del.isPending) del.mutate(doc.filename);
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !del.isPending) {
                  e.preventDefault();
                  e.stopPropagation();
                  del.mutate(doc.filename);
                }
              }}
              aria-disabled={del.isPending}
              className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-red-400 aria-disabled:opacity-50"
              title="Remove doc"
            >
              {del.isPending && del.variables === doc.filename ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <X className="h-2.5 w-2.5" />
              )}
            </span>
          </>
        );
        if (onPickDoc) {
          return (
            <button
              key={doc.filename}
              type="button"
              onClick={() => onPickDoc(doc.filename)}
              className={`${baseClass} ${interactiveClass}`}
              title={tooltip}
            >
              {inner}
            </button>
          );
        }
        return (
          <div key={doc.filename} className={baseClass} title={tooltip}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
