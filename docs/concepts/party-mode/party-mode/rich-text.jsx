/* global React */
// RichText.jsx — minimal markdown-ish renderer for agent messages.
// Supports: **bold**, *italic*, ~~strike~~, `inline code`, ```fenced```,
// [text](url), ### headers, > blockquotes, - lists, 1. numbered lists,
// horizontal rules (---), auto-linked URLs and file paths.

const { useState } = React;

// Inline tokenizer: bold / italic / code / strike / links + autolinks for
// urls and file paths.
function renderInline(text, keyPrefix = '') {
  const nodes = [];
  let rest = text;
  let i = 0;
  // Regex order matters — first match wins at each position.
  const PATTERNS = [
    { kind: 'code', re: /`([^`]+)`/ },
    { kind: 'bold', re: /\*\*([^*]+)\*\*/ },
    { kind: 'italic', re: /\*([^*\n]+)\*/ },
    { kind: 'strike', re: /~~([^~]+)~~/ },
    { kind: 'link', re: /\[([^\]]+)\]\(([^)]+)\)/ },
    { kind: 'url', re: /(https?:\/\/[^\s)]+)/ },
    { kind: 'file', re: /(?:^|\s)([\w./-]+\.(?:md|ts|tsx|js|jsx|json|css|html|py|go|rs|yml|yaml|sh))(?=\s|$|[,.;:)])/ },
    { kind: 'mention', re: /@([A-Z][a-z]+)/ },
  ];

  while (rest.length > 0) {
    let best = null;
    for (const p of PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { ...p, match: m, index: m.index };
      }
    }
    if (!best) {
      nodes.push(rest);
      break;
    }
    if (best.index > 0) {
      nodes.push(rest.slice(0, best.index));
    }
    const k = `${keyPrefix}-${i++}`;
    const m = best.match;
    switch (best.kind) {
      case 'code':
        nodes.push(<code key={k} className="inline-code">{m[1]}</code>);
        break;
      case 'bold':
        nodes.push(<strong key={k} style={{ fontWeight: 600, color: '#f4f4f4' }}>{renderInline(m[1], k)}</strong>);
        break;
      case 'italic':
        nodes.push(<em key={k} style={{ color: '#d4d4d4' }}>{renderInline(m[1], k)}</em>);
        break;
      case 'strike':
        nodes.push(<s key={k} style={{ color: 'var(--fg-dim)' }}>{m[1]}</s>);
        break;
      case 'link': {
        const isExt = /^https?:/.test(m[2]);
        nodes.push(
          <a key={k} href={m[2]} className={`rich-link ${isExt ? 'rich-link-ext' : 'rich-link-file'}`} onClick={(e) => e.preventDefault()}>
            {m[1]}
          </a>,
        );
        break;
      }
      case 'url':
        nodes.push(
          <a key={k} href={m[1]} className="rich-link rich-link-ext" onClick={(e) => e.preventDefault()}>
            {m[1].replace(/^https?:\/\//, '').slice(0, 40)}{m[1].length > 47 ? '…' : ''}
          </a>,
        );
        break;
      case 'file': {
        const leading = m[0].startsWith(' ') ? ' ' : '';
        nodes.push(leading);
        nodes.push(
          <a key={k} className="rich-link rich-link-file" onClick={(e) => e.preventDefault()}>
            {m[1]}
          </a>,
        );
        break;
      }
      case 'mention':
        nodes.push(<span key={k} className="mention">@{m[1]}</span>);
        break;
      default:
        nodes.push(m[0]);
    }
    rest = rest.slice(best.index + m[0].length);
  }
  return nodes;
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div className="codeblock">
      <div className="codeblock-header">
        <span>{lang || 'code'}</span>
        <button className="btn btn-ghost" style={{ padding: '1px 6px', fontSize: 10.5 }} onClick={copy}>
          {copied ? '✓ copied' : '⧉ copy'}
        </button>
      </div>
      <pre>{highlightCode(code, lang)}</pre>
    </div>
  );
}

// Very light syntax coloring — enough to feel alive, not a full lexer.
function highlightCode(code, lang) {
  if (!lang || !/^(ts|tsx|js|jsx|typescript|javascript)$/i.test(lang)) return code;
  const tokens = [];
  const rx = /(\/\/[^\n]*)|(['"`])(?:\\.|(?!\2).)*\2|\b(const|let|var|function|interface|type|return|if|else|for|while|import|from|export|default|class|extends|new|async|await|number|string|boolean|void)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Z][a-zA-Z0-9]*)\b/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = rx.exec(code)) !== null) {
    if (m.index > last) tokens.push(code.slice(last, m.index));
    const k = `t-${i++}`;
    if (m[1]) tokens.push(<span key={k} style={{ color: '#6b7280' }}>{m[0]}</span>);
    else if (m[2]) tokens.push(<span key={k} style={{ color: '#a5b4fc' }}>{m[0]}</span>);
    else if (m[3]) tokens.push(<span key={k} style={{ color: '#f0abfc' }}>{m[0]}</span>);
    else if (m[4]) tokens.push(<span key={k} style={{ color: '#fdba74' }}>{m[0]}</span>);
    else if (m[5]) tokens.push(<span key={k} style={{ color: '#7dd3fc' }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) tokens.push(code.slice(last));
  return tokens;
}

function RichText({ text }) {
  if (!text) return null;
  // Split on fenced code blocks first, then render the rest block-by-block.
  const segments = [];
  const fence = /```(\w+)?\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: 'prose', text: text.slice(last, m.index) });
    segments.push({ kind: 'code', lang: m[1], code: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'prose', text: text.slice(last) });

  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--fg)' }}>
      {segments.map((s, i) => {
        if (s.kind === 'code') return <CodeBlock key={i} lang={s.lang} code={s.code} />;
        return <Prose key={i} text={s.text} />;
      })}
    </div>
  );
}

function Prose({ text }) {
  // Parse blocks by blank lines; further inspect each block for heading/quote/list/hr.
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  return (
    <>
      {blocks.map((b, bi) => <Block key={bi} text={b} />)}
    </>
  );
}

function Block({ text }) {
  const lines = text.split('\n');
  const first = lines[0].trim();

  // Horizontal rule
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(first) && lines.length === 1) {
    return <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />;
  }

  // Heading
  const h = /^(#{1,4})\s+(.*)$/.exec(first);
  if (h && lines.length === 1) {
    const level = h[1].length;
    const sizes = { 1: 20, 2: 17, 3: 15, 4: 13.5 };
    const Tag = `h${level}`;
    return (
      <Tag style={{ fontSize: sizes[level], fontWeight: 600, margin: '14px 0 6px', color: '#f4f4f4' }}>
        {renderInline(h[2])}
      </Tag>
    );
  }

  // Blockquote
  if (lines.every((l) => /^>\s?/.test(l))) {
    const body = lines.map((l) => l.replace(/^>\s?/, '')).join('\n');
    return (
      <blockquote className="rich-quote">
        {body.split('\n').map((l, i) => (
          <div key={i}>{renderInline(l)}</div>
        ))}
      </blockquote>
    );
  }

  // Ordered list
  if (lines.every((l) => /^\d+\.\s+/.test(l))) {
    return (
      <ol style={{ margin: '6px 0', paddingLeft: 22 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ margin: '3px 0' }}>
            {renderInline(l.replace(/^\d+\.\s+/, ''))}
          </li>
        ))}
      </ol>
    );
  }

  // Unordered list
  if (lines.every((l) => /^[-*]\s+/.test(l))) {
    return (
      <ul style={{ margin: '6px 0', paddingLeft: 20, listStyle: 'disc' }}>
        {lines.map((l, i) => (
          <li key={i} style={{ margin: '3px 0' }}>
            {renderInline(l.replace(/^[-*]\s+/, ''))}
          </li>
        ))}
      </ul>
    );
  }

  // Regular paragraph (may contain soft line breaks)
  return (
    <p style={{ margin: '6px 0' }}>
      {lines.map((l, i) => (
        <React.Fragment key={i}>
          {renderInline(l)}
          {i < lines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </p>
  );
}

Object.assign(window, { RichText });
