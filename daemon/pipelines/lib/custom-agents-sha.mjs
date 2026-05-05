/**
 * Compute a stable SHA256 hex of the custom-agent source tree. Used to detect
 * drift between a project's installed `bmad/agents/` and the admin repo's
 * source of truth.
 *
 * Stable = sorted-concat of file path + file content so rename/reorder is
 * observable, not just content mutation.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function computeCustomAgentsSHA(agentsDir) {
  const files = collectMarkdownFiles(agentsDir);
  files.sort();
  const hash = createHash('sha256');
  for (const f of files) {
    const rel = relative(agentsDir, f).split('\\').join('/');
    hash.update(`\n--- ${rel} ---\n`);
    hash.update(readFileSync(f));
  }
  return hash.digest('hex');
}

function collectMarkdownFiles(dir) {
  const out = [];
  walk(dir, (p) => {
    if (p.endsWith('.md') && !p.endsWith('.source.md')) out.push(p);
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
    if (s.isDirectory()) walk(full, visit);
    else if (s.isFile()) visit(full);
  }
}
