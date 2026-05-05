/**
 * Party Mode turn parser
 *
 * Splits a Claude assistant text stream into typed blocks:
 *   - intro:  free-form preamble before the first marker (BMad Master welcome)
 *   - agent:  one per agent contribution
 *   - system: orchestrator notes / closing remarks
 *
 * Two parser strategies, tried in order:
 *
 *   1. Marker-based — the new contract injected via --append-system-prompt
 *      in `daemon/pipelines/party-turn.mjs`. Looks for `⟪AGENT:Name⟫` and
 *      `⟪SYSTEM⟫` lines. Fast, unambiguous, no false positives.
 *
 *   2. Legacy fallback — used when no markers are present (i.e. session was
 *      started before the contract shipped). Splits on `^[emoji ]\*\*Name:\*\*`
 *      lines but ONLY accepts `Name` if it matches the canonical roster.
 *      This rejects false positives like `**My hot take:**` and
 *      `**Orchestrator Note:**` that the old parser misread as agents.
 *
 * Both strategies emit the same Block[] shape so callers don't care which
 * one ran. See `docs/concepts/party-mode/party-mode-output-format.md` for
 * full design context, real examples, and failure modes of the old parser.
 */

import { agentIdentity } from './agent-identity';

export type PartyBlockKind = 'intro' | 'agent' | 'system';

export interface PartyBlock {
  kind: PartyBlockKind;
  /** Speaker name for `kind === 'agent'`; null for intro/system. */
  speaker: string | null;
  /** Markdown body. May be empty while a block is mid-stream. */
  text: string;
}

/**
 * Canonical roster — the same 23 names listed in the format contract.
 * Used to validate `**Name:**` candidates in the legacy fallback. Lowercased
 * for case-insensitive lookup, but display-cased values come from this map.
 */
export const ROSTER_NAMES = [
  'BMad Master',
  'BMad Builder',
  'Mary',
  'John',
  'Sally',
  'Winston',
  'Amelia',
  'Paige',
  'Bob',
  'Murat',
  'Carson',
  'Dr. Quinn',
  'Maya',
  'Victor',
  'Sophia',
  'Ludwig',
  'Pedrock',
  'Dave ups!',
  'Sean Tinel',
  'Nimbus',
  'Kube Rick',
  'Sue Render',
  'Rick',
] as const;

const ROSTER_LOOKUP: Map<string, string> = new Map(
  ROSTER_NAMES.map((n) => [n.toLowerCase(), n]),
);

/**
 * Global marker matcher. Captures the marker AND its name (if AGENT).
 * Used for splitting the merged stream regardless of where the marker sits
 * relative to surrounding text (Claude doesn't always put markers on their
 * own line — sometimes glues `⟪AGENT:Name⟫` to the end of the previous
 * paragraph with no newline before it). The split-based approach handles
 * both clean marker-on-own-line and inline cases.
 */
const GLOBAL_MARKER_RE = /⟪(AGENT:([^⟫\n]+)|SYSTEM)⟫/g;

/** Quick presence check for any marker. */
const HAS_ANY_MARKER_RE = /⟪(?:AGENT:[^⟫\n]+|SYSTEM)⟫/;

/** Legacy header: optional emoji + `**Name:**` at start of line. */
const LEGACY_HEADER_RE = /^[\p{Extended_Pictographic}\u200d\uFE0F\s]*\*\*([^:*\n]{1,40}):\*\*\s*$/u;

/**
 * Resolve a raw `Name` (either from a marker or a `**Name:**` legacy header)
 * to a canonical roster name. Returns null if the name isn't on the roster.
 *
 * Trims, lowercases, and tolerates trailing punctuation/whitespace.
 */
export function resolveRosterName(raw: string): string | null {
  const cleaned = raw.trim().replace(/[.,;:]+$/, '');
  return ROSTER_LOOKUP.get(cleaned.toLowerCase()) ?? null;
}

/**
 * Strip the BMad Master welcome roster table from intro text. The contract
 * tells Claude to skip it, but legacy turns and partial compliance still
 * print it. Drops the markdown table block entirely (header + rows).
 */
function stripRosterTable(intro: string): string {
  // A markdown table starts with `| Icon | Name | Role |`-ish header and
  // has at least one separator row. Greedy-match a contiguous run of pipe
  // lines.
  return intro
    .replace(/^\|[^\n]*\|\s*\n\|[-:|\s]+\|\s*\n(?:\|[^\n]*\|\s*\n?)+/gm, '')
    .trim();
}

/* ────────── Marker-based parser (preferred) ────────── */

/**
 * Find every marker in the text, regardless of whether it sits on its own
 * line or is glued to surrounding content. Returns positions and the
 * captured marker info, in source order. We deliberately scan the WHOLE
 * string instead of line-by-line because real Claude output sometimes
 * writes `...analysis.⟪AGENT:Winston⟫` (no newline before the marker) —
 * a strict line-anchored regex would miss those and silently swallow the
 * agent's content into the previous block.
 */
interface MarkerHit {
  /** Index in the source string where the marker starts. */
  start: number;
  /** Index where the text AFTER the marker begins. */
  end: number;
  kind: 'agent' | 'system';
  /** Speaker name for AGENT markers; null for SYSTEM. */
  rawName: string | null;
}

