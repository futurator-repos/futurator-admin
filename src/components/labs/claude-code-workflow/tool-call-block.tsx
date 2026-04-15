'use client';
import { useState } from 'react';

interface ToolCallBlockProps {
  name: string;
  input?: string;
  output?: string;
}

const TOOL_ICONS: Record<string, string> = {
  Read: '\u{1F4C4}',
  Edit: '\u{270F}\u{FE0F}',
  Write: '\u{1F4DD}',
  Bash: '\u{2B1B}',
  Grep: '\u{1F50D}',
  Glob: '\u{1F4C2}',
  Agent: '\u{1F916}',
};

function parseSummary(name: string, input?: string): string {
  if (!input) return name;
  try {
    const parsed = JSON.parse(input);
    return parsed.file_path || parsed.command || parsed.pattern || parsed.path || name;
  } catch {
    return input.slice(0, 60);
  }
}

export function ToolCallBlock({ name, input, output }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[name] || '\u{1F527}';
  const summary = parseSummary(name, input);

  return (
    <div className="border-l-2 border-blue-300 pl-3 dark:border-blue-700">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-mono text-blue-700 hover:underline dark:text-blue-400"
      >
        <span>{icon}</span>
        <span>
          {name}(<span className="max-w-[400px] truncate inline-block align-bottom">{summary}</span>
          )
        </span>
        <span className="text-muted-foreground">{expanded ? '\u25BC' : '\u25B6'}</span>
      </button>

      {expanded && output && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-900 p-2 text-[11px] text-gray-100">
          {output}
        </pre>
      )}
    </div>
  );
}
