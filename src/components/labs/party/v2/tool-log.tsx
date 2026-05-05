'use client';
import { useState } from 'react';
import {
  ChevronRight,
  FileText,
  Edit3,
  Search,
  Globe,
  Terminal,
  FolderTree,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { COLORS } from './tokens';
import type { ToolCall } from '../turn-adapter';

interface Props {
  tools: ToolCall[];
  /**
   * When true, this round is still streaming and there's no content yet —
   * the tool log expands by default so the user sees something happening.
   * Once content arrives it auto-collapses on the next mount.
   */
  defaultOpen?: boolean;
}

/**
 * Collapsible "Actions" panel that shows what tools the orchestrator (and
 * agents, if they ever delegate) called during a round. Sits inside the
 * orchestrator-open container — same purple styling family, but visually
 * a child of it.
 */
export function ToolLog({ tools, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (tools.length === 0) return null;

  return (
    <div
      className="mt-2 rounded-md border"
      style={{
        background: 'rgba(0,0,0,0.18)',
        borderColor: 'rgba(167,139,250,0.18)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
        style={{ color: COLORS.accentOrchSoft }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(167,139,250,0.06)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <ChevronRight
          className="h-3.5 w-3.5 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <Wrench className="h-3 w-3" />
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: COLORS.accentOrchSoft }}
        >
          Actions
        </span>
        <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
          · {tools.length} tool call{tools.length === 1 ? '' : 's'}
        </span>
        {!open && <ToolBadgeStrip tools={tools} />}
      </button>

      {open && (
        <ul
          className="space-y-0.5 px-3 pb-2 pt-1"
          style={{ borderTop: '1px solid rgba(167,139,250,0.12)' }}
        >
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Inline icons row shown next to the title when collapsed — one per tool kind. */
function ToolBadgeStrip({ tools }: { tools: ToolCall[] }) {
  const kinds = new Map<string, number>();
  for (const t of tools) {
    kinds.set(t.name, (kinds.get(t.name) ?? 0) + 1);
  }
  return (
    <span className="ml-auto flex items-center gap-1.5">
      {Array.from(kinds.entries())
        .slice(0, 5)
        .map(([name, count]) => (
          <span
            key={name}
            className="flex items-center gap-1 rounded px-1.5 py-px text-[10.5px]"
            style={{
              background: 'rgba(167,139,250,0.1)',
              color: COLORS.accentOrchSoft,
            }}
            title={`${count}× ${name}`}
          >
            <ToolIcon name={name} />
            {count}
          </span>
        ))}
    </span>
  );
}

function ToolRow({ tool }: { tool: ToolCall }) {
  const summary = summarizeInput(tool.name, tool.input);
  return (
    <li
      className="flex items-start gap-2 rounded px-1.5 py-1 font-mono text-[11.5px] leading-snug"
      style={{ color: COLORS.textBody }}
    >
      <span className="mt-px shrink-0" style={{ color: COLORS.accentOrchSoft }}>
        <ToolIcon name={tool.name} />
      </span>
      <span className="shrink-0 font-semibold" style={{ color: COLORS.accentOrchSoft }}>
        {tool.name}
      </span>
      <span className="min-w-0 flex-1 truncate" title={summary} style={{ color: COLORS.textMuted }}>
        {summary}
      </span>
    </li>
  );
}

function ToolIcon({ name }: { name: string }) {
  const cls = 'h-3 w-3';
  switch (name) {
    case 'Read':
      return <FileText className={cls} />;
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return <Edit3 className={cls} />;
    case 'Grep':
      return <Search className={cls} />;
    case 'Glob':
    case 'LS':
      return <FolderTree className={cls} />;
    case 'Bash':
      return <Terminal className={cls} />;
    case 'WebFetch':
    case 'WebSearch':
      return <Globe className={cls} />;
    case 'Skill':
    case 'Agent':
    case 'Task':
      return <Sparkles className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

/**
 * Build a one-line human-readable summary of a tool's input. We pick the
 * single most informative field per tool so the row stays scannable.
 */
function summarizeInput(name: string, input: Record<string, unknown>): string {
  const s = (k: string): string =>
    typeof input[k] === 'string' ? (input[k] as string) : '';
  switch (name) {
    case 'Read':
      return shortenPath(s('file_path'));
    case 'Write':
    case 'Edit':
      return shortenPath(s('file_path'));
    case 'Grep': {
      const path = s('path') || s('glob') || '.';
      return `${quote(s('pattern'))} in ${shortenPath(path)}`;
    }
    case 'Glob':
      return s('pattern') || '';
    case 'Bash': {
      const desc = s('description');
      const cmd = s('command');
      return desc ? `${desc} — ${cmd}` : cmd;
    }
    case 'WebFetch':
      return s('url');
    case 'WebSearch':
      return s('query');
    case 'Skill':
      return s('skill') || s('command') || '';
    case 'Task':
    case 'Agent':
      return s('description') || s('subagent_type') || '';
    default: {
      // Fallback: print the first string value we find.
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === 'string' && v.length > 0) return `${k}=${v}`;
      }
      return '';
    }
  }
}

function shortenPath(p: string): string {
  if (!p) return '';
  // Drop noisy /home/ubuntu/projects/<slug>/ prefix so paths read as
  // project-relative.
  const m = p.match(/^\/home\/ubuntu\/projects\/[^/]+\/(.+)$/);
  return m ? m[1] : p;
}

function quote(s: string): string {
  if (!s) return '""';
  return `"${s.length > 60 ? s.slice(0, 60) + '…' : s}"`;
}
