/**
 * claude-md-writer.mjs — Pipeline v2 Phase 3-C Epic 5 (2026-05-20).
 *
 * Section-aware write helper for the project's CLAUDE.md. The
 * boilerplate template (`CLAUDE_MD_TEMPLATE` in `boilerplates/registry.ts`)
 * ships with section headings + HTML-comment placeholders. This module
 * fills them in idempotently as the project evolves.
 *
 * v2.5 §41.2 — who writes what:
 *   ## What this is              — PM at project init (one paragraph)
 *   ## Architecture decisions    — DEV on milestone-story completion (append)
 *   ## Constraints discovered    — any agent (append)
 *   ## Patterns to use           — REFLECTOR only (Epic 6)
 *   ## Patterns to avoid         — REFLECTOR only (Epic 6)
 *   ## Domain glossary           — PM seeds, all agents append
 *   ## Skills loaded by default  — REFLECTOR (Epic 6)
 *   ## AWS scoping reminder      — from boilerplate
 *   ## Known issues              — REFLECTOR (Epic 6)
 *
 * v1 (this commit) covers the two highest-value writers:
 *   - seedWhatThisIs() — PM call from pm-plan.mjs after intent decomposition
 *   - appendArchitectureDecision() — story-pipeline call from compile-knowledge
 *     when story carries milestone marker
 *
 * Idempotency: each writer is keyed by content. seedWhatThisIs is a no-op
 * when the section is already populated. appendArchitectureDecision is
 * keyed by storyId so re-running a story doesn't duplicate the entry.
 *
 * All writers emit a structured forensic event via the injected pushEvent
 * so observers see CLAUDE.md sha churn during a plan.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Locate a section in CLAUDE.md by its `## <Title>` header. Returns the
 * line index ranges:
 *
 *   - headerLine: 0-based index of the `## Title` line
 *   - bodyStart:  first line index AFTER the header
 *   - bodyEnd:    last line index of the body (the line BEFORE the next
 *                 `## ` or `# ` heading, or the last line if none)
 *
 * Returns null when the section heading isn't found — the caller should
 * fail soft (CLAUDE.md may have been hand-edited to drop the section).
 *
 * @param {string[]} lines
 * @param {string} title  — case-insensitive match on `## <title>`
 */
export function locateSection(lines, title) {
  const want = title.trim().toLowerCase();
  let headerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('## ')) continue;
    const heading = line.slice(3).trim().toLowerCase();
    if (heading === want) {
      headerLine = i;
      break;
    }
  }
  if (headerLine === -1) return null;

  let bodyEnd = lines.length - 1;
  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ') || line.startsWith('# ')) {
      bodyEnd = i - 1;
      break;
    }
  }
  return { headerLine, bodyStart: headerLine + 1, bodyEnd };
}

/**
 * Return the trimmed body text of a section, stripping the leading
 * HTML-comment placeholders the boilerplate ships with. Returns '' when
 * the section body is empty (only placeholders / whitespace).
 */
export function sectionBody(lines, range) {
  if (!range) return '';
  const slice = lines.slice(range.bodyStart, range.bodyEnd + 1);
  const stripped = slice
    .map((l) => l.replace(/<!--[\s\S]*?-->/g, '').trim())
    .filter((l) => l.length > 0)
    .join('\n');
  return stripped.trim();
}

