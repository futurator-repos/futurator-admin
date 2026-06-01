# Free-Agent Worktree Unification — Addendum to Party Push

**Status:** ⏸ **DO NOT START YET** — addendum plan; waits on `docs/concepts/party-push/plan.md` PR 0 + PR 1 landing in production. Picked up by the next implementing agent after party-push's daemon work is green.
**Author:** Ricardo + Free Explorer Agent (Claude Opus 4.7)
**Date:** 2026-05-22
**Estimated effort:** ~half-day (one focused PR, no cross-team scope)
**Predecessor doc:** [docs/concepts/party-push/plan.md](./party-push/plan.md)
**Related:** [docs/concepts/free-mode-agent-exploration.md](./free-mode-agent-exploration.md), [docs/epics-free-agent.md](../epics-free-agent.md)

---

## 0 · Why this exists

When the Free Agent shipped (Story 18.1, 2026-05-17), there was no shared worktree pattern in the codebase. So it built its own: a dedicated root at `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/`, with its own GC ticker at `daemon/lib/free-agent-gc.mjs` and its own conventions.

Then party-push generalized the worktree pattern:

- Pipeline v2 worktrees → `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/`
- Wave-merge coordinator → `/home/ubuntu/worktrees/<app>/<plan>/_merge/`
- Party debate → `/home/ubuntu/worktrees/<app>/_party/<sessionIdShort>/`

A single reaper at `daemon/lib/worktree-reaper.mjs`, a single root, a single set of namespace conventions (`_<reserved>` prefix can never collide with a plan slug because the slug regex rejects leading underscores).

**Free-agent's separate root is now legacy.** Three agent classes share most of the substrate; one class has its own root and its own reaper. This addendum brings free-agent under the shared umbrella.

The operator surfaced this directly: _"i don't want the free agent to have its own folder of free-agent worktrees. but rather work with the same logic as we have been discussing, perhaps with a label in those worktrees or branches, but not as a separate system."_

---

## 1 · Decisions locked in

These were resolved in the conversation that spawned this addendum; reviewer feedback should focus on _how_, not _whether_.

1. **Free-agent worktrees move to the shared root.** New path: `/home/ubuntu/worktrees/<projectId>/_assist/<sessionIdShort>/`. Old path `/home/ubuntu/free-agent-worktrees/` is deleted entirely on the migration daemon startup.

2. **Classification is by path namespace** (the `_assist` underscore-prefix reserved-namespace pattern), not by branch name or by attribute file. Matches party's `_party` convention. The slug regex in `daemon/lib/worktree-paths.mjs` already rejects underscore-led names, so `_assist` can never collide with a real plan slug.

3. **Session ID short form everywhere.** Filesystem: 8-char short. Branch: `assist/<projectId>/<sessionIdShort>` (was `assist/<projectId>/<fullUuid>` pre-unification). DDB keeps full UUID for `sessionId`; everything path-facing or branch-facing uses the short form. Aligns with party's convention.

4. **Migration = reap, don't migrate.** On first daemon startup after the unification PR lands, the daemon `rm -rf`s `/home/ubuntu/free-agent-worktrees/` and marks all `ACTIVE`/`PROCESSING` free-agent sessions as `EXPIRED` with `errorReason='WORKTREE_UNIFICATION_MIGRATION'`. Operator opens new chats; new sessions land on the unified path. No file-level migration because free-agent sessions never hold uncommitted work that matters — assist branches are local-only today.

