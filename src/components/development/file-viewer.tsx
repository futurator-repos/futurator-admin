'use client';
import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { useTheme } from 'next-themes';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download, Copy, Check, AlertCircle, Loader2, Eye, FileCode } from 'lucide-react';
import type { Extension } from '@codemirror/state';
import { useEc2FileContent, type FileContentResponse } from '@/hooks/use-ec2-files';
import { cn } from '@/lib/utils';

// ── Filename → CodeMirror language extension ────────────────────────────────
// Each language ships as its own package; we lazy-import only the one we need
// so opening a single .json file doesn't drag in the JS+Python+HTML parsers.
async function languageExtensionForFilename(filename: string): Promise<Extension | null> {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? (lower.split('.').pop() ?? '') : lower;
  switch (ext) {
    case 'ts':
    case 'tsx': {
      const m = await import('@codemirror/lang-javascript');
      return m.javascript({ typescript: true, jsx: ext === 'tsx' });
    }
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': {
      const m = await import('@codemirror/lang-javascript');
      return m.javascript({ jsx: ext === 'jsx' });
    }
    case 'json':
    case 'jsonc': {
      const m = await import('@codemirror/lang-json');
      return m.json();
    }
    case 'md':
    case 'mdx':
    case 'markdown': {
      const m = await import('@codemirror/lang-markdown');
      return m.markdown();
    }
    case 'yaml':
    case 'yml': {
      const m = await import('@codemirror/lang-yaml');
      return m.yaml();
    }
    case 'html':
    case 'htm': {
      const m = await import('@codemirror/lang-html');
      return m.html();
    }
    case 'css':
    case 'scss':
    case 'sass':
    case 'less': {
      const m = await import('@codemirror/lang-css');
      return m.css();
    }
    case 'xml':
    case 'svg': {
      const m = await import('@codemirror/lang-xml');
      return m.xml();
    }
    case 'py': {
      const m = await import('@codemirror/lang-python');
      return m.python();
    }
    default:
      return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '—';
  }
}

