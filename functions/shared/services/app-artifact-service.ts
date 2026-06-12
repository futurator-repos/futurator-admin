/**
 * app-artifact-service.ts — 2026-05-19
 *
 * Cleanup helpers for `DELETE /api/apps/:appId`. Each helper is best-effort
 * and returns a structured `CleanupStep` rather than throwing — so a failure
 * in (say) the GitHub repo delete doesn't strand the operator with half-
 * deleted DDB state.
 *
 * Steps covered:
 *   - SSM `rm -rf /home/ubuntu/projects/<appId>` (legacy shared worktree)
 *   - SSM `rm -rf /home/ubuntu/worktrees/<appId>` + `repos/<appId>.git`
 *     (2026-05-28 — all per-story / _merge / _party / _assist worktrees +
 *     the bare object store; see deleteAppWorktreesAndRepo)
 *   - GitHub `DELETE /repos/futurator-repos/<appId>`
 *   - S3 `apps/<appId>/*` purge   (deployed Vite/Next artifacts)
 *   - S3 `knowledge-live/<appId>/*` purge (Mycelium mirror)
 *   - Secrets Manager schedule-delete `futurator/brownfield-pat/<appId>`
 *
 * Caller is responsible for cascading plans (incl. per-plan branch cleanup
 * via `cleanupPlanBranch`) BEFORE invoking this — the folder rm here is
 * unconditional and would clobber any in-progress plan work.
 */

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CleanupStep, PlanFolderDeps } from './plan-folder-service';
import { archivePartyBranch, reapPartyWorktree } from './plan-folder-service';
import { brownfieldPatSecretNameFor } from '../types/party';

const FUTURATOR_PUBLIC_BUCKET = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';

export interface AppArtifactDeps extends PlanFolderDeps {
  /** GitHub `deleteRepo('futurator-repos', appId)` — wraps the connector. */
  deleteGithubRepo: (owner: string, name: string) => Promise<void>;
  /** Injectable for tests. Defaults to a real client when omitted. */
  s3Client?: S3Client;
  /** Injectable for tests. Defaults to a real client when omitted. */
  secretsClient?: SecretsManagerClient;
  /**
   * Story 20.11 (party-push Epic 20) — list every party session for an
   * app so the cascade can reap branches + worktrees BEFORE the folder
   * `rm -rf`. Wire to `partySessionsRepo.listSessionsByProject` at the
   * API call site. Optional: when missing, the party-cleanup step skips
   * with `detail: 'no listSessionsByProject dep wired'` so the cascade
   * still completes (rollout-safe).
   */
  listPartySessionsByProject?: (appId: string) => Promise<{ sessionId: string }[]>;
}

function assertSafeFolderName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(name)) {
    throw new Error(`Refused: folder name "${name}" does not match safe pattern`);
  }
}

/**
 * Delete the App's worktree folder via SSM. Runs after all per-plan branch
 * cleanups so we never race a daemon trying to write into the folder.
 *
 * Side effect: removes all local branches (including any lingering Epic 18
 * free-agent `assist/<projectId>/<sessionId>` branches the daemon GC
 * hasn't reaped yet). Those branches are local-only — free-agent
 * sessions never push (see daemon/pipelines/lib/free-agent-worktree.mjs)
 * — so nuking the folder is sufficient and no remote cleanup is needed.
 */
