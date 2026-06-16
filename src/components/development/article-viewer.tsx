'use client';

/**
 * ArticleViewer — renders a knowledge article (markdown) inline in a modal
 * instead of opening the raw `.md` in a browser tab. Fetches from CloudFront
 * (futurator.ai/knowledge-live/…) and renders with react-markdown + GFM.
 */

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface ArticleViewerProps {
  url: string;
  title: string;
  /** The raw URL, surfaced as an "open raw" escape hatch. */
  rawUrl?: string;
  onClose: () => void;
}

export function ArticleViewer({ url, title, rawUrl, onClose }: ArticleViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setContent(text);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <span className="flex-1 truncate font-semibold">{title}</span>
          {rawUrl && (
            <a
              href={rawUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            >
              open raw ↗
            </a>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto px-6 py-5">
          {error && (
            <div className="text-sm text-warning-foreground">
              Couldn&apos;t load the article ({error}). It may not be mirrored yet.
            </div>
          )}
          {!error && content === null && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          {content !== null && (
            <div className="space-y-3 text-sm leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: (p) => <h1 className="mt-4 text-lg font-semibold" {...p} />,
                  h2: (p) => <h2 className="mt-4 text-base font-semibold" {...p} />,
                  h3: (p) => <h3 className="mt-3 text-sm font-semibold" {...p} />,
                  p: (p) => <p className="my-2" {...p} />,
                  ul: (p) => <ul className="my-2 list-disc pl-5" {...p} />,
                  ol: (p) => <ol className="my-2 list-decimal pl-5" {...p} />,
                  li: (p) => <li className="my-0.5" {...p} />,
                  a: (p) => (
                    <a
                      className="text-accent-blue underline"
                      target="_blank"
                      rel="noopener noreferrer"
                      {...p}
                    />
                  ),
                  code: (p) => (
                    <code
                      className="rounded bg-muted px-1 py-0.5 text-xs text-accent-blue"
                      {...p}
                    />
                  ),
                  pre: (p) => (
                    <pre className="my-2 overflow-auto rounded-md bg-muted p-3 text-xs" {...p} />
                  ),
                  table: (p) => <table className="my-2 w-full border-collapse text-xs" {...p} />,
                  th: (p) => <th className="border border-border px-2 py-1 text-left" {...p} />,
                  td: (p) => <td className="border border-border px-2 py-1" {...p} />,
                  blockquote: (p) => (
                    <blockquote
                      className="border-l-2 border-border pl-3 text-muted-foreground"
                      {...p}
                    />
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
