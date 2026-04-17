/**
 * Codebase-index builder (Touch-Point Inference §4).
 *
 * Returns a compressed markdown codebase map used as context for Haiku
 * during touch-point inference. Primary source is Mycelium's
 * `knowledge/code/*.md` articles; falls back to a lightweight directory
 * walk when the knowledge dir is absent or empty.
 *
 * Result is cached at `{workingDir}/.futurator/codebase-index-{sha}.md`
 * keyed by short git SHA — invalidated automatically on commit.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_MAX_BYTES = 8 * 1024;
const FALLBACK_EXT_WHITELIST = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
]);
const FALLBACK_DIRS = ['src', 'functions', 'daemon', 'app', 'lib'];
const FALLBACK_EXCLUDED = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '__tests__', 'tests', '.mycelium', '.futurator', 'knowledge',
]);

/**
 * @param {string} workingDir  Absolute path to the project root.
 * @param {{ maxBytes?: number, cache?: boolean, logger?: Console }} [opts]
 * @returns {Promise<string>} Markdown codebase index.
 */
export async function buildCodebaseIndex(workingDir, opts = {}) {
  if (!workingDir) throw new Error('buildCodebaseIndex: workingDir is required');
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const useCache = opts.cache !== false;
  const logger = opts.logger;

  const sha = safeGitSha(workingDir);
  const cachePath = sha
    ? join(workingDir, '.futurator', `codebase-index-${sha}.md`)
    : null;

  if (useCache && cachePath && existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf8');
  }

  const knowledgeCodeDir = join(workingDir, 'knowledge', 'code');
  let body;
  if (hasMdArticles(knowledgeCodeDir)) {
    body = buildFromMycelium(knowledgeCodeDir, maxBytes);
  } else {
    body = buildFromFallback(workingDir, maxBytes);
  }

  if (useCache && cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, body);
    } catch (err) {
      logger?.warn?.(`[codebase-index] cache write failed: ${err.message}`);
    }
  }

  return body;
}

function safeGitSha(workingDir) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .slice(0, 12);
  } catch {
    return null;
  }
}

function hasMdArticles(dir) {
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

function buildFromMycelium(knowledgeCodeDir, maxBytes) {
  const files = readdirSync(knowledgeCodeDir).filter((f) => f.endsWith('.md'));
  files.sort();
  const lines = [];
  let total = 0;
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    const sourcePath = slug.replace(/--/g, '/');
    const content = readFileSync(join(knowledgeCodeDir, f), 'utf8');
    const purpose = extractSection(content, 'Purpose');
    const exports = extractSection(content, 'Key Exports');
    const deps = extractSection(content, 'Dependencies');
    const line = composeLine(sourcePath, purpose, exports, deps);
    if (total + line.length + 1 > maxBytes) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function extractSection(markdown, heading) {
  const re = new RegExp(`##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = markdown.match(re);
  if (!m) return '';
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
}

function composeLine(sourcePath, purpose, exports, deps) {
  const parts = [sourcePath];
  if (purpose) parts.push(`— ${purpose}`);
  if (exports) parts.push(`Exports: ${exports}`);
  if (deps) parts.push(`Depends on: ${deps}`);
  return parts.join(' ');
}

function buildFromFallback(workingDir, maxBytes) {
  const lines = [];
  let total = 0;
  for (const topLevel of FALLBACK_DIRS) {
    const abs = join(workingDir, topLevel);
    if (!existsSync(abs)) continue;
    for (const relPath of walkFiles(abs, workingDir)) {
      const summary = summarizeFile(join(workingDir, relPath));
      if (!summary) continue;
      const line = `${relPath} — ${summary}`;
      if (total + line.length + 1 > maxBytes) return finalize(lines);
      lines.push(line);
      total += line.length + 1;
    }
  }
  return finalize(lines);
}

function finalize(lines) {
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function* walkFiles(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (FALLBACK_EXCLUDED.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkFiles(abs, root);
    } else if (ent.isFile() && FALLBACK_EXT_WHITELIST.has(extname(ent.name))) {
      yield relative(root, abs);
    }
  }
}

function summarizeFile(absPath) {
  try {
    const raw = readFileSync(absPath, 'utf8');
    const firstLines = raw.split('\n').slice(0, 30);
    const blockComment = firstLines.find((l) => /^\s*\*\s*\S/.test(l));
    if (blockComment) {
      return blockComment.replace(/^\s*\*\s*/, '').trim().slice(0, 160);
    }
    const lineComment = firstLines.find((l) => /^\s*(\/\/|#)\s*\S/.test(l));
    if (lineComment) {
      return lineComment.replace(/^\s*(\/\/|#)\s*/, '').trim().slice(0, 160);
    }
    const exportLine = firstLines.find((l) => /^\s*export\s+/.test(l));
    if (exportLine) return exportLine.trim().slice(0, 160);
    return '';
  } catch {
    return '';
  }
}