5. **Bare-repo prerequisite is shared with party.** Free-agent on a non-bare-repo project refuses to start with a clear error pointing at the admin migration action (the same one party's §12.3.3 establishes). Greenfield apps already have the bare-repo topology; brownfield apps need the conversion to have run. Both classes share the prereq, both classes share the migration trigger.

6. **One reaper, one cron, one set of classifiers.** `daemon/lib/free-agent-gc.mjs` is deleted; its responsibilities move into `daemon/lib/worktree-reaper.mjs` as a new `walkAssistWorktrees` walker + `classifyAssistWorktree` classifier, mirroring party's `_party` extension exactly.

---

## 2 · Path + branch + namespace summary

After unification:

```
/home/ubuntu/repos/<app>.git                                  (bare; shared object store)
/home/ubuntu/projects/<app>/                                  (legacy shared worktree on main)
/home/ubuntu/worktrees/<app>/<plan>/<storyId>/                (pipeline-v2 per-story)
/home/ubuntu/worktrees/<app>/<plan>/_merge/                   (pipeline-v2 wave-merge)
/home/ubuntu/worktrees/<app>/_party/<sid-short>/              (party debate)
/home/ubuntu/worktrees/<app>/_assist/<sid-short>/             (← NEW: free-agent, was /home/ubuntu/free-agent-worktrees/)
```

Branch namespace:

| Prefix                    | Owner                 | Push direction                         | Path correspondence                                |
| ------------------------- | --------------------- | -------------------------------------- | -------------------------------------------------- |
| `main`                    | App (canonical)       | Operator only                          | `/home/ubuntu/projects/<app>/`                     |
| `plan/<slug>`             | Pipeline-v2 plan      | Daemon                                 | `/home/ubuntu/worktrees/<app>/<plan>/_merge/`      |
| `wip/<storyId>`           | Pipeline-v2 per-story | Daemon                                 | `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/`   |
| `party/<app>/<sidShort>`  | Party debate          | Daemon (post-PAT-upgrade)              | `/home/ubuntu/worktrees/<app>/_party/<sidShort>/`  |
| `assist/<app>/<sidShort>` | Free-agent            | **Local only today; remote at Rung 1** | `/home/ubuntu/worktrees/<app>/_assist/<sidShort>/` |
| `archive/party/...`       | Soft-deleted party    | GC ticker                              | n/a                                                |

Symmetric. `ls /home/ubuntu/worktrees/<app>/` shows everything the daemon is doing for that app, regardless of agent class.

---

## 3 · Subsystem design

Single PR. The implementing agent should run these in order; each is a single commit.

### 3.1 EDIT `daemon/pipelines/lib/free-agent-worktree.mjs`

```diff
- export const FREE_AGENT_WORKTREES_ROOT = '/home/ubuntu/free-agent-worktrees';
- export const FREE_AGENT_REPOS_ROOT = '/home/ubuntu/repos';
+ // 2026-05-XX (unification) — free-agent worktrees now live alongside party
+ // and pipeline-v2 worktrees under the shared root. See
+ // docs/concepts/free-agent-unification.md for rationale.
+ import {
+   WORKTREE_ROOT_DEFAULT,
+   bareRepoPath,
+   LEGACY_PROJECTS_ROOT,
+ } from '../../lib/story-worktree.mjs';
+
+ export const ASSIST_NAMESPACE = '_assist';
+
+ /**
+  * Filesystem path the assist worktree lives at.
+  * /home/ubuntu/worktrees/<projectId>/_assist/<sessionIdShort>/
+  */
+ export function worktreePathFor(projectId, sessionId, root = WORKTREE_ROOT_DEFAULT) {
+   const sidShort = sessionId.slice(0, 8);
+   return join(root, projectId, ASSIST_NAMESPACE, sidShort);
+ }
+
+ /** Branch name format for free-agent commits — short-form for symmetry. */
+ export function branchNameFor(projectId, sessionId) {
+   const sidShort = sessionId.slice(0, 8);
+   return `assist/${projectId}/${sidShort}`;
+ }
```

`ensureWorktree` body — switch from clone-based setup to `git worktree add` from the bare repo:

```diff
- // Old: cloneRepo into the session dir
- await cloneRepo({ repoUrl, branch, token, targetPath: worktreePath, ... });
+ const bareRepo = bareRepoPath(projectId);
+ if (!fs.existsSync(bareRepo)) {
+   throw new Error(
+     `ensureWorktree: bare repo not found at ${bareRepo}. ` +
+     `Run POST /api/admin/migrate-brownfield/<projectId> first ` +
+     `(see docs/concepts/party-push/plan.md §12.3.3).`,
+   );
+ }
+
+ const parent = worktreePath.slice(0, worktreePath.lastIndexOf('/'));
+ if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
+
+ const branch = branchNameFor(projectId, sessionId);
+ await execGit([
+   '--git-dir', bareRepo,
+   'worktree', 'add', '-B', branch, worktreePath, 'main',
+ ]);
```

`reapWorktree` body — switch to `git worktree remove --force` against the bare repo (same shape as party):

```diff
- // Old: rm -rf the entire session dir
+ const bareRepo = bareRepoPath(projectId);
+ if (fs.existsSync(bareRepo)) {
+   await execGit([
+     '--git-dir', bareRepo,
+     'worktree', 'remove', '--force', worktreePath,
+   ]);
+ }
+ // Defensive: also rm -rf in case worktree-remove didn't fully clean up.
+ if (fs.existsSync(worktreePath)) {
+   fs.rmSync(worktreePath, { recursive: true, force: true });
+ }
```

Other functions in this module (`writeFreeAgentSettings`, `writeAgentMd`, `installCommitMsgHook`) take a `worktreePath` argument and operate inside it — no changes needed since they're path-relative.

### 3.2 EDIT `daemon/lib/worktree-reaper.mjs` — add `_assist` namespace

Mirror exactly the party namespace extension that landed in party-push PR 0 (§11.2.8). Two new functions:

```javascript
/**
 * 2026-05-XX (unification) — Walk free-agent assist worktrees at
 * /home/ubuntu/worktrees/<app>/_assist/<sessionIdShort>/.
 * Mirror of walkPartyWorktrees.
 */
function* walkAssistWorktrees(root) {
  if (!existsSync(root)) return;
  for (const app of readdirSync(root, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const assistDir = join(root, app.name, '_assist');
    if (!existsSync(assistDir)) continue;
    for (const sess of readdirSync(assistDir, { withFileTypes: true })) {
      if (!sess.isDirectory()) continue;
      yield {
        appId: app.name,
        sessionIdShort: sess.name,
        fullPath: join(assistDir, sess.name),
      };
    }
  }
}

const ASSIST_TERMINAL_STATUSES = new Set(['IDLE', 'EXPIRED', 'BUDGET_EXHAUSTED', 'ERROR']);
const ASSIST_STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000; // 7d (matches party)

async function classifyAssistWorktree({ entry, deps }) {
  if (typeof deps.findFreeAgentSessionByShort !== 'function') {
    return { shouldReap: false, reason: 'lookup-not-wired' };
  }
  const session = await deps.findFreeAgentSessionByShort(entry.sessionIdShort).catch(() => null);
  if (!session) return { shouldReap: true, reason: 'session-row-missing' };
  if (!ASSIST_TERMINAL_STATUSES.has(session.status)) {
    return { shouldReap: false, reason: 'session-active' };
  }
  const lastActivity = session.lastActivityAt ? Date.parse(session.lastActivityAt) : 0;
  const ageMs = Date.now() - lastActivity;
  if (ageMs < ASSIST_STALE_TERMINAL_MS) {
    return {
      shouldReap: false,
      reason: `session-terminal-but-fresh (${Math.round(ageMs / 3_600_000)}h)`,
    };
  }
  return { shouldReap: true, reason: 'session-terminal-and-stale' };
}
```

Extend `runWorktreeReaper`'s summary block + main loop to include the `_assist` namespace (mirror of the `party` block):

```javascript
summary.assist = { scanned: 0, reaped: 0, errors: 0 };
for (const entry of walkAssistWorktrees(WORKTREE_ROOT_DEFAULT)) {
  summary.assist.scanned++;
  try {
    const verdict = await classifyAssistWorktree({ entry, deps });
    if (!verdict.shouldReap) continue;
    log('info', `[reaper] assist REAP ${entry.fullPath} (${verdict.reason})`);
    const bare = bareRepoPath(entry.appId);
    if (existsSync(bare)) {
      await runGit(
        ['--git-dir', bare, 'worktree', 'remove', '--force', entry.fullPath],
        LEGACY_PROJECTS_ROOT,
      );
    }
    if (existsSync(entry.fullPath)) {
      rmSync(entry.fullPath, { recursive: true, force: true });
    }
    summary.assist.reaped++;
  } catch (err) {
    summary.assist.errors++;
    log('error', `[reaper] assist FAIL ${entry.fullPath}: ${err.message}`);
  }
}
```

Wire `findFreeAgentSessionByShort` (new function, see §3.4) into the reaper's `deps` at daemon startup.

### 3.3 DELETE `daemon/lib/free-agent-gc.mjs`

Entire file goes. Its responsibilities are absorbed by the unified reaper above. Also delete the corresponding test file `daemon/lib/__tests__/free-agent-gc.test.mjs` if present.

### 3.4 EDIT `functions/shared/repositories/free-agent-sessions-repository.ts` — add short-form lookup

Mirror party's `findBySessionIdShort` (party-push §11.3.11):

```typescript
/**
 * 2026-05-XX (unification) — Lookup by first 8 chars of sessionId.
 * Used by the worktree reaper which only has the short form from the
 * filesystem path. Implementation: scan with FilterExpression
 * `begins_with(sessionId, :p)`. Collision probability ~10⁻¹⁰; first match wins.
 */
export async function findBySessionIdShort(
  sessionIdShort: string,
): Promise<FreeAgentSession | null> {
  if (!/^[a-f0-9]{8}$/.test(sessionIdShort)) return null;
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAMES.freeAgentSessions,
      FilterExpression: 'begins_with(sessionId, :p)',
      ExpressionAttributeValues: { ':p': sessionIdShort },
      Limit: 5,
    }),
  );
  const items = (result.Items ?? []) as FreeAgentSession[];
  return items[0] ?? null;
}
```

### 3.5 EDIT `daemon/agent-daemon.mjs` — drop the separate free-agent GC ticker + wire short-form lookup

Two changes near the existing reaper-ticker startup block:

```diff
@@ daemon/agent-daemon.mjs (top imports)

- import { runFreeAgentGc } from './lib/free-agent-gc.mjs';

@@ in startReaperTicker call site

  startReaperTicker({
    findStoryByIds: storyRepository.findByIds,
    getJobById: agentJobsRepo.findById,
    findPlanByAppAndSlug: planRepository.findByAppAndSlug,
    findPartySessionByShort: partySessionsRepo.findBySessionIdShort,
+   findFreeAgentSessionByShort: freeAgentSessionsRepo.findBySessionIdShort,
  });

@@ remove the separate setInterval that called runFreeAgentGc
- if (Date.now() - lastFreeAgentGcAt >= FREE_AGENT_GC_INTERVAL_MS) {
-   lastFreeAgentGcAt = Date.now();
-   runFreeAgentGc({
-     querySessionsScan: () => freeAgentListAllSessions(),
-     logFn: (level, msg, ctx) => log(level, msg, ctx),
-   }).catch((e) => log('error', `free-agent-gc uncaught: ${e.message}`));
- }
```

The unified reaper's hourly tick now sweeps both `_party` and `_assist` in one pass.

### 3.6 EDIT `daemon/pipelines/free-agent-session.mjs` — refuse on non-bare-repo + cwd assertion

When the bare repo is missing on the project (brownfield not yet migrated), emit a clear error event the UI can render. Add the assertion before worktree creation:

```diff
@@ daemon/pipelines/free-agent-session.mjs (in setup phase)

+ // 2026-05-XX (unification) — Free-agent now requires the bare-repo + worktree
+ // topology, same as party + pipeline-v2. Brownfield projects must have been
+ // migrated via POST /api/admin/migrate-brownfield/<projectId> before they
+ // can host free-agent sessions.
+ const bareRepo = bareRepoPath(projectId);
+ if (!fsExistsSync(bareRepo)) {
+   await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.error', {
+     sessionId,
+     reason: 'BARE_REPO_MISSING',
+     detail: `Bare repo at ${bareRepo} does not exist. Run POST ` +
+             `/api/admin/migrate-brownfield/${projectId} first.`,
+   });
+   await sessionsRepo.markError(sessionId, 'BARE_REPO_MISSING');
+   await sessionsRepo.releaseProcessingLock(sessionId, 'ERROR');
+   throw new Error(`Bare repo missing for ${projectId}`);
+ }
```

### 3.7 WRITE `daemon/lib/free-agent-unification-migration.mjs`

One-shot startup migration. Runs once per daemon installation, idempotent via a sentinel file.

```javascript
/**
 * free-agent-unification-migration.mjs — 2026-05-XX.
 *
 * One-shot migration that runs on daemon startup:
 *   1. Delete /home/ubuntu/free-agent-worktrees/ entirely (old root).
 *   2. Mark all ACTIVE/PROCESSING free-agent sessions as EXPIRED with
 *      errorReason='WORKTREE_UNIFICATION_MIGRATION'. Operator opens new
 *      chats; new sessions land on the unified path at
 *      /home/ubuntu/worktrees/<app>/_assist/<sidShort>/.
 *   3. Touch /var/lib/futurator-daemon/free-agent-unified.flag so
 *      subsequent restarts skip this.
 *
 * No file-level migration. Assist branches are local-only today; nothing
 * is lost. Operator inconvenience is "start a new chat" which is near-zero.
 */
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';

const OLD_ROOT = '/home/ubuntu/free-agent-worktrees';
const SENTINEL = '/var/lib/futurator-daemon/free-agent-unified.flag';

export async function maybeRunUnificationMigration({ sessionsRepo, log }) {
  if (existsSync(SENTINEL)) return { ran: false, reason: 'sentinel-present' };
  log('info', '[unification-migration] starting one-shot migration');

  // Step 1: remove old worktree root.
  let rmStatus = 'noop';
  if (existsSync(OLD_ROOT)) {
    try {
      rmSync(OLD_ROOT, { recursive: true, force: true });
      rmStatus = 'removed';
    } catch (err) {
      log('error', `[unification-migration] rm failed: ${err.message}`);
      rmStatus = `error: ${err.message}`;
    }
  }

  // Step 2: mark in-flight sessions EXPIRED.
  let markedCount = 0;
  let markErrors = 0;
  try {
    const allSessions = await sessionsRepo.listAllSessions();
    for (const sess of allSessions) {
      if (sess.status === 'ACTIVE' || sess.status === 'PROCESSING') {
        try {
          await sessionsRepo.markError(sess.sessionId, 'WORKTREE_UNIFICATION_MIGRATION');
          markedCount++;
        } catch (err) {
          markErrors++;
          log('warn', `[unification-migration] mark failed for ${sess.sessionId}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log('error', `[unification-migration] sessions scan failed: ${err.message}`);
  }

  // Step 3: touch sentinel.
  try {
    mkdirSync('/var/lib/futurator-daemon', { recursive: true });
    writeFileSync(SENTINEL, `${new Date().toISOString()}\n`);
  } catch (err) {
    log('warn', `[unification-migration] sentinel write failed: ${err.message}`);
  }

  log(
    'info',
    `[unification-migration] complete: oldRoot=${rmStatus}, ` +
      `sessionsMarked=${markedCount}, markErrors=${markErrors}`,
  );
  return { ran: true, rmStatus, markedCount, markErrors };
}
```

Wire into `agent-daemon.mjs` startup (before the first poll-loop iteration):

```diff
@@ daemon/agent-daemon.mjs (after sessionsRepo facade is built, before poll loop starts)