function readClaudeMd(workingDir) {
  const path = join(workingDir, 'CLAUDE.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function writeClaudeMd(workingDir, content) {
  writeFileSync(join(workingDir, 'CLAUDE.md'), content, 'utf-8');
}

function sha(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * PM agent's first write at project init. Replaces the placeholder body
 * of `## What this is` with a one-paragraph summary derived from the
 * project intent.
 *
 * Idempotent: returns `{ written: false, reason: 'already-populated' }`
 * when the section already has non-placeholder content. PM gets one
 * canonical "What this is" — subsequent edits go through Reflection Inbox.
 *
 * @param {{
 *   workingDir: string,
 *   purpose: string,
 *   onEvent?: (eventType: string, payload: object) => Promise<void>,
 * }} args
 * @returns {Promise<{
 *   written: boolean,
 *   reason?: string,
 *   newSha?: string,
 *   sizeBytes?: number,
 * }>}
 */
export async function seedWhatThisIs({ workingDir, purpose, onEvent }) {
  if (!workingDir) throw new Error('seedWhatThisIs: workingDir required');
  if (typeof purpose !== 'string' || purpose.trim().length === 0) {
    throw new Error('seedWhatThisIs: purpose required');
  }

  const content = readClaudeMd(workingDir);
  if (content === null) {
    return { written: false, reason: 'claude-md-missing' };
  }

  const lines = content.split('\n');
  const range = locateSection(lines, 'What this is');
  if (!range) {
    return { written: false, reason: 'section-missing' };
  }

  const existing = sectionBody(lines, range);
  if (existing.length > 0) {
    return { written: false, reason: 'already-populated' };
  }

  // Replace body with the purpose paragraph. Keep one blank line after
  // the header for readability.
  const before = lines.slice(0, range.headerLine + 1);
  const after = lines.slice(range.bodyEnd + 1);
  const newBody = ['', purpose.trim(), ''];
  const merged = [...before, ...newBody, ...after].join('\n');
  writeClaudeMd(workingDir, merged);

  const newSha = sha(merged);
  await onEvent?.('claude_md_updated', {
    section: 'What this is',
    writer: 'PM',
    newSha,
    sizeBytes: merged.length,
  });
  return { written: true, newSha, sizeBytes: merged.length };
}

/**
 * DEV agent appends to `## Architecture decisions` on milestone-story
 * completion. The boilerplate template specifies append-only here per
 * v2.5 §41.2 — past entries are immutable; superseding decisions go
 * BELOW, never edit-in-place.
 *
 * Idempotency: keyed by `<storyId> + <isoDate>`. Re-running the same
 * story on the same day is a no-op.
 *
 * @param {{
 *   workingDir: string,
 *   storyId: string,
 *   decision: string,    — one-line decision summary
 *   rationale: string,   — one-line rationale
 *   storyTitle?: string,
 *   isoDate?: string,    — defaults to today
 *   onEvent?: (eventType: string, payload: object) => Promise<void>,
 * }} args
 */
export async function appendArchitectureDecision({
  workingDir,
  storyId,
  decision,
  rationale,
  storyTitle,
  isoDate,
  onEvent,
}) {
  if (!workingDir) throw new Error('appendArchitectureDecision: workingDir required');
  if (typeof storyId !== 'string' || storyId.length === 0) {
    throw new Error('appendArchitectureDecision: storyId required');
  }
  if (typeof decision !== 'string' || decision.trim().length === 0) {
    throw new Error('appendArchitectureDecision: decision required');
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new Error('appendArchitectureDecision: rationale required');
  }

  const content = readClaudeMd(workingDir);
  if (content === null) {
    return { written: false, reason: 'claude-md-missing' };
  }
  const lines = content.split('\n');
  const range = locateSection(lines, 'Architecture decisions');
  if (!range) {
    return { written: false, reason: 'section-missing' };
  }

  const date = isoDate ?? new Date().toISOString().slice(0, 10);
  const idempotencyKey = `<!-- story:${storyId} date:${date} -->`;
  if (content.includes(idempotencyKey)) {
    return { written: false, reason: 'idempotent-dup' };
  }

  // Format the entry per v2.5 §41.2: date — decision — rationale — proposed by.
  const title = storyTitle ? ` (${storyTitle.replace(/\)|\n/g, '').slice(0, 80)})` : '';
  const entry = [
    idempotencyKey,
    `- **${date}** — ${decision.trim()} — *Rationale:* ${rationale.trim()} — *Agent:* DEV @story \`${storyId}\`${title}`,
    '',
  ].join('\n');

  // Insert at the END of the section body (preserves chronological
  // append-only order per v2.5 §41.2). Strip any trailing blank lines
  // INSIDE the section first so the new entry sits flush.
  const before = lines.slice(0, range.bodyEnd + 1);
  const after = lines.slice(range.bodyEnd + 1);

  // Trim trailing blank lines from `before` (within this section).
  let cut = before.length;
  while (cut > range.bodyStart && before[cut - 1].trim() === '') {
    cut -= 1;
  }
  const trimmedBefore = before.slice(0, cut);

  const merged = [...trimmedBefore, '', entry, ...after].join('\n');
  writeClaudeMd(workingDir, merged);

  const newSha = sha(merged);
  await onEvent?.('claude_md_updated', {
    section: 'Architecture decisions',
    writer: 'DEV',
    storyId,
    newSha,
    sizeBytes: merged.length,
  });
  return { written: true, newSha, sizeBytes: merged.length };
}
