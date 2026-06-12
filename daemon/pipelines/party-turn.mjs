/**
 * Party Turn Pipeline — runs one user→agent turn in an existing party session.
 *
 * Contract (tech-spec §"Party Turn Execution"):
 *   - Input: { sessionId, content } via job.partyTurnPayload
 *   - Precondition: session already PROCESSING (API layer acquired the lock)
 *   - Turn 1 (turnCount=0 and no claudeSessionId): prompt is
 *       "/bmad:core:workflows:party-mode\n\n<user content>"
 *     and Claude generates a fresh session. The `system.init` stream event
 *     exposes its `session_id`, which we persist as `claudeSessionId`.
 *   - Turn N (N≥2): prompt is just <user content>, and we pass
 *     `--resume <claudeSessionId>` so Claude restores prior context.
 *   - On normal exit: release lock to ACTIVE, increment turnCount.
 *   - On idle-watchdog fire (10 min of stream silence) OR absolute ceiling
 *     (40 min total): SIGTERM then SIGKILL, attempt salvage commit of any
 *     work the agent landed in the worktree, then release lock to ERROR.
 *   - On non-zero exit: release lock to ERROR.
 *   - All events are keyed by sessionId (not the turn job's jobId) so the UI
 *     gets one continuous event stream per session across N turns.
 */

import { spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';

// Idle-watchdog timeout — how long the daemon will tolerate ZERO stream
// activity from the Claude CLI before declaring the child hung. Reset on
// every stdout chunk. 10 min of silence is generous; in practice a healthy
// turn emits a stream-json line every few seconds (assistant tokens, tool
// invocations, even the orchestrator's `system.init`).
//
// Why activity-based: 2026-06-05 — a PRD-writing turn was actively writing
// 11 markdown files in parallel Write batches when a fixed total-elapsed
// 10-min timer killed it at the cap. The work was healthy and progressing;
// the timer just didn't know. An activity watchdog distinguishes "hung CLI"
// from "task is genuinely big" — exactly what we want.
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
// Absolute ceiling — last-resort safety net. Even with the activity
// watchdog, a pathological loop (agent stuck in a tight tool-call cycle
// emitting tokens forever) needs a hard wall. 40 min is well past any
// legitimate single-turn budget; if a turn is still running at 40 min, the
// task should be decomposed across turns rather than waited out further.
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 2_400_000;
// Kept as a back-compat alias for callers / tests that still pass
// `timeoutMs`. New code should use `idleTimeoutMs` / `absoluteTimeoutMs`
// explicitly.
const DEFAULT_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
const KILL_GRACE_MS = 5_000;
// Mirrors functions/shared/types/party.ts DEFAULT_ALLOWED_TOOLS. Kept inline
// because the daemon is a separate node module with its own deps and can't
// import TypeScript directly. If you add a tool here, also add it to the
// TOGGLEABLE_TOOLS list in shared/types/party.ts so the UI can flip it.
const DEFAULT_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'];
// BMAD 6.3.x invokes party-mode as a Claude Code skill (`/bmad-party-mode`).
// The older `/bmad:core:workflows:party-mode` slash-command is a workflow
// path and no longer exists post-6.3.x.
const PARTY_MODE_PREFIX = '/bmad-party-mode';

// ── Story 20.7 (party-push Epic 20) imports ──────────────────────────────
// Lazy/conditional to keep the legacy code path zero-cost when
// PARTY_PUSH_V1_ENABLED is unset.
import {
  existsSync as fsExistsSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
  rmSync as fsRmSync,
  readdirSync as fsReaddirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { startCancelPoller } from './lib/cancel-poller.mjs';
import { extractMarkers } from './lib/party-marker-extractor.mjs';
import { composeAgentCommit } from './lib/agent-commit-composer.mjs';
import {
  setupPartyWorktree,
  teardownPartyWorktree,
  WorktreeSetupError,
} from './lib/party-worktree.mjs';
import { syncMainToOrigin } from '../lib/bare-repo-sync.mjs';

// ── Scoped doc delivery (party-docs session/shared scoping) ──────────────
// S3 is the source of truth for uploaded docs. At the start of every turn we
// mirror (shared ∪ this session) into the worktree's `.party-uploads/` so the
// agent reads exactly THIS debate's docs — no cross-session leak. The dir is
// git-excluded by party-checkpoint.sh so reference files are never committed
// or pushed. See functions/api/index.ts doc routes for the S3 key layout.
const PARTY_DOCS_BUCKET = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';
const PARTY_DOCS_S3_PREFIX = 'party-docs';
const PARTY_UPLOADS_DIRNAME = '.party-uploads';

function runAwsS3CpRecursive(source, dest) {
  return new Promise((resolve) => {
    const child = realSpawn(
      'aws',
      ['s3', 'cp', '--recursive', '--only-show-errors', source, dest],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ ok: false, stderr: 'spawn-failed' }));
    child.on('close', (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
  });
}

/**
 * Mirror this session's scoped docs (shared ∪ session) from S3 into
 * `<worktree>/.party-uploads/`, replacing whatever was there before so
 * deletes propagate. Best-effort: any failure returns `[]` and the turn
 * proceeds (a doc-sync hiccup must never abort a debate).
 *
 * @returns {Promise<string[]>} delivered filenames (basename only)
 */
async function syncSessionDocsToWorktree({ projectId, sessionId, worktreePath, logger }) {
  if (!projectId || !sessionId || !worktreePath) return [];
  if (!fsExistsSync(worktreePath)) return [];
  const uploadsDir = pathJoin(worktreePath, PARTY_UPLOADS_DIRNAME);
  try {
    fsRmSync(uploadsDir, { recursive: true, force: true });
    fsMkdirSync(uploadsDir, { recursive: true });
  } catch (err) {
    logger?.warn?.(`[party-turn] could not reset ${uploadsDir}: ${err.message}`);
    return [];
  }
  const base = `s3://${PARTY_DOCS_BUCKET}/${PARTY_DOCS_S3_PREFIX}/${projectId}`;
  // Shared first, then session — session wins on a filename collision.
  await runAwsS3CpRecursive(`${base}/_shared/`, `${uploadsDir}/`);
  await runAwsS3CpRecursive(`${base}/_session/${sessionId}/`, `${uploadsDir}/`);
  try {
    return fsReaddirSync(uploadsDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * System-prompt fragment listing the delivered docs by their worktree-relative
 * path. Appended to PARTY_FORMAT_CONTRACT each turn so the agent re-learns the
 * doc set even on `--resume`. Empty string when there are no docs.
 */
function buildDocsNote(filenames) {
  if (!filenames || filenames.length === 0) return '';
  const list = filenames.map((f) => `- ./${PARTY_UPLOADS_DIRNAME}/${f}`).join('\n');
  return [
    '',
    '',
    '## Reference documents for this debate',
    '',
    'The operator attached these files for this debate. Read them with the Read',
    'tool when relevant. They are reference material — do NOT edit them; the',
    'system does not commit or push them to git.',
    '',
    list,
  ].join('\n');
}

// ── Opt-in auto-PR (project.autoOpenPr) ──────────────────────────────────
// After a successful checkpoint push, open (or reuse) a DRAFT PR from the
// debate branch into the canonical branch so the generated deliverables are
// immediately reviewable. Mirrors the idempotent logic of the explicit
// Open-PR API route (functions/api/index.ts) but runs daemon-side using the
// per-project PAT — no API auth round-trip. Self-contained REST via fetch.
function parseOwnerRepo(gitRepoUrl) {
  const m = String(gitRepoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function ghFetch(path, pat, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'futurator-party-daemon',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, ok: res.ok, json };
}

async function openOrReuseDraftPr({
  project,
  branch,
  sha,
  title,
  summary,
  sessionId,
  loadPat,
  logger,
  // 2026-06-12 — open a ready (non-draft) PR when the caller intends to
  // immediately merge it (autoMerge). Defaults to draft for the
  // review-first autoOpenPr path.
  draft = true,
}) {
  if (typeof loadPat !== 'function') return { ok: false, reason: 'NO_PAT_LOADER' };
  const or = parseOwnerRepo(project?.gitRepoUrl);
  if (!or) return { ok: false, reason: 'BAD_GITREPO_URL' };
  const { owner, repo } = or;
  const base = project?.gitBranch || 'main';

  let pat = null;
  try {
    pat = await loadPat(project?.patSecretName);
  } catch (err) {
    logger?.warn?.(`[party-turn] auto-PR loadPat failed: ${err.message}`);
  }
  if (!pat) return { ok: false, reason: 'NO_PAT' };

  const head = `${owner}:${branch}`;
  // Idempotent: reuse an existing open PR for this head branch.
  const existing = await ghFetch(
    `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=5`,
    pat,
  );
  if (existing.ok && Array.isArray(existing.json) && existing.json.length > 0) {
    const pr = existing.json[0];
    return {
      ok: true,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prNodeId: pr.node_id,
      isDraft: pr.draft === true,
      reused: true,
    };
  }

  const prTitle = (title && title.trim()) || `Party debate ${String(sessionId).slice(0, 8)}`;
  const body = [
    summary || 'Opened automatically from a Futurator party-mode debate.',
    '',
    `Source commit: \`${sha || 'unknown'}\``,
    `Session: \`${sessionId}\``,
    '',
    '🤖 Auto-opened by party-push.',
  ].join('\n');

  const created = await ghFetch(`/repos/${owner}/${repo}/pulls`, pat, {
    method: 'POST',
    body: JSON.stringify({
      title: prTitle.slice(0, 250),
      head: branch,
      base,
      body: body.slice(0, 65000),
      draft,
    }),
  });
  if (created.ok && created.json) {
    return {
      ok: true,
      prNumber: created.json.number,
      prUrl: created.json.html_url,
      prNodeId: created.json.node_id,
      isDraft: created.json.draft === true,
      reused: false,
    };
  }
  // 422 "already exists" race → refetch and reuse.
  if (created.status === 422) {
    const refetch = await ghFetch(
      `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=5`,
      pat,
    );
    if (refetch.ok && Array.isArray(refetch.json) && refetch.json.length > 0) {
      const pr = refetch.json[0];
      return {
        ok: true,
        prNumber: pr.number,
        prUrl: pr.html_url,
        prNodeId: pr.node_id,
        isDraft: pr.draft === true,
        reused: true,
      };
    }
  }
  return {
    ok: false,
    reason: created.json?.message ? `GH_${created.status}: ${created.json.message}` : `GH_${created.status}`,
  };
}

/**
 * 2026-06-12 — auto-merge a party PR (mark ready if needed, then squash-merge).
 * Used by the autoMerge path after the PR is opened non-draft. Best-effort
 * mark-ready covers the reuse-of-an-old-draft case.
 */
async function squashMergePartyPr({ project, prNumber, prNodeId, isDraft, loadPat, logger }) {
  if (typeof loadPat !== 'function') return { ok: false, reason: 'NO_PAT_LOADER' };
  const or = parseOwnerRepo(project?.gitRepoUrl);
  if (!or) return { ok: false, reason: 'BAD_GITREPO_URL' };
  const { owner, repo } = or;
  let pat = null;
  try {
    pat = await loadPat(project?.patSecretName);
  } catch (err) {
    logger?.warn?.(`[party-turn] auto-merge loadPat failed: ${err.message}`);
  }
  if (!pat) return { ok: false, reason: 'NO_PAT' };

  // Clear draft (best-effort) so the REST merge isn't 405'd.
  if (isDraft && prNodeId) {
    await ghFetch('/graphql', pat, {
      method: 'POST',
      body: JSON.stringify({
        query:
          'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
        variables: { id: prNodeId },
      }),
    }).catch(() => {});
  }

  const merged = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, pat, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  if (merged.ok && merged.json?.merged) {
    return { ok: true, mergeSha: merged.json.sha };
  }
  return {
    ok: false,
    reason: merged.json?.message ? `GH_${merged.status}: ${merged.json.message}` : `GH_${merged.status}`,
  };
}

function resolvePartyToolHookPath() {
  // Lazy: only resolves when V1 actually fires. Some test environments
  // load this module with a non-file: import.meta.url which would throw
  // `URL must be of scheme file` at import time.
  try {
    return fileURLToPath(new URL('./lib/party-tool-hook.sh', import.meta.url));
  } catch {
    return pathJoin(pathDirname(fileURLToPath(import.meta.url)), 'lib/party-tool-hook.sh');
  }
}

/**
 * Story 21.4 — lazy resolver for party-checkpoint.sh. Same import.meta.url
 * guard as the hook resolver — the test environment uses non-file URLs.
 */
function resolvePartyCheckpointScriptPath() {
  try {
    return fileURLToPath(new URL('./lib/party-checkpoint.sh', import.meta.url));
  } catch {
    return pathJoin(pathDirname(fileURLToPath(import.meta.url)), 'lib/party-checkpoint.sh');
  }
}

/**
 * Story 20.7 feature flag. When set to '1' the daemon switches to the
 * party-push wired path: per-session worktree cwd assertion, shared
 * cancel-poller, `--settings` + `bypassPermissions`, default-allow audit
 * ingest, marker extraction. Default OFF for safety until operator
 * confirms the smoke test on `applicator`.
 */
function isPartyPushV1Enabled() {
  const v = process.env.PARTY_PUSH_V1_ENABLED;
  return v === '1' || v === 'true';
}

/**
 * Returns `/tmp/party-settings-<sessionIdShort>.json`. Per `plan.md` §12.1.2,
 * settings live OUTSIDE the worktree so a stray `git add -A` inside the
 * checkpoint can't sweep them into the commit.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function getPartySettingsPath(sessionId) {
  return `/tmp/party-settings-${sessionId.slice(0, 8)}.json`;
}

/**
 * Write the per-session Claude Code settings.json with the PreToolUse
 * party-tool-hook reference. Idempotent: if the file already exists with
 * identical content, this is a no-op. Story 20.7 AC 3.
 */
function writePartySettings(sessionId) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: resolvePartyToolHookPath() }],
        },
      ],
    },
  };
  const path = getPartySettingsPath(sessionId);
  const payload = JSON.stringify(settings, null, 2);
  fsWriteFileSync(path, payload, { mode: 0o600 });
  return path;
}

