/**
 * ast-facts-reconcile.mjs — F14 refuse-to-narrow safety net (2026-06-18).
 *
 * A partial AST scan must never SHRINK the project's known file set. Per-story
 * and wave-candidate worktrees run ast-extract in `--diff-manifest` mode, which
 * only emits the handful of files a single story touched. If that partial doc
 * is ground as-is it becomes the authoritative ast-facts and the graph snapshot
 * collapses to that story's slice (FINDING F14).
 *
 * These are pure helpers so graph-sync.mjs (a CLI module that runs `main()` on
 * import, hence untestable directly) can delegate the narrowing decision here.
 */

// Path segments that mark an ephemeral / partial-scan working dir:
//   worktrees/<app>/<plan>/<storyId>     — per-story worktree
//   .../_cand/<jobId>  .../_merge         — wave-merge candidate/coordinator
//   .../_party  .../_assist               — other reserved worktree namespaces
const EPHEMERAL_ROOT_RE = /(^|\/)(worktrees|_cand|_merge|_party|_assist)(\/|$)/;

/**
 * True when `root` looks like a per-story / wave-candidate worktree rather than
 * the integrated project tree (projects/<appId>).
 */
export function isEphemeralScanRoot(root) {
  return typeof root === 'string' && EPHEMERAL_ROOT_RE.test(root);
}

/**
 * Union a partial scan's file rows over a preserved full-project scan so the
 * known file set can only GROW. Per-file facts from the partial scan win for
 * files it covers (it reflects this story's edits); files only present in the
 * full scan are kept untouched; brand-new files in the partial scan are added.
 *
 * @param {{files: Array<{path:string}>}} partial  the freshly-scanned doc
 * @param {{files: Array<{path:string}>}} full     the preserved full-project doc
 * @returns {Array<object>} the unioned `files` array
 */
export function unionAstFiles(partial, full) {
  const partialFiles = Array.isArray(partial?.files) ? partial.files : [];
  const fullFiles = Array.isArray(full?.files) ? full.files : [];
  const incoming = new Map(partialFiles.map((f) => [f.path, f]));
  const merged = [];
  for (const ff of fullFiles) {
    merged.push(incoming.has(ff.path) ? incoming.get(ff.path) : ff);
    incoming.delete(ff.path);
  }
  for (const f of incoming.values()) merged.push(f);
  return merged;
}
