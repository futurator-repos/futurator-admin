// Pipeline v2.0 efficiency fix B8 — bash deny patterns.
//
// Daemon-side runtime enforcement of "thou shalt not scaffold from scratch
// in a project that already has a working scaffold." dino1 forensic showed
// the LLM ignoring prompt rules ("Do NOT run `npm create vite`") and running
// the scaffolding commands anyway, race-conditioning with sibling stories.
//
// This module is pure — given a Bash command string, return whether it
// matches a deny pattern and which one. The daemon's processStreamEvent
// applies the verdict by SIGTERM-ing the active child and surfacing an
// attention item.
//
// **Why bash here, not in the prompt:** prose rules are advisory; SIGTERM
// is unbypassable. The dev-subagent-prompt's PROJECT BASELINE paragraph
// (landed 2026-04-28) is replaced by this enforcement.

/**
 * Deny patterns. Each entry has a label, a regex, and a reason string the
 * daemon surfaces in the attention item. Order matters only for matching
 * priority — the first match wins; the rest are still recorded as "also
 * matched" for diagnostics in dev.
 *
 * Patterns target shapes that:
 *   - Scaffold a fresh project from scratch (overwrites the existing
 *     boilerplate), e.g. `npm create vite`, `npx create-next-app`.
 *   - Initialize git or tsconfig in a directory that already has them.
 *   - Recursively delete project-essential paths.
 *   - Modify the lockfile or node_modules outside `npm install` flows.
 */
const DENY_PATTERNS = Object.freeze([
  {
    label: 'scaffold-vite',
    pattern: /(^|\s|;|&&|\|\|)\s*(npx?\s+)?(npm\s+)?create[-\s]vite\b/i,
    reason:
      'creating a fresh Vite project would overwrite the existing scaffold (boilerplate already wired)',
  },
  {
    label: 'scaffold-next',
    pattern: /(^|\s|;|&&|\|\|)\s*(npx?\s+)?create-next-app\b/i,
    reason:
      'creating a fresh Next.js project would overwrite the existing scaffold (boilerplate already wired)',
  },
  {
    label: 'scaffold-react',
    pattern: /(^|\s|;|&&|\|\|)\s*(npx?\s+)?create-react-app\b/i,
    reason: 'creating a fresh React app would overwrite the existing scaffold',
  },
  {
    label: 'scaffold-bmad-init',
    // Common BMAD init invocations. Project's BMAD is installed by the daemon's
    // app-bootstrap saga; agents should not re-init.
    pattern: /(^|\s|;|&&|\|\|)\s*(npx?\s+)?bmad-method\s+(install|init)\b/i,
    reason: 'BMAD is installed by the daemon during app-bootstrap; agents must not re-init',
  },
  {
    label: 'tsc-init',
    pattern: /(^|\s|;|&&|\|\|)\s*(npx?\s+)?tsc\s+--init\b/i,
    reason: 'tsconfig.json already exists in the scaffolded project',
  },
  {
    label: 'git-init',
    pattern: /(^|\s|;|&&|\|\|)\s*git\s+init\b/i,
    reason: 'project working directory is already a git repo (created by the saga)',
  },
  {
    label: 'rm-rf-project-root',
    // Catches `rm -rf .`, `rm -rf ./`, `rm -rf ./*` and any combination with
    // -fr / -Rf / -rf flags.
    pattern: /(^|\s|;|&&|\|\|)\s*rm\s+-[rRf]+\s+(\.|\.\/|\.\/\*)(\s|$|;|&)/,
    reason: 'recursively deleting the project root is not a recoverable mistake',
  },
  {
    label: 'rm-rf-essentials',
    // Targets package.json, node_modules, src, public, plus any path that
    // starts with one of those (e.g. `src/foo`).
    pattern:
      /(^|\s|;|&&|\|\|)\s*rm\s+-[rRf]+\s+(?:\.\/)?(?:package\.json\b|package-lock\.json\b|node_modules\b|src\b|public\b|tsconfig\.json\b|\.git\b|_bmad\b)/,
    reason:
      'deleting project-essential paths (package.json, node_modules, src/, .git/, _bmad/, etc.) is destructive',
  },
  {
    label: 'git-stash-shared-tree',
    // pacman4 forensic (2026-07-05): a story agent ran `git stash … git stash
    // pop` to isolate a typecheck. The P3 worktree is SHARED across parallel
    // in-flight stories — a stash swallows SIBLING stories' uncommitted files,
    // and the pop can conflict, corrupting work the agent doesn't own. Use
    // `git diff`/`git status` for inspection instead; never mutate the shared
    // index/worktree state wholesale. (`stash list`/`show` stay allowed.)
    pattern: /(^|\s|;|&&|\|\|)\s*git\s+stash\b(?!\s+(list|show)\b)/i,
    reason:
      'git stash on the SHARED plan worktree swallows parallel sibling stories’ uncommitted work (pop can conflict/corrupt it) — inspect with git diff/status instead',
  },
  // Deferred to PR-5+: these would be useful but are too aggressive for v1.
  // - banning `npm install <pkg>` outside the project's existing deps
  // - banning `git push` (currently the daemon does this via app-bootstrap saga)
  // - banning `cd ../..` and absolute-path edits outside cwd
]);

/**
 * Check whether a Bash command string matches a deny pattern.
 *
 * @param {string} cmd - the raw command string from a `tool_use` event's
 *   `input.command` field. Empty / non-string returns no-match.
 * @returns {{ denied: boolean, label?: string, reason?: string }}
 */
export function matchesDenyPattern(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { denied: false };
  }
  for (const entry of DENY_PATTERNS) {
    if (entry.pattern.test(cmd)) {
      return { denied: true, label: entry.label, reason: entry.reason };
    }
  }
  return { denied: false };
}

/** Exported for visibility / docs only — production code uses matchesDenyPattern. */
export const DENY_PATTERN_REGISTRY = DENY_PATTERNS;