+ // 2026-05-XX (unification) — one-shot migration; sentinel-gated.
+ await maybeRunUnificationMigration({
+   sessionsRepo: buildFreeAgentSessionsRepoFacade(),
+   log,
+ });
```

### 3.8 EDIT `daemon/pipelines/lib/free-agent-path-hook.sh` — confinement root path change

The hook itself reads `$FREE_AGENT_CONFINEMENT_ROOT` from env (set by the daemon at spawn time). The daemon now sets it to the new path:

```diff
@@ daemon/pipelines/free-agent-session.mjs (at spawn args build)

  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
-   FREE_AGENT_CONFINEMENT_ROOT: worktreeInfo.worktreePath,  // old: /home/ubuntu/free-agent-worktrees/<proj>/<full-uuid>/
+   FREE_AGENT_CONFINEMENT_ROOT: worktreeInfo.worktreePath,  // new: /home/ubuntu/worktrees/<proj>/_assist/<sid-short>/
    FREE_AGENT_SESSION_ID: sessionId,
  };
```

No actual code change — the same line, just the value now resolves to the new path. The hook script itself is unchanged. Worth re-running the existing hook adversarial tests against the new path to confirm path-confinement behavior carries over (it does — path-relative logic, not hardcoded).

### 3.9 EDIT `functions/shared/types/free-agent.ts` — document the new path shape

Add a comment block to `FreeAgentSession` near the existing fields, explaining the post-unification path semantics. No type field changes — `sessionId` stays as the full UUID; the short form is derived at use-time. But ADD an optional field:

```diff
@@ functions/shared/types/free-agent.ts

  export interface FreeAgentSession {
    sessionId: string;
+   /**
+    * 2026-05-XX (unification) — Per-session worktree path. Set by
+    * ensureWorktree when the bare-repo + worktree topology creates the
+    * session worktree. Pre-unification sessions have no value (those
+    * sessions are all EXPIRED by the migration script).
+    *
+    * Shape: /home/ubuntu/worktrees/<projectId>/_assist/<sessionIdShort>/
+    */
+   worktreePath?: string;
+   /** Per-session git branch — `assist/<projectId>/<sessionIdShort>`. */
+   branchName?: string;
    ...
  }