async function deleteAppFolder(appId: string, deps: PlanFolderDeps): Promise<CleanupStep> {
  assertSafeFolderName(appId);
  const dir = `/home/ubuntu/projects/${appId}`;
  const cmd = [
    `if [ -d "${dir}" ]; then`,
    `  rm -rf "${dir}" && echo "FOLDER_DELETED" || echo "FOLDER_DELETE_FAILED"`,
    `else`,
    `  echo "FOLDER_ABSENT"`,
    `fi`,
  ].join('\n');
  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    if (output.includes('FOLDER_ABSENT')) {
      return { step: 'folder', status: 'skipped', detail: `${dir} already gone` };
    }
    if (output.includes('FOLDER_DELETED')) {
      return { step: 'folder', status: 'done', detail: dir };
    }
    return {
      step: 'folder',
      status: 'error',
      detail: `unexpected ssm output: ${output.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      step: 'folder',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 2026-05-28 — Delete the App's per-story / coordinator / party / assist
 * worktrees + the bare object store. App-delete is the nuclear option, so
 * this is a wholesale `rm -rf` of the entire app subtree under the shared
 * worktree root + the bare repo — independent of plan/session state.
 *
 * Why a wholesale sweep (vs the per-plan `reapPlanStoryWorktrees`):
 *   - The per-plan reaper is keyed by plan name; orphaned worktrees from
 *     a deleted/renamed plan, plus `_party/<sid>` and `_assist/<sid>`
 *     worktrees (keyed by session, not plan), are NOT covered by it.
 *   - On full app-delete we want everything gone regardless of how it
 *     got orphaned. `rm -rf <root>/<appId>` catches all four namespaces
 *     in one shot.
 *
 * Removing the bare repo too means any stale `git worktree` admin entries
 * inside it (from the `rm -rf` skipping `git worktree remove`) are moot —
 * the whole object store goes with it.
 *
 * NOTE: `/home/ubuntu/worktrees/<appId>` is the shared root used by
 * pipeline-v2 (per-story + `_merge`), party (`_party/<sid>`), and
 * free-agent (`_assist/<sid>`). The legacy `/home/ubuntu/projects/<appId>`
 * shared worktree is handled separately by deleteAppFolder.
 */
async function deleteAppWorktreesAndRepo(
  appId: string,
  deps: PlanFolderDeps,
): Promise<CleanupStep> {
  assertSafeFolderName(appId);
  const worktreesDir = `/home/ubuntu/worktrees/${appId}`;
  const bareRepo = `/home/ubuntu/repos/${appId}.git`;
  // 2026-06-10 (dragon1 disk-full incident) — also reap the app's shared
  // node_modules store. The daemon's worktree-reaper protects store entries
  // behind `.refcount.json`, but this wholesale `rm -rf` of the worktrees
  // bypasses the refcount-decrement teardown — so a deleted app's store
  // entries kept stale positive counts and were immortal (dino1 left 1.2 GB
  // for a week; the disk hit 98% and wave-merge node_modules
  // materialization failed with ENOSPC, stalling the plan). On app-delete
  // the refcounts are moot: the whole `<storeRoot>/<appId>` subtree goes.
  const storeDir = `/home/ubuntu/.node_modules_store/${appId}`;
  const cmd = [
    `WT_STATUS=ABSENT; REPO_STATUS=ABSENT; STORE_STATUS=ABSENT`,
    `if [ -d "${worktreesDir}" ]; then`,
    `  rm -rf "${worktreesDir}" && WT_STATUS=DELETED || WT_STATUS=FAILED`,
    `fi`,
    `if [ -d "${bareRepo}" ]; then`,
    `  rm -rf "${bareRepo}" && REPO_STATUS=DELETED || REPO_STATUS=FAILED`,
    `fi`,
    `if [ -d "${storeDir}" ]; then`,
    `  rm -rf "${storeDir}" && STORE_STATUS=DELETED || STORE_STATUS=FAILED`,
    `fi`,
    `echo "WORKTREES_${'$'}{WT_STATUS} BAREREPO_${'$'}{REPO_STATUS} NMSTORE_${'$'}{STORE_STATUS}"`,
  ].join('\n');
  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    const wtMatch = output.match(/WORKTREES_(\w+)/);
    const repoMatch = output.match(/BAREREPO_(\w+)/);
    const storeMatch = output.match(/NMSTORE_(\w+)/);
    const wt = wtMatch?.[1] ?? 'UNKNOWN';
    const repo = repoMatch?.[1] ?? 'UNKNOWN';
    const store = storeMatch?.[1] ?? 'UNKNOWN';
    if (wt === 'FAILED' || repo === 'FAILED' || store === 'FAILED') {
      return {
        step: 'worktrees',
        status: 'error',
        detail: `worktrees=${wt} bareRepo=${repo} nmStore=${store}`,
      };
    }
    const anyDeleted = wt === 'DELETED' || repo === 'DELETED' || store === 'DELETED';
    return {
      step: 'worktrees',
      status: anyDeleted ? 'done' : 'skipped',
      detail: `worktrees=${wt} bareRepo=${repo} nmStore=${store}`,
    };
  } catch (err) {
    return {
      step: 'worktrees',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * dino1 hygiene (2026-06-12) — sweep the per-app residue the folder/worktree
 * deletes leave behind. Found auditing the host after a full app-delete
 * pass:
 *
 *   1. Claude session transcripts: every agent the daemon spawns in a
 *      worktree writes `~/.claude/projects/<cwd-slug>/...` — 138 MB of
 *      transcripts for long-deleted apps had accumulated. The slug encodes
 *      the cwd with `/`→`-` (e.g. `-home-ubuntu-projects-dino1`,
 *      `-home-ubuntu-worktrees-dino1-...`), so the app's dirs are
 *      `-home-ubuntu-projects-<appId>` exactly plus either prefix followed
 *      by `-` (path separator) — an app named `dino` can never match
 *      `dino1`'s dirs.
 *   2. Dangling symlinks at the projects root pointing INTO the deleted
 *      folder (a stray `projects/vite.config.ts` → spyhunter-1 survived
 *      that app's delete; `rm -rf projects/<app>` can't see siblings).
 *   3. /tmp QA artifacts (`qa-<jobId>/` screenshot dirs,
 *      `wave-vqa-devserver-*.log`): keyed by jobId, unattributable to an
 *      app after the job rows cascade — swept by age (>2 days) instead.
 *
 * NOT swept here, by design: `~/.npm/_cacache` and any package-manager
 * store are content-addressed (shared across apps, unattributable) and
 * make the next bootstrap's install fast — they are hygiene-by-cap, not
 * per-app cascade material.
 */
async function deleteAppResidue(appId: string, deps: PlanFolderDeps): Promise<CleanupStep> {
  assertSafeFolderName(appId);
  const claudeProjects = '/home/ubuntu/.claude/projects';
  const cmd = [
    `TRANSCRIPTS=0`,
    // Exact projects dir + prefixed (path-separator '-') worktree/session dirs.
    `for d in "${claudeProjects}/-home-ubuntu-projects-${appId}" \\`,
    `         "${claudeProjects}/-home-ubuntu-projects-${appId}-"* \\`,
    `         "${claudeProjects}/-home-ubuntu-worktrees-${appId}-"*; do`,
    `  if [ -d "$d" ]; then rm -rf "$d" && TRANSCRIPTS=$((TRANSCRIPTS+1)); fi`,
    `done`,
    // Dangling symlinks at the projects root (target deleted with the app).
    `DANGLING=$(find /home/ubuntu/projects -maxdepth 1 -xtype l -print -delete 2>/dev/null | wc -l)`,
    // Stale /tmp QA artifacts (age-based; jobIds are gone with the plans).
    `find /tmp -maxdepth 1 -name "qa-*" -mtime +2 -exec rm -rf {} + 2>/dev/null || true`,
    `find /tmp -maxdepth 1 -name "wave-vqa-devserver-*.log" -mtime +2 -delete 2>/dev/null || true`,
    `echo "RESIDUE transcripts=$TRANSCRIPTS dangling=$DANGLING"`,
  ].join('\n');
  try {
    const commandId = await deps.sendSsmCommand(cmd);
    const output = await deps.waitForSsmOutput(commandId);
    const m = output.match(/RESIDUE transcripts=(\d+) dangling=(\d+)/);
    if (!m) {
      return {
        step: 'residue',
        status: 'error',
        detail: `unexpected ssm output: ${output.slice(0, 200)}`,
      };
    }
    const transcripts = Number(m[1]);
    const dangling = Number(m[2]);
    return {
      step: 'residue',
      status: transcripts > 0 || dangling > 0 ? 'done' : 'skipped',
      detail: `claude-transcript dirs=${transcripts} dangling-symlinks=${dangling} (+tmp qa sweep)`,
    };
  } catch (err) {
    return {
      step: 'residue',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Delete `futurator-repos/<appId>` on GitHub. 404 is treated as already-
 * gone (success); any other failure surfaces as error so the operator can
 * clean up manually + a follow-up attention item can be raised.
 */
async function deleteGithubRepoStep(appId: string, deps: AppArtifactDeps): Promise<CleanupStep> {
  try {
    await deps.deleteGithubRepo('futurator-repos', appId);
    return { step: 'github-repo', status: 'done', detail: `futurator-repos/${appId}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404|not found/i.test(msg)) {
      return { step: 'github-repo', status: 'skipped', detail: 'repo already gone' };
    }
    return { step: 'github-repo', status: 'error', detail: msg };
  }
}

