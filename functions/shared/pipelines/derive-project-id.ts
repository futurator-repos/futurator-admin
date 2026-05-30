/**
 * derive-project-id.ts — worktree-aware projectId resolution (2026-05-30).
 *
 * THE BUG (knowledge graph not growing): pipeline generators derived the
 * projectId — used as the Memgraph `--project` key AND the S3 mirror path
 * `knowledge-live/<projectId>/` — by taking the LAST path segment of
 * `workingDir`. That assumed the legacy single-folder layout
 * `/home/ubuntu/projects/<appId>` (last segment = appId). Under the per-story
 * worktree model the compile runs in
 * `/home/ubuntu/worktrees/<appId>/<planSlug>/<storyId>`, whose last segment is
 * the STORY id — so knowledge landed under `knowledge-live/<storyId>/` and
 * Memgraph nodes were keyed per story. The graph-viewer fetches
 * `knowledge-live/<appSlug>/_graph/graph-snapshot.json` → 404 → empty graph.
 * (Proven: S3 `knowledge-live/` held story-UUID prefixes, not app slugs.)
 *
 * This helper returns the APP id for BOTH layouts:
 *   /home/ubuntu/projects/<appId>                         → <appId>
 *   /home/ubuntu/worktrees/<appId>/<planSlug>/<storyId>   → <appId>
 *
 * For any other shape it falls back to the last segment (legacy behavior), so
 * it's a strict superset — never worse than before.
 */
export function deriveProjectId(workingDir: string | undefined | null): string {
  if (!workingDir) return 'unknown';
  const segs = workingDir.replace(/\/+$/, '').split('/').filter(Boolean);
  // Worktree layout: the app id is the segment immediately after `worktrees`.
  const wt = segs.lastIndexOf('worktrees');
  if (wt >= 0 && segs[wt + 1]) return segs[wt + 1];
  // Legacy single-folder layout (or anything else): last segment.
  return segs[segs.length - 1] || 'unknown';
}