// Format contract — appended to Claude's system prompt via --append-system-prompt
// so the UI can split a multi-agent response into per-agent cards reliably.
//
// Why open-only Unicode markers (⟪…⟫):
//   • Brackets U+27EA / U+27EB never appear in normal prose, code, or markdown,
//     so collisions with content are essentially impossible.
//   • Open-only (no close marker) keeps the stream small and matches the
//     observed pattern (`**Name:**` style with the next header terminating
//     the previous block). Lower cognitive load on the model = higher
//     compliance rate.
//
// The 23 names below come from the canonical roster (bmad/_cfg/agent-manifest
// .csv after the custom-agents overlay). The parser rejects any other name as
// "this is a section heading, not an agent" — that's how false positives like
// `**My hot take:**` get filtered out.
//
// Backwards compat: the client parser ALWAYS falls back to legacy
// `[emoji ]**Name:**` matching for sessions started before this contract
// shipped. So existing transcripts still render correctly.
// Compact format contract. Long contracts burn context budget and slow Claude
// down measurably; this version trades verbosity for clarity. Roster names
// must match the UI's allow-list — see src/components/labs/party/turn-parser.ts
// `ROSTER_NAMES`. The rest is style: open-only markers, one per line.
const PARTY_FORMAT_CONTRACT = [
  '## Party Mode output format',
  '',
  'Wrap each speaker in a single marker line. No close marker — the next',
  'marker terminates the previous block.',
  '',
  '- `⟪AGENT:Name⟫` — an agent contribution (Name from the roster below).',
  '- `⟪SYSTEM⟫` — your orchestrator notes (routing, summaries, hand-offs).',
  '',
  'Rules:',
  '1. Each marker MUST be preceded by a blank line AND start its own line.',
  '   ALWAYS write `\\n\\n⟪AGENT:Name⟫\\n` — never glue a marker to the end',
  '   of the previous sentence (e.g. `…analysis.⟪AGENT:Winston⟫` is WRONG).',
  '2. No `📋 **John:**` headers, no `---` decoration between agents.',
  '3. No roster table — the UI already shows an avatar rail.',
  '4. Inside blocks: normal GFM markdown (bold, lists, code, tables, etc).',
  '',
  'Roster names (exact spelling, case-sensitive):',
  'BMad Master, BMad Builder, Mary, John, Sally, Winston, Amelia, Paige, Bob,',
  'Murat, Carson, Dr. Quinn, Maya, Victor, Sophia, Ludwig, Pedrock, Dave ups!,',
  'Sean Tinel, Nimbus, Kube Rick, Sue Render, Rick.',
  '',
  'Example:',
  '```',
  '⟪SYSTEM⟫',
  'Bringing in John (PM) and Sally (UX) to debate the scoring system.',
  '',
  '⟪AGENT:John⟫',
  'Why do you want it more competitive? Who are you competing against?',
  '',
  '⟪AGENT:Sally⟫',
  'Two players, same score, totally different play styles — that means',
  'scoring rewards completion, not skill.',
  '',
  '⟪SYSTEM⟫',
  'Strong agreement on a combo multiplier. Want to dig deeper?',
  '```',
  '',
  // ── Story 20.8 (party-push Epic 20) — checkpoint + ASK_HUMAN markers ──
  // The party-marker-extractor (Story 20.1) pulls these out of assistant
  // text post-turn; the agent-commit-composer (Story 19.5) uses them to
  // shape commit titles + bodies. Without explicit teaching here, the
  // orchestrator emits free-form prose and the composer falls back to
  // lenient titles like "N files changed (auto)" — defeating the design.
  '## Saving your work to git',
  '',
  'The system handles all git operations. You do NOT run git commands. Edit and',
  'Write tools auto-approve; git mutation is hard-denied by the hook.',
  '',
  'WHERE to write matters. Deliverables you want kept (architecture docs, tech',
  'specs, ADRs, schemas) go in the repo under `docs/` (or the path the repo',
  "conventions dictate) — only those get committed and pushed. Files under",
  '`./.party-uploads/` are READ-ONLY reference inputs the operator attached for',
  'this debate; never write or edit there — that directory is deliberately',
  'excluded from every commit, so anything you put there is silently lost.',
  '',
  'When a round ends, if you produced files (Edit/Write/MultiEdit), the system',
  "auto-commits to this debate's git branch. To shape the commit's title and",
  'summary — what future readers (humans, other agents) will see in `git log` —',
  'emit ONE block at the end of your final round message:',
  '',
  '    [CHECKPOINT_SUMMARY]: <conventional-commit-style title, ≤100 chars>',
  '    <2-5 line summary describing what was decided and produced, ≤500 chars total>',
  '',
  'Example:',
  '    [CHECKPOINT_SUMMARY]: feat: cohort module architecture v0.1',
  '    Covers profile-maturity scoring, multitenancy model, DynamoDB schema,',
  '    and dashboard wireframes per round. Open: comms channel + facilitator search.',
  '',
  "If you didn't produce files this round, OMIT the block — the system skips",
  'the commit silently.',
  '',
  '## Asking the human for input',
  '',
  'If you need the operator to make a decision before continuing, emit:',
  '',
  '    [ASK_HUMAN]: <one-sentence question>',
  '',
  'and stop tool calls in the same round. The system pauses the debate, surfaces',
  "your question in the UI, and resumes with the operator's reply as the next",
  "turn's input.",
  '',
  'Use sparingly — most rounds should not need this. Genuine clarifications',
  "(\"commit message: 'feat:' or 'chore:'?\") count; rhetorical questions don't.",
].join('\n');

/**
 * @param {object} job        — agent-jobs row with partyTurnPayload
 * @param {object} ctx
 * @param {Function} ctx.pushEvent        — daemon's pushEvent(jobId, stepId, agentId, eventType, data)
 * @param {Function} ctx.getSession       — async (sessionId) → session row
 * @param {Function} ctx.setClaudeSessionId — async (sessionId, claudeSessionId)
 * @param {Function} ctx.incrementTurn    — async (sessionId)
 * @param {Function} ctx.releaseSessionLock — async (sessionId, finalStatus)
 * @param {string} ctx.claudeBin          — path to the `claude` binary
 * @param {typeof realSpawn} [ctx.spawn]  — injected for tests
 * @param {number} [ctx.timeoutMs]        — legacy alias for idleTimeoutMs (back-compat)
 * @param {number} [ctx.idleTimeoutMs]    — stream-silence budget (default 10 min)
 * @param {number} [ctx.absoluteTimeoutMs] — hard ceiling regardless of activity (default 40 min)
 * @param {() => number} [ctx.now]        — time source for tests
 */
