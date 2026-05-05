'use client';
import { useRef } from 'react';
import { FileText, Image as ImageIcon, X, Upload, Loader2 } from 'lucide-react';
import type { PmAttachment } from '@/hooks/use-epic-workflow';

interface Props {
  attachments: PmAttachment[];
  uploadingCount: number;
  onKindChange: (key: string, kind: 'reference' | 'asset') => void;
  onRemove: (key: string) => void;
  onPickFiles: (files: File[]) => void;
}

export function PmAttachmentTray({
  attachments,
  uploadingCount,
  onKindChange,
  onRemove,
  onPickFiles,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (attachments.length === 0 && uploadingCount === 0) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-ring"
        >
          <Upload className="h-3 w-3" />
          Attach files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf,text/markdown,text/plain,application/json"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) onPickFiles(files);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Attachments ({attachments.length}
          {uploadingCount > 0 ? ` + ${uploadingCount} uploading` : ''})
        </span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <Upload className="h-3 w-3" />
          Add
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,application/pdf,text/markdown,text/plain,application/json"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) onPickFiles(files);
            e.target.value = '';
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <AttachmentChip key={a.key} a={a} onKindChange={onKindChange} onRemove={onRemove} />
        ))}
        {uploadingCount > 0 && (
          <div className="flex items-center gap-1.5 rounded border border-input bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            uploading…
          </div>
        )}
      </div>
    </div>
  );
}

function AttachmentChip({
  a,
  onKindChange,
  onRemove,
}: {
  a: PmAttachment;
  onKindChange: (key: string, kind: 'reference' | 'asset') => void;
  onRemove: (key: string) => void;
}) {
  const isImage = a.mimeType.startsWith('image/');

  return (
    <div
      className="group flex items-center gap-2 rounded border border-input bg-background px-2 py-1 text-[11px]"
      title={`${a.filename} (${a.mimeType}, ${formatBytes(a.size)})`}
    >
      {isImage ? (
        <ImageIcon className="h-3 w-3 text-purple-400 shrink-0" />
      ) : (
        <FileText className="h-3 w-3 text-blue-400 shrink-0" />
      )}

      <span className="max-w-[180px] truncate">{a.filename}</span>
      <span className="text-muted-foreground">{formatBytes(a.size)}</span>

      <button
        type="button"
        onClick={() => onKindChange(a.key, a.kind === 'reference' ? 'asset' : 'reference')}
        className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
          a.kind === 'asset'
            ? 'bg-green-900/40 text-green-400'
            : 'bg-muted text-muted-foreground'
        }`}
        title={
          a.kind === 'asset'
            ? 'Ships with the app (click → reference only)'
            : 'Reference only, not shipped (click → ship as asset)'
        }
      >
        {a.kind}
      </button>

      <button
        type="button"
        onClick={() => onRemove(a.key)}
        className="text-muted-foreground hover:text-red-400"
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
