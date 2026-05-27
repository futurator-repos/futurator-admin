'use client';
import { useId, useRef } from 'react';
import { FileText, X, Loader2, Plus } from 'lucide-react';
import {
  usePartyDocs,
  useDeletePartyDoc,
  useUploadPartyDoc,
  type PartyDoc,
} from '@/hooks/use-party-docs';

interface Props {
  projectId: string;
  /**
   * Active debate session. `session`-scoped docs are private to it; `shared`
   * docs show regardless. When null (e.g. the project chooser) only shared
   * docs render and session uploads are disabled.
   */
  sessionId: string | null;
  /**
   * Optional click-on-chip handler. When provided, each chip becomes a
   * button that calls `onPickDoc(filename)` — used by the V2 chat to drop
   * a `./.party-uploads/<filename>` reference into the composer.
   */
  onPickDoc?: (filename: string) => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocTray({ projectId, sessionId, onPickDoc }: Props) {
  const { data, isLoading } = usePartyDocs(projectId, sessionId);
  const del = useDeletePartyDoc(projectId, sessionId);
  const upload = useUploadPartyDoc(projectId, sessionId);
  const sharedInputId = useId();
  const sharedInputRef = useRef<HTMLInputElement | null>(null);

  const sessionDocs: PartyDoc[] = data?.session ?? [];
  const sharedDocs: PartyDoc[] = data?.shared ?? [];

  // Hide entirely until the first list resolves AND there's nothing to show —
  // avoids a flash of an empty "+ shared" row before docs load.
  if (isLoading && sessionDocs.length === 0 && sharedDocs.length === 0) return null;

  async function onSharedFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file
    for (const file of files) {
      try {
        await upload.mutateAsync({ file, scope: 'shared' });
      } catch (err) {
        console.error('[Party] shared doc upload failed:', file.name, err);
      }
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 pb-2">
      {sessionDocs.length > 0 && (
        <>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            This debate
          </span>
          {sessionDocs.map((doc) => (
            <DocChip
              key={`session:${doc.filename}`}
              doc={doc}
              onPickDoc={onPickDoc}
              onDelete={() => del.mutate({ filename: doc.filename, scope: 'session' })}
              deleting={del.isPending && del.variables?.filename === doc.filename}
            />
          ))}
        </>
      )}

      {sharedDocs.length > 0 && (
        <>
          <span className="ml-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Shared
          </span>
          {sharedDocs.map((doc) => (
            <DocChip
              key={`shared:${doc.filename}`}
              doc={doc}
              shared
              onPickDoc={onPickDoc}
              onDelete={() => del.mutate({ filename: doc.filename, scope: 'shared' })}
              deleting={del.isPending && del.variables?.filename === doc.filename}
            />
          ))}
        </>
      )}

      {/* Add a project-level shared doc (visible in every debate of the
          project). Session docs are uploaded via the composer paperclip. */}
      <label
        htmlFor={sharedInputId}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-accent-blue/40 hover:text-foreground"
        title="Add a shared doc — visible in every debate of this project"
      >
        {upload.isPending && upload.variables?.scope === 'shared' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Plus className="h-3 w-3" />
        )}
        shared
      </label>
      <input
        id={sharedInputId}
        ref={sharedInputRef}
        type="file"
        className="sr-only"
        onChange={onSharedFilePicked}
        disabled={upload.isPending}
      />
    </div>
  );
}

function DocChip({
  doc,
  shared = false,
  onPickDoc,
  onDelete,
  deleting,
}: {
  doc: PartyDoc;
  shared?: boolean;
  onPickDoc?: (filename: string) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const baseClass = `inline-flex items-center gap-1.5 rounded-full border pl-2 pr-1 py-0.5 text-[11px] ${
    shared ? 'border-accent-blue/30 bg-accent-blue/5' : 'border-border bg-muted/40'
  }`;
  const interactiveClass = onPickDoc
    ? 'cursor-pointer transition-colors hover:bg-muted/70 hover:border-accent-blue/40'
    : '';
  const tooltip = onPickDoc
    ? `Click to insert ./.party-uploads/${doc.filename} into your message · ${formatBytes(doc.size)}`
    : `${doc.filename} · ${formatBytes(doc.size)}`;

  const inner = (
    <>
      <FileText className="h-3 w-3 text-muted-foreground" />
      <span className="max-w-[160px] truncate font-mono">{doc.filename}</span>
      <span className="text-[10px] text-muted-foreground">{formatBytes(doc.size)}</span>
      {/* Close affordance — span role="button" so it doesn't nest a <button>
          inside the chip's <button> wrapper. */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          if (!deleting) onDelete();
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !deleting) {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }
        }}
        aria-disabled={deleting}
        className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-red-400 aria-disabled:opacity-50"
        title={shared ? 'Remove shared doc' : 'Remove doc'}
      >
        {deleting ? (
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
    <div className={baseClass} title={tooltip}>
      {inner}
    </div>
  );
}
