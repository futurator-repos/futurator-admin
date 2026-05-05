/**
 * Rebuild bmad/_cfg/agent-manifest.csv from the on-disk bmad/ tree.
 *
 * BMAD ships no public script for this. Custom agents live under
 * bmad/agents/<name>/<name>.md alongside stock agents from BMM/CIS/BMB/core
 * modules. After every per-project install + custom-agent rsync we must
 * regenerate the manifest so Party Mode sees the full roster.
 *
 * Output schema (column order fixed, RFC 4180 quoting):
 *   name, displayName, title, icon, role, identity,
 *   communicationStyle, principles, module, path
 *
 * Row order: core → bmb → bmm → cis → agents (stable, alphabetic within
 * module by file path).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const COLUMNS = [
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

const MODULE_ORDER = ['core', 'bmb', 'bmm', 'cis', 'agents'];

export async function rebuildManifest(bmadRoot) {
  const files = findAgentFiles(bmadRoot);
  const rows = files.map((file) => parseAgentFile(file, bmadRoot)).filter(Boolean);
  rows.sort(compareRows);
  const csv = toCsv(rows);
  const outPath = join(bmadRoot, '_cfg', 'agent-manifest.csv');
  writeFileSync(outPath, csv, 'utf8');
  return rows.length;
}

function findAgentFiles(bmadRoot) {
  const out = [];
  walk(bmadRoot, (p) => {
    if (!p.endsWith('.md')) return;
    if (p.endsWith('.source.md')) return;
    if (p.endsWith('.customize.yaml')) return;
    // Only files under an /agents/ directory.
    if (!/[\\/]agents[\\/]/.test(p)) return;
    out.push(p);
  });
  return out;
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, visit);
    } else if (s.isFile()) {
      visit(full);
    }
  }
}

function parseAgentFile(filePath, bmadRoot) {
  const content = readFileSync(filePath, 'utf8');

  const agentAttrs = extractAgentAttrs(content);
  if (!agentAttrs || !agentAttrs.name) return null;

  const persona = {
    role: extractTag(content, 'role') ?? '',
    identity: extractTag(content, 'identity') ?? '',
    communicationStyle:
      extractTag(content, 'communication_style') ??
      extractTag(content, 'communicationStyle') ??
      '',
    principles: extractTag(content, 'principles') ?? '',
  };

  const moduleName = deriveModule(filePath, bmadRoot);
  const relPath = relative(bmadRoot, filePath).split('\\').join('/');

  return {
    name: agentAttrs.name,
    displayName: agentAttrs.displayName || agentAttrs.name,
    title: agentAttrs.title || '',
    icon: agentAttrs.icon || '',
    role: persona.role,
    identity: persona.identity,
    communicationStyle: persona.communicationStyle,
    principles: persona.principles,
    module: moduleName,
    path: `bmad/${relPath}`,
  };
}

/**
 * Extract attributes from the first `<agent ...>` block. Supports single and
 * double quotes around values.
 */
function extractAgentAttrs(content) {
  const open = content.match(/<agent\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1];
  return {
    name: attrValue(attrs, 'name'),
    title: attrValue(attrs, 'title'),
    icon: attrValue(attrs, 'icon'),
    displayName: attrValue(attrs, 'displayName') || attrValue(attrs, 'name'),
  };
}

function attrValue(attrs, key) {
  const m = attrs.match(new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? m[1] ?? m[2] : undefined;
}

/**
 * Extract inner text of the first `<tagName>...</tagName>` block. Returns
 * trimmed content or null when the tag is absent.
 */
function extractTag(content, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = content.match(re);
  if (!m) return null;
  return m[1].trim();
}

function deriveModule(filePath, bmadRoot) {
  const rel = relative(bmadRoot, filePath).split('\\').join('/');
  const first = rel.split('/')[0];
  if (['core', 'bmb', 'bmm', 'cis'].includes(first)) return first;
  if (first === 'agents') return 'agents';
  return 'agents';
}

function compareRows(a, b) {
  const ia = MODULE_ORDER.indexOf(a.module);
  const ib = MODULE_ORDER.indexOf(b.module);
  const ra = ia === -1 ? MODULE_ORDER.length : ia;
  const rb = ib === -1 ? MODULE_ORDER.length : ib;
  if (ra !== rb) return ra - rb;
  return a.path.localeCompare(b.path);
}

/**
 * Serialize rows to RFC 4180 CSV. Every field is quoted; internal `"` is
 * doubled; newlines and commas inside fields are preserved verbatim between
 * the outer quotes.
 */
export function toCsv(rows) {
  const header = COLUMNS.join(',');
  const body = rows
    .map((r) =>
      COLUMNS.map((col) => quoteField(String(r[col] ?? ''))).join(','),
    )
    .join('\n');
  return rows.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
}

export function quoteField(v) {
  const escaped = v.replace(/"/g, '""');
  return `"${escaped}"`;
}

// Re-exported for unit tests.
export const _internals = {
  extractAgentAttrs,
  extractTag,
  attrValue,
  deriveModule,
  compareRows,
  toCsv,
  quoteField,
  findAgentFiles,
};