/**
 * Purge an S3 prefix under the public bucket. Uses ListObjectsV2 +
 * DeleteObjects in pages of 1000 (S3 caps). Idempotent.
 */
async function purgeS3Prefix(prefix: string, label: string, s3: S3Client): Promise<CleanupStep> {
  let total = 0;
  let ContinuationToken: string | undefined;
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: FUTURATOR_PUBLIC_BUCKET,
          Prefix: prefix,
          ContinuationToken,
        }),
      );
      const objects: ObjectIdentifier[] =
        page.Contents?.filter((o) => !!o.Key).map((o) => ({ Key: o.Key! })) ?? [];
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: FUTURATOR_PUBLIC_BUCKET,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        total += objects.length;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return {
      step: label,
      status: total > 0 ? 'done' : 'skipped',
      detail: total > 0 ? `${total} objects` : 'no objects at prefix',
    };
  } catch (err) {
    return {
      step: label,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Schedule the brownfield PAT secret for deletion (30-day recovery window
 * via Secrets Manager's default). 404 → already gone → skipped.
 *
 * Mirrors the migrate-module's `DELETE /api/migrations/:id` behavior so
 * brownfield Apps that go through the App-delete path also clean up their
 * per-project secret. Greenfield Apps with no PAT secret → 404 → skipped.
 */
async function scheduleSecretDelete(
  appId: string,
  client: SecretsManagerClient,
): Promise<CleanupStep> {
  const name = brownfieldPatSecretNameFor(appId);
  try {
    await client.send(new DeleteSecretCommand({ SecretId: name }));
    return { step: 'brownfield-pat', status: 'done', detail: `${name} (30-day window)` };
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'ResourceNotFoundException') {
      return { step: 'brownfield-pat', status: 'skipped', detail: 'no per-app secret' };
    }
    return {
      step: 'brownfield-pat',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run the full App-artifact teardown. Returns one CleanupStep per
 * destination. Caller persists the array in the response.
 *
 * Order:
 *   1. Party-session reap (branches + _party worktrees).
 *   2. SSM legacy projects-folder rm (depends on plans being already
 *      drained so no daemon is mid-write).
 *   3. SSM worktrees-root + bare-repo rm (2026-05-28).
 *   4. GitHub repo delete (orthogonal — independent network call).
 *   5. S3 apps/<appId>/* purge.
 *   6. S3 knowledge-live/<appId>/* purge.
 *   7. Secrets Manager schedule-delete.
 */
export async function cleanupAppArtifacts(
  appId: string,
  deps: AppArtifactDeps,
): Promise<CleanupStep[]> {
  assertSafeFolderName(appId);

  const s3 = deps.s3Client ?? new S3Client({ region: 'us-east-1' });
  const secrets = deps.secretsClient ?? new SecretsManagerClient({ region: 'us-east-1' });

  // Sequential — these are independent enough to be parallel, but the
  // sequential trace is easier to read in the response body, and a folder
  // delete may need a few seconds via SSM. Six steps × ~2 s each is fine.
  const results: CleanupStep[] = [];
  // Story 20.11 — reap party sessions BEFORE the folder rm. Folder rm
  // doesn't see worktrees outside `/home/ubuntu/projects/<app>` (party
  // worktrees live at `/home/ubuntu/worktrees/<app>/_party/<sid>/`).
  results.push(await reapPartySessionsForApp(appId, deps));
  results.push(await deleteAppFolder(appId, deps));
  // 2026-05-28 — sweep the shared worktree root + bare repo wholesale.
  // Covers per-story/_merge/_party/_assist worktrees that the legacy
  // projects-folder rm + per-session party reap leave behind.
  results.push(await deleteAppWorktreesAndRepo(appId, deps));
  // dino1 hygiene (2026-06-12) — claude transcripts, dangling symlinks at
  // the projects root, stale /tmp QA artifacts. Runs AFTER the folder rm so
  // symlinks into the deleted folder are already dangling.
  results.push(await deleteAppResidue(appId, deps));
  results.push(await deleteGithubRepoStep(appId, deps));
  results.push(await purgeS3Prefix(`apps/${appId}/`, 's3-apps', s3));
  results.push(await purgeS3Prefix(`knowledge-live/${appId}/`, 's3-knowledge', s3));
  results.push(await scheduleSecretDelete(appId, secrets));
  return results;
}

/**
 * Story 20.11 — reap every party session's branch + worktree for an app.
 * Best-effort per session: a single session's archive/reap failure doesn't
 * block siblings. Step status is always 'done' (or 'skipped' when no
 * sessions / no dep wired) because partial success is the expected
 * common case post-rollout.
 */
async function reapPartySessionsForApp(appId: string, deps: AppArtifactDeps): Promise<CleanupStep> {
  if (typeof deps.listPartySessionsByProject !== 'function') {
    return {
      step: 'party-cleanup',
      status: 'skipped',
      detail: 'no listPartySessionsByProject dep wired (rollout-safe)',
    };
  }
  let sessions: { sessionId: string }[];
  try {
    sessions = await deps.listPartySessionsByProject(appId);
  } catch (err) {
    return {
      step: 'party-cleanup',
      status: 'error',
      detail: `listPartySessionsByProject failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (sessions.length === 0) {
    return { step: 'party-cleanup', status: 'skipped', detail: 'no party sessions' };
  }
  let archived = 0;
  let reaped = 0;
  for (const s of sessions) {
    const sessionIdShort = s.sessionId.slice(0, 8);
    try {
      const a = await archivePartyBranch({ workingDirSlug: appId, sessionIdShort }, deps);
      if (a.status === 'done') archived++;
    } catch {
      /* best-effort */
    }
    try {
      const r = await reapPartyWorktree({ workingDirSlug: appId, sessionIdShort }, deps);
      if (r.status === 'done' || r.status === 'skipped') reaped++;
    } catch {
      /* best-effort */
    }
  }
  return {
    step: 'party-cleanup',
    status: 'done',
    detail: `${sessions.length} session(s) (${archived} archived, ${reaped} reaped)`,
  };
}