```

`worktreePath` + `branchName` are set by `ensureWorktree` and persisted at session-bootstrap time (mirror of party's `partyBranch` field).

### 3.10 EDIT `daemon/pipelines/lib/free-agent-worktree.mjs::writeAgentMd` template

AGENT.md generates a worktree-relative description; the branch name + worktree path in the template need to use the new shape. Most of this is automatic (the template already reads from caller-provided fields), but verify:

- Branch name in AGENT.md uses `branchNameFor(projectId, sessionId)` which now returns the short form
- Worktree path in AGENT.md is correctly the new shared-root path
- Hook script reference uses `import.meta.url`-relative resolution (already does, per the previous fix)

No code change unless the template hardcodes the old root anywhere; spot-check by reading the template literal output for a sample session.

### 3.11 WRITE tests

| Test file                                                                                 | Coverage                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon/lib/__tests__/worktree-reaper.test.mjs` (EXTEND)                                  | Add cases for `walkAssistWorktrees` + `classifyAssistWorktree` mirroring the party cases. Adversarial: stale terminal session, active session, missing-DDB-row orphan, lookup-not-wired (returns no-reap by design). |
| `daemon/lib/__tests__/free-agent-unification-migration.test.mjs` (NEW)                    | Idempotent (runs once, sentinel blocks second run); marks ACTIVE/PROCESSING sessions; tolerates missing old root; tolerates DDB scan errors.                                                                         |
| `daemon/pipelines/lib/__tests__/free-agent-worktree.test.mjs` (EDIT)                      | Existing tests using the old `FREE_AGENT_WORKTREES_ROOT` constant — update to expect the new path shape from `worktreePathFor`. New test: bare-repo-missing returns the documented error.                            |
| `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` (EXTEND) | New test for `findBySessionIdShort`: valid 8-char hex → match; invalid pattern → null; no-rows → null.                                                                                                               |

