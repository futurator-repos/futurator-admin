'use client';
import { useRef } from 'react';
import { Paperclip, AtSign, Slash, ArrowRight, Square, Loader2 } from 'lucide-react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isProcessing: boolean;
  disabled?: boolean;
  maxBytes?: number;
  placeholder?: string;
  onAttach?: (files: File[]) => void;
  isUploading?: boolean;
  acceptedTypes?: string;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isProcessing,
  disabled = false,
  maxBytes = 8192,
  placeholder,
  onAttach,
  isUploading = false,
  acceptedTypes,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bytes = new TextEncoder().encode(value || '').length;
  const pct = Math.min(100, (bytes / maxBytes) * 100);
  const near = pct > 80;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function handleAttachClick() {
    if (onAttach) fileInputRef.current?.click();
  }
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onAttach) return;
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onAttach(files);
    e.target.value = ''; // reset so the same filename can be re-selected
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (value.trim()) onSend();
    }
  }

  const effectivePlaceholder =
    placeholder ||
    (isProcessing
      ? 'Party agents are thinking… (type your next message)'
      : 'Type a message, @-mention an agent to target them');

  const circumference = 2 * Math.PI * 5.5;
  const dashOffset = circumference - (pct / 100) * circumference;

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-2.5 flex flex-col gap-1.5">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={effectivePlaceholder}
        disabled={disabled}
        rows={2}
        className="min-h-[60px] max-h-[180px] w-full resize-none bg-transparent px-1.5 py-1 text-[13px] font-mono text-foreground placeholder:text-muted-foreground focus:outline-none"
      />

      <div className="flex items-center gap-1.5">
        {onAttach ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={acceptedTypes}
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={handleAttachClick}
              disabled={isUploading}
              title="Attach doc for this project"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5" />
              )}
            </button>
          </>
        ) : (
          <IconBtn title="Attach file or code reference">
            <Paperclip className="h-3.5 w-3.5" />
          </IconBtn>
        )}
        <IconBtn title="Mention agent">
          <AtSign className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="Slash commands">
          <Slash className="h-3.5 w-3.5" />
        </IconBtn>

        <span className="flex-1" />

        {/* byte ring + counter */}
        <div
          className={`flex items-center gap-1.5 text-[10.5px] font-mono ${
            near ? 'text-warning' : 'text-muted-foreground'
          }`}
          title={`${bytes.toLocaleString()} of ${maxBytes.toLocaleString()} bytes`}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--border)" strokeWidth="1.5" />
            <circle
              cx="7"
              cy="7"
              r="5.5"
              fill="none"
              stroke={near ? 'var(--warning)' : 'var(--success)'}
              strokeWidth="1.5"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span>
            {bytes.toLocaleString()}/{maxBytes.toLocaleString()}
          </span>
        </div>

        <span className="ml-1 text-[10.5px] text-muted-foreground">
          <span className="party-kbd">⌘</span>
          <span className="party-kbd">↵</span> to send
        </span>

        {isProcessing && onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/60 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Square className="h-3 w-3" fill="currentColor" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function IconBtn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled
      title={`${title} (coming soon)`}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.04] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
