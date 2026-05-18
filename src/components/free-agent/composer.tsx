/**
 * composer.tsx — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Textarea-based composer with:
 *   - Keyboard handling (AC #6): Cmd/Ctrl+Enter → send, Shift+Enter/Enter → newline
 *   - Image paste from Cmd+Shift+4 (or any clipboard image) → resize → JPEG
 *     encode → preview chip → ship as base64 in the send payload
 *
 * Send wiring is in Story 18.5 via the parent's `onSend` callback.
 */

'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { SendHorizontal, X } from 'lucide-react';
import { useFreeAgentStore } from '@/stores/free-agent-store';

export interface ComposerImageAttachment {
  /** Stable client-side id for React keys + removal. */
  id: string;
  /** Same shape the API/daemon expect. No `data:` prefix on base64. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  base64: string;
  /** Object URL for the preview <img>. Revoked on removal/unmount. */
  previewUrl: string;
}

interface FreeAgentComposerProps {
  /** True while a turn is in flight (POST in progress or daemon PROCESSING). */
  isSending?: boolean;
  /** Wire up by Story 18.5 — receives the text + (optional) image attachments. */
  onSend?: (text: string, images?: Array<{ mediaType: string; base64: string }>) => void;
}

const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;
const MAX_IMAGES = 4;
const MAX_IMAGE_LONGEST_EDGE_PX = 1500;
const JPEG_QUALITY = 0.85;
const ACCEPTED_PASTE_MIME = /^image\/(png|jpeg|webp|gif)$/;

export function FreeAgentComposer({ isSending = false, onSend }: FreeAgentComposerProps) {
  const text = useFreeAgentStore((s) => s.composerText);
  const setText = useFreeAgentStore((s) => s.setComposerText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Auto-grow the textarea up to MAX_ROWS lines, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = MAX_ROWS * LINE_HEIGHT_PX + 16;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [text]);

  // Revoke any object URLs when component unmounts so the browser doesn't
  // leak the underlying blobs.
  useEffect(() => {
    return () => {
      for (const img of images) {
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSend = (text.trim().length > 0 || images.length > 0) && !isSending;

  const handleSend = () => {
    if (!canSend) return;
    const wireImages = images.map((i) => ({ mediaType: i.mediaType, base64: i.base64 }));
    onSend?.(text, wireImages.length > 0 ? wireImages : undefined);
    // Clear preview URLs after send.
    for (const img of images) {
      try {
        URL.revokeObjectURL(img.previewUrl);
      } catch {
        /* ignore */
      }
    }
    setImages([]);
    setPasteError(null);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && isMeta) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt || !dt.items) return;
    const pastedFiles: File[] = [];
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item.kind === 'file' && ACCEPTED_PASTE_MIME.test(item.type)) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length === 0) return; // plain text paste — let textarea handle.
    e.preventDefault();
    setPasteError(null);

    const remainingSlots = MAX_IMAGES - images.length;
    if (remainingSlots <= 0) {
      setPasteError(`Max ${MAX_IMAGES} images per message`);
      return;
    }
    const toAdd = pastedFiles.slice(0, remainingSlots);

    const next: ComposerImageAttachment[] = [];
    for (const file of toAdd) {
      try {
        const compressed = await compressImage(file);
        next.push(compressed);
      } catch (err) {
        setPasteError(`Couldn't read paste: ${(err as Error).message}`);
      }
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next]);
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((i) => i.id !== id);
    });
  };

  return (
    <div className="border-t bg-background">
      {/* Image preview chips */}
      {images.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5 border-b border-dashed px-2 py-1.5"
          data-testid="free-agent-attachments"
          role="list"
          aria-label="Pasted images"
        >
          {images.map((img) => (
            <div
              key={img.id}
              role="listitem"
              className="group relative h-12 w-12 overflow-hidden rounded border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.previewUrl}
                alt="Pasted attachment"
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => handleRemoveImage(img.id)}
                className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center rounded-bl bg-black/70 text-white hover:bg-black group-hover:flex"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pasteError && (
        <div className="border-b border-dashed border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
          {pasteError}
        </div>
      )}

      <div className="flex items-end gap-2 p-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={MIN_ROWS}
          placeholder={
            isSending
              ? 'Agent is working — wait for the reply before sending again'
              : 'Send a message (⌘↵ to send, Shift+↵ for newline, ⌘V to paste images)'
          }
          disabled={isSending}
          aria-label="Message composer"
          data-testid="free-agent-composer"
          className="flex-1 resize-none rounded border bg-background px-2 py-1 text-sm leading-5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Send message"
          data-testid="free-agent-send"
          disabled={!canSend}
          onClick={handleSend}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors ${
            canSend
              ? 'bg-[color:var(--accent-blue,#3b82f6)] text-white hover:opacity-90'
              : 'cursor-not-allowed bg-muted text-muted-foreground'
          }`}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Downsize + re-encode a pasted image so the base64 payload stays under the
 * API's 900KB/image budget (which is required to keep the agent-jobs DDB row
 * under 400KB hard limit even with 4 attachments). Uses a canvas — no
 * external deps. Always re-encodes to JPEG @85%; GIF animation is lost
 * (acceptable for screenshots; users wanting animated GIFs are rare here).
 */
async function compressImage(file: File): Promise<ComposerImageAttachment> {
  const bitmap = await createImageBitmap(file);
  const longestEdge = Math.max(bitmap.width, bitmap.height);
  const scale =
    longestEdge > MAX_IMAGE_LONGEST_EDGE_PX ? MAX_IMAGE_LONGEST_EDGE_PX / longestEdge : 1;
  const targetW = Math.round(bitmap.width * scale);
  const targetH = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
  });
  if (!blob) throw new Error('canvas.toBlob failed');

  const arrayBuf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuf);
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mediaType: 'image/jpeg',
    base64,
    previewUrl: URL.createObjectURL(blob),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
