/**
 * git-graph-snapshot.mjs — git-graph from the bare repo (2026-05-30).
 *
 * The Labs git-graph view reads the GitHub API (`futurator-repos/<appId>`).
 * Greenfield Labs apps have NO GitHub repo (→ 404, empty graph), and the
 * daemon only pushes `plan/<slug>` — the `wip/<storyId>` per-story branches,
 * their commits, and the wave merges (the "emerging branching") live ONLY in
 * the EC2 bare repo `/home/ubuntu/repos/<appId>.git`, never on GitHub.
 *
 * This builds a snapshot of the bare repo's full graph (all refs) in the SAME
 * shape the existing view consumes (GitGraphResponse) and uploads it to
 * `s3://futurator-ai-website/knowledge-live/<appId>/_graph/git-graph.json`.
 * The API serves it as a fallback when GitHub has no repo — so the view + hook
 * are UNCHANGED; greenfield apps just get bare-repo data.
 *
 * Best-effort: never throws into the caller (wave-merge). A failure just means
 * the git-graph stays stale until the next wave.
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';

// Unit Separator (0x1f) — can't appear in commit subjects or refnames, so it's
// a safe field delimiter for `git log --format` (subjects contain spaces).
const US = String.fromCharCode(31);
const KNOWLEDGE_BUCKET = process.env.KNOWLEDGE_BUCKET || 'futurator-ai-website';

/**
 * Build the git-graph snapshot object from a bare repo. Runs git via the
 * injected `git` runner (same `{ code, stdout, stderr }` contract as the
 * wave-merge runner's); no S3 — the caller uploads.
 *
 * @param {{ appId: string, bare: string, git: Function, bareOpCwd: string, limit?: number }} a
 * @returns {Promise<object|null>} GitGraphResponse-shaped snapshot, or null on failure.
 */
export async function buildGitGraphSnapshot({ appId, bare, git, bareOpCwd, limit = 300 }) {
  if (!appId || !bare) return null;

  // Commits across ALL refs (wip/*, plan/*, main), date-ordered. Fields are
  // US-separated; records newline-separated.
  const fmt = ['%H', '%P', '%s', '%an', '%ae', '%aI'].join('%x1f');
  const logRes = await git(
    ['--git-dir', bare, 'log', '--all', '--date-order', `--max-count=${limit}`, `--format=${fmt}`],
    bareOpCwd,
  );
  if (logRes.code !== 0) return null;

  const commits = logRes.stdout
    .split('\n')
    .filter((l) => l.includes(US))
    .map((line) => {
      const [sha, parents, message, an, ae, date] = line.split(US);
      return {
        sha,
        parents: (parents || '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((p) => ({ sha: p })),
        commit: {
          message: message || '',
          author: { name: an || '', email: ae || '', date: date || '' },
        },
        author: null, // no GitHub-user mapping for local commits
        html_url: '',
      };
    });

  // Branches (local heads). objectname FIRST (fixed 40 hex), then the refname
  // (refnames can't contain spaces) — split on the first space.
  const refRes = await git(
    ['--git-dir', bare, 'for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads'],
    bareOpCwd,
  );
  const branches =
    refRes.code === 0
      ? refRes.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line) => {
            const sp = line.indexOf(' ');
            const sha = sp >= 0 ? line.slice(0, sp) : line;
            const name = sp >= 0 ? line.slice(sp + 1) : '';
            return { name, commit: { sha }, protected: name === 'main' };
          })
          .filter((b) => b.name)
      : [];

  const defaultBranch = branches.some((b) => b.name === 'main')
    ? 'main'
    : branches[0]?.name || 'main';

  return {
    repo: {
      name: appId,
      full_name: `local/${appId}`,
      description: 'EC2 bare-repo snapshot (not on GitHub)',
      default_branch: defaultBranch,
      html_url: '',
    },
    commits,
    branches,
    pullRequests: [],
    rateLimit: { limit: 0, remaining: 0, reset: 0 },
    source: 'bare-repo', // provenance: lets the UI/operator tell the source apart
    generatedAt: null, // stamped by writeGitGraphSnapshot
  };
}

/**
 * Build + upload the snapshot to S3. Best-effort; logs + swallows errors.
 *
 * @param {{ appId, bare, git, bareOpCwd, s3, log?, limit? }} a
 *   s3 — an @aws-sdk/client-s3 S3Client.
 * @returns {Promise<{ uploaded: boolean, commits?: number, branches?: number, reason?: string }>}
 */
export async function writeGitGraphSnapshot({
  appId,
  bare,
  git,
  bareOpCwd,
  s3,
  log = () => {},
  limit,
}) {
  try {
    const snapshot = await buildGitGraphSnapshot({ appId, bare, git, bareOpCwd, limit });
    if (!snapshot) {
      log('warn', `[git-graph] could not build snapshot for ${appId} (git log failed)`);
      return { uploaded: false, reason: 'build-failed' };
    }
    snapshot.generatedAt = new Date().toISOString();
    const key = `knowledge-live/${appId}/_graph/git-graph.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: KNOWLEDGE_BUCKET,
        Key: key,
        Body: JSON.stringify(snapshot),
        ContentType: 'application/json',
        CacheControl: 'no-cache',
      }),
    );
    log(
      'info',
      `[git-graph] wrote ${snapshot.commits.length} commit(s), ${snapshot.branches.length} branch(es) → s3://${KNOWLEDGE_BUCKET}/${key}`,
    );
    return {
      uploaded: true,
      commits: snapshot.commits.length,
      branches: snapshot.branches.length,
    };
  } catch (err) {
    log('warn', `[git-graph] snapshot write failed (non-blocking): ${err.message}`);
    return { uploaded: false, reason: err.message };
  }
}
