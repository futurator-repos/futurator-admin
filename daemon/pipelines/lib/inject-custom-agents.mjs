/**
 * Inject our 8 custom agents (Ludwig, Rick, Pedrock, Dave ups!, Sean Tinel,
 * Nimbus, Kube Rick, Sue Render) into a BMAD 6.3.x-generated manifest so
 * Party Mode's roster sees them alongside the stock agents.
 *
 * Path 3b from `docs/concepts/party-module-implementation.md §15`.
 *
 * Input:
 *   sourceDir    — /home/ubuntu/bmad-agents-source/bmad/agents/ (subdirs per agent)
 *   manifestPath — <projectPath>/_bmad/_config/agent-manifest.csv (6.3.x layout)
 *
 * For each `<slug>/<slug>.md` in sourceDir:
 *   1. Parse the first <agent ...> attributes (name, title, icon)
 *   2. Parse <role>, <identity>, <communication_style>, <principles> tags
 *   3. Flatten multi-line fields to single-line (CSV round-trip safety)
 *   4. Emit a row with module='agents', path='_bmad/agents-custom/<slug>'
 *
 * Idempotent: existing rows in the manifest whose `name` column matches an
 * injected slug are REPLACED (not duplicated). Safe to re-run on every bootstrap.
 *
 * Returns { injected: number, total: number } where total is the final row count.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _internals, quoteField } from './rebuild-manifest.mjs';

const FALLBACK_COLUMNS = [
  'name',
  'displayName',
  'title',
  'icon',
  'role',
  'identity',
  'communicationStyle',
  'principles',
  'module',
  'path',
];

export async function injectCustomAgents({ sourceDir, manifestPath, onOutput }) {
  if (!sourceDir || !existsSync(sourceDir)) {
    onOutput?.({ stream: 'stdout', data: `source dir not present (${sourceDir}) — skipping` });
    return { injected: 0, total: countRows(manifestPath) };
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`inject-custom-agents: manifest not found at ${manifestPath}`);
  }

  const slugs = readdirSync(sourceDir)
    .map((name) => ({ name, full: join(sourceDir, name) }))
    .filter(({ full }) => {
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .map(({ name }) => name)
    .sort();

  const injected = [];
  for (const slug of slugs) {
    const mdPath = join(sourceDir, slug, `${slug}.md`);
    if (!existsSync(mdPath)) {
      onOutput?.({ stream: 'stderr', data: `no ${slug}.md in source — skipping` });
      continue;
    }
    const row = parseAgentFile(mdPath, slug);
    if (!row) {
      onOutput?.({ stream: 'stderr', data: `no <agent> block in ${slug}.md — skipping` });
      continue;
    }
    injected.push(row);
    onOutput?.({ stream: 'stdout', data: `injected ${slug} (${row.displayName})` });
  }

  if (injected.length === 0) {
    return { injected: 0, total: countRows(manifestPath) };
  }

  const raw = readFileSync(manifestPath, 'utf8');
  const { header, rows } = parseCsv(raw);
  const columns = header.length > 0 ? header : FALLBACK_COLUMNS;

  const injectSlugs = new Set(injected.map((r) => r.name));
  const kept = rows.filter((r) => !injectSlugs.has(r.name));
  const allRows = [...kept, ...injected];

  const csv = serialize(allRows, columns);
  writeFileSync(manifestPath, csv, 'utf8');

  return { injected: injected.length, total: allRows.length };
}

function parseAgentFile(filePath, slug) {
  const content = readFileSync(filePath, 'utf8');
  const attrs = _internals.extractAgentAttrs(content);
  if (!attrs || !attrs.name) return null;
  return {
    name: slug,
    displayName: attrs.name,
    title: attrs.title || '',
    icon: attrs.icon || '',
    role: flatten(_internals.extractTag(content, 'role')),
    identity: flatten(_internals.extractTag(content, 'identity')),
    communicationStyle: flatten(
      _internals.extractTag(content, 'communication_style') ??
        _internals.extractTag(content, 'communicationStyle'),
    ),
    principles: flatten(_internals.extractTag(content, 'principles')),
    module: 'agents',
    path: `_bmad/agents-custom/${slug}`,
  };
}

/**
 * Flatten any multi-line field to a single line — replace newline runs with a
 * space and collapse repeated whitespace. Keeps the manifest single-line per
 * record to match BMAD 6.3.x's style and avoid the need for a multi-line-aware
 * parser downstream.
 */
function flatten(text) {
  if (text == null) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

function countRows(manifestPath) {
  if (!existsSync(manifestPath)) return 0;
  const { rows } = parseCsv(readFileSync(manifestPath, 'utf8'));
  return rows.length;
}

/**
 * Minimal RFC-4180 CSV reader that handles quoted fields with embedded quotes
 * and commas. Assumes single-line records (matches BMAD's style). Empty lines
 * are ignored.
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const values = parseLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = values[i] ?? '';
    }
    return obj;
  });
  return { header, rows };
}

function parseLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function serialize(rows, columns) {
  const header = columns.join(',');
  const body = rows
    .map((r) => columns.map((c) => quoteField(String(r[c] ?? ''))).join(','))
    .join('\n');
  return rows.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
}

export const _internalsForTest = { parseAgentFile, flatten, parseCsv, serialize };
