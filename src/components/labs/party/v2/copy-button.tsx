'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Reusable icon-only copy button — used on every agent card and orchestrator
 * container. See `docs/concepts/party-mode/party-mode-ui2.md` §8 for the
 * size, color, and confirm-state spec.
 *
 * Confirmed state lasts ~1.4s then reverts to default. Falls back silently
 * if the clipboard API throws (e.g. document not focused, perms denied).
 */
export function CopyButton({
  text,
  label = 'message',
  size = 28,
}: {
  text: string;
  label?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard not available */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      className="inline-flex items-center justify-center rounded-md border transition-colors"
      style={{
        width: size,
        height: size,
        background: copied ? 'rgba(35,165,90,0.18)' : 'rgba(255,255,255,0.04)',
        borderColor: copied ? 'rgba(35,165,90,0.45)' : 'rgba(255,255,255,0.06)',
        color: copied ? '#23a55a' : '#b5bac1',
      }}
      onMouseEnter={(e) => {
        if (copied) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
        e.currentTarget.style.color = '#ffffff';
      }}
      onMouseLeave={(e) => {
        if (copied) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        e.currentTarget.style.color = '#b5bac1';
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