---

## 4 · PR plan

**Single PR. ~half-day total.** No subdivision needed since the changes are tightly coupled and the migration MUST land atomically with the code changes (you can't have the code looking at the new path while the old root is still alive).

**Acceptance criteria:**

1. `npx vitest run daemon/lib/__tests__/ daemon/pipelines/lib/__tests__/ functions/shared/repositories/__tests__/` — green
2. `npx vitest run daemon/pipelines/__tests__/free-agent-session.test.mjs` — green (existing tests pass against new path)
3. `npm run typecheck` — error count ≤ existing baseline
4. `./scripts/rsync-daemon.sh` — succeeds; daemon restarts cleanly
5. On first restart after PR lands: daemon log contains `[unification-migration] complete: oldRoot=removed, sessionsMarked=N, markErrors=0`
6. `ls /home/ubuntu/free-agent-worktrees/` returns "No such file or directory"
7. Operator opens a fresh free-agent chat on `snake-4`: daemon spawns `claude -p` with `cwd=/home/ubuntu/worktrees/snake-4/_assist/<sid-short>/`; tool calls render in the panel; `git status` (read-only allowed) shows the new branch
8. Operator opens a chat on a brownfield project that has NOT yet been migrated (e.g., a fresh import): session immediately errors with `BARE_REPO_MISSING` event; widget surfaces the migration instruction
9. Reaper hourly sweep includes the new `_assist` namespace: log line at end of sweep includes `assist N/M scanned/reaped`
10. Existing party + pipeline-v2 flows unaffected (regression suite passes)

---

## 5 · Risk register

| #   | Risk                                                                                                           | Severity                                  | Mitigation                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Operator has an active free-agent chat when unification deploys → session goes to EXPIRED mid-conversation     | Low impact (start new chat)               | Deploy during quiet window OR accept. Operator inconvenience is opening a new chat; no work is lost.                                             |
| 2   | Migration runs but sentinel write fails → next restart re-runs migration on already-clean state                | Very low                                  | Migration is idempotent: rm of non-existent dir is noop; mark-EXPIRED on already-EXPIRED row is also fine. Worst case: noise in logs on restart. |
| 3   | `findBySessionIdShort` returns no match for an existing worktree (operator manually created or DDB sync issue) | Low                                       | Classifier returns `session-row-missing` → reap. Conservative — operator's stale dir gets cleaned.                                               |
| 4   | Short-form sessionId collision (~10⁻¹⁰ probability with 100k sessions)                                         | Negligible                                | Same risk party already accepted in §9.1 Q5. First-match-wins on lookup.                                                                         |
| 5   | Hook path-confinement still works after path change                                                            | n/a (verified by re-running tests)        | Existing hook tests are path-relative; rerun confirms.                                                                                           |
| 6   | Bare-repo missing for non-migrated brownfield → free-agent fails with cryptic error                            | Low (mitigated by clear error event)      | Error event includes the exact admin migration command operator should run.                                                                      |
| 7   | Daemon migration script consumes too many DDB reads on first startup                                           | Low                                       | listAllSessions scans the full table; 90-day TTL keeps it bounded (~100s of rows at v1 scale). Runs once.                                        |
| 8   | Pipeline v2 + party reapers race with the assist reaper on shared worktree root                                | Low (verified per existing party rollout) | Already proven safe: party's `walkPartyWorktrees` runs alongside per-story walkers; same pattern applies to `_assist`.                           |
| 9   | AGENT.md generator emits stale path references (e.g., old absolute paths in templated text)                    | Low                                       | Step 3.10 spot-check; existing template uses callsite-supplied paths, not hardcoded.                                                             |
| 10  | Documentation drift: CLAUDE.md still references `/home/ubuntu/free-agent-worktrees/`                           | Low                                       | CLAUDE.md update is part of the PR (see §6).                                                                                                     |

---

## 6 · Documentation updates required in same PR

The PR must update:

- **`CLAUDE.md`** — add a new dated entry under "Recent changes" describing the unification, the new path, and the migration. The existing "2026-05-17 (Story 18.1 — Free Claude Code Agent foundation)" entry's reference to `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` should be marked superseded; the new entry takes precedence for current operator guidance.
- **`docs/concepts/party-push/plan.md`** — add a one-line note at the bottom of §10 (worktree agent's section) cross-referencing this addendum: "Free-agent worktrees unified under the shared root in a follow-up PR — see `docs/concepts/free-agent-unification.md`."
- **`docs/concepts/free-mode-agent-exploration.md`** — §3 (Today's posture) needs the path updated to the unified root. §5 (safety primitives) inventory table updates `daemon/lib/free-agent-gc.mjs` row to "merged into worktree-reaper.mjs (unified)".

---

## 7 · Cross-references for the implementing agent

Files this PR touches:

- `daemon/pipelines/lib/free-agent-worktree.mjs` (EDIT, §3.1)
- `daemon/lib/worktree-reaper.mjs` (EDIT, §3.2)
- `daemon/lib/free-agent-gc.mjs` (DELETE, §3.3)
- `daemon/lib/__tests__/free-agent-gc.test.mjs` (DELETE if present, §3.3)
- `functions/shared/repositories/free-agent-sessions-repository.ts` (EDIT, §3.4)
- `daemon/agent-daemon.mjs` (EDIT, §3.5 + §3.7 wiring)
- `daemon/pipelines/free-agent-session.mjs` (EDIT, §3.6)
- `daemon/lib/free-agent-unification-migration.mjs` (WRITE, §3.7)
- `functions/shared/types/free-agent.ts` (EDIT, §3.9)
- `daemon/lib/__tests__/worktree-reaper.test.mjs` (EXTEND, §3.11)
- `daemon/lib/__tests__/free-agent-unification-migration.test.mjs` (WRITE, §3.11)
- `daemon/pipelines/lib/__tests__/free-agent-worktree.test.mjs` (EDIT, §3.11)
- `functions/shared/repositories/__tests__/free-agent-sessions-repository.test.ts` (EXTEND, §3.11)
- `CLAUDE.md` (EDIT, §6)
- `docs/concepts/party-push/plan.md` (EDIT, §6 — one-line cross-ref)
- `docs/concepts/free-mode-agent-exploration.md` (EDIT, §6 — path updates)

Files this PR DOES NOT touch:

- `daemon/pipelines/lib/free-agent-path-hook.sh` — env-driven, no change
- `daemon/pipelines/lib/free-agent-commit-msg-hook.sh` — env-driven, no change
- `src/components/free-agent/**` — frontend unaware of path
- `functions/api/index.ts` free-agent routes — operate on sessionId, not paths
- `sst.config.ts` — IAM role + tables are path-agnostic
- Any pipeline-v2 or party-specific code — different agent classes

---

## 8 · Out of scope for this PR

These are deliberate non-goals:

- **Branch namespace migration in DDB.** Existing events in `futurator-agent-events` referencing the old long-form branch names stay as-is (the migration script doesn't rewrite them). Only NEW events use the short form. Forensic queries against pre-migration data work normally; the convention shifts going forward only.
- **Renaming the role / domain terms.** "Free agent" stays the name. Path uses `_assist` (mirroring the branch name `assist/`) so the disk path describes what the worktree IS, not what subsystem owns it. Both conventions coexist.
- **Cross-class worktree sharing.** Free-agent does NOT share a worktree with party or pipeline-v2 sessions even when they're for the same app. Each session gets its own worktree. That's the same isolation guarantee as today.
- **Operator UI surface.** No UI changes. The widget reads sessionId, not paths. The audit endpoint already returns abstract event timelines.
- **Capability ladder progression.** This PR does NOT advance free-agent up the capability ladder. Assist branches still don't push to GitHub. Rung 1 (open PRs) lands in a SEPARATE follow-up PR after this one — see [`docs/concepts/free-mode-agent-exploration.md`](./free-mode-agent-exploration.md) §7.

---

## 9 · When to start

**Prerequisites:**

1. Party-push PR 0 + PR 1 (per `docs/concepts/party-push/plan.md` §12.5) must be in production. Verify by:
   - `daemon/pipelines/lib/cancel-poller.mjs` exists and is wired into both party-turn and free-agent-session
   - `daemon/lib/worktree-reaper.mjs` includes the `_party` namespace walker
   - Brownfield migration admin action (§12.3.3) is functional — `POST /api/admin/migrate-brownfield/:projectId` returns success for at least one converted project
2. At least one quiet window with no active free-agent sessions, OR operator acknowledgement that in-flight free-agent sessions WILL be killed by the migration (most realistic — there are very few concurrent sessions in practice).

**Sequencing relative to other in-flight work:**

| Timing                                      | Recommendation                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| **Sequential after party-push PR 1**        | Safest — clean blast radius, no contention with party's daemon work         |
| **In parallel with party-push PR 2 + PR 3** | Acceptable — those PRs are UI-side; this PR is daemon-side; no file overlap |
| **Before party-push PR 1**                  | ❌ Refuse — depends on cancel-poller + worktree-reaper substrate from PR 0  |

The implementing agent should refresh-read this doc, refresh-read `docs/concepts/party-push/plan.md` §10 (the worktree agent's specifics on namespace conventions + reaper extension pattern), and then run §3.1–3.11 in order.

---

## 10 · Why this matters for the operator's bigger goal

This addendum is small (~half-day) but enables three things the operator named as priorities:

1. **One mental model for "what's the daemon doing on snake-4?"** — `ls /home/ubuntu/worktrees/snake-4/` shows free-agent sessions + party debates + pipeline-v2 plans, all together. Today you have to know to also check `/home/ubuntu/free-agent-worktrees/snake-4/`.

2. **Free-agent's eventual Rung 1 (open PRs) costs ~2h instead of ~half-day** because the commit composer, PAT loader, hook substrate, and worktree reaper are all already wired for the unified path. The party-push primitives become turnkey for free-agent. See free-mode-agent-exploration.md §7 phasing.

3. **Multi-agent collaboration via GitHub branches works uniformly.** A free-agent assist branch can be continued by a future cloud worker (or your laptop's Claude Code) by checking out `assist/<app>/<sid-short>` against the same bare repo. Today the separate-root architecture makes that handoff awkward; after this PR, every agent class checks out from the same bare repo via `git worktree add`. The collaboration substrate is uniform.

These three are direct consequences of unification, not separate features. Shipping the addendum unblocks all of them.

---

_End of addendum plan. Next: party-push PR 0 + PR 1 land → operator confirms quiet window → implementing agent picks up §3.1._