// Trigger a browser download from a base64 payload without ever storing the
// blob in state — built lazily on click, revoked immediately after.
function downloadBase64(name: string, mime: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Renderers ───────────────────────────────────────────────────────────────

function CodeRenderer({ filename, content }: { filename: string; content: string }) {
  const { resolvedTheme } = useTheme();
  const [extensions, setExtensions] = useState<Extension[]>([]);

  useEffect(() => {
    let cancelled = false;
    languageExtensionForFilename(filename).then((ext) => {
      if (cancelled) return;
      setExtensions(ext ? [ext] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [filename]);

  return (
    <CodeMirror
      value={content}
      extensions={extensions}
      theme={resolvedTheme === 'dark' ? oneDark : undefined}
      readOnly
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
      }}
      style={{ fontSize: '13px', height: '100%' }}
      height="100%"
    />
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose-sm h-full overflow-auto px-6 py-4 text-[13.5px] leading-[1.65] text-foreground">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-2xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-xl font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-2 text-lg font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-3 mb-1 text-base font-semibold">{children}</h4>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-6">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const raw = String(children ?? '').replace(/\n$/, '');
            const isBlock = (className && /language-/.test(className)) || raw.includes('\n');
            if (!isBlock) {
              return (
                <code className="rounded bg-muted px-1 py-px font-mono text-[0.88em]">
                  {children}
                </code>
              );
            }
            return (
              <pre className="my-2 overflow-x-auto rounded-md border border-border bg-[#0b0b0b] p-3 text-[12.5px] leading-[1.55] text-[#d4d4d4]">
                <code>{raw}</code>
              </pre>
            );
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded border border-border">
              <table className="w-full text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted/40 px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border px-2.5 py-1.5 align-top">{children}</td>
          ),
          hr: () => <hr className="my-3 border-border" />,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

// Convert a base64 payload to a blob URL. Blob URLs decode in more browsers
// than data URLs (notably Chrome's ICO handling) and don't bloat the DOM with
// megabytes of base64 in the src attribute.
function useBlobUrl(base64: string, mime: string): string {
  const url = useMemo(() => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }, [base64, mime]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

function ImageRenderer({ mime, base64, filename }: { mime: string; base64: string; filename: string }) {
  const url = useBlobUrl(base64, mime);
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[#0b0b0b] p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={filename}
        className="max-h-full max-w-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    </div>
  );
}

function PdfRenderer({ mime, base64, filename }: { mime: string; base64: string; filename: string }) {
  const url = useBlobUrl(base64, mime);
  return (
    <embed src={url} type={mime} title={filename} className="h-full w-full bg-[#0b0b0b]" />
  );
}

// Render an SVG string by wrapping it in a blob URL — keeps the SVG sandboxed
// in an <img> (no script execution, no DOM access) so previewing untrusted
// SVGs from the EC2 filesystem can't run code in our origin.
function SvgPreview({ content, filename }: { content: string; filename: string }) {
  const url = useMemo(() => {
    const blob = new Blob([content], { type: 'image/svg+xml' });
    return URL.createObjectURL(blob);
  }, [content]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[#0b0b0b] p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={filename} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

// Empty `sandbox=""` blocks scripts, forms, top-level navigation, popups, and
// same-origin access — safe to render arbitrary HTML this way. Note: pages
// that pull sibling CSS/JS (e.g. Next.js out/index.html) will render with
// broken assets; `srcdoc` has no concept of a base directory.
function HtmlPreview({ content }: { content: string }) {
  return (
    <iframe
      title="HTML preview"
      sandbox=""
      srcDoc={content}
      className="h-full w-full border-0 bg-white"
    />
  );
}

function BinaryFallback({
  filename,
  size,
  mime,
  base64,
}: {
  filename: string;
  size: number;
  mime: string;
  base64?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-foreground">Binary file ({formatBytes(size)})</p>
      <p className="text-xs text-muted-foreground">
        {mime || 'application/octet-stream'} — preview not available.
      </p>
      {base64 && (
        <button
          onClick={() => downloadBase64(filename, mime || 'application/octet-stream', base64)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
      )}
    </div>
  );
}

function TooLargeFallback({
  filename,
  size,
  maxBytes,
}: {
  filename: string;
  size: number;
  maxBytes: number;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-amber-500" />
      <p className="text-sm text-foreground">File too large to preview</p>
      <p className="text-xs text-muted-foreground">
        {formatBytes(size)} exceeds the {formatBytes(maxBytes)} preview limit.
      </p>
      <p className="text-[10px] text-muted-foreground font-mono break-all">{filename}</p>
    </div>
  );
}

// ── Top-level viewer ────────────────────────────────────────────────────────

export interface OpenTab {
  id: string; // == path
  path: string;
  name: string;
}

export function FileViewer({ tab }: { tab: OpenTab }) {
  const { data, isLoading, error } = useEc2FileContent(tab.path);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Reading {tab.name}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertCircle className="h-7 w-7 text-red-400" />
        <p className="text-sm text-red-400">{(error as Error).message}</p>
        <p className="text-[10px] text-muted-foreground font-mono break-all">{tab.path}</p>
      </div>
    );
  }

  if (!data) return null;

  return <FileViewerHeader tab={tab} data={data} />;
}

// Discriminator helper — TS narrows the rest of the union to the readable
// shape (kind + size + mtime + content|base64) once this returns false.
function isTooLarge(
  d: FileContentResponse,
): d is Extract<FileContentResponse, { tooLarge: true }> {
  return 'tooLarge' in d && d.tooLarge === true;
}

type ViewMode = 'source' | 'preview';

// Files that can be flipped between code-view and rendered-view. SVG defaults
// to preview (visual file → visual default); HTML defaults to source (most
// HTML in /home/ubuntu is build output that won't render usefully without its
// sibling assets, so showing source first is more honest).
function previewableExt(ext: string): { previewable: boolean; defaultMode: ViewMode } {
  if (ext === 'svg') return { previewable: true, defaultMode: 'preview' };
  if (ext === 'html' || ext === 'htm') return { previewable: true, defaultMode: 'source' };
  return { previewable: false, defaultMode: 'source' };
}

function renderBody(tab: OpenTab, data: FileContentResponse, mode: ViewMode) {
  if (isTooLarge(data)) {
    return <TooLargeFallback filename={tab.name} size={data.size} maxBytes={data.maxBytes} />;
  }
  if (data.kind === 'text') {
    const ext = tab.name.toLowerCase().split('.').pop() ?? '';
    if (mode === 'preview') {
      if (ext === 'svg') return <SvgPreview content={data.content} filename={tab.name} />;
      if (ext === 'html' || ext === 'htm') return <HtmlPreview content={data.content} />;
    }
    if (ext === 'md' || ext === 'mdx' || ext === 'markdown') {
      return <MarkdownRenderer content={data.content} />;
    }
    return <CodeRenderer filename={tab.name} content={data.content} />;
  }
  if (data.kind === 'image') {
    return <ImageRenderer mime={data.mime} base64={data.base64} filename={tab.name} />;
  }
  if (data.kind === 'pdf') {
    return <PdfRenderer mime={data.mime} base64={data.base64} filename={tab.name} />;
  }
  return (
    <BinaryFallback
      filename={tab.name}
      size={data.size}
      mime={data.mime}
      base64={data.base64}
    />
  );
}

function FileViewerHeader({ tab, data }: { tab: OpenTab; data: FileContentResponse }) {
  const [copied, setCopied] = useState(false);
  const tooLarge = isTooLarge(data);
  const { kind, mime, size, mtime } = data;
  const ext = tab.name.toLowerCase().split('.').pop() ?? '';
  const { previewable, defaultMode } = previewableExt(ext);
  // FileExplorer uses `<FileViewer key={activeTab.id}>` so this whole
  // component remounts on tab switch — useState's lazy init gives us a clean
  // per-file mode without needing a reset effect.
  const [mode, setMode] = useState<ViewMode>(defaultMode);

  async function copyContent() {
    if (isTooLarge(data) || data.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }

  function downloadCurrent() {
    if (isTooLarge(data)) return;
    if (data.kind === 'text') {
      downloadText(tab.name, data.content);
    } else {
      downloadBase64(tab.name, data.mime || 'application/octet-stream', data.base64);
    }
  }

  const body = useMemo(() => renderBody(tab, data, mode), [data, tab, mode]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono truncate flex-1" title={tab.path}>
          {tab.path}
        </span>
        <span>{formatBytes(size)}</span>
        <span title="Modified (UTC)">{formatMtime(mtime)}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 uppercase tracking-wide text-[9px]">
          {kind}
          {mime && kind !== 'text' ? ` · ${mime}` : ''}
        </span>
        {!tooLarge && previewable && data.kind === 'text' && (
          <div className="inline-flex overflow-hidden rounded border border-border">
            <button
              onClick={() => setMode('source')}
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]',
                mode === 'source'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title="View source"
            >
              <FileCode className="h-3 w-3" />
              Source
            </button>
            <button
              onClick={() => setMode('preview')}
              className={cn(
                'inline-flex items-center gap-1 border-l border-border px-1.5 py-0.5 text-[10px]',
                mode === 'preview'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              title="Render preview"
            >
              <Eye className="h-3 w-3" />
              Preview
            </button>
          </div>
        )}
        {!tooLarge && data.kind === 'text' && (
          <button
            onClick={copyContent}
            className="inline-flex items-center gap-1 rounded p-1 hover:bg-accent hover:text-foreground"
            title="Copy contents"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        )}
        {!tooLarge && (
          <button
            onClick={downloadCurrent}
            className="inline-flex items-center gap-1 rounded p-1 hover:bg-accent hover:text-foreground"
            title="Download"
          >
            <Download className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}
