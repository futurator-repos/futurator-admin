import type { AgentEvent } from '../types/agent-orchestrator';

/**
 * Flat-log renderer (Observability Spine §8).
 *
 * Produces a plain-text, one-line-per-event rendering that can be pasted
 * into a chat and reasoned about without tooling. Hierarchical correlation
 * prefix makes grep/filter trivially easy:
 *
 *   {timestamp} {epicId}/wave-{N|-}/{storyId|-}/{role|-}/{attempt|-}/{eventType} k=v k=v
 *     multi-line payload field
 *     indents under parent
 */

const INLINE_PAYLOAD_KEYS = [
  'storyId',
  'role',
  'attempt',
  'status',
  'verdict',
  'reason',
  'exit',
  'durationMs',
  'tier',
  'count',
  'outcome',
] as const;

const MULTILINE_PAYLOAD_KEYS = ['findings', 'reasoning', 'diff', 'summary', 'rationale'] as const;

export interface RenderOpts {
  includeTimestamp?: boolean; // default true
}

export function renderFlatLog(events: AgentEvent[], opts: RenderOpts = {}): string {
  const includeTs = opts.includeTimestamp !== false;
  const lines: string[] = [];
  for (const e of events) {
    const prefix = composePrefix(e);
    const inline = renderInline(e);
    const head = [includeTs ? e.timestamp : null, prefix, inline].filter(Boolean).join(' ');
    lines.push(head);
    for (const block of renderMultiline(e)) lines.push(block);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function composePrefix(e: AgentEvent): string {
  const epic = e.epicId || '-';
  const wave = typeof e.waveNumber === 'number' ? `wave-${e.waveNumber}` : '-';
  const story = e.storyId || '-';
  const role = e.role || '-';
  const attempt = typeof e.attempt === 'number' ? String(e.attempt) : '-';
  return `${epic}/${wave}/${story}/${role}/${attempt}/${e.eventType}`;
}

function renderInline(e: AgentEvent): string {
  const parts: string[] = [];
  const payload = (e.payload || {}) as Record<string, unknown>;

  for (const key of INLINE_PAYLOAD_KEYS) {
    const v = (payload as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    const rendered = typeof v === 'string' ? truncate(v, 120) : String(v);
    parts.push(`${key}=${escapeInline(rendered)}`);
  }

  // Top-level scalar fields that carry meaning for common events
  if (typeof e.text === 'string' && e.text.trim().length > 0 && !hasMultiline(e)) {
    parts.push(`text=${escapeInline(truncate(e.text.trim(), 120))}`);
  }
  if (e.toolName) parts.push(`tool=${e.toolName}`);
  if (typeof e.cost === 'number' && e.cost > 0) parts.push(`cost=${e.cost.toFixed(4)}`);
  if (typeof e.durationMs === 'number') parts.push(`durationMs=${e.durationMs}`);
  if (e.validationPassed !== undefined) parts.push(`pass=${e.validationPassed}`);

  return parts.join(' ');
}

function renderMultiline(e: AgentEvent): string[] {
  const out: string[] = [];
  const payload = (e.payload || {}) as Record<string, unknown>;
  for (const key of MULTILINE_PAYLOAD_KEYS) {
    const v = payload[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    const normalized = v.replace(/\r\n/g, '\n');
    if (!normalized.includes('\n') && normalized.length <= 120) continue;
    out.push(`  ${key}:`);
    for (const line of normalized.split('\n')) out.push(`    ${line}`);
  }
  return out;
}

function hasMultiline(e: AgentEvent): boolean {
  const payload = (e.payload || {}) as Record<string, unknown>;
  return MULTILINE_PAYLOAD_KEYS.some((k) => typeof payload[k] === 'string');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function escapeInline(s: string): string {
  const normalized = s.replace(/\r?\n/g, ' ').trim();
  if (/\s/.test(normalized)) return `"${normalized.replace(/"/g, '\\"')}"`;
  return normalized;
}

export interface FlatLogFilter {
  since?: string;
  role?: string;
  storyId?: string;
  wave?: number;
  limit?: number;
}

export function filterEvents(events: AgentEvent[], filter: FlatLogFilter): AgentEvent[] {
  let out = events;
  if (filter.since) {
    out = out.filter((e) => e.timestamp >= filter.since!);
  }
  if (filter.role) {
    out = out.filter((e) => e.role === filter.role);
  }
  if (filter.storyId) {
    out = out.filter((e) => e.storyId === filter.storyId);
  }
  if (typeof filter.wave === 'number') {
    out = out.filter((e) => e.waveNumber === filter.wave);
  }
  if (typeof filter.limit === 'number' && filter.limit > 0) {
    out = out.slice(0, filter.limit);
  }
  return out;
}