export async function runPartyTurn(job, ctx) {
  const payload = job.partyTurnPayload || {};
  const { sessionId, content } = payload;
  if (!sessionId || typeof content !== 'string' || content.length === 0) {
    throw new Error('runPartyTurn: payload.sessionId and payload.content are required');
  }

  const {
    pushEvent,
    getSession,
    getProject,
    setClaudeSessionId,
    incrementTurn,
    releaseSessionLock,
    claudeBin = 'claude',
    spawn = realSpawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    // Activity-based watchdog (2026-06-05): idle = stream silence; absolute
    // = total elapsed. Both default to constants above; `timeoutMs` is
    // accepted as a back-compat alias for `idleTimeoutMs` so existing tests
    // / callers keep working without changes.
    idleTimeoutMs = timeoutMs,
    absoluteTimeoutMs = DEFAULT_ABSOLUTE_TIMEOUT_MS,
    env = {},
    logger = console,
    // Injectable for tests — defaults to the real S3→worktree mirror, which
    // shells `aws s3 cp`. Tests stub it to avoid real network calls.
    syncDocs = syncSessionDocsToWorktree,
    // Opt-in auto-PR opener. Defaults to the real GitHub-REST impl; tests
    // stub it. Resolves the per-project PAT via ctx.loadPat.
    openPr = openOrReuseDraftPr,
    // Opt-in auto-merge (2026-06-12). Squash-merges the opened PR; tests stub.
    mergePr = squashMergePartyPr,
    // Reaps the per-session worktree after a successful auto-merge (DONE).
    // Defaults to the real teardown; tests stub.
    reapWorktree = ({ projectId, sessionIdShort, logger: lg }) =>
      teardownPartyWorktree({
        projectId,
        sessionIdShort,
        log: (level, msg) => lg?.[level]?.(msg),
      }),
    loadPat,
  } = ctx;

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`runPartyTurn: session ${sessionId} not found`);
  }

  // ── Story 20.7 (party-push Epic 20) — pre-spawn gates ────────────────
  const partyPushV1 = isPartyPushV1Enabled();
  if (partyPushV1) {
    // (1) Lazy worktree setup. POST /api/party/sessions creates the session
    // row with `projectPath = project.path` (the LEGACY shared folder) and
    // never calls setupPartyWorktree, so on the first turn we materialize
    // the per-session worktree here. Story 20.6's setup is idempotent so
    // subsequent turns are a no-op (reuse). Persist the resolved
    // worktreePath + partyBranch back to the session row so audit + delete
    // cascade + checkpoint emission see them.
    //
    // CRITICAL CONSTRAINT (2026-05-23): only run lazy-setup when the
    // session is fresh (`claudeSessionId === null`). Claude Code namespaces
    // per-session state by cwd-hash in ~/.claude/projects/; switching cwd
    // between turns on an existing `--resume <id>` session breaks the
    // session lookup and the subprocess exits 1 with no useful output. So:
    //   - Fresh session (no claudeSessionId yet) → setup + persist + use worktree
    //   - Existing session (claudeSessionId set) but no worktreePath → leave
    //     it on the legacy shared folder for the rest of its life. New
    //     sessions created from this point will get the worktree path.
    //
    // Stays silent (no exception, no event) when V1 was off when the
    // session was created — operator may have re-enabled V1 mid-flight.
    let resolvedWorktreePath = session.worktreePath || null;
    let resolvedPartyBranch = session.partyBranch || null;
    const isFreshSession = !session.claudeSessionId;
    if (isFreshSession && (!resolvedWorktreePath || !resolvedPartyBranch)) {
      // 2026-05-30 — start every fresh debate from the LATEST main. For a
      // brownfield app (real GitHub repo, any org), sync main to origin/main
      // BEFORE forking the party worktree off main, so the debate sees the
      // latest pushed code (laptop / other machines). One-way, best-effort;
      // main only (plan/<slug> is EC2-owned). Greenfield apps skip (their
      // main is local-only). See daemon/lib/bare-repo-sync.mjs.
      try {
        if (typeof getProject === 'function' && session.projectId) {
          const proj = await getProject(session.projectId).catch(() => null);
          if (proj?.kind === 'brownfield') {
            // Sync 'main' — the party worktree forks off main (party-worktree),
            // so we align the synced branch with the fork point.
            await syncMainToOrigin({
              appId: session.projectId,
              branch: 'main',
              log: (level, msg) => logger?.[level]?.(msg),
            });
          }
        }
      } catch (syncErr) {
        logger?.warn?.(`[party-turn] pre-debate main sync failed (non-blocking): ${syncErr.message}`);
      }
      try {
        const setup = await setupPartyWorktree({
          projectId: session.projectId,
          sessionId,
          // 2026-05-30 — debate against a specific branch when the session
          // carries one (e.g. a plan/<slug> in execution); defaults to main
          // (synced above for brownfield). plan branches are used as-is.
          baseRef: session.baseRef || 'main',
          log: (level, msg) => logger?.[level]?.(msg),
        });
        resolvedWorktreePath = setup.worktreePath;
        resolvedPartyBranch = setup.branch;
        if (typeof ctx.sessionsRepo?.setWorktreePath === 'function') {
          try {
            await ctx.sessionsRepo.setWorktreePath(sessionId, {
              worktreePath: resolvedWorktreePath,
              partyBranch: resolvedPartyBranch,
            });
            // Mutate the in-memory session so the rest of this turn uses
            // the per-session worktree as cwd (instead of the legacy
            // shared folder it was created with).
            session.worktreePath = resolvedWorktreePath;
            session.partyBranch = resolvedPartyBranch;
            session.projectPath = resolvedWorktreePath;
          } catch (writeErr) {
            logger?.warn?.(
              `[party-turn] setWorktreePath persist failed (continuing in-memory only): ${writeErr.message}`,
            );
            session.projectPath = resolvedWorktreePath;
            session.worktreePath = resolvedWorktreePath;
            session.partyBranch = resolvedPartyBranch;
          }
        } else {
          // Repo doesn't expose setWorktreePath (older daemon code paths).
          // Still use the worktree for this turn — better than the shared folder.
          session.projectPath = resolvedWorktreePath;
          session.worktreePath = resolvedWorktreePath;
          session.partyBranch = resolvedPartyBranch;
        }
      } catch (setupErr) {
        await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
          sessionId,
          reason:
            setupErr instanceof WorktreeSetupError ? setupErr.reason : 'WORKTREE_SETUP_FAILED',
          message: setupErr.message || String(setupErr),
        });
        try {
          await releaseSessionLock(sessionId, 'ERROR');
        } catch {
          /* best effort */
        }
        throw setupErr;
      }
    }

    // (2) cwd assertion — defend against reaper-mid-flight. After the
    // lazy setup above, the worktree path SHOULD exist. If it doesn't,
    // the reaper raced us (rare) and the only safe action is to fail
    // loudly so the operator opens a new session.
    if (!fsExistsSync(session.projectPath)) {
      await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
        sessionId,
        reason: 'WORKTREE_MISSING',
        worktreePath: session.projectPath,
        message:
          'Per-session worktree no longer exists. Create a new session — this one is unrecoverable.',
      });
      try {
        await releaseSessionLock(sessionId, 'ERROR');
      } catch {
        /* best effort */
      }
      throw new Error(`WORKTREE_MISSING: ${session.projectPath}`);
    }

    // (3) Clear any stale cancel flag from a prior turn BEFORE spawning.
    // Otherwise a flag the operator never cleared could pre-cancel this
    // fresh turn. (cancel-poller's stop() also clears, but only at the
    // end of THIS turn — the pre-spawn clear handles cross-turn drift.)
    if (typeof ctx.sessionsRepo?.clearCancelFlag === 'function') {
      try {
        await ctx.sessionsRepo.clearCancelFlag(sessionId);
      } catch (err) {
        logger.warn?.(`[party-turn] clearCancelFlag (pre-spawn) failed: ${err.message}`);
      }
    }
  }

  // Mirror this session's scoped docs (shared ∪ session) from S3 into the
  // worktree's .party-uploads/ so the agent reads exactly this debate's docs.
  // Best-effort — never abort the turn on a doc-sync failure.
  let docsNote = '';
  try {
    const deliveredDocs = await syncDocs({
      projectId: session.projectId,
      sessionId,
      worktreePath: session.projectPath,
      logger,
    });
    docsNote = buildDocsNote(deliveredDocs);
    if (deliveredDocs.length > 0) {
      logger.info?.(
        `[party-turn] delivered ${deliveredDocs.length} doc(s) to ${PARTY_UPLOADS_DIRNAME}/ ` +
          `for session=${sessionId.slice(0, 8)}`,
      );
    }
  } catch (err) {
    logger.warn?.(`[party-turn] doc delivery failed (continuing): ${err.message}`);
  }

  // Resolve which extra tools (WebSearch, WebFetch, …) the user has
  // allowed for this project. Default → DEFAULT_ALLOWED_TOOLS so existing
  // projects work without a DDB migration. Empty array → user explicitly
  // disabled all extras (we still pass the flag with no values, which
  // claude treats as "no extra allowlist").
  let allowedTools = [...DEFAULT_ALLOWED_TOOLS];
  if (typeof getProject === 'function' && session.projectId) {
    try {
      const project = await getProject(session.projectId);
      if (project && Array.isArray(project.allowedTools)) {
        allowedTools = project.allowedTools.filter((t) => typeof t === 'string');
      }
    } catch (err) {
      logger.warn?.(`[party-turn] getProject failed (using defaults): ${err.message}`);
    }
  }

  // Emit user turn event immediately so the UI renders the user message even
  // before Claude has produced a token.
  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.user', {
    sessionId,
    turnCount: session.turnCount,
    content,
  });

  const isFirstTurn = !session.claudeSessionId;
  // Single-line `/slash-command <args>` form. Claude Code's slash-command
  // parser in -p mode treats the FIRST line as the command + its arguments;
  // a blank line between `/bmad-party-mode` and the user content was causing
  // Claude to see them as two separate messages and hallucinate "I don't
  // have that skill" (even though the skill is registered).
  const prompt = isFirstTurn ? `${PARTY_MODE_PREFIX} ${content}` : content;
  // Story 20.7 — party-push V1 swaps `acceptEdits` for `bypassPermissions`
  // and injects `--settings <tmp>` pointing at a settings.json with the
  // PreToolUse party-tool-hook reference. The hook (Story 20.3) provides
  // the load-bearing security boundary; bypassPermissions auto-approves
  // Edit/Write so the agent doesn't hang on confirm prompts in `-p` mode.
  let partySettingsPath = null;
  if (partyPushV1) {
    try {
      partySettingsPath = writePartySettings(sessionId);
    } catch (err) {
      logger.warn?.(
        `[party-turn] writePartySettings failed (falling back to legacy spawn args): ${err.message}`,
      );
      partySettingsPath = null;
    }
  }
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    partySettingsPath ? 'bypassPermissions' : 'acceptEdits',
    // Inject marker-based output contract. See PARTY_FORMAT_CONTRACT above.
    // Appended (not replaced) so BMAD's own party-mode skill prompt still
    // applies. The contract instructs Claude to wrap each agent in
    // `⟪AGENT:Name⟫` markers — the client parser splits on these.
    '--append-system-prompt',
    PARTY_FORMAT_CONTRACT + docsNote,
  ];
  if (partySettingsPath) {
    args.push('--settings', partySettingsPath);
  }
  // Pass the per-project tool allowlist. Without this, WebSearch/WebFetch
  // get auto-denied in `-p` mode (the default permission flow can't
  // surface a prompt) and agents fall back to model knowledge.
  if (allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }
  if (!isFirstTurn) {
    args.push('--resume', session.claudeSessionId);
  }

  logger.info?.(
    `[party-turn] spawning session=${sessionId.slice(0, 8)} firstTurn=${isFirstTurn} ` +
      `cwd=${session.projectPath}`,
  );

  const child = spawn(claudeBin, args, {
    cwd: session.projectPath,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(job.jobId, child);

  // ── Story 20.7 — shared cancel-poller wiring ─────────────────────────
  // When V1 is enabled AND the daemon has a sessionsRepo wired, poll the
  // session row for cancelRequested. Cancellation SIGTERMs the child and
  // flags isCancelled() so the close handler emits party.turn.cancelled
  // instead of a generic error.
  let cancelPoller = null;
  if (partyPushV1 && ctx.sessionsRepo) {
    try {
      cancelPoller = startCancelPoller({
        sessionsRepo: ctx.sessionsRepo,
        sessionId,
        child,
        logger,
      });
    } catch (err) {
      logger.warn?.(`[party-turn] startCancelPoller failed (continuing without): ${err.message}`);
      cancelPoller = null;
    }
  }

  // Signal that the Claude subprocess is live — UI uses this to replace the
  // generic "routing" indicator with a concrete "waiting on first token"
  // message. Happens immediately after spawn() returns, which is well
  // before Claude emits its first stream-json line (5–15 s cold start).
  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.started', {
    sessionId,
    turnCount: session.turnCount,
    isFirstTurn,
  });

  try {
    child.stdin?.write?.(prompt);
    child.stdin?.end?.();
  } catch {
    // fall through — child.on('error') and close path handles
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  let capturedClaudeSessionId = null;
  let timedOut = false;
  // Which watchdog fired — 'IDLE' (stream silence) or 'ABSOLUTE' (hard cap).
  // First-fire wins so the other can't overwrite once we're in shutdown.
  let timeoutReason = null;
  let idleTimer = null;
  let absoluteTimer = null;
  let killTimer = null;
  // Story 20.7 — accumulate assistant text across the turn so we can run
  // extractMarkers() once at close. Markers are emitted at the end of the
  // orchestrator's final round; mid-turn fragments don't matter.
  let assistantTextAccum = '';

  const fireTimeout = (reason) => {
    if (timedOut) return; // first watchdog wins
    timedOut = true;
    timeoutReason = reason;
    if (idleTimer) clearTimeout(idleTimer);
    if (absoluteTimer) clearTimeout(absoluteTimer);
    try {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // best effort
        }
      }, KILL_GRACE_MS);
    } catch {
      // best effort
    }
  };

  const resetIdle = () => {
    if (timedOut) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fireTimeout('IDLE'), idleTimeoutMs);
  };

  // Arm both timers immediately. The idle timer is rearmed on every stdout
  // chunk (see below); the absolute timer is set once and never reset, so
  // it acts as a true hard ceiling.
  resetIdle();
  absoluteTimer = setTimeout(() => fireTimeout('ABSOLUTE'), absoluteTimeoutMs);

  child.stdout?.on('data', (chunk) => {
    // Any byte from the CLI counts as activity — keep the idle watchdog
    // alive. Doing this on the chunk boundary (not per parsed JSON line)
    // means even a partial line keeps the turn breathing.
    resetIdle();
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      void handleStreamLine(line);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrBuf += text;
    // Story 20.7 — ingest party-tool-hook audit markers. Each occurrence
    // of `[party-tool-hook] default-allow cmd=<cmd>` becomes a
    // `party.tool.default-allow` event. Truncate cmd to 500 chars to bound
    // the event payload (matches the hook's own truncation cap).
    if (partyPushV1) {
      const lines = text.split('\n');
      for (const line of lines) {
        const m = /^\[party-tool-hook\] default-allow cmd=(.+)$/.exec(line);
        if (m) {
          void pushEvent(sessionId, 'turn', '__system__', 'party.tool.default-allow', {
            sessionId,
            cmd: m[1].slice(0, 500),
            turnCount: session.turnCount,
          }).catch((err) =>
            logger.warn?.(`[party-turn] default-allow event emit failed: ${err.message}`),
          );
        }
      }
    }
  });

  async function handleStreamLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line — keep a note for debugging but do not blow up the turn.
      logger.warn?.(`[party-turn] non-JSON line: ${line.slice(0, 120)}`);
      return;
    }
    const type = parsed?.type;
    if (type === 'system' && parsed?.subtype === 'init' && parsed?.session_id) {
      if (!capturedClaudeSessionId) {
        capturedClaudeSessionId = parsed.session_id;
        try {
          await setClaudeSessionId(sessionId, capturedClaudeSessionId);
        } catch (err) {
          logger.warn?.(
            `[party-turn] setClaudeSessionId failed (may already be set): ${err.message}`,
          );
        }
      }
      return;
    }
    if (type === 'assistant') {
      // Extract chunks from message.content. Text → assistant.token (renders
      // as orchestrator/agent prose). Tool calls → assistant.tool (renders
      // as a collapsible "Actions" log row). Surfacing tool calls lets the
      // user see what the orchestrator is exploring (Read, Glob, Bash, …)
      // before any agent text arrives — useful both as a progress signal
      // and as a debugging aid when agents reference specific files.
      const blocks = parsed?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          if (partyPushV1) assistantTextAccum += block.text;
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
            sessionId,
            text: block.text,
          });
        } else if (block?.type === 'tool_use') {
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.tool', {
            sessionId,
            tool: {
              id: block.id,
              name: block.name,
              // Trim oversized inputs so we don't blow the DDB 400 KB item
              // limit when Claude reads a giant file. The full payload only
              // matters for debugging — UI only shows the key params.
              input: truncateToolInput(block.input),
            },
          });
        }
      }
      return;
    }
    if (type === 'result') {
      // Final result payload — emitted as completion by the close handler.
      return;
    }
    // Unknown type — forward a generic passthrough for forward-compat.
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
      sessionId,
      raw: parsed,
    });
  }

  const exitCode = await new Promise((resolvePromise) => {
    child.on('error', (err) => {
      unregisterChild(job.jobId, child);
      logger.error?.(`[party-turn] spawn error: ${err.message}`);
      resolvePromise(-1);
    });
    child.on('close', (code) => {
      unregisterChild(job.jobId, child);
      resolvePromise(code ?? 0);
    });
  });

  if (idleTimer) clearTimeout(idleTimer);
  if (absoluteTimer) clearTimeout(absoluteTimer);
  if (killTimer) clearTimeout(killTimer);

  // Story 20.7 — stop the cancel-poller. `stop()` is async and always
  // clears the cancel flag on the session row (atomic-clear API per
  // Story 19.2 §13.2). Stop BEFORE the cancelled/error/completed branch
  // so the flag is unconditionally cleared regardless of exit path.
  const wasCancelled = cancelPoller ? cancelPoller.isCancelled() : false;
  if (cancelPoller) {
    try {
      await cancelPoller.stop();
    } catch (err) {
      logger.warn?.(`[party-turn] cancelPoller.stop failed: ${err.message}`);
    }
  }

  // Operator clicked Stop. Emit cancelled event + release lock back to
  // ACTIVE (not ERROR — the operator can resume with another message).
  if (wasCancelled) {
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.cancelled', {
      sessionId,
      reason: 'CANCELLED_BY_OPERATOR',
      exitCode,
    });
    await releaseSessionLock(sessionId, 'ACTIVE');
    return { ok: false, reason: 'CANCELLED', claudeSessionId: capturedClaudeSessionId };
  }

  if (timedOut) {
    // Salvage-on-TIMEOUT (2026-06-05) — run party-checkpoint.sh over the
    // worktree to commit anything the agent wrote before SIGTERM landed.
    // Without this, partial PRD-style work sits as untracked files until an
    // operator manually rescues them (which is exactly what happened with
    // session 7e524eea's round 10 — the bug that motivated this fix).
    //
    // Push opt-in is preserved: salvage commits respect project.pushEnabled
    // exactly like a normal round-end checkpoint. Auto-PR is NOT triggered
    // for salvage commits — a timed-out turn is by definition incomplete
    // and shouldn't trip the "ready for review" workflow.
    //
    // Non-fatal: if salvage fails, log + continue to the throw. Better to
    // surface the original TIMEOUT than mask it with a salvage error.
    let salvageSha = null;
    let salvagePushed = false;
    let salvageReason = null;
    if (
      partyPushV1 &&
      session.partyBranch &&
      (session.worktreePath || session.projectPath)
    ) {
      try {
        let resolvedProject = null;
        if (typeof getProject === 'function' && session.projectId) {
          try {
            resolvedProject = await getProject(session.projectId);
          } catch (err) {
            logger.warn?.(`[party-turn] getProject for salvage failed: ${err.message}`);
          }
        }
        const pushOptIn = resolvedProject?.pushEnabled === true;
        const salvageResult = await runCheckpointScript({
          sessionId,
          projectId: session.projectId,
          branch: session.partyBranch,
          worktreePath: session.worktreePath || session.projectPath,
          turnCount: session.turnCount,
          title: `salvage: round ${session.turnCount + 1} timed out (${timeoutReason})`,
          summary:
            `Watchdog fired (${timeoutReason}). Committing whatever the agent ` +
            `wrote before SIGTERM so the partial work is preserved on this branch.`,
          push: pushOptIn,
          spawnSync: ctx.spawnSync || realSpawnSync,
          logger,
        });
        salvageSha = salvageResult.sha || null;
        salvagePushed = salvageResult.pushed === true;
        salvageReason = salvageResult.reason;
        if (salvageSha) {
          logger.info?.(
            `[party-turn] salvage committed ${salvageSha.slice(0, 8)} ` +
              `(reason=${salvageReason}, pushed=${salvagePushed})`,
          );
          await pushEvent(sessionId, 'turn', '__party__', 'party.checkpoint.salvaged', {
            sessionId,
            projectId: session.projectId,
            branch: session.partyBranch,
            round: session.turnCount,
            commitSha: salvageSha,
            pushed: salvagePushed,
            reason: salvageReason,
            timeoutReason,
          });
        } else if (salvageReason === 'EMPTY') {
          logger.info?.(`[party-turn] salvage no-op (worktree porcelain empty)`);
        }
      } catch (err) {
        logger.warn?.(`[party-turn] salvage failed (non-fatal): ${err.message}`);
      }
    }
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
      sessionId,
      reason: 'TIMEOUT',
      timeoutReason,
      idleTimeoutMs,
      absoluteTimeoutMs,
      stderr: stderrBuf.slice(0, 4000),
      ...(salvageSha ? { salvageSha, salvagePushed, salvageReason } : {}),
    });
    await releaseSessionLock(sessionId, 'ERROR');
    throw new Error(
      `party-turn timeout (${timeoutReason}) — idle=${idleTimeoutMs}ms abs=${absoluteTimeoutMs}ms`,
    );
  }

  if (exitCode !== 0) {
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
      sessionId,
      reason: 'NON_ZERO_EXIT',
      exitCode,
      stderr: stderrBuf.slice(0, 4000),
    });
    await releaseSessionLock(sessionId, 'ERROR');
    throw new Error(`party-turn exited with code ${exitCode}`);
  }

  await incrementTurn(sessionId);
  await releaseSessionLock(sessionId, 'ACTIVE');

  // Story 20.7 — extract checkpoint + ASK_HUMAN markers from accumulated
  // assistant text. ASK_HUMAN immediately becomes an event the UI's
  // inline-questions list (Epic 22) will surface. CHECKPOINT_SUMMARY is
  // returned in the result so a future post-round hook (Story 20.2's
  // caller path) can run party-checkpoint.sh with the composed message.
  let checkpoint = null;
  if (partyPushV1 && assistantTextAccum.length > 0) {
    try {
      const { markers } = extractMarkers(assistantTextAccum);
      for (const marker of markers) {
        if (marker.kind === 'ASK_HUMAN') {
          await pushEvent(sessionId, 'turn', '__party__', 'party.agent.question', {
            sessionId,
            question: marker.title || '',
            turnCount: session.turnCount,
          });
        } else if (marker.kind === 'CHECKPOINT_SUMMARY') {
          checkpoint = { title: marker.title || '', body: marker.body || '' };
        }
      }
    } catch (err) {
      logger.warn?.(`[party-turn] extractMarkers failed (non-fatal): ${err.message}`);
    }
  }

  // Story 21.4 — when V1 is enabled AND a CHECKPOINT_SUMMARY was extracted
  // AND the session has a partyBranch + worktreePath (Story 20.6 bootstrap
  // populated these), run party-checkpoint.sh. The script is idempotent
  // for the empty-porcelain case, so running it without changes is cheap.
  // The --push flag is set iff the project has opted into push (Story 21.2).
  let checkpointSha = null;
  let checkpointPushed = false;
  if (
    partyPushV1 &&
    checkpoint &&
    session.partyBranch &&
    (session.worktreePath || session.projectPath)
  ) {
    try {
      // Resolve the project once. If getProject is unwired or throws, default
      // to commit-only (pushOptIn=false) and no auto-PR.
      let resolvedProject = null;
      if (typeof getProject === 'function' && session.projectId) {
        try {
          resolvedProject = await getProject(session.projectId);
        } catch (err) {
          logger.warn?.(`[party-turn] getProject for checkpoint failed: ${err.message}`);
        }
      }
      const pushOptIn = resolvedProject?.pushEnabled === true;
      const checkpointResult = await runCheckpointScript({
        sessionId,
        projectId: session.projectId,
        branch: session.partyBranch,
        worktreePath: session.worktreePath || session.projectPath,
        turnCount: session.turnCount,
        title: checkpoint.title,
        summary: checkpoint.body,
        push: pushOptIn,
        spawnSync: ctx.spawnSync || realSpawnSync,
        logger,
      });
      checkpointSha = checkpointResult.sha || null;
      checkpointPushed = checkpointResult.pushed === true;
      // Emit the appropriate checkpoint event. The event the UI cares
      // about (Story 22.5) is either .pushed or .composed.
      const evtType =
        checkpointResult.code === 2
          ? 'party.checkpoint.blocked'
          : checkpointResult.code === 0 && checkpointResult.pushed
            ? 'party.checkpoint.pushed'
            : checkpointResult.code === 0
              ? 'party.checkpoint.composed'
              : 'party.checkpoint.failed';
      await pushEvent(sessionId, 'turn', '__party__', evtType, {
        sessionId,
        projectId: session.projectId,
        branch: session.partyBranch,
        round: session.turnCount,
        title: checkpoint.title,
        summary: checkpoint.body,
        commitSha: checkpointSha,
        pushed: checkpointPushed,
        exitCode: checkpointResult.code,
        reason: checkpointResult.reason,
      });

      // Opt-in auto-PR: after a successful PUSH, open (or reuse) a PR into the
      // canonical branch. Gated on project.autoOpenPr; the explicit Open-PR
      // button works independently of this. Non-fatal on failure.
      //
      // 2026-06-12 — when project.autoMerge is also on, "publish = finish":
      // open the PR non-draft, squash-merge it, reap the per-session worktree,
      // and mark the session DONE. The Claude subprocess has already exited by
      // this point, so reaping the worktree here is safe for this turn; the
      // DONE status makes the debate terminal (tryAcquireSessionLock excludes
      // it). Reversibility lives in GitHub history.
      const autoMergeOn = resolvedProject?.autoMerge === true;
      if (checkpointPushed && resolvedProject?.autoOpenPr === true) {
        try {
          const prResult = await openPr({
            project: resolvedProject,
            branch: session.partyBranch,
            sha: checkpointSha,
            title: checkpoint.title,
            summary: checkpoint.body,
            sessionId,
            loadPat,
            logger,
            draft: !autoMergeOn,
          });
          await pushEvent(
            sessionId,
            'turn',
            '__party__',
            prResult?.ok ? 'party.checkpoint.pr.opened' : 'party.checkpoint.pr.failed',
            {
              sessionId,
              projectId: session.projectId,
              branch: session.partyBranch,
              round: session.turnCount,
              commitSha: checkpointSha,
              prNumber: prResult?.prNumber ?? null,
              prUrl: prResult?.prUrl ?? null,
              reused: prResult?.reused === true,
              reason: prResult?.reason ?? null,
            },
          );
          if (prResult?.ok) {
            logger.info?.(
              `[party-turn] auto-PR ${prResult.reused ? 'reused' : 'opened'} ` +
                `#${prResult.prNumber} for session=${sessionId.slice(0, 8)}`,
            );
          } else {
            logger.warn?.(`[party-turn] auto-PR not opened: ${prResult?.reason || 'unknown'}`);
          }

          // Auto-merge → finish.
          if (autoMergeOn && prResult?.ok && prResult.prNumber) {
            const mergeRes = await mergePr({
              project: resolvedProject,
              prNumber: prResult.prNumber,
              prNodeId: prResult.prNodeId,
              isDraft: prResult.isDraft === true,
              loadPat,
              logger,
            });
            if (mergeRes?.ok) {
              await pushEvent(sessionId, 'turn', '__party__', 'party.checkpoint.merged', {
                sessionId,
                projectId: session.projectId,
                branch: session.partyBranch,
                round: session.turnCount,
                prNumber: prResult.prNumber,
                prUrl: prResult.prUrl ?? null,
                mergeSha: mergeRes.mergeSha ?? null,
              });
              let worktreeReaped = false;
              try {
                const reap = await reapWorktree({
                  projectId: session.projectId,
                  sessionIdShort: sessionId.slice(0, 8),
                  logger,
                });
                worktreeReaped = reap?.removed === true;
              } catch (err) {
                logger.warn?.(`[party-turn] auto-merge worktree reap failed: ${err.message}`);
              }
              try {
                await releaseSessionLock(sessionId, 'DONE');
              } catch (err) {
                logger.warn?.(`[party-turn] set DONE failed: ${err.message}`);
              }
              await pushEvent(sessionId, 'turn', '__party__', 'party.session.done', {
                sessionId,
                projectId: session.projectId,
                prNumber: prResult.prNumber,
                prUrl: prResult.prUrl ?? null,
                mergeSha: mergeRes.mergeSha ?? null,
                worktreeReaped,
              });
              logger.info?.(
                `[party-turn] auto-merged + finished session=${sessionId.slice(0, 8)} ` +
                  `(reaped=${worktreeReaped})`,
              );
            } else {
              await pushEvent(sessionId, 'turn', '__party__', 'party.checkpoint.merge.failed', {
                sessionId,
                projectId: session.projectId,
                prNumber: prResult.prNumber,
                prUrl: prResult.prUrl ?? null,
                reason: mergeRes?.reason ?? 'unknown',
              });
              logger.warn?.(
                `[party-turn] auto-merge failed (PR left open): ${mergeRes?.reason || 'unknown'}`,
              );
            }
          }
        } catch (err) {
          logger.warn?.(`[party-turn] auto-PR/merge failed (non-fatal): ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn?.(`[party-turn] runCheckpointScript failed (non-fatal): ${err.message}`);
    }
  }

  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.completed', {
    sessionId,
    claudeSessionId: capturedClaudeSessionId,
    exitCode,
    ...(checkpoint ? { checkpoint } : {}),
    ...(checkpointSha ? { checkpointSha, checkpointPushed } : {}),
  });

  return {
    ok: true,
    claudeSessionId: capturedClaudeSessionId,
    ...(checkpoint ? { checkpoint } : {}),
    ...(checkpointSha ? { checkpointSha, checkpointPushed } : {}),
  };
}

/**
 * Story 21.4 — runs party-checkpoint.sh as a subprocess for one turn. Pure
 * IO + composer wrap; logic-light so it's easy to mock in tests.
 *
 * Returns:
 *   { code, sha, pushed, reason }
 *
 *   code   — script exit (0 success/empty, 2 secrets, 3 branch mismatch,
 *            4 worktree missing, 5 push attempted but failed).
 *   sha    — 40-char SHA from the last stdout line when committed; null when empty.
 *   pushed — true when the script's stdout contains 'PUSHED: ' (exit 0 + --push).
 *   reason — short token suitable for an event payload (PUSHED|COMPOSED|EMPTY|
 *            SECRETS_HIT|BRANCH_MISMATCH|WORKTREE_MISSING|PUSH_FAILED|OTHER).
 */
async function runCheckpointScript(opts) {
  const {
    sessionId,
    projectId,
    branch,
    worktreePath,
    turnCount,
    title,
    summary,
    push,
    spawnSync,
    logger,
  } = opts;
  const composed = composeAgentCommit({
    kind: 'party',
    title: title || '(untitled)',
    summary: summary || '',
    sessionId,
    projectId,
    round: turnCount,
    trigger: 'round-end-auto',
  });
  const scriptPath = resolvePartyCheckpointScriptPath();
  const args = [scriptPath, branch, worktreePath];
  if (push) args.push('--push');
  const result = spawnSync('bash', args, {
    input: composed.message,
    encoding: 'utf-8',
    env: process.env,
  });
  const stdout = (result.stdout || '').toString();
  const stderr = (result.stderr || '').toString();
  const code = result.status;
  // Last non-empty line of stdout is the SHA (or STATUS_PORCELAIN_EMPTY).
  const lastLine = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const isSha = typeof lastLine === 'string' && /^[a-f0-9]{40}$/.test(lastLine);
  const sha = isSha ? lastLine : null;
  const pushed = code === 0 && stdout.includes('PUSHED:');
  let reason = 'OTHER';
  if (code === 0 && lastLine === 'STATUS_PORCELAIN_EMPTY') reason = 'EMPTY';
  else if (code === 0 && pushed) reason = 'PUSHED';
  else if (code === 0 && stdout.includes('PUSH_SKIPPED')) reason = 'COMPOSED';
  else if (code === 2) reason = 'SECRETS_HIT';
  else if (code === 3) reason = 'BRANCH_MISMATCH';
  else if (code === 4) reason = 'WORKTREE_MISSING';
  else if (code === 5) reason = 'PUSH_FAILED';
  if (code !== 0 && code !== null) {
    logger?.warn?.(
      `[party-turn] party-checkpoint.sh exit=${code} reason=${reason} stderr=${stderr.slice(0, 400)}`,
    );
  }
  return { code, sha, pushed, reason };
}

/**
 * Tool inputs can carry huge strings (file contents from Read, multi-KB
 * Bash output, big JSON blobs from MCP servers). DDB items are capped at
 * 400 KB and we want plenty of headroom — string-shaped fields are clipped
 * to ~2000 chars each and the whole serialized payload to ~8000 chars.
 */
function truncateToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const MAX_FIELD = 2000;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > MAX_FIELD) {
      out[k] = v.slice(0, MAX_FIELD) + `…[+${v.length - MAX_FIELD}b]`;
    } else if (typeof v === 'object' && v !== null) {
      try {
        const json = JSON.stringify(v);
        out[k] = json.length > MAX_FIELD ? json.slice(0, MAX_FIELD) + '…' : v;
      } catch {
        out[k] = '[unserializable]';
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const PARTY_TURN_CONSTANTS = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_ABSOLUTE_TIMEOUT_MS,
  KILL_GRACE_MS,
  PARTY_MODE_PREFIX,
  PARTY_FORMAT_CONTRACT,
};