function findMarkers(text: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  GLOBAL_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GLOBAL_MARKER_RE.exec(text)) !== null) {
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: m[1] === 'SYSTEM' ? 'system' : 'agent',
      rawName: m[1] === 'SYSTEM' ? null : (m[2] ?? '').trim(),
    });
  }
  return hits;
}

function parseWithMarkers(text: string): PartyBlock[] {
  const hits = findMarkers(text);
  if (hits.length === 0) return [];

  const blocks: PartyBlock[] = [];

  // Anything BEFORE the first marker is the intro (BMad Master's exploration
  // narration). Strip the roster table if it's there.
  const introRaw = text.slice(0, hits[0].start).trim();
  if (introRaw.length > 0) {
    const stripped = stripRosterTable(introRaw);
    if (stripped) blocks.push({ kind: 'intro', speaker: null, text: stripped });
  }

  // Each marker hit defines a block whose body runs from end-of-marker to
  // start-of-next-marker (or end-of-text for the last one).
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const bodyStart = hit.end;
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].start : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    if (hit.kind === 'system') {
      blocks.push({ kind: 'system', speaker: null, text: body });
    } else {
      const canonical = hit.rawName ? resolveRosterName(hit.rawName) : null;
      // Best-effort: if the name isn't on the canonical roster, still emit
      // the block using the raw name. Fallback initials beat dropping
      // content silently.
      blocks.push({
        kind: 'agent',
        speaker: canonical ?? (hit.rawName || 'Unknown'),
        text: body,
      });
    }
  }
  return blocks;
}

/* ────────── Legacy fallback parser (pre-contract sessions) ────────── */

/**
 * Find legacy headers (`📋 **John:**`) and split on them, but ONLY when the
 * name resolves to a canonical roster member. This rejects:
 *   - `**My hot take:**`  (Sue Render's section header — old bug)
 *   - `**Orchestrator Note:**`  (gets re-tagged as system block)
 *   - Any other `**Foo:**` that's just a markdown emphasis line
 */
function parseLegacy(text: string): PartyBlock[] {
  const blocks: PartyBlock[] = [];
  const lines = text.split('\n');
  let current: PartyBlock | null = null;
  let intro = '';
  let lastBlankLine = true; // first line counts as "after blank"

  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    // Only check for headers at the start of a paragraph (after a blank line)
    // OR at the very first line of the stream — guards against false positives
    // mid-paragraph.
    let matched = false;
    if (lastBlankLine || (current === null && intro === '')) {
      const orchMatch = line.match(/^\s*\*\*Orchestrator Note:\*\*\s*(.*)$/);
      if (orchMatch) {
        if (current) {
          current.text = current.text.trimEnd();
          blocks.push(current);
        } else if (intro.trim().length > 0) {
          const stripped = stripRosterTable(intro);
          if (stripped) blocks.push({ kind: 'intro', speaker: null, text: stripped });
          intro = '';
        }
        current = { kind: 'system', speaker: null, text: orchMatch[1] || '' };
        matched = true;
      } else {
        const m = line.match(LEGACY_HEADER_RE);
        if (m) {
          const canonical = resolveRosterName(m[1]);
          if (canonical) {
            if (current) {
              current.text = current.text.trimEnd();
              blocks.push(current);
            } else if (intro.trim().length > 0) {
              const stripped = stripRosterTable(intro);
              if (stripped) blocks.push({ kind: 'intro', speaker: null, text: stripped });
              intro = '';
            }
            current = { kind: 'agent', speaker: canonical, text: '' };
            matched = true;
          }
        }
      }
    }
    if (!matched) {
      if (current) {
        current.text += (current.text ? '\n' : '') + line;
      } else {
        intro += (intro ? '\n' : '') + line;
      }
    }
    lastBlankLine = isBlank;
  }

  if (current) {
    current.text = current.text.trimEnd();
    blocks.push(current);
  } else if (intro.trim().length > 0) {
    const stripped = stripRosterTable(intro);
    if (stripped) blocks.push({ kind: 'intro', speaker: null, text: stripped });
  }

  // Strip leading horizontal rules + leading emoji from agent bodies that
  // came from `📋 **John:**\n\n[body]` — we already consumed the header line
  // but the agent-only `---` separator rules are still in the body.
  for (const b of blocks) {
    if (b.kind === 'agent' || b.kind === 'system') {
      b.text = b.text.replace(/^\s*---\s*\n+/, '').trimStart();
    }
  }

  return blocks;
}

/* ────────── Public API ────────── */

/**
 * Parse one assistant response into ordered blocks.
 * Picks the strategy automatically based on whether markers are present.
 */
export function parseTurn(text: string): PartyBlock[] {
  if (!text || text.length === 0) return [];
  if (HAS_ANY_MARKER_RE.test(text)) return parseWithMarkers(text);
  return parseLegacy(text);
}

/**
 * Resolve a speaker to its identity (icon, accent, role) — re-exported for
 * convenience so callers don't have to import agent-identity separately.
 */
export { agentIdentity };

/**
 * Concatenate the text of all `party.turn.assistant.token` events into a
 * single string suitable for parseTurn(). Filters out tool-use noise and
 * forward-compat raw events.
 */
export function mergeAssistantTokens(
  events: ReadonlyArray<{ eventType: string; text?: string }>,
): string {
  return events
    .filter((e) => e.eventType === 'party.turn.assistant.token' && typeof e.text === 'string')
    .map((e) => e.text!)
    .join('');
}
