'use client';
import { useState, Fragment, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { useFileDrawer } from './v2/file-drawer';

/* ── Inline text enhancers — @mentions + file paths ─────────────── */

const MENTION_RE = /@([A-Z][a-z]+)/g;
// File extensions worth previewing inline. We deliberately exclude binary
// formats (png, pdf, …) — they need a different drawer body.
const FILE_RE =
  /\b([\w./-]+\.(?:md|markdown|txt|ts|tsx|js|jsx|json|css|scss|html|py|go|rs|rb|java|kt|swift|c|cpp|h|sh|bash|zsh|yml|yaml|toml|xml|mjs|cjs|sql|env))\b/g;

function enhanceString(text: string, keyPrefix: string, openFile?: (path: string) => void): ReactNode[] {
  // Run both regexes, collect tokens with positions, replace non-overlapping hits
  interface Hit {
    kind: 'mention' | 'file';
    index: number;
    length: number;
    value: string;
  }
  const hits: Hit[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    hits.push({ kind: 'mention', index: m.index!, length: m[0].length, value: m[1] });
  }
  for (const m of text.matchAll(FILE_RE)) {
    hits.push({ kind: 'file', index: m.index!, length: m[0].length, value: m[1] });
  }
  if (hits.length === 0) return [text];
  hits.sort((a, b) => a.index - b.index);

  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.index < cursor) return;
    if (hit.index > cursor) out.push(text.slice(cursor, hit.index));
    const key = `${keyPrefix}-${i}`;
    if (hit.kind === 'mention') {
      out.push(
        <span key={key} className="party-mention">
          @{hit.value}
        </span>,
      );
    } else {
      // File path: clickable when a drawer-opener is in scope. Otherwise
      // render styled-but-inert (preserves visual treatment in standalone
      // RichText usage e.g. file preview body).
      const path = hit.value;
      out.push(
        openFile ? (
          <button
            type="button"
            key={key}
            className="party-link-file"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openFile(path);
            }}
            title={`Open ${path}`}
          >
            {path}
          </button>
        ) : (
          <span key={key} className="party-link-file">
            {path}
          </span>
        ),
      );
    }
    cursor = hit.index + hit.length;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function enhanceChildren(
  children: ReactNode,
  keyPrefix = 'e',
  openFile?: (path: string) => void,
): ReactNode {
  if (typeof children === 'string') {
    const parts = enhanceString(children, keyPrefix, openFile);
    return parts.length === 1 ? parts[0] : <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === 'string' ? (
        <Fragment key={i}>{enhanceString(c, `${keyPrefix}-${i}`, openFile)}</Fragment>
      ) : (
        <Fragment key={i}>{c}</Fragment>
      ),
    );
  }
  return children;
}

/* ── Lightweight syntax highlighter ───────────────────────────── */

const TS_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'interface',
  'type',
  'return',
  'if',
  'else',
  'for',
  'while',
  'import',
  'from',
  'export',
  'default',
  'class',
  'extends',
  'new',
  'async',
  'await',
  'number',
  'string',
  'boolean',
  'void',
  'null',
  'undefined',
  'true',
  'false',
]);

function highlightTs(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const rx = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(['"`])(?:\\.|(?!\2).)*\2|\b([A-Za-z_$][\w$]*)\b|\b(\d+(?:\.\d+)?)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = rx.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const k = `tok-${i++}`;
    if (m[1]) {
      out.push(
        <span key={k} className="party-tok-comment">
          {m[0]}
        </span>,
      );
    } else if (m[2]) {
      out.push(
        <span key={k} className="party-tok-string">
          {m[0]}
        </span>,
      );
    } else if (m[3]) {
      if (TS_KEYWORDS.has(m[3])) {
        out.push(
          <span key={k} className="party-tok-keyword">
            {m[0]}
          </span>,
        );
      } else if (/^[A-Z]/.test(m[3])) {
        out.push(
          <span key={k} className="party-tok-type">
            {m[0]}
          </span>,
        );
      } else {
        out.push(m[0]);
      }
    } else if (m[4]) {
      out.push(
        <span key={k} className="party-tok-number">
          {m[0]}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/* ── Block renderers ──────────────────────────────────────────── */

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }
  const highlighted =
    language && /^(ts|tsx|js|jsx|typescript|javascript)$/i.test(language)
      ? highlightTs(code)
      : code;
  return (
    <div className="my-2.5 overflow-hidden rounded-md border border-border bg-[#0b0b0b]">
      <div className="flex items-center justify-between border-b border-border bg-[#0f0f0f] px-2.5 py-1">
        <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground font-mono">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" /> copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> copy
            </>
          )}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 text-[12.5px] leading-[1.55] font-mono text-[#d4d4d4]">
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}

/* ── Public API ───────────────────────────────────────────────── */

export function RichText({ text }: { text: string }) {
  // FileDrawerProvider injects projectId so RichText only deals in paths.
  // When no provider is mounted (default ctx), `enabled` is false and we
  // pass undefined → file paths render as styled-but-inert spans.
  const drawer = useFileDrawer();
  const open = drawer.enabled ? drawer.openPath : undefined;
  return (
    <div className="text-[13.5px] leading-[1.6] text-foreground">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5">{enhanceChildren(children, 'e', open)}</p>,
          li: ({ children }) => <li className="my-0.5">{enhanceChildren(children, 'e', open)}</li>,
          strong: ({ children }) => (
            <strong style={{ fontWeight: 600, color: '#f4f4f4' }}>
              {enhanceChildren(children, 'e', open)}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ color: '#d4d4d4' }}>{enhanceChildren(children, 'e', open)}</em>
          ),
          del: ({ children }) => (
            <s className="text-muted-foreground/70">{enhanceChildren(children, 'e', open)}</s>
          ),
          blockquote: ({ children }) => <blockquote className="party-quote">{children}</blockquote>,
          hr: () => (
            <hr className="my-3" style={{ border: 'none', borderTop: '1px solid var(--border)' }} />
          ),
          h1: ({ children }) => (
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '14px 0 6px', color: '#f4f4f4' }}>
              {enhanceChildren(children, 'e', open)}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: '14px 0 6px', color: '#f4f4f4' }}>
              {enhanceChildren(children, 'e', open)}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: '12px 0 6px', color: '#f4f4f4' }}>
              {enhanceChildren(children, 'e', open)}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 style={{ fontSize: 13.5, fontWeight: 600, margin: '10px 0 6px', color: '#f4f4f4' }}>
              {enhanceChildren(children, 'e', open)}
            </h4>
          ),
          a: ({ href, children }) => {
            const isExternal = href && /^https?:\/\//.test(href);
            return (
              <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                className={`text-sky-300 underline decoration-dotted underline-offset-2 hover:decoration-solid ${
                  isExternal ? 'party-link-ext' : ''
                }`}
              >
                {children}
              </a>
            );
          },
          ul: ({ children }) => (
            <ul className="my-1.5 pl-5 list-disc">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 pl-5 list-decimal">{children}</ol>
          ),
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
            <td className="border-b border-border px-2.5 py-1.5 text-left align-top">
              {enhanceChildren(children, 'e', open)}
            </td>
          ),
          code: ({ className, children }) => {
            const raw = String(children ?? '').replace(/\n$/, '');
            const match = /language-([\w-]+)/.exec(className || '');
            const isBlock = Boolean(match) || raw.includes('\n');
            if (!isBlock) {
              return (
                <code
                  className="rounded border border-white/[0.04] bg-white/[0.06] px-1 py-px font-mono text-[0.88em]"
                  style={{ color: '#e0c6a8' }}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock language={match?.[1]} code={raw} />;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
