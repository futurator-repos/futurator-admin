// Pipeline v2.0 PR-4 — file-path heuristic extractor.
//
// Pure regex extraction of file path references from story text (the
// `description` + `acceptanceCriteria` fields). The first signal in the
// touch-point inference pipeline; if this returns ≥1 plausible path, we
// skip the LLM fallback entirely.
//
// Three patterns matter for the planner output we see in practice:
//   1. Backticked path:        `src/foo.ts`, `index.html`, `tests/auth.spec.ts`
//   2. Plain path-with-ext:    src/foo.ts, dist/index.html  (anywhere in prose)
//   3. Glob-y reference:       `src/**/*.ts`, `tests/**/*.spec.ts`
//
// We DON'T try to parse English ("create a foo.ts file") — that's the LLM's
// job in the fallback path.
//
// Returns deduplicated paths sorted longest-first (more specific paths first
// for downstream globbing). No file-system access — pure on input string.

/** File extensions the planner typically references for code/asset files. */
const FILE_EXTS = [
  // TypeScript / JavaScript
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  // Web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  // Config
  'json',
  'yml',
  'yaml',
  'toml',
  'env',
  // Docs / markup
  'md',
  'mdx',
  // Templates
  'tpl',
  // Tests
  'spec',
  'test',
];

/**
 * Extract candidate file paths from arbitrary story text.
 *
 * @param {string} text - typically `story.description + '\n' + story.acceptanceCriteria`
 * @returns {string[]} deduplicated, longest-first
 */
export function extractCandidatePaths(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  // Strip URLs first — `https://example.com/guide.html` would otherwise match
  // as `example.com/guide.html`. We don't want network references.
  text = text.replace(/https?:\/\/\S+/g, ' ');

  const candidates = new Set();
  const extPattern = FILE_EXTS.join('|');

  // Pattern 1: backticked path including extension
  //   `src/foo.ts`, `index.html`, `tests/auth.spec.ts`, `src/**/*.ts`
  const backticked = new RegExp(
    `\`([\\w./*\\-]+\\.(?:${extPattern}))\``,
    'g',
  );
  let m;
  while ((m = backticked.exec(text)) !== null) {
    candidates.add(normalizePath(m[1]));
  }

  // Pattern 2: backticked DIRECTORY-globs ending in /, or `src/**`, `tests/**`
  //   `src/**`, `tests/__tests__/`, `e2e/`
  const backtickedDir = /`([\w./-]+(?:\*\*|\/))`/g;
  while ((m = backtickedDir.exec(text)) !== null) {
    const norm = normalizePath(m[1]);
    if (norm.length > 2 && !norm.startsWith('.')) candidates.add(norm);
  }

  // Pattern 3: plain path-with-extension at word boundary, must contain `/`
  //   "create src/foo.ts to ..." → src/foo.ts
  //   Excludes single-word filenames in prose (file.txt isn't enough — needs a /)
  const plainPath = new RegExp(
    `\\b([a-zA-Z_][\\w./-]*\\/[\\w./-]+\\.(?:${extPattern}))\\b`,
    'g',
  );
  while ((m = plainPath.exec(text)) !== null) {
    candidates.add(normalizePath(m[1]));
  }

  // Pattern 4: bare top-level filenames that are SO common they're worth
  // catching even without a slash. Restricted to a known list to avoid prose
  // false-positives.
  const wellKnownFiles = [
    'index.html',
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'next.config.ts',
    'next.config.js',
    'README.md',
    'plan.md',
  ];
  for (const f of wellKnownFiles) {
    const re = new RegExp(`\`?\\b${escapeRegex(f)}\\b\`?`);
    if (re.test(text)) candidates.add(f);
  }

  // Filter & sort
  return [...candidates]
    .filter((p) => isPlausiblePath(p))
    .sort((a, b) => b.length - a.length);
}

// ── internals ────────────────────────────────────────────────────────────

function normalizePath(p) {
  return String(p)
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlausiblePath(p) {
  if (typeof p !== 'string' || p.length < 3) return false;
  // Reject paths with leading slashes (absolute), `..`, or whitespace.
  if (p.startsWith('/')) return false;
  if (p.includes('..')) return false;
  if (/\s/.test(p)) return false;
  // Reject pure prose that happened to match an ext token (e.g., "X.json" in
  // a sentence that's actually about a JSON example, not a file). We can't
  // perfectly distinguish, but require either a slash or a well-known
  // top-level filename.
  const isWellKnown = [
    'index.html',
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'next.config.ts',
    'next.config.js',
    'README.md',
    'plan.md',
  ].includes(p);
  if (!p.includes('/') && !p.includes('**') && !isWellKnown) return false;
  return true;
}
