'use client';

import { useMemo } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

/**
 * Plain-text textarea editor for `KEY=VALUE` env-var lines. Validates as
 * the user types: blank lines + `# comment` lines ignored; otherwise
 * each line must split on the first `=` into UPPER_SNAKE_CASE key + a
 * value (any chars OK, optionally quoted with `"..."`).
 *
 * Quotes around values are stripped on parse so the user can paste
 * either `KEY=foo bar` or `KEY="foo bar"` interchangeably. The
 * server-side render reapplies quoting before writing `<projectPath>/.env`.
 *
 * Reports errors via `onValidityChange` so the parent wizard can
 * gate the Submit button.
 */

const KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export interface ParsedEnvLine {
  key: string;
  value: string;
}

export interface ParseResult {
  vars: Record<string, string>;
  errors: { line: number; message: string }[];
  count: number;
}

export function parseEnvText(text: string): ParseResult {
  const vars: Record<string, string> = {};
  const errors: { line: number; message: string }[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;
    const eqIdx = raw.indexOf('=');
    if (eqIdx === -1) {
      errors.push({ line: i + 1, message: 'missing "="' });
      continue;
    }
    const key = raw.slice(0, eqIdx).trim();
    let value = raw.slice(eqIdx + 1).trim();
    if (!KEY_REGEX.test(key)) {
      errors.push({ line: i + 1, message: `invalid key "${key}" — must be UPPER_SNAKE_CASE` });
      continue;
    }
    // Strip surrounding double quotes (dotenv convention).
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (vars[key] !== undefined) {
      errors.push({ line: i + 1, message: `duplicate key "${key}"` });
    }
    vars[key] = value;
  }
  return { vars, errors, count: Object.keys(vars).length };
}

interface EnvVarEditorProps {
  value: string;
  onChange: (text: string) => void;
  onValidityChange?: (parse: ParseResult) => void;
  rows?: number;
  helperText?: string;
}

export function EnvVarEditor({
  value,
  onChange,
  onValidityChange,
  rows = 8,
  helperText,
}: EnvVarEditorProps) {
  const parse = useMemo(() => parseEnvText(value), [value]);
  // Surface validity to parent on every change.
  if (onValidityChange) onValidityChange(parse);

  return (
    <div className="space-y-1">
      <Label htmlFor="env-var-editor">
        Environment variables{parse.count > 0 ? ` (${parse.count})` : ''}
      </Label>
      <Textarea
        id="env-var-editor"
        data-testid="env-var-editor"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`# One KEY=value per line. Lines starting with # are comments.\nOPENAI_API_KEY="sk-..."\nLINKEDIN_API_KEY="li-..."`}
        className="font-mono text-[12px]"
        aria-invalid={parse.errors.length > 0 ? 'true' : undefined}
      />
      {helperText && <p className="text-[10.5px] text-muted-foreground">{helperText}</p>}
      {parse.errors.length > 0 && (
        <ul className="text-[11px] text-red-400">
          {parse.errors.map((e) => (
            <li key={`${e.line}-${e.message}`}>
              line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
