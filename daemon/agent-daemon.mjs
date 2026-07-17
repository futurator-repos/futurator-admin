/**
 * Futurator Agent Orchestrator — Local Daemon (v2)
 *
 * Step-based pipeline executor. Supports N agents, variable extraction,
 * template substitution, session resume, and validation assertions.
 *
 * Usage:
 *   cp .env.example .env
 *   npm install
 *   npm start
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { spawn, execSync, spawnSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, statSync, appendFileSync, readdirSync } from 'fs';
import { join as pathJoin, extname as pathExtname, relative as pathRelative, basename as pathBasename } from 'path';
import { createHash } from 'node:crypto';
import { totalmem, freemem, loadavg } from 'os';
import {
  isCompileStep as _isCompileStep,
  COMPILE_STEP_IDS as _COMPILE_STEP_IDS,
} from './pipelines/compile-pipeline.mjs';
import {
  emitCompilationStarted,
  emitCompilationCompleted,
  emitCompilationFailed,
  writeCompilationLog,
  parseArticleCounts,
} from './pipelines/compile-events.mjs';
import { createNdjsonForwarder } from './forwarder/ndjson-forwarder.mjs';
import { createDdbEventStore } from './forwarder/ddb-event-store.mjs';
import { createDaemonReceiver } from './receiver/http-receiver.mjs';
import { createEpicRepo } from './pipelines/lib/epic-repo.mjs';
// PR-11 #1 — wire the review-criteria parser/aggregator that was built but
// never imported. Without these the validation `VERDICT === PASS` always
// fails (VERDICT is never set), so reviewer pass verdicts get treated as
// fails and the loop spins 3× before bailing.
import {
  parseReviewCriteria,
  aggregateReviewVerdict,
  formatFailedReasonsForRetry,
  formatHumanQuestionsForAttention,
} from './pipelines/lib/review-criteria-parser.mjs';
// PR-11 #2 — wire the Story Context Pack assembler that was built (Epic B.2)
// but never imported. Without this the reviewer prompt's
// `<project_context>{{PROJECT_CONTEXT}}</project_context>` reaches the LLM
// with the literal placeholder; reviewer can't see story spec/ACs and
// hallucinates verdicts.
import { resolveAndSerializeContextPack } from './pipelines/lib/context-pack-resolver.mjs';
import {
  selectHandler,
  validateEpicDevJob,
  validatePartyBootstrapJob,
  validatePartyInspectJob,
  validatePartyTurnJob,
  validatePartyDocsSyncJob,
  validatePartyDocsUnlinkJob,
  validatePartyRefreshJob,
  validateAppBootstrapJob,
  validateFreeAgentSessionJob,
  validateQueueRequestJob,
  validateWaveMergeJob,
  validateDualAgentCompareJob,
  JOB_HANDLER_EPIC_DEV,
  JOB_HANDLER_PARTY_BOOTSTRAP,
  JOB_HANDLER_PARTY_INSPECT,
  JOB_HANDLER_PARTY_TURN,
  JOB_HANDLER_PARTY_DOCS_SYNC,
  JOB_HANDLER_PARTY_DOCS_UNLINK,
  JOB_HANDLER_PARTY_REFRESH,
  JOB_HANDLER_APP_BOOTSTRAP,
  JOB_HANDLER_FREE_AGENT_SESSION,
  JOB_HANDLER_QUEUE_REQUEST,
  JOB_HANDLER_WAVE_MERGE,
  JOB_HANDLER_SKILL_SCOUT,
  JOB_HANDLER_SKILL_INSTALL,
  JOB_HANDLER_REFLECTOR,
  JOB_HANDLER_SCORECARD_ASSESS,
  JOB_HANDLER_REFACTOR_AUDIT,
  JOB_HANDLER_ULTRACODE_BENCH,
  JOB_HANDLER_DUAL_AGENT_COMPARE,
  JOB_HANDLER_SCAN_ENGINE,
  JOB_HANDLER_STORY_DEV,
  JOB_HANDLER_QUICK_PLANSPEC,
  JOB_HANDLER_P3_QA,
  JOB_HANDLER_INTEGRATOR,
  validateScanEngineJob,
  validateP3QaJob,
  validateIntegratorJob,
  isJobClaimableBySource,
} from './pipelines/job-router.mjs';
// Servers module (Task 18, spec §5.2) — server-aware poll/claim/heartbeat.
// All of it is gated behind the `dispatch.serverAware` agent-flag; with the
// flag off the daemon behaves byte-for-byte like the legacy global-pool poll.
import { resolveServerId } from './lib/server-identity.mjs';
// Servers module (spec §5) — stamp plan-affinity (+ optional self-assign) onto
// plan-scoped jobs the daemon creates, so the dispatcher pins them to one server.
import { planAffinityStamp } from './lib/plan-affinity.mjs';
// Task B (2026-07-17) — Mac/fleet path portability. agent-jobs rows bake
// fleet-absolute paths (/home/ubuntu/…) at enqueue time; on a host whose roots
// differ (runner script sets PROJECTS_ROOT / FUTURATOR_WORKTREE_ROOT) they are
// rewritten ONCE at the job-intake seam (runJobAsync). On fleet/EC2 boxes the
// remap is inactive (env unset or equal to the legacy defaults) — exact no-op.
import { remapDaemonPath, remapJobPaths, isRemapActive } from './lib/path-remap.mjs';
// Servers module (Task 19, spec §6) — Claude OAuth relay for fleet daemons
// that don't have SSM access. Inert (never called) unless ENROLL_TOKEN is set.
import { fetchAgentCredentials } from './lib/creds-fetch.mjs';
import {
  buildJobClaimParams,
  buildJobRenewParams,
  buildJobReleaseParams,
} from './lib/atomic-claim.mjs';
import { runStoryDevJob } from './pipelines/story-dev-pipeline.mjs';
// Reality-Spine P3 — the whole-tree Integrator + its readiness gate. The daemon
// wires the real green runners (tree-gates + boot-liveness) and the story-dev
// gate deps factory (foundation-gate) so S3's foundationGate/greenTrunk resolve.
import { runIntegratorJob } from './pipelines/integrator-pipeline.mjs';
import { makeStoryDevGateDeps } from './lib/foundation-gate.mjs';
import { runTreeTypecheck, runTreeBuild } from './lib/tree-gates.mjs';
import { runBootLiveness, defaultLivenessInputs } from './lib/boot-liveness.mjs';
import { bootDevServer } from './lib/dev-server-boot.mjs';
import { envFlag } from './lib/pipeline-flags.mjs';
import { runQuickPlanspecJob } from './pipelines/quick-planspec-runner.mjs';
import { propagateCompletion, dependentsOf } from './lib/story-dispatch-driver.mjs';
import { defaultExecutors } from './lib/test-executors.mjs';
// P3-parity glue (INT wiring): full story-state write-back, fire-and-forget
// code-knowledge-graph compile, and the reflector enqueue that P3's
// plan-reducer bypass otherwise drops.
import { buildStoryStateUpdate } from './lib/story-persist.mjs';
import { runStoryCompileGraph } from './pipelines/lib/story-compile-graph.mjs';
import { enqueueStoryReflector } from './pipelines/lib/story-reflector-hook.mjs';
import { nextStatusOnDispatch, nextStatusOnAllDone, allStoriesResolved, integrateSatisfied } from './lib/p3-lifecycle.mjs';
import { resolveStampableCommitSha } from './lib/qa-commit-sha.mjs';
import { runUltracodeBenchJob } from './pipelines/ultracode-bench-job-runner.mjs';
import { makeCaptureDeps } from './pipelines/ultracode-bench-capture.mjs';
import { runDualAgentCompare } from './pipelines/dual-agent-compare-runner.mjs';
import { makeDualAgentCapture } from './pipelines/dual-agent-compare-capture.mjs';
import { case1ToDecision } from './lib/ultracode/case1-to-decision.mjs';
import { computeStructuralDiff } from './lib/ultracode/structural-diff.mjs';
import { runEpicDevPipeline } from './pipelines/epic-dev-pipeline.mjs';
import { runPartyBootstrap } from './pipelines/party-bootstrap.mjs';
import { runPartyInspect } from './pipelines/party-inspector.mjs';
import { runPartyTurn } from './pipelines/party-turn.mjs';
import { runPartyDocsSync } from './pipelines/party-docs-sync.mjs';
import { runPartyDocsUnlink } from './pipelines/party-docs-unlink.mjs';
// Story 15.4 — brownfield refresh pipeline.
import { runPartyRefresh } from './pipelines/party-refresh.mjs';
// Pipeline v2 / Story 1.4.3 — App-bootstrap saga (steps 3–5).
import { runAppBootstrap } from './pipelines/app-bootstrap.mjs';
// Story 18.2 — Free Claude Code Agent session handler.
// 2026-05-27 (unification) — `runFreeAgentGc` removed; its work is now part
// of the unified `worktree-reaper.mjs` `_assist` namespace classifier.
import { runFreeAgentSession } from './pipelines/free-agent-session.mjs';
// Queues module — inbound external REST call runner.
import { runQueueRequest } from './pipelines/queue-request.mjs';
// 2026-05-27 (unification) — one-shot startup migration: removes the old
// `/home/ubuntu/free-agent-worktrees/` root and marks in-flight free-agent
// sessions EXPIRED so they re-spawn on the unified `_assist` path.
import { maybeRunUnificationMigration } from './lib/free-agent-unification-migration.mjs';
// 2026-05-27 PR D.b — attention-items poller (Rung 5 autotrigger).
import {
  startAttentionPoller,
  composeAttentionPromptBody,
} from './lib/attention-poller.mjs';
// Skills Institution Story 1.2 — reflection-apply poller (closes the loop:
// confirmed reflections → REFLECTOR-APPLY authors the app-evolved skill).
import { startReflectionApplyPoller } from './lib/reflection-apply-poller.mjs';
import { applyReflection } from './pipelines/reflector-apply.mjs';
// 2026-05-19 — Phase 1 worktree rollout. Materialize per-story worktrees
// + node_modules symlinks before any pipeline step runs.
import { setupStoryWorktree, teardownStoryWorktree, BARE_REPOS_ROOT } from './lib/story-worktree.mjs';
// Concept v2 (E1.2/E2.4) — land generated concept docs on disk + their manifests.
import {
  writeConceptArtifact,
  extractRequirementIds,
} from './pipelines/lib/concept-artifact-writeback.mjs';
// Concept v2 (E3.2a) — fill {{PRIOR_ARTIFACTS}} from approved upstream docs.
import {
  loadPriorArtifacts,
  loadAllConceptArtifacts,
  loadCitableSections,
  conceptKindForStepId,
} from './pipelines/lib/story-context-pack.mjs';
import { startReaperTicker } from './lib/worktree-reaper.mjs';
// 2026-05-21 — auth-probe classifier (extracted so the false-FAIL fix
// is unit-testable without bringing the daemon entry into the test).
import { classifyAuthProbeResult } from './lib/auth-probe-classifier.mjs';
// Story 20.14 (party-push Epic 20) — unified-queue ConcurrencyManager with
// interactive-first priority. Wired in Story 20.16 (this file). Defaults
// to enabled; operator can opt out with PARTY_PUSH_CONCURRENCY_MANAGER='0'
// to fall back to the legacy `activeJobs.size`-gated path.
import {
  ConcurrencyManager,
  classifyJob,
  isConcurrencyManagerEnabled,
} from './lib/concurrency-manager.mjs';
import {
  findStaleJobs,
  buildResumeJob,
  isStaleAnyPhase,
  isRequeueableOrphan,
  canReapJob,
  DEFAULT_STALE_MS,
  REQUEUE_ON_ORPHAN_JOB_TYPES,
} from './pipelines/stale-heartbeat.mjs';
import {
  registerChild,
  unregisterChild,
  signalAllChildren,
  signalChildrenForJob,
  waitForAllChildrenToExit,
  killAllChildren,
  getChildCount,
} from './pipelines/lib/child-tracker.mjs';
// Pipeline-3 (development-plan §5.4/§9) — fact-force memo TTL sweep + mid-turn
// cost-ceiling halt watch.
import { startGateMemoSweep } from './lib/gate-memo-sweep.mjs';
import { checkAndSignalHalt } from './lib/halt-watch.mjs';
// Pipeline v2.0 efficiency fix B8 — deterministic deny-pattern enforcement
// for Bash tool_use events. Replaces prompt prose ("Do NOT run npm create
// vite") with SIGTERM-on-match. See daemon/lib/bash-deny-patterns.mjs.
import { matchesDenyPattern } from './lib/bash-deny-patterns.mjs';
import { myceliumMcpSpawn, myceliumMcpSpawnForced } from './lib/mcp-config.mjs';
import {
  writeAttentionItem,
  autoResolveAttentionByDedupKey,
  resolvePlanIdFromEpicId,
  addCostToPlan,
} from './pipelines/lib/attention-writer.mjs';
import { assertSpawnAllowed, ShellGuardViolation } from './pipelines/lib/shell-guard.mjs';
import { mergeVisualTestsBlock } from './pipelines/lib/visual-tests-writer.mjs';
// Pipeline v2.0 efficiency fixes T0.1 + PR-6(B) — detect step-output
// completion in agent prose so forced terminations (COST_HARD, OAuth
// expiry, OOM-kill, SIGTERM) resolve as success when the agent has
// already finished its work. See daemon/lib/done-detector.mjs.
import { isStepOutputComplete, classifyCompletion } from './lib/done-detector.mjs';
// Pipeline v2.0 efficiency fix T0.2 — daemon-side pre-DEV gate that
// short-circuits no-op stories without spawning the LLM. See
// daemon/lib/prework-gate.mjs.
import { evaluatePreworkGate, renderGateEvidence } from './lib/prework-gate.mjs';
// D4(a) — proactive plan-gen budget guard (large grounded spec → compact first attempt).
import { applyProactivePlanBudget } from './lib/plan-budget.mjs';
// Pipeline v2.0 PR-4 — touch-point inference. When the planner left a
// story's `touchPoints` empty, the daemon infers them at dispatch time
// (heuristic-first, Haiku fallback) so the prework gate / scope-violation
// detector / wave-conflict resolver have valid inputs.
import { inferTouchPoints } from './lib/touch-point-inference.mjs';
import { writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createFederationCache, manifestSha } from './lib/federation-loader.mjs';
// Epic 3 Story 3.1 (2026-05-20) — SKILL-SCOUT runner + daemon-side
// shape validator (mirror of the TS Zod schema, see
// daemon/lib/skill-proposal-validator.mjs).
import { runSkillScoutJob } from './pipelines/skill-scout-job-runner.mjs';
import { validateSkillProposalsBlock } from './lib/skill-proposal-validator.mjs';
// Epic 3 Story 3.2 — the installer the runner calls for auto-confirm.
import { applyConfirmedProposals } from './pipelines/skill-installer.mjs';
// Epic 3 Story 3.6 — operator-confirm path.
import { runSkillInstallJob } from './pipelines/skill-install-job-runner.mjs';
// Epic 6 wire-in (2026-05-20) — REFLECTOR job runner.
import { runReflectorJob } from './pipelines/reflector-job-runner.mjs';
// Plan Retrospect — The Assessor job runner + daemon-side scorecard store.
import { runScorecardAssessJob } from './pipelines/scorecard-assess-job-runner.mjs';
import { getStoredStageRow, putAssessorSlices } from './lib/scorecard-store.mjs';
// Refactoring Assessment Module (Epic B2/C) — deterministic recon runner +
// optional L3 adjudication.
import {
  runRefactorAuditJob,
  runL3Adjudication,
  findCharacterizationGateViolations,
} from './pipelines/refactor-audit-job-runner.mjs';
// Data Privacy Assessment lane (parallel sibling to recon).
import { runPrivacyAuditJob, summarizePrivacyReport } from './pipelines/privacy-audit-job-runner.mjs';
// Refactoring Scan Engine v2 — hybrid deterministic + swarm orchestration core.
import { runScanEngine } from './pipelines/scan-engine-job-runner.mjs';
import { enrichInfraWithGraph } from './scripts/refactor-recon/infra-extract.mjs';
// Epic 4 (2026-05-20) — track Skill tool_use activations into
// .context/loaded-skills.json so the per-story commit's Skills-Used
// trailer populates with real content.
import { recordSkillActivation } from './lib/loaded-skills-tracker.mjs';
import { buildSkillsPromptLine, buildSkillsPushPrompt, SKILLS_PUSH_ROLES } from './lib/skills-prompt.mjs';
import { startFederationBackupSchedule } from './lib/federation-backup.mjs';
import { createFederationResolver } from './lib/federation-resolver.mjs';
import { createMemoryStore, provisionMemoryRoot } from './lib/memory-store.mjs';
// PR-80-followup — CLAUDE.md prepend per v2.5 §41.3.
import { readClaudeMd } from './lib/claude-md-loader.mjs';
import { createPatRetry } from './lib/pat-retry.mjs';

// Resolve the full path to `claude` binary at startup.
// NB: Claude Code ≥2.1.19x ships a NATIVE compiled binary (bin/claude.exe) — it must be
// spawned DIRECTLY (`spawn(CLAUDE_BIN, args)`), NOT via `node` (older builds shipped a cli.js
// that `node` could run; the native binary makes `node claude.exe` throw ERR_UNKNOWN_FILE_EXTENSION).
// Direct exec also works for the legacy cli.js via its shebang — it's the universal pattern, and the
// one epic-dev/party/free-agent spawns already use (2026-06-25 claude-upgrade fix).
let CLAUDE_BIN = 'claude';
try {
  CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim();
} catch {
  // Fallback: try common locations
  for (const p of ['/usr/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) {
      CLAUDE_BIN = p;
      break;
    }
  }
}

// ── Config ──

const REGION = process.env.AWS_REGION || 'us-east-1';
const JOBS_TABLE = process.env.JOBS_TABLE || 'futurator-agent-jobs';
const EVENTS_TABLE = process.env.AGENT_EVENTS_TABLE || 'futurator-agent-events';
const ULTRACODE_RUNS_TABLE = process.env.ULTRACODE_RUNS_TABLE || 'futurator-ultracode-runs';
const EPICS_TABLE = process.env.EPIC_WORKFLOWS_TABLE || 'futurator-epic-workflows';
// Pipeline v2 / Story 1.4.3 — App-bootstrap saga reads + updates the App row.
const APPS_TABLE = process.env.APPS_TABLE || 'futurator-apps';
// PR-22 — post-deploy writebacks read the plan row to derive App linkage.
const PLANS_TABLE = process.env.PLANS_TABLE || 'futurator-plans';
// Task B (2026-07-17) — host-local filesystem roots. Fleet/EC2 leaves both
// envs unset so every derived path is byte-identical to the old literals.
const DAEMON_PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';
const DAEMON_WORKTREE_ROOT = process.env.FUTURATOR_WORKTREE_ROOT || '/home/ubuntu/worktrees';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const OAUTH_CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH || '/home/ubuntu/.claude/.credentials.json';
// Re-read OAuth file + probe hourly. Access tokens expire ~24h and the CLI
// refreshes them per-invocation using the refresh_token, so hourly is plenty.
const AUTH_PROBE_INTERVAL_MS = parseInt(
  process.env.AUTH_PROBE_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);
// Servers module (Task 19, spec §6) — fleet daemons fetch Claude OAuth creds
// from the admin API using their enrollment token instead of the legacy SSM
// pull. ENROLL_TOKEN unset (EC2/local seeded daemons) ⇒ fully inert.
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'https://hub.futurator.ai';
const ENROLL_TOKEN = process.env.ENROLL_TOKEN || '';
const EVENT_LOG_DIR = process.env.FUTURATOR_EVENT_LOG_DIR || '/var/log/futurator/events';
const FORWARDER_POLL_MS = parseInt(process.env.FORWARDER_POLL_MS || '250', 10);
const DAEMON_RECEIVER_PORT = parseInt(process.env.FUTURATOR_DAEMON_PORT || '17631', 10);
const STALE_HEARTBEAT_MS = parseInt(process.env.STALE_HEARTBEAT_MS || String(DEFAULT_STALE_MS), 10);
const STALE_SCAN_INTERVAL_MS = parseInt(process.env.STALE_SCAN_INTERVAL_MS || '30000', 10);
// 2026-05-27 (unification) — FREE_AGENT_GC_INTERVAL_MS removed. Assist
// worktrees are now reaped by the unified hourly worktree-reaper alongside
// per-story + party + node_modules-store entries.
// Pipeline Enhancement Plan v2 — Phase A.1: graceful shutdown window. On
// SIGTERM/SIGINT the daemon SIGTERMs tracked children, waits this long, then
// SIGKILLs any stragglers and emits daemon-shutdown-timeout attention items.
const GRACEFUL_SHUTDOWN_MS = parseInt(process.env.GRACEFUL_SHUTDOWN_MS || '30000', 10);

// Pipeline Enhancement Plan v2 — Phase A.3: retry ladder. Transient step
// failures (non-policy, non-auth) re-queue as PENDING with retryAfter set to
// now + the corresponding delay. After MAX_RETRIES exhausted the job is
// FAILED for real and a high-severity retry-exhausted attention item is
// written.
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000]; // 30s → 2m → 8m
const MAX_RETRIES = RETRY_DELAYS_MS.length;

// Pipeline v2.0 Efficiency Fix T0.3 — story pipelines (per-story DEV→
// REVIEWER→COMPILER) get a tighter retry budget than the generic ladder.
// dino1 forensic: a no-op story burned ~$40 across ~5 dev re-spawns before
// the operator manually abandoned. T0.1's COST_HARD-after-DONE detector is
// the primary fix; this is defense-in-depth for the case where dev fails
// BEFORE emitting ---DONE---. Default 2 attempts (1 retry).
const MAX_DEV_ATTEMPTS_PER_STORY = parseInt(process.env.MAX_DEV_ATTEMPTS_PER_STORY || '2', 10);
const STORY_PIPELINE_MAX_RETRIES = Math.max(0, MAX_DEV_ATTEMPTS_PER_STORY - 1);

// Pipeline v2.0 Efficiency Fix T0.2 — daemon-side pre-DEV gate.
// When enabled (default), executePipeline runs three deterministic signals
// (recent commits + AC named exports present in touchPoints + tsc clean)
// before spawning the dev step. If all green, the job short-circuits to
// COMPLETED_VIA_PREWORK without spawning any agent. dino1 forensic projects
// this would have eliminated 7 of 9 DEV spawns on pre-scaffolded boilerplates.
const PREWORK_GATE_ENABLED = (process.env.PREWORK_GATE_ENABLED || 'true') !== 'false';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ── Event-driven advancement (2026-05-30) ──────────────────────────────────
// After a wave-merge / epic-dev job reaches a terminal state, the daemon
// asynchronously invokes the WaveCompletionCheck Lambda so the next wave/epic
// dispatches IMMEDIATELY instead of waiting up to ~2 cron ticks (~120s of dead
// time observed in the dino1 forensic). The reducer is TS-only (lives in the
// Lambda), so the daemon triggers the existing cron entrypoint rather than
// porting reducer logic. Fire-and-forget (InvocationType:'Event'); the
// scheduled rate(1 minute) tick stays as the backstop, and the per-plan reduce
// lock (plan-repository.acquirePlanReduceLock) makes the on-demand + scheduled
// runs safe against each other. IAM: the EC2 role needs lambda:InvokeFunction
// on this function (granted out-of-band). Disabled cleanly if the SDK/env are
// absent — the cron still advances, just at cron cadence.
const WAVE_COMPLETION_FN =
  process.env.WAVE_COMPLETION_FN ||
  'futurator-production-WaveCompletionCheckHandlerFunction-cbowzwhk';
let _lambdaClient = null;
let _lambdaInvokeCmd = null;
// ── git-graph snapshot (2026-05-30) ───────────────────────────────────────
// After a wave-merge the daemon writes a snapshot of the bare repo's full
// graph (all refs: main + wip/* + plan/<slug>, with merge commits) to S3 so
// the Labs git-graph view can show the emerging branching for greenfield apps
// that have no GitHub repo. Best-effort, fire-and-forget.
let _s3Client = null;
function daemonGit(args, cwd) {
  // Task B (2026-07-17) — on remapped hosts (Mac / non-fleet boxes, detected
  // via isRemapActive) the daemon runs as the operator user and no `ubuntu`
  // user exists, so drop the sudo indirection. Fleet/EC2 (remap inactive)
  // keeps the root→ubuntu sudo spawn byte-for-byte.
  const [bin, argv] = isRemapActive() ? ['git', args] : ['sudo', ['-n', '-u', 'ubuntu', 'git', ...args]];
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function snapshotGitGraph(appId, short) {
  try {
    const [{ writeGitGraphSnapshot }, { bareRepoPath }, s3mod] = await Promise.all([
      import('./lib/git-graph-snapshot.mjs'),
      import('./lib/story-worktree.mjs'),
      import('@aws-sdk/client-s3'),
    ]);
    if (!_s3Client) _s3Client = new s3mod.S3Client({ region: REGION });
    const bare = bareRepoPath(appId);
    await writeGitGraphSnapshot({
      appId,
      bare,
      git: daemonGit,
      bareOpCwd: DAEMON_PROJECTS_ROOT,
      s3: _s3Client,
      log,
    });
  } catch (err) {
    log('warn', `[${short}] git-graph snapshot failed (non-blocking): ${err.message}`);
  }
}

async function triggerWaveReduce(reason) {
  try {
    if (!_lambdaClient) {
      const mod = await import('@aws-sdk/client-lambda').catch(() => null);
      if (!mod) {
        log('warn', `[reduce-trigger] @aws-sdk/client-lambda absent — relying on cron (${reason})`);
        return;
      }
      _lambdaClient = new mod.LambdaClient({ region: REGION });
      _lambdaInvokeCmd = mod.InvokeCommand;
    }
    await _lambdaClient.send(
      new _lambdaInvokeCmd({ FunctionName: WAVE_COMPLETION_FN, InvocationType: 'Event' }),
    );
    log('info', `[reduce-trigger] invoked WaveCompletionCheck (${reason})`);
  } catch (err) {
    // Non-fatal: the scheduled cron is the backstop.
    log('warn', `[reduce-trigger] invoke failed (cron will catch it): ${err.message}`);
  }
}

// Module-scope epic-row accessor — shared by the receiver and by the
// touch-point inference helper (PR-4). Single instance per daemon process.
const epicRepo = createEpicRepo({ ddb, tableName: EPICS_TABLE });

// ── Claude Code OAuth auth (Max subscription only, no fallback) ──
//
// The daemon NEVER uses an Anthropic API key. All agent work counts against
// the operator's Claude Max subscription via the OAuth tokens at
// OAUTH_CREDS_PATH. Those tokens are pushed from the operator's Mac Keychain
// via scripts/mac-oauth-sync.sh (manual) or scripts/mac-oauth-server.mjs
// (the always-on localhost helper, triggered on-demand by the admin UI's
// Re-authorize button and also on a launchd timer).
//
// If the OAuth file is missing or the `claude` CLI rejects it, jobs fail —
// we do not attempt to authenticate any other way. The operator clicks
// Re-authorize in the UI to push fresh tokens from their Mac.
const authState = {
  valid: null, // null until first probe, true/false after
  checkedAt: null,
  error: null,
  loadedAt: null, // when we last read the OAuth file
  hasFile: false, // does the file exist + parse?
  hasRefresh: false, // does the file contain a refresh_token?
  expiresAt: null, // unix ms from the accessToken (CLI refreshes per-use)
  subscriptionType: null, // "max" / "pro" / ...
};

// Phase 3 / Story 3-C-1-1 — skill federation cache + backup schedule.
// Loaded at startup from ~/.futurator/skill-federation.yaml (overridable via
// FUTURATOR_FEDERATION_PATH); refreshed via SIGUSR1 alongside OAuth reload.
// Daily S3 backup tick is started in the main IIFE and stored here for
// shutdown teardown.
let federationCache = null;
let federationResolver = null;
let federationBackupHandles = null;

// Phase 3 / Story 3-E-1-1 — inter-agent memory store. Provisioned at
// startup (idempotent); accessed via createMemoryStore() handle by REFLECTOR,
// TRIAGE, and agents writing to inbox/* outbox files.
let memoryStore = null;

function tryOAuthFile() {
  try {
    const raw = readFileSync(OAUTH_CREDS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Real Keychain format (verified): { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }
    // Legacy / alternate flat format: { accessToken, refreshToken, ... }
    const oauth = parsed?.claudeAiOauth || parsed?.oauth || parsed;
    if (!oauth?.accessToken || oauth.accessToken.length < 30) return null;
    return {
      accessToken: oauth.accessToken,
      hasRefresh: !!oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      subscriptionType: oauth.subscriptionType || null,
    };
  } catch {
    return null;
  }
}

function loadOAuth(reason = 'startup') {
  // CRITICAL: if ANYTHING has set ANTHROPIC_API_KEY in our process env, remove
  // it. Claude CLI prioritises that env var over the OAuth file and would
  // silently bill against an API key instead of the Max subscription.
  if ('ANTHROPIC_API_KEY' in process.env) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  const info = tryOAuthFile();
  if (!info) {
    authState.hasFile = false;
    authState.hasRefresh = false;
    authState.expiresAt = null;
    authState.subscriptionType = null;
    log('warn', `OAuth file missing or unreadable at ${OAUTH_CREDS_PATH} (${reason})`);
    return;
  }
  authState.hasFile = true;
  authState.hasRefresh = info.hasRefresh;
  authState.expiresAt = info.expiresAt;
  authState.subscriptionType = info.subscriptionType;
  authState.loadedAt = Date.now();
  log('info', `OAuth loaded from ${OAUTH_CREDS_PATH} (${reason})`, {
    subscription: info.subscriptionType,
    hasRefresh: info.hasRefresh,
    accessExpiresAt: info.expiresAt ? new Date(info.expiresAt).toISOString() : null,
  });
}

function probeAuth() {
  return new Promise((resolve) => {
    const args = ['-p', 'ok', '--model', 'haiku', '--output-format', 'json'];
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Belt-and-suspenders: strip ANTHROPIC_API_KEY from child env so the CLI
      // cannot pick it up even if something sets it after daemon startup.
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      // 120s: a cold-started native CLI on a laptop can take >60s to first
      // token (measured 2026-07-17 on macOS — user-level MCP/config init
      // dominates); 20s flagged working auth as "exit 143" every probe.
      // A genuinely hung CLI is still reaped.
      timeout: 120000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', (err) => {
      authState.valid = false;
      authState.error = `probe spawn failed: ${err.message}`;
      authState.checkedAt = new Date().toISOString();
      resolve();
    });
    proc.on('close', (code) => {
      const combined = stderr + stdout;
      // CLI may exit 0 with is_error=true on rate limit / quota / OAuth reject.
      let parsed = null;
      try {
        const trimmed = combined.trim();
        if (trimmed.startsWith('{')) parsed = JSON.parse(trimmed);
      } catch {}
      // 2026-05-21 — classifyAuthProbeResult is the pure decision matrix
      // (lib/auth-probe-classifier.mjs). Pre-fix this inlined a strict
      // `code === 0` check which flipped to FAIL on benign non-zero exits
      // (rate-limit response headers, trace fragments, shutdown signals)
      // even when is_error=false. The UI surfaced that as "auth expired"
      // while the next agent spawn worked fine. Now: if Claude returned
      // JSON with is_error=false and no auth-failure phrase, we trust
      // the API result over the exit code.
      const ok = classifyAuthProbeResult({
        exitCode: code,
        parsed,
        combinedOutput: combined,
      });
      authState.valid = ok;
      authState.error = ok
        ? null
        : (parsed?.result || stderr.trim() || `exit ${code}`).slice(0, 300);
      authState.checkedAt = new Date().toISOString();
      log(ok ? 'info' : 'warn', `Auth probe: ${ok ? 'OK' : 'FAIL'}`, {
        err: authState.error,
        // 2026-05-21 — surface the raw exit code so flaky non-zero exits
        // are visible in the log even when we (correctly) call it OK.
        exit: code,
        parsed: parsed ? 'yes' : 'no',
      });
      resolve();
    });
  });
}

// Servers module (Task 19, spec §6) — fleet daemons don't have SSM access,
// so they pull Claude OAuth credentials from the admin API using their
// per-server enrollment token. EC2/local seeded daemons have no
// ENROLL_TOKEN and keep the legacy SSM/Keychain-push path untouched (this
// is a no-op for them). Never throws — auth loss here must not crash the
// daemon; probeAuth() on the next cycle reports the real auth state.
async function maybeFetchAgentCredentials(reason) {
  if (!ENROLL_TOKEN) return false;
  const ok = await fetchAgentCredentials({
    adminApiUrl: ADMIN_API_URL,
    enrollToken: ENROLL_TOKEN,
    credsPath: OAUTH_CREDS_PATH,
    log: (level, msg, ctx) => log(level, `[creds-fetch:${reason}] ${msg}`, ctx),
  });
  return ok;
}

function stripApiKey(env) {
  const clean = { ...env };
  delete clean.ANTHROPIC_API_KEY;
  return clean;
}

function isAuthFailureOutput(text) {
  if (!text) return false;
  return /401|authentication_error|unauthenticated|Failed to authenticate|Not logged in|Please run \/login/i.test(
    text,
  );
}

const jobEventSeqs = new Map(); // jobId -> last seq number
const activeJobs = new Map(); // jobId -> { startedAt, workingDir, stepId, agentId, pid, model }
// t2.micro has 1.8GB RAM; each Claude process uses ~150-300MB. 2 concurrent = safe.
// PR-29 — concurrency cap. Default 2; override with MAX_CONCURRENT env var.
//
// 2026-05-04 plan-2 dino-runner-1: 3 wave-1 stories ran in parallel and each
// dev agent issued an `npm run build` / `npx tsc --noEmit` Bash tool call
// within the same second. On a t4g.small (2GB RAM) the daemon (~150MB) +
// 3 claude subprocesses (~450MB) + 3 npm/tsc child processes
// (~500-800MB each) blew past available memory. Linux OOM killer fired,
// daemon got SIGKILL'd, all 3 jobs left orphaned RUNNING in DDB.
//
// Memory-aware cap: when totalmem < 3 GB, hard-cap at 2 regardless of env
// override. Bigger instances (t4g.medium 4GB+) honour the env var.
//
// Note: this caps DAEMON-LEVEL job concurrency. Individual stories that
// run in parallel as part of a single wave (e.g. 3 stories in wave-1)
// are still launched simultaneously by the cron — but the daemon will
// only pick up MAX_CONCURRENT of them at a time, queuing the rest.
const SMALL_HOST_MEM_THRESHOLD_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB
const SMALL_HOST_MAX_CONCURRENT = 2;
const _envConcurrent = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const _isSmallHost = totalmem() < SMALL_HOST_MEM_THRESHOLD_BYTES;
const MAX_CONCURRENT = _isSmallHost
  ? Math.min(_envConcurrent, SMALL_HOST_MAX_CONCURRENT)
  : _envConcurrent;
if (_isSmallHost && _envConcurrent > SMALL_HOST_MAX_CONCURRENT) {
  // eslint-disable-next-line no-console
  console.warn(
    `[daemon] MAX_CONCURRENT=${_envConcurrent} ignored — host has <3GB RAM, capping at ${SMALL_HOST_MAX_CONCURRENT} (PR-29 OOM protection)`,
  );
}

// Queues module — the *effective* cap the poll loop enforces. Seeded from the
// boot MAX_CONCURRENT (env + small-host clamp) and then updated each tick from
// the operator-set `concurrency.maxConcurrent.<source>` agent-flag (see
// applyCapOverrideCached below). Kept in lockstep with concurrencyManager._max.
let effectiveMaxConcurrent = MAX_CONCURRENT;

// Story 20.16 — ConcurrencyManager instance. Lives alongside `activeJobs`:
// the manager owns "is there capacity to dispatch?" + classifies + chooses
// which PENDING to dispatch; `activeJobs` keeps the rich per-job metadata
// the heartbeat reports (pid, model, agentId, …). Both updated in
// runJobAsync's set/delete hooks so they never drift.
//
// When PARTY_PUSH_CONCURRENCY_MANAGER='0', the manager is still
// instantiated (its snapshot stays useful in heartbeats) but the poll
// loop falls back to the legacy `activeJobs.size`-vs-MAX_CONCURRENT gate.
const CONCURRENCY_MANAGER_ENABLED = isConcurrencyManagerEnabled();
const concurrencyManager = new ConcurrencyManager({
  maxConcurrent: MAX_CONCURRENT,
  classifier: classifyJob,
  logger: {
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
  },
});
// Story 20.14 AC 10 — DDB candidate window size when the manager is on.
// We fetch up to 20 PENDING jobs instead of `MAX_CONCURRENT` so
// `selectNext` can apply interactive-first priority across the queue —
// not just the next free-slot count.
const CM_CANDIDATE_LIMIT = 20;
let shuttingDown = false;
let ndjsonForwarder = null;
let daemonReceiver = null;

function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data,
  };
  const prefix = {
    info: '\x1b[36mINFO\x1b[0m',
    warn: '\x1b[33mWARN\x1b[0m',
    error: '\x1b[31mERROR\x1b[0m',
    debug: '\x1b[90mDEBG\x1b[0m',
  };
  console.log(
    `[${entry.ts}] ${prefix[level] || level} ${msg}`,
    Object.keys(data).length ? JSON.stringify(data) : '',
  );
}

// ── Push event to DynamoDB ──

/**
 * Look up the highest existing eventSeq for a jobId in DDB. Used to seed
 * `jobEventSeqs` the first time we touch a jobId in this daemon process —
 * critical for party sessions, where the same jobId (= sessionId) accumulates
 * events across many turns and across daemon restarts. Without this, a
 * deploy/restart resets the counter to 0 and the next turn's events overwrite
 * Round 1's user event in DDB, which (a) destroys data and (b) makes the
 * fresh turn appear at the top of the chat as "Round 1" instead of being
 * appended at the end.
 *
 * Walks ScanIndexForward=false with Limit=1, so it costs one DDB read per
 * cold-start of a session in this process.
 */
async function loadMaxEventSeq(jobId) {
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'jobId = :j',
        ExpressionAttributeValues: { ':j': jobId },
        ScanIndexForward: false,
        Limit: 1,
        ProjectionExpression: 'eventSeq',
      }),
    );
    const item = (result.Items || [])[0];
    if (!item || typeof item.eventSeq !== 'string') return 0;
    const n = parseInt(item.eventSeq, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    log('warn', 'Failed to load max eventSeq — starting from 0', { jobId, err: err.message });
    return 0;
  }
}

async function pushEvent(jobId, stepId, agentId, eventType, data = {}) {
  // Seed the in-memory counter from DDB the first time we see this jobId in
  // this process. See loadMaxEventSeq() for why.
  if (!jobEventSeqs.has(jobId)) {
    const existing = await loadMaxEventSeq(jobId);
    jobEventSeqs.set(jobId, existing);
  }
  const current = (jobEventSeqs.get(jobId) || 0) + 1;
  jobEventSeqs.set(jobId, current);
  const seq = String(current).padStart(6, '0');
  try {
    await ddb.send(
      new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          jobId,
          eventSeq: seq,
          seq: current,
          timestamp: new Date().toISOString(),
          stepId,
          agentId,
          eventType,
          ...data,
          expireAt: Math.floor(Date.now() / 1000) + 7 * 86400,
        },
      }),
    );
  } catch (err) {
    log('error', `Failed to push event ${eventType}`, { jobId, seq, err: err.message });
  }
}

// ── Template substitution: replace {{VAR}} with values from variables store ──

function substituteTemplate(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    if (varName in variables) {
      log('debug', `Template substitution: {{${varName}}} → ${variables[varName].length} chars`);
      return variables[varName];
    }
    log('warn', `Template variable {{${varName}}} not found in store, leaving as-is`);
    return match;
  });
}

// ── Extract variables from agent output ──

function runExtractors(text, extractors) {
  const extracted = {};

  for (const [varName, config] of Object.entries(extractors)) {
    let value = null;

    if (config.type === 'regex' && config.pattern) {
      try {
        const re = new RegExp(config.pattern, 's');
        const match = re.exec(text);
        if (match) {
          value = match[1] || match[0]; // prefer capture group 1
        }
      } catch (err) {
        log('error', `Invalid regex for ${varName}: ${config.pattern}`, { err: err.message });
      }
    } else if (config.type === 'between' && config.startDelimiter && config.endDelimiter) {
      const startIdx = text.indexOf(config.startDelimiter);
      const endIdx = text.indexOf(config.endDelimiter, startIdx);
      if (startIdx !== -1 && endIdx !== -1) {
        value = text.slice(startIdx, endIdx + config.endDelimiter.length);
      }
    }

    if (value !== null) {
      extracted[varName] = value;
      log('info', `Extracted ${varName} (${config.type}): ${value.length} chars`, {
        preview: value.slice(0, 80),
      });
    } else {
      log('warn', `Extractor ${varName} (${config.type}) found nothing`);
    }
  }

  return extracted;
}

// ── Run validations ──

function runValidations(validations, variables) {
  const results = [];

  for (const v of validations) {
    const leftVal = variables[v.left] ?? v.left;
    const rightVal = variables[v.right] ?? v.right;
    let passed = false;
    let details = '';

    switch (v.type) {
      case 'equals':
        passed = leftVal === rightVal;
        details = passed
          ? `"${leftVal.slice(0, 40)}" == "${rightVal.slice(0, 40)}"`
          : `"${leftVal.slice(0, 40)}" != "${rightVal.slice(0, 40)}"`;
        break;
      case 'contains':
        passed = leftVal.includes(rightVal);
        details = passed
          ? `"${v.left}" contains "${v.right}"`
          : `"${v.left}" does NOT contain "${v.right}"`;
        break;
      case 'not_contains':
        passed = !leftVal.includes(rightVal);
        details = passed
          ? `"${v.left}" correctly does NOT contain "${v.right}"`
          : `LEAKED: "${v.right}" found inside "${v.left}"`;
        break;
    }

    const icon = passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    log('info', `Validation [${icon}] ${v.label}: ${details}`);
    results.push({ label: v.label, passed, details });
  }

  return results;
}

// ── Pipeline v2.0 PR-6 (B+): Auth recovery loop ────────────────────────
//
// Wraps `runAgent` with a retry-on-auth-failure loop. dino1 retry forensic
// (2026-04-29): OAuth expired AFTER REVIEWER finished; without recovery,
// the daemon marked the job FAILED non-retriable. Now:
//
//   1. Call runAgent.
//   2. If it rejects with err.code === 'AUTH_FAILED' (set by close handler
//      when output buffer was empty — i.e. truly mid-stream auth death):
//        a. loadOAuth('auth-error-recovery') — re-read the credentials file
//           in case the Mac Keychain push or hourly probe already refreshed
//           the access_token.
//        b. probeAuth() — verify the new token works. If it does, retry the
//           same step with the same prompt + same opts. The agent restarts
//           but the working dir already has any committed work.
//   3. Backoff: 5s before first recovery retry, 30s before second.
//   4. After 2 failed recoveries: re-throw the original error so handleJobFailure
//      routes to NEEDS_ATTENTION with category 'auth-recovery-failed'.
//
// Notes:
//   - Buffer-recovery (PR-6 B) handles "auth died AFTER complete output" —
//     in that case runAgent resolves successfully and this wrapper is a no-op.
//   - The recovery loop only kicks in when the agent died mid-stream with no
//     captured work. That's the case worth retrying.
//   - Auth-recovery does NOT count against MAX_DEV_ATTEMPTS_PER_STORY (T0.3) —
//     auth failures are infrastructure, not bad-prompt failures.
const AUTH_RECOVERY_BACKOFF_MS = [5_000, 30_000];
// pacman7 — Anthropic 529 "overloaded" storms can last minutes. Back off longer
// and more times than auth recovery; these do NOT count against the story's
// dev-retry budget (overload is infrastructure, not a bad prompt).
const OVERLOAD_BACKOFF_MS = [15_000, 45_000, 90_000, 90_000];
// PR-6 (C): if the OAuth access token expires within this window, force a
// pre-spawn reload + probe. Eliminates the "token died mid-stream" race for
// the common case where the Mac Keychain push happened recently and the
// fresh tokens are sitting in the file but `authState.expiresAt` is stale.
const PRESPAWN_EXPIRY_THRESHOLD_MS = 5 * 60 * 1000;

async function runAgentWithAuthRecovery(jobId, stepId, agentId, prompt, opts = {}) {
  let attempt = 0; // auth-recovery attempts
  let overloadAttempt = 0; // pacman7 — transient API-overload retries (separate budget)
  while (true) {
    // PR-6 (C): pre-spawn token-expiry check. Refresh-from-file if the access
    // token expires soon — cheap insurance against the race that bit dino1's
    // reviewer step.
    if (authState.expiresAt && authState.expiresAt - Date.now() < PRESPAWN_EXPIRY_THRESHOLD_MS) {
      log(
        'info',
        `[${jobId.slice(0, 8)}] pre-spawn: access token expires in <${Math.round(PRESPAWN_EXPIRY_THRESHOLD_MS / 60_000)}min, reloading OAuth file`,
        { expiresAt: new Date(authState.expiresAt).toISOString() },
      );
      try {
        loadOAuth(`pre-spawn-${stepId}`);
      } catch (preErr) {
        log('warn', `[${jobId.slice(0, 8)}] pre-spawn OAuth reload threw: ${preErr.message}`);
      }
    }

    try {
      return await runAgent(jobId, stepId, agentId, prompt, opts);
    } catch (err) {
      const isAuthErr = err?.code === 'AUTH_FAILED';
      const isOverload = err?.code === 'OVERLOADED';

      // pacman7 — transient API overload: back off and retry WITHOUT consuming
      // the story's dev-retry budget and WITHOUT reloading OAuth (auth is fine,
      // the API is just overloaded). Separate budget from auth recovery.
      if (isOverload && overloadAttempt < OVERLOAD_BACKOFF_MS.length) {
        const backoffMs = OVERLOAD_BACKOFF_MS[overloadAttempt];
        overloadAttempt += 1;
        log(
          'warn',
          `[${jobId.slice(0, 8)}] API overloaded: backing off ${Math.round(backoffMs / 1000)}s (attempt ${overloadAttempt}/${OVERLOAD_BACKOFF_MS.length})`,
        );
        pushEvent(jobId, stepId, agentId, 'status', {
          text: `[SYSTEM] api-overload backoff ${overloadAttempt}/${OVERLOAD_BACKOFF_MS.length} — retrying in ${Math.round(backoffMs / 1000)}s (does not consume a story retry)`,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      if (isAuthErr && attempt < AUTH_RECOVERY_BACKOFF_MS.length) {
        const backoffMs = AUTH_RECOVERY_BACKOFF_MS[attempt];
        attempt += 1;
        log(
          'warn',
          `[${jobId.slice(0, 8)}] auth recovery attempt ${attempt}/${AUTH_RECOVERY_BACKOFF_MS.length}: re-reading OAuth + sleeping ${backoffMs}ms`,
        );
        pushEvent(jobId, stepId, agentId, 'status', {
          text: `[SYSTEM] auth-recovery attempt ${attempt}/${AUTH_RECOVERY_BACKOFF_MS.length} — reloading OAuth file in ${Math.round(backoffMs / 1000)}s`,
        });

        await new Promise((r) => setTimeout(r, backoffMs));
        try {
          loadOAuth(`auth-error-recovery-${attempt}`);
          await probeAuth();
        } catch (probeErr) {
          log('warn', `[${jobId.slice(0, 8)}] auth recovery probe threw: ${probeErr.message}`);
          // Fall through — retry runAgent anyway; the next iteration's reject
          // will surface the actual auth issue if probe was lying.
        }
        if (!authState.valid) {
          log(
            'warn',
            `[${jobId.slice(0, 8)}] auth recovery: probe still invalid after reload; will retry anyway in case Mac Keychain push is in flight`,
          );
        } else {
          log('info', `[${jobId.slice(0, 8)}] auth recovery: OAuth re-validated; retrying step`);
        }
        continue;
      }

      // Non-transient failure, or transient budget exhausted → tag + re-throw.
      if (isAuthErr) {
        // Route to a distinct attention category instead of the generic path.
        err.code = 'AUTH_RECOVERY_EXHAUSTED';
        err.authRecoveryAttempts = attempt;
      } else if (isOverload) {
        err.code = 'OVERLOADED_EXHAUSTED';
        err.overloadAttempts = overloadAttempt;
      }
      throw err;
    }
  }
  // (unreachable — the while(true) loop only exits via `return` or `throw`)
}

// ── Run a single Claude CLI agent ──

function runAgent(jobId, stepId, agentId, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    // Mycelium graph MCP tools (gated by MYCELIUM_MCP=on). Co-located with
    // Memgraph on the box — no VPC barrier. Extends the agent's allowlist with
    // the read-only graph tools; no-op when the flag is off.
    const mcp = myceliumMcpSpawn(opts.allowedTools);
    args.push(...mcp.args);

    if (opts.resume) args.push('--resume', opts.resume);
    if (mcp.allowedTools) args.push('--allowedTools', mcp.allowedTools);
    if (opts.disallowedTools) args.push('--disallowedTools', opts.disallowedTools);
    if (opts.model) args.push('--model', opts.model);
    // PR-38 — per-rigor turn cap from the agent's RolePolicy. Resolved at
    // spawn-time via role-policy.mjs::buildAgentConfig and threaded through
    // runAgentWithAuthRecovery (line 1572). Absent → no cap.
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
      args.push('--max-turns', String(opts.maxTurns));
    }
    // PR-80-followup — CLAUDE.md prepended to every agent's system prompt
    // per v2.5 §41.3. The loader caps the file at 100KB so we never blow
    // past the CLI's argv limits.
    if (typeof opts.appendSystemPrompt === 'string' && opts.appendSystemPrompt.length > 0) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    log('info', `Spawning claude for step ${stepId} (agent ${agentId})`, {
      resume: opts.resume || 'none',
      model: opts.model || 'default',
      promptLen: prompt.length,
    });

    pushEvent(jobId, stepId, agentId, 'step_start', {
      text: `Step ${stepId}: Agent ${agentId} starting...`,
    });

    // Auto-create working directory if it doesn't exist
    const cwd = opts.workingDir || process.env.HOME;
    if (opts.workingDir && !existsSync(opts.workingDir)) {
      try {
        mkdirSync(opts.workingDir, { recursive: true });
        log('info', `Created working directory: ${opts.workingDir}`);
      } catch (err) {
        log('error', `Failed to create working directory: ${err.message}`);
      }
    }

    try {
      assertSpawnAllowed(CLAUDE_BIN, args, cwd);
    } catch (err) {
      if (err instanceof ShellGuardViolation) {
        log('error', `shell-guard refused agent step ${stepId}: ${err.message}`, err.details);
        handleGuardViolation(jobId, { ...err.details, stepId, agentId });
        return reject(err);
      }
      throw err;
    }
    // Use node directly to execute claude's cli.js — avoids shell interpretation
    // issues AND works on Linux where spawn without shell can't handle shebangs
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // stripApiKey: defense against anything setting ANTHROPIC_API_KEY at
      // runtime. The daemon authenticates exclusively via the Max-subscription
      // OAuth file at OAUTH_CREDS_PATH; if the env var leaks into a spawn the
      // CLI prioritises it and we'd silently switch to API-key billing.
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
    });

    registerChild(jobId, proc);

    // Track PID and model in heartbeat
    const entry = activeJobs.get(jobId);
    if (entry) {
      entry.pid = proc.pid;
      entry.model = opts.model || 'default';
    }

    let buffer = '';
    let finalResult = null;
    let stderrBuffer = '';
    // T0.1: accumulate the agent's prose output across all stream events so the
    // close-handler can scan for ---DONE--- + ---WORK_SUMMARY--- when the CLI
    // terminates non-zero. Capped at 64 KB to bound memory; the markers
    // typically land in the last few KB of agent output.
    let agentTextBuffer = '';
    const AGENT_TEXT_BUFFER_CAP = 64 * 1024;

    // Handle spawn failures (ENOENT, permissions, etc.)
    proc.on('error', (err) => {
      unregisterChild(jobId, proc);
      const msg =
        err.code === 'ENOENT'
          ? `Claude CLI not found at ${CLAUDE_BIN}. Is it installed?`
          : `Failed to spawn claude: ${err.message}`;
      log('error', msg);
      pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
      reject(new Error(msg));
    });

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(jobId, stepId, agentId, event, cwd);
          if (event.type === 'result') finalResult = event;
          // T0.1: accumulate agent prose for COST_HARD-after-DONE detection.
          // Two paths emit text: stream_event/text_delta (incremental) and
          // assistant/text-block (final). Keep both; cap at 64 KB.
          if (agentTextBuffer.length < AGENT_TEXT_BUFFER_CAP) {
            if (
              event.type === 'stream_event' &&
              event.event?.delta?.type === 'text_delta' &&
              typeof event.event.delta.text === 'string'
            ) {
              agentTextBuffer += event.event.delta.text;
            } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
              for (const block of event.message.content) {
                if (block?.type === 'text' && typeof block.text === 'string') {
                  agentTextBuffer += block.text;
                }
              }
            }
          }
        } catch {
          // Non-JSON line
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        stderrBuffer += text + '\n';
        log('debug', `stderr [${stepId}]: ${text}`);
      }
    });

    proc.on('close', (code) => {
      unregisterChild(jobId, proc);
      // Check for auth errors in stderr or stdout — also catch the silent-failure
      // pattern where Claude CLI exits 0 with $0 cost and empty output (seen when
      // the OAuth token is expired but stream-json mode swallowed the error).
      const allOutput = stderrBuffer + (finalResult?.result || '');
      const isAuthError = isAuthFailureOutput(allOutput);
      const silentZeroCost =
        code === 0 &&
        finalResult &&
        (finalResult.total_cost_usd || 0) === 0 &&
        !finalResult.result?.trim();
      const isRateLimit = /429|rate.?limit/i.test(allOutput);

      // pacman7 (2026-06-23) — transient API overload (Anthropic 529 /
      // "overloaded_error" / 5xx) with NO captured work. This is NOT an auth or
      // prompt failure: the agent never ran, the error is in the streamed text
      // (finalResult is usually null → it would otherwise fall through to the
      // success path with 0 tokens and empty output, failing every downstream
      // gate). Tag it so runAgentWithAuthRecovery backs off and retries WITHOUT
      // consuming the story's dev-retry budget (the 529 storm burned all 3
      // retries because each immediate retry hit 529 again). Checked BEFORE the
      // auth/silent-zero-cost branch so a 529 isn't misrouted as an auth failure.
      const isOverloaded =
        /overloaded_error|\boverloaded\b|API Error:\s*(500|502|503|504|529)/i.test(
          allOutput + agentTextBuffer,
        );
      if (isOverloaded && classifyCompletion(agentTextBuffer) === 'none') {
        const msg = 'Claude API overloaded (transient 5xx) — backing off to retry.';
        log('warn', `Step ${stepId}: ${msg}`);
        pushEvent(jobId, stepId, agentId, 'status', {
          text: '[SYSTEM] terminationReason=API_OVERLOADED — transient; backing off and retrying (does not consume a story retry)',
        });
        const oErr = new Error(msg);
        oErr.code = 'OVERLOADED';
        return reject(oErr);
      }

      if (isAuthError || silentZeroCost) {
        // Mark auth as invalid so the next heartbeat reflects reality immediately.
        authState.valid = false;
        authState.error =
          (silentZeroCost ? 'silent zero-cost failure' : allOutput.slice(0, 200)) || 'auth failure';
        authState.checkedAt = new Date().toISOString();

        // Pipeline v2.0 PR-6 (B) — save the buffer if the agent already
        // emitted complete output. dino1 retry forensic (2026-04-29): the
        // REVIEWER fully emitted ---REVIEW_CRITERIA--- + END marker, then
        // OAuth expired ~291ms later. Without this branch, that complete
        // verdict was thrown away and the job marked FAILED. With it, the
        // captured output is treated as success and the orchestrator
        // advances normally — operator only sees the auth-expired warning.
        const completionKind = classifyCompletion(agentTextBuffer);
        if (completionKind !== 'none') {
          log(
            'warn',
            `Step ${stepId}: OAuth expired AFTER agent completed (${completionKind}); saving captured output as success`,
            { bufferBytes: agentTextBuffer.length, completionKind },
          );
          pushEvent(jobId, stepId, agentId, 'status', {
            text: `[SYSTEM] terminationReason=AUTH_EXPIRED_AFTER_OUTPUT (${completionKind}) — saving captured output; auth flagged for next spawn`,
          });
          return resolve({
            type: 'result',
            total_cost_usd: 0,
            session_id: '',
            result: agentTextBuffer.slice(-AGENT_TEXT_BUFFER_CAP),
            modelUsage: {},
            duration_ms: 0,
            num_turns: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            _terminationReason: 'AUTH_EXPIRED_AFTER_OUTPUT',
            _completionKind: completionKind,
          });
        }

        // Genuine auth failure mid-stream with no captured work. Reject
        // with a tagged error so the runAgentWithAuthRecovery wrapper
        // (PR-6 B+) can catch it and attempt recovery.
        const msg =
          'Claude Code OAuth expired on EC2 — click Re-authorize in the admin UI to push fresh tokens from your Mac Keychain.';
        log('error', msg);
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        const err = new Error(msg);
        err.code = 'AUTH_FAILED'; // recognized by runAgentWithAuthRecovery
        return reject(err);
      }

      if (isRateLimit) {
        const msg =
          'Claude Code rate limited (429). Too many concurrent requests. Retry in a moment.';
        log('warn', msg);
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        return reject(new Error(msg));
      }

      if (code !== 0 && !finalResult) {
        // T0.1 + PR-6(B) — Pipeline v2.0 efficiency fix.
        // If the agent emitted complete output (DEV: ---DONE---+
        // ---WORK_SUMMARY---; REVIEWER: ---REVIEW_CRITERIA---+
        // ---END_REVIEW_CRITERIA---; COMPILER: ---DONE---) before the CLI
        // forced a termination (typically COST_HARD, but also OOM-kill,
        // SIGTERM, etc.), the work is captured. Synthesize a finalResult so
        // executePipeline can run extractors against the buffered text and
        // proceed normally. Without this, the job re-enqueues and the same
        // conclusion is re-discovered at full cost — dino1 burned ~$35 on
        // this loop.
        const completionKind = classifyCompletion(agentTextBuffer);
        if (completionKind !== 'none') {
          log(
            'warn',
            `Step ${stepId}: forced termination (exit ${code}) AFTER ${completionKind} completion; treating as success`,
            {
              bufferBytes: agentTextBuffer.length,
              completionKind,
              stderr: stderrBuffer.slice(0, 200),
            },
          );
          pushEvent(jobId, stepId, agentId, 'status', {
            text: `[SYSTEM] terminationReason=FORCED_TERMINATION_AFTER_OUTPUT (${completionKind}) — agent emitted completion markers before termination; treating as success`,
          });
          return resolve({
            type: 'result',
            // Cost is unknown (no result event arrived); 0 keeps rollups stable.
            // Observability sees the COST_HARD log line + the synthesized event.
            total_cost_usd: 0,
            session_id: '',
            // executePipeline reads result.result for runExtractors; the buffer
            // contains the agent's full prose including all envelope markers.
            result: agentTextBuffer.slice(-AGENT_TEXT_BUFFER_CAP),
            modelUsage: {},
            duration_ms: 0,
            num_turns: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            // Tag for downstream observability — not consumed by executePipeline
            // today, but cheap to surface for future debugging.
            _terminationReason: 'FORCED_TERMINATION_AFTER_OUTPUT',
            _completionKind: completionKind,
          });
        }

        const errorDetail = stderrBuffer.trim() || `Process exited with code ${code}`;
        log('error', `Step ${stepId} failed: ${errorDetail}`);
        pushEvent(jobId, stepId, agentId, 'step_error', {
          text: `Step failed (exit ${code}): ${errorDetail.slice(0, 500)}`,
        });
        return reject(
          new Error(`Step ${stepId} (agent ${agentId}) failed: ${errorDetail.slice(0, 200)}`),
        );
      }

      // Check if result contains auth error in text_delta
      if (finalResult?.result && isAuthError) {
        const msg = 'Claude authentication expired during execution';
        pushEvent(jobId, stepId, agentId, 'step_error', { text: msg });
        return reject(new Error(msg));
      }

      // Extract model usage info
      const modelKey = finalResult?.modelUsage ? Object.keys(finalResult.modelUsage)[0] : null;
      const modelInfo = modelKey ? finalResult.modelUsage[modelKey] : {};
      const cost = finalResult?.total_cost_usd || 0;
      const inputTokens = modelInfo.inputTokens || finalResult?.usage?.input_tokens || 0;
      const outputTokens = modelInfo.outputTokens || finalResult?.usage?.output_tokens || 0;
      const cacheRead = modelInfo.cacheReadInputTokens || 0;
      const cacheCreation = modelInfo.cacheCreationInputTokens || 0;
      const contextWindow = modelInfo.contextWindow || 0;
      const totalTokens = inputTokens + outputTokens + cacheCreation;
      const contextPercent =
        contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 100) : 0;

      log('info', `Step ${stepId} complete`, {
        cost: `$${cost.toFixed(4)}`,
        duration: finalResult?.duration_ms,
        session: finalResult?.session_id,
        model: modelKey || 'unknown',
        tokens: `${inputTokens}in + ${outputTokens}out + ${cacheCreation}cache = ${totalTokens} (${contextPercent}% of ${contextWindow})`,
        turns: finalResult?.num_turns,
      });

      pushEvent(jobId, stepId, agentId, 'step_complete', {
        cost,
        sessionId: finalResult?.session_id || '',
        durationMs: finalResult?.duration_ms || 0,
        text: JSON.stringify({
          model: modelKey || 'unknown',
          inputTokens,
          outputTokens,
          cacheCreation,
          cacheRead,
          contextWindow,
          contextPercent,
          numTurns: finalResult?.num_turns || 0,
        }),
      });

      resolve(finalResult);
    });
  });
}

// ── Process stream-json events ──

/**
 * Pipeline v2.0 B8 — handle a denied Bash command.
 *
 * SIGTERM the active child for this jobId, push a step_error event for
 * observability, and write a 'tamper-reverted' attention item so the
 * operator can review what the agent attempted. The child's close handler
 * will subsequently reject runAgent — handleJobFailure decides whether
 * the job is retriable (story pipelines retry once per T0.3; the agent
 * gets a fresh attempt with the same prompt and presumably tries again,
 * which this gate will block again — net effect: predictable failure).
 *
 * The deny is non-bypassable: there's no way for the agent to "negotiate"
 * past it via prompt jiggling. The pattern matching happens before the
 * tool_result event is emitted back to the agent, but the bash command
 * has already started executing — the SIGTERM is best-effort harm
 * reduction, not pre-execution prevention. Future: pair with
 * `--disallowedTools=Bash` on agents that don't need Bash at all
 * (REVIEWER, COMPILER) so the surface area is even smaller.
 */
async function handleDeniedBashCommand({ jobId, stepId, agentId, command, verdict }) {
  log(
    'error',
    `[${jobId.slice(0, 8)}] B8 deny — killing child: pattern=${verdict.label} cmd=${command.slice(0, 200)}`,
  );
  await pushEvent(jobId, stepId, agentId, 'step_error', {
    text: `[B8] Bash command denied by deny-pattern (${verdict.label}): ${verdict.reason}`,
    deniedCommand: command.slice(0, 500),
    deniedPattern: verdict.label,
  });

  // SIGTERM only this job's children. Other in-flight jobs are unaffected.
  try {
    const signaled = signalChildrenForJob(jobId, 'SIGTERM');
    log('warn', `[${jobId.slice(0, 8)}] B8: SIGTERMed ${signaled} child(ren)`);
  } catch (sigErr) {
    log('error', `[${jobId.slice(0, 8)}] B8: SIGTERM failed: ${sigErr.message}`);
  }

  // Surface to the operator inbox. Best-effort; failure here is non-fatal.
  try {
    const planId = await resolvePlanIdFromEpicId(ddb, /* epicId */ null);
    // We don't have epicId in this scope; the writer accepts a falsy planId
    // and skips DDB writes silently. The step_error event above is the
    // primary surface; the attention item is the secondary one.
    if (planId) {
      await writeAttentionItem(
        ddb,
        {
          planId,
          severity: 'high',
          category: 'tamper-reverted',
          title: `Agent attempted denied Bash command (B8: ${verdict.label})`,
          body:
            `The ${agentId || 'agent'} step "${stepId}" attempted a Bash command ` +
            `that the daemon's B8 deny-pattern enforcement classified as harmful: ` +
            `${verdict.reason}. Command (truncated): \`${command.slice(0, 300)}\`. ` +
            `The child process was SIGTERM-ed; the job will fail with a step_error. ` +
            `If this is a false-positive, edit daemon/lib/bash-deny-patterns.mjs.`,
          context: { jobId, stepId, agentId, deniedPattern: verdict.label },
          suggestedActions: [
            { label: 'Open logs', kind: 'open-logs' },
            { label: 'Open story', kind: 'open-story' },
          ],
        },
        log,
      );
    }
  } catch (attnErr) {
    log('error', `[${jobId.slice(0, 8)}] B8: attention-item write failed: ${attnErr.message}`);
  }
}

async function processStreamEvent(jobId, stepId, agentId, event, workingDir) {
  switch (event.type) {
    case 'stream_event': {
      const delta = event.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        await pushEvent(jobId, stepId, agentId, 'text_delta', { text: delta.text });
      }
      break;
    }
    case 'assistant': {
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          await pushEvent(jobId, stepId, agentId, 'tool_use', {
            toolName: block.name,
            toolInput: JSON.stringify(block.input).slice(0, 2000),
          });

          // Epic 4 (2026-05-20) — record Skill activations into
          // .context/loaded-skills.json. Story 2.0 probe confirmed
          // Claude Code's built-in `Skill` tool fires this exact event
          // shape when the agent auto-activates a skill on prompt-content
          // match. Best-effort: any error (manifest read, file write)
          // is swallowed — the commit-trailer can tolerate a missing
          // file (emits the label-only form).
          if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
            try {
              const result = recordSkillActivation({
                workingDir,
                skillName: block.input.skill,
              });
              if (result.written) {
                await pushEvent(jobId, stepId, agentId, 'skill_activated', {
                  // snake3 (2026-06-10) — `text` is what the UI live-log
                  // renders; without it the row shows an empty line.
                  text: `Skill activated: ${block.input.skill} (${result.source})`,
                  skill: block.input.skill,
                  source: result.source,
                  totalLoaded: result.total,
                });
              }
            } catch (err) {
              // Don't surface as attention — the agent's behavior isn't
              // affected by the trailer tracking failure.
              log('warn', `[${jobId.slice(0, 8)}] loaded-skills tracker failed: ${err.message}`);
            }
          }

          // Pipeline v2.0 B8 — Bash deny-pattern enforcement.
          // The CLI's --allowedTools flag controls which tools are AVAILABLE,
          // but it can't sub-restrict Bash command shapes. We enforce
          // scaffolding-prohibition (npm create vite, git init, rm -rf .,
          // etc.) at the daemon by SIGTERM-ing the child as soon as we
          // observe a denied command. The agent's prompt no longer needs
          // a PROJECT BASELINE prose paragraph — the rule is unbypassable
          // at the process layer.
          if (block.name === 'Bash' && typeof block.input?.command === 'string') {
            const verdict = matchesDenyPattern(block.input.command);
            if (verdict.denied) {
              await handleDeniedBashCommand({
                jobId,
                stepId,
                agentId,
                command: block.input.command,
                verdict,
              });
            }
          }
        }
        if (block.type === 'text' && block.text) {
          await pushEvent(jobId, stepId, agentId, 'text_delta', { text: block.text });
        }
      }
      break;
    }
    case 'tool_result': {
      const output =
        typeof event.output === 'string'
          ? event.output.slice(0, 2000)
          : JSON.stringify(event.output).slice(0, 2000);
      await pushEvent(jobId, stepId, agentId, 'tool_result', { toolOutput: output });
      break;
    }
    // Story F.3 (2026-05-30) — capture the CLI's `system`/`init` event, which
    // carries the `skills[]` + `tools[]` arrays the session actually has.
    // Previously discarded — which is exactly why the skills-never-committed
    // defect (dino1: skills:null) took a multi-hour trace instead of a glance:
    // this event would have shown `skills: []` immediately. Emitting it as a
    // `skills_available` forensic event makes "did skills load?" a one-glance
    // check and gives the forensic exporter a ground-truth signal.
    case 'system': {
      if (event.subtype === 'init') {
        const skills = Array.isArray(event.skills) ? event.skills : [];
        const tools = Array.isArray(event.tools) ? event.tools : [];
        await pushEvent(jobId, stepId, agentId, 'skills_available', {
          // snake3 (2026-06-10) — `text` is what the UI live-log renders;
          // the count was invisible before (blank row next to the label).
          text: `${skills.length} skills available (Skill tool ${tools.includes('Skill') ? 'ON' : 'OFF'})`,
          skills,
          skillCount: skills.length,
          // `tools` can be long; record the count + whether Skill is present
          // rather than the full list, to keep the event row small.
          toolCount: tools.length,
          hasSkillTool: tools.includes('Skill'),
        });
        if (skills.length === 0) {
          log(
            'warn',
            `[${jobId.slice(0, 8)}] CLI init reports ZERO skills available — ` +
              `check .claude/skills/ is committed + present in the worktree (Story F)`,
          );
        }
      }
      break;
    }
  }
}

// ── Update job fields helper ──

/**
 * PR-12 — variables that MUST NOT be persisted to the agent-jobs DDB row.
 *
 * `PROJECT_CONTEXT` is the serialized Story Context Pack (PR-11 #2):
 * project tree + recent diffs + knowledge index + adjacent file heads. It
 * routinely runs >100 KB and pushes the row past DDB's 400 KB item limit,
 * which surfaces as:
 *
 *   ExpressionAttributeValues contains invalid value:
 *   Item size has exceeded the maximum allowed size for key :variables
 *
 * The pack is rebuilt at job-pickup from DDB anyway (idempotent assembly),
 * so persisting it is wasted bytes — strip it at the persist boundary.
 *
 * Add other vars here if their persisted state is genuinely transient
 * (i.e., reconstructible from job metadata + working tree).
 */
// Concept v2 (E2.4) — the raw generated markdown is the artifact OF RECORD on
// disk (write-back lands `concept/<kind>.md` + sidecar). It must NOT be
// persisted as a job variable — full PRD/UX/Arch prose can blow the ~400KB DDB
// item cap. Write-back + manifest capture run at extraction time (in-memory),
// then these vars are stripped before persist; the small `<KIND>_SECTIONS_JSON`
// manifest var (ids/ranges/hash, no prose) survives for the apply endpoint.
const TRANSIENT_VARS = new Set([
  'PROJECT_CONTEXT',
  'PRD_MD',
  'UX_MD',
  'ARCHITECTURE_MD',
  // E3.2a — inlined upstream doc bodies for {{PRIOR_ARTIFACTS}}; prompt-only,
  // never persisted (can be large — dodges the ~400KB DDB item cap).
  'PRIOR_ARTIFACTS',
  // E5.2 — citable section ids for the pm-plan {{CITABLE_SECTIONS}} placeholder;
  // prompt-only, filled from the on-disk manifests at run time.
  'CITABLE_SECTIONS',
]);

// Concept v2 (E2.4) — map a captured generator variable → its ArtifactKind.
// The daemon runs write-back for any of these present after extraction.
const CONCEPT_GEN_VARS = {
  PRD_MD: 'prd',
  UX_MD: 'ux',
  ARCHITECTURE_MD: 'architecture',
};

function stripTransientVars(variables) {
  if (!variables || typeof variables !== 'object') return variables;
  const out = {};
  for (const [k, v] of Object.entries(variables)) {
    if (TRANSIENT_VARS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

async function updateJobFields(jobId, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);

  const names = {};
  const values = {};
  const expressions = [];

  for (const [key, value] of entries) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

// ── Write heartbeat so UI can show daemon status ──

const DAEMON_SOURCE = process.env.DAEMON_SOURCE || 'local';

// Servers module (Task 18) — this daemon's fleet identity + servers table.
// SERVER_ID is what the dispatcher stamps on `assignedServerId`; the daemon
// polls/claims/heartbeats under it when `dispatch.serverAware` is on.
const SERVER_ID = resolveServerId(process.env);
const SERVERS_TABLE = process.env.SERVERS_TABLE || 'futurator-servers';
// A FLEET daemon is one provisioned by the Servers module: cloud-init (or the
// local-machine install command) injects SERVER_ID explicitly. The two legacy
// daemons predate the module and identify only by DAEMON_SOURCE=ec2|local.
//
// The distinction matters twice:
//  1. DAEMON_HEARTBEAT is a SINGLE fixed-key row. A fleet box writing it
//     hijacks the EC2/local daemon widget — observed live: the row's `source`
//     became `srv_gcp_zu6y9a`. Fleet daemons report in their own server row.
//  2. With dispatch.serverAware OFF there is no assigned-index and no CAS
//     claim, so a fleet box polling the global pool is an uncoordinated worker
//     racing the Mac/EC2 daemons for the same jobs. It must idle instead.
const IS_FLEET_DAEMON = Boolean(process.env.SERVER_ID);
// CAS claim lease (matches atomic-claim's DEFAULT_LEASE_MS); renewed at 1/3.
const JOB_CLAIM_LEASE_MS = 15 * 60 * 1000;
// Daemon build fingerprint for the servers-row heartbeat (same sha256-over-self
// scheme the boot banner prints — dino1 stale-deploy lesson, 2026-05-02).
const DAEMON_VERSION = (() => {
  try {
    const buf = readFileSync(new URL(import.meta.url).pathname);
    return createHash('sha256').update(buf).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
})();

// Queues module — a laptop daemon (DAEMON_SOURCE=local) can run CONCURRENTLY
// with the EC2 daemon to service 'local'-targeted queue calls. But non-queue
// jobs (pipeline/party/free-agent) are claimable by any source, so without a
// guard the laptop would hijack production pipeline jobs and run them in the
// wrong environment. Set DAEMON_QUEUE_ONLY=1 on such a laptop daemon: it then
// claims ONLY queue-request jobs (still subject to target routing), leaving
// everything else to EC2. Unset (EC2 default) → claims all job types.
const DAEMON_QUEUE_ONLY = process.env.DAEMON_QUEUE_ONLY === '1';

/**
 * Whether THIS daemon may claim a given PENDING job, combining the queue-only
 * gate (DAEMON_QUEUE_ONLY) with queue-request target routing (DAEMON_SOURCE).
 */
function canClaimJob(job) {
  if (DAEMON_QUEUE_ONLY && job?.jobType !== 'queue-request') return false;
  return isJobClaimableBySource(job, DAEMON_SOURCE);
}

// Servers module (Task 18) — log the missing-row conditional failure once,
// not every ~10s heartbeat (a destroyed server's daemon keeps ticking until
// its VM is deleted; its row must NOT be resurrected).
let _serverRowMissingLogged = false;

async function writeHeartbeat() {
  try {
    const processes = [];
    for (const [jobId, info] of activeJobs) {
      processes.push({
        jobId: jobId.slice(0, 12),
        stepId: info.stepId,
        agentId: info.agentId,
        model: info.model,
        pid: info.pid,
        startedAt: info.startedAt,
        workingDir: (info.workingDir || '').split('/').pop() || '',
      });
      // Per-job liveness refresh (pacman1 triple-mint, 2026-07-13): a story-dev
      // job's lastHeartbeatAt was written once at start, then the claude spawn
      // ran >5 min with no DDB write — indistinguishable from a crash to any
      // stale check that can't see this process's activeJobs. Tick the row
      // ~every 60s while the job is live so staleness means actual death.
      // Fire-and-forget: a missed tick only delays the next one.
      if (!info.jobHbMs || Date.now() - info.jobHbMs > 60_000) {
        info.jobHbMs = Date.now();
        updateJobFields(jobId, { lastHeartbeatAt: new Date().toISOString() }).catch(() => {});
      }
    }

    const mem = { totalMem: totalmem(), freeMem: freemem(), loadAvg: loadavg() };

    // The legacy DAEMON_HEARTBEAT row belongs to the ec2/local daemons — it is
    // a single fixed key, so a fleet box writing it would overwrite theirs.
    if (!IS_FLEET_DAEMON) {
      await ddb.send(
        new PutCommand({
          TableName: JOBS_TABLE,
          Item: {
          jobId: 'DAEMON_HEARTBEAT',
          status: 'ALIVE',
          source: DAEMON_SOURCE,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          activeCount: activeJobs.size,
          // Queues module — publish the *live* effective cap (operator override
          // via agent-flags, applied each poll tick) so the EC2 Monitor reflects
          // the current ceiling, not the boot-time constant.
          maxConcurrent: effectiveMaxConcurrent,
          // Pipeline-3 ready-frontier dispatch mode (off|shadow|on). Surfaced so
          // Labs3 can tell the operator whether ingested StoryNodes will actually
          // be dispatched — an ingested plan whose frontier is off/shadow sits
          // idle, which otherwise looks like a silent hang.
          p3ReadyFrontier: envFlag('P3_READY_FRONTIER'),
          // Story 20.16 — ConcurrencyManager snapshot. Lives alongside
          // the legacy `processes` array; UI diagnostics can use either.
          // The snapshot is cheap to compute (in-memory map walk) so we
          // emit it every heartbeat (~10s).
          concurrency: {
            enabled: CONCURRENCY_MANAGER_ENABLED,
            ...concurrencyManager.getSnapshot(),
          },
          processes,
          system: {
            totalMem: Math.round(mem.totalMem / 1024 / 1024),
            freeMem: Math.round(mem.freeMem / 1024 / 1024),
            loadAvg: mem.loadAvg.map((v) => Math.round(v * 100) / 100),
          },
          auth: {
            valid: authState.valid,
            checkedAt: authState.checkedAt,
            error: authState.error,
            hasFile: authState.hasFile,
            hasRefresh: authState.hasRefresh,
            loadedAt: authState.loadedAt ? new Date(authState.loadedAt).toISOString() : null,
            expiresAt: authState.expiresAt ? new Date(authState.expiresAt).toISOString() : null,
            subscriptionType: authState.subscriptionType,
            },
          },
        }),
      );
    }

    // Servers module (Task 18, spec §5.2) — heartbeat this daemon's own row in
    // `futurator-servers` (in ADDITION to the legacy DAEMON_HEARTBEAT row, kept
    // during migration). Update-only: `attribute_exists(serverId)` so a deleted
    // server's still-running daemon can never resurrect its row.
    //
    // UNCONDITIONAL, per plan Task 18 ("in addition to the legacy row"). It was
    // gated behind dispatch.serverAware, which made provisioning unverifiable:
    // a server can only reach ACTIVE via this write, so with dispatch off every
    // fleet box sat in BOOTSTRAPPING forever even when its daemon was healthy
    // and polling. Liveness reporting must not depend on the dispatch switch —
    // that is the same lie as an ACTIVE badge with no heartbeat.
    {
      try {
        const nowIso = new Date().toISOString();
        await ddb.send(
          new UpdateCommand({
            TableName: SERVERS_TABLE,
            Key: { serverId: SERVER_ID },
            UpdateExpression:
              'SET lastHeartbeatAt = :now, activeCount = :n, daemonVersion = :v, #system = :sys, #auth = :auth, updatedAt = :now',
            ConditionExpression: 'attribute_exists(serverId)',
            // Both `system` and `auth` are DynamoDB reserved words — must alias.
            ExpressionAttributeNames: { '#system': 'system', '#auth': 'auth' },
            ExpressionAttributeValues: {
              ':now': nowIso,
              ':n': activeJobs.size,
              ':v': DAEMON_VERSION,
              ':sys': {
                totalMem: Math.round(mem.totalMem / 1024 / 1024),
                freeMem: Math.round(mem.freeMem / 1024 / 1024),
                loadAvg: mem.loadAvg.map((v) => Math.round(v * 100) / 100),
              },
              // Liveness is not readiness: a box can heartbeat perfectly while
              // `claude -p` answers "Not logged in" — which is exactly what a
              // broken credentials fetch produced, under a green ACTIVE badge.
              // Report auth so the fleet card can tell the difference.
              ':auth': {
                valid: Boolean(authState.valid),
                error: authState.error ? String(authState.error).slice(0, 200) : null,
                checkedAt: authState.checkedAt ?? null,
                subscriptionType: authState.subscriptionType ?? null,
              },
            },
          }),
        );
        _serverRowMissingLogged = false;
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          if (!_serverRowMissingLogged) {
            _serverRowMissingLogged = true;
            log(
              'warn',
              `[server-heartbeat] no ${SERVER_ID} row in ${SERVERS_TABLE} — server deleted or not yet seeded; heartbeat skipped (logged once)`,
            );
          }
        } else if (err?.name === 'ValidationException') {
          // A malformed UpdateExpression is a CODE bug, not a transient — it
          // will fail on EVERY heartbeat, so the box never reaches ACTIVE while
          // the outer catch silently eats it. (Lived it: `auth` is a reserved
          // word and wasn't aliased.) Make it LOUD so the next one is minutes,
          // not another provision cycle. Still don't crash the daemon over it.
          log('error', `[server-heartbeat] BUG: DynamoDB rejected the write — ${err.message}`);
        } else {
          throw err; // genuinely transient — swallowed by the outer catch, retried next tick
        }
      }
    }
  } catch {
    // Non-critical
  }
}

// ── Stale-heartbeat scan for crash-resume (EO-4.5) ──
// Query RUNNING epic-dev jobs, find ones whose lastHeartbeatAt is older
// than STALE_HEARTBEAT_MS, mark them STALE, and create a fresh PENDING
// job that carries the accumulated waveResults forward via
// resumeFromWaveResults. The poll loop will then pick the new job up
// and spawn a new orchestrator that skips completed waves.
let lastStaleScanAt = 0;
// Pipeline-3 (development-plan §5.2) — ready-frontier shadow scan throttle.
// Inert unless P3_READY_FRONTIER is set; logs would-dispatch vs legacy waves.
let lastFrontierScanAt = 0;
const FRONTIER_SCAN_INTERVAL_MS = parseInt(process.env.P3_FRONTIER_SCAN_INTERVAL_MS || '60000', 10);
// Reality-Spine review fix — reconciliation sweep throttle. Re-drives the
// all-resolved → integrate → review advance for developing/fixing plans so a
// lost/failed integrator enqueue self-heals instead of deadlocking a plan out
// of review forever (the advance only otherwise fires on a fresh story/integrator
// completion). Idempotent: maybeAdvancePlanOnAllResolved self-guards on
// all-resolved, the reflector claim dedupes, and integrator enqueue is
// at-most-once per head.
let lastIntegrateSweepAt = 0;
const INTEGRATE_SWEEP_INTERVAL_MS = parseInt(process.env.P3_INTEGRATE_SWEEP_INTERVAL_MS || '120000', 10);
const PLAN_SPEC_GRAPH_TABLE = process.env.PLAN_SPEC_GRAPH_TABLE || 'futurator-plan-spec-graph';

// Throttled, inert-by-default. When P3_READY_FRONTIER=shadow|on, scan the
// plan-spec-graph for ingested plans and dispatch each plan's ready frontier:
// shadow LOGS would-dispatch (the A/B substrate vs legacy waves); on CLAIMS each
// ready story atomically and mints a `story-dev` AgentJob the poll loop runs.
async function runFrontierScan() {
  const mode = envFlag('P3_READY_FRONTIER');
  if (mode === 'off') return;
  try {
    const [{ runFrontierTick }, { buildStoryDevContract, buildStoryDevJob, mintStoryDevJob }] = await Promise.all([
      import('./lib/story-dispatch-driver.mjs'),
      import('./lib/story-job-minter.mjs'),
    ]);
    // Low-volume table; a scan projecting just planId is cheap at this cadence.
    const { Items } = await ddb.send(
      new ScanCommand({ TableName: PLAN_SPEC_GRAPH_TABLE, ProjectionExpression: 'planId' }),
    );
    const planIds = [...new Set((Items || []).map((i) => i.planId).filter(Boolean))];

    for (const planId of planIds) {
      // In 'on' mode, resolve the plan's working dir + appId once so the minter
      // can build runnable story-dev jobs.
      let plan = null;
      if (mode === 'on') {
        const r = await ddb.send(new GetCommand({ TableName: PLANS_TABLE, Key: { planId } })).catch(() => null);
        plan = r?.Item || null;
      }

      const enqueue = async (storyNode) => {
        const contract = buildStoryDevContract({ storyNode });
        const row = buildStoryDevJob({
          storyNode,
          planId,
          appId: storyNode.appId || plan?.appId || '',
          workingDir: plan?.workingDir || storyNode.workingDir || '',
          contract,
          claimToken: storyNode.claimToken,
          jobId: randomUUID(),
        });
        if (!row.workingDir) {
          log('warn', `[frontier] story ${storyNode.storyId} has no resolvable workingDir — skipping mint`);
          return;
        }
        // Plan-affinity only: the frontier tick has no parent job (it runs on a
        // scan cadence, not inside a job's execution), so self-assign never
        // applies — the sweeper picks the owner and every story of the plan
        // follows it. Self-assigning here would strand ALL stories on whichever
        // daemon happened to run the scan.
        Object.assign(row, planAffinityStamp({ planId }));
        await mintStoryDevJob({ ddb, table: JOBS_TABLE, row });
        // Link the story row → its story-dev job so Labs3 can stream the live log
        // (the story detail fetches events via story.jobId). Best-effort — a miss
        // only costs the log link, never the run. #state is unrelated here.
        try {
          await ddb.send(new UpdateCommand({
            TableName: PLAN_SPEC_GRAPH_TABLE,
            Key: { storyId: storyNode.storyId },
            UpdateExpression: 'SET jobId = :j, updatedAt = :now',
            ExpressionAttributeValues: { ':j': row.jobId, ':now': new Date().toISOString() },
          }));
        } catch (e) {
          log('warn', `[frontier] story ${storyNode.storyId} jobId link failed (non-blocking): ${e.message}`);
        }
        log('info', `[frontier] minted story-dev job ${row.jobId.slice(0, 8)} for story ${storyNode.storyId}`);
      };

      const res = await runFrontierTick({
        ddb,
        table: PLAN_SPEC_GRAPH_TABLE,
        planId,
        p3Flags: { P3_READY_FRONTIER: mode, P3_FRONTIER_MODE: envFlag('P3_FRONTIER_MODE') },
        owner: 'daemon',
        enqueue: mode === 'on' ? enqueue : undefined,
        log,
      });
      if (mode === 'shadow' && res.frontier.length) {
        log('info', `[frontier-shadow] plan ${planId}: would dispatch ${res.frontier.length} ready stories [${res.frontier.join(', ')}]`);
      }
      if (mode === 'on' && res.dispatched.length) {
        log('info', `[frontier] plan ${planId}: dispatched ${res.dispatched.length} stories [${res.dispatched.join(', ')}]`);
      }
    }
  } catch (err) {
    log('warn', `[frontier] scan failed (non-blocking): ${err.message}`);
  }
}

// Pipeline-3 (development-plan §4) — execute one per-story dev job: run a single
// Claude scoped to the story's touches under the live gate, then apply the
// deterministic completion verdict to the StoryNode + unblock its dependents.
// quick-planspec — intent → plan_spec ingest (the Labs3 fast path). Builds the
// injected I/O the pure runner needs (job read, StoryNode batch-put, attention).
async function executeQuickPlanspecJob(job) {
  await runQuickPlanspecJob(job, {
    spawn,
    claudeBin: CLAUDE_BIN,
    eventLogDir: EVENT_LOG_DIR,
    getJob: async (id) => (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId: id } }))).Item,
    batchPutStoryNodes: async (rows) => {
      for (const Item of rows) {
        await ddb.send(new PutCommand({ TableName: PLAN_SPEC_GRAPH_TABLE, Item }));
      }
    },
    updateJobFields,
    writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
    // Persist the planner narrative/shape onto the plan row. Mirrors the integrator's
    // plan-row UpdateCommand pattern (grep integrateVerifiedAt) — same table, same
    // client. Only SETs defined fields so an absent narrative never nulls a column;
    // named-attr aliases keep it safe against any future reserved word.
    updatePlanFields: async (planId, fields) => {
      const sets = [];
      const names = {};
      const values = {};
      for (const [k, v] of Object.entries(fields || {})) {
        if (v === undefined) continue;
        sets.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      if (!sets.length) return; // nothing to persist (all fields undefined)
      names['#updatedAt'] = 'updatedAt';
      values[':updatedAt'] = new Date().toISOString();
      sets.push('#updatedAt = :updatedAt');
      await ddb.send(new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    },
    // Brownfield test-law: list the repo's committed test files so the runner can
    // lock them into every story's forbiddenAreas (prior plans' tests are immutable
    // across brownfield growth — pacman8 root cause). Uses the daemon's existing
    // git helper (runs as the repo owner). Fail-soft: any error → [] (plan proceeds).
    listRepoTestFiles: async (dir) => {
      try {
        const r = await daemonGit(['ls-files'], dir);
        if (r.code !== 0) return [];
        return r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
      } catch {
        return [];
      }
    },
    log,
  });
}

// QA-Review W2 — execute a p3-qa job: drive the DEPLOYED dev URL through the
// plan's journeys (Lane 1) + before/after VQA (Lane 2) + the wiring/orphan check,
// then persist the plan-level verdict shadow-safely. All heavy deps (playwright,
// judge, s3) are wired from the daemon's existing gate/shell primitives. Never
// throws out — a failure marks the job FAILED and leaves the plan verdict alone.
async function executeP3QaJob(job) {
  const short = job.jobId.slice(0, 8);
  const vlog = (level, msg) => log(level, `[${short}] ${msg}`);
  await updateJobFields(job.jobId, { status: 'RUNNING', lastHeartbeatAt: new Date().toISOString() });

  const check = validateP3QaJob(job);
  if (!check.ok) {
    vlog('error', `p3-qa job invalid: ${check.reason}`);
    await updateJobFields(job.jobId, { status: 'FAILED', error: `invalid p3-qa job: ${check.reason}` });
    return;
  }

  // Load the plan + its story rows (touches → orphan check; ACs → journey fallback).
  const plan = (await ddb.send(new GetCommand({ TableName: PLANS_TABLE, Key: { planId: job.planId } }))).Item;
  if (!plan) {
    await updateJobFields(job.jobId, { status: 'FAILED', error: 'plan-not-found' });
    return;
  }
  let stories = [];
  try {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: PLAN_SPEC_GRAPH_TABLE,
      IndexName: 'planId-cohortBatch-index',
      KeyConditionExpression: 'planId = :p',
      ExpressionAttributeValues: { ':p': job.planId },
    }));
    stories = Items || [];
  } catch (e) { vlog('warn', `story read failed (orphan/journey coverage reduced): ${e.message}`); }

  const { runP3Qa } = await import('./lib/p3-qa-runner.mjs');
  const { defaultShellRunner } = await import('./lib/wave-merge-runner.mjs');
  let playwright = null;
  try { playwright = await import('playwright'); }
  catch (e) { vlog('warn', `playwright import failed — Lane 1 reports seam-unreachable (fail-closed): ${e.message}`); }

  // The job carries the authoritative pin (devUrl + qaCommitSha stamped at deploy).
  const planForQa = {
    ...plan,
    devUrl: job.devUrl || plan.devUrl,
    qaCommitSha: job.qaCommitSha || plan.qaCommitSha,
    workingDir: job.workingDir || plan.workingDir,
  };

  let verdict;
  try {
    verdict = await runP3Qa({
      plan: planForQa,
      stories,
      playwright,
      spawnJudge: (a) => spawnGateAgent({ ...a, role: 'judge' }, { short }),
      s3: (cmd, cwd, timeoutMs) => defaultShellRunner(cmd, cwd, timeoutMs),
      // p3-qa-runner reads qaContext.appDir (orphan scan root + judge/s3 cwd).
      // Passing `workingDir` here left appDir undefined → the orphan/wiring lane
      // silently never ran in production (shipped the pacman3 disease as a
      // false-pass). Key MUST be `appDir`. seamHook is boilerplate metadata
      // stamped on the job by the cron (never a pipeline constant).
      // screenshotBucket = the DEV-ENV bucket the daemon CAN write to (the
      // public futurator-ai-website is PutObject-denied to the EC2 role); frames
      // serve at screenshotBase (dev.futurator.ai) under the `_qa/` prefix.
      qaContext: {
        appDir: planForQa.workingDir,
        seamHook: job.seamHook,
        screenshotBucket: process.env.DEV_ENV_BUCKET,
        screenshotBase: process.env.DEV_ENV_BASE || 'https://dev.futurator.ai',
      },
      log,
    });
  } catch (e) {
    vlog('error', `p3-qa run threw: ${e.message}`);
    await updateJobFields(job.jobId, { status: 'FAILED', error: e.message });
    return;
  }

  // Persist shadow-safely: only under the SHA QA ran against, never over a human
  // decision (mirrors functions/shared repositories writeP3QaVerdict guards).
  // P3_QA_REVIEW honest-gate (Slice B): a NON-BLOCKING verdict ALSO stamps
  // qaVerifiedAt = now (the automated "deployed-app QA passed" mark, gated on the
  // same SHA/decision guards); a BLOCKING verdict REMOVEs any prior mark. The
  // SHA condition guarantees qaVerifiedAt only ever reflects the CURRENT build.
  try {
    const nonBlocking = verdict.blocking !== true;
    const updateExpr = nonBlocking
      ? 'SET p3QaVerdict = :v, qaVerifiedAt = :now, updatedAt = :now'
      : 'SET p3QaVerdict = :v, updatedAt = :now REMOVE qaVerifiedAt';
    await ddb.send(new UpdateCommand({
      TableName: PLANS_TABLE,
      Key: { planId: job.planId },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: { ':v': verdict, ':now': new Date().toISOString(), ':sha': verdict.ranAtSha || '' },
      ConditionExpression:
        '(attribute_not_exists(qaCommitSha) OR qaCommitSha = :sha) AND attribute_not_exists(p3QaVerdict.decidedAt)',
    }));
    vlog('info', `p3-qa verdict: status=${verdict.status} blocking=${verdict.blocking} verified=${nonBlocking} journeys=${verdict.journeys?.length ?? 0} orphans=${verdict.wiring?.orphanModules?.length ?? 0}`);
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') vlog('warn', 'p3-qa verdict dropped (stale SHA or human-decided)');
    else vlog('warn', `p3-qa verdict persist failed: ${e.message}`);
  }

  await updateJobFields(job.jobId, {
    status: 'COMPLETED',
    variables: { QA_STATUS: verdict.status, QA_BLOCKING: String(verdict.blocking) },
  });
}

async function executeStoryDevJob(job) {
  const short = job.jobId.slice(0, 8);
  const storyId = job.storyNodeRef?.storyId;
  const planId = job.storyNodeRef?.planId;
  await updateJobFields(job.jobId, { status: 'RUNNING', lastHeartbeatAt: new Date().toISOString() });

  // Read the plan row ONCE for rigor (gates skills commit trailer + reflector
  // firing) and appId (the code-knowledge-graph namespace).
  let planRow = null;
  try {
    planRow = (await ddb.send(new GetCommand({ TableName: PLANS_TABLE, Key: { planId } }))).Item;
  } catch { /* tolerate — fall back to defaults */ }
  const rigor = planRow?.rigor || 'mvp';
  const appId = planRow?.appId || pathBasename(job.workingDir || '');

  // QA-Review W1 (P3_LIFECYCLE) — the plan status driver. A P3 plan is created
  // at 'concept' and, without the epic-shaped reducer, would stay there forever.
  // On the first story dispatch, advance concept→developing so the lifecycle
  // strip reflects reality. Conditional write → idempotent + race-safe (only the
  // concept→developing transition ever fires here). Dark unless the flag is on.
  if (envFlag('P3_LIFECYCLE') === 'on' && planId) {
    const nextStatus = nextStatusOnDispatch(planRow?.status || 'concept');
    if (nextStatus) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: PLANS_TABLE,
          Key: { planId },
          UpdateExpression: 'SET #s = :next, updatedAt = :now',
          ConditionExpression: '#s = :concept',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':next': nextStatus, ':concept': 'concept', ':now': new Date().toISOString() },
        }));
        if (planRow) planRow.status = nextStatus;
        log('info', `[${short}] plan ${planId.slice(0, 8)} → ${nextStatus} (first dispatch)`);
      } catch { /* conditional-check fail = another job already advanced it; fine */ }
    }
  }

  const updateStoryState = async ({ storyId: sid, state, verdict, acceptanceCriteria, commitSha, metrics, loadedSkills, invariants, stageSummaries }) => {
    try {
      // Glue aliases EVERY key (#state is a reserved word + GSI key), flattens
      // metrics{} → cost/tokens/duration, persists the loaded skill set (forensic
      // Skills tab reads it off the row), and appends updatedAt EXACTLY ONCE
      // (no "Two document paths overlap"). We supply Key + TableName.
      // invariants (A1): the validator bindings MUST land on the row — they only
      // ever existed in the fresh test-author's stdout, so every resumed/retried
      // job re-derived manifest={} and fail-closed on 'no authored validator'
      // (pacman1 job 677f9e70: a retried invariant story could NEVER complete).
      // stageSummaries (B2): structured per-stage artifacts, size-capped upstream.
      const upd = buildStoryStateUpdate({ state, verdict, acceptanceCriteria, commitSha, metrics, loadedSkills, invariants, stageSummaries });
      await ddb.send(new UpdateCommand({
        TableName: PLAN_SPEC_GRAPH_TABLE,
        Key: { storyId: sid },
        ...upd,
      }));
    } catch (e) {
      log('warn', `[${short}] story state update failed (non-blocking): ${e.message}`);
    }
  };

  const propagate = async ({ completedStoryId }) => {
    try {
      const { Items } = await ddb.send(new QueryCommand({
        TableName: PLAN_SPEC_GRAPH_TABLE,
        IndexName: 'planId-cohortBatch-index',
        KeyConditionExpression: 'planId = :p',
        ExpressionAttributeValues: { ':p': planId },
      }));
      const nodes = (Items || []).map((r) => ({ storyId: r.storyId, depends_on: r.depends_on || [] }));
      const deps = dependentsOf(nodes, completedStoryId);
      const { unblocked } = await propagateCompletion({ ddb, table: PLAN_SPEC_GRAPH_TABLE, completedStoryId, dependents: deps });
      if (unblocked.length) {
        log('info', `[${short}] story ${completedStoryId} done → unblocked [${unblocked.join(', ')}]`);
        // W3.4 — force the next daemon poll (~POLL_INTERVAL, 3s) to run the frontier
        // scan instead of idling up to P3_FRONTIER_SCAN_INTERVAL_MS (60s). Kills the
        // last structural dead-time between a story finishing and its dependents
        // dispatching. No-op when the frontier is off (scan early-returns).
        lastFrontierScanAt = 0;
      }
    } catch (e) {
      log('warn', `[${short}] dependency propagation failed (non-blocking): ${e.message}`);
    }
  };

  let headSha = '';
  try {
    const r = await daemonGit(['rev-parse', 'HEAD'], job.workingDir);
    if (r.code === 0) headSha = r.stdout.trim();
  } catch { /* tolerate */ }

  // Thread rigor to the dev pipeline so it gates the skills commit trailer and
  // resolves the same rigor the reflector/compile phases use.
  if (job.storyDevPayload) job.storyDevPayload.rigor = rigor;

  // Resolve the boilerplate's qaContext (dev command / port / seam) so the
  // `browser` bound-AC executor can serve the app + drive Playwright against
  // `window.__harness`. Absent → browser ACs stay fail-closed (never fake-pass).
  let qaContext;
  try {
    const appRowQa = await getAppRow(appId);
    const { getGateEntry } = await import('./lib/gate-registry.mjs');
    qaContext = getGateEntry(appRowQa?.boilerplateType || 'nextjs-base')?.qaContext;
  } catch (e) {
    log('warn', `[${short}] qaContext resolve failed (browser ACs fail-closed): ${e.message}`);
  }

  const result = await runStoryDevJob({
    job,
    eventLogDir: EVENT_LOG_DIR,
    deps: {
      spawn,
      claudeBin: CLAUDE_BIN,
      headSha,
      // Reality-Spine P1/P2 — the hardened foundation gate (tsc+build+boot-
      // liveness, foundation stories) + the per-story green-trunk check
      // (tsc+build). The factory boots the real dev server (harness seam) and
      // lazy-imports playwright; story-dev-pipeline only decides WHEN to call
      // them (guarded by P3_FOUNDATION_GATE / P3_GREEN_TRUNK). qaContext is also
      // threaded so the foundation gate can resolve the boilerplate dev port.
      // Tree gates run via an async (non-blocking) spawn — never spawnSync — so
      // they don't freeze the daemon event loop (and every concurrent sibling
      // story) for the minutes a cold tsc+build can take. `git: daemonGit` lets
      // the gate SHA-pin its whole-tree verdict against a concurrent commit.
      ...makeStoryDevGateDeps({ cwd: job.workingDir, qaContext, git: daemonGit }),
      qaContext,
      // Real bound-AC test executors run in the shared plan tree. qaContext
      // enables the browser/__harness executor for kind=browser behavioral ACs.
      executors: defaultExecutors({ cwd: job.workingDir, qaContext, log: (lvl, m) => log(lvl, `[${short}] ${m}`) }),
      // Per-story commit (development-plan §4.1) — daemonGit runs as the repo owner.
      git: daemonGit,
      updateStoryState,
      propagateCompletion: propagate,
      // W3.2 — contract_frozen signal (dark under P3_FRONTIER_MODE=kahn): flip the
      // story to 'merging' after its integrate commit so a dependent's test-author
      // can start early in contract/green mode. Best-effort; the driver reads
      // storyState.
      markContractFrozen: async ({ storyId }) => {
        try {
          await ddb.send(new UpdateCommand({
            TableName: PLAN_SPEC_GRAPH_TABLE,
            Key: { storyId },
            UpdateExpression: 'SET storyState = :m, updatedAt = :now',
            ExpressionAttributeValues: { ':m': 'merging', ':now': new Date().toISOString() },
          }));
        } catch (e) {
          log('warn', `[${short}] contract_frozen write failed (non-blocking): ${e.message}`);
        }
      },
      // W2.1b — risk-tiered reviewer. Fresh read-only Claude over the diff + ACs;
      // ADVISORY (only fed into the verdict when P3_QUALITY_GATE=on, inside
      // handleStoryCompletion). Non-blocking → empty verdicts on any failure.
      spawnReviewer: async ({ acceptanceCriteria, headSha: sha }) => {
        try {
          // Sub-pipeline visibility: reviewer is its own stage (stepId 'reviewer').
          await pushEvent(job.jobId, 'reviewer', 'reviewer', 'step_start', {
            text: `reviewer: fresh-context review of ${acceptanceCriteria.length} AC(s) @${String(sha || '').slice(0, 7)}`,
          }).catch(() => {});
          const [{ buildReviewerPrompt, parseReviewerVerdict }, { extractAssistantText }] = await Promise.all([
            import('./lib/story-reviewer.mjs'),
            import('./lib/stream-json-text.mjs'),
          ]);
          let diff = '';
          try {
            // A retry attempt may commit NOTHING (the code landed in a prior
            // attempt), so `sha~1..sha` shows whatever unrelated commit happens
            // to be head — observed live: a movement retry was reviewed against
            // an operator hotfix diff and its ACs "failed". Review the story's
            // OWN commits (message convention `story(<storyId>)`), newest last;
            // fall back to the attempt diff only when none exist.
            const rvStoryId = job.storyDevPayload?.storyId;
            let storyShas = [];
            if (rvStoryId) {
              const l = await daemonGit(
                ['log', '--format=%H', '--grep', `story(${rvStoryId})`, '-n', '10', sha],
                job.workingDir,
              );
              storyShas = String(l.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
            }
            if (storyShas.length) {
              const parts = [];
              for (const s of storyShas.reverse()) {
                const d = await daemonGit(['show', '--patch', '--format=commit %h %s', s], job.workingDir);
                parts.push(String(d.stdout || ''));
              }
              diff = parts.join('\n');
            } else {
              const d = await daemonGit(['diff', `${sha}~1`, sha], job.workingDir);
              diff = String(d.stdout || '');
            }
          } catch { /* no diff → reviewer judges from ACs only */ }
          const prompt = buildReviewerPrompt({ storyTitle: job.storyDevPayload?.title, acceptanceCriteria, diff });
          // Reviewer effort is risk-tiered (model-effort-policy): cheap (low)
          // by default; P0/security ACs escalate to high. Plan overrides win.
          const { resolveAgentPolicy, cliModelArgs } = await import('./lib/model-effort-policy.mjs');
          const reviewerArgs = cliModelArgs(resolveAgentPolicy({
            role: 'reviewer',
            riskTags: acceptanceCriteria.map((a) => a?.riskTag).filter(Boolean),
            overrides: { model: planRow?.reviewerModel, effort: planRow?.reviewerEffort },
          }));
          const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
            ...reviewerArgs,
            '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read,Grep,Glob'];
          const out = await new Promise((res) => {
            let o = '';
            const c = spawn(CLAUDE_BIN, args, { cwd: job.workingDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            c.stdout.on('data', (ch) => { o += ch.toString('utf8'); });
            c.on('error', () => res(''));
            c.on('close', () => res(o));
          });
          const parsed = parseReviewerVerdict(extractAssistantText(out) || out);
          const fails = Object.values(parsed.verdicts).filter((v) => v === 'fail').length;
          await pushEvent(job.jobId, 'reviewer', 'reviewer', 'step_complete', {
            text: `reviewer verdicts: ${Object.keys(parsed.verdicts).length} AC(s), ${fails} fail, needs-human [${parsed.needsHuman.join(', ') || 'none'}]`,
          }).catch(() => {});
          return parsed;
        } catch (e) {
          log('warn', `[${short}] reviewer spawn failed (non-blocking): ${e.message}`);
          await pushEvent(job.jobId, 'reviewer', 'reviewer', 'step_error', {
            text: `reviewer failed (non-blocking): ${e.message}`,
          }).catch(() => {});
          return { verdicts: {}, needsHuman: [] };
        }
      },
      // W5.1 — selective cross-story regression (dark unless P3_SELECTIVE_REGRESSION).
      // Reverse-impact this story's changed files → the prior tests covering them,
      // and (in 'on') run only those. Non-blocking; Memgraph-down → skip.
      selectiveRegression: async ({ headSha: sha, jobId }) => {
        const flag = process.env.P3_SELECTIVE_REGRESSION || 'off';
        if (flag === 'off' || !sha) return;
        try {
          const d = await daemonGit(['diff', '--name-only', `${sha}~1`, sha], job.workingDir);
          const changedFiles = String(d.stdout || '').split('\n').map((s) => s.trim())
            .filter(Boolean).filter((f) => !/\.(test|spec)\./.test(f));
          if (!changedFiles.length) return;
          const changedNodeIds = changedFiles.map((f) => `code/${f.replace(/\//g, '--')}`);
          const [{ createDriver }, { queryImpact }, { runSelectiveRegression }] = await Promise.all([
            import('./scripts/lib/memgraph-driver.mjs'),
            import('./scripts/lib/impact-propagation.mjs'),
            import('./lib/selective-regression.mjs'),
          ]);
          const driver = createDriver();
          try {
            const runTest = flag === 'on'
              ? (testNodeId) => new Promise((res) => {
                  const path = String(testNodeId).replace(/^code\//, '').replace(/--/g, '/');
                  const c = spawn('/bin/sh', ['-c', `npx vitest run ${path}`], { cwd: job.workingDir, stdio: 'ignore' });
                  c.on('error', () => res({ passed: false }));
                  c.on('close', (code) => res({ passed: code === 0 }));
                })
              : undefined;
            const r = await runSelectiveRegression({ flag, changedNodeIds, driver, queryImpact, runTest });
            log('info', `[${short}] selective-regression (${r.mode}): ${r.selected.length} covering test(s)` +
              (r.regressions.length ? `, ${r.regressions.length} REGRESSION(S): ${r.regressions.join(', ')}` : ''));
            if (r.regressions.length) {
              try { await pushEvent(jobId, 'story-dev', 'dev', 'step_error', { text: `selective regression: ${r.regressions.length} prior test(s) now failing: ${r.regressions.join(', ')}` }); } catch { /* telemetry */ }
            }
          } finally {
            try { await driver.close?.(); } catch { /* best-effort */ }
          }
        } catch (e) {
          log('warn', `[${short}] selective-regression skipped (non-blocking): ${e.message}`);
        }
      },
      // Live streaming into agent-events (use-agent-events reads it) + bounded
      // fix-forward attempt budget.
      pushEvent,
      maxAttempts: MAX_DEV_ATTEMPTS_PER_STORY,
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
    },
  });

  const ok = result.exitCode === 0 && result.newState !== 'failed';

  if (ok) {
    // Fire-and-forget: grow the code-knowledge-graph (the real Graph tab's data
    // source) after every green story. Non-blocking — never fails the job.
    // W1.2/W4.2 — cohort-close signal: is this the last story of its cohortBatch
    // to finish? Fires the cohort-batched semantic-extract + LLM article lane once
    // per cohort. Best-effort; failure → false (per-story behavior unchanged).
    let isCohortClose = false;
    try {
      const { Items } = await ddb.send(new QueryCommand({
        TableName: PLAN_SPEC_GRAPH_TABLE,
        IndexName: 'planId-cohortBatch-index',
        KeyConditionExpression: 'planId = :p',
        ExpressionAttributeValues: { ':p': planId },
      }));
      const { isLastInCohort } = await import('./lib/story-graph.mjs');
      isCohortClose = isLastInCohort(
        (Items || []).map((r) => ({ storyId: r.storyId, cohortBatch: r.cohortBatch, state: r.state, storyState: r.storyState })),
        storyId,
      );
    } catch { /* best-effort — default per-story */ }

    // Sub-pipeline visibility: compile is its own stage (stepId 'compile').
    pushEvent(job.jobId, 'compile', 'compiler', 'step_start', {
      text: `compile: growing the code knowledge graph for ${storyId.slice(0, 8)}`,
    }).catch(() => {});
    runStoryCompileGraph({
      projectId: appId,
      workingDir: job.workingDir,
      storyId,
      planId,
      headSha: result.commitSha,
      rigor,
      isCohortClose,
      // W1.2 (P3_SEMANTIC_COMPILE, default off) — grow real cross-file CALLS/
      // RENDERS edges via ts-morph at compile. Read from env like the frontier
      // path; 'cohort' stays inert until the cohort-close signal is wired.
      semanticCompile: ['cohort', 'on'].includes(process.env.P3_SEMANTIC_COMPILE)
        ? process.env.P3_SEMANTIC_COMPILE
        : 'off',
      // W4.2 (P3_GRAPH_GROWTH_SPLIT, default off) — deterministic per-story lane;
      // LLM article lane deferred to cohort close.
      growthSplit: process.env.P3_GRAPH_GROWTH_SPLIT === 'on',
      deps: {
        spawn,
        claudeBin: CLAUDE_BIN,
        logger: { info: (m) => log('info', m), warn: (m) => log('warn', m) },
      },
    }).then((r) => pushEvent(job.jobId, 'compile', 'compiler', r?.ran ? 'step_complete' : 'step_error', {
      text: r?.ran
        ? `compile done — graph ${r.graphUpdated ? 'updated' : 'unchanged'}${r.reason ? ` (${r.reason})` : ''}`
        : `compile skipped: ${r?.reason || 'unknown'}`,
    }).catch(() => {})).catch(() => { /* non-blocking */ });

    // Enqueue the story-scope reflector that P3's plan-reducer bypass drops.
    // Idempotent per scope; only fires when the rigor gate passes (production).
    enqueueStoryReflector({
      ddb,
      plan: planRow,
      storyId,
      scope: 'story',
      createJob: async (payload) => {
        // Plan-affinity (+ self-assign when THIS server ran the parent story-dev
        // job): the reflector reads the plan's worktree, so it belongs on the
        // same server as the plan.
        const affinity = planAffinityStamp({
          planId,
          parentJob: job,
          serverId: SERVER_ID,
          serverAware: serverAwareDispatch,
        });
        await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: { ...payload, ...affinity } }));
        return payload.jobId;
      },
      uuid: randomUUID,
      log,
    }).catch(() => { /* non-blocking */ });

    // Plan-close reflector + lifecycle advance now run UNCONDITIONALLY after the
    // if/else (see maybeAdvancePlanOnAllResolved below the branch) so a FAILING
    // last story still triggers the transition — a success-only hook wedged
    // pacman4 in `fixing` forever (27 failed fix-stories → never all-done).
  } else if (result.attemptsUsed >= MAX_DEV_ATTEMPTS_PER_STORY) {
    // Bounded fix-forward exhausted — surface for operator attention with the
    // real failing-test detail from the last attempt.
    await writeAttentionItem(ddb, {
      planId,
      dedupKey: `story-dev-fix-exhausted:${storyId}`,
      severity: 'high',
      category: 'dev-retry-exhausted',
      title: `Story ${storyId} exhausted ${result.attemptsUsed} dev attempts`,
      body: result.lastFailureDetail || 'bound-AC never passed',
      context: { jobId: job.jobId, planId, storyId, attempts: result.attemptsUsed },
      suggestedActions: [
        { label: 'Retry step', kind: 'retry-step' },
        { label: 'Skip story', kind: 'skip-step' },
        { label: 'Open logs', kind: 'open-logs' },
      ],
    }, log);
  } else if (result.newState === 'failed' && (result.attemptsUsed || 0) === 0) {
    // Test-author FAIL-CLOSED before any implementer ever spawned (pipeline-v3
    // redesign, pacman8). The split path REFUSES the legacy single-spawn fallback
    // (the implementer authoring its own tests is the forbidden mechanism), so a
    // test-author that fails its one retry kills the story with attemptsUsed=0.
    // That value slips through the `>= MAX_DEV_ATTEMPTS_PER_STORY` branch above
    // (0 >= 5 is false) — so WITHOUT this branch the story dies silent: a
    // multi-story plan completes missing that feature with nothing in the
    // operator attention queue (only a timeline event). This is the exact failure
    // the redesign targets, so it MUST reach the attention queue. Distinct
    // dedupKey/category from fix-exhausted: no code was written, the operator's
    // move is different (the test-author, not the implementer, is stuck).
    await writeAttentionItem(ddb, {
      planId,
      dedupKey: `story-dev-test-author-failed:${storyId}`,
      severity: 'high',
      category: 'dev-test-author-failed',
      title: `Story ${storyId} test-author failed — story fails closed (no code written)`,
      body: result.lastFailureDetail
        || 'test-author failed twice; the implementer never authors its own tests (no single-spawn fallback)',
      context: { jobId: job.jobId, planId, storyId, attempts: result.attemptsUsed || 0 },
      suggestedActions: [
        { label: 'Retry step', kind: 'retry-step' },
        { label: 'Skip story', kind: 'skip-step' },
        { label: 'Open logs', kind: 'open-logs' },
      ],
    }, log);
  }

  // Advance the plan lifecycle when EVERY story is terminal — runs on BOTH the
  // success and failure paths (a failing last story must still trigger it).
  await maybeAdvancePlanOnAllResolved({ planId, planRow, storyId, short, parentJob: job });

  // updateJobFields ALWAYS appends updatedAt — do NOT pass it (duplicate path →
  // "Two document paths overlap" → the status write throws → the job never
  // reaches terminal → the poll loop re-runs it forever).
  await updateJobFields(job.jobId, { status: ok ? 'COMPLETED' : 'FAILED' });
  log(ok ? 'info' : 'error', `[${short}] story-dev ${storyId} → ${result.newState || `exit ${result.exitCode}`}` +
    (result.attemptsUsed ? ` (${result.attemptsUsed} attempt${result.attemptsUsed === 1 ? '' : 's'})` : ''));
}

/**
 * Reality-Spine P3 — enqueue the whole-tree Integrator for a plan whose current
 * app-tree head is not yet integrate-verified. AT-MOST-ONCE per head: skips when
 * an integrator job for this plan is still in flight (PENDING/RUNNING); otherwise
 * CAS-claims the `integratorJobId` slot (serializes racing last-completions) and
 * mints a fresh `integrator` job pinned to `targetHeadSha`. Never throws out.
 */
async function maybeEnqueueIntegrator({ planId, planRow, headSha, workingDir, short, parentJob = null }) {
  try {
    const prevJobId = planRow?.integratorJobId;
    // AT-MOST-ONCE PER HEAD (the staleness discipline the redesign calls for):
    // skip if the prior integrator is still in flight, OR if it already ATTEMPTED
    // this exact head (terminal, same targetHeadSha). Re-enqueue ONLY when the
    // head has MOVED — i.e. a fix-story commit changed the tree — so an
    // un-greenable tree can never spin up an infinite series of Opus integrators.
    // A completed-but-red integrator for the current head leaves the plan
    // fail-closed OUT of review (its INTEGRATE_GREEN='false' surfaces the stall).
    if (prevJobId) {
      try {
        const existing = (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId: prevJobId } }))).Item;
        if (existing) {
          const inFlight = existing.status === 'PENDING' || existing.status === 'RUNNING';
          const sameHead = existing.targetHeadSha && existing.targetHeadSha === headSha;
          if (inFlight || sameHead) return;
        }
      } catch { /* tolerate a read miss — fall through to (re)enqueue */ }
    }

    const jobId = randomUUID();
    const nowIso = new Date().toISOString();
    const appId = planRow?.appId || pathBasename(workingDir || '');

    // ATOMIC ENQUEUE (reality-spine review fix): the CAS on the plan's
    // integratorJobId slot AND the job-row Put must land together or not at all.
    // A prior two-write sequence (Update-then-Put) could partially apply — if the
    // Put threw (DDB throttle/transient) after the CAS succeeded, or the process
    // restarted between them, the plan pointed at an integratorJobId that never
    // existed. Since every story is already resolved, nothing re-invokes the
    // advance for this plan, so it deadlocked OUT of review forever. A single
    // TransactWriteItems makes the two writes all-or-nothing.
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: PLANS_TABLE,
              Key: { planId },
              UpdateExpression: 'SET integratorJobId = :j, updatedAt = :now',
              ConditionExpression: prevJobId ? 'integratorJobId = :prev' : 'attribute_not_exists(integratorJobId)',
              ExpressionAttributeValues: prevJobId
                ? { ':j': jobId, ':now': nowIso, ':prev': prevJobId }
                : { ':j': jobId, ':now': nowIso },
            },
          },
          {
            Put: {
              TableName: JOBS_TABLE,
              Item: {
                jobId,
                jobType: 'integrator',
                status: 'PENDING',
                planId,
                appId,
                planSlug: appId,
                workingDir,
                integratorModel: planRow?.integratorModel,
                targetHeadSha: headSha,
                failureSummary: 'Assemble + green the whole tree before review (Reality-Spine INTEGRATE-RUN). Every story is terminal but no actor has run the assembled artifact as a whole.',
                createdBy: planRow?.createdBy || 'daemon:integrate-run',
                createdAt: nowIso,
                updatedAt: nowIso,
                // Plan-affinity (+ self-assign when THIS server ran the parent job).
                ...planAffinityStamp({
                  planId,
                  parentJob,
                  serverId: SERVER_ID,
                  serverAware: serverAwareDispatch,
                  nowIso,
                }),
              },
            },
          },
        ],
      }));
    } catch (e) {
      // A CAS loss surfaces as a transaction-cancelled (conditional check) —
      // another completion claimed the slot; no-op. Neither write applied.
      if (e.name === 'ConditionalCheckFailedException' || e.name === 'TransactionCanceledException') return;
      throw e;
    }
    if (planRow) planRow.integratorJobId = jobId;
    log('info', `[${short}] plan ${planId.slice(0, 8)} → integrator ${jobId.slice(0, 8)} enqueued for head ${String(headSha).slice(0, 7)}`);
  } catch (e) {
    log('warn', `[${short}] integrator enqueue failed (non-blocking): ${e.message}`);
  }
}

// Reality-Spine P3 — execute the whole-tree Integrator: one Opus agent with
// whole-tree write authority loops to full green (tsc && lint && test && build
// && boot-liveness), commits, and stamps the SHA-pinned integrate mark on the
// plan so the review transition becomes reachable. On green it re-triggers the
// lifecycle advance; on exhaustion it leaves the plan un-verified (fail-closed).
async function executeIntegratorJob(job) {
  const short = job.jobId.slice(0, 8);
  const planId = job.planId;
  await updateJobFields(job.jobId, { status: 'RUNNING', lastHeartbeatAt: new Date().toISOString() });

  const check = validateIntegratorJob(job);
  if (!check.ok) {
    log('error', `[${short}] integrator job invalid: ${check.reason}`);
    await updateJobFields(job.jobId, { status: 'FAILED', error: `invalid integrator job: ${check.reason}` });
    return;
  }

  let planRow = null;
  try {
    planRow = (await ddb.send(new GetCommand({ TableName: PLANS_TABLE, Key: { planId } }))).Item;
  } catch { /* tolerate — run with job-carried identity */ }
  const appId = job.appId || planRow?.appId || pathBasename(job.workingDir || '');

  // Resolve the boilerplate qaContext so boot-liveness can serve the app on the
  // right dev port + healthcheck path (browser probe drives window.__harness).
  let qaContext;
  try {
    const appRowQa = await getAppRow(appId);
    const { getGateEntry } = await import('./lib/gate-registry.mjs');
    qaContext = getGateEntry(appRowQa?.boilerplateType || 'nextjs-base')?.qaContext;
  } catch (e) {
    log('warn', `[${short}] integrator qaContext resolve failed (boot-liveness fail-closed): ${e.message}`);
  }

  // The head BEFORE the integrator runs — the fallback pin when the agent makes
  // no changes (tree already green).
  let headSha = '';
  try {
    const r = await daemonGit(['rev-parse', 'HEAD'], job.workingDir);
    if (r.code === 0) headSha = r.stdout.trim();
  } catch { /* tolerate */ }

  // Deterministic green runner: a shell command in the app tree → { passed, detail }.
  const runShellGate = (cmd, args, cwd) => {
    try {
      const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300000 });
      if (res.error) return { passed: false, detail: `${cmd} error: ${res.error.message}` };
      const passed = res.status === 0;
      const tail = ((res.stdout || '') + (res.stderr || '')).trim().slice(-400);
      return { passed, detail: passed ? 'pass' : `exit ${res.status}: ${tail}` };
    } catch (e) {
      return { passed: false, detail: `${cmd} threw: ${e.message}` };
    }
  };

  // Boot-liveness dep: boot the served build (harness seam), replay synthetic
  // inputs, assert an observable state delta. FAIL CLOSED on any boot/probe error.
  const bootLiveness = async ({ cwd }) => {
    const port = qaContext?.defaultPort ?? 3000;
    let boot;
    try {
      const { defaultShellRunner } = await import('./lib/wave-merge-runner.mjs');
      boot = await bootDevServer({
        cwd,
        qaContext,
        port,
        shell: (cmd, c, t) => defaultShellRunner(cmd, c, t),
        log: (m) => log('info', `[${short}] boot: ${m}`),
      });
      if (!boot?.ok) {
        return { passed: false, detail: `dev server did not boot (status=${boot?.status ?? 'unknown'})` };
      }
      const url = `http://localhost:${boot.port}${qaContext?.healthcheckPath ?? '/'}`;
      let playwright = null;
      try { playwright = await import('playwright'); }
      catch (e) { return { passed: false, detail: `playwright unavailable: ${e.message}` }; }
      return await runBootLiveness({ url, playwright, inputs: defaultLivenessInputs(), log: (l, m) => log(l, `[${short}] ${m}`) });
    } catch (e) {
      return { passed: false, detail: `boot-liveness error: ${e.message}` };
    } finally {
      try { if (boot?.stop) await boot.stop(); } catch { /* best-effort */ }
    }
  };

  const result = await runIntegratorJob({
    job: {
      ...job,
      appId,
      planSlug: appId,
      integratorModel: planRow?.integratorModel || job.integratorModel,
      costCeilingUsd: planRow?.costCeilingUsd,
    },
    eventLogDir: EVENT_LOG_DIR,
    deps: {
      spawn,
      claudeBin: CLAUDE_BIN,
      git: daemonGit,
      headSha,
      runTreeTypecheck: ({ cwd }) => runTreeTypecheck({ cwd }),
      runTreeBuild: ({ cwd }) => runTreeBuild({ cwd }),
      runLint: ({ cwd }) => runShellGate('npm', ['run', 'lint'], cwd),
      runTests: ({ cwd }) => runShellGate('npm', ['run', 'test'], cwd),
      bootLiveness,
      updateJobFields,
      pushEvent,
      logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) },
      now: Date.now,
    },
  });

  // On green, stamp the SHA-pinned integrate mark so `integrateSatisfied` passes
  // for this head and review becomes reachable. runIntegratorJob already set the
  // job to COMPLETED with INTEGRATE_SHA/INTEGRATE_GREEN.
  if (result.green && result.sha) {
    try {
      const nowIso = new Date().toISOString();
      await ddb.send(new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId },
        UpdateExpression: 'SET integrateVerifiedAt = :now, integrateVerifiedSha = :sha, updatedAt = :now',
        ExpressionAttributeValues: { ':now': nowIso, ':sha': result.sha },
      }));
      if (planRow) { planRow.integrateVerifiedAt = nowIso; planRow.integrateVerifiedSha = result.sha; }
      log('info', `[${short}] integrator GREEN — plan ${planId.slice(0, 8)} integrate-verified @${String(result.sha).slice(0, 7)}`);
    } catch (e) {
      log('warn', `[${short}] integrate-verified stamp failed (non-blocking): ${e.message}`);
    }
  } else {
    log('warn', `[${short}] integrator did NOT reach green (${result.failing?.join(', ') || 'unknown'}) — plan stays un-verified (fail-closed)`);
  }

  // Re-trigger the lifecycle advance now that the head may be integrate-verified
  // (green) — flips to review — or still is not (exhausted) — holds, surfacing the
  // failure to the operator via the completed-but-red integrator job.
  await maybeAdvancePlanOnAllResolved({ planId, planRow, storyId: undefined, short, parentJob: job });
}

/**
 * P3 lifecycle advance — flip the plan to `review` when EVERY story is TERMINAL
 * (done OR failed), not only when all are done. pacman4 forensic (2026-07-06):
 * a failed fix-story is terminal, so an all-`done` predicate wedged the plan in
 * `fixing` FOREVER (27 failed fix-stories → the "all done → review" check could
 * never pass, so the assembled-app QA — the REAL gate — never got to judge).
 * Failed unit-stories surface their own `dev-retry-exhausted` attention items;
 * the deployed-app QA + operator are the real arbiters, so a partial failure
 * must advance to review, not deadlock. Also enqueues the plan-close reflector.
 * Idempotent conditional write → concurrent last-completions race safely.
 */
async function maybeAdvancePlanOnAllResolved({ planId, planRow, storyId, short, parentJob = null }) {
  try {
    const { Items } = await ddb.send(new QueryCommand({
      TableName: PLAN_SPEC_GRAPH_TABLE,
      IndexName: 'planId-cohortBatch-index',
      KeyConditionExpression: 'planId = :p',
      ExpressionAttributeValues: { ':p': planId },
    }));
    const nodes = Items || [];
    if (!allStoriesResolved(nodes, storyId)) return;
    const failedCount = nodes.filter((n) => n.state === 'failed' && n.storyId !== storyId).length;

    await enqueueStoryReflector({
      ddb,
      plan: planRow,
      scope: 'plan',
      createJob: async (payload) => {
        // Plan-affinity (+ self-assign when THIS server ran the parent job).
        const affinity = planAffinityStamp({
          planId,
          parentJob,
          serverId: SERVER_ID,
          serverAware: serverAwareDispatch,
        });
        await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: { ...payload, ...affinity } }));
        return payload.jobId;
      },
      uuid: randomUUID,
      log,
    });

    // QA-Review W1 (P3_LIFECYCLE) — advance to `review`, which the cron watches
    // to auto dev-deploy + launch the real assembled-app QA. Conditional write
    // on a pre-review status → idempotent. Dark unless the flag is on.
    if (envFlag('P3_LIFECYCLE') === 'on') {
      const nextStatus = nextStatusOnAllDone(planRow?.status || 'developing');
      if (nextStatus) {
        // Reality-Spine P3 (redesign Part 2 P3, Part 3 #2) — the INTEGRATE-RUN
        // precondition. `review` is unreachable until the whole-tree Integrator
        // has proven the CURRENT app-tree head fully green + committed it
        // (integrateVerifiedSha === head). Resolve the live head; if it is not
        // yet integrate-verified, dispatch the Integrator (at-most-once per
        // head) and HOLD — do not flip. The Integrator's own green commit
        // becomes the head it stamps as integrateVerifiedSha, so the re-triggered
        // advance (from executeIntegratorJob) then finds integrateSatisfied ===
        // true and flips to review. A later fix-story commit moves the head and
        // forces a fresh Integrator round. Fail-closed: an unresolvable head or a
        // still-red tree never advances.
        // Task B (2026-07-17) — plan rows bake the fleet path; remap to the
        // host-local root (identity on fleet boxes) before touching git.
        const workingDir = remapDaemonPath(planRow?.workingDir);
        let headSha = '';
        if (workingDir) {
          try {
            const r = await daemonGit(['rev-parse', 'HEAD'], workingDir);
            if (r.code === 0) headSha = r.stdout.trim();
          } catch { /* tolerate — headSha stays '' → integrateSatisfied false */ }
        }
        if (!integrateSatisfied({ integrateVerifiedSha: planRow?.integrateVerifiedSha, headSha })) {
          if (workingDir && headSha) {
            await maybeEnqueueIntegrator({ planId, planRow, headSha, workingDir, short, parentJob });
          } else {
            log('warn', `[${short}] plan ${planId.slice(0, 8)} integrate-gate: no resolvable workingDir/head — holding out of review (fail-closed)`);
          }
          return; // do NOT flip to review until the Integrator proves the head green
        }

        try {
          await ddb.send(new UpdateCommand({
            TableName: PLANS_TABLE,
            Key: { planId },
            UpdateExpression: 'SET #s = :rev, reviewAt = :now, updatedAt = :now',
            ConditionExpression: '#s IN (:concept, :developing, :fixing)',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':rev': 'review', ':now': new Date().toISOString(),
              ':concept': 'concept', ':developing': 'developing', ':fixing': 'fixing',
            },
          }));
          log('info', `[${short}] plan ${planId.slice(0, 8)} → review (all ${nodes.length} stories resolved, integrate-verified @${String(headSha).slice(0, 7)}${failedCount ? `, ${failedCount} failed — deployed-app QA is the gate` : ''})`);
          // Task B (2026-07-17) — PUSH-ON-PLAN-CLOSE. Repos move BETWEEN
          // machines only via GitHub, so the moment a plan flips to review its
          // branch state must be visible off-box. Best-effort + LOUD: a push
          // failure never blocks or reverts the flip. Only on remapped hosts
          // (Mac/fleet dev) — fleet/EC2 stays an exact no-op.
          if (isRemapActive() && workingDir) {
            try {
              const push = await daemonGit(['push', 'origin', 'HEAD'], workingDir);
              if (push.code === 0) {
                log('info', `[${short}] plan ${planId.slice(0, 8)} push-on-close: pushed HEAD → origin from ${workingDir}`);
              } else {
                log('error', `[${short}] plan ${planId.slice(0, 8)} push-on-close FAILED (exit ${push.code}) in ${workingDir}: ${(push.stderr || push.stdout).trim().slice(0, 300)} — plan is in review anyway; push manually`);
              }
            } catch (pushErr) {
              log('error', `[${short}] plan ${planId.slice(0, 8)} push-on-close threw: ${pushErr.message} — plan is in review anyway; push manually`);
            }
          }
        } catch { /* conditional fail = already advanced by a racing completion; fine */ }
      }
    }
  } catch (e) {
    log('warn', `[${short}] plan-advance check failed (non-blocking): ${e.message}`);
  }
}

/**
 * Reality-Spine reconciliation sweep — re-drive the all-resolved → integrate →
 * review advance for every plan stuck in `developing`/`fixing`. The advance
 * normally only fires when a NEW story or integrator job completes; if that
 * enqueue was lost (transient DDB error, process restart at the wrong moment)
 * the plan — with every story already resolved — has nothing left to re-trigger
 * it and would deadlock out of review forever. This periodic re-invocation is
 * the self-heal. maybeAdvancePlanOnAllResolved is idempotent (self-guards on
 * all-resolved; reflector claim dedupes; integrator enqueue is at-most-once per
 * head), so a sweep over a plan that is genuinely still developing, or already
 * advancing, is a cheap no-op. Dark unless P3_LIFECYCLE is on. Never throws out.
 */
async function scanStalledPlansForIntegrate() {
  try {
    if (envFlag('P3_LIFECYCLE') !== 'on') return;
    const { Items } = await ddb.send(new ScanCommand({
      TableName: PLANS_TABLE,
      FilterExpression: '#s IN (:developing, :fixing)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':developing': 'developing', ':fixing': 'fixing' },
    }));
    const plans = Items || [];
    for (const planRow of plans) {
      if (!planRow?.planId) continue;
      await maybeAdvancePlanOnAllResolved({
        planId: planRow.planId,
        planRow,
        storyId: undefined,
        short: 'sweep',
      });
    }
  } catch (e) {
    log('warn', `[sweep] stalled-plan integrate sweep failed (non-blocking): ${e.message}`);
  }
}

async function scanStaleEpicDevJobs() {
  try {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :running',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':running': 'RUNNING' },
        Limit: 50,
      }),
    );

    if (!Items || Items.length === 0) return;

    // NOTE (pacman4 root-cause, 2026-07-05): findStaleJobs matches ONLY
    // epic-dev orchestrator jobs. The old `if (stale.length === 0) return;`
    // early-exit meant that in a P3 world (no epic-dev jobs ever) the
    // requeue-orphans and mark-STALE passes below NEVER RAN — every restart-
    // orphaned story-dev job sat RUNNING forever with its story stuck
    // 'claimed'. Guard the epic-dev loop only; always run the later passes.
    const stale = findStaleJobs(Items, { now: Date.now(), staleMs: STALE_HEARTBEAT_MS });

    for (const job of stale) {
      // Skip jobs currently running on THIS daemon — they aren't actually
      // dead; their heartbeat is just behind because the pipeline module
      // doesn't tick updatedAt continuously.
      if (activeJobs.has(job.jobId)) continue;
      // Reap-ownership scope (pacman1 triple-mint, 2026-07-13) — same rule as
      // the story-dev passes below: never resume another host's live job.
      if (!canReapJob(job, { source: DAEMON_SOURCE })) continue;

      const newJobId = randomUUID();
      const nowIso = new Date().toISOString();
      const resumeJob = buildResumeJob(job, { newJobId, now: nowIso });

      log('warn', `Stale epic-dev job detected — resuming`, {
        staleJobId: job.jobId.slice(0, 8),
        newJobId: newJobId.slice(0, 8),
        waves: resumeJob.resumeFromWaveResults
          ? Object.keys(resumeJob.resumeFromWaveResults).length
          : 0,
      });

      try {
        await ddb.send(
          new PutCommand({
            TableName: JOBS_TABLE,
            Item: resumeJob,
          }),
        );
        await updateJobFields(job.jobId, {
          status: 'STALE',
          errorMessage: `Orchestrator heartbeat stale >${Math.round(STALE_HEARTBEAT_MS / 1000)}s — resumed as ${newJobId}`,
          resumedAsJobId: newJobId,
        });
      } catch (err) {
        log('error', `Failed to schedule resume for ${job.jobId.slice(0, 8)}: ${err.message}`);
      }
    }

    // PR-28 — also catch per-story dev pipeline jobs (phase != 'epic-dev')
    // that are stuck RUNNING. We don't auto-resume them (story state is too
    // fragile to rebuild from outside the daemon's in-memory tracker), but
    // we DO mark them STALE + write an attention item so the wave-reducer
    // sees them as terminal and the operator can decide what to do.
    //
    // 2026-05-04 plan-2 dino-runner-1: 3 wave-1 stories sat RUNNING for an
    // hour after the daemon got OOM-killed during 3 parallel npm builds.
    // Without this pass they would have stayed RUNNING forever after EC2
    // restart (the new daemon's activeJobs Map is empty so nothing claims
    // them, and the orchestrator-only `findStaleJobs` filtered them out).
    // 2026-06-16 — idempotent infra jobs (app-bootstrap) orphaned RUNNING by a
    // daemon restart are AUTO-REQUEUED to PENDING so they finish themselves,
    // instead of being marked STALE (terminal) and leaving the App stuck on
    // "Scaffold pending" forever. Safe: these jobs are idempotent, and a
    // genuinely-failing run lands FAILED via its own catch (not RUNNING), so
    // this never loops. See REQUEUE_ON_ORPHAN_JOB_TYPES. (brick1 root-cause.)
    // 2026-06-17 (Story 3.4) — `isRequeueableOrphan` now also matches autopilot
    // concept-gen jobs (stamped `conceptAutopilotGen: true` by the driver), not
    // just app-bootstrap. Interactive convergence turns are never stamped, so
    // they fall through to mark-STALE.
    const requeueOrphans = (Items || []).filter(
      (j) =>
        !activeJobs.has(j.jobId) &&
        // Reap-ownership scope (pacman1 triple-mint, 2026-07-13): activeJobs is
        // process-local, so a peer daemon (laptop ↔ EC2) must not requeue or
        // reap another host's live jobs — only jobs OUR source claimed.
        canReapJob(j, { source: DAEMON_SOURCE }) &&
        isRequeueableOrphan(j, { now: Date.now(), staleMs: STALE_HEARTBEAT_MS }),
    );
    for (const job of requeueOrphans) {
      try {
        await updateJobFields(job.jobId, { status: 'PENDING' });
        const label = job.jobType || (job.conceptAutopilotGen ? 'concept-gen' : 'job');
        log(
          'warn',
          `[${job.jobId.slice(0, 8)}] orphaned ${label} requeued → PENDING (idempotent; daemon restarted mid-run)`,
        );
      } catch (err) {
        log('error', `Failed to requeue orphaned ${job.jobType} ${job.jobId.slice(0, 8)}: ${err.message}`);
      }
    }

    const otherStale = (Items || []).filter(
      (j) =>
        j.status === 'RUNNING' &&
        j.phase !== 'epic-dev' &&
        // Requeueable orphans (idempotent infra + autopilot concept-gen) are
        // handled above — don't also mark them STALE.
        !isRequeueableOrphan(j, { now: Date.now(), staleMs: STALE_HEARTBEAT_MS }) &&
        !activeJobs.has(j.jobId) &&
        // Reap-ownership scope (pacman1 triple-mint, 2026-07-13): only jobs OUR
        // source claimed — a laptop daemon reaping EC2's live story-dev jobs
        // orphan-released their claims and the frontier re-minted duplicates
        // every ~5 min while the "dead" implementers kept racing the tree.
        canReapJob(j, { source: DAEMON_SOURCE }) &&
        isStaleAnyPhase(j, { now: Date.now(), staleMs: STALE_HEARTBEAT_MS }),
    );
    for (const job of otherStale) {
      try {
        await updateJobFields(job.jobId, {
          status: 'STALE',
          errorMessage: `Heartbeat stale >${Math.round(STALE_HEARTBEAT_MS / 1000)}s — daemon likely crashed mid-execution. Operator action required.`,
        });
        log(
          'warn',
          `[${job.jobId.slice(0, 8)}] non-orchestrator stale job marked STALE (phase=${job.phase || 'pipeline'})`,
        );

        // P3 SELF-HEAL (pacman4 f594a817, 2026-07-05): a stale story-dev job
        // leaves its StoryNode 'claimed' FOREVER — the frontier's atomic claim
        // only takes state=ready rows, so the plan wedges until an operator
        // resets it by hand (three times today). Release the dead job's claim
        // (condition: still claimed BY this jobId — a re-claimed story is
        // untouched) so the frontier re-mints. Safe to re-run: the test-author
        // is retry-idempotent and the completion gate re-verifies bindings.
        if (job.jobType === 'story-dev' && job.storyNodeRef?.storyId) {
          try {
            const { buildOrphanReleaseParams } = await import('./lib/atomic-claim.mjs');
            await ddb.send(new UpdateCommand(buildOrphanReleaseParams({
              table: PLAN_SPEC_GRAPH_TABLE,
              storyId: job.storyNodeRef.storyId,
              deadJobId: job.jobId,
            })));
            log('warn', `[${job.jobId.slice(0, 8)}] released orphaned story claim ${job.storyNodeRef.storyId.slice(0, 8)} → ready (frontier will re-mint)`);
          } catch (relErr) {
            if (relErr.name !== 'ConditionalCheckFailedException') {
              log('warn', `[${job.jobId.slice(0, 8)}] orphan claim release failed (non-blocking): ${relErr.message}`);
            }
          }
        }
        // Best-effort attention item. Skip if the resolver can't find a planId
        // (legacy jobs without epicId linkage).
        try {
          const planId = job.epicId ? await resolvePlanIdFromEpicId(ddb, job.epicId) : null;
          if (planId) {
            await writeAttentionItem(
              ddb,
              {
                planId,
                severity: 'high',
                category: 'daemon-crash-stale-job',
                title: `Story job stalled — daemon may have crashed`,
                body:
                  `Job ${job.jobId} for story ${job.epicId || ''} hit a stale-heartbeat ` +
                  `threshold (${Math.round(STALE_HEARTBEAT_MS / 1000)}s). The daemon was ` +
                  `most likely killed by the OS (OOM) during heavy parallel work. The job ` +
                  `has been marked STALE; the wave-reducer will treat it as failed and ` +
                  `the operator can re-run the story from the dashboard.`,
                context: {
                  jobId: job.jobId,
                  epicId: job.epicId,
                  stepId: 'unknown',
                },
                suggestedActions: [
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Re-run story', kind: 'retry-step' },
                ],
                dedupKey: `daemon-crash-stale:${job.jobId}`,
              },
              log,
            );
          }
        } catch (attnErr) {
          log(
            'warn',
            `attention-item write failed for stale ${job.jobId.slice(0, 8)}: ${attnErr.message}`,
          );
        }
      } catch (err) {
        log('error', `Failed to mark ${job.jobId.slice(0, 8)} STALE: ${err.message}`);
      }
    }
  } catch (err) {
    log('error', `Stale scan failed: ${err.message}`);
  }
}

// ── Execute pipeline ──

// ── Execute a shell (non-agentic) step ──

async function executeShellStep(jobId, step, workingDir, variables) {
  const command = substituteTemplate(step.command, variables);
  const timeout = step.timeout || 30000;
  const expectCode = step.expectExitCode ?? 0;

  log('info', `\n${'='.repeat(60)}`);
  log('info', `STEP: ${step.id} (Shell command)`);
  log('info', `${'='.repeat(60)}`);
  log('debug', `Command: ${command}`);

  await pushEvent(jobId, step.id, '__shell__', 'step_start', {
    text: `Shell: ${command.slice(0, 120)}`,
  });

  // 2026-06-03 — per-story VQA boot fix. `review-runtime` runs `next dev` to
  // screenshot the story. Next 16 + Turbopack FATAL-panics on the dedup
  // node_modules SYMLINK ("Symlink node_modules is invalid, it points out of
  // the filesystem root"), so the dev server never serves a page and the VQA
  // always RUNTIME_REVIEW_SKIPPED (empty review-screenshots/). Materialize a
  // REAL node_modules in the story worktree first — the same primitive the
  // wave-build candidate uses. Idempotent + non-blocking: on failure
  // review-runtime degrades to its existing skip, no worse than before.
  if (step.id === 'review-runtime' && workingDir) {
    try {
      const { materializeNodeModulesFromStore } = await import('./lib/node-modules-store.mjs');
      const parts = workingDir.split('/');
      const wtIdx = parts.indexOf('worktrees');
      const appId = variables.PROJECT_ID || (wtIdx >= 0 ? parts[wtIdx + 1] : null);
      // ensureStoreEntry requires an installFn (guard) even when the store
      // entry already exists — it only RUNS it on a true miss. Matches the
      // npm-install helper used by story-worktree + the wave-build candidate.
      const installFn = (cwd) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            'sudo',
            ['-n', '-u', 'ubuntu', 'npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'],
            { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
          );
          let stderr = '';
          child.stderr.on('data', (b) => (stderr += b.toString('utf8').slice(-2000)));
          child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`npm install exit ${code}: ${stderr.slice(-300)}`)),
          );
          child.on('error', reject);
        });
      if (appId) {
        const res = await materializeNodeModulesFromStore({ appId, worktreeDir: workingDir, installFn, log });
        log(
          'info',
          `[review-runtime] node_modules ${res.materialized ? 'materialized (real — Turbopack-safe)' : `reused (${res.skipped})`}`,
        );
      }
    } catch (err) {
      log('warn', `[review-runtime] node_modules materialize failed (non-blocking): ${err.message}`);
    }
  }

  const startMs = Date.now();

  return new Promise((resolve) => {
    const effectiveCwd = workingDir || process.env.HOME;
    try {
      assertSpawnAllowed('bash', ['-c', command], effectiveCwd);
    } catch (err) {
      if (err instanceof ShellGuardViolation) {
        log('error', `shell-guard refused shell step ${step.id}: ${err.message}`, err.details);
        handleGuardViolation(jobId, {
          ...err.details,
          command: command.slice(0, 200),
          stepId: step.id,
        });
        return resolve({
          passed: false,
          stepResult: {
            stepId: step.id,
            agentId: '__shell__',
            status: 'error',
            cost: 0,
            durationMs: 0,
            errorMessage: err.message,
            extractedVariables: {},
            validationResults: [],
          },
        });
      }
      throw err;
    }
    // detached: true → bash becomes its own process group leader. Lets us
    // SIGKILL the whole descendant tree via kill(-pgid) on timeout — critical
    // because shell steps that spawn dev servers (npm, vite, etc.) can leave
    // orphans that keep holding ports and occupying slots (2026-04-24
    // incident).
    const proc = spawn('bash', ['-c', command], {
      cwd: effectiveCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
      detached: true,
    });
    registerChild(jobId, proc);

    let stdout = '';
    let stderr = '';
    let killed = false;
    let resolved = false;

    const settle = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    // Stream chunks into agent events so the UI can show real-time shell
    // output. We throttle to avoid flooding DDB — emit when we've buffered
    // >= 500 chars OR 500ms have passed since last flush, whichever comes
    // first. On step close we flush whatever's left.
    let unflushedStdout = '';
    let unflushedStderr = '';
    let lastFlushAt = Date.now();
    const flushStream = async (force) => {
      const elapsed = Date.now() - lastFlushAt;
      const bigEnough = unflushedStdout.length + unflushedStderr.length >= 500;
      if (!force && !bigEnough && elapsed < 500) return;
      const out = unflushedStdout;
      const err = unflushedStderr;
      unflushedStdout = '';
      unflushedStderr = '';
      lastFlushAt = Date.now();
      if (out) {
        await pushEvent(jobId, step.id, '__shell__', 'tool_result', { text: out.slice(-4000) });
      }
      if (err) {
        await pushEvent(jobId, step.id, '__shell__', 'tool_result', { text: err.slice(-4000) });
      }
    };

    const forceResolveTimer = { id: null };

    const timer = setTimeout(() => {
      killed = true;
      log(
        'warn',
        `[${jobId.slice(0, 8)}] Step ${step.id} exceeded ${timeout}ms — SIGKILL'ing process group`,
      );
      // Negative pid sends signal to the whole process group (bash + npm +
      // vite + sub-shells). Fall back to per-proc kill if group kill is
      // rejected (e.g. EPERM).
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch (e) {
        log(
          'warn',
          `[${jobId.slice(0, 8)}] group kill failed (${e.message}) — SIGKILL'ing bash alone`,
        );
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      // Safety net: if proc.on('close') doesn't fire within 5s of SIGKILL,
      // force-resolve the Promise so the job's slot is freed regardless.
      // Happens when bash is alive but a grandchild keeps the stdout pipe
      // open (Vite did this pre-fix).
      forceResolveTimer.id = setTimeout(async () => {
        log(
          'error',
          `[${jobId.slice(0, 8)}] Step ${step.id} did not close 5s after SIGKILL — force-resolving (slot freed)`,
        );
        await pushEvent(jobId, step.id, '__shell__', 'step_error', {
          text: `Step force-killed after ${timeout}ms timeout + 5s grace. stderr: ${stderr.slice(0, 300)}`,
        });
        unregisterChild(jobId, proc);
        settle({
          passed: false,
          stepResult: {
            stepId: step.id,
            agentId: '__shell__',
            status: 'error',
            cost: 0,
            durationMs: Date.now() - startMs,
            errorMessage: `timeout ${timeout}ms + force-kill`,
            extractedVariables: {},
            validationResults: [],
          },
        });
      }, 5000);
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      unflushedStdout += s;
      flushStream(false).catch(() => {});
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      unflushedStderr += s;
      flushStream(false).catch(() => {});
    });

    proc.on('close', async (code) => {
      unregisterChild(jobId, proc);
      clearTimeout(timer);
      if (forceResolveTimer.id) clearTimeout(forceResolveTimer.id);
      if (resolved) return;
      const durationMs = Date.now() - startMs;
      const passed = !killed && code === expectCode;

      await flushStream(true);

      if (step.captureAs) variables[step.captureAs] = stdout;
      if (step.captureStderrAs) variables[step.captureStderrAs] = stderr;

      // D3-2 (2026-06-22) — persist the MEASURED edit set from the dev-scope
      // gate as the story's actualTouchPoints, so a future wave computation
      // serializes stories that genuinely collide on a file neither declared.
      // Runs on pass AND fail (we want the measurement either way). Best-effort:
      // a persistence error never blocks the pipeline. Recorded separately from
      // the DECLARED touchPoints — it never feeds the gate's enforced set.
      if (step.id === 'dev-scope-check') {
        try {
          const m = /__DEV_SCOPE_ACTUAL__\s*([^\n]*)/.exec(stdout || '');
          const files = (m?.[1] || '').trim().split(/\s+/).filter(Boolean);
          const epicId = variables.EPIC_ID;
          const storyId = variables.STORY_ID;
          if (
            files.length > 0 &&
            epicId &&
            epicId !== '(not provided)' &&
            storyId &&
            storyId !== 'unknown'
          ) {
            const res = await epicRepo.updateStoryActualTouchPoints(epicId, storyId, files);
            if (res?.updated) {
              log(
                'info',
                `[${jobId.slice(0, 8)}] dev-scope: recorded ${files.length} actual touch point(s) for story ${storyId} (merged=${res.merged?.length ?? '?'})`,
              );
            }
          }
        } catch (err) {
          log('warn', `[${jobId.slice(0, 8)}] dev-scope actualTouchPoints persist failed (non-blocking): ${err.message}`);
        }
      }

      // 2026-06-03 — apply step.extractors for SHELL steps too. Previously only
      // the AGENT-step path ran extractors, so qa-report (a shell step) never
      // populated OVERALL_VERDICT / TEST_RESULTS / SCREENSHOTS — the QA-report
      // aggregator then had no per-test data and fell back to a fake
      // "all-pass / NO SCREENSHOT" gallery, even though the judges returned real
      // FAIL verdicts with real screenshot URLs. Mirrors the agent-step pass.
      if (step.extractors && Object.keys(step.extractors).length > 0) {
        try {
          const extracted = runExtractors(stdout, step.extractors);
          for (const [k, v] of Object.entries(extracted)) {
            if (v !== undefined && v !== null) variables[k] = v;
          }
        } catch (err) {
          log('warn', `[${jobId.slice(0, 8)}] shell extractor pass failed (non-blocking): ${err.message}`);
        }
      }

      const stepResult = {
        stepId: step.id,
        agentId: '__shell__',
        status: 'complete',
        cost: 0,
        durationMs,
        extractedVariables: {},
        validationResults: [
          {
            label: `exit code ${code}${killed ? ' (timeout)' : ''}`,
            passed,
            details: passed
              ? `Exited ${code} as expected`
              : `Expected ${expectCode}, got ${code}${killed ? ' (killed)' : ''}. stderr: ${stderr.slice(0, 300)}`,
          },
        ],
      };

      await pushEvent(jobId, step.id, '__shell__', passed ? 'step_complete' : 'step_error', {
        text: passed
          ? `Shell passed (${durationMs}ms)`
          : `Shell FAILED: exit ${code}. ${stderr.slice(0, 300)}`,
        durationMs,
      });

      if (!passed && step.onFail?.injectAs) {
        variables[step.onFail.injectAs] = stderr || stdout;
      }

      // ── S4: per-story VQA (review-runtime) → notification card ──
      // Surface the runtime visual-review outcome as ONE evolving attention
      // card (dedupKey collapses every retry; recurrenceCount = attempts) so
      // the operator watches the fail→fix→pass loop in the bell. The card
      // carries the screenshot URL + observations; a real PASS auto-resolves
      // it. Non-blocking — never affects the step verdict.
      if (step.id === 'review-runtime') {
        try {
          const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
          const storyId = variables.STORY_ID || 'unknown';
          if (planId) {
            const dedupKey = `story-vqa:${planId}:${storyId}`;
            const shot = (stdout.match(/SCREENSHOT_URL:\s*(\S+)/) || [])[1];
            const combined = `${stderr}\n${stdout}`;
            const failed = !passed && /RUNTIME_REVIEW_FAILED/.test(combined);
            // Step-0.4b (2026-06-05) — a "real pass" requires at least ONE
            // per-AC PASS verdict, not merely the envelope marker. Before
            // this, an all-UNCERTAIN blank page counted as a pass AND
            // auto-resolved the operator's open story-vqa-failed card —
            // actively clearing the failure signal for a broken UI.
            const realPass =
              passed && /---RUNTIME_REVIEW---/.test(stdout) && /^\S+: PASS\b/m.test(stdout);
            const unverifiable = passed && /RUNTIME_REVIEW_UNVERIFIABLE/.test(stdout);
            const skipped = passed && /RUNTIME_REVIEW_SKIPPED/.test(combined);
            const coverageGap = (stdout.match(/AC_COVERAGE_GAP:\s*(.+)/) || [])[1];
            if (failed) {
              const fails = (stderr.match(/^\s*-\s*\S+:\s*.+$/gm) || [])
                .map((l) => l.trim())
                .slice(0, 6);
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'medium',
                  category: 'story-vqa-failed',
                  title: `Visual review failed — story ${storyId.slice(0, 8)} (attempt ${variables.ITERATION || '?'})`,
                  body:
                    `The running app does not match this story's browser acceptance ` +
                    `criteria. The DEV agent is being given this feedback to fix ` +
                    `(auto-retry, up to ${variables.MAX_ITERATIONS || 3} attempts):\n\n` +
                    (fails.length ? fails.join('\n') : 'See the story logs for per-AC verdicts.'),
                  context: {
                    jobId,
                    epicId: variables.EPIC_ID,
                    storyId,
                    stepId: step.id,
                    screenshotUrl: shot,
                    iteration: variables.ITERATION,
                  },
                  suggestedActions: [
                    { label: 'Open story', kind: 'open-story' },
                    { label: 'Open logs', kind: 'open-logs' },
                  ],
                  dedupKey,
                },
                log,
              );
            } else if (realPass) {
              await autoResolveAttentionByDedupKey(ddb, planId, dedupKey, log);
            }
            // Step-0.4b — surface non-FAIL anomalies LOUDLY (low severity,
            // deduped per story) instead of letting them masquerade as
            // healthy passes. None of these blocks the pipeline.
            if (unverifiable) {
              const detail = (stdout.match(/RUNTIME_REVIEW_UNVERIFIABLE:[\s\S]{0,500}/) || [''])[0];
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'low',
                  category: 'story-vqa-unverifiable',
                  title: `VQA could not verify some ACs — story ${storyId.slice(0, 8)}`,
                  body:
                    `One or more browser ACs describe a state the idle screenshot ` +
                    `cannot show (or only a low-confidence contradiction was seen). ` +
                    `No retry was triggered — an unverifiable verdict must not drive ` +
                    `code changes. Consider mapping these ACs to suite tests ` +
                    `(AC_TEST_MAP) or rewording them to the initial state.\n\n` +
                    detail.slice(0, 600),
                  context: { jobId, epicId: variables.EPIC_ID, storyId, stepId: step.id, screenshotUrl: shot },
                  suggestedActions: [
                    { label: 'Open story', kind: 'open-story' },
                    { label: 'Open logs', kind: 'open-logs' },
                  ],
                  dedupKey: `story-vqa-unverifiable:${planId}:${storyId}`,
                },
                log,
              );
            }
            if (skipped && !realPass && !failed) {
              const cause = (combined.match(/RUNTIME_REVIEW_SKIPPED:\s*(.+)/) || [, 'unknown'])[1];
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'low',
                  category: 'story-vqa-skipped',
                  title: `VQA did not run — story ${storyId.slice(0, 8)}`,
                  body:
                    `review-runtime exited without judging this story's browser ACs. ` +
                    `The story proceeds UNVERIFIED — this is not a pass.\n\nCause: ${String(cause).slice(0, 300)}`,
                  context: { jobId, epicId: variables.EPIC_ID, storyId, stepId: step.id },
                  suggestedActions: [{ label: 'Open logs', kind: 'open-logs' }],
                  dedupKey: `story-vqa-skipped:${planId}:${storyId}`,
                },
                log,
              );
            }
            if (coverageGap) {
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'low',
                  category: 'ac-coverage-gap',
                  title: `Browser ACs without suite tests — story ${storyId.slice(0, 8)}`,
                  body:
                    `TEST emitted an AC→test map but these browser ACs have no ` +
                    `asserting test case (screenshot judge keeps jurisdiction): ` +
                    `${coverageGap.slice(0, 300)}`,
                  context: { jobId, epicId: variables.EPIC_ID, storyId, stepId: step.id },
                  suggestedActions: [{ label: 'Open story', kind: 'open-story' }],
                  dedupKey: `ac-coverage-gap:${planId}:${storyId}`,
                },
                log,
              );
            }
          }
        } catch (attnErr) {
          log(
            'warn',
            `[${jobId.slice(0, 8)}] story-vqa attention write failed (non-blocking): ${attnErr.message}`,
          );
        }
      }

      settle({ passed, stepResult });
    });

    proc.on('error', async (err) => {
      unregisterChild(jobId, proc);
      clearTimeout(timer);
      if (forceResolveTimer.id) clearTimeout(forceResolveTimer.id);
      await pushEvent(jobId, step.id, '__shell__', 'step_error', {
        text: `Shell spawn failed: ${err.message}`,
      });
      settle({
        passed: false,
        stepResult: {
          stepId: step.id,
          agentId: '__shell__',
          status: 'error',
          cost: 0,
          durationMs: Date.now() - startMs,
          errorMessage: err.message,
          extractedVariables: {},
          validationResults: [],
        },
      });
    });
  });
}

// ── Execute a single step (reusable for loops) ──

async function executeStep(jobId, step, agents, workingDir, variables, sessions, stepResults) {
  // Update activity tracker for heartbeat
  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = step.id;
    entry.agentId = step.stepType === 'shell' ? '__shell__' : step.agentId || null;
  }

  // ── Branch on step type ──
  if (step.stepType === 'shell') {
    const { passed, stepResult } = await executeShellStep(jobId, step, workingDir, variables);
    stepResults.push(stepResult);
    // PR-12 — strip transient PROJECT_CONTEXT before DDB persist (item size).
    await updateJobFields(jobId, {
      variables: stripTransientVars(variables),
      sessions,
      stepResults,
    });

    // A hard gate (action:'fail') that ALSO declares a loopTo engages the
    // caller's in-pipeline fix loop instead of failing immediately — the
    // fixer step needs the captured {{...ERROR}} variable (set just above)
    // to know what to repair. dino1 (2026-06-13): lint-verify/test-verify
    // hard-failed here, the daemon-level retry spawned a fresh job with an
    // empty variable store, and the retry DEV never saw the error → "already
    // implemented, no changes" → reaped. With loopTo, the loop re-runs the
    // DEV (resumed session) WITH the error in-prompt; exhaustion still throws
    // (see the loop's post-exhaustion guard) so the gate stays blocking.
    if (!passed && step.onFail?.action === 'fail' && !step.loopTo) {
      throw new Error(`Shell step ${step.id} failed`);
    }

    return { allPassed: passed, stepResult };
  }

  // ── Agent step (existing logic) ──
  const agent = agents[step.agentId];
  if (!agent) {
    throw new Error(`Step ${step.id} references unknown agent "${step.agentId}"`);
  }

  log('info', `\n${'='.repeat(60)}`);
  log('info', `STEP: ${step.id} (Agent ${step.agentId} — ${agent.name})`);
  log('info', `${'='.repeat(60)}`);

  // Concept v2 (E3.2a) — fill the {{PRIOR_ARTIFACTS}} placeholder for ux-gen /
  // arch-gen from the APPROVED upstream docs on disk (prd for ux; prd+ux for
  // arch). The Lambda can't read EC2 disk, so it enqueues the placeholder and we
  // inline the real section bodies here, just before substitution. Never carried
  // as a persisted job variable (avoids the 400KB cap).
  if (typeof step.prompt === 'string' && step.prompt.includes('{{PRIOR_ARTIFACTS}}')) {
    const conceptKind = conceptKindForStepId(step.id);
    if (conceptKind) {
      variables.PRIOR_ARTIFACTS = loadPriorArtifacts(workingDir, conceptKind);
    } else if (step.id === 'pm-plan') {
      // Round 1.1 — the chain-driven planner shards ALL approved docs (PRD + UX
      // + Architecture), not just upstreams of one generator. This is what makes
      // the epic plan grounded in the specs the agents just wrote.
      variables.PRIOR_ARTIFACTS = loadAllConceptArtifacts(workingDir);
    }
  }
  // Concept v2 (E5.2) — fill the pm-plan {{CITABLE_SECTIONS}} placeholder with
  // the real, current-rev section ids from the approved on-disk manifests
  // (closes the E7.8 gap: the PM cites the contract instead of deferring).
  if (typeof step.prompt === 'string' && step.prompt.includes('{{CITABLE_SECTIONS}}')) {
    variables.CITABLE_SECTIONS = loadCitableSections(workingDir);
  }

  // 1. Template substitution
  let prompt = substituteTemplate(step.prompt, variables);
  log('debug', `Prompt after substitution: ${prompt.length} chars`);

  // D4(a) (2026-06-22) — PROACTIVE plan-gen budget guard. Now that the real
  // grounded spec is inlined (PRIOR_ARTIFACTS above), measure the rendered
  // pm-plan prompt: if it's large enough to risk a mid-JSON output overflow,
  // prepend a compact directive so the FIRST attempt aims small (instead of
  // overflowing and relying on D4(b)'s reactive re-fire). No-op for every other
  // step and for small prompts.
  if (step.id === 'pm-plan') {
    const maxOutputTokens = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || undefined;
    const budgeted = applyProactivePlanBudget(prompt, {
      rigor: variables.PLAN_RIGOR,
      maxOutputTokens,
    });
    if (budgeted.injected) {
      prompt = budgeted.prompt;
      log(
        'info',
        `[${jobId.slice(0, 8)}] plan-budget: large pm-plan prompt (${prompt.length} chars, cap=${maxOutputTokens ?? 'default'}) — injected proactive compact directive (≤${budgeted.storyBudget} stories)`,
      );
    }
  }

  // 2. Resolve session resume
  const resumeSession = step.resumeFromStep ? sessions[step.resumeFromStep] : undefined;
  if (step.resumeFromStep) {
    if (resumeSession) {
      log('info', `Resuming session from step ${step.resumeFromStep}: ${resumeSession}`);
    } else {
      log(
        'warn',
        `Step ${step.id} wants to resume from ${step.resumeFromStep} but no session found`,
      );
    }
  }

  // 3. Run agent (PR-6 B+: wrapped with auth-recovery — if OAuth dies
  // mid-stream with no captured output, the wrapper will reload the file
  // and retry up to 2x before escalating to NEEDS_ATTENTION).
  //
  // PR-80-followup — read CLAUDE.md from the project working tree and
  // pass it as --append-system-prompt. The loader handles truncation
  // (100KB cap) + returns null when missing (no-op). Provenance lands
  // in the forensic via `step.append_system_prompt_sha`.
  const effectiveCwd = workingDir || process.env.HOME;
  const claudeMd = readClaudeMd(effectiveCwd);
  // Step-0.9 (2026-06-05) — append the project's skill loadout (name +
  // description per vendored skill) so the model actually invokes the Skill
  // tool. Skills LOAD in every session (CLI init reports them) but were
  // never ACTIVATED: their descriptions are user-utterance-shaped and never
  // match the daemon's machine prompts. See daemon/lib/skills-prompt.mjs.
  //
  // F24 (2026-06-18) — name+description PULL only fired on 5.2% of sessions.
  // For the code-producing roles (DEV/TEST/API_AUTHOR) switch to PUSH: inject
  // the BODIES of the top-3 skills ranked (F27 cosine) against THIS story's
  // substituted prompt, so the conventions are in-context, not waiting on a
  // Skill-tool call. The flat name+description list stays as the fallback for
  // the remaining skills (and for all other roles).
  // W3.1 — one shared push-role policy (imported), so this seam and the P3
  // story pipeline agree. DEV/TEST/API_AUTHOR stay push (unchanged).
  const skillsSection = SKILLS_PUSH_ROLES.has(step.agentId)
    ? await buildSkillsPushPrompt(effectiveCwd, prompt)
    : buildSkillsPromptLine(effectiveCwd);
  const promptParts = [];
  if (claudeMd && !claudeMd.truncated) promptParts.push(`# Project CLAUDE.md\n\n${claudeMd.content}`);
  if (skillsSection) promptParts.push(skillsSection);
  const appendSystemPrompt = promptParts.length > 0 ? promptParts.join('\n\n') : undefined;
  if (claudeMd) {
    pushEvent(jobId, step.id, step.agentId, 'claude_md_loaded', {
      text: `CLAUDE.md ${claudeMd.truncated ? 'truncated' : 'loaded'} from ${effectiveCwd}`,
      sha: claudeMd.sha,
      sizeBytes: claudeMd.sizeBytes,
      truncated: claudeMd.truncated,
    });
  }

  const result = await runAgentWithAuthRecovery(jobId, step.id, step.agentId, prompt, {
    workingDir: effectiveCwd,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    model: agent.model,
    // PR-38 — per-rigor turn cap from RolePolicy.
    maxTurns: agent.maxTurns,
    resume: resumeSession,
    // PR-80-followup
    appendSystemPrompt,
  });

  const resultText = result?.result || '';
  const sessionId = result?.session_id || '';
  sessions[step.id] = sessionId;

  // Extract model info for the step result
  const modelKey = result?.modelUsage ? Object.keys(result.modelUsage)[0] : null;
  const modelInfo = modelKey ? result.modelUsage[modelKey] : {};

  const stepResult = {
    stepId: step.id,
    agentId: step.agentId,
    status: 'complete',
    sessionId,
    cost: result?.total_cost_usd || 0,
    durationMs: result?.duration_ms || 0,
    model: modelKey || undefined,
    inputTokens: modelInfo.inputTokens || result?.usage?.input_tokens || 0,
    outputTokens: modelInfo.outputTokens || result?.usage?.output_tokens || 0,
    contextWindow: modelInfo.contextWindow || 0,
    numTurns: result?.num_turns || 0,
    extractedVariables: {},
    validationResults: [],
  };

  // 4. Run extractors
  if (step.extractors && Object.keys(step.extractors).length > 0) {
    const extracted = runExtractors(resultText, step.extractors);
    stepResult.extractedVariables = extracted;

    for (const [varName, varValue] of Object.entries(extracted)) {
      variables[varName] = varValue;
      await pushEvent(jobId, step.id, step.agentId, 'extraction', {
        variableName: varName,
        variableValue: varValue.slice(0, 500),
        extractorType: step.extractors[varName].type,
      });
    }

    // Concept v2 (E2.4) — when a generator step emits PRD_MD / UX_MD /
    // ARCHITECTURE_MD, land it on disk as the artifact of record (write-back:
    // concept/<kind>.md + <kind>.sections.json, atomic, with anchors) and
    // capture the SMALL manifest sidecar into `<KIND>_SECTIONS_JSON` so the
    // Lambda apply endpoint can register {rev,contentHash} without reading EC2
    // disk and without the raw prose (which TRANSIENT_VARS strips at persist).
    for (const [genVar, kind] of Object.entries(CONCEPT_GEN_VARS)) {
      const md = extracted[genVar];
      if (typeof md !== 'string' || !md.trim()) continue;
      try {
        const { manifest } = writeConceptArtifact(workingDir, kind, md, { rev: 0 });
        const sectionsVar = `${genVar.replace(/_MD$/, '')}_SECTIONS_JSON`;
        variables[sectionsVar] = JSON.stringify(manifest);
        await pushEvent(jobId, step.id, step.agentId, 'extraction', {
          variableName: sectionsVar,
          variableValue: `${manifest.sections.length} sections, ${manifest.contentHash}`,
          extractorType: 'concept-writeback',
        });
        log('info', `[${jobId.slice(0, 8)}] wrote concept/${kind}.md (${manifest.sections.length} sections)`);

        // v3 E1-S2 — capture the PRD's FR ids as a SMALL, persisted job var
        // (the raw PRD_MD is transient-stripped). The apply path reads this off
        // the COMPLETED job and stamps `plan.prdRequirementIds`, the ground
        // truth the readiness gate checks epic `requirementRefs` coverage
        // against. Sibling of the `_SECTIONS_JSON` capture above.
        if (kind === 'prd') {
          const reqIds = extractRequirementIds(md);
          variables.PRD_REQUIREMENT_IDS = JSON.stringify(reqIds);
          await pushEvent(jobId, step.id, step.agentId, 'extraction', {
            variableName: 'PRD_REQUIREMENT_IDS',
            variableValue: `${reqIds.length} FR ids: ${reqIds.join(', ')}`.slice(0, 500),
            extractorType: 'concept-writeback',
          });
        }
      } catch (err) {
        log('error', `[${jobId.slice(0, 8)}] concept write-back failed for ${kind}: ${err.message}`);
      }
    }

    // PR-11 #1 — derive VERDICT + FEEDBACK from REVIEW_CRITERIA.
    //
    // The reviewer step's prompt instructs the agent to emit a structured
    // `---REVIEW_CRITERIA--- AC-1: pass / AC-2: fail — reason ---END_REVIEW_CRITERIA---`
    // block (see story-pipeline.ts §"OUTPUT CONTRACT — REQUIRED (Story C.1)").
    // The parser + aggregator were built (review-criteria-parser.mjs) but
    // never wired into the daemon, so the validation `VERDICT === PASS`
    // always failed (VERDICT was never set) and the retry prompt's
    // `{{FEEDBACK}}` / `{{VERDICT}}` placeholders were never substituted.
    //
    // We derive both AFTER the raw extractors run but BEFORE validations,
    // so the validation matrix sees a populated VERDICT.
    //
    // PR-48 (2026-05-07) — re-derive UNCONDITIONALLY when REVIEW_CRITERIA
    // is captured. The previous `!variables.VERDICT` guard meant iteration
    // 2's review reused iteration 1's VERDICT — fine in steady state, but
    // brick-breaker-3 forensic showed cases where iteration 1 didn't
    // populate VERDICT (likely stale daemon code), then iteration 2's
    // fresh REVIEW_CRITERIA wasn't re-parsed because `!variables.VERDICT`
    // was false (still unset, but the check evaluates `!undefined` → true,
    // so ACTUALLY this should fire). The real cause was an older daemon
    // image without this code. Re-deriving every iteration guarantees the
    // verdict reflects THIS iteration's REVIEW_CRITERIA, never a prior
    // one — defensive consistency at zero cost (parser is pure + cheap).
    if (extracted.REVIEW_CRITERIA) {
      try {
        const entries = parseReviewCriteria(extracted.REVIEW_CRITERIA);
        const agg = aggregateReviewVerdict(entries);
        if (agg.verdict === 'pass') {
          variables.VERDICT = 'PASS';
          variables.FEEDBACK = '';
        } else if (agg.verdict === 'needs-human') {
          // Treat needs-human as a non-blocking pass for the validation gate
          // (the work is done, the operator just needs to confirm subjective
          // judgment) but capture the questions for the attention inbox.
          variables.VERDICT = 'PASS';
          variables.FEEDBACK = formatHumanQuestionsForAttention(agg.reasons.humans);
        } else if (agg.verdict === 'fail') {
          variables.VERDICT = 'FAIL';
          variables.FEEDBACK = formatFailedReasonsForRetry(agg.reasons.failed);
        } else {
          // 'malformed' — reviewer didn't emit a parseable block. Surface to
          // the retry agent so it knows to ask the reviewer for a re-emit.
          variables.VERDICT = 'FAIL';
          variables.FEEDBACK = `Reviewer emitted a malformed REVIEW_CRITERIA block (${agg.parseErrors.map((e) => e.error).join('; ')}). Please re-emit per the contract.`;
        }
        log('info', `Review verdict derived: ${variables.VERDICT}`, {
          counts: agg.counts,
          aggregate: agg.verdict,
        });
        await pushEvent(jobId, step.id, step.agentId, 'extraction', {
          variableName: 'VERDICT',
          variableValue: variables.VERDICT,
          extractorType: 'derived-from-REVIEW_CRITERIA',
        });
        if (variables.FEEDBACK) {
          await pushEvent(jobId, step.id, step.agentId, 'extraction', {
            variableName: 'FEEDBACK',
            variableValue: variables.FEEDBACK.slice(0, 500),
            extractorType: 'derived-from-REVIEW_CRITERIA',
          });
        }
      } catch (err) {
        log('error', `REVIEW_CRITERIA aggregation failed: ${err.message}`);
        // Defensive: if parsing throws, fall through with VERDICT=FAIL so the
        // retry prompt at least has a defined value rather than the literal
        // `{{VERDICT}}` placeholder.
        variables.VERDICT = 'FAIL';
        variables.FEEDBACK = `REVIEW_CRITERIA parser threw: ${err.message}`;
      }
    }

    // Story A.2: when VISUAL_TESTS is captured, materialize it on disk so the
    // reviewer can see it. Before A.2 the reviewer FAILed valid stories with
    // "missing visual-tests file" because nothing wrote `visual-tests.md`.
    // Synchronous on the job loop — must complete BEFORE the reviewer step
    // starts. Malformed entries → compile-sync-failed attention item; the
    // file is left untouched.
    if (extracted.VISUAL_TESTS && workingDir) {
      const merge = mergeVisualTestsBlock({
        projectDir: workingDir,
        block: extracted.VISUAL_TESTS,
      });
      if (merge.ok) {
        log('info', `visual-tests.md merged`, {
          path: merge.path,
          appended: merge.appendedRefs?.length || 0,
          replaced: merge.replacedRefs?.length || 0,
          totalEntries: merge.totalEntries,
        });
        await pushEvent(jobId, step.id, step.agentId, 'status', {
          text: `visual-tests.md updated (${merge.totalEntries || 0} entries; +${merge.appendedRefs?.length || 0} new, ~${merge.replacedRefs?.length || 0} replaced)`,
        });
      } else {
        log('error', `visual-tests.md merge FAILED: ${merge.reason}`, { path: merge.path });
        await pushEvent(jobId, step.id, step.agentId, 'step_error', {
          text: `visual-tests.md write failed: ${merge.reason}`,
        });
        try {
          const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
          if (planId) {
            await writeAttentionItem(
              ddb,
              {
                planId,
                severity: 'medium',
                category: 'compile-sync-failed',
                title: `visual-tests.md write failed`,
                body: `The DEV agent emitted a VISUAL_TESTS block but it could not be parsed into ${merge.path}: ${merge.reason}. The reviewer will not see the visual tests this run.`,
                context: {
                  jobId,
                  epicId: variables.EPIC_ID,
                  storyId: variables.STORY_ID,
                  stepId: step.id,
                },
                suggestedActions: [
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Open story', kind: 'open-story' },
                ],
              },
              log,
            );
          }
        } catch (attnErr) {
          log('error', `Failed to write visual-tests attention item: ${attnErr.message}`);
        }
      }
    }
  }

  // 5. Run validations
  let allPassed = true;
  if (step.validations && step.validations.length > 0) {
    const validationResults = runValidations(step.validations, variables);
    stepResult.validationResults = validationResults;

    for (const vr of validationResults) {
      await pushEvent(jobId, step.id, step.agentId, 'validation', {
        validationLabel: vr.label,
        validationPassed: vr.passed,
        validationDetails: vr.details,
      });
    }

    allPassed = validationResults.every((vr) => vr.passed);
    if (!allPassed) {
      log('warn', `Validation(s) failed in step ${step.id}`);
    }
  }

  stepResults.push(stepResult);

  // PR-12 — strip transient PROJECT_CONTEXT before DDB persist (item size).
  await updateJobFields(jobId, {
    variables: stripTransientVars(variables),
    sessions,
    stepResults,
  });

  // PR-14b — roll the step's USD cost into the parent plan's totalCostUsd.
  // Fire-and-forget; resolves planId via job.epicId (cached). Without this
  // every plan's "Cost" rollup shows $0.00 even when stepResults sum to
  // real money — observed on dino-runner-1 (~$3.34 across 6 stories with
  // plan.totalCostUsd: 0).
  const stepCost = stepResult.cost || 0;
  if (stepCost > 0 && variables.EPIC_ID && variables.EPIC_ID !== '(not provided)') {
    addCostToPlan(ddb, variables.EPIC_ID, stepCost, {
      warn: (m) => log('warn', m),
    }).catch((err) => log('warn', `addCostToPlan error: ${err.message}`));
  }

  log('info', `Step ${step.id} done. Variables: [${Object.keys(variables).join(', ')}]`);

  return { allPassed, stepResult };
}

// ── Compile step identification (imported from compile-pipeline.mjs) ──
const isCompileStep = _isCompileStep;

/**
 * Pipeline v2.0 PR-7 (I) — auto-resolve attention items when a story-pipeline
 * job lands in a SUCCESS state (COMPLETED, COMPLETED_VIA_PREWORK,
 * COMPLETED_VIA_SALVAGE).
 *
 * Resolves the dedupKeys that the daemon + wave-reducer would have created
 * for this story's prior failures. Operator no longer sees stale failure
 * items in the inbox after a successful retry.
 *
 * Best-effort: each resolve is fire-and-forget. Failure to resolve doesn't
 * break the success path.
 */
async function autoResolveStoryAttentionOnSuccess(jobId, variables) {
  const storyId = variables?.STORY_ID;
  const epicId = variables?.EPIC_ID;
  if (!storyId || !epicId) return;
  let planId;
  try {
    planId = await resolvePlanIdFromEpicId(ddb, epicId);
  } catch {
    return;
  }
  if (!planId) return;

  // dedupKey scheme — must match the writer call sites in this file +
  // functions/shared/services/wave-reducer.ts. If a key isn't present in
  // the table, autoResolveAttentionByDedupKey returns false silently.
  const keys = [
    `wave-reducer:test-gate-failed:${storyId}`,
    `dev-retry-exhausted:${storyId}`,
    `retry-exhausted:${jobId}`,
  ];
  for (const dedupKey of keys) {
    try {
      await autoResolveAttentionByDedupKey(ddb, planId, dedupKey, log);
    } catch (err) {
      log('warn', `auto-resolve attention failed (non-critical): ${err.message}`, {
        planId,
        dedupKey,
      });
    }
  }
}

// Pipeline v2.0 PR-4 — touch-point inference at dispatch time.
// Default ON. Disable via TOUCH_POINT_INFERENCE_ENABLED=false.
// LLM fallback can be disabled separately via TOUCH_POINT_LLM_FALLBACK_ENABLED=false
// (heuristic-only mode — useful in $0-cost environments / CI).
const TOUCH_POINT_INFERENCE_ENABLED =
  (process.env.TOUCH_POINT_INFERENCE_ENABLED || 'true') !== 'false';
const TOUCH_POINT_LLM_FALLBACK_ENABLED =
  (process.env.TOUCH_POINT_LLM_FALLBACK_ENABLED || 'true') !== 'false';

/**
 * Pipeline v2.0 PR-4 — ensure the story has touchPoints[] before the gate runs.
 *
 * If `variables.TOUCH_POINTS` is missing or `'[]'`, infer touchPoints from the
 * story's AC text (heuristic first, Haiku fallback) and persist the result
 * back to the epic row so subsequent dispatches reuse it. Updates
 * `variables.TOUCH_POINTS` in place.
 *
 * Best-effort — never throws. Failure leaves variables.TOUCH_POINTS empty
 * and the prework gate falls through to spawn DEV (the v1 behavior).
 *
 * @param {object} variables - in/out: variables.TOUCH_POINTS may be mutated.
 * @param {string} workingDir
 */
async function inferAndPersistTouchPointsIfEmpty(jobId, variables, workingDir) {
  if (!TOUCH_POINT_INFERENCE_ENABLED) return;

  // Already populated? Skip.
  let existing = [];
  try {
    existing = JSON.parse(variables.TOUCH_POINTS || '[]');
  } catch {
    /* malformed — re-infer */
  }
  if (Array.isArray(existing) && existing.length > 0) return;

  const epicId = variables.EPIC_ID;
  const storyId = variables.STORY_ID;
  if (!epicId || !storyId || !workingDir) return;

  // Look up the story so we have the description + AC text.
  let story;
  try {
    const epic = await epicRepo.getEpicById(epicId);
    story = epic?.stories?.find((s) => s.storyId === storyId);
  } catch (err) {
    log('warn', `[${jobId.slice(0, 8)}] touch-point inference: epic fetch failed: ${err.message}`);
    return;
  }
  if (!story) return;

  let result;
  try {
    result = await inferTouchPoints({
      projectDir: workingDir,
      story: {
        title: story.title,
        description: story.description,
        acceptanceCriteria:
          (story.criteria || []).map((c) => `- ${c.text || c.description || ''}`).join('\n') || '',
      },
      opts: { skipLlm: !TOUCH_POINT_LLM_FALLBACK_ENABLED },
    });
  } catch (err) {
    log(
      'warn',
      `[${jobId.slice(0, 8)}] touch-point inference threw (non-blocking): ${err.message}`,
    );
    return;
  }

  log(
    'info',
    `[${jobId.slice(0, 8)}] touch-point inference: source=${result.source} count=${result.touchPoints.length} reason="${result.reason || ''}"`,
  );

  if (result.touchPoints.length === 0) {
    // Nothing to do — variables.TOUCH_POINTS stays empty; the gate will fall
    // through naturally.
    await pushEvent(jobId, '__touch_point_inference__', 'orchestrator', 'status', {
      text: `[SYSTEM] touch-points: source=none — ${result.reason || 'no paths inferred'}`,
    });
    return;
  }

  // Persist back to the epic row + update in-memory variables.
  try {
    const persisted = await epicRepo.updateStoryTouchPoints(epicId, storyId, result.touchPoints, {
      source: result.source,
    });
    if (persisted.updated) {
      log(
        'info',
        `[${jobId.slice(0, 8)}] persisted ${result.touchPoints.length} touchPoint(s) to epic row`,
      );
    }
  } catch (err) {
    // Persistence failure is non-fatal — the inference still informs the
    // current run via variables.TOUCH_POINTS.
    log(
      'warn',
      `[${jobId.slice(0, 8)}] touch-point persistence failed (non-blocking): ${err.message}`,
    );
  }

  variables.TOUCH_POINTS = JSON.stringify(result.touchPoints);
  await pushEvent(jobId, '__touch_point_inference__', 'orchestrator', 'status', {
    text: `[SYSTEM] touch-points: source=${result.source} paths=${JSON.stringify(result.touchPoints).slice(0, 300)}`,
  });
}

/**
 * Pipeline v2.0 T0.2 — run the pre-DEV gate for a story-pipeline job.
 * Reads AC_TEXT / TOUCH_POINTS / PLAN_START_TIME from the job's pipeline
 * variables (seeded by generateStoryPipeline), invokes the pure
 * `evaluatePreworkGate`, and writes the evidence markdown to
 * `<workingDir>/.context/wave-N-story-<id>.md` for observability and (when
 * the gate falls through) for the running DEV agent to optionally Read.
 *
 * Returns { shouldSkipDev, reason, evidenceMarkdownPath?, evidence }.
 *
 * Never throws on internal failures — caller falls through to spawn DEV.
 */
async function runPreworkGateForJob(job, variables, workingDir) {
  let touchPoints = [];
  try {
    const raw = variables.TOUCH_POINTS || '[]';
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) touchPoints = parsed.filter((p) => typeof p === 'string');
  } catch {
    // malformed TOUCH_POINTS — treat as no touchPoints (gate falls through)
  }

  const verdict = await evaluatePreworkGate({
    projectDir: workingDir,
    planStartTime: variables.PLAN_START_TIME || null,
    touchPoints,
    acText: variables.AC_TEXT || '',
    runCommand: variables.RUN_COMMAND || undefined,
  });

  // Persist evidence to disk for observability + agent-side context (T1.5
  // will plumb the path into the dev prompt's touchPoints in a later PR;
  // for now the file simply exists).
  let evidenceMarkdownPath = null;
  try {
    const storyId = variables.STORY_ID || 'unknown';
    const waveNum = variables.WAVE_NUMBER || '0';
    const dir = `${workingDir.replace(/\/+$/, '')}/.context`;
    await fsMkdir(dir, { recursive: true });
    const filename = `wave-${waveNum}-story-${storyId}.md`;
    evidenceMarkdownPath = `${dir}/${filename}`;
    const md = renderGateEvidence(verdict, storyId);
    if (md) await fsWriteFile(evidenceMarkdownPath, md, 'utf8');
  } catch (writeErr) {
    log('warn', `prework-gate: failed to write evidence file (non-fatal): ${writeErr.message}`);
  }

  return {
    shouldSkipDev: !verdict.shouldSpawnDev,
    reason: verdict.reason,
    evidenceMarkdownPath,
    evidence: verdict.evidence,
  };
}

// 2026-06-05 — false-DONE guard. A story-pipeline job must not reach COMPLETED
// unless a real commit for this story landed on the worktree's HEAD. The
// compile-commit-on-pass step already exits 1 + the daemon fails the job on a
// FRESH run (STORY_COMMIT_EMPTY, ~L2929). But a RESUME could re-enter the
// compile phase PAST the errored commit step and run compile-sync/compile-push
// to COMPLETED with no commit (observed: a story flipped DONE with an empty
// commit, then deployed without the code). This is a resume-proof backstop that
// checks git ground truth instead of trusting step bookkeeping. Every story
// commit — real or verification-only (--allow-empty) — has subject
// `story: <storyId> — …` and a `Story: <storyId>` trailer, so a grep finds it.
// Fail-OPEN on any git/infra error so a healthy pipeline is never broken by the
// guard itself.
function storyCommitExistsSync(workingDir, storyId) {
  if (!workingDir || !storyId) return true; // not enough info → don't block
  try {
    const out = execSync(
      `git -C ${JSON.stringify(workingDir)} log --grep ${JSON.stringify(storyId)} --format=%H -1`,
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out.length > 0;
  } catch {
    return true; // git unavailable / not a repo / transient → fail-open
  }
}

async function executePipeline(job) {
  const { jobId, pipeline } = job;

  if (!pipeline || !pipeline.agents || !pipeline.steps) {
    throw new Error('Job has no valid pipeline definition (old format?)');
  }

  const { agents, steps } = pipeline;
  const maxIterations = pipeline.maxIterations || 1;
  const workingDir = job.workingDir;

  const variables = {
    ITERATION: '1',
    MAX_ITERATIONS: String(maxIterations),
    ...(pipeline.initialVariables || {}),
  };

  // PR-11 #2 — assemble the Story Context Pack (Epic B.2) and inject as
  // PROJECT_CONTEXT so the reviewer prompt's `<project_context>` actually
  // contains storySpec / touchPoints / recentDiffs / projectTree. Before
  // this fix the placeholder was left literal and the reviewer hallucinated
  // ACs from the developer's summary alone.
  //
  // PR-51 (2026-05-07) — refactored into a helper so steps with
  // `refreshContext: true` (review + retry per story-pipeline.ts) can
  // re-assemble the pack mid-job. brick-breaker-3 forensic showed that
  // PROJECT_CONTEXT was static across all steps within a job, so REVIEWER
  // couldn't see DEV's writes via the context pack and had to spend
  // tool calls Reading the files. With per-step refresh, REVIEWER's
  // pack reflects DEV's post-state and tool calls drop.
  //
  // Best-effort: the resolver never throws, returns a stub failure pack on
  // any error so the pipeline still runs. validationErrors[] surfaces as
  // attention.context-pack-invalid (Story 2-A-2-1 / PR-33).
  async function refreshProjectContext(reason) {
    try {
      const { body, failure, validationErrors } = await resolveAndSerializeContextPack({
        ddb,
        job,
        variables,
        logger: {
          info: (m) => log('info', m),
          warn: (m) => log('warn', m),
          error: (m) => log('error', m),
        },
      });
      variables.PROJECT_CONTEXT = body || '';
      if (failure) {
        log('warn', `[${jobId.slice(0, 8)}] context pack stub (${reason}): ${failure}`);
      } else {
        log('info', `[${jobId.slice(0, 8)}] context pack ${reason} (${body.length} chars)`);
      }
      // PR-51 — when validation fails, emit a medium-severity attention
      // item so the operator knows the agent is running with a
      // potentially malformed context. Pipeline still proceeds with the
      // stub body (PR-33's fail-open semantics preserved).
      if (validationErrors && validationErrors.length > 0 && variables.PLAN_ID) {
        try {
          await writeAttentionItem(
            ddb,
            {
              planId: variables.PLAN_ID,
              dedupKey: `context-pack-invalid:${jobId}:${reason}`,
              severity: 'medium',
              category: 'context-pack-invalid',
              title: `PROJECT_CONTEXT validation failed (${reason})`,
              body:
                `${validationErrors.length} validation error(s) — pipeline ` +
                `proceeded with stub body.\n\n` +
                validationErrors
                  .slice(0, 10)
                  .map((e) => `- ${e}`)
                  .join('\n'),
              context: { jobId, reason },
            },
            (level, msg, data) => log(level, msg, data),
          );
        } catch (attnErr) {
          log(
            'warn',
            `[${jobId.slice(0, 8)}] attention.context-pack-invalid emit failed: ${attnErr.message}`,
          );
        }
      }
    } catch (err) {
      log(
        'error',
        `[${jobId.slice(0, 8)}] context pack resolver threw (${reason}): ${err.message}`,
      );
      variables.PROJECT_CONTEXT = `<!-- context pack failed: ${err.message} -->`;
    }
  }

  if (!variables.PROJECT_CONTEXT && variables.STORY_ID) {
    await refreshProjectContext('initial-assembly');
  } else if (!variables.PROJECT_CONTEXT) {
    // No STORY_ID — orchestrator-level or pipeline-init-only jobs. Use a
    // benign empty marker so {{PROJECT_CONTEXT}} doesn't survive substitute.
    variables.PROJECT_CONTEXT = '<!-- no story context (job has no STORY_ID variable) -->';
  }

  // Pipeline v2.0 PR-6 (A) — retry resume-from-session.
  // When a retry job is created via launchStoryRerun + buildPriorJobStateFromStory,
  // pipeline.initialSessions / initialStepResults carry the prior job's runtime
  // state. Seeding sessions[] enables `--resume <prior session>` on the failed
  // step (warm cache hits). Seeding stepResults[] lets the steps loop skip
  // already-`complete` steps so we don't re-run DEV when DEV already finished.
  const sessions = { ...(pipeline.initialSessions || {}) };
  const stepResults = Array.isArray(pipeline.initialStepResults)
    ? [...pipeline.initialStepResults]
    : [];
  const completedStepIds = new Set(
    stepResults
      .filter((sr) => sr?.status === 'complete')
      .map((sr) => sr?.stepId)
      .filter(Boolean),
  );
  const isRetryResume = stepResults.length > 0 || Object.keys(sessions).length > 0;
  if (isRetryResume) {
    log(
      'info',
      `[${jobId.slice(0, 8)}] retry-resume: ${completedStepIds.size} step(s) carrying forward as complete, ${Object.keys(sessions).length} session(s) available for --resume`,
      { completedSteps: [...completedStepIds] },
    );
  }

  // Compilation tracking metadata
  let compilationStatus = undefined; // 'success' | 'failed' | 'skipped' | undefined
  let compilationStartedAt = undefined;
  let compilationCompletedAt = undefined;

  // Collect steps that are loop-only targets (only run during loop retries, not in linear flow)
  const loopTargetIds = new Set(steps.filter((s) => s.loopTo).map((s) => s.loopTo));

  // Check if this pipeline has compile steps
  const hasCompileSteps = steps.some((s) => isCompileStep(s.id));

  log(
    'info',
    `Pipeline starting: ${steps.length} steps, ${Object.keys(agents).length} agents, maxIterations: ${maxIterations}`,
  );
  if (loopTargetIds.size > 0) {
    log('info', `Loop-only steps (skipped in linear flow): [${[...loopTargetIds].join(', ')}]`);
  }
  if (hasCompileSteps) {
    log('info', `COMPILE phase detected: steps will be non-blocking`);
  }

  await updateJobFields(jobId, { status: 'RUNNING', currentStepIndex: 0 });

  // ── 2026-05-19 Phase 1 worktree rollout — per-story worktree setup ──
  //
  // When pipeline-launcher baked `workingDir` as
  // `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/`, materialize the
  // worktree (git worktree add + node_modules symlink) before any step
  // runs. Legacy paths (`/home/ubuntu/projects/<app>/`) skip this — they
  // are operator-owned shared worktrees.
  //
  // Idempotent: setupStoryWorktree treats an existing-on-correct-branch
  // worktree as a happy reuse (daemon restart picked up the same story).
  if (
    workingDir &&
    workingDir.startsWith(`${DAEMON_WORKTREE_ROOT}/`) &&
    variables.STORY_ID &&
    variables.STORY_ID !== '(not provided)'
  ) {
    try {
      // Path shape: <DAEMON_WORKTREE_ROOT>/<app>/<plan>/<storyId>/
      const rel = workingDir.replace(/\/+$/, '').slice(`${DAEMON_WORKTREE_ROOT}/`.length);
      const [appId, planSlug, storyId] = rel.split('/').filter(Boolean);
      if (!appId || !planSlug || !storyId) {
        throw new Error(`workingDir does not match ${DAEMON_WORKTREE_ROOT}/<app>/<plan>/<story>/ shape: ${workingDir}`);
      }
      const setup = await setupStoryWorktree({
        appId,
        planSlug,
        storyId,
        sourceWorktree: `${DAEMON_PROJECTS_ROOT}/${appId}`,
        log: (level, msg) => log(level, msg),
      });
      log(
        'info',
        `[${jobId.slice(0, 8)}] story-worktree ${setup.reused ? 'reused' : 'created'}: ${setup.worktreeDir} on ${setup.branch} (node_modules ${setup.nodeModules.skipped ? 'skipped-no-lockfile' : setup.nodeModules.freshlyInstalled ? 'fresh-install' : 'symlinked'})`,
      );
    } catch (wtErr) {
      // A worktree-setup failure is fatal — without it, the pipeline's
      // shell steps `cd workingDir` to a non-existent path and explode.
      // Mark the job FAILED with the underlying error.
      log('error', `[${jobId.slice(0, 8)}] story-worktree setup failed: ${wtErr.message}`);
      await updateJobFields(jobId, {
        status: 'FAILED',
        failedStepId: '__worktree_setup__',
        failureReason: `Worktree setup failed: ${wtErr.message.slice(0, 200)}`,
      });
      throw wtErr;
    }
  }

  // ── Pipeline v2.0 T0.2 — daemon-side pre-DEV gate ──
  // Run before the first step. If all three signals (recent commits + AC
  // named exports present in touchPoints + tsc clean) pass, short-circuit the
  // entire pipeline to COMPLETED_VIA_PREWORK. No LLM is invoked. dino1
  // forensic: 7 of 9 stories were no-ops; this gate would have skipped them
  // for ~$0.02 each instead of ~$0.30 each via the agent-emits-sentinel path.
  const isStoryPipeline = Boolean(variables.STORY_ID);
  const hasDevStep = steps.some((s) => s.id === 'dev');
  if (PREWORK_GATE_ENABLED && isStoryPipeline && hasDevStep && workingDir) {
    // Pipeline v2.0 PR-4 — infer touchPoints if the planner left them empty.
    // Runs before the gate so Signal 1 (commits in scope) and Signal 2 (AC
    // exports in touchPoint files) actually have inputs to evaluate.
    await inferAndPersistTouchPointsIfEmpty(jobId, variables, workingDir);
    try {
      const gateResult = await runPreworkGateForJob(job, variables, workingDir);
      if (gateResult.shouldSkipDev) {
        log(
          'info',
          `[${jobId.slice(0, 8)}] prework gate PASSED — skipping DEV; reason: ${gateResult.reason}`,
        );
        await pushEvent(jobId, '__prework_gate__', 'orchestrator', 'status', {
          text: `[SYSTEM] prework-gate=skip-dev — ${gateResult.reason}`,
        });
        await updateJobFields(jobId, {
          status: 'COMPLETED_VIA_PREWORK',
          variables,
          stepResults,
          totalCost: 0,
          preworkGateEvidence: gateResult.evidenceMarkdownPath || undefined,
        });
        // PR-7 (I) — clear stale attention items from prior failures of the
        // same story (typical: operator clicked Retry after a failure and
        // the prework gate now finds the AC already satisfied by the prior
        // attempt's commits).
        await autoResolveStoryAttentionOnSuccess(jobId, variables);
        return;
      }
      log(
        'info',
        `[${jobId.slice(0, 8)}] prework gate fell through — spawning DEV; reason: ${gateResult.reason}`,
      );
      await pushEvent(jobId, '__prework_gate__', 'orchestrator', 'status', {
        text: `[SYSTEM] prework-gate=spawn-dev — ${gateResult.reason}`,
      });
    } catch (gateErr) {
      // Gate must NEVER block the pipeline. Log + fall through to spawn DEV.
      log('warn', `[${jobId.slice(0, 8)}] prework gate threw (non-blocking): ${gateErr.message}`);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Skip loop-only steps in normal linear flow — they only run during loop iterations
    if (loopTargetIds.has(step.id)) {
      log('info', `Skipping "${step.id}" (loop-only step, runs only during retry)`);
      continue;
    }

    // Pipeline v2.0 PR-6 (A) — retry-resume: skip steps that already
    // completed in the prior job. The prior step's stepResult is already
    // in stepResults[] (carried over from initialStepResults), so the
    // orchestrator's downstream consumers see "step done" without re-spawning.
    if (isRetryResume && completedStepIds.has(step.id)) {
      log(
        'info',
        `[${jobId.slice(0, 8)}] retry-resume: skipping "${step.id}" (prior job marked complete)`,
      );
      await pushEvent(jobId, step.id, '__resume__', 'status', {
        text: `[SYSTEM] retry-resume: step "${step.id}" already complete in prior job; skipping`,
      });
      continue;
    }

    // Pipeline v2.0 PR-6 (A) — for the first step that DID NOT complete in
    // the prior job, set resumeFromStep so the agent --resumes the prior
    // step's session (warm cache, conversation history). The agent's text
    // history still reflects what already happened on the previous attempt;
    // the daemon doesn't need to re-feed prior context.
    if (isRetryResume && step.stepType !== 'shell' && !step.resumeFromStep && sessions[step.id]) {
      step.resumeFromStep = step.id; // resolve via sessions[step.resumeFromStep]
      log(
        'info',
        `[${jobId.slice(0, 8)}] retry-resume: step "${step.id}" will --resume prior session ${sessions[step.id].slice(0, 8)}…`,
      );
    }

    // PR-50 (2026-05-07) — denormalize the step ID alongside the index so
    // the UI can render a per-story status badge without re-resolving
    // pipeline.steps[currentStepIndex] on every poll. Single DDB write per
    // step transition; no scan / no extra event. The story dashboard reads
    // `job.currentStepId` directly.
    await updateJobFields(jobId, { currentStepIndex: i, currentStepId: step.id });

    // PR-51 (2026-05-07) — refresh PROJECT_CONTEXT before steps that
    // benefit from seeing prior step's writes (review sees DEV's edits;
    // retry sees DEV's first-attempt writes). Skip when STORY_ID is
    // absent (orchestrator-level jobs) or when the step opts out.
    //
    // Default refresh-eligible steps: review, retry, compile-knowledge.
    // Other steps (test-author, dev, test-verify, tamper-check,
    // baseline-regression, compile-diff, compile-sync, compile-push)
    // either don't benefit (they run BEFORE / DURING DEV's writes) or
    // produce their own diff (compile-diff explicitly reads HEAD).
    //
    // The step's `refreshContext` field overrides this default when set.
    const REFRESH_BY_DEFAULT = new Set(['review', 'retry', 'compile-knowledge']);
    const shouldRefresh =
      typeof step.refreshContext === 'boolean'
        ? step.refreshContext
        : REFRESH_BY_DEFAULT.has(step.id);
    if (shouldRefresh && variables.STORY_ID && i > 0) {
      await refreshProjectContext(`pre-${step.id}`);
    }

    // ── Non-blocking COMPILE phase handling ──
    if (isCompileStep(step.id)) {
      // Record compilation start time on first compile step
      if (!compilationStartedAt) {
        const compilationCtx = {
          jobId,
          storyId: variables.STORY_ID || 'unknown',
          epicId: variables.EPIC_ID || 'unknown',
          projectId: variables.PROJECT_ID || 'unknown',
          workingDir,
        };
        compilationStartedAt =
          (await emitCompilationStarted(pushEvent, jobId, compilationCtx)) ||
          new Date().toISOString();
      }

      try {
        const { allPassed } = await executeStep(
          jobId,
          step,
          agents,
          workingDir,
          variables,
          sessions,
          stepResults,
        );

        if (!allPassed) {
          throw new Error(`Compile step ${step.id} did not pass`);
        }

        // If this is the last compile step and we got here, compilation succeeded
        if (step.id === 'compile-sync') {
          compilationStatus = 'success';
          compilationCompletedAt = new Date().toISOString();
          const durationMs = new Date(compilationCompletedAt) - new Date(compilationStartedAt);

          // Parse article counts from the compiler agent's output
          const articleCounts = parseArticleCounts(variables.COMPILE_RESULT || '');

          const compilationCtx = {
            jobId,
            storyId: variables.STORY_ID || 'unknown',
            epicId: variables.EPIC_ID || 'unknown',
            projectId: variables.PROJECT_ID || 'unknown',
            workingDir,
          };

          log(
            'info',
            `Compilation phase SUCCEEDED (${durationMs}ms, ${articleCounts.created} created, ${articleCounts.updated} updated, ${articleCounts.superseded} superseded)`,
          );

          await emitCompilationCompleted(pushEvent, jobId, compilationCtx, {
            status: 'success',
            startedAt: compilationStartedAt,
            completedAt: compilationCompletedAt,
            durationMs,
            articleCounts,
          });

          // Write success record to knowledge/log.md as fallback
          // (in case the COMPILER agent skipped the log write)
          await writeCompilationLog(
            workingDir,
            variables.STORY_ID || 'unknown',
            'success',
            articleCounts,
          );

          // 2026-05-17 dino-7 fix: auto-resolve any compile-failed attention
          // items for this (planId, storyId, *) that were created by a prior
          // step in this same job's compile phase. Pre-fix dino-7 left 2 open
          // compile-failed items even though both stories' self-heal pass
          // succeeded — the operator saw stale red badges forever. Since the
          // overall compile phase succeeded, every per-step failure dedup key
          // is moot.
          //
          // Compile step IDs from story-pipeline.ts: compile-commit-on-pass,
          // compile-diff, compile-ast, compile-knowledge, compile-sync,
          // compile-push. Resolve all six idempotently (autoResolveAttentionByDedupKey
          // returns false silently when the row doesn't exist).
          try {
            const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
            const storyId = variables.STORY_ID || 'unknown';
            if (planId && storyId !== 'unknown') {
              const compileStepIds = [
                'compile-commit-on-pass',
                'compile-diff',
                'compile-ast',
                'compile-knowledge',
                'compile-sync',
                'compile-push',
              ];
              await Promise.all(
                compileStepIds.map((sid) =>
                  autoResolveAttentionByDedupKey(
                    ddb,
                    planId,
                    `compile-failed:${planId}:${storyId}:${sid}`,
                    log,
                  ),
                ),
              );
            }
          } catch (resolveErr) {
            // Resolution failures are cosmetic — never let them break the
            // compile-sync success path.
            log(
              'warn',
              `compile-failed attention auto-resolve failed (non-critical): ${resolveErr.message}`,
            );
          }
        }
      } catch (compileErr) {
        compilationStatus = 'failed';
        compilationCompletedAt = new Date().toISOString();

        const compilationCtx = {
          jobId,
          storyId: variables.STORY_ID || 'unknown',
          epicId: variables.EPIC_ID || 'unknown',
          projectId: variables.PROJECT_ID || 'unknown',
          workingDir,
        };

        // 2026-05-19 — Phase 0.1 of the worktree rollout plan
        // (docs/concepts/pipeline-v2/worktree-rollout-plan.md). Pre-fix the
        // daemon classified ALL compile-phase steps as non-blocking. That was
        // correct for the knowledge-sidecar steps (compile-diff / compile-ast
        // / compile-knowledge / compile-sync / compile-push) — those are
        // idempotent rebuild operations and a transient failure should not
        // kill the story. But `compile-commit-on-pass` is load-bearing: it's
        // the actual git commit. If it fails the empty-commit guard
        // (STORY_COMMIT_EMPTY, PR-67), no source landed and the story
        // SHOULD fail. snake-4_mpcdwkto had 2 stories ship green with no
        // commit because this override was missing.
        //
        // Honor `onFail.action: 'fail'` on compile-commit-on-pass specifically
        // (the only compile step with that contract). Other compile steps
        // continue to be non-blocking.
        if (step.id === 'compile-commit-on-pass' && step.onFail?.action === 'fail') {
          log(
            'error',
            `compile-commit-on-pass failed AND has onFail.action='fail' — blocking job. ${compileErr.message}`,
          );
          // P1 (pong1 2026-06-12): the commit step now has TWO loud failure
          // modes. STORY_COMMIT_EMPTY = nothing staged, no commit happened.
          // STORY_COMMIT_INCOMPLETE = a commit happened but a declared
          // touchPoint sitting on disk never made it into HEAD (validated ≠
          // shipped). The step's stderr was injected as STORY_COMMIT_ERROR
          // (onFail.injectAs), so discriminate there — compileErr.message is
          // just the generic "did not pass".
          const commitStderr = String(variables.STORY_COMMIT_ERROR || '');
          const commitIncomplete = commitStderr.includes('STORY_COMMIT_INCOMPLETE');
          const commitCategory = commitIncomplete ? 'story-commit-incomplete' : 'story-commit-empty';
          // Emit a high-severity attention item (vs the medium-severity
          // compile-failed) so the operator sees this as a real story failure.
          try {
            const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
            if (planId) {
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'high',
                  category: commitCategory,
                  title: commitIncomplete
                    ? `Story ${variables.STORY_ID || 'unknown'} commit is missing declared touchPoints`
                    : `Story ${variables.STORY_ID || 'unknown'} produced no commit`,
                  body: commitIncomplete
                    ? `compile-commit-on-pass committed, but one or more of the ` +
                      `story's declared touchPoints exist in the worktree without ` +
                      `being in HEAD — the smoke validated files that did NOT ship. ` +
                      `This should be impossible after the P1 unconditional ` +
                      `touchPoint staging; inspect the worktree's git state.\n\n` +
                      `Marker output: ${commitStderr.slice(0, 400)}`
                    : `compile-commit-on-pass refused to commit because no source-` +
                      `code changes were staged. Likely cause: DEV agent wrote the ` +
                      `file but a sibling story's commit step swept it via git add ` +
                      `-A first (the snake-4_mpcdwkto subsumption race), OR DEV ` +
                      `legitimately produced no source. Inspect the working tree ` +
                      `and the dev session before retrying.\n\n` +
                      `Step error: ${compileErr.message.slice(0, 400)}`,
                  context: {
                    jobId,
                    epicId: variables.EPIC_ID,
                    storyId: variables.STORY_ID,
                    stepId: step.id,
                  },
                  suggestedActions: [
                    { label: 'Open logs', kind: 'open-logs' },
                    { label: 'Open story', kind: 'open-story' },
                  ],
                  dedupKey: `${commitCategory}:${planId}:${variables.STORY_ID || 'unknown'}`,
                },
                log,
              );
            }
          } catch (attnErr) {
            log('error', `Failed to write ${commitCategory} attention: ${attnErr.message}`);
          }
          // Mark the job FAILED with the step id + error for forensic clarity,
          // then re-throw so the outer try/catch in the job runner records
          // the standard failure metadata.
          await updateJobFields(jobId, {
            status: 'FAILED',
            failedStepId: step.id,
            failureReason: `compile-commit-on-pass: ${compileErr.message.slice(0, 200)}`,
          });
          throw new Error(
            `Story job failed: compile-commit-on-pass refused empty commit (${compileErr.message.slice(0, 150)})`,
          );
        }

        log('warn', `Compilation step ${step.id} failed (NON-BLOCKING): ${compileErr.message}`);

        // Emit typed compilation-failed event via compile-events module
        await emitCompilationFailed(
          pushEvent,
          jobId,
          compilationCtx,
          compileErr,
          compilationStartedAt,
        );

        // PR-14e — surface compile failures in the attention inbox.
        // Compile is non-blocking by design (knowledge graph rebuild is
        // idempotent — next story can rebuild what was missed) so the
        // pipeline continues. Without an attention item the failure is
        // silent: dino-runner-1 had 3/6 compile steps fail and operator
        // had no UI signal at all. Dedup-key per (planId, storyId, stepId)
        // so a re-run on the same story upserts instead of multiplying.
        try {
          const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
          if (planId) {
            await writeAttentionItem(
              ddb,
              {
                planId,
                severity: 'medium',
                category: 'compile-failed',
                title: `Knowledge compiler failed for story ${variables.STORY_ID || 'unknown'}`,
                body:
                  `Compile step "${step.id}" threw: ${compileErr.message.slice(0, 400)}\n\n` +
                  `Compile is non-blocking — the rest of the pipeline continued. ` +
                  `Knowledge graph for this story is missing; the next compile run ` +
                  `will rebuild from the live diff.`,
                context: {
                  jobId,
                  epicId: variables.EPIC_ID,
                  storyId: variables.STORY_ID,
                  stepId: step.id,
                },
                suggestedActions: [
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Open story', kind: 'open-story' },
                ],
                dedupKey: `compile-failed:${planId}:${variables.STORY_ID || 'unknown'}:${step.id}`,
              },
              log,
            );
          }
        } catch (attnErr) {
          log('error', `Failed to write compile-failed attention item: ${attnErr.message}`);
        }

        // Write failure record to knowledge/log.md via compile-events module
        await writeCompilationLog(
          workingDir,
          variables.STORY_ID || 'unknown',
          'failed',
          { created: 0, updated: 0, superseded: 0 },
          compileErr.message.slice(0, 100),
        );

        // Skip remaining compile steps — jump to end of compile phase
        while (i + 1 < steps.length && isCompileStep(steps[i + 1].id)) {
          i++;
          log('info', `Skipping remaining compile step: ${steps[i].id}`);
        }
        // Continue pipeline — compilation is non-blocking
        continue;
      }
      continue;
    }

    // ── Standard (non-compile) step execution ──
    const { allPassed } = await executeStep(
      jobId,
      step,
      agents,
      workingDir,
      variables,
      sessions,
      stepResults,
    );

    // ── Loop logic: if validations failed and loopTo is set, retry ──
    if (!allPassed && step.loopTo) {
      const retryStep = steps.find((s) => s.id === step.loopTo);
      if (!retryStep) {
        log('error', `loopTo step "${step.loopTo}" not found, skipping loop`);
        continue;
      }

      // dino1 (2026-06-13) — track loop outcome so a HARD gate (action:'fail',
      // e.g. lint-verify/test-verify) that never recovers fails the job rather
      // than silently continuing past a blocking gate with known-bad code.
      let loopResolved = false;
      let loopContested = false;

      for (let iteration = 1; iteration < maxIterations; iteration++) {
        // Inject iteration count into variable store so prompts can use {{ITERATION}}
        variables.ITERATION = String(iteration + 1); // 1st attempt was iteration 1, this is 2+
        variables.MAX_ITERATIONS = String(maxIterations);

        log(
          'info',
          `\n*** LOOP iteration ${iteration}/${maxIterations - 1}: running "${retryStep.id}" then re-checking "${step.id}" (attempt ${iteration + 1}/${maxIterations}) ***`,
        );

        await pushEvent(jobId, step.id, step.agentId || '__shell__', 'status', {
          text: `Loop iteration ${iteration}: re-running ${retryStep.id} then ${step.id} (attempt ${iteration + 1}/${maxIterations})`,
        });

        // Run the retry/fix step
        const contestBefore = variables.AC_CONTEST || '';
        await executeStep(jobId, retryStep, agents, workingDir, variables, sessions, stepResults);

        // ── Step-0.3b (2026-06-05) — AC_CONTEST routing ──
        // DEV disputed the failing AC (the verification instrument cannot
        // observe the state it describes) INSTEAD of changing code. Stop the
        // fix loop without burning the remaining iterations, mark the contest
        // for the operator to adjudicate, and leave a marker file so the
        // commit step suppresses the VQA-Fixed trailer (Step-0.7) — a
        // contested verdict must never be mined as a visual lesson.
        const contestNow = variables.AC_CONTEST || '';
        if (contestNow.trim() && contestNow !== contestBefore) {
          log(
            'warn',
            `[${jobId.slice(0, 8)}] AC_CONTEST raised by ${retryStep.id} — stopping fix loop, routing to operator: ${contestNow.trim().slice(0, 200)}`,
          );
          try {
            const ctxDir = pathJoin(workingDir || '.', '.context');
            mkdirSync(ctxDir, { recursive: true });
            appendFileSync(pathJoin(ctxDir, 'ac-contest.txt'), contestNow.trim() + '\n');
          } catch (markerErr) {
            log('warn', `ac-contest marker write failed (non-blocking): ${markerErr.message}`);
          }
          loopContested = true;
          await pushEvent(jobId, step.id, 'orchestrator', 'status', {
            text: `[SYSTEM] AC contested by DEV — fix loop stopped without consuming iterations: ${contestNow.trim().slice(0, 300)}`,
          });
          try {
            const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
            if (planId) {
              await writeAttentionItem(
                ddb,
                {
                  planId,
                  severity: 'medium',
                  category: 'ac-contested',
                  title: `DEV contests a failing AC — story ${(variables.STORY_ID || 'unknown').slice(0, 8)}`,
                  body:
                    `The DEV agent disputes that the verification instrument can ` +
                    `observe the failing AC's state (idle screenshot limitation), ` +
                    `and made no code change. The fix loop stopped. Adjudicate: ` +
                    `if the contest is right, fix/rebind the AC (or Accept it in ` +
                    `QA Review); if wrong, send the story back to dev.\n\n` +
                    contestNow.trim().slice(0, 600),
                  context: { jobId, epicId: variables.EPIC_ID, storyId: variables.STORY_ID, stepId: step.id },
                  suggestedActions: [
                    { label: 'Open story', kind: 'open-story' },
                    { label: 'Open logs', kind: 'open-logs' },
                  ],
                  dedupKey: `ac-contested:${planId}:${variables.STORY_ID || 'unknown'}`,
                },
                log,
              );
            }
          } catch (attnErr) {
            log('warn', `ac-contested attention write failed (non-blocking): ${attnErr.message}`);
          }
          break;
        }

        // Re-run the gate step (the one with loopTo)
        const recheck = await executeStep(
          jobId,
          step,
          agents,
          workingDir,
          variables,
          sessions,
          stepResults,
        );

        if (recheck.allPassed) {
          loopResolved = true;
          log('info', `Loop resolved after ${iteration} iteration(s)`);
          break;
        }

        if (iteration === maxIterations - 1) {
          log('warn', `Max iterations (${maxIterations}) reached, continuing pipeline`);
        }
      }

      // dino1 (2026-06-13) — a hard gate that the fix loop could not resolve
      // must fail the job (the daemon-level story retry is the next backstop).
      // Soft gates (review = validation-driven, review-runtime = 'retry_step')
      // have no onFail.action==='fail' and intentionally continue here, as
      // before. A DEV contest also continues (already routed to the operator).
      if (!loopResolved && !loopContested && step.onFail?.action === 'fail') {
        throw new Error(
          `Gate "${step.id}" still failing after ${maxIterations} in-pipeline fix attempts`,
        );
      }
    }
  }

  // All steps complete
  const totalCost = stepResults.reduce((sum, sr) => sum + (sr.cost || 0), 0);

  // 2026-06-05 — false-DONE guard (resume-proof). Before declaring a story
  // job COMPLETED, verify a real commit for this story exists on the worktree.
  // Catches the resume-past-empty-commit path where compile-sync/compile-push
  // ran to green with no source committed → story falsely DONE → deployed
  // without the code. Only applies to story pipelines that had a dev step.
  if (isStoryPipeline && hasDevStep && !storyCommitExistsSync(workingDir, variables.STORY_ID)) {
    log(
      'error',
      `[${jobId.slice(0, 8)}] false-DONE guard TRIPPED — no commit for story ${variables.STORY_ID} on ${workingDir}; marking FAILED instead of COMPLETED`,
    );
    await pushEvent(jobId, '__commit_guard__', 'orchestrator', 'status', {
      text: `[SYSTEM] false-DONE guard: no story commit found on HEAD — job FAILED (story not delivered).`,
    });
    try {
      const planId = await resolvePlanIdFromEpicId(ddb, variables.EPIC_ID);
      if (planId) {
        await writeAttentionItem(
          ddb,
          {
            planId,
            severity: 'high',
            category: 'story-commit-empty',
            title: `Story ${variables.STORY_ID || 'unknown'} reached end with no commit`,
            body:
              `The pipeline ran to the end but no commit for this story exists on ` +
              `the worktree HEAD. Most likely a resume re-entered the compile phase ` +
              `past a failed compile-commit-on-pass (STORY_COMMIT_EMPTY). The story ` +
              `was NOT delivered; the job is marked FAILED. Re-run from QA "Send back ` +
              `to dev" (fresh DEV) rather than resuming this job.`,
            context: { jobId, epicId: variables.EPIC_ID, storyId: variables.STORY_ID },
            suggestedActions: [
              { label: 'Open logs', kind: 'open-logs' },
              { label: 'Open story', kind: 'open-story' },
            ],
            dedupKey: `story-commit-empty:${planId}:${variables.STORY_ID || 'unknown'}`,
          },
          log,
        );
      }
    } catch (attnErr) {
      log('warn', `[${jobId.slice(0, 8)}] false-DONE guard attention write failed: ${attnErr.message}`);
    }
    await updateJobFields(jobId, {
      status: 'FAILED',
      failedStepId: 'compile-commit-on-pass',
      failureReason: `false-DONE guard: no commit for story ${variables.STORY_ID} on worktree HEAD`,
      stepResults,
      variables,
      sessions,
    });
    return;
  }

  // Parse article counts if compilation succeeded
  const compilationArticleCounts =
    compilationStatus === 'success'
      ? parseArticleCounts(variables.COMPILE_RESULT || '')
      : undefined;

  await updateJobFields(jobId, {
    status: 'COMPLETED',
    totalCost,
    stepResults,
    variables,
    sessions,
    compilationStatus: compilationStatus || (hasCompileSteps ? 'skipped' : undefined),
    compilationStartedAt,
    compilationCompletedAt,
    compilationArticleCounts,
  });

  // PR-7 (I) — clear any open attention rows that were created by prior
  // failed attempts of this same story. The wave-reducer's
  // 'wave-reducer:test-gate-failed' rows + the daemon's
  // 'dev-retry-exhausted' rows both auto-resolve here.
  await autoResolveStoryAttentionOnSuccess(jobId, variables);

  // PR-22 — post-deploy writebacks. When the just-completed job was a
  // successful deploy (DEPLOY agent + DEPLOY_STATUS=success), propagate
  // state back to the parent App + Plan rows so the Apps grid can render
  // "live" and the plan dashboard's deployedAt timestamp populates.
  // Without this, deploys land at S3/CloudFront but the UI keeps showing
  // the App as "no-deploy" and Plan.deployedAt stays null. (2026-05-04
  // dino-runner-1: deploy succeeded, app live, but currentlyDeployedPlanId
  // remained null.) Fire-and-forget; never blocks the main loop.
  postDeployWriteback(job, variables).catch((err) =>
    log('warn', `[${jobId.slice(0, 8)}] post-deploy writeback threw: ${err?.message || err}`),
  );

  log(
    'info',
    `\nPipeline COMPLETED. Total cost: $${totalCost.toFixed(4)}${compilationStatus ? ` | Compilation: ${compilationStatus}` : ''}`,
  );
  log(
    'info',
    `Final variables: ${JSON.stringify(
      Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, v.slice(0, 60)])),
    )}`,
  );
}

// ── Epic-dev pipeline dispatcher (EO-4.3) ──

async function executeEpicDevJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateEpicDevJob(job);
  if (!validation.ok) {
    throw new Error(`epic-dev job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to epic-dev pipeline`, {
    epicId: job.epicId,
    stories: job.epicDevPayload?.stories?.length,
    model: job.epicDevPayload?.orchestratorModel,
  });

  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = 'epic-dev';
    entry.agentId = 'orchestrator';
    entry.model = job.epicDevPayload?.orchestratorModel || null;
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'epic-dev',
    lastHeartbeatAt: new Date().toISOString(),
  });

  const result = await runEpicDevPipeline({
    job,
    eventLogDir: EVENT_LOG_DIR,
    daemonPort: DAEMON_RECEIVER_PORT,
    claudeBin: CLAUDE_BIN,
    spawn,
    pushEvent,
    onGuardViolation: (jid, details) => handleGuardViolation(jid, details),
    logger: {
      info: (msg) => log('info', msg),
      warn: (msg) => log('warn', msg),
      error: (msg) => log('error', msg),
    },
  });

  const ok = result.exitCode === 0;
  log(ok ? 'info' : 'error', `[${short}] Orchestrator exited`, {
    code: result.exitCode,
    durationMs: result.durationMs,
  });

  await updateJobFields(jobId, {
    status: ok ? 'COMPLETED' : 'FAILED',
    errorMessage: ok ? undefined : `orchestrator exit code ${result.exitCode}`,
    orchestratorDurationMs: result.durationMs,
  });
}

// ── Party Module (Epic 15) ──

const PARTY_PROJECTS_TABLE = process.env.PARTY_PROJECTS_TABLE || 'futurator-party-projects';
const PARTY_SESSIONS_TABLE = process.env.PARTY_SESSIONS_TABLE || 'futurator-party-sessions';
// Story 18.2 — Free Claude Code Agent sessions table (created by sst.config.ts).
const FREE_AGENT_SESSIONS_TABLE =
  process.env.FREE_AGENT_SESSIONS_TABLE || 'futurator-free-agent-sessions';
// Queues module — inbound external-call rows (created by sst.config.ts). The
// daemon writes RUNNING→COMPLETED/FAILED/RESPONDED + appends audit entries.
const QUEUE_REQUESTS_TABLE = process.env.QUEUE_REQUESTS_TABLE || 'futurator-queue-requests';
// 2026-05-27 PR B.f — global agent feature flags (e.g. agent.paused).
const AGENT_FLAGS_TABLE = process.env.AGENT_FLAGS_TABLE || 'futurator-agent-flags';
// 2026-05-27 PR D.a/b — attention items + per-category remediation policies.
const ATTENTION_ITEMS_TABLE = process.env.ATTENTION_ITEMS_TABLE || 'futurator-attention-items';
const REFACTOR_AUDITS_TABLE = process.env.REFACTOR_AUDITS_TABLE || 'futurator-refactor-audits';
const REMEDIATION_POLICIES_TABLE =
  process.env.REMEDIATION_POLICIES_TABLE || 'futurator-remediation-policies';
const PARTY_PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/ubuntu/projects';
const PARTY_BMAD_VERSION = process.env.BMAD_VERSION || '6.3.0';
const PARTY_BMAD_AGENTS_SOURCE =
  process.env.BMAD_AGENTS_SOURCE || '/home/ubuntu/bmad-agents-source/bmad/agents';
const PARTY_BMAD_AGENTS_SOURCE_REPO =
  process.env.BMAD_AGENTS_SOURCE_REPO || '/home/ubuntu/bmad-agents-source';
const PARTY_EXPECTED_AGENT_COUNT = parseInt(process.env.PARTY_EXPECTED_AGENT_COUNT || '6', 10);

// Story 15.4 + Migrate-module — brownfield PAT loader.
//
// Each brownfield project carries its own AWS Secrets Manager secret
// (`futurator/brownfield-pat/<projectId>`) so different GitHub accounts
// can be used per project. Legacy migrations (the original `applicator`)
// fall back to the shared secret `futurator/labs-brownfield-github-pat`.
//
// Tokens are loaded ON DEMAND when a brownfield bootstrap or refresh
// job starts. A 60-second in-memory TTL cache keeps Secrets Manager calls
// bounded under concurrent traffic while keeping rotation-detection latency
// low (Story 19.6 — dropped from 1h to 60s per §12.4 risk 27; the binding
// rotation-detection semantic is `withPatRetry`'s force-refresh-on-auth-fail
// path below). Tokens never land in DDB rows, daemon logs, or event
// payloads — git-clone.mjs's redactor strips them.
const LEGACY_SHARED_BROWNFIELD_PAT_SECRET = 'futurator/labs-brownfield-github-pat';
const PAT_CACHE_TTL_MS = 60 * 1000; // 60 seconds (Story 19.6 — was 1h)

const secretsClient = new SecretsManagerClient({ region: REGION });

/** in-memory cache keyed by secretName → { token, expiresAt } */
const brownfieldPatCache = new Map();

/**
 * Resolve a fine-grained GitHub PAT from Secrets Manager. Caches for
 * `PAT_CACHE_TTL_MS` (60s) to bound Secrets Manager call rate.
 *
 * @param {string} [secretName] — explicit secret name. Falls back to
 *   the legacy shared secret when undefined (back-compat for the
 *   `applicator` migration that pre-dated per-project secrets).
 * @param {{ forceRefresh?: boolean }} [opts] — Story 19.6: when
 *   `forceRefresh` is true, skip the cache, re-read from Secrets
 *   Manager, and update the cache with the new value. `withPatRetry`
 *   below uses this on the second pass after a GitHub auth failure.
 * @returns {Promise<string|null>} the token, or null if Secrets Manager
 *   couldn't resolve it. Callers must handle null with a clear error
 *   (we don't throw here so the daemon can keep processing greenfield
 *   work even when a brownfield secret is misconfigured).
 */
async function loadBrownfieldPat(secretName, opts) {
  const forceRefresh = Boolean(opts && opts.forceRefresh);
  const id = secretName || LEGACY_SHARED_BROWNFIELD_PAT_SECRET;
  if (!forceRefresh) {
    const cached = brownfieldPatCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
  }
  try {
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: id }));
    const value = result?.SecretString;
    if (!value) {
      log('warn', `[brownfield-pat] secret ${id} has no SecretString`);
      return null;
    }
    // Accept both raw token strings and JSON-wrapped { token: "..." } forms.
    let token = value;
    if (value.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        token = parsed.token || parsed.pat || value;
      } catch {
        // fall back to raw value
      }
    }
    brownfieldPatCache.set(id, { token, expiresAt: Date.now() + PAT_CACHE_TTL_MS });
    log('info', `[brownfield-pat] ${forceRefresh ? 'refreshed' : 'loaded'} ${id}`);
    return token;
  } catch (err) {
    log(
      'warn',
      `[brownfield-pat] failed to load ${id}: ${err.message} — brownfield jobs using this secret will fail until resolved`,
    );
    return null;
  }
}

// Story 19.6 — `withPatRetry(secretName, operation)` is built via the
// `createPatRetry` factory in `./lib/pat-retry.mjs` so the heuristic +
// retry-once contract are unit-testable without spinning up the daemon.
// The factory closes over the real `loadBrownfieldPat` so callers get
// rotation-detection retry on the actual Secrets Manager cache.
const withPatRetry = createPatRetry({
  loadPat: loadBrownfieldPat,
  logger: { info: (msg) => log('info', msg) },
});

/**
 * Probe the legacy shared secret at startup so the daemon logs report
 * whether brownfield work is end-to-end ready. Non-fatal: per-project
 * secrets resolve on-demand later.
 */
async function probeBrownfieldPatAtStartup() {
  const ok = await loadBrownfieldPat(LEGACY_SHARED_BROWNFIELD_PAT_SECRET);
  if (ok) {
    log('info', '[brownfield-pat] startup probe: legacy shared secret reachable');
  } else {
    log(
      'info',
      '[brownfield-pat] startup probe: legacy shared secret not loaded (per-project secrets will load on-demand)',
    );
  }
}

async function updatePartyProjectState(projectId, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function partyGetSession(sessionId) {
  const result = await ddb.send(
    new GetCommand({ TableName: PARTY_SESSIONS_TABLE, Key: { sessionId } }),
  );
  return result?.Item || null;
}

/**
 * Story 20.15 — look up a PartySession by the first 8 chars of its UUID.
 * The reaper's classifier hands the path-encoded `<sessionIdShort>` to
 * this function to resolve it to a session row, then decides whether to
 * reap based on the session's status + age.
 *
 * Same shape as `findBySessionIdShort` in the Lambda's
 * `party-sessions-repository.ts` (Story 19.8): DDB `Scan` with
 * `begins_with(sessionId, :p)`, limit 5, first match wins, warn-log on
 * collisions.
 *
 * Validates the input shape (8-char lowercase hex) before scanning —
 * defense against accidental full-UUID passes (which would scan with a
 * 36-char prefix and return nothing).
 *
 * @param {string} sessionIdShort
 * @returns {Promise<object | null>}
 */
async function partyFindBySessionIdShort(sessionIdShort) {
  if (typeof sessionIdShort !== 'string' || !/^[a-f0-9]{8}$/.test(sessionIdShort)) {
    return null;
  }
  // 2026-05-27 bug fix: previously this used `Limit: 5` which the AWS SDK
  // interprets as "evaluate at most 5 items BEFORE applying the filter",
  // NOT "return at most 5 matches". With >5 sessions in the table, the
  // scan returned 0 matches for sessions outside the first 5 scanned
  // rows — and the reaper's classifier interpreted that as
  // `session-row-missing → reap`, deleting active worktrees mid-flight.
  //
  // Fix: paginate through the full table, stopping early when we've
  // collected enough matches (3 is plenty — collision check + return
  // first). Hex prefix is very selective so total matches across a
  // ~100-row table is ~1.
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: PARTY_SESSIONS_TABLE,
        FilterExpression: 'begins_with(sessionId, :p)',
        ExpressionAttributeValues: { ':p': sessionIdShort },
        ExclusiveStartKey,
      }),
    );
    if (result?.Items?.length) items.push(...result.Items);
    if (items.length >= 3) break;
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  if (items.length === 0) return null;
  if (items.length > 1) {
    log(
      'warn',
      `[party-find-by-short] '${sessionIdShort}' matched ${items.length} sessions (collision?) — returning first`,
    );
  }
  return items[0];
}

/**
 * Look up a Party project by id. Used by the party-turn pipeline to read
 * `allowedTools` so it can pass `--allowedTools` to Claude. Returns null
 * if the row is missing — caller falls back to defaults.
 */
async function partyGetProject(projectId) {
  const result = await ddb.send(
    new GetCommand({ TableName: PARTY_PROJECTS_TABLE, Key: { projectId } }),
  );
  return result?.Item || null;
}

async function partySetClaudeSessionId(sessionId, claudeSessionId) {
  // Accept rows where claudeSessionId is absent OR stored as a legacy NULL
  // value (pre-fix createSession wrote `null`, which DDB stores as a NULL
  // attribute and made `attribute_not_exists` return false). This change
  // lets the daemon capture the real Claude session ID on first-turn even
  // for older sessions.
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET claudeSessionId = :cid',
      ConditionExpression:
        'attribute_exists(sessionId) AND (attribute_not_exists(claudeSessionId) OR attribute_type(claudeSessionId, :nullType))',
      ExpressionAttributeValues: {
        ':cid': claudeSessionId,
        ':nullType': 'NULL',
      },
    }),
  );
}

async function partyIncrementTurn(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'ADD turnCount :one SET lastTurnAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    }),
  );
}

/**
 * Story 15.4 — idempotent transition to REFRESHING. The API route
 * (`POST /api/party/projects/:id/refresh`) pre-acquires the lock via
 * the SHARED `tryAcquireRefreshLock` before enqueueing the job, so by
 * the time the daemon picks up the work the row is ALREADY in
 * REFRESHING state. Treat that as "already acquired by us" rather than
 * a conflict — otherwise every API-triggered refresh fails at step 1.
 *
 * For the bypass path (operator dispatches a `party-refresh` job
 * directly without pre-acquiring), the conditional still transitions
 * HEALTHY|DRIFTED → REFRESHING the normal way.
 *
 * The strict semantics live at the API layer (returns 409
 * REFRESH_IN_PROGRESS when status is already REFRESHING) — the daemon
 * just trusts that whoever enqueued the job has the right to refresh.
 */
async function partyTryAcquireRefreshLock(projectId) {
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: PARTY_PROJECTS_TABLE,
        Key: { projectId },
        UpdateExpression: 'SET bmadStatus = :refreshing, updatedAt = :now',
        // Allow FAILED|CORRUPTED too — a party-refresh is a hard git reset, so
        // recovery is the point. Critically, this also lets the job's OWN retries
        // re-acquire the lock: attempt 1 sets REFRESHING → the git op fails →
        // releaseRefreshLock stamps FAILED → without FAILED here, attempts 2 & 3
        // die with "refresh lock not acquired: INVALID_STATE", masking the real
        // failure. Mirrors the shared tryAcquireRefreshLock (API layer).
        ConditionExpression:
          'attribute_exists(projectId) AND bmadStatus IN (:healthy, :drifted, :refreshing, :failed, :corrupted)',
        ExpressionAttributeValues: {
          ':refreshing': 'REFRESHING',
          ':now': now,
          ':healthy': 'HEALTHY',
          ':drifted': 'DRIFTED',
          ':failed': 'FAILED',
          ':corrupted': 'CORRUPTED',
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { ok: false, reason: 'INVALID_STATE' };
    }
    throw err;
  }
}

async function partyReleaseRefreshLock(projectId, next) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: 'SET bmadStatus = :next, updatedAt = :now',
      ExpressionAttributeValues: {
        ':next': next,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

async function partyUpdateProjectAfterRefresh(projectId, patch) {
  await updatePartyProjectState(projectId, {
    ...patch,
    lastInspectedAt: patch.lastPulledAt,
  });
}

async function partyReleaseSessionLock(sessionId, finalStatus) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastTurnAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': finalStatus,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

// Story 19.4 / 20.6 — persist the per-session worktree path + branch on
// first lazy-setup (party-turn.mjs V1 path). Subsequent turns see the
// fields on the session row and skip the setup.
async function partySetWorktreePath(sessionId, { worktreePath, partyBranch }) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression:
        'SET worktreePath = :wp, partyBranch = :pb, projectPath = :wp, updatedAt = :now',
      ExpressionAttributeValues: {
        ':wp': worktreePath,
        ':pb': partyBranch,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

// Story 19.4 — clear the cancel flag at turn start (defense against stale
// flags from a prior turn). cancel-poller.mjs's stop() also clears at
// close; this is the cross-turn drift safety net.
async function partyClearCancelFlag(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: PARTY_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'REMOVE cancelRequested, cancelRequestedAt SET updatedAt = :now',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
      },
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Story 18.2 — Free Claude Code Agent sessions repo facade (daemon-side).
//
// The TypeScript repository at functions/shared/repositories/free-agent-sessions-
// repository.ts is the source of truth for shape/semantics. The daemon re-
// implements the same DDB operations here because the .mjs daemon cannot
// import .ts modules directly (same pattern as partyGetSession/etc above).
// Keep the two in sync: any change to AC #7 or AC #8 contracts must land
// in BOTH files.
// ──────────────────────────────────────────────────────────────────────

async function freeAgentGetSession(sessionId) {
  const result = await ddb.send(
    new GetCommand({ TableName: FREE_AGENT_SESSIONS_TABLE, Key: { sessionId } }),
  );
  return result?.Item || null;
}

async function freeAgentAcquireProcessingLock(sessionId) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: FREE_AGENT_SESSIONS_TABLE,
        Key: { sessionId },
        UpdateExpression: 'SET #status = :processing, lastActivityAt = :now',
        ConditionExpression: 'attribute_exists(sessionId) AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'PROCESSING',
          ':active': 'ACTIVE',
          ':now': new Date().toISOString(),
        },
      }),
    );
    return { ok: true };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      const row = await freeAgentGetSession(sessionId);
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      if (row.status === 'PROCESSING') return { ok: false, reason: 'SESSION_BUSY' };
      return { ok: false, reason: 'INVALID_STATE' };
    }
    throw err;
  }
}

async function freeAgentReleaseProcessingLock(sessionId, newStatus) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastActivityAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': newStatus, ':now': new Date().toISOString() },
    }),
  );
}

async function freeAgentSetClaudeSessionId(sessionId, claudeSessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET claudeSessionId = :cid',
      ConditionExpression:
        'attribute_exists(sessionId) AND (attribute_not_exists(claudeSessionId) OR claudeSessionId = :cid)',
      ExpressionAttributeValues: { ':cid': claudeSessionId },
    }),
  );
}

async function freeAgentIncrementTurn(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET lastTurnAt = :now, lastActivityAt = :now ADD turnCount :one',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':now': new Date().toISOString(), ':one': 1 },
    }),
  );
}

async function freeAgentUpdateCostUsd(sessionId, costUsdDelta) {
  if (!Number.isFinite(costUsdDelta) || costUsdDelta <= 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'ADD costUsdAccumulated :d',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':d': costUsdDelta },
    }),
  );
}

// Story 18.3 — token accumulation. Mirrors functions/shared/repositories/
// free-agent-sessions-repository.ts:updateTokens.
async function freeAgentUpdateTokens(sessionId, tokensIn, tokensOut) {
  const safeIn = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const safeOut = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  if (safeIn === 0 && safeOut === 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'ADD tokensInAccumulated :i, tokensOutAccumulated :o',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: { ':i': safeIn, ':o': safeOut },
    }),
  );
}

async function freeAgentMarkBudgetExhausted(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, lastActivityAt = :now',
      ConditionExpression: 'attribute_exists(sessionId) AND #status IN (:p0, :p1)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': 'BUDGET_EXHAUSTED',
        ':p0': 'PROCESSING',
        ':p1': 'ACTIVE',
        ':now': new Date().toISOString(),
      },
    }),
  );
}

async function freeAgentMarkError(sessionId, reason) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'SET #status = :s, errorReason = :r, lastActivityAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': 'ERROR',
        ':r': reason,
        ':now': new Date().toISOString(),
      },
    }),
  );
}

async function freeAgentListAllSessions() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({ TableName: FREE_AGENT_SESSIONS_TABLE, ExclusiveStartKey }),
    );
    if (result.Items) out.push(...result.Items);
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * 2026-05-27 (unification) — daemon-side `findBySessionIdShort` for the
 * `_assist` worktree reaper. Same paginated Scan shape as
 * `partyFindBySessionIdShort` (2026-05-27 bug fix above); the `Limit:5` was
 * reaping active worktrees mid-flight in party — we apply the same lesson
 * here proactively.
 */
async function freeAgentFindBySessionIdShort(sessionIdShort) {
  if (typeof sessionIdShort !== 'string' || !/^[a-f0-9]{8}$/.test(sessionIdShort)) {
    return null;
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: FREE_AGENT_SESSIONS_TABLE,
        FilterExpression: 'begins_with(sessionId, :p)',
        ExpressionAttributeValues: { ':p': sessionIdShort },
        ExclusiveStartKey,
      }),
    );
    if (result?.Items?.length) items.push(...result.Items);
    if (items.length >= 3) break;
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  if (items.length === 0) return null;
  if (items.length > 1) {
    log(
      'warn',
      `[free-agent-find-by-short] '${sessionIdShort}' matched ${items.length} sessions (collision?) — returning first`,
    );
  }
  return items[0];
}

// 2026-05-27 PR B.f — cached `agent.paused` check. Daemon polls this BEFORE
// claiming a PENDING job; when true, the poll loop skips dispatch entirely
// (in-flight jobs complete normally). 5s cache balances responsiveness with
// DDB read cost: a stop-the-world pause takes effect within 5s of the
// operator's tap, with steady-state cost of one GetItem per 5s.
const PAUSED_FLAG_CACHE_MS = 5_000;
let _pausedCache = { value: false, fetchedAt: 0 };
async function isAgentPausedCached() {
  if (Date.now() - _pausedCache.fetchedAt < PAUSED_FLAG_CACHE_MS) {
    return _pausedCache.value;
  }
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: AGENT_FLAGS_TABLE,
        Key: { flagName: 'agent.paused' },
      }),
    );
    _pausedCache = { value: result?.Item?.value === 'true', fetchedAt: Date.now() };
  } catch (err) {
    // Fail-open: a DDB blip should NOT block job dispatch (would mask the
    // problem and starve the queue). Surface to logs; treat as not-paused.
    log('warn', `[paused-check] DDB read failed, treating as not-paused: ${err.message}`);
    _pausedCache = { value: false, fetchedAt: Date.now() };
  }
  return _pausedCache.value;
}

// Story E Tier 2 (2026-05-30) — global auto-merge toggle. Default OFF: when
// unset the daemon keeps the Story A operator-resolve-only halt. When
// `agent.autoMerge` is 'true', the daemon passes the agentic resolver into the
// wave-merge runner (which is still gated by the build gate + advance-on-green,
// and per-plan overridable via plan.autoMergeMode). 5s cache like agent.paused.
const AUTOMERGE_FLAG_CACHE_MS = 5_000;
let _autoMergeCache = { value: false, fetchedAt: 0 };
async function isAutoMergeEnabledCached() {
  if (Date.now() - _autoMergeCache.fetchedAt < AUTOMERGE_FLAG_CACHE_MS) {
    return _autoMergeCache.value;
  }
  try {
    const result = await ddb.send(
      new GetCommand({ TableName: AGENT_FLAGS_TABLE, Key: { flagName: 'agent.autoMerge' } }),
    );
    _autoMergeCache = { value: result?.Item?.value === 'true', fetchedAt: Date.now() };
  } catch (err) {
    // Fail-CLOSED: a DDB blip must never accidentally enable autonomous merges.
    log('warn', `[automerge-check] DDB read failed, treating as OFF: ${err.message}`);
    _autoMergeCache = { value: false, fetchedAt: Date.now() };
  }
  return _autoMergeCache.value;
}

// Queues module — runtime-settable shared concurrency cap. The operator sets it
// per daemon target (EC2 vs Local) in the EC2 Monitor; the API writes
// `concurrency.maxConcurrent.<source>` into the agent-flags table. Each poll
// tick this reader (5s cache like the pause flag) applies the value to the
// ConcurrencyManager AND updates `effectiveMaxConcurrent` (the legacy gate).
//
// Clamp policy: an *explicit* operator override bypasses the small-host default
// clamp (the operator is deliberately asking for more slots, e.g. EC2 2→3), but
// is still bounded to [1,16] and logs a warning past SMALL_HOST_MAX_CONCURRENT
// on a <3GB host. When no override is set we fall back to the boot MAX_CONCURRENT
// (which already carries the small-host default clamp).
const CAP_FLAG_CACHE_MS = 5_000;
let _capCache = { fetchedAt: 0 };
const CAP_ABSOLUTE_MAX = 16;
// Servers module (Task 18) — `dispatch.serverAware` gate, read alongside the
// cap flag every poll tick (same 5s cache). OFF (default) ⇒ legacy global-pool
// polling + unconditional RUNNING write, byte-for-byte. On a DDB blip we keep
// the last-known value: flapping to OFF mid-blip would drop a fleet daemon
// back into the global pool and race jobs assigned to other servers.
let serverAwareDispatch = false;
async function applyCapOverrideCached() {
  if (Date.now() - _capCache.fetchedAt < CAP_FLAG_CACHE_MS) return;
  _capCache = { fetchedAt: Date.now() };
  const flagName =
    DAEMON_SOURCE === 'ec2' ? 'concurrency.maxConcurrent.ec2' : 'concurrency.maxConcurrent.local';
  try {
    const [result, serverAwareResult] = await Promise.all([
      ddb.send(new GetCommand({ TableName: AGENT_FLAGS_TABLE, Key: { flagName } })),
      ddb.send(
        new GetCommand({
          TableName: AGENT_FLAGS_TABLE,
          Key: { flagName: 'dispatch.serverAware' },
        }),
      ),
    ]);
    serverAwareDispatch = serverAwareResult?.Item?.value === 'true';
    const raw = result?.Item?.value;
    let next = MAX_CONCURRENT; // default when no/invalid override
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed >= 1) {
        next = Math.min(parsed, CAP_ABSOLUTE_MAX);
        if (_isSmallHost && next > SMALL_HOST_MAX_CONCURRENT) {
          log(
            'warn',
            `[cap] operator override ${next} exceeds small-host safe cap ${SMALL_HOST_MAX_CONCURRENT} (<3GB RAM) — honoring override, watch for OOM`,
          );
        }
      }
    }
    if (next !== effectiveMaxConcurrent) {
      effectiveMaxConcurrent = next;
      concurrencyManager.setMax(next);
    }
  } catch (err) {
    // Fail-safe: keep the current effective cap on a DDB blip.
    log('warn', `[cap] flag read failed, keeping cap=${effectiveMaxConcurrent}: ${err.message}`);
  }
}

/**
 * Story E Tier 2 (2026-05-30) — agentic conflict resolver. Spawns a pinned,
 * temperature-0 Claude in the candidate worktree to INTEGRATE BOTH SIDES of
 * the conflict, edits only the conflicted files, and leaves git to the runner.
 * Returns `{ resolved, reasoning }`. The runner verifies marker-free + commits
 * with an audit trailer; the build gate is the final backstop. Unlike the
 * reverted 3fa8713 resolver this runs in the EPHEMERAL candidate worktree
 * (never the shared branch), is build-gated before green advances, and is
 * recorded as `mode:auto-resolved` in the conflict telemetry — so a wrong
 * resolution is rejected or revertible, never silently shipped.
 */
async function resolveWaveMergeConflict(args, opts = {}) {
  // snake3 (2026-06-10) — the resolver died with `claude exited 1` (empty
  // output) inside the OAuth-expired window, and that INFRASTRUCTURE failure
  // was reported as "conflict unresolved" → permanent wave halt → operator
  // escalation for a conflict the agent never even attempted. Wrap the spawn
  // in one reload-and-retry (mirrors runAgentWithAuthRecovery's pattern) and
  // tag infra failures so the runner marks the job TRANSIENT (the reducer
  // re-mints it later) instead of burning the conflict as "unresolvable".
  // Pre-spawn expiry gate (mirrors runAgentWithAuthRecovery): don't burn the
  // first attempt on a token we already KNOW is near-dead.
  if (authState.expiresAt && authState.expiresAt - Date.now() < PRESPAWN_EXPIRY_THRESHOLD_MS) {
    try {
      loadOAuth('conflict-resolver-prespawn');
      await probeAuth();
    } catch {
      /* spawn anyway — Keychain push may be in flight (see runAgent 833-837) */
    }
  }
  const first = await resolveWaveMergeConflictOnce(args, opts);
  if (first.resolved || !first.infra) return first;
  log(
    'warn',
    `[${opts.short || 'wave-merge'}] conflict-resolver infra failure (${first.reasoning}); reloading OAuth + retrying once`,
  );
  loadOAuth('conflict-resolver-recovery');
  try {
    await probeAuth();
  } catch {
    /* spawn anyway */
  }
  const second = await resolveWaveMergeConflictOnce(args, opts);
  if (!second.resolved && second.infra) {
    return { ...second, reasoning: `infra (2 attempts): ${second.reasoning}` };
  }
  return second;
}

function resolveWaveMergeConflictOnce({ worktreeDir, conflictedFiles, conflictStoryId, mergedStoryIds }, { short } = {}) {
  return new Promise((resolve) => {
    const fileList = conflictedFiles.map((f) => `  - ${f}`).join('\n');
    const mergedList = (mergedStoryIds || []).map((s) => `  - wip/${s}`).join('\n') || '  (none)';
    const prompt = [
      'You are resolving git merge conflicts from integrating PARALLEL stories',
      'into a wave branch. Multiple stories were developed independently and',
      'have collided on shared files.',
      '',
      'Conflicted files (each has `<<<<<<< HEAD`, `=======`, `>>>>>>>` markers):',
      fileList,
      '',
      'Branches already merged into HEAD:',
      mergedList,
      `Incoming branch causing the conflict: wip/${conflictStoryId}`,
      '',
      'Per-story intent is in `.context/wave-*-story-*.md` — read the relevant',
      'ones before resolving.',
      '',
      'RULES:',
      '1. INTEGRATE BOTH SIDES. Preserve all functionality, imports, and exports',
      '   from HEAD *and* the incoming branch. Never delete one side wholesale.',
      '2. For app entry / mount files where each story wired its own component,',
      '   combine them so EVERY component is imported and rendered together.',
      '3. Remove EVERY conflict marker. The result must be valid TypeScript/TSX',
      '   that compiles with `next build`.',
      '4. Only edit the conflicted files listed above. Do not touch anything else.',
      '5. Do NOT run git commands — just edit the files.',
    ].join('\n');
    const args = [
      '-p',
      prompt,
      '--model',
      process.env.WAVE_MERGE_RESOLVER_MODEL || 'claude-sonnet-4-6',
      '--permission-mode',
      'bypassPermissions',
      '--add-dir',
      worktreeDir,
    ];
    log('info', `[${short || 'wave-merge'}] spawning Tier-2 conflict-resolver for ${conflictedFiles.length} file(s)`);
    let settled = false;
    const done = (resolved, reason, infra = false) => {
      if (settled) return;
      settled = true;
      if (!resolved && reason) log('warn', `[${short || 'wave-merge'}] conflict-resolver: ${reason}`);
      resolve({ resolved, infra, reasoning: reason });
    };
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd: worktreeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      });
    } catch (err) {
      return done(false, `spawn threw: ${err.message}`, true);
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      // A hang is environment trouble, not a verdict on the conflict — retryable.
      done(false, 'timed out after 8m', true);
    }, 8 * 60 * 1000);
    let stderrTail = '';
    let stdoutTail = '';
    proc.stderr?.on('data', (c) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-1500)));
    proc.stdout?.on('data', (c) => (stdoutTail = (stdoutTail + c.toString('utf8')).slice(-2000)));
    proc.on('error', (err) => {
      clearTimeout(timer);
      done(false, `process error: ${err.message}`, true);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // Trust the runner's marker-check + build gate for correctness; here we
      // only gate on the process not erroring out.
      if (code === 0) {
        // Forensics (snake3 2026-06-10): carry the agent's own explanation of
        // HOW it integrated the sides into the conflict-event record —
        // recordConflictEvent stores `reasoning` durably in
        // futurator-wave-conflicts, making every auto-resolution auditable.
        return done(true, `agent integrated both sides. Transcript tail: ${stdoutTail.slice(-1200)}`);
      }
      // Non-zero exit with no agent output = the CLI died BEFORE doing any
      // work (expired OAuth, spawn problem, rate limit). That is an
      // infrastructure failure, not an unresolvable conflict — tag it so the
      // caller retries instead of halting the wave on a conflict no agent
      // ever attempted. (snake3 18:08: `claude exited 1:` with empty output
      // during the expired-OAuth window.)
      const infra =
        stdoutTail.trim().length === 0 ||
        /401|authentication|OAuth|credentials|overloaded|rate.?limit/i.test(stderrTail);
      done(false, `claude exited ${code}${infra ? ' (infra)' : ''}: ${(stderrTail || stdoutTail).slice(-300)}`, infra);
    });
  });
}

// pacman1 (2026-06-11) — agentic wave build-fix. Mirrors the conflict
// resolver's spawn/auth-recovery shape but targets a DIFFERENT failure:
// the merge applied cleanly, yet the union of parallel stories doesn't
// build (e.g. a story imported an interface-contract file its sibling
// owns, a type drifted between stories, a dep is missing). The agent
// repairs the MERGED tree in the candidate worktree; the runner re-runs
// the full validation gate and only advances green if it passes.
async function fixWaveMergeBuild(args, opts = {}) {
  if (authState.expiresAt && authState.expiresAt - Date.now() < PRESPAWN_EXPIRY_THRESHOLD_MS) {
    try {
      loadOAuth('build-fix-prespawn');
      await probeAuth();
    } catch {
      /* spawn anyway — Keychain push may be in flight */
    }
  }
  const first = await fixWaveMergeBuildOnce(args, opts);
  if (first.attempted || !first.infra) return first;
  log(
    'warn',
    `[${opts.short || 'wave-merge'}] build-fix infra failure (${first.reasoning}); reloading OAuth + retrying once`,
  );
  loadOAuth('build-fix-recovery');
  try {
    await probeAuth();
  } catch {
    /* spawn anyway */
  }
  return fixWaveMergeBuildOnce(args, opts);
}

function fixWaveMergeBuildOnce(
  { worktreeDir, validationCmd, validationOutput, mergedStoryIds },
  { short } = {},
) {
  return new Promise((resolve) => {
    const mergedList = (mergedStoryIds || []).map((s) => `  - wip/${s}`).join('\n') || '  (none)';
    const prompt = [
      'You are repairing a BUILD/TEST failure on a wave-merge candidate: several',
      'stories developed in PARALLEL worktrees merged cleanly at the git level,',
      'but the merged union fails the validation gate below. Each story passed',
      'this gate in isolation — the break is in the INTEGRATION (e.g. a story',
      'imports a type-contract file that only existed locally in a sibling',
      "worktree, two stories' types drifted apart, or package.json lost a",
      'dependency/script a story relied on).',
      '',
      'Branches merged into HEAD:',
      mergedList,
      '',
      `Validation command: ${validationCmd}`,
      '',
      'Validation output (tail):',
      '```',
      validationOutput || '(none captured)',
      '```',
      '',
      'Per-story intent is in `.context/wave-*-story-*.md` — read the relevant',
      'ones before changing anything.',
      '',
      'RULES:',
      '1. Make the SMALLEST change that makes the validation command pass while',
      '   preserving every story’s intended functionality. Prefer fixing an',
      '   import path to the real merged location of a symbol over creating',
      '   duplicate declaration files.',
      '2. If a type/interface is genuinely missing from the merged tree, define',
      '   it ONCE in the most natural module and point consumers at it.',
      '3. You may run the validation command yourself to iterate.',
      '4. Never weaken ASSERTIONS: do not delete or loosen what a test checks,',
      '   do not add ts-ignore/any-casts, do not change the validation command.',
      '   You MAY repair test INFRASTRUCTURE while preserving intent — e.g. a',
      '   legacy compile-time-only test file the runner rejects ("No test suite',
      '   found") may be wrapped in a real suite keeping every type-level',
      '   assertion; a test asserting a sibling story’s behavior may be updated',
      '   to the MERGED behavior when the merged code is correct per both',
      '   stories’ intents (confirm against the .context story notes).',
      '5. Do NOT run git commit/push — just fix the files; the runner commits.',
      '6. If the failure comes from an unused-code check (e.g. knip reporting',
      '   unused exports/files/dependencies), that means DEAD CODE: prefer',
      '   DELETING the unused export or file over wiring it somewhere',
      '   artificial just to silence the tool. Lint failures: fix the cited',
      '   code; never disable rules or edit lint/format configs.',
    ].join('\n');
    const args = [
      '-p',
      prompt,
      '--model',
      process.env.WAVE_BUILD_FIX_MODEL || 'claude-sonnet-4-6',
      '--permission-mode',
      'bypassPermissions',
      '--add-dir',
      worktreeDir,
    ];
    log('info', `[${short || 'wave-merge'}] spawning build-fix agent on candidate`);
    let settled = false;
    const done = (attempted, reason, infra = false) => {
      if (settled) return;
      settled = true;
      if (!attempted && reason) log('warn', `[${short || 'wave-merge'}] build-fix: ${reason}`);
      resolve({ attempted, infra, reasoning: reason });
    };
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd: worktreeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      });
    } catch (err) {
      return done(false, `spawn threw: ${err.message}`, true);
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best effort */
      }
      done(false, 'timed out after 12m', true);
    }, 12 * 60 * 1000);
    let stderrTail = '';
    let stdoutTail = '';
    proc.stderr?.on('data', (c) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-1500)));
    proc.stdout?.on('data', (c) => (stdoutTail = (stdoutTail + c.toString('utf8')).slice(-2000)));
    proc.on('error', (err) => {
      clearTimeout(timer);
      done(false, `process error: ${err.message}`, true);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        return done(true, `agent repaired merged tree. Transcript tail: ${stdoutTail.slice(-1200)}`);
      }
      const infra =
        stdoutTail.trim().length === 0 ||
        /401|authentication|OAuth|credentials|overloaded|rate.?limit/i.test(stderrTail);
      done(false, `claude exited ${code}${infra ? ' (infra)' : ''}: ${(stderrTail || stdoutTail).slice(-300)}`, infra);
    });
  });
}

// ── v2.6 M2 (2026-06-11) — generic wave-gate agent spawner ────────────────
//
// Third copy of the spawn/timeout/OAuth-recovery/infra-tagging block was
// about to appear (conflict-resolver, build-fix, now four VQA roles), so the
// pattern is extracted ONCE. Role params:
//
//   evidence — haiku, 12m, bypassPermissions (needs Bash for playwright);
//              the VQA runner enforces read-only post-hoc via git status.
//   judge    — haiku, 3m, Read-only tools (mirrors review-runtime's judge).
//   triage   — sonnet, 5m, read tools (Read/Grep/Glob) — propose-only.
//   fixer    — sonnet, 12m, bypassPermissions; round 2 escalates the model
//              tier (invariant I6's escalation ladder).
//
// Returns { ok, output, infra, reason }. `infra` mirrors the build-fix
// heuristic (empty stdout / auth / rate-limit) so the reducer's transient
// re-mint logic applies to gate-agent deaths.
const GATE_AGENT_ROLES = {
  evidence: () => ({
    model: process.env.WAVE_VQA_EVIDENCE_MODEL || 'haiku',
    timeoutMs: 12 * 60 * 1000,
    bypass: true,
  }),
  judge: () => ({
    model: process.env.WAVE_VQA_JUDGE_MODEL || 'haiku',
    timeoutMs: 3 * 60 * 1000,
    allowedTools: 'Read',
  }),
  triage: () => ({
    model: process.env.WAVE_VQA_TRIAGE_MODEL || 'claude-sonnet-4-6',
    timeoutMs: 5 * 60 * 1000,
    allowedTools: 'Read,Grep,Glob',
  }),
  fixer: (round = 1) => ({
    model:
      round > 1
        ? process.env.WAVE_VQA_FIXER_ESCALATION_MODEL || 'claude-opus-4-8'
        : process.env.WAVE_VQA_FIXER_MODEL || 'claude-sonnet-4-6',
    timeoutMs: 12 * 60 * 1000,
    bypass: true,
  }),
  // R1 (2026-06-12) — the REFLECTOR brain. Read-only by design: it may
  // inspect the repo (CLAUDE.md, sources named in the evidence) but only
  // PROPOSES — application happens through the operator's inbox confirm.
  reflector: () => ({
    model: process.env.REFLECTOR_MODEL || 'claude-sonnet-4-6',
    timeoutMs: 8 * 60 * 1000,
    allowedTools: 'Read,Grep,Glob',
  }),
  // Plan Retrospect — The Assessor: read-only, grades [LLM] criteria.
  assessor: () => ({
    model: process.env.ASSESSOR_MODEL || 'claude-sonnet-4-6',
    timeoutMs: 8 * 60 * 1000,
    allowedTools: 'Read,Grep,Glob',
  }),
};

// Scan-engine swarm roles are dynamic strings not present in GATE_AGENT_ROLES:
//   'scan-analyzer:<name>', 'scan-xcut:<area>', 'scan-report-writer'.
// They resolve to a dedicated cfg (model upgrade + read-tool set) below.
const isScanRole = (role) =>
  !!role &&
  (role.startsWith('scan-analyzer') || role.startsWith('scan-xcut') || role === 'scan-report-writer');
// One-time note: the Mycelium graph MCP serves a FIXED global Memgraph
// (bolt://localhost:7687 in lib/mcp-config.mjs), NOT a per-scan-repo
// cwd/graphify-out graph — so wiring it into scan agents would point them at the
// wrong graph. We do the model upgrade only. (Logged once at first scan spawn.)
let _scanMcpNoteLogged = false;

async function spawnGateAgent({ role, prompt, cwd, round, jobId }, { short } = {}) {
  if (authState.expiresAt && authState.expiresAt - Date.now() < PRESPAWN_EXPIRY_THRESHOLD_MS) {
    try {
      loadOAuth(`gate-${role}-prespawn`);
      await probeAuth();
    } catch {
      /* spawn anyway — Keychain push may be in flight */
    }
  }
  const first = await spawnGateAgentOnce({ role, prompt, cwd, round, jobId }, { short });
  if (first.ok || !first.infra) return first;
  log(
    'warn',
    `[${short || 'wave-vqa'}] gate ${role} infra failure (${first.reason}); reloading OAuth + retrying once`,
  );
  loadOAuth(`gate-${role}-recovery`);
  try {
    await probeAuth();
  } catch {
    /* spawn anyway */
  }
  return spawnGateAgentOnce({ role, prompt, cwd, round, jobId }, { short });
}

function spawnGateAgentOnce({ role, prompt, cwd, round, jobId }, { short } = {}) {
  return new Promise((resolve) => {
    const scan = isScanRole(role);
    // Scan swarm cfg: bigger model than the haiku 'judge' fallback + a read-tool
    // set so analyzers can Grep/Glob the repo. No --mcp-config (see note above).
    const cfg = scan
      ? {
          model: process.env.SCAN_SWARM_MODEL || 'claude-sonnet-4-6',
          timeoutMs: 8 * 60 * 1000,
          allowedTools: 'Read,Grep,Glob',
        }
      : (GATE_AGENT_ROLES[role] || GATE_AGENT_ROLES.judge)(round);
    if (scan && !_scanMcpNoteLogged) {
      _scanMcpNoteLogged = true;
      log('info', '[scan] graph MCP not per-repo — model-upgrade only');
    }
    const args = ['-p', prompt, '--model', cfg.model];
    // Scan roles capture per-agent tokens/cost via the CLI's JSON envelope.
    if (scan) args.push('--output-format', 'json');
    if (cfg.bypass) args.push('--permission-mode', 'bypassPermissions', '--add-dir', cwd);
    else args.push('--allowedTools', cfg.allowedTools);
    // Scan roles report usage; non-scan roles keep the legacy shape untouched.
    const scanUsage = scan ? { tokens: null, costUsd: null } : undefined;
    let settled = false;
    const done = (ok, output, reason, infra = false, usage = scanUsage) => {
      if (settled) return;
      settled = true;
      if (!ok && reason) log('warn', `[${short || 'wave-vqa'}] gate ${role}: ${reason}`);
      const res = { ok, output, infra, reason };
      if (usage !== undefined) res.usage = usage;
      resolve(res);
    };
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      });
    } catch (err) {
      return done(false, '', `spawn threw: ${err.message}`, true);
    }
    // Make scan agents killable by the abort poller (signalChildrenForJob).
    if (jobId) registerChild(jobId, proc);
    const timer = setTimeout(
      () => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* best effort */
        }
        if (jobId) unregisterChild(jobId, proc);
        done(false, '', `timed out after ${Math.round(cfg.timeoutMs / 60000)}m`, true);
      },
      cfg.timeoutMs,
    );
    let stdoutBuf = '';
    let stderrTail = '';
    proc.stdout?.on('data', (c) => {
      // Full stdout (fenced JSON lives here) — capped at 400KB.
      stdoutBuf = (stdoutBuf + c.toString('utf8')).slice(-400_000);
    });
    proc.stderr?.on('data', (c) => (stderrTail = (stderrTail + c.toString('utf8')).slice(-1500)));
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (jobId) unregisterChild(jobId, proc);
      done(false, '', `process error: ${err.message}`, true);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (jobId) unregisterChild(jobId, proc);
      // Scan roles: parse the --output-format json envelope for output + usage.
      // Defensive — a parse failure falls back to raw stdout with null usage.
      if (scan) {
        let output = stdoutBuf;
        let usage = { tokens: null, costUsd: null };
        try {
          const parsed = JSON.parse(stdoutBuf);
          if (typeof parsed.result === 'string') output = parsed.result;
          const u = parsed.usage || {};
          const summed = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
          const tokens = summed > 0 ? summed : Number(u.total_tokens) || null;
          usage = { tokens, costUsd: parsed.total_cost_usd ?? null };
        } catch {
          /* non-JSON stdout — keep raw output, usage stays null */
        }
        if (code === 0) return done(true, output, undefined, false, usage);
        const infra =
          stdoutBuf.trim().length === 0 ||
          /401|authentication|OAuth|credentials|overloaded|rate.?limit/i.test(stderrTail);
        return done(
          false,
          output,
          `claude exited ${code}${infra ? ' (infra)' : ''}: ${(stderrTail || stdoutBuf).slice(-300)}`,
          infra,
          usage,
        );
      }
      if (code === 0) return done(true, stdoutBuf);
      const infra =
        stdoutBuf.trim().length === 0 ||
        /401|authentication|OAuth|credentials|overloaded|rate.?limit/i.test(stderrTail);
      done(
        false,
        stdoutBuf,
        `claude exited ${code}${infra ? ' (infra)' : ''}: ${(stderrTail || stdoutBuf).slice(-300)}`,
        infra,
      );
    });
  });
}

// 2026-05-27 PR D.b — attention-poller helpers.
//
// scanOpenAttentionItems: full-table scan filtered on status='open' AND
//   missing agentSessionId. The attention-items table is bounded by the
//   plan TTLs upstream (a stuck plan never produces unbounded items per
//   the PR-7 dedupKey pattern), so a paginated Scan is acceptable v1.
//
// getRemediationPolicy: GetItem on the per-category policies table.
//   Absent rows resolve to 'manual' (the safe default — never spawn
//   without an explicit operator opt-in).
//
// claimAttentionItemForAgent: conditional UpdateItem (succeeds only when
//   `agentSessionId` is absent). Idempotent under concurrent ticks.
//
// enqueueFreeAgentSessionFromAttention: writes the free-agent row to
//   the sessions table + a PENDING agent-job row that the daemon's
//   own poll loop picks up. Mirrors the operator-driven flow but
//   bypasses STS credentials (the daemon-bot identity uses the daemon's
//   own EC2 instance role for AWS access; the agent's IAM scoping is
//   the load-bearing security boundary as before).
async function scanOpenAttentionItems() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: ATTENTION_ITEMS_TABLE,
        FilterExpression: '#st = :open AND attribute_not_exists(agentSessionId)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':open': 'open' },
        ExclusiveStartKey,
      }),
    );
    if (result?.Items?.length) items.push(...result.Items);
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getRemediationPolicy(category) {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: REMEDIATION_POLICIES_TABLE,
        Key: { category },
      }),
    );
    return result?.Item?.policy ?? 'manual';
  } catch (err) {
    log('warn', `[attention-poller] policy lookup failed for ${category}: ${err.message}`);
    return 'manual';
  }
}

async function claimAttentionItemForAgent({ planId, itemId, sessionId }) {
  const nowIso = new Date().toISOString();
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: ATTENTION_ITEMS_TABLE,
        Key: { planId, itemId },
        UpdateExpression: 'SET agentSessionId = :sid, agentClaimedAt = :now',
        ConditionExpression:
          'attribute_exists(itemId) AND attribute_not_exists(agentSessionId)',
        ExpressionAttributeValues: { ':sid': sessionId, ':now': nowIso },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return result.Attributes ?? null;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    log('warn', `[attention-poller] claim failed for ${itemId}: ${err.message}`);
    return null;
  }
}

async function enqueueFreeAgentSessionFromAttention({ sessionId, item, autoFix }) {
  const nowIso = new Date().toISOString();
  const ninetyDaySec = 90 * 24 * 60 * 60;
  const projectId =
    (item.context && (item.context.projectId || item.context.appId)) ||
    item.planId ||
    '_attention';

  // Write the free-agent session row first (mirrors POST /api/free-agent/sessions).
  // Skipping STS credentials: the daemon-bot sessions run with the EC2 instance
  // role's broader access; the load-bearing safety is still the PreToolUse hook
  // path-confinement + danger-list classification.
  await ddb.send(
    new PutCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Item: {
        sessionId,
        operatorId: '__daemon-bot__',
        projectId,
        scope: { kind: 'attention', id: item.itemId },
        scopeIdComposite: `attention#${item.itemId}`,
        status: 'ACTIVE',
        model: process.env.FREE_AGENT_BOT_MODEL || 'claude-sonnet-4-6',
        costCapUsd: parseFloat(process.env.FREE_AGENT_BOT_COST_CAP_USD || '5') || 5,
        costUsdAccumulated: 0,
        turnCount: 0,
        createdAt: nowIso,
        lastActivityAt: nowIso,
        expiresAt: Math.floor(Date.now() / 1000) + ninetyDaySec,
        // Mark the session as agent-spawned so downstream auto-fix logic
        // can find it. Per §7.4.b: auto-fix sessions auto-merge themselves
        // on green class — v1 ships the metadata; the auto-merge trigger is
        // a v1.1 follow-up.
        attentionItemRef: { planId: item.planId, itemId: item.itemId },
        autoFix,
      },
    }),
  );

  // Now enqueue the PENDING agent-job for the daemon's own poll loop.
  const jobId = randomUUID();
  const primer = composeAttentionPromptBody(item);
  await ddb.send(
    new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        jobId,
        status: 'PENDING',
        jobType: 'free-agent-session',
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: '__daemon-bot__',
        workingDir: '',
        freeAgentSessionPayload: {
          sessionId,
          projectId,
          model: process.env.FREE_AGENT_BOT_MODEL || 'claude-sonnet-4-6',
          costCapUsd: parseFloat(process.env.FREE_AGENT_BOT_COST_CAP_USD || '5') || 5,
          // Credentials: the daemon-bot's STS credentials are derived
          // inside free-agent-session.mjs from the EC2 instance role —
          // not minted via the FreeAgentSessionRole assume-role path that
          // the API uses. Use the operator's STS-equivalent placeholder
          // shape so the handler's signature stays uniform; the IAM role
          // attached to the EC2 instance is what actually authorizes.
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
            sessionToken: process.env.AWS_SESSION_TOKEN || '',
          },
          messages: [{ role: 'user', content: primer }],
          scope: { kind: 'attention', id: item.itemId },
          operatorId: '__daemon-bot__',
        },
      },
    }),
  );
}

async function freeAgentClearCancelFlag(sessionId) {
  await ddb.send(
    new UpdateCommand({
      TableName: FREE_AGENT_SESSIONS_TABLE,
      Key: { sessionId },
      UpdateExpression: 'REMOVE cancelRequested, cancelRequestedAt',
      ConditionExpression: 'attribute_exists(sessionId)',
    }),
  );
}

function buildFreeAgentSessionsRepoFacade() {
  return {
    getSession: freeAgentGetSession,
    acquireProcessingLock: freeAgentAcquireProcessingLock,
    releaseProcessingLock: freeAgentReleaseProcessingLock,
    setClaudeSessionId: freeAgentSetClaudeSessionId,
    incrementTurn: freeAgentIncrementTurn,
    updateCostUsd: freeAgentUpdateCostUsd,
    updateTokens: freeAgentUpdateTokens,
    markBudgetExhausted: freeAgentMarkBudgetExhausted,
    markError: freeAgentMarkError,
    clearCancelFlag: freeAgentClearCancelFlag,
    listAllSessions: freeAgentListAllSessions,
  };
}

function buildPartyCtx() {
  return {
    pushEvent,
    updateProjectState: updatePartyProjectState,
    expectedBmadVersion: PARTY_BMAD_VERSION,
    customAgentsSourceDir: PARTY_BMAD_AGENTS_SOURCE,
    customAgentsSourceRepo: PARTY_BMAD_AGENTS_SOURCE_REPO,
    expectedAgentCount: PARTY_EXPECTED_AGENT_COUNT,
    projectsRoot: PARTY_PROJECTS_ROOT,
    // Story 15.4 + Migrate-module — brownfield wiring.
    // Pipelines call `loadBrownfieldPat(secretName)` lazily with the
    // per-project secret name from the job payload. Falls back to the
    // shared secret when no name is provided (legacy `applicator`).
    // Story 19.6: `withPatRetry` wraps PAT-using operations with
    // rotation-detection retry (force-refresh on GitHub auth failure,
    // retry once). Pipeline-v2's compile-push uses this; party-push's
    // checkpoint script (Story 20.2) wires it too, dormant until Epic 21.
    loadBrownfieldPat,
    withPatRetry,
    tryAcquireRefreshLock: partyTryAcquireRefreshLock,
    releaseRefreshLock: partyReleaseRefreshLock,
    updateProjectAfterRefresh: partyUpdateProjectAfterRefresh,
  };
}

async function executePartyBootstrapJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyBootstrapJob(job);
  if (!validation.ok) {
    throw new Error(`party-bootstrap job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-bootstrap pipeline`, {
    projectId: job.partyBootstrapPayload?.projectId,
    projectPath: job.partyBootstrapPayload?.projectPath,
    forceReinstall: job.partyBootstrapPayload?.forceReinstall === true,
  });

  const entry = activeJobs.get(jobId);
  if (entry) {
    entry.stepId = 'party-bootstrap';
    entry.agentId = '__party__';
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-bootstrap',
    lastHeartbeatAt: new Date().toISOString(),
  });

  await runPartyBootstrap(job, buildPartyCtx());

  await updateJobFields(jobId, { status: 'COMPLETED' });
  log('info', `[${short}] party-bootstrap completed`);
}

/**
 * Story 15.4 — brownfield refresh job dispatch.
 */
async function executePartyRefreshJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyRefreshJob(job);
  if (!validation.ok) {
    throw new Error(`party-refresh job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-refresh pipeline`, {
    projectId: job.partyRefreshPayload?.projectId,
    gitBranch: job.partyRefreshPayload?.gitBranch,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-refresh',
    lastHeartbeatAt: new Date().toISOString(),
  });

  await runPartyRefresh(job, buildPartyCtx());

  await updateJobFields(jobId, { status: 'COMPLETED' });
  log('info', `[${short}] party-refresh completed`);
}

async function executePartyInspectJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyInspectJob(job);
  if (!validation.ok) {
    throw new Error(`party-inspect job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-inspect pipeline`, {
    projectId: job.partyInspectPayload?.projectId,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-inspect',
    lastHeartbeatAt: new Date().toISOString(),
  });

  await runPartyInspect(job, buildPartyCtx());

  await updateJobFields(jobId, { status: 'COMPLETED' });
  log('info', `[${short}] party-inspect completed`);
}

async function executePartyTurnJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validatePartyTurnJob(job);
  if (!validation.ok) {
    throw new Error(`party-turn job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to party-turn pipeline`, {
    sessionId: job.partyTurnPayload?.sessionId,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-turn',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    await runPartyTurn(job, {
      pushEvent,
      getSession: partyGetSession,
      getProject: partyGetProject,
      setClaudeSessionId: partySetClaudeSessionId,
      incrementTurn: partyIncrementTurn,
      releaseSessionLock: partyReleaseSessionLock,
      // Opt-in auto-PR (project.autoOpenPr) resolves the per-project PAT via
      // this loader after a successful checkpoint push.
      loadPat: loadBrownfieldPat,
      // Story 20.6/19.4 facade — surfaces the daemon's DDB helpers as a
      // minimal sessionsRepo so party-turn V1 can lazy-create worktrees,
      // clear stale cancel flags, and (via cancel-poller) poll the cancel
      // flag mid-turn. Each method is optional in party-turn (presence
      // gates the behavior) so older daemons without these stay functional.
      sessionsRepo: {
        getSession: partyGetSession,
        setWorktreePath: partySetWorktreePath,
        clearCancelFlag: partyClearCancelFlag,
      },
      claudeBin: CLAUDE_BIN,
      spawn,
      // ANTHROPIC_API_KEY is set on process.env by loadApiKeyFromSsm; the
      // spawned child inherits it via the default env-inheritance path.
      env: {},
      logger: {
        info: (msg) => log('info', msg),
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
      },
    });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-turn completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-turn failed: ${err?.message || err}`);
    throw err;
  }
}

async function executePartyDocsSyncJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const validation = validatePartyDocsSyncJob(job);
  if (!validation.ok) {
    throw new Error(`party-docs-sync job rejected: ${validation.reason}`);
  }
  log('info', `[${short}] Routing to party-docs-sync pipeline`, {
    projectId: job.partyDocsSyncPayload?.projectId,
    filename: job.partyDocsSyncPayload?.filename,
  });
  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-docs-sync',
    lastHeartbeatAt: new Date().toISOString(),
  });
  try {
    await runPartyDocsSync(job, { pushEvent });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-docs-sync completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-docs-sync failed: ${err?.message || err}`);
    throw err;
  }
}

async function executePartyDocsUnlinkJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const validation = validatePartyDocsUnlinkJob(job);
  if (!validation.ok) {
    throw new Error(`party-docs-unlink job rejected: ${validation.reason}`);
  }
  log('info', `[${short}] Routing to party-docs-unlink pipeline`, {
    projectId: job.partyDocsUnlinkPayload?.projectId,
    filename: job.partyDocsUnlinkPayload?.filename,
  });
  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'party-docs-unlink',
    lastHeartbeatAt: new Date().toISOString(),
  });
  try {
    await runPartyDocsUnlink(job, { pushEvent });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] party-docs-unlink completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] party-docs-unlink failed: ${err?.message || err}`);
    throw err;
  }
}

/**
 * PR-22 — post-deploy writebacks.
 *
 * Detects when the just-completed job was a successful deploy and updates
 * the App + Plan rows so the UI can render "live" status.
 *
 * Detection signal: `variables.DEPLOY_STATUS === 'success'` AND
 * `variables.DEPLOY_URL` populated. Both are set by the DEPLOY agent's
 * pipeline (functions/api/index.ts /api/epic-workflows/:id/deploy).
 *
 * Resolution chain (best-effort, never throws):
 *   job.epicId → epic row → epic.planId → plan row → plan.appId → app row
 *
 * Writes:
 *   • App.currentlyDeployedPlanId = planId
 *   • App.deployJobIds — append jobId (deduped)
 *   • Plan.deployedAt = now
 *   • Plan.deployUrl = DEPLOY_URL (for the deploy panel)
 *
 * Skipped silently when:
 *   • DEPLOY_STATUS not 'success' (or missing)
 *   • epic / plan / app row can't be resolved
 *   • App row missing (orchestrator-mode legacy plans without an App)
 */
async function postDeployWriteback(job, variables) {
  if (!variables || variables.DEPLOY_STATUS !== 'success') return;

  const short = job.jobId.slice(0, 8);
  // QA-Review W1 — resolve the plan. P3 deploy jobs carry `planId` directly
  // (no epic); legacy deploy jobs carry `epicId` and we hop epic→planId. Prefer
  // the direct planId when present so P3 dev-deploys record their preview URL.
  let planId = job.planId || null;
  if (!planId) {
    if (!job?.epicId) return;
    let epic;
    try {
      const er = await ddb.send(
        new GetCommand({ TableName: EPICS_TABLE, Key: { epicId: job.epicId } }),
      );
      epic = er.Item;
    } catch (err) {
      log('warn', `[${short}] post-deploy: epic read failed: ${err.message}`);
      return;
    }
    if (!epic?.planId) return;
    planId = epic.planId;
  }

  let plan;
  try {
    const pr = await ddb.send(
      new GetCommand({ TableName: PLANS_TABLE, Key: { planId } }),
    );
    plan = pr.Item;
  } catch (err) {
    log('warn', `[${short}] post-deploy: plan read failed: ${err.message}`);
    return;
  }
  if (!plan) return;

  const now = new Date().toISOString();
  const deployUrl = variables.DEPLOY_URL || undefined;
  // Deployment v2.5 — environment discriminator. Absent on legacy deploy jobs
  // (treated as `production` for back-compat). Only a production deploy is a
  // delivery event that advances `main`.
  const deployEnv = job.deployEnvironment || 'production';

  // Preview deploys (dev/staging) NEVER advance main and never mark the plan
  // delivered. They only record a clickable preview URL on the plan so the QA
  // stage can surface "Open in dev". Skip the App writeback + merge-to-main.
  if (deployEnv !== 'production') {
    if (!deployUrl) return;
    const field = deployEnv === 'staging' ? 'stagingUrl' : 'devUrl';
    // QA-Review W2 — on a DEV deploy, ALSO stamp the frozen commit the artifact
    // built from (the deploy agent's COMMIT_SHA) so QA pins to it and Approve
    // promotes exactly it. Shadow-safe: only stamp when the SHA is a valid
    // 40-hex AND the plan has no human QA decision yet (never re-pin under a
    // decided verdict). Absent/invalid SHA → devUrl still recorded (fail-open).
    //
    // BUG FIX (2026-07-06, pacman4 forensic): this used to read
    // `job.variables?.COMMIT_SHA` — the ORIGINAL job snapshot captured before
    // the pipeline ran (no variables yet extracted) — instead of the
    // `variables` PARAMETER this function receives, which holds the actual
    // extracted COMMIT_SHA. Silent no-op: qaCommitSha was NEVER stamped for ANY
    // plan since this feature shipped, so the cron's p3-qa auto-enqueue (which
    // requires plan.qaCommitSha) never fired — the real deployed-app QA
    // (journeys+VQA+wiring) never ran, full stop, for every P3 plan. The
    // fallback per-story testBinding QA tab (which only verifies isolated unit
    // tests, never the assembled app) was the only thing anyone ever saw —
    // exactly why an app can show "32/32 AC passing" while Pacman doesn't move.
    // Extracted to a pure, unit-tested module (qa-commit-sha.mjs) — this file
    // has zero test coverage, which is exactly how the bug shipped unnoticed.
    const stampSha = resolveStampableCommitSha({ deployEnv, variables });
    // P3_QA_REVIEW honest-gate (Slice B): a fresh DEV deploy re-pins the build
    // (new qaCommitSha), so any prior automated QA pass is now stale — REMOVE
    // qaVerifiedAt so the plan is NOT deliverable until the deployed-app QA
    // re-verifies this new SHA. Staging deploys happen AFTER approval and leave
    // qaVerifiedAt alone.
    const clearVerified = field === 'devUrl';
    try {
      const setExpr = stampSha
        ? `SET ${field} = :url, qaCommitSha = :sha, updatedAt = :now`
        : `SET ${field} = :url, updatedAt = :now`;
      const expr = clearVerified ? `${setExpr} REMOVE qaVerifiedAt` : setExpr;
      const vals = stampSha
        ? { ':url': deployUrl, ':sha': stampSha, ':now': now }
        : { ':url': deployUrl, ':now': now };
      await ddb.send(
        new UpdateCommand({
          TableName: PLANS_TABLE,
          Key: { planId: plan.planId },
          UpdateExpression: expr,
          ExpressionAttributeValues: vals,
          // Never re-pin the QA commit under an existing human decision.
          ConditionExpression: stampSha
            ? 'attribute_exists(planId) AND attribute_not_exists(p3QaVerdict.decidedAt)'
            : 'attribute_exists(planId)',
        }),
      );
      log('info', `[${short}] post-deploy: ${deployEnv} preview recorded — ${deployUrl}${stampSha ? ` @ ${stampSha.slice(0, 7)}` : ''}`);
    } catch (err) {
      // A conditional-check failure here means a human already decided — record
      // just the URL without the SHA re-pin (never lose the preview link).
      if (err.name === 'ConditionalCheckFailedException' && stampSha) {
        try {
          await ddb.send(new UpdateCommand({
            TableName: PLANS_TABLE, Key: { planId: plan.planId },
            UpdateExpression: clearVerified
              ? `SET ${field} = :url, updatedAt = :now REMOVE qaVerifiedAt`
              : `SET ${field} = :url, updatedAt = :now`,
            ExpressionAttributeValues: { ':url': deployUrl, ':now': now },
            ConditionExpression: 'attribute_exists(planId)',
          }));
        } catch { /* best-effort */ }
      } else {
        log('warn', `[${short}] post-deploy: ${deployEnv} preview write failed: ${err.message}`);
      }
    }
    return;
  }

  // Update Plan row: deployedAt + deployUrl. Always issue this; legacy plans
  // without appId still benefit from the timestamp.
  try {
    const planUpdate = ['deployedAt = :now', 'updatedAt = :now'];
    const planValues = { ':now': now };
    if (deployUrl) {
      planUpdate.push('deployUrl = :url');
      planValues[':url'] = deployUrl;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: PLANS_TABLE,
        Key: { planId: plan.planId },
        UpdateExpression: `SET ${planUpdate.join(', ')}`,
        ExpressionAttributeValues: planValues,
        ConditionExpression: 'attribute_exists(planId)',
      }),
    );
  } catch (err) {
    log('warn', `[${short}] post-deploy: plan update failed: ${err.message}`);
  }

  // Update App row: currentlyDeployedPlanId + deployJobIds append.
  // Skip when plan has no appId (legacy non-App-scoped plan — nothing to update).
  if (!plan.appId) {
    log(
      'info',
      `[${short}] post-deploy: plan ${plan.planId} has no appId — App writeback skipped (legacy plan)`,
    );
    return;
  }
  try {
    // Read existing deployJobIds to dedupe before append.
    const ar = await ddb.send(
      new GetCommand({ TableName: APPS_TABLE, Key: { appId: plan.appId } }),
    );
    const app = ar.Item;
    if (!app) {
      log('warn', `[${short}] post-deploy: App ${plan.appId} not found — App writeback skipped`);
      return;
    }
    const existing = Array.isArray(app.deployJobIds) ? app.deployJobIds : [];
    const nextIds = existing.includes(job.jobId) ? existing : [...existing, job.jobId];
    await ddb.send(
      new UpdateCommand({
        TableName: APPS_TABLE,
        Key: { appId: plan.appId },
        UpdateExpression:
          'SET currentlyDeployedPlanId = :planId, deployJobIds = :jobs, updatedAt = :now',
        ExpressionAttributeValues: {
          ':planId': plan.planId,
          ':jobs': nextIds,
          ':now': now,
        },
        ConditionExpression: 'attribute_exists(appId)',
      }),
    );
    log(
      'info',
      `[${short}] post-deploy: writeback OK — app=${plan.appId} plan=${plan.planId} jobs=${nextIds.length}`,
    );
  } catch (err) {
    log('warn', `[${short}] post-deploy: App update failed: ${err.message}`);
  }

  // Deployment v2.5 — ROLLBACK jobs restore prior production hosting and must
  // NOT advance the trunk (main already has that release or later code). Skip
  // the merge-to-main entirely for them; the Plan/App deployUrl writeback above
  // still runs so the UI reflects the rolled-back live state.
  if (job.skipTrunkAdvance) {
    log('info', `[${short}] post-deploy: rollback — skipping main advance`);
    return;
  }

  // ── Merge to main on delivery (2026-06-01) ──
  // A successful deploy is the delivery event. Fast-forward the app's `main`
  // to the just-shipped `plan/<slug>` tip so: (1) the trunk reflects the live
  // state, and (2) the NEXT plan forks brownfield off it — story-worktree's
  // resolveParentRef falls back to `main` when the new plan branch doesn't
  // exist yet. `main`'s only worktree is `projects/<appId>` (detached during
  // QA/deploy), so this is the canonical place for the advance. We use
  // `merge --ff-only` — never a force/reset — so if `main` ever diverged from
  // the plan branch we WARN for manual reconcile rather than silently drop
  // commits. In the sequential single-operator model the plan always
  // descends from `main`, so the fast-forward is the normal case.
  try {
    const { bareRepoPath, LEGACY_PROJECTS_ROOT } = await import('./lib/story-worktree.mjs');
    const bare = bareRepoPath(plan.appId);
    const proj = `${LEGACY_PROJECTS_ROOT}/${plan.appId}`;
    // Branch-name unification: legacy plans branch as plan/<plan.name>; P3
    // (quick-flow) plans branch as plan/<planId>. Try both — first that exists
    // wins — so a production promote merges main for EITHER lineage.
    let planBranch = null;
    for (const candidate of [`plan/${plan.name}`, `plan/${plan.planId}`]) {
      const has = await daemonGit(
        ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`],
        proj,
      );
      if (has.code === 0) {
        planBranch = candidate;
        break;
      }
    }
    const hasPlanBranch = { code: planBranch ? 0 : 1 };
    if (hasPlanBranch.code === 0) {
      await daemonGit(['checkout', '-f', 'main'], proj);
      const ff = await daemonGit(['merge', '--ff-only', planBranch], proj);
      if (ff.code === 0) {
        log(
          'info',
          `[${short}] post-deploy: merged to main — main now at ${planBranch} tip; next plan forks brownfield`,
        );
        // Push the advanced main to origin so GitHub mirrors the delivered
        // state AND the next plan-create's clean-check (which resolves the
        // remote main via ls-remote) sees local==remote. Without this the
        // trunk would be perpetually "ahead-of-origin" after every delivery.
        const push = await daemonGit(['push', 'origin', 'main'], proj);
        if (push.code === 0) {
          log('info', `[${short}] post-deploy: pushed main to origin`);
        } else {
          log(
            'warn',
            `[${short}] post-deploy: push main to origin failed (non-blocking): ${push.stderr.trim()}`,
          );
        }
        // Delete the now-redundant plan branch (fully merged into main via the
        // FF above). `branch -d` is the SAFE delete — it refuses if the branch
        // isn't merged, so we never lose unmerged work. This keeps the bare
        // repo clean so the next plan-create's stale-`plan/*`-branch preflight
        // passes without requiring ?force=1.
        const del = await daemonGit(['--git-dir', bare, 'branch', '-d', planBranch], proj);
        if (del.code === 0) {
          log('info', `[${short}] post-deploy: deleted merged plan branch ${planBranch}`);
        } else {
          log(
            'warn',
            `[${short}] post-deploy: could not delete ${planBranch} (non-blocking): ${del.stderr.trim()}`,
          );
        }
        // Leave the trunk worktree pristine: discard transient untracked
        // artifacts (visual-tests-draft.md, BMAD scratch dirs, build leftovers)
        // so the NEXT plan-create's dirty-worktree preflight passes. `-fd`
        // keeps .gitignored paths (node_modules, out, .next); we never use -x.
        await daemonGit(['clean', '-fd'], proj);
      } else {
        log(
          'warn',
          `[${short}] post-deploy: main fast-forward to ${planBranch} declined (divergence?) — ` +
            `manual reconcile may be needed: ${ff.stderr.trim() || ff.stdout.trim()}`,
        );
      }
    }
  } catch (err) {
    log('warn', `[${short}] post-deploy: merge-to-main failed (non-blocking): ${err.message}`);
  }
}

// Pipeline v2 / Story 1.4.3 — App-bootstrap saga executor.
//
// Reads + writes the futurator-apps row directly via the daemon's `ddb` client
// (the daemon doesn't import the TS repository module). Re-uses the party
// context for the BMAD step and the shared attention-writer for failure
// surfacing.
async function getAppRow(appId) {
  const result = await ddb.send(new GetCommand({ TableName: APPS_TABLE, Key: { appId } }));
  return result.Item || null;
}

// Story E Tier 2 (2026-05-30) — read a plan row for its `autoMergeMode`
// override. Best-effort: a missing row / DDB blip returns null and the caller
// treats the per-plan override as absent (global flag governs).
async function getPlanRowForAutoMerge(planId) {
  if (!planId) return null;
  try {
    const result = await ddb.send(new GetCommand({ TableName: PLANS_TABLE, Key: { planId } }));
    return result.Item || null;
  } catch {
    return null;
  }
}

// F6 (P0 cost safety) — HARD cost ceiling at the wave boundary.
//
// The cost ceiling was soft/post-hoc: cost-meter.decideAction /
// cost-engine.checkCostEnvelope existed but nothing consulted them between
// waves, so a runaway plan kept spawning wave work past its budget. This
// turns the ceiling into a HARD gate: before a wave-merge dispatches its
// stories, compare plan.totalCostUsd against plan.costCeilingUsd (with a
// small overrun tolerance) using the EXISTING cost-meter math. When the
// budget is blown we stop spawning new work, mark this wave's stories
// 'skipped' (skippedReason: 'skipped-budget'), and raise an operator card.
//
// Returns true when the wave was blocked (caller should short-circuit the
// merge), false when the wave may proceed. Fail-open on any unexpected
// error (a budget-check blip must never wedge a plan).
const WAVE_BUDGET_OVERRUN_TOLERANCE = 0.05; // allow 5% overrun before a hard stop

async function enforceWaveBudgetGate(planRow, p, short) {
  try {
    const ceiling = Number(planRow?.costCeilingUsd);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return false; // no ceiling set → back-compat: no enforcement
    let total = Number(planRow?.totalCostUsd) || 0;

    // Pipeline-3 (development-plan §5.4) — reconcile the TRUE per-process spend
    // (harness-cost bridge) before the gate reads it. observe logs the ~10× gap
    // and keeps the internal total; enforce uses the reconciled total so the
    // ceiling fires on real spend. Fail-open (keeps `total` on any error).
    const ceilingMode = (process.env.P3_COST_CEILING || 'off').toLowerCase();
    if (ceilingMode !== 'off' && planRow?.workingDir) {
      try {
        const [{ reconcileWaveCost }, { join: joinPath }] = await Promise.all([
          import('./lib/cost-reconcile-gate.mjs'),
          import('node:path'),
        ]);
        const r = reconcileWaveCost({
          harnessCostDir: joinPath(planRow.workingDir, '.pipeline', 'harness-cost'),
          internalTotalUsd: total,
          ceilingUsd: ceiling,
          mode: ceilingMode,
          log,
        });
        total = r.effectiveTotal;
      } catch (e) {
        log('warn', `[${short}] cost reconcile skipped (non-blocking): ${e.message}`);
      }
    }

    // Reuse the existing cost-meter decision math. We inflate the ceiling by
    // the overrun tolerance so `terminate` fires only once spend is past the
    // ceiling + tolerance (decideAction terminates at cost >= ceiling).
    const { CostMeter } = await import('./lib/cost-meter.mjs');
    const decision = new CostMeter(ddb).decideAction(
      total,
      ceiling * (1 + WAVE_BUDGET_OVERRUN_TOLERANCE),
    );
    if (decision.action !== 'terminate') return false;

    log(
      'warn',
      `[${short}] cost ceiling exceeded — blocking wave ${p.waveNumber} ` +
        `(spend $${total.toFixed(2)} ≥ ceiling $${ceiling.toFixed(2)} +${Math.round(WAVE_BUDGET_OVERRUN_TOLERANCE * 100)}%)`,
    );

    // Mark this wave's stories 'skipped' with reason 'skipped-budget'. Best-
    // effort, read-modify-write on the epic row (same shape the wave-reducer
    // mutates). A write failure does NOT un-block the gate.
    try {
      const epicRes = await ddb.send(
        new GetCommand({ TableName: EPICS_TABLE, Key: { epicId: p.epicId } }),
      );
      const stories = epicRes.Item?.stories;
      if (Array.isArray(stories)) {
        const ids = new Set(p.storyIds || []);
        let changed = 0;
        for (const s of stories) {
          if (ids.has(s.storyId) && s.status !== 'done') {
            s.status = 'skipped';
            s.skippedReason = 'skipped-budget';
            changed += 1;
          }
        }
        if (changed > 0) {
          await ddb.send(
            new UpdateCommand({
              TableName: EPICS_TABLE,
              Key: { epicId: p.epicId },
              UpdateExpression: 'SET stories = :s, updatedAt = :n',
              ExpressionAttributeValues: { ':s': stories, ':n': new Date().toISOString() },
              ConditionExpression: 'attribute_exists(epicId)',
            }),
          );
          log('info', `[${short}] marked ${changed} story(ies) skipped-budget`);
        }
      }
    } catch (markErr) {
      log('warn', `[${short}] skipped-budget story mark failed (non-blocking): ${markErr.message}`);
    }

    // Raise an operator attention card (dedup per-plan — one open card per
    // plan budget breach; recurrence increments rather than spamming).
    await writeAttentionItem(
      ddb,
      {
        planId: p.planId,
        severity: 'high',
        category: 'cost-ceiling-block',
        title: `Cost ceiling exceeded — plan halted at wave ${p.waveNumber}`,
        body:
          `Plan spend $${total.toFixed(2)} reached the cost ceiling $${ceiling.toFixed(2)} ` +
          `(+${Math.round(WAVE_BUDGET_OVERRUN_TOLERANCE * 100)}% overrun tolerance). ` +
          `Wave ${p.waveNumber} was NOT merged and its remaining stories were marked ` +
          `'skipped' (skipped-budget). Raise the ceiling via ` +
          `POST /api/plans/${p.planId}/raise-cost-ceiling to resume, or accept the plan as-is.`,
        context: {
          epicId: p.epicId,
          waveNumber: p.waveNumber,
          totalCostUsd: total,
          costCeilingUsd: ceiling,
          skippedStoryIds: p.storyIds || [],
        },
        dedupKey: `cost-ceiling-block:${p.planId}`,
      },
      log,
    );
    return true;
  } catch (err) {
    // Fail-open: a budget-check error must never wedge the pipeline.
    log('warn', `[${short}] wave budget gate check failed (fail-open): ${err.message}`);
    return false;
  }
}

async function patchAppRow(appId, patch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);
  const names = {};
  const values = {};
  const expressions = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expressions.push(`#${k} = :${k}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: APPS_TABLE,
      Key: { appId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(appId)',
    }),
  );
}

/**
 * Story 18.2 — Free Claude Code Agent session turn handler.
 *
 * The API Lambda (Story 18.5) creates the session row + assumes STS
 * credentials, then enqueues a free-agent-session job per user message.
 * This function picks up that job, validates it, and dispatches into the
 * pipeline implementation at daemon/pipelines/free-agent-session.mjs.
 */
async function executeFreeAgentSessionJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateFreeAgentSessionJob(job);
  if (!validation.ok) {
    throw new Error(`free-agent-session job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to free-agent-session pipeline`, {
    sessionId: job.freeAgentSessionPayload?.sessionId,
    model: job.freeAgentSessionPayload?.model,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'free-agent-session',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    await runFreeAgentSession(job, {
      pushEvent,
      sessionsRepo: buildFreeAgentSessionsRepoFacade(),
      claudeBin: CLAUDE_BIN,
      spawn,
      logger: {
        info: (msg) => log('info', msg),
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
      },
    });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] free-agent-session completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] free-agent-session failed: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Queues module — write helper for the queue-requests table. Accepts either a
 * normal field patch (SET) or the runner's `{ __appendAudit: entry }` sentinel,
 * which does a DynamoDB `list_append` (seeding the list on first write). Keeps
 * the pure runner free of DDB imports.
 */
async function updateQueueRequest(requestId, patch) {
  if (patch && patch.__appendAudit) {
    const entry = patch.__appendAudit;
    // Seed `audit` as an empty list if absent, then append (idempotent seed).
    await ddb.send(
      new UpdateCommand({
        TableName: QUEUE_REQUESTS_TABLE,
        Key: { requestId },
        UpdateExpression: 'SET #a = if_not_exists(#a, :empty)',
        ExpressionAttributeNames: { '#a': 'audit' },
        ExpressionAttributeValues: { ':empty': [] },
      }),
    );
    await ddb.send(
      new UpdateCommand({
        TableName: QUEUE_REQUESTS_TABLE,
        Key: { requestId },
        UpdateExpression: 'SET #a = list_append(#a, :e), updatedAt = :ts',
        ExpressionAttributeNames: { '#a': 'audit' },
        ExpressionAttributeValues: { ':e': [entry], ':ts': new Date().toISOString() },
      }),
    );
    return;
  }
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  entries.push(['updatedAt', new Date().toISOString()]);
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of entries) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(
    new UpdateCommand({
      TableName: QUEUE_REQUESTS_TABLE,
      Key: { requestId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Queues module — inbound external REST call handler. The API Lambda writes the
 * queue-requests row (RECEIVED) + enqueues this job (PENDING); the daemon claims
 * it under the shared cap and dispatches into daemon/pipelines/queue-request.mjs,
 * which spawns `claude -p`, streams the live terminal into agent-events, and
 * writes the result back onto the queue-requests row.
 */
async function executeQueueRequestJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateQueueRequestJob(job);
  if (!validation.ok) {
    throw new Error(`queue-request job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to queue-request runner`, {
    requestId: job.queueRequestPayload?.requestId,
    source: job.queueRequestPayload?.source,
    target: job.queueRequestPayload?.target,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'queue-request',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    const outcome = await runQueueRequest(job, {
      pushEvent,
      updateRequest: updateQueueRequest,
      claudeBin: CLAUDE_BIN,
      spawn,
      logger: {
        info: (msg) => log('info', msg),
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
      },
    });
    // The runner already wrote COMPLETED/FAILED onto the queue-request row; mirror
    // the outcome onto the agent-job so the poll loop + heartbeat reflect it.
    if (outcome.ok) {
      await updateJobFields(jobId, { status: 'COMPLETED' });
      log('info', `[${short}] queue-request completed`);
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: outcome.error || 'queue-request failed',
      });
      log('warn', `[${short}] queue-request failed: ${outcome.error}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    // Best-effort: also mark the queue-request row FAILED if the runner threw
    // before it could persist a terminal state.
    try {
      await updateQueueRequest(job.queueRequestPayload?.requestId, {
        status: 'FAILED',
        error: err?.message || String(err),
        completedAt: new Date().toISOString(),
      });
    } catch {
      /* row may not exist / already terminal — non-fatal */
    }
    log('error', `[${short}] queue-request failed: ${err?.message || err}`);
    throw err;
  }
}

async function executeAppBootstrapJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateAppBootstrapJob(job);
  if (!validation.ok) {
    throw new Error(`app-bootstrap job rejected: ${validation.reason}`);
  }

  log('info', `[${short}] Routing to app-bootstrap pipeline`, {
    appId: job.appBootstrapPayload?.appId,
    boilerplateType: job.appBootstrapPayload?.boilerplateType,
    bmadEnabled: job.appBootstrapPayload?.bmadEnabled === true,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'app-bootstrap',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    await runAppBootstrap(job, {
      pushEvent,
      getApp: getAppRow,
      updateApp: patchAppRow,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
      partyCtx: buildPartyCtx(),
      runPartyBootstrap,
      // 2026-07-17 — host-portable roots. Without these the saga's own
      // `/home/ubuntu/*` defaults apply, which EACCES on a remapped host
      // (Mac runner) where /home/ubuntu is not writable. BARE_REPOS_ROOT is
      // env-driven (FUTURATOR_BARE_REPOS_ROOT, exported by run-fleet-local.sh)
      // and shared with story-worktree.mjs so both features agree on one
      // repos root; remapDaemonPath additionally rewrites the /home/ubuntu
      // default when only PROJECTS_ROOT/FUTURATOR_WORKTREE_ROOT are remapped.
      // Fleet/EC2 (env unset, remap inactive) resolves to the same
      // /home/ubuntu/{repos,projects} defaults as before — exact no-op.
      reposRoot: remapDaemonPath(BARE_REPOS_ROOT),
      projectsRoot: DAEMON_PROJECTS_ROOT,
      // Epic 3 Story 3.3 (2026-05-20) — saga inserts the T1 SKILL-SCOUT
      // job row directly at bootstrap completion. Pass-through to DDB.
      insertAgentJob: async (newJob) => {
        await ddb.send(
          new PutCommand({
            TableName: JOBS_TABLE,
            Item: newJob,
            ConditionExpression: 'attribute_not_exists(jobId)',
          }),
        );
      },
    });
    await updateJobFields(jobId, { status: 'COMPLETED' });
    log('info', `[${short}] app-bootstrap completed`);
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] app-bootstrap failed: ${err?.message || err}`);
    throw err;
  }
}

/**
 * 2026-05-19 — Phase 1 worktree rollout. Wave-merge job runner.
 *
 * Consumes `job.waveMergePayload` and dispatches to runWaveMerge in
 * lib/wave-merge-runner.mjs. Translates the runner's structured outcome
 * back into job-status updates:
 *
 *   success           → COMPLETED, plan branch pushed, wip branches reaped
 *   merge-conflict    → FAILED with structured error (attention already raised)
 *   wave-build-failed → FAILED with structured error (attention already raised)
 *   no-stories        → COMPLETED (idempotent; wave had nothing to merge)
 *   setup-failed      → FAILED (coordinator worktree could not be created)
 */
async function executeWaveMergeJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateWaveMergeJob(job);
  if (!validation.ok) {
    throw new Error(`wave-merge job rejected: ${validation.reason}`);
  }

  const p = job.waveMergePayload;
  log('info', `[${short}] Routing to wave-merge runner`, {
    appId: p.appId,
    planSlug: p.planSlug,
    epicId: p.epicId,
    waveNumber: p.waveNumber,
    stories: p.storyIds.length,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'wave-merge',
    lastHeartbeatAt: new Date().toISOString(),
  });

  // Resolve the boilerplate's gate config (validation command + qaContext +
  // qualityGate) from the committed gate-registry snapshot
  // (lib/boilerplate-gate-registry.json, generated from the TS registry and
  // drift-guarded by a parity test). v2.6 M2 — this closes the
  // "validated ≠ shipped" seam where agent-daemon imported
  // `../sst-env-shared/boilerplate-registry-snapshot.mjs`, a file NEVER
  // generated, so a hardcoded fallback ran for every wave since 2026-05-19.
  let postMergeValidationCmd = p.postMergeValidationCmd ?? null;
  let gateEntry = null;
  try {
    const appRow = await getAppRow(p.appId);
    const boilerplateType = appRow?.boilerplateType || 'nextjs-base';
    const { getGateEntry } = await import('./lib/gate-registry.mjs');
    gateEntry = getGateEntry(boilerplateType);
  } catch (resolveErr) {
    log('warn', `[${short}] gate-registry resolve failed (legacy fallback): ${resolveErr.message}`);
  }
  if (postMergeValidationCmd === null) {
    if (gateEntry) {
      // Registry semantics preserved: null = stub boilerplate = skip validation.
      postMergeValidationCmd = gateEntry.postMergeValidationCmd ?? null;
    } else {
      // 2026-05-28 legacy fallback (snapshot missing/unreadable): `next
      // build` is the real gate that exists; tests run when a scaffold has
      // them. Story D — regenerate generated wiring before the build.
      postMergeValidationCmd =
        '[ -f scripts/generate-wiring.mjs ] && node scripts/generate-wiring.mjs; npm run build && npm run test --if-present';
    }
  }

  // Story E Tier 2 (2026-05-30) — decide whether to pass the agentic resolver.
  // Default OFF (operator-resolve-only / Story A). Enabled only when the global
  // `agent.autoMerge` flag is on AND the plan hasn't opted out via
  // `autoMergeMode: 'off'`. When enabled, the runner attempts an in-candidate
  // resolution that is still build-gated + advance-on-green + audited.
  // Plan row read once: autoMergeMode gates the agentic hooks below, rigor
  // gates + scales the v2.6 wave VQA stage.
  const planRow = await getPlanRowForAutoMerge(p.planId);

  // F6 (P0 cost safety) — HARD cost ceiling at the wave boundary. Before this
  // wave spawns ANY merge/validation work, stop if the plan has blown its
  // budget. enforceWaveBudgetGate marks this wave's stories skipped-budget and
  // raises an operator card; we terminate the job cleanly (COMPLETED, like the
  // no-stories path) so the wave-reducer sees a terminal wave and never
  // dispatches further work for this plan.
  if (await enforceWaveBudgetGate(planRow, p, short)) {
    await updateJobFields(jobId, {
      status: 'COMPLETED',
      phase: 'skipped-budget',
      errorMessage: 'wave skipped — plan cost ceiling exceeded (skipped-budget)',
    });
    await pushEvent(jobId, 'wave-merge', 'MERGE', 'step_error', {
      text: `wave ${p.waveNumber} skipped — plan cost ceiling exceeded (skipped-budget)`,
    });
    return;
  }

  let resolveConflictHook;
  let fixBuildHook;
  try {
    if (await isAutoMergeEnabledCached()) {
      const planMode = planRow?.autoMergeMode;
      if (planMode !== 'off') {
        resolveConflictHook = (args) => resolveWaveMergeConflict(args, { short });
        // pacman1 (2026-06-11) — same opt-in also enables the agentic
        // build-fix on post-merge validation failures (see wave-merge-runner).
        fixBuildHook = (args) => fixWaveMergeBuild(args, { short });
        log('info', `[${short}] auto-merge ON (global flag${planMode ? `, plan=${planMode}` : ''})`);
      } else {
        log('info', `[${short}] auto-merge globally ON but plan opted out (autoMergeMode=off)`);
      }
    }
  } catch (err) {
    log('warn', `[${short}] auto-merge gate check failed, defaulting to halt: ${err.message}`);
  }

  // ── v2.6 M2 (2026-06-11) — wave-gate VQA hook ─────────────────────────────
  // Judged visual QA runs against the MERGED candidate, between validation
  // and the green advance (see lib/wave-vqa-runner.mjs). Hook passed only
  // when it applies: rigor !== 'prototype', boilerplate is UI-bearing
  // (qaContext), and the wave's stories carry browser ACs. Judged failures
  // fix-forward (never block green); a no-boot env failure blocks like a
  // build failure.
  let runVqaHook;
  let waveStoriesForVqa = [];
  try {
    const rigor = planRow?.rigor || 'mvp';
    const qaContext = gateEntry?.qaContext || null;
    if (rigor !== 'prototype' && qaContext) {
      const epicRes = await ddb.send(
        new GetCommand({ TableName: EPICS_TABLE, Key: { epicId: p.epicId } }),
      );
      waveStoriesForVqa = (epicRes.Item?.stories || []).filter((s) =>
        p.storyIds.includes(s.storyId),
      );
      const hasBrowserAcs = waveStoriesForVqa.some((s) =>
        (s.criteria || []).some((c) => c.needsBrowser),
      );
      if (hasBrowserAcs) {
        const { runWaveVqa } = await import('./lib/wave-vqa-runner.mjs');
        const { bootDevServer, cleanCacheAndReboot } = await import('./lib/dev-server-boot.mjs');
        const { defaultGitRunner, defaultShellRunner, composeQualityGate } = await import(
          './lib/wave-merge-runner.mjs'
        );
        // v2.6 M4 — the VQA fixer re-runs the SAME blocking gate the merge
        // validated with (rigor-composed when the registry declares stages).
        const vqaValidationCmd =
          composeQualityGate({
            qualityGate: gateEntry?.qualityGate ?? null,
            rigor,
            postMergeValidationCmd,
          }).blockingCmd || postMergeValidationCmd;
        const vqaLog = (level, msg) => waveLog(level, msg);
        runVqaHook = ({ candidateDir }) =>
          runWaveVqa({
            candidateDir,
            stories: waveStoriesForVqa,
            rigor,
            qaContext,
            planId: p.planId,
            epicId: p.epicId,
            waveNumber: p.waveNumber,
            appId: p.appId,
            validationCmd: vqaValidationCmd,
            spawnEvidence: (a) => spawnGateAgent({ ...a, role: 'evidence' }, { short }),
            spawnJudge: (a) => spawnGateAgent({ ...a, role: 'judge' }, { short }),
            spawnTriage: (a) => spawnGateAgent({ ...a, role: 'triage' }, { short }),
            spawnFixer: async (a) => {
              const r = await spawnGateAgent({ ...a, role: 'fixer' }, { short });
              return {
                attempted: r.ok,
                infra: r.infra,
                reasoning: r.ok ? (r.output || '').slice(-1200) : r.reason,
              };
            },
            shell: defaultShellRunner,
            git: defaultGitRunner,
            writeAttention: (item) => writeAttentionItem(ddb, { ...item, planId: p.planId }, log),
            log: vqaLog,
            bootServer: bootDevServer,
            cleanReboot: cleanCacheAndReboot,
          });
        log('info', `[${short}] wave VQA armed (rigor=${rigor}, stories=${waveStoriesForVqa.length})`);
      } else {
        log('info', `[${short}] wave VQA skipped — no browser ACs in this wave`);
      }
    }
  } catch (err) {
    log('warn', `[${short}] wave VQA arm failed (non-blocking, gate proceeds without VQA): ${err.message}`);
  }

  // pacman1 (2026-06-11) — wave-level live streaming. Story jobs stream
  // their pipeline into the events table; wave-merge jobs were a black box
  // (the operator saw FIXING with no narrative). Tee every runner log line
  // into the events table under this jobId so the hierarchy view's wave
  // gate panel can render the same live log stories get. pushEvent never
  // throws (it catches internally), so the tee cannot break the merge.
  const waveLog = (level, msg) => {
    log(level, `[${short}] ${msg}`);
    if (typeof msg === 'string') {
      void pushEvent(
        jobId,
        'wave-merge',
        'MERGE',
        level === 'warn' || level === 'error' ? 'step_error' : 'status',
        { text: msg },
      );
    }
  };

  try {
    const { runWaveMerge } = await import('./lib/wave-merge-runner.mjs');
    const { withAppIntegrationLock } = await import('./lib/integration-lock.mjs');
    const { recordWaveConflictEvent } = await import('./lib/wave-conflict-recorder.mjs');
    // Story B (2026-05-29) — serialize the integration gate per app so two
    // epics in one plan-wave never race to advance the same green ref. The
    // ephemeral-candidate + advance-on-green model in the runner closes the
    // worktree race; this lock closes the ref race. See integration-lock.mjs.
    const result = await withAppIntegrationLock(p.appId, () =>
      runWaveMerge({
        appId: p.appId,
        planId: p.planId,
        planSlug: p.planSlug,
        epicId: p.epicId,
        waveNumber: p.waveNumber,
        storyIds: p.storyIds,
        postMergeValidationCmd,
        // v2.6 M4 — rigor-composed quality stages from the gate registry;
        // the runner falls back to postMergeValidationCmd when absent.
        qualityGate: gateEntry?.qualityGate ?? null,
        rigor: planRow?.rigor || null,
        jobId,
        writeAttention: (item) =>
          writeAttentionItem(ddb, { ...item, planId: p.planId }, log),
        // snake3 (2026-06-10) — success closes prior failure cards for this wave.
        resolveAttention: (dedupKey) =>
          autoResolveAttentionByDedupKey(ddb, p.planId, dedupKey, log),
        // Story C (2026-05-29) — durable conflict telemetry.
        recordConflictEvent: (event) => recordWaveConflictEvent(ddb, event, log),
        // Story E Tier 2 — undefined (halt) unless the toggle gate enabled it.
        resolveConflict: resolveConflictHook,
        // pacman1 (2026-06-11) — undefined (halt) unless autoMerge enabled it.
        fixBuild: fixBuildHook,
        // v2.6 M2 — undefined (skip) unless rigor/qaContext/browser-ACs armed it.
        runVqa: runVqaHook,
        // F14 (2026-06-18) — authoritative FULL-PROJECT ast-facts regen at
        // wave-close. The per-story pipeline persists ast-facts from a
        // `--diff-manifest` scan (last writer wins → snapshot collapses to one
        // story's slice). Once the candidate worktree IS the integrated product,
        // re-run bootstrap-ast over the WHOLE integrated tree (candidateDir),
        // NOT a per-story worktree, so the persisted scan reflects every source
        // file. Spawned as ubuntu (the worktree's owner) on the model of the
        // boilerplate wave-gate bootstrap: `node bootstrap-ast.mjs --project
        // <appId> --root <candidateDir>`. Best-effort: a regen failure logs and
        // resolves — it must NEVER fail the wave merge.
        regenAstFacts: ({ candidateDir, appId: regenAppId }) =>
          new Promise((resolve) => {
            try {
              const scriptPath = new URL('./scripts/bootstrap-ast.mjs', import.meta.url).pathname;
              const child = spawn(
                'sudo',
                [
                  '-n',
                  '-u',
                  'ubuntu',
                  process.execPath,
                  scriptPath,
                  '--project',
                  regenAppId,
                  '--root',
                  candidateDir,
                ],
                { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
              );
              let stderr = '';
              child.stderr.on('data', (b) => (stderr += b.toString('utf8').slice(-2000)));
              child.on('close', (code) => {
                if (code !== 0) {
                  waveLog(
                    'warn',
                    `[wave-merge] full-project AST regen exit ${code} (non-blocking): ${stderr.slice(-300)}`,
                  );
                }
                // F16 (2026-06-18) — consume the structured orphan signal the
                // regen's graph-sync wrote. bootstrap-ast scans candidateDir,
                // and graph-sync emits knowledge/_graph/orphan-signal.json with
                // { genuineOrphanCount, legitimateFloaterCount, delta,
                // needsAttention }. A genuine-orphan regression means an
                // extractor dropped an edge — raise a deduped OPERATOR ATTENTION
                // CARD. Best-effort: a parse/read failure must never fail the
                // wave.
                try {
                  const signalPath = pathJoin(
                    candidateDir,
                    'knowledge',
                    '_graph',
                    'orphan-signal.json',
                  );
                  if (existsSync(signalPath)) {
                    const signal = JSON.parse(readFileSync(signalPath, 'utf8'));
                    if (signal && signal.needsAttention) {
                      const n = signal.genuineOrphanCount ?? 0;
                      const floaters = signal.legitimateFloaterCount ?? 0;
                      const delta = signal.delta;
                      const deltaStr =
                        delta == null
                          ? 'no prior baseline'
                          : `${delta >= 0 ? '+' : ''}${delta} vs prior`;
                      writeAttentionItem(
                        ddb,
                        {
                          planId: p.planId,
                          severity: 'medium',
                          category: 'other',
                          title: `Knowledge-graph: ${n} genuine orphan(s) (extractor dropped an edge)`,
                          body:
                            `The wave-close graph-sync over the integrated tree found ${n} ` +
                            `genuine orphan node(s) (${deltaStr}; ${floaters} legitimate floater(s) ` +
                            `excluded). A genuine orphan is a non-file node with no containing edge — ` +
                            `an extractor dropped an edge rather than a real finding. See ` +
                            `knowledge/_graph/orphan-signal.json for the breakdown.`,
                          context: {
                            appId: regenAppId,
                            epicId: p.epicId,
                            waveNumber: p.waveNumber,
                            genuineOrphanCount: n,
                            legitimateFloaterCount: floaters,
                            delta: delta ?? null,
                          },
                          dedupKey: `graph-orphans:${regenAppId}:${p.waveNumber}`,
                        },
                        waveLog,
                      ).catch((err) =>
                        waveLog(
                          'warn',
                          `[wave-merge] orphan-signal attention write failed (non-blocking): ${err.message}`,
                        ),
                      );
                    }
                  }
                } catch (err) {
                  waveLog(
                    'warn',
                    `[wave-merge] orphan-signal consume failed (non-blocking): ${err.message}`,
                  );
                }
                resolve();
              });
              child.on('error', (err) => {
                waveLog('warn', `[wave-merge] full-project AST regen spawn failed (non-blocking): ${err.message}`);
                resolve();
              });
            } catch (err) {
              waveLog('warn', `[wave-merge] full-project AST regen threw (non-blocking): ${err.message}`);
              resolve();
            }
          }),
        log: waveLog,
      }),
    );

    if (result.outcome === 'success' || result.outcome === 'no-stories') {
      // v2.6 M2 — persist a compact VQA summary (the full handoff packets
      // live in attention-card context + the committed .context/ files; DDB
      // job rows stay small).
      const vqaSummary = result.vqa
        ? {
            outcome: result.vqa.outcome,
            reason: result.vqa.reason,
            pass: (result.vqa.verdicts || []).filter((v) => v.result === 'PASS').length,
            fixed: (result.vqa.fixesApplied || []).length,
            fixForward: (result.vqa.fixForward || []).map((h) => ({
              storyId: h.storyId,
              acId: h.acId,
              observed: (h.observed || '').slice(0, 300),
              screenshotUrl: h.evidence?.screenshotUrl || null,
            })),
            unverifiable: (result.vqa.unverifiable || []).length,
            reportPath: result.vqa.reportPath || null,
            // QA-B (pong1 2026-06-12) — per-AC verdicts, compact. The QA
            // Review claims table joins gate history by acId; without these
            // only failures (fixForward) were reconstructable and every
            // PASS at the gate was invisible at the shipping decision.
            verdicts: (result.vqa.verdicts || []).map((v) => ({
              acId: v.acId,
              storyId: v.storyId,
              result: v.result,
              observation: (v.observation || '').slice(0, 200),
              screenshotUrl: v.screenshotUrl || null,
            })),
            fixedAcIds: (result.vqa.fixesApplied || []).flatMap((f) => f.acIds || []),
          }
        : null;
      // ORDERING MATTERS: mint BEFORE flipping the job COMPLETED — the
      // wave-reducer advances (or completes) the epic on the first tick that
      // sees a terminal gate; stories appended after that tick's read would
      // never launch.
      // ── v2.6 M5 — auto-mint fix stories from fix-forward handoffs ───────
      // Each surviving judged failure becomes a NORMAL story in the epic's
      // next wave, dependsOn the owning story, description = the handoff
      // packet — so self-correction flows through the standard story
      // pipeline (test-author → dev → gate → wave VQA re-verifies) with
      // zero new launch machinery (the wave-reducer launches wave N+1 when
      // wave N completes). Cap: ONE auto-fix story per owning story per
      // plan; recurrence escalates to the operator (HIGH card) — the end of
      // the escalation ladder. Best-effort: a mint failure never un-merges.
      if ((result.vqa?.fixForward || []).length > 0) {
        try {
          const epicRes = await ddb.send(
            new GetCommand({ TableName: EPICS_TABLE, Key: { epicId: p.epicId } }),
          );
          const epic = epicRes.Item;
          if (epic && Array.isArray(epic.stories)) {
            const { buildVqaFixStories } = await import('./lib/wave-vqa-fix-story.mjs');
            const { minted, escalations } = buildVqaFixStories({
              existingStories: epic.stories,
              fixForward: result.vqa.fixForward,
              waveNumber: p.waveNumber,
              uuid: randomUUID,
            });
            for (const esc of escalations) {
              const acs = esc.handoffs.map((h) => h.acId).join(', ');
              // FL-1 — two escalation reasons need different operator copy:
              //  • 'operator-route' — the failure is not machine-actionable
              //    (ac-wording / environment); routed to the operator on FIRST
              //    occurrence, not a recurrence.
              //  • 'recurrence' (default) — a fix story already ran and the AC
              //    failed again; the end of the auto-correction ladder.
              const isOperatorRoute = esc.reason === 'operator-route';
              const title = isOperatorRoute
                ? `VQA: ${acs} needs an operator decision (${esc.route?.routeClass || 'not auto-fixable'})`
                : `VQA fix story already attempted for ${esc.ownerId.slice(0, 8)} — operator decision needed`;
              const body = isOperatorRoute
                ? `Wave ${p.waveNumber} VQA confirmed ${acs} failing, but it is not machine-actionable. ` +
                  `${esc.route?.guidance || ''} Decide: reword the AC, fix manually, or accept.`
                : `Wave ${p.waveNumber} VQA confirmed ${acs} ` +
                  `failing AGAIN after an auto-minted fix story already ran for this story. ` +
                  `Not minting another (one per owning story). Decide: reword the AC, fix manually, or accept.`;
              await writeAttentionItem(
                ddb,
                {
                  planId: p.planId,
                  severity: 'high',
                  category: 'wave-vqa-failed',
                  title,
                  body,
                  context: {
                    epicId: p.epicId,
                    storyId: esc.ownerId,
                    waveNumber: p.waveNumber,
                    handoffs: esc.handoffs,
                    reason: esc.reason || 'recurrence',
                    route: esc.route?.route,
                  },
                  dedupKey: `wave-vqa-escalated:${p.planId}:${esc.ownerId}`,
                },
                log,
              );
            }
            if (minted.length > 0) {
              // list_append (not full-array write) — the wave-reducer
              // read-modify-writes epic.stories on its own tick; appending
              // narrows the lost-update window to reducer-reads in flight.
              await ddb.send(
                new UpdateCommand({
                  TableName: EPICS_TABLE,
                  Key: { epicId: p.epicId },
                  UpdateExpression: 'SET stories = list_append(stories, :new)',
                  ExpressionAttributeValues: { ':new': minted },
                  ConditionExpression: 'attribute_exists(epicId)',
                }),
              );
              log(
                'info',
                `[${short}] minted ${minted.length} wave-vqa-fix stor${minted.length === 1 ? 'y' : 'ies'} at wave ${minted[0].wave}`,
              );
              await pushEvent(jobId, 'wave-merge', 'MERGE', 'status', {
                text: `vqa fix-forward → minted ${minted.length} fix stor${minted.length === 1 ? 'y' : 'ies'} at wave ${minted[0].wave}: ${minted.map((st) => st.title).join(' | ').slice(0, 400)}`,
              });
            }
          }
        } catch (mintErr) {
          log('warn', `[${short}] vqa fix-story mint failed (non-blocking): ${mintErr.message}`);
        }
      }

      // ── P3 (pong1 2026-06-12) — close the fix-forward loop ──────────────
      // When a previously auto-minted wave-vqa-fix story is IN this wave and
      // every one of its criteria passed this gate's VQA (judged PASS, or
      // cleared by the in-gate fixer), auto-resolve the originating
      // wave-vqa-failed card. pong1 left the AC-S5-1 card OPEN although its
      // fix story verified at the wave-3 gate — the loop should close
      // itself end-to-end. dedupKey rebuilt from the story's fixesWave
      // provenance (wave-vqa:<plan>:<epic>:<fixesWave>:<ownerStoryId>).
      if (result.vqa) {
        try {
          const epicRes = await ddb.send(
            new GetCommand({ TableName: EPICS_TABLE, Key: { epicId: p.epicId } }),
          );
          const epicStories = Array.isArray(epicRes.Item?.stories) ? epicRes.Item.stories : [];
          const inWave = new Set(p.storyIds || []);
          const fixStories = epicStories.filter(
            (s) => s.origin === 'wave-vqa-fix' && inWave.has(s.storyId),
          );
          if (fixStories.length > 0) {
            const passed = new Set(
              (result.vqa.verdicts || []).filter((v) => v.result === 'PASS').map((v) => v.acId),
            );
            for (const f of result.vqa.fixesApplied || []) {
              for (const id of f.acIds || []) passed.add(id);
            }
            for (const fs of fixStories) {
              const acIds = (fs.criteria || []).map((c) => c.id);
              const allPass = acIds.length > 0 && acIds.every((id) => passed.has(id));
              const ownerId = (fs.dependsOn || [])[0];
              if (!allPass || !ownerId || typeof fs.fixesWave !== 'number') continue;
              const dedupKey = `wave-vqa:${p.planId}:${p.epicId}:${fs.fixesWave}:${ownerId}`;
              await autoResolveAttentionByDedupKey(ddb, p.planId, dedupKey, log);
              log(
                'info',
                `[${short}] fix story ${fs.storyId.slice(0, 8)} verified (${acIds.join(', ')}) — auto-resolved ${dedupKey}`,
              );
            }
          }
        } catch (resolveErr) {
          log(
            'warn',
            `[${short}] wave-vqa-failed auto-resolve failed (non-blocking): ${resolveErr.message}`,
          );
        }
      }

      await updateJobFields(jobId, {
        status: 'COMPLETED',
        waveMergeResult: {
          outcome: result.outcome,
          mergedStoryIds: result.mergedStoryIds || [],
          coordinatorWorktree: result.coordinatorWorktree,
          pushSha: result.pushSha,
          vqa: vqaSummary,
          // QA-D (pong1 2026-06-12) — real per-stage gate outcomes; the QA
          // Review matrix renders these instead of inferring N green cells
          // from this job's single COMPLETED bit.
          stages: result.stages || [],
        },
      });
      // v2.6 §2.6 — every in-gate VQA fix becomes a pending REFLECTOR row
      // ("VQA caught X; pattern to avoid") in the existing inbox. Best-effort.
      for (const f of result.vqa?.fixesApplied || []) {
        try {
          await ddb.send(
            new PutCommand({
              TableName: process.env.REFLECTIONS_TABLE || 'futurator-reflections',
              Item: {
                projectSlug: p.appId,
                id: randomUUID(),
                createdAt: new Date().toISOString(),
                planId: p.planId,
                scope: 'wave',
                target: 'project-claude-md',
                action: 'append-line',
                section: 'Patterns to avoid',
                content: `Wave ${p.waveNumber} VQA caught and fixed ${f.acIds.join(', ')}: ${f.summary}`,
                rationale:
                  'A judge panel confirmed a visual contradiction on the merged candidate that every per-story gate missed; the in-gate fixer repaired it. Recurring shapes of this failure belong in Patterns to avoid.',
                evidence: f.acIds,
                confidence: 0.6,
                status: 'pending',
              },
            }),
          );
        } catch (reflErr) {
          log('warn', `[${short}] vqa reflection write failed (non-blocking): ${reflErr.message}`);
        }
      }
      await pushEvent(jobId, 'wave-merge', 'MERGE', 'step_complete', {
        text:
          `wave-merge ${result.outcome} — merged ${result.mergedStoryIds?.length || 0} stories, green advanced to ${result.pushSha || '?'}` +
          (vqaSummary
            ? ` · vqa ${vqaSummary.outcome} (${vqaSummary.pass} pass, ${vqaSummary.fixed} fixed, ${vqaSummary.fixForward.length} fix-forward)`
            : ''),
      });
      log('info', `[${short}] wave-merge ${result.outcome} (merged ${result.mergedStoryIds?.length || 0})`);
      // git-graph snapshot — the plan branch + merge commits just advanced.
      void snapshotGitGraph(p.appId, short);
      return;
    }

    // merge-conflict / wave-build-failed / setup-failed
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: `wave-merge ${result.outcome}: ${result.conflictedAtStoryId || result.failingTests?.length || result.error || 'see attention items'}`,
      waveMergeResult: result,
    });
    await pushEvent(jobId, 'wave-merge', 'MERGE', 'step_error', {
      text:
        `wave-merge ${result.outcome}` +
        (result.testOutput ? ` — validation output (tail):\n${result.testOutput.slice(-1800)}` : ''),
    });
    log('warn', `[${short}] wave-merge ${result.outcome}`);
    // Snapshot even on halt — the wip/* branches the operator wants to see
    // are still present (they're only reaped on success).
    void snapshotGitGraph(p.appId, short);
    // We do NOT throw — the failure is structured and the wave-reducer
    // will see this terminal status on the next tick and flip the wave
    // to `fixing` (existing wave-reducer behavior for non-success wave
    // build-check jobs).
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] wave-merge runner threw: ${err?.message || err}`);
    throw err;
  }
}

// ── Poll loop ──

// Task B (2026-07-17) — REPO MATERIALIZATION for plan-scoped jobs on a fresh
// machine. Plan-affinity keeps a plan's jobs on one host; when that host has
// never seen the app, clone it from GitHub into the (already-remapped)
// workingDir. Git auth rides the insteadOf PAT rewrite that
// configure-git-identity.sh installs. Rules:
//   - remapped hosts only (isRemapActive) — fleet/EC2 is an exact no-op;
//   - plan-scoped jobs only (job.planId) — NEVER queue-requests, which
//     provision their own run dirs;
//   - per-story worktree dirs are excluded — setupStoryWorktree owns those;
//   - no resolvable repo URL ⇒ THROW (loud FAILED job, no silent skip).
async function materializePlanWorkingDirIfMissing(job) {
  if (!isRemapActive()) return;
  // Plan-scope detection: legacy pipeline + integrator jobs stamp a top-level
  // planId; story-dev / quick-planspec / reflector jobs carry it in their
  // payload refs. app-bootstrap is EXCLUDED even though it is plan-pinned —
  // its own bare-clone step is what creates the repo. queue-requests carry no
  // plan reference at all and are excluded naturally.
  const planId =
    job.planId ||
    job.storyNodeRef?.planId ||
    job.storyDevPayload?.planId ||
    job.quickPlanspecPayload?.planId ||
    job.reflectorPayload?.planId ||
    null;
  if (!planId || !job.workingDir || job.jobType === 'app-bootstrap') return;
  const workingDir = job.workingDir; // remapped at the runJobAsync intake seam
  if (existsSync(workingDir)) return;
  if (workingDir.startsWith(`${DAEMON_WORKTREE_ROOT}/`)) return;
  const short = job.jobId.slice(0, 8);
  // Fleet convention (derive-project-id.ts): last path segment == appId.
  const appId =
    job.appId || job.projectId || pathBasename(workingDir.replace(/\/+$/, ''));
  const app = await getAppRow(appId);
  if (!app) {
    throw new Error(
      `repo-materialize: workingDir ${workingDir} is missing and no App row exists for '${appId}' (APPS_TABLE) — no repo URL to clone from; refusing to run plan-scoped job without a repo`,
    );
  }
  // Brownfield apps carry githubRepoUrl; greenfield apps fall back to the
  // futurator-repos/<appId> convention (parse-repo-url.ts).
  const repoUrl = app.githubRepoUrl || `https://github.com/futurator-repos/${appId}.git`;
  const parentDir = pathJoin(workingDir, '..');
  mkdirSync(parentDir, { recursive: true });
  log('info', `[${short}] repo-materialize: workingDir missing — cloning ${repoUrl} → ${workingDir} (plan ${String(planId).slice(0, 8)})`);
  const res = await daemonGit(['clone', repoUrl, workingDir], parentDir);
  if (res.code !== 0) {
    throw new Error(
      `repo-materialize: git clone ${repoUrl} → ${workingDir} FAILED (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 400)}`,
    );
  }
  log('info', `[${short}] repo-materialize: clone complete → ${workingDir}`);
}

async function runJobAsync(job) {
  // Task B (2026-07-17) — THE single path-remap seam. Rewrite every baked
  // fleet-absolute path (workingDir, *Payload path fields, legacy step
  // command/prompt text) to this host's roots before the claim/handlers see
  // the job. Exact no-op on fleet/EC2 boxes (remap inactive).
  remapJobPaths(job);
  // Servers module (Task 18, spec §5.2) — with `dispatch.serverAware` on, win
  // the CAS lease BEFORE taking a slot: a conditional PENDING→RUNNING write
  // pinned to this SERVER_ID (buildJobClaimParams), so N daemons racing the
  // same row resolve to exactly one winner. Losing the race is normal, not an
  // error. Flag off ⇒ legacy path: no claim, handlers write RUNNING as before.
  let jobClaim = null;
  if (serverAwareDispatch) {
    const short = job.jobId.slice(0, 8);
    const { params: claimParams, claimToken } = buildJobClaimParams({
      tableName: JOBS_TABLE,
      jobId: job.jobId,
      serverId: SERVER_ID,
      nowIso: new Date().toISOString(),
      leaseMs: JOB_CLAIM_LEASE_MS,
    });
    try {
      await ddb.send(new UpdateCommand(claimParams));
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        log('info', `[${short}] CAS claim lost — another daemon holds this job; skipping`);
      } else {
        log('error', `[${short}] CAS claim write failed (job stays PENDING): ${err.message}`);
      }
      return;
    }
    // Renew the lease at 1/3 of its length while the job runs; cleared (and
    // the claim released) in the finally-block below. unref'd so a renew
    // timer never keeps a shutting-down daemon alive.
    const renewTimer = setInterval(() => {
      const renewParams = buildJobRenewParams({
        tableName: JOBS_TABLE,
        jobId: job.jobId,
        serverId: SERVER_ID,
        claimToken,
        nowIso: new Date().toISOString(),
        leaseMs: JOB_CLAIM_LEASE_MS,
      });
      ddb
        .send(new UpdateCommand(renewParams))
        .catch((err) => log('warn', `[${short}] claim lease renew failed: ${err.message}`));
    }, Math.floor(JOB_CLAIM_LEASE_MS / 3));
    renewTimer.unref?.();
    jobClaim = { claimToken, renewTimer };
  }

  // Story 20.16 — acquire the manager slot up-front. Idempotent (selectNext
  // path already pre-checked canAcquire) so this is effectively bookkeeping.
  // When CM_DISABLED the call still runs but the legacy poll-loop gate is
  // the load-bearing capacity check.
  concurrencyManager.tryAcquire(job);
  const jobStartMs = Date.now(); // 2026-05-27 PR B.c — spend instrumentation.
  activeJobs.set(job.jobId, {
    startedAt: new Date().toISOString(),
    workingDir: job.workingDir || '',
    stepId: null,
    agentId: null,
    pid: null,
    model: null,
  });
  jobEventSeqs.set(job.jobId, 0);
  // Reap-ownership stamp (pacman1 triple-mint, 2026-07-13): record WHICH daemon
  // source runs this job so the stale reaper (canReapJob) is scoped to its own
  // jobs — a peer daemon (laptop ↔ EC2) must never reap another host's live
  // work. Fire-and-forget: a missed stamp only means the legacy ec2-only rule.
  updateJobFields(job.jobId, { claimedBySource: DAEMON_SOURCE }).catch(() => {});

  const handler = selectHandler(job);
  log(
    'info',
    `[${job.jobId.slice(0, 8)}] Job started (${activeJobs.size}/${effectiveMaxConcurrent} concurrent) handler=${handler}`,
  );
  if (handler !== JOB_HANDLER_EPIC_DEV) {
    log('info', `[${job.jobId.slice(0, 8)}]   Steps: ${job.pipeline?.steps?.length || 0}`);
    log(
      'info',
      `[${job.jobId.slice(0, 8)}]   Agents: ${Object.keys(job.pipeline?.agents || {}).join(', ')}`,
    );
  }

  try {
    // Task B (2026-07-17) — clone-if-missing repo materialization. Plan-affinity
    // pins a plan's jobs to one machine, but a machine seeing the plan for the
    // first time has no checkout — repos move BETWEEN machines only via GitHub.
    // Plan-scoped jobs only; a failure throws → handleJobFailure marks FAILED
    // (loud, no silent skip). Inactive on fleet/EC2 (remap off) — exact no-op.
    await materializePlanWorkingDirIfMissing(job);
    if (handler === JOB_HANDLER_EPIC_DEV) {
      await executeEpicDevJob(job);
    } else if (handler === JOB_HANDLER_PARTY_BOOTSTRAP) {
      await executePartyBootstrapJob(job);
    } else if (handler === JOB_HANDLER_PARTY_INSPECT) {
      await executePartyInspectJob(job);
    } else if (handler === JOB_HANDLER_PARTY_TURN) {
      await executePartyTurnJob(job);
    } else if (handler === JOB_HANDLER_PARTY_DOCS_SYNC) {
      await executePartyDocsSyncJob(job);
    } else if (handler === JOB_HANDLER_PARTY_DOCS_UNLINK) {
      await executePartyDocsUnlinkJob(job);
    } else if (handler === JOB_HANDLER_PARTY_REFRESH) {
      await executePartyRefreshJob(job);
    } else if (handler === JOB_HANDLER_APP_BOOTSTRAP) {
      await executeAppBootstrapJob(job);
    } else if (handler === JOB_HANDLER_FREE_AGENT_SESSION) {
      await executeFreeAgentSessionJob(job);
    } else if (handler === JOB_HANDLER_QUEUE_REQUEST) {
      await executeQueueRequestJob(job);
    } else if (handler === JOB_HANDLER_WAVE_MERGE) {
      await executeWaveMergeJob(job);
    } else if (handler === JOB_HANDLER_SKILL_SCOUT) {
      await executeSkillScoutJob(job);
    } else if (handler === JOB_HANDLER_SKILL_INSTALL) {
      await executeSkillInstallJob(job);
    } else if (handler === JOB_HANDLER_REFLECTOR) {
      await executeReflectorJob(job);
    } else if (handler === JOB_HANDLER_SCORECARD_ASSESS) {
      await executeScorecardAssessJob(job);
    } else if (handler === JOB_HANDLER_REFACTOR_AUDIT) {
      await executeRefactorAuditJob(job);
    } else if (handler === JOB_HANDLER_ULTRACODE_BENCH) {
      await executeUltracodeBenchJob(job);
    } else if (handler === JOB_HANDLER_DUAL_AGENT_COMPARE) {
      await executeDualAgentCompareJob(job);
    } else if (handler === JOB_HANDLER_SCAN_ENGINE) {
      await executeScanEngineJob(job);
    } else if (handler === JOB_HANDLER_STORY_DEV) {
      await executeStoryDevJob(job);
    } else if (handler === JOB_HANDLER_QUICK_PLANSPEC) {
      await executeQuickPlanspecJob(job);
    } else if (handler === JOB_HANDLER_P3_QA) {
      await executeP3QaJob(job);
    } else if (handler === JOB_HANDLER_INTEGRATOR) {
      await executeIntegratorJob(job);
    } else {
      await executePipeline(job);
    }
  } catch (err) {
    log('error', `[${job.jobId.slice(0, 8)}] Job failed: ${err.message}`);
    try {
      await handleJobFailure(job, err);
    } catch (updateErr) {
      log('error', `[${job.jobId.slice(0, 8)}] Failure handler failed: ${updateErr.message}`);
    }
  } finally {
    activeJobs.delete(job.jobId);
    jobEventSeqs.delete(job.jobId);
    // Servers module (Task 18) — stop renewing and release the CAS lease,
    // preserving whatever terminal status the handler wrote (the release SET
    // re-asserts it while REMOVE-ing the claim fields). If the status can't
    // be read, skip the release: the lease simply expires and the sweeper's
    // orphan recovery clears it — never guess a terminal status.
    if (jobClaim) {
      clearInterval(jobClaim.renewTimer);
      try {
        const fresh = await ddb.send(
          new GetCommand({
            TableName: JOBS_TABLE,
            Key: { jobId: job.jobId },
            ProjectionExpression: '#s',
            ExpressionAttributeNames: { '#s': 'status' },
          }),
        );
        const finalStatus = fresh?.Item?.status;
        if (finalStatus) {
          await ddb.send(
            new UpdateCommand(
              buildJobReleaseParams({
                tableName: JOBS_TABLE,
                jobId: job.jobId,
                serverId: SERVER_ID,
                claimToken: jobClaim.claimToken,
                status: finalStatus,
              }),
            ),
          );
        }
      } catch (err) {
        // ConditionalCheckFailed = lease already expired/re-owned — fine.
        if (err?.name !== 'ConditionalCheckFailedException') {
          log('warn', `[${job.jobId.slice(0, 8)}] claim release failed: ${err.message}`);
        }
      }
    }
    // Story 20.16 — release the manager slot. Idempotent; double-release
    // is logged as a warn (helps catch lifecycle bugs without crashing).
    concurrencyManager.release(job.jobId);
    // 2026-05-27 PR B.c — spend instrumentation. One row per completed job.
    // Failures (including handleJobFailure) still get a row — we want to
    // count agent walltime regardless of outcome.
    try {
      await writeAgentSpendRow(job, jobStartMs);
    } catch (err) {
      log('warn', `[${job.jobId.slice(0, 8)}] spend log write failed: ${err.message}`);
    }
    // 2026-06-03 — QA send-back remediation merge. If this was a remediation
    // rerun (job.remediationMerge set by the send-back endpoint) and it reached
    // a SUCCESS state, enqueue a one-shot wave-merge so the fix on
    // `wip/<storyId>` is integrated into `plan/<slug>` (the branch QA reads).
    try {
      await enqueueRemediationMergeIfNeeded(job);
    } catch (err) {
      log('warn', `[${job.jobId.slice(0, 8)}] remediation-merge enqueue threw: ${err.message}`);
    }
    // Event-driven advancement (2026-05-30) — a terminal wave-merge or epic-dev
    // job is exactly what unblocks the next wave/epic. Poke the reducer NOW so
    // it dispatches immediately instead of waiting for the next cron tick.
    // Pipeline jobs only; party/free-agent/bootstrap don't drive wave advance.
    if (handler === JOB_HANDLER_WAVE_MERGE || handler === JOB_HANDLER_EPIC_DEV) {
      void triggerWaveReduce(`${handler}:${job.jobId.slice(0, 8)}`);
    }
  }
}

// 2026-06-03 — QA send-back remediation merge.
//
// A single-story QA send-back re-runs DEV in the story worktree and commits the
// fix to `wip/<storyId>` (forked from the current `plan/<slug>` tip, so the
// fix is a strict descendant → clean fast-forward). But the forward-only
// wave-reducer won't re-fire a completed wave's merge, so the fix never reaches
// `plan/<slug>` — the branch QA reads. This closes that gap: on terminal
// SUCCESS of a job tagged `remediationMerge`, enqueue a one-shot `wave-merge`
// job for just that story. The wave-merge runner forks at the plan tip, merges
// `wip/<storyId>`, runs the build gate, advance-on-green updates `plan/<slug>`,
// pushes origin, and reaps the wip branch + worktree. The operator then
// re-runs QA against the now-fixed plan branch.
const REMEDIATION_SUCCESS_STATUSES = new Set([
  'COMPLETED',
  'COMPLETED_VIA_PREWORK',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'MANUALLY_SKIPPED',
]);
async function enqueueRemediationMergeIfNeeded(job) {
  const rm = job?.remediationMerge;
  if (!rm) return;
  const short = job.jobId.slice(0, 8);
  // Re-read the terminal status — only integrate a fix that actually passed.
  // A rerun that failed review-runtime (or any gate) must NOT be merged.
  let fresh = null;
  try {
    fresh = await ddb
      .send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId: job.jobId } }))
      .then((r) => r.Item || null);
  } catch {
    fresh = null;
  }
  const status = fresh?.status || job.status;
  if (!REMEDIATION_SUCCESS_STATUSES.has(status)) {
    log(
      'info',
      `[${short}] remediation-merge SKIPPED — rerun status=${status} (not success); fix on wip/${rm.storyId.slice(0, 8)} NOT integrated into plan/${rm.planSlug}`,
    );
    return;
  }
  const mergeJobId = randomUUID();
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        jobId: mergeJobId,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        createdBy: job.createdBy || 'remediation-merge',
        workingDir: job.workingDir,
        jobType: 'wave-merge',
        waveMergePayload: {
          appId: rm.appId,
          planId: rm.planId,
          planSlug: rm.planSlug,
          epicId: rm.epicId,
          waveNumber: rm.waveNumber,
          storyIds: [rm.storyId],
          // Resolved daemon-side from the boilerplate registry (build gate).
          postMergeValidationCmd: null,
        },
        pipeline: { agents: {}, steps: [] },
        // Plan-affinity (+ self-assign when THIS server ran the parent rerun job):
        // the merge integrates the fix into plan/<slug> on the plan's worktree.
        ...planAffinityStamp({
          planId: rm.planId,
          parentJob: job,
          serverId: SERVER_ID,
          serverAware: serverAwareDispatch,
          nowIso: now,
        }),
      },
    }),
  );
  log(
    'info',
    `[${short}] remediation-merge ENQUEUED wave-merge ${mergeJobId.slice(0, 8)} for story ${rm.storyId.slice(0, 8)} → plan/${rm.planSlug}`,
  );
}

/**
 * 2026-05-27 PR B.c — write one spend row per completed job.
 *
 * Spend = walltime × AGENT_COST_PER_SEC (env, default 0.02). Wall-clock is
 * what we have; true token-level tracking is a deferred Phase 2 swap
 * behind the same `getDailySpend` query (per §9.5 RESOLVED).
 *
 * agentClass derivation is a best-effort categorization for forensic
 * queries — `other` is the default for jobTypes we don't explicitly map.
 */
const AGENT_SPEND_LOG_TABLE =
  process.env.AGENT_SPEND_LOG_TABLE || 'futurator-agent-spend-log';
const AGENT_COST_PER_SEC = (() => {
  const v = parseFloat(process.env.AGENT_COST_PER_SEC || '0.02');
  return Number.isFinite(v) && v >= 0 ? v : 0.02;
})();
const SPEND_TTL_SECONDS = 90 * 24 * 60 * 60;

function classifyAgentForSpend(job) {
  const t = job?.jobType || '';
  if (t.startsWith('party-')) return 'party';
  if (t === 'free-agent-session') return 'free-agent';
  if (t === 'app-bootstrap') return 'app-bootstrap';
  if (t === 'wave-merge' || t === 'epic-dev' || t === 'skill-scout' || t === 'skill-install' || t === 'reflector' || t === 'scorecard-assess' || t === 'refactor-audit' || t === 'ultracode-bench') {
    return 'pipeline-v2';
  }
  return 'other';
}

async function writeAgentSpendRow(job, jobStartMs) {
  const createdAt = new Date().toISOString();
  const walltimeSec = Math.max(0, (Date.now() - jobStartMs) / 1000);
  const costUsd = walltimeSec * AGENT_COST_PER_SEC;
  await ddb.send(
    new PutCommand({
      TableName: AGENT_SPEND_LOG_TABLE,
      Item: {
        logId: randomUUID(),
        jobId: job?.jobId,
        sessionId:
          job?.freeAgentSessionPayload?.sessionId ?? job?.partyTurnPayload?.sessionId ?? null,
        projectId:
          job?.projectId ??
          job?.freeAgentSessionPayload?.projectId ??
          job?.partyTurnPayload?.projectId ??
          null,
        agentClass: classifyAgentForSpend(job),
        walltimeSec,
        costUsd,
        createdAt,
        GSI1PK: createdAt.slice(0, 10), // UTC date
        GSI1SK: createdAt,
        expiresAt: Math.floor(Date.parse(createdAt) / 1000) + SPEND_TTL_SECONDS,
      },
    }),
  );
}


/**
 * Pipeline v2 Phase 3-C Epic 3 / Story 3.1 (2026-05-20) — SKILL-SCOUT
 * job runner. Reads the federation manifest + project skill manifest
 * from disk, spawns the SKILL-SCOUT agent step via executeStep, then
 * either auto-confirms (T1/T2/T5/T7 prototype + high confidence) by
 * calling applyConfirmedProposals directly, or surfaces a decision
 * card via writeAttentionItem.
 *
 * The single-step pipeline is baked into job.pipeline.steps[0] by
 * `generateSkillScoutPipeline` (functions/shared/pipelines/skill-scout-
 * pipeline.ts) at job-create time. This function just orchestrates the
 * lifecycle via runSkillScoutJob's injected-deps contract.
 */
async function executeSkillScoutJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  log('info', `[${short}] Routing to skill-scout pipeline`, {
    trigger: job.skillScoutPayload?.trigger,
    projectSlug: job.skillScoutPayload?.projectSlug,
    rigor: job.skillScoutPayload?.rigor,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'skill-scout',
    lastHeartbeatAt: new Date().toISOString(),
  });

  // Adapter: bridge runSkillScoutJob's executeAgentStep contract to the
  // daemon's module-scoped executeStep. The runner expects a return
  // shape of `{ variables, tokensConsumed }`; executeStep mutates the
  // variables object in-place and returns { allPassed, stepResult }.
  async function executeAgentStep(j, step, initialVars) {
    const variables = { ...initialVars };
    const sessions = {};
    const stepResults = [];
    const agents = j.pipeline?.agents || {};
    const workingDir = j.workingDir || `${DAEMON_PROJECTS_ROOT}/${j.skillScoutPayload.projectSlug}`;
    const { stepResult } = await executeStep(
      jobId,
      step,
      agents,
      workingDir,
      variables,
      sessions,
      stepResults,
    );
    return {
      variables,
      tokensConsumed:
        (stepResult?.inputTokens ?? 0) + (stepResult?.outputTokens ?? 0),
    };
  }

  // F26 — provide emitBulkProposal so a surface-card `add` discovery is routed
  // THROUGH the gate as a `bulk` skill-proposal (single trust authority) instead
  // of installing straight through the vendor step. The daemon role now has DDB
  // access to futurator-skill-proposals, so we write the row directly here,
  // mirroring functions/shared/skill-gate/index.ts fromBulk + putProposal's
  // SkillProposal shape. Best-effort: log + count, never fail the job.
  async function emitBulkProposal(args) {
    try {
      const now = new Date().toISOString();
      const proposalId = `${now.replace(/[-:T.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      const description = args.description || '';
      const body = args.body || '';
      const kind = args.kind || 'core';
      const gist = description.trim().slice(0, 140);
      const row = {
        proposalId,
        source: 'bulk',
        skillName: args.name,
        kind,
        proposedBody: body,
        // Gate would scan + label; the daemon writes the draft/vendored facets
        // directly (mirrors fromBulk → labelProposal output). The operator
        // ratifies it into the trusted registry from the inbox.
        proposedEntry: {
          name: args.name,
          kind,
          framework: false,
          version: 'sha:HEAD',
          license: 'UNKNOWN',
          description,
          provenanceClass: 'vendored',
          securityStatus: 'unverified',
          qualityGrade: 'ungraded',
          trustTier: 'draft',
          maturity: 0,
          lineage: { adaptedFrom: args.originRef ?? null },
        },
        gist,
        securityStatus: 'unverified',
        qualityGrade: 'ungraded',
        status: 'pending',
        createdAt: now,
        lineage: { adaptedFrom: args.originRef ?? null },
        // Provenance back-refs from the job for the inbox.
        planId: args.planId ?? null,
        projectSlug: job.skillScoutPayload?.projectSlug ?? args.appId ?? null,
      };
      await ddb.send(
        new PutCommand({
          TableName: process.env.SKILL_PROPOSALS_TABLE || 'futurator-skill-proposals',
          Item: row,
        }),
      );
      log('info', `[${short}] emitted bulk skill-proposal ${proposalId} (${args.name})`);
      return 1;
    } catch (err) {
      log('warn', `[${short}] emitBulkProposal failed for ${args?.name}: ${err?.message || err}`);
      return 0;
    }
  }

  try {
    const result = await runSkillScoutJob(job, {
      federationCache,
      getProjectPath: (slug) => `${DAEMON_PROJECTS_ROOT}/${slug}`,
      executeAgentStep,
      applyConfirmedProposals,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
      emitBulkProposal,
      pushEvent,
      validateSkillProposalsBlock,
    });

    if (result.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        skillScoutDisposition: result.disposition,
        skillScoutProposalCount: result.proposalCount ?? 0,
        skillScoutAcceptedCount: result.acceptedCount ?? 0,
      });
      log(
        'info',
        `[${short}] skill-scout completed (disposition=${result.disposition}, proposals=${result.proposalCount ?? 0})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
        skillScoutFailureReason: result.reason,
      });
      log('warn', `[${short}] skill-scout failed: ${result.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] skill-scout threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Pipeline v2 Phase 3-C Epic 3 / Story 3.6 (2026-05-20) — SKILL-INSTALL
 * job runner. Operator-confirmed installs land here from the API
 * Lambda's POST /api/skill-scout/proposals/:itemId/confirm path. Applies
 * the manifest deltas, re-runs vendor-skills, and commits to git with
 * `Agent: SKILL-SCOUT` trailer.
 */
async function executeSkillInstallJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  log('info', `[${short}] Routing to skill-install pipeline`, {
    projectSlug: job.skillInstallPayload?.projectSlug,
    source: job.skillInstallPayload?.source,
    proposalCount: job.skillInstallPayload?.output?.proposals?.length,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'skill-install',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    const result = await runSkillInstallJob(job, {
      applyConfirmedProposals,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
      pushEvent,
      getProjectPath: (slug) => `${DAEMON_PROJECTS_ROOT}/${slug}`,
    });

    if (result.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        skillInstallWritten: result.written,
        skillInstallVendoredCount: result.vendoredCount,
      });
      log(
        'info',
        `[${short}] skill-install completed (written=${result.written}, vendored=${result.vendoredCount})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
      });
      log('warn', `[${short}] skill-install failed: ${result.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] skill-install threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Epic 6 wire-in (2026-05-20) — REFLECTOR job runner. Plan-reducer
 * enqueues these at plan close; we wrap runReflectorJob with the
 * daemon's pushEvent + writeAttentionItem deps + (for v1) a stub
 * runAgentStep that returns empty proposals — the real prompt + parser
 * integration is the next iteration. With this scaffold in place,
 * the cron-replay-safe enqueue path is exercised end-to-end and rows
 * land in futurator-reflections (just none in v1 until the agent
 * step + Zod proposal parser is wired).
 */
async function executeReflectorJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  log('info', `[${short}] Routing to reflector pipeline`, {
    scope: job.reflectorPayload?.scope,
    planId: job.reflectorPayload?.planId,
    rigor: job.reflectorPayload?.rigor,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'reflector',
    lastHeartbeatAt: new Date().toISOString(),
  });

  // v1 SCAFFOLD: stub agent step. Next iteration replaces this with
  // R1 (pacman1 audit, 2026-06-12) — the REAL agent step. The v1 scaffold
  // returned empty proposals; 9 reflector jobs COMPLETED with zero rows in
  // futurator-reflections, ever, while the whole inbox→approve→CLAUDE.md/
  // skill loop sat wired and starved. Now: gather the run's evidence from
  // DDB (plan/epics summary, attention history, gate stage outcomes incl.
  // agent-fixed, gate-VQA claims), build the generic REFLECTOR prompt, and
  // spawn a read-only sonnet via the shared gate-agent spawn surface.
  async function runAgentStep(j) {
    const p = j.reflectorPayload;
    const evidenceBlocks = [];
    let planSummary = '';
    try {
      const planRes = await ddb.send(
        new GetCommand({ TableName: PLANS_TABLE, Key: { planId: p.planId } }),
      );
      const plan = planRes.Item || {};
      planSummary =
        `Plan ${plan.name || p.planId} · rigor ${plan.rigor || p.rigor} · status ${plan.status || '?'} · ` +
        `${plan.doneStories ?? '?'}/${plan.totalStories ?? '?'} stories done · cost $${plan.totalCostUsd ?? '?'}\n` +
        `Intent: ${(plan.intent || '').slice(0, 500)}`;

      // Epics: story outcomes + auto-minted fix stories + gate jobs.
      const gateJobIds = [];
      for (const epicId of plan.epicIds || []) {
        const epicRes = await ddb.send(
          new GetCommand({ TableName: EPICS_TABLE, Key: { epicId } }),
        );
        const epic = epicRes.Item;
        if (!epic) continue;
        const stories = Array.isArray(epic.stories) ? epic.stories : [];
        const failedOrRetried = stories.filter(
          (s) => s.status === 'failed' || s.origin === 'wave-vqa-fix',
        );
        if (failedOrRetried.length > 0) {
          evidenceBlocks.push({
            title: `Epic "${(epic.title || epicId).slice(0, 80)}" — stories that struggled`,
            body: failedOrRetried
              .map(
                (s) =>
                  `- [${s.origin === 'wave-vqa-fix' ? 'auto-minted fix story' : s.status}] ${s.title}`,
              )
              .join('\n'),
          });
        }
        for (const id of Object.values(epic.waveBuildJobs || {})) gateJobIds.push(id);
      }

      // Gate outcomes: real per-stage results + VQA claims (QA-D / QA-B data).
      const stageLines = [];
      const vqaLines = [];
      for (const gid of gateJobIds.slice(0, 20)) {
        const jr = await ddb.send(
          new GetCommand({ TableName: JOBS_TABLE, Key: { jobId: gid } }),
        );
        const wmr = jr.Item?.waveMergeResult;
        if (!wmr) continue;
        for (const s of wmr.stages || []) {
          if (s.status === 'fail' || s.fixedByAgent) {
            stageLines.push(
              `- gate stage "${s.key}" ${s.fixedByAgent ? 'failed then was repaired by the build-fix agent' : 'FAILED'} (cmd: ${s.cmd})`,
            );
          }
        }
        const vqa = wmr.vqa;
        if (vqa) {
          for (const v of vqa.verdicts || []) {
            if (v.result && v.result !== 'PASS') {
              vqaLines.push(`- visual claim ${v.acId} → ${v.result}: ${(v.observation || '').slice(0, 160)}`);
            }
          }
          for (const h of vqa.fixForward || []) {
            vqaLines.push(`- visual claim ${h.acId} fix-forwarded: ${(h.observed || '').slice(0, 160)}`);
          }
        }
      }
      if (stageLines.length > 0)
        evidenceBlocks.push({ title: 'Quality-gate failures and agent repairs', body: stageLines.join('\n') });
      if (vqaLines.length > 0)
        evidenceBlocks.push({ title: 'Visual verification findings (judged on merged code)', body: vqaLines.join('\n') });

      // Attention history — every card is a lesson candidate.
      const attn = await ddb.send(
        new QueryCommand({
          TableName: ATTENTION_ITEMS_TABLE,
          KeyConditionExpression: 'planId = :p',
          ExpressionAttributeValues: { ':p': p.planId },
          Limit: 50,
        }),
      );
      const cards = (attn.Items || []).map(
        (a) => `- [${a.category}/${a.severity}${a.status === 'resolved' ? '/resolved' : ''}] ${(a.title || '').slice(0, 140)}`,
      );
      if (cards.length > 0)
        evidenceBlocks.push({ title: 'Operator attention items raised during the run', body: cards.join('\n') });
    } catch (gatherErr) {
      log('warn', `[${short}] reflector evidence gathering partial: ${gatherErr.message}`);
    }

    const { buildReflectorAgentPrompt, parseReflectorOutput } = await import(
      './pipelines/reflector-runner.mjs'
    );
    const prompt = buildReflectorAgentPrompt({
      scope: p.scope,
      projectSlug: p.projectSlug,
      planSummary,
      evidenceBlocks,
    });
    const res = await spawnGateAgent({ role: 'reflector', prompt, cwd: job.workingDir }, { short });
    if (res?.ok === false) {
      throw new Error(`reflector agent spawn failed: ${(res.output || '').slice(-300)}`);
    }
    const proposals = parseReflectorOutput(res?.output || '');
    log('info', `[${short}] reflector produced ${proposals.length} proposal(s)`);
    return { proposals, tokensConsumed: 0 };
  }

  async function writeReflectionRow(row) {
    // Best-effort DDB write into futurator-reflections. The table
    // exists (per architecture.md §5.1) but has had no writers until
    // this commit. We use the daemon's existing ddb client.
    try {
      await ddb.send(
        new PutCommand({
          TableName: process.env.REFLECTIONS_TABLE || 'futurator-reflections',
          Item: {
            ...row,
            // R1 fix: the scaffold synthesized `reflectionId`, but the
            // table's SORT KEY is `id` — every write would have failed with
            // a key ValidationException the moment proposals stopped being
            // empty. Time-prefixed (ULID-shape per types/reflection.ts) so
            // the inbox's chronological ordering works.
            id: row.id || `${new Date().toISOString()}_${randomUUID().slice(0, 8)}`,
          },
        }),
      );
    } catch (err) {
      log('warn', `[${short}] reflection-row write failed: ${err?.message || err}`);
      throw err;
    }
  }

  try {
    const result = await runReflectorJob(job, {
      runAgentStep,
      writeReflectionRow,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
      pushEvent,
    });

    if (result.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        reflectorProposalCount: result.proposalCount ?? 0,
        reflectorWrittenCount: result.writtenCount ?? 0,
        reflectorStatus: result.status ?? 'completed',
      });
      log(
        'info',
        `[${short}] reflector completed (proposals=${result.proposalCount ?? 0}, written=${result.writtenCount ?? 0})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
      });
      log('warn', `[${short}] reflector failed: ${result.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] reflector threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Plan Retrospect — The Assessor (plan-retrospect-spec §4b). Wraps
 * `runScorecardAssessJob` with the daemon's surfaces: reads the API-written
 * deterministic stage row (ground-truth context), spawns a read-only sonnet via
 * the shared gate-agent surface to grade the stage's `[LLM]` criteria, and
 * merges the Assessor slices back onto the scorecard row. The composer runs
 * API-side on read, so this only persists; it never re-derives the numbers.
 */
async function executeScorecardAssessJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const p = job.scorecardAssessPayload || {};

  log('info', `[${short}] Routing to scorecard-assess (Assessor)`, {
    planId: p.planId,
    stage: p.stage,
    rubricVersion: p.rubricVersion,
  });

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'scorecard-assess',
    lastHeartbeatAt: new Date().toISOString(),
  });

  // Load the API-stored deterministic row → the ground-truth context block the
  // Assessor must treat as authoritative (it never re-derives numbers).
  async function loadDeterministicSlice({ planId, stage, rubricVersion }) {
    const row = await getStoredStageRow(ddb, { planId, stage, rubricVersion });
    if (!row) return null;
    const detLines = (row.slices || [])
      .filter((s) => s && s.verdict && s.verdict !== '⚪')
      .map((s) => {
        const v = typeof s.value === 'object' ? JSON.stringify(s.value) : s.value;
        return `- ${s.criterionId}: ${s.verdict} score=${s.score} value=${v}${s.note ? ` — ${s.note}` : ''}`;
      });
    let planSummary = `Plan ${planId} · stage ${stage}`;
    try {
      const planRes = await ddb.send(
        new GetCommand({ TableName: PLANS_TABLE, Key: { planId } }),
      );
      const plan = planRes.Item;
      if (plan) {
        planSummary =
          `Plan ${plan.name || planId} · rigor ${plan.rigor || '?'} · status ${plan.status || '?'} · ` +
          `${plan.doneStories ?? '?'}/${plan.totalStories ?? '?'} stories · cost $${plan.totalCostUsd ?? '?'}\n` +
          `Intent: ${(plan.intent || '').slice(0, 400)}`;
      }
    } catch (e) {
      log('warn', `[${short}] assessor plan-summary read partial: ${e?.message || e}`);
    }
    return {
      // criterionIds omitted → the runner falls back to its LLM_CRITERIA_BY_STAGE.
      rubricSlice: undefined,
      deterministicContext: detLines.length
        ? detLines.join('\n')
        : '(no deterministic verdicts stored for this stage)',
      planSummary,
    };
  }

  async function runAgentStep(j, prompt) {
    const res = await spawnGateAgent({ role: 'assessor', prompt, cwd: j.workingDir }, { short });
    if (res?.ok === false) {
      throw new Error(`assessor agent spawn failed: ${(res.output || '').slice(-300)}`);
    }
    return { output: res?.output || '', tokensConsumed: 0 };
  }

  try {
    const paused = await isAgentPausedCached();
    const result = await runScorecardAssessJob(job, {
      paused,
      loadDeterministicSlice,
      runAgentStep,
      writeAssessorSlices: (payload) => putAssessorSlices(ddb, payload),
      pushEvent,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
    });

    if (result.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        scorecardAssessStatus: result.status ?? 'completed',
        scorecardAssessSliceCount: result.sliceCount ?? 0,
        scorecardAssessGradedCount: result.gradedCount ?? 0,
      });
      log(
        'info',
        `[${short}] assessor completed (stage=${p.stage}, graded=${result.gradedCount ?? 0}/${result.sliceCount ?? 0})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
      });
      log('warn', `[${short}] assessor failed: ${result.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] assessor threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Ultracode-Reverse bench — daemon handler for a `jobType: 'ultracode-bench'` row.
 * Wires the real OAuth-safe `claude` spawns + the vendored scorers into the DI runner. The runner
 * orchestrates the symmetric two-`claude` rep loop (Case 1 native ultracode w/ capture+halt, Case 2
 * our meta-prompt), AST-parses both, structurally diffs, and writes the scorecard to the
 * ultracode-runs table. The kill-on-script-write halt + headless ultracode trigger are EC2-validated
 * (see docs/concepts/pipeline-v3/ultracode-bench-ec2-validation.md) — tainted reps are excluded.
 */
async function executeUltracodeBenchJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const p = job.ultracodeBenchPayload || {};
  log('info', `[${short}] Routing to ultracode-bench`, {
    runId: p.runId,
    intent: (p.intent || '').slice(0, 80),
    reps: p.reps,
  });
  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'ultracode-bench',
    lastHeartbeatAt: new Date().toISOString(),
  });

  // updateRun writes to the (additive) ultracode-runs table, keyed by runId. Mirrors updateJobFields.
  const updateRun = async (runId, fields) => {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    entries.push(['updatedAt', new Date().toISOString()]);
    const names = {};
    const values = {};
    const expr = [];
    for (const [k, v] of entries) {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      expr.push(`#${k} = :${k}`);
    }
    await ddb.send(
      new UpdateCommand({
        TableName: ULTRACODE_RUNS_TABLE,
        Key: { runId },
        UpdateExpression: `SET ${expr.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  };

  try {
    // The capture spawns `claude` with `cwd: job.workingDir` (a greenfield path the API mints as
    // /home/ubuntu/ultracode-bench/<runId>) — but nothing else provisions it (no repo clone/worktree
    // step for a greenfield bench). A non-existent cwd makes Node's spawn throw `spawn <bin> ENOENT`,
    // which masquerades as a missing binary. Ensure it exists first (pacman ultracode-bench, 2026-06-24).
    mkdirSync(job.workingDir, { recursive: true });
    const metaPrompt = readFileSync(new URL('./lib/ultracode/meta-prompt-v1.md', import.meta.url), 'utf8');
    // Persist the exact Case-2 meta-prompt that produced this run so the JSON export is
    // self-contained for the prompt-improvement loop (the agent edits the prompt it's given).
    await updateRun(p.runId, { metaPromptVersion: 'futurator-workflow-author-v1', metaPrompt });
    const capture = makeCaptureDeps({ claudeBin: CLAUDE_BIN, stripApiKey, loadOAuth, metaPrompt, log });
    const paused = await isAgentPausedCached();

    // True-cancel: the API's cancel route stamps cancelRequestedAt on the run row; the runner
    // polls this and kills the live claude children within one tick.
    const isCancelRequested = async (rid) => {
      try {
        const r = await ddb.send(
          new GetCommand({
            TableName: ULTRACODE_RUNS_TABLE,
            Key: { runId: rid },
            ProjectionExpression: 'cancelRequestedAt',
          }),
        );
        return Boolean(r?.Item?.cancelRequestedAt);
      } catch {
        return false; // a failed read must never cancel a healthy run
      }
    };

    const result = await runUltracodeBenchJob(job, {
      paused,
      captureCase1: capture.captureCase1,
      runCase2: capture.runCase2,
      parseScript: (js) => case1ToDecision(js),
      scorePlans: (a, b) => computeStructuralDiff(a, b),
      pushEvent,
      updateRun,
      isCancelRequested,
    });

    if (result.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        ultracodeBenchReps: result.reps ?? 0,
        ultracodeBenchTainted: result.tainted ?? 0,
        ...(result.cancelled ? { ultracodeBenchCancelled: true } : {}),
      });
      log(
        'info',
        `[${short}] ultracode-bench ${result.cancelled ? 'cancelled by operator' : 'completed'} (reps=${result.reps}, tainted=${result.tainted})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
      });
      log('warn', `[${short}] ultracode-bench failed: ${result.reason || result.error}`);
    }
  } catch (err) {
    await updateJobFields(jobId, { status: 'FAILED', errorMessage: err?.message || String(err) });
    log('error', `[${short}] ultracode-bench threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Refactoring Assessment Module (Epic B2) — daemon handler for a
 * `jobType: 'refactor-audit'` row. Spawns `recon.mjs` as a PLAIN NODE CHILD
 * (NOT spawnGateAgent — recon is deterministic and spends ~0 LLM tokens;
 * routing it through the agent path would burn OAuth budget and trip the auth
 * circuit-breaker). Streams stdout/stderr as `assess.*` events; on success
 * reads `hotspots.json` + `REPORT.md` and writes the summary onto the job row.
 * Report-only — it NEVER mutates the assessed code.
 */
/**
 * Dual-agent comparison harness — daemon handler for `jobType: 'dual-agent-compare'`.
 * Spawns TWO `claude` agents on the SAME question over the assessed app's clone:
 * Agent A with vanilla tools, Agent B additionally given the Mycelium graph MCP
 * (forced on regardless of MYCELIUM_MCP, since graph access IS the variable under
 * test). Captures each lane's answer/latency/tokens/cost/graph-tool usage and
 * denormalizes the result onto the job row. Read-only: agents never edit code,
 * and the clone never leaves the box.
 */
async function executeDualAgentCompareJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateDualAgentCompareJob(job);
  if (!validation.ok) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: `dual-agent-compare invalid: ${validation.reason}`,
    });
    log('warn', `[${short}] dual-agent-compare invalid: ${validation.reason}`);
    return;
  }

  const p = job.dualAgentComparePayload;
  const projectPath = p.projectPath || job.workingDir;

  // Same read-only safety boundary as refactor-audit: the clone must exist under
  // the party projects root. Never let an agent escape to another repo.
  if (!projectPath || !projectPath.startsWith(PARTY_PROJECTS_ROOT) || !existsSync(projectPath)) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: `dual-agent-compare refused: projectPath '${projectPath}' is not an existing path under ${PARTY_PROJECTS_ROOT}`,
    });
    log('warn', `[${short}] dual-agent-compare refused unsafe projectPath: ${projectPath}`);
    return;
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'dual-agent-compare',
    lastHeartbeatAt: new Date().toISOString(),
  });

  try {
    // Lane B's graph tools — forced on (not gated by MYCELIUM_MCP). Under
    // bypassPermissions, --mcp-config alone makes the tools available.
    const graphMcpArgs = myceliumMcpSpawnForced(undefined).args;
    const { captureLane } = makeDualAgentCapture({
      claudeBin: CLAUDE_BIN,
      stripApiKey,
      loadOAuth,
      graphMcpArgs,
      log,
    });

    const run = await runDualAgentCompare(
      {
        question: p.question,
        projectPath,
        model: p.model || 'opus',
        timeoutMs: p.timeoutMs || 240000,
      },
      {
        captureLane,
        // Adapt the runner's {type,...} events onto the daemon's event sink.
        pushEvent: ({ type, ...data }) => pushEvent(jobId, 'dual-agent-compare', null, type, data),
        log,
        jobId,
      },
    );

    if (run.ok) {
      await updateJobFields(jobId, {
        status: 'COMPLETED',
        dualAgentCompareResult: run.result,
      });
      log(
        'info',
        `[${short}] dual-agent-compare completed (A: ${run.result.agentA.latencyMs}ms / B: ${run.result.agentB.latencyMs}ms, B graph calls ${run.result.agentB.graphToolCalls})`,
      );
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: run.reason || 'unknown',
      });
      log('warn', `[${short}] dual-agent-compare failed: ${run.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, { status: 'FAILED', errorMessage: err?.message || String(err) });
    log('error', `[${short}] dual-agent-compare threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Refactoring Scan Engine v2 — daemon handler for `jobType: 'scan-engine'`.
 * Hybrid deterministic recon + LLM swarm. Runs recon.mjs + subsystem-decompose
 * + internal privacy (all ~0 LLM) deterministically, then a bounded swarm of
 * per-subsystem analyzers + cross-cutting passes (spawnGateAgent), maps + dedupes
 * into a dimension-tagged ScanFinding pool, generates a phased dependency-ordered
 * plan (char-net-gated), and writes the report. Report-only; clone never leaves
 * the box. The pure orchestration lives in runScanEngine; this wires real deps.
 */
async function executeScanEngineJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);

  const validation = validateScanEngineJob(job);
  if (!validation.ok) {
    await updateJobFields(jobId, { status: 'FAILED', errorMessage: `scan-engine invalid: ${validation.reason}` });
    log('warn', `[${short}] scan-engine invalid: ${validation.reason}`);
    return;
  }
  const p = job.scanEnginePayload;
  const projectPath = p.projectPath || job.workingDir;
  if (!projectPath || !projectPath.startsWith(PARTY_PROJECTS_ROOT) || !existsSync(projectPath)) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: `scan-engine refused: projectPath '${projectPath}' is not an existing path under ${PARTY_PROJECTS_ROOT}`,
    });
    log('warn', `[${short}] scan-engine refused unsafe projectPath: ${projectPath}`);
    return;
  }

  await updateJobFields(jobId, { status: 'RUNNING', phase: 'scan-engine', lastHeartbeatAt: new Date().toISOString() });

  // ── Operator cancel ──────────────────────────────────────────────────────
  // A scan is a long chain of child processes (npm install, graphify, knip,
  // eslint, the swarm). Poll the job row for `abortRequested`; when set, SIGKILL
  // this job's tracked children so the in-flight stage dies promptly. The current
  // stage then resolves with a non-zero code / throws, and we flip the job terminal
  // with a clean "cancelled" message (see the aborted checks below).
  let aborted = false;
  const abortPoll = setInterval(async () => {
    try {
      const row = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }));
      if (row?.Item?.abortRequested) {
        aborted = true;
        clearInterval(abortPoll);
        const n = signalChildrenForJob(jobId, 'SIGKILL');
        log('warn', `[${short}] scan-engine cancel requested — SIGKILLed ${n} child(ren)`);
      }
    } catch { /* transient DDB read error — try again next tick */ }
  }, 3000);

  const reconPath = new URL('./scripts/refactor-recon/recon.mjs', import.meta.url).pathname;
  const decomposePath = new URL('./scripts/refactor-recon/subsystem-decompose.mjs', import.meta.url).pathname;
  const privacyPath = new URL('./scripts/refactor-recon/privacy-scan-internal.mjs', import.meta.url).pathname;
  const testsPath = new URL('./scripts/refactor-recon/tests-detect.mjs', import.meta.url).pathname;
  const infraPath = new URL('./scripts/refactor-recon/infra-extract.mjs', import.meta.url).pathname;
  const eslintPath = new URL('./scripts/refactor-recon/eslint-detect.mjs', import.meta.url).pathname;
  const securityPath = new URL('./scripts/refactor-recon/security-scan.mjs', import.meta.url).pathname;
  const sddPath = new URL('./scripts/refactor-recon/sdd-detect.mjs', import.meta.url).pathname;
  const stackProfilePath = new URL('./scripts/refactor-recon/stack-profile.mjs', import.meta.url).pathname;
  const aiReadinessPath = new URL('./scripts/refactor-recon/ai-readiness.mjs', import.meta.url).pathname;
  const gitAnalyzePath = new URL('./scripts/refactor-recon/git-analyze.mjs', import.meta.url).pathname;

  // Spawn a plain Node child (deterministic stages — never the agent path).
  const spawnNode = (args, cwd) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: true,
      });
      registerChild(jobId, proc);
      let tail = '';
      proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
      proc.on('error', (err) => { unregisterChild(jobId, proc); resolve({ code: 1, tail: String(err?.message || err) }); });
      proc.on('close', (code) => { unregisterChild(jobId, proc); resolve({ code: code ?? 1, tail }); });
    });

  // Spawn an arbitrary command with a hard timeout — for the best-effort
  // `npm install` (so knip + eslint can resolve deps). NEVER fatal.
  const spawnCmd = (cmd, args, cwd, timeoutMs) =>
    new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, FORCE_COLOR: '0' }, detached: true });
      registerChild(jobId, proc);
      const timer = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } } }, timeoutMs);
      proc.on('error', () => { clearTimeout(timer); unregisterChild(jobId, proc); resolve({ code: 1 }); });
      proc.on('close', (code) => { clearTimeout(timer); unregisterChild(jobId, proc); resolve({ code: code ?? 1 }); });
    });

  // Install deps so knip (dead-code) + eslint (lint health) can run. --ignore-scripts
  // is a SECURITY boundary (never run an untrusted clone's postinstall). Best-effort.
  let depsInstalled = false;
  async function ensureDeps(repo) {
    if (!existsSync(pathJoin(repo, 'package.json'))) return;
    if (existsSync(pathJoin(repo, 'node_modules'))) { depsInstalled = true; return; }
    sePush('scan.deps.installing', {});
    const hasLock = existsSync(pathJoin(repo, 'package-lock.json'));
    const args = hasLock
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'];
    const r = await spawnCmd('npm', args, repo, 240000);
    depsInstalled = r.code === 0 && existsSync(pathJoin(repo, 'node_modules'));
    log('info', `[${short}] scan-engine npm ${args[0]} ${depsInstalled ? 'ok' : 'failed/timeout — knip+eslint degrade'}`);
    sePush('scan.deps.done', { ok: depsInstalled });
  }

  const sePush = (type, data = {}) => pushEvent(jobId, 'scan-engine', null, type, data);

  // Collect every real source file (relative) so the anchored-path guard drops
  // only HALLUCINATED paths, not real files graphify didn't node-ify.
  function walkSourceFiles(repo, into = new Set()) {
    const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
    const IGNORE = new Set(['node_modules', '.next', 'dist', 'out', 'build', '.git', 'coverage']);
    const walk = (dir) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        if (IGNORE.has(e.name)) continue;
        const full = pathJoin(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (EXTS.has(pathExtname(e.name)) && !e.name.endsWith('.d.ts')) into.add(pathRelative(repo, full));
      }
    };
    walk(repo);
    return into;
  }

  try {
    const result = await runScanEngine(job, {
      projectName: p.projectId || job.projectId,
      concurrency: 6,
      runRecon: async ({ projectPath: repo, src }) => {
        await ensureDeps(repo); // so recon's knip stage can resolve imports
        return spawnNode([reconPath, repo, ...(src ? ['--src', src] : [])], repo);
      },
      runDecompose: ({ projectPath: repo, cap }) =>
        spawnNode([decomposePath, pathJoin(repo, 'graphify-out'), '--repo', repo, ...(cap ? ['--cap', String(cap)] : [])], repo),
      readArtifacts: async ({ projectPath: repo, reuseDetectors }) => {
        const od = pathJoin(repo, 'graphify-out');
        const rj = (f) => { try { return JSON.parse(readFileSync(pathJoin(od, f), 'utf8')); } catch { return null; } };
        // reuseDetectors (targeted re-scan over unchanged structure): read the
        // detector outputs the PRIOR recon already wrote to graphify-out/ instead of
        // re-spawning them — ~0 wall-clock, keeps the maturity inputs identical.
        let privacySummary = null;
        let tests = null;
        let infra = null;
        let eslint = null;
        let security = null;
        let sdd = null;
        let stack = null;
        let aiReadiness = null;
        let gitEvolution = null;
        if (reuseDetectors) {
          const pr = rj('privacy.json');
          if (pr) privacySummary = summarizePrivacyReport(pr);
          tests = rj('tests.json');
          infra = rj('infra.json');
          eslint = rj('eslint.json');
          security = rj('security.json');
          sdd = rj('sdd.json');
          stack = rj('stack-profile.json');
          aiReadiness = rj('ai-readiness.json');
          gitEvolution = rj('git-evolution.json');
        } else {
          // Privacy/compliance lane. Default 'internal' (our own scanner, ~0 LLM,
          // source stays on the box); 'external' routes to the data-privacy service.
          try {
            if ((p.privacyMode || 'internal') === 'external') {
              const extPath = process.env.PRIVACY_RECON_PATH || '/opt/data-privacy-platform/scripts/privacy-recon.mjs';
              const svc = process.env.PRIVACY_SERVICE_URL || '';
              const token = process.env.PRIVACY_SERVICE_TOKEN || '';
              await spawnNode([extPath, repo, '--regulation', 'all', '--out', pathJoin(od, 'privacy.json'), ...(svc ? ['--service', svc] : []), ...(token ? ['--token', token] : [])], repo);
            } else {
              await spawnNode([privacyPath, repo, '--src', p.src || 'src', '--out', pathJoin(od, 'privacy.json')], repo);
            }
            const pr = rj('privacy.json');
            if (pr) privacySummary = summarizePrivacyReport(pr);
          } catch (pe) { log('warn', `[${short}] scan-engine privacy lane failed (non-fatal): ${pe?.message || pe}`); }
          // TDD-maturity detector — deterministic file-walk, always runnable.
          try {
            await spawnNode([testsPath, repo, '--out', pathJoin(od, 'tests.json')], repo);
            tests = rj('tests.json');
          } catch (te) { log('warn', `[${short}] scan-engine tests detector failed (non-fatal): ${te?.message || te}`); }
          // Infrastructure inventory — deterministic AWS/db/AI/3rd-party + IaC map.
          try {
            await spawnNode([infraPath, repo, '--src', p.src || 'src', '--out', pathJoin(od, 'infra.json')], repo);
            infra = rj('infra.json');
          } catch (ie) { log('warn', `[${short}] scan-engine infra extractor failed (non-fatal): ${ie?.message || ie}`); }
          // Eslint-health detector — runs the repo's own eslint (needs deps; best-effort).
          if (depsInstalled) {
            try {
              await spawnNode([eslintPath, repo, '--out', pathJoin(od, 'eslint.json')], repo);
              eslint = rj('eslint.json');
            } catch (ee) { log('warn', `[${short}] scan-engine eslint detector failed (non-fatal): ${ee?.message || ee}`); }
          }
          // Security & secrets/env-hygiene detector — deterministic, always runnable.
          try {
            await spawnNode([securityPath, repo, '--src', p.src || 'src', '--out', pathJoin(od, 'security.json')], repo);
            security = rj('security.json');
          } catch (se) { log('warn', `[${short}] scan-engine security detector failed (non-fatal): ${se?.message || se}`); }
          // SDD-readiness detector — content-signal (design intent anywhere), always runnable.
          try {
            await spawnNode([sddPath, repo, '--out', pathJoin(od, 'sdd.json')], repo);
            sdd = rj('sdd.json');
          } catch (de) { log('warn', `[${short}] scan-engine SDD detector failed (non-fatal): ${de?.message || de}`); }
          // Stack-profile detector — language/framework/archetype fingerprint, always runnable.
          try {
            await spawnNode([stackProfilePath, repo, '--out', pathJoin(od, 'stack-profile.json')], repo);
            stack = rj('stack-profile.json');
          } catch (spe) { log('warn', `[${short}] scan-engine stack-profile detector failed (non-fatal): ${spe?.message || spe}`); }
          // AI-readiness detector — Claude Code / skills / MCP / hooks fingerprint, always runnable.
          try {
            await spawnNode([aiReadinessPath, repo, '--out', pathJoin(od, 'ai-readiness.json')], repo);
            aiReadiness = rj('ai-readiness.json');
          } catch (are) { log('warn', `[${short}] scan-engine ai-readiness detector failed (non-fatal): ${are?.message || are}`); }
          // Git & Evolution detector — deterministic git-history read (churn/coupling/bus-factor), always runnable.
          try {
            await spawnNode([gitAnalyzePath, repo, '--out', pathJoin(od, 'git-evolution.json')], repo);
            gitEvolution = rj('git-evolution.json');
          } catch (ge) { log('warn', `[${short}] scan-engine git-analyze detector failed (non-fatal): ${ge?.message || ge}`); }
        }
        const graph = rj('graph.resolved.json') || rj('graph.json') || { nodes: [] };
        const resolved = rj('resolved-imports.json') || {};
        const hotspotsDoc = rj('hotspots.json') || {};
        // Graph-informed IaC (pass 2): annotate infra services with fanIn/centralized
        // using the resolved import graph. No-op when the graph is unavailable.
        const enrichedInfra = infra && graph ? enrichInfraWithGraph(infra, graph, resolved) : infra;
        return {
          hotspots: hotspotsDoc.hotspots || [],
          shards: rj('subsystem-shards.json') || { shards: [] },
          privacySummary,
          tests,
          infra: enrichedInfra,
          eslint,
          security,
          sdd,
          stack,
          aiReadiness,
          gitEvolution,
          // knip actually produced data? (else the clutter axis is degraded)
          knipRan: hotspotsDoc.toolStatus?.knip === 'ok',
          // Anchor = graphify nodes ∪ the REAL on-disk source files. graphify only
          // node-ifies reachable/parsed files (~1.5k here), so anchoring to it alone
          // dropped valid findings in real-but-ungraphed files (the "203 dropped"
          // over-drop). Walking the repo keeps the guard (hallucinated paths still
          // dropped) without losing real findings.
          anchoredPaths: walkSourceFiles(repo, new Set((graph.nodes || []).map((n) => n.source_file).filter(Boolean))),
          hubs: resolved.hubs || [],
        };
      },
      spawnAgent: async ({ role, prompt }) => {
        // jobId makes the swarm+report-writer children killable by the abort poller.
        const res = await spawnGateAgent({ role, prompt, cwd: projectPath, jobId }, { short });
        if (res?.ok === false) throw new Error(`scan agent ${role} failed: ${(res.output || '').slice(-200)}`);
        // Per-step attribution: the runner reads {output, tokens, costUsd}. Defensive
        // — usage is null when the CLI didn't emit a JSON envelope.
        return { output: res?.output || '', tokens: res?.usage?.tokens ?? null, costUsd: res?.usage?.costUsd ?? null };
      },
      checkGate: (planOutput) => findCharacterizationGateViolations(planOutput),
      // Targeted re-scan merges into the last persisted scan.json (fetched from S3).
      readPriorScan: async () => {
        try {
          const s3mod = await import('@aws-sdk/client-s3');
          if (!_s3Client) _s3Client = new s3mod.S3Client({ region: REGION });
          const bucket = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';
          const projectId = p.projectId || job.projectId;
          const res = await _s3Client.send(new s3mod.GetObjectCommand({ Bucket: bucket, Key: `knowledge-live/${projectId}/_refactor/scan.json` }));
          const body = await res.Body.transformToString();
          return JSON.parse(body);
        } catch (e) {
          log('info', `[${short}] scan-engine no prior scan.json to merge (${e?.name || e?.message || e})`);
          return null;
        }
      },
      // Can a targeted re-scan reuse the cached recon instead of rebuilding it?
      reconAvailable: ({ projectPath: repo }) => {
        const od = pathJoin(repo, 'graphify-out');
        return existsSync(pathJoin(od, 'subsystem-shards.json')) &&
          (existsSync(pathJoin(od, 'graph.resolved.json')) || existsSync(pathJoin(od, 'graph.json')));
      },
      // git-diff the files that changed since the last-scanned SHA (auto-target).
      changedFiles: (sinceSha) =>
        new Promise((resolve) => {
          if (!sinceSha) return resolve(null);
          const proc = spawn('git', ['-C', projectPath, 'diff', '--name-only', `${sinceSha}..HEAD`], {
            stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' },
          });
          let out = '';
          proc.stdout.on('data', (d) => { out += d.toString(); });
          proc.on('error', () => resolve(null));
          proc.on('close', (code) => resolve(code === 0 ? out.split('\n').map((s) => s.trim()).filter(Boolean) : null));
        }),
      shouldAbort: () => aborted,
      pushEvent: sePush,
      log,
    });

    // Operator cancelled mid-run — the killed child surfaced as a non-ok result (or
    // an empty one). Flip terminal with a clean message; don't persist a partial scan.
    if (aborted) {
      clearInterval(abortPoll);
      sePush('scan.cancelled', {});
      await updateJobFields(jobId, { status: 'FAILED', triggeredBy: 'OPERATOR_ABORT', errorMessage: 'scan cancelled by operator' });
      log('warn', `[${short}] scan-engine cancelled by operator`);
      return;
    }

    if (!result.ok) {
      await updateJobFields(jobId, { status: 'FAILED', errorMessage: `scan-engine: ${result.reason}` });
      log('warn', `[${short}] scan-engine failed: ${result.reason}`);
      return;
    }

    // Write the report into the clone (docs/refactoring-scan.md) for export.
    let reportPath = null;
    try {
      const docsDir = pathJoin(projectPath, 'docs');
      mkdirSync(docsDir, { recursive: true });
      reportPath = pathJoin(docsDir, 'refactoring-scan.md');
      writeFileSync(reportPath, result.reportMarkdown || '# Refactoring & System-Design Scan\n');
    } catch (we) { log('warn', `[${short}] scan-engine report write failed (non-fatal): ${we?.message || we}`); }

    // The clone's current HEAD — stamped on the scan so a later auto-target re-scan
    // can `git diff <scannedSha>..HEAD` and re-run only the changed subsystems.
    const scannedSha = await new Promise((resolve) => {
      try {
        const proc = spawn('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', (code) => resolve(code === 0 ? out.trim() : null));
      } catch { resolve(null); }
    });

    // Upload the full scan to S3 (the UI fetches it like graph.json).
    let scanAvailable = false;
    const projectId = p.projectId || job.projectId;
    try {
      const s3mod = await import('@aws-sdk/client-s3');
      if (!_s3Client) _s3Client = new s3mod.S3Client({ region: REGION });
      const bucket = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';
      await _s3Client.send(
        new s3mod.PutObjectCommand({
          Bucket: bucket,
          Key: `knowledge-live/${projectId}/_refactor/scan.json`,
          Body: JSON.stringify({
            findings: result.findings,
            phases: result.phases,
            planOutput: result.planOutput,
            gateViolations: result.gateViolations,
            counts: result.counts,
            lowConfidence: result.lowConfidence,
            maturity: result.maturity,
            infra: result.infra,
            iacPlan: result.iacPlan,
            stack: result.stack,
            aiReadiness: result.aiReadiness,
            gitEvolution: result.gitEvolution,
            // Per-step token/cost ledger produced by the runner (C-LEDGER shapes).
            timeline: result.timeline,
            cost: result.cost,
            reportMarkdown: result.reportMarkdown,
            // Provenance for granular re-scans: the merge key vocabulary + the SHA
            // an auto-target re-scan diffs against.
            scannedSha,
            mode: result.mode,
            scannedAt: new Date().toISOString(),
          }),
          ContentType: 'application/json',
          CacheControl: 'no-cache',
        }),
      );
      scanAvailable = true;
      // Also upload the file-level graph projection so the Graph tab populates
      // after a v2 scan (parity with the v1 audit path; closes the 403 on the
      // graph.json probe for v2-only apps).
      try {
        const graphUiPath = pathJoin(projectPath, 'graphify-out', 'graph-ui.json');
        if (existsSync(graphUiPath)) {
          await _s3Client.send(
            new s3mod.PutObjectCommand({
              Bucket: bucket,
              Key: `knowledge-live/${projectId}/_refactor/graph.json`,
              Body: readFileSync(graphUiPath),
              ContentType: 'application/json',
              CacheControl: 'no-cache',
            }),
          );
        }
      } catch (ge) { log('warn', `[${short}] scan-engine graph S3 upload failed (non-fatal): ${ge?.message || ge}`); }
    } catch (s3e) { log('warn', `[${short}] scan-engine S3 upload failed (non-fatal): ${s3e?.message || s3e}`); }

    // Durable record (status 'scan-v2') + denormalized summary on the row.
    const auditId = randomUUID();
    try {
      await ddb.send(
        new PutCommand({
          TableName: REFACTOR_AUDITS_TABLE,
          Item: {
            auditId,
            projectId,
            projectPath,
            jobId,
            status: 'scan-v2',
            counts: result.counts?.byDimension || {},
            hotspots: [],
            scanFindings: result.findings,
            phases: result.phases,
            plan: result.planOutput,
            gateViolations: result.gateViolations,
            lowConfidence: result.lowConfidence,
            scanAvailable,
            createdAt: new Date().toISOString(),
            createdBy: job.createdBy || 'daemon',
          },
        }),
      );
    } catch (ae) { log('warn', `[${short}] scan-engine durable-write failed (non-fatal): ${ae?.message || ae}`); }

    await updateJobFields(jobId, {
      status: 'COMPLETED',
      scanEngineSummary: {
        auditId,
        findingCount: result.findings.length,
        counts: result.counts,
        phaseCount: result.phases.length,
        gateViolations: result.gateViolations.length,
        lowConfidence: result.lowConfidence,
        scanAvailable,
        reportPath,
        maturity: result.maturity,
      },
    });
    log(
      'info',
      `[${short}] scan-engine completed (${result.findings.length} findings, ${result.phases.length} phases, ${result.gateViolations.length} gate-violations${result.lowConfidence ? ', LOW-CONFIDENCE decomposition' : ''})`,
    );
  } catch (err) {
    // A cancel SIGKILLs children mid-stage, which usually throws here — report it as
    // a clean cancellation (terminal, not a noisy failure that triggers retries).
    if (aborted) {
      sePush('scan.cancelled', {});
      await updateJobFields(jobId, { status: 'FAILED', triggeredBy: 'OPERATOR_ABORT', errorMessage: 'scan cancelled by operator' });
      log('warn', `[${short}] scan-engine cancelled by operator (mid-stage)`);
      return;
    }
    await updateJobFields(jobId, { status: 'FAILED', errorMessage: err?.message || String(err) });
    log('error', `[${short}] scan-engine threw: ${err?.message || err}`);
    throw err;
  } finally {
    clearInterval(abortPoll);
  }
}

async function executeRefactorAuditJob(job) {
  const { jobId } = job;
  const short = jobId.slice(0, 8);
  const p = job.refactorAuditPayload || {};
  const projectPath = p.projectPath || job.workingDir;

  log('info', `[${short}] Routing to refactor-audit (recon)`, {
    projectId: p.projectId,
    projectPath,
  });

  // FR17 — read-only safety: recon may only run inside the party projects root,
  // and the clone must exist. Never let an audit escape to e.g. the homepage repo.
  if (!projectPath || !projectPath.startsWith(PARTY_PROJECTS_ROOT) || !existsSync(projectPath)) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: `refactor-audit refused: projectPath '${projectPath}' is not an existing path under ${PARTY_PROJECTS_ROOT}`,
    });
    log('warn', `[${short}] refactor-audit refused unsafe projectPath: ${projectPath}`);
    return;
  }

  await updateJobFields(jobId, {
    status: 'RUNNING',
    phase: 'refactor-audit',
    lastHeartbeatAt: new Date().toISOString(),
  });

  const reconPath = new URL('./scripts/refactor-recon/recon.mjs', import.meta.url).pathname;

  // Spawn recon.mjs as a plain Node child (detached pgroup → killable on
  // timeout via registerChild). Resolves with the exit code + a stderr tail.
  async function runRecon({ projectPath: repo, src, skipGraphify, onChunk }) {
    return await new Promise((resolve) => {
      const args = [reconPath, repo];
      if (src) args.push('--src', src);
      if (skipGraphify) args.push('--skip-graphify');
      const proc = spawn(process.execPath, args, {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: true,
      });
      registerChild(jobId, proc);
      let stderrTail = '';
      proc.stdout.on('data', (d) => onChunk('stdout', d.toString()));
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-2000);
        onChunk('stderr', s);
      });
      proc.on('error', (err) => {
        unregisterChild(jobId, proc);
        resolve({ code: 1, stderrTail: String(err?.message || err) });
      });
      proc.on('close', (code, signal) => {
        unregisterChild(jobId, proc);
        resolve({ code: code ?? 1, killed: signal != null, stderrTail });
      });
    });
  }

  function readArtifacts({ projectPath: repo }) {
    const outDir = pathJoin(repo, 'graphify-out');
    const hs = JSON.parse(readFileSync(pathJoin(outDir, 'hotspots.json'), 'utf8'));
    const reportPath = pathJoin(outDir, 'REPORT.md');
    const hotspots = Array.isArray(hs.hotspots) ? hs.hotspots : [];
    return {
      hotspotCount: hotspots.length,
      counts: hs.counts && typeof hs.counts === 'object' ? hs.counts : {},
      // MVP transport — the full array rides the no-TTL job row so the
      // Lambda-served dashboard can render it (the EC2 disk is unreadable to
      // the API). ~27KB on applicator; well under the 400KB DDB item limit.
      hotspots,
      detectedCount: hs.detectedCount ?? hotspots.length,
      shownCount: hs.shownCount ?? hotspots.length,
      toolStatus: hs.toolStatus ?? {},
      reportPath: existsSync(reportPath) ? reportPath : null,
    };
  }

  // ── Data Privacy Assessment (parallel lane, opt-in via payload.runPrivacy) ──
  // privacy-recon is an independent deterministic child (rulepack-in, findings-out
  // to a local file; source never leaves). Runs CONCURRENTLY with the refactoring
  // recon — both finish in ~max(recon, privacy) not the sum.
  // privacyMode: 'internal' (default — our own deterministic scanner, fully
  // local, no network) | 'external' (the data-privacy-platform GDPR service).
  const privacyMode = job.refactorAuditPayload?.privacyMode || 'internal';
  const privacySrc = job.refactorAuditPayload?.src || 'src';
  function runPrivacyChild({ projectPath: repo, outPath, onChunk }) {
    const svc = process.env.PRIVACY_SERVICE_URL || '';
    const token = process.env.PRIVACY_API_KEY || '';
    const internalPath = new URL('./scripts/refactor-recon/privacy-scan-internal.mjs', import.meta.url).pathname;
    const reconPath =
      privacyMode === 'external'
        ? process.env.PRIVACY_RECON_PATH || '/opt/data-privacy-platform/scripts/privacy-recon.mjs'
        : internalPath;
    return new Promise((resolve) => {
      if (!existsSync(reconPath)) {
        resolve({ code: 1, stderrTail: `privacy scanner not found at ${reconPath}` });
        return;
      }
      // Internal: our scanner takes <repo> --src <src> --out. External: the
      // service runner takes <repo> --regulation all --service --token --out.
      const args =
        privacyMode === 'external'
          ? [reconPath, repo, '--regulation', 'all', '--out', outPath, ...(svc ? ['--service', svc] : []), ...(token ? ['--token', token] : [])]
          : [reconPath, repo, '--src', privacySrc, '--out', outPath];
      const proc = spawn(process.execPath, args, {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        detached: true,
      });
      registerChild(jobId, proc);
      let stderrTail = '';
      proc.stdout.on('data', (d) => onChunk('stdout', d.toString()));
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-2000);
        onChunk('stderr', s);
      });
      proc.on('error', (err) => { unregisterChild(jobId, proc); resolve({ code: 1, stderrTail: String(err?.message || err) }); });
      proc.on('close', (code, signal) => { unregisterChild(jobId, proc); resolve({ code: code ?? 1, killed: signal != null, stderrTail }); });
    });
  }

  try {
    const paused = await isAgentPausedCached();
    // Start privacy FIRST (non-blocking) so it overlaps recon.
    const privacyPromise = job.refactorAuditPayload?.runPrivacy
      ? runPrivacyAuditJob(job, {
          paused,
          runPrivacy: runPrivacyChild,
          readReport: async (p) => JSON.parse(readFileSync(p, 'utf8')),
          pushEvent,
          // Internal mode is fully local → no service host in the boundary note.
          serviceUrl: privacyMode === 'external' ? process.env.PRIVACY_SERVICE_URL || '' : '',
        }).catch((e) => ({ ok: false, reason: 'privacy-threw', error: String(e?.message || e) }))
      : null;

    const result = await runRefactorAuditJob(job, {
      paused,
      runRecon,
      readArtifacts,
      pushEvent,
      writeAttentionItem: (item) => writeAttentionItem(ddb, item, log),
    });

    if (result.ok && result.status === 'gated') {
      // Paused mid-flight — return to PENDING so the daemon re-picks it later.
      await updateJobFields(jobId, { status: 'PENDING' });
      log('info', `[${short}] refactor-audit gated (agent.paused) — re-queued`);
      return;
    }

    if (result.ok) {
      // Epic C — optional L3 adjudication (gated by payload.runL3). This IS an
      // LLM spend (spawnGateAgent), unlike recon. A self-contained inline prompt
      // (the .claude workflow + version-adjudicator are the operator-invocable
      // local equivalents, not shipped here). Best-effort: an L3 failure still
      // ships the recon-only audit.
      let l3 = null;
      if (job.refactorAuditPayload?.runL3 && (result.hotspots?.length ?? 0) > 0) {
        try {
          await pushEvent(jobId, 'assess.l3', 'L3-ADJUDICATOR', 'assess.l3.started', {
            hotspotCount: result.hotspots.length,
          });
          l3 = await runL3Adjudication(job, result.hotspots, {
            topN: job.refactorAuditPayload.topN,
            runL3Agent: async (prompt) => {
              const res = await spawnGateAgent(
                { role: 'l3-adjudicator', prompt, cwd: projectPath },
                { short },
              );
              if (res?.ok === false) throw new Error(`L3 agent spawn failed: ${(res.output || '').slice(-300)}`);
              return { output: res?.output || '' };
            },
          });
          await pushEvent(jobId, 'assess.l3', 'L3-ADJUDICATOR', 'assess.l3.completed', {
            confirmed: l3?.confirmed?.length ?? 0,
            rejected: (l3?.verdicts?.length ?? 0) - (l3?.confirmed?.length ?? 0),
            hasPlan: !!l3?.plan,
            // E1 — flag a mis-sequenced plan (deletion/repoint with no test net).
            gateViolations: l3?.gateViolations?.length ?? 0,
          });
          if (l3?.gateViolations?.length) {
            log('warn', `[${short}] L3 plan has ${l3.gateViolations.length} characterization-gate violation(s) — operator should review before executing`);
          }
        } catch (l3err) {
          log('warn', `[${short}] refactor-audit L3 stage failed (recon-only audit kept): ${l3err?.message || l3err}`);
          await pushEvent(jobId, 'assess.l3', 'L3-ADJUDICATOR', 'assess.l3.failed', {
            message: String(l3err?.message || l3err).slice(0, 500),
          });
        }
      }

      // Upload the file-level graph projection to S3 (scoped knowledge-live path,
      // CLAUDE.md-allowed) so the Assess Graph tab can render the real code graph
      // with communities + the hotspot overlay. Non-fatal. Done BEFORE the durable
      // write so graphAvailable is recorded on the row.
      let graphUploaded = false;
      try {
        const graphUiPath = pathJoin(projectPath, 'graphify-out', 'graph-ui.json');
        if (existsSync(graphUiPath)) {
          const s3mod = await import('@aws-sdk/client-s3');
          if (!_s3Client) _s3Client = new s3mod.S3Client({ region: REGION });
          const bucket = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';
          const projectId = job.refactorAuditPayload?.projectId || job.projectId;
          await _s3Client.send(
            new s3mod.PutObjectCommand({
              Bucket: bucket,
              Key: `knowledge-live/${projectId}/_refactor/graph.json`,
              Body: readFileSync(graphUiPath),
              ContentType: 'application/json',
              CacheControl: 'no-cache',
            }),
          );
          graphUploaded = true;
        }
      } catch (gerr) {
        log('warn', `[${short}] refactor-audit graph S3 upload failed (non-fatal): ${gerr?.message || gerr}`);
      }

      // Await the parallel privacy lane (started before recon). Best-effort: a
      // privacy failure never fails the refactoring audit. Full findings → S3
      // (export); the capped/grouped summary → the row + durable record.
      let privacySummary = null;
      if (privacyPromise) {
        try {
          const pr = await privacyPromise;
          if (pr?.ok && pr.summary) {
            privacySummary = pr.summary;
            // upload the FULL privacy report to a scoped S3 path for export.
            try {
              const s3mod = await import('@aws-sdk/client-s3');
              if (!_s3Client) _s3Client = new s3mod.S3Client({ region: REGION });
              const bucket = process.env.FUTURATOR_PUBLIC_BUCKET || 'futurator-ai-website';
              const projectId = job.refactorAuditPayload?.projectId || job.projectId;
              if (pr.report) {
                await _s3Client.send(
                  new s3mod.PutObjectCommand({
                    Bucket: bucket,
                    Key: `knowledge-live/${projectId}/_refactor/privacy.json`,
                    Body: JSON.stringify(pr.report),
                    ContentType: 'application/json',
                    CacheControl: 'no-cache',
                  }),
                );
                privacySummary.fullReportAvailable = true;
              }
            } catch (s3e) {
              log('warn', `[${short}] privacy S3 upload failed (non-fatal): ${s3e?.message || s3e}`);
            }
            log('info', `[${short}] privacy-audit completed (${privacySummary.totalDetected} findings, tier ${privacySummary.tier})`);
          } else if (pr && !pr.ok) {
            privacySummary = { failed: true, reason: pr.reason, error: String(pr.error || '').slice(0, 500) };
            log('warn', `[${short}] privacy-audit failed (non-fatal): ${pr.reason}`);
          }
        } catch (perr) {
          privacySummary = { failed: true, reason: 'privacy-threw', error: String(perr?.message || perr).slice(0, 500) };
        }
      }

      // Write the durable audit row (always — recon-only or adjudicated) so the
      // report survives the 7-day events TTL and the §9.4/9.5 endpoints can read it.
      const auditId = randomUUID();
      const adjudicated = !!(l3 && l3.ok);
      try {
        await ddb.send(
          new PutCommand({
            TableName: REFACTOR_AUDITS_TABLE,
            Item: {
              auditId,
              projectId: job.refactorAuditPayload?.projectId || job.projectId,
              projectPath,
              jobId,
              status: adjudicated ? 'adjudicated' : 'recon-only',
              counts: result.counts ?? {},
              hotspots: result.hotspots ?? [],
              graphAvailable: graphUploaded,
              detectedCount: result.detectedCount ?? result.hotspotCount ?? 0,
              shownCount: result.shownCount ?? result.hotspotCount ?? 0,
              toolStatus: result.toolStatus ?? {},
              ...(adjudicated ? { verdicts: l3.verdicts, plan: l3.plan } : {}),
              ...(privacySummary ? { privacy: privacySummary } : {}),
              createdAt: new Date().toISOString(),
              createdBy: job.createdBy || 'daemon',
            },
          }),
        );
      } catch (auditErr) {
        log('warn', `[${short}] refactor-audit durable-write failed (non-fatal): ${auditErr?.message || auditErr}`);
      }

      await updateJobFields(jobId, {
        status: 'COMPLETED',
        refactorAuditSummary: {
          hotspotCount: result.hotspotCount ?? 0,
          counts: result.counts ?? {},
          hotspots: result.hotspots ?? [],
          reportPath: result.reportPath ?? null,
          auditId,
          graphAvailable: graphUploaded,
          detectedCount: result.detectedCount ?? result.hotspotCount ?? 0,
          shownCount: result.shownCount ?? result.hotspotCount ?? 0,
          toolStatus: result.toolStatus ?? {},
          ...(privacySummary ? { privacy: privacySummary } : {}),
        },
      });
      log('info', `[${short}] refactor-audit completed (hotspots=${result.hotspotCount ?? 0}${adjudicated ? `, L3 confirmed=${l3.confirmed.length}` : ''}${privacySummary && !privacySummary.failed ? `, privacy=${privacySummary.totalDetected}` : ''})`);
    } else {
      await updateJobFields(jobId, {
        status: 'FAILED',
        errorMessage: result.error || result.reason || 'unknown',
      });
      log('warn', `[${short}] refactor-audit failed: ${result.reason}`);
    }
  } catch (err) {
    await updateJobFields(jobId, {
      status: 'FAILED',
      errorMessage: err?.message || String(err),
    });
    log('error', `[${short}] refactor-audit threw: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Pipeline Enhancement Plan v2 — Phase A.3. Decide between retrying the job
 * (re-queue as PENDING with a backoff) or marking it FAILED for good.
 * Non-retriable: shell-guard violations, auth failures, and jobs that
 * already exhausted MAX_RETRIES.
 */
async function handleJobFailure(job, err) {
  const message = err?.message || String(err);
  // Conversational turns (party-turn) must NEVER silently retry — a retry
  // re-emits `party.turn.user` with the same content and re-runs Claude,
  // producing a duplicate round in the UI. Fail visibly; the user sees the
  // error banner and chooses whether to resend.
  const isConversationalTurn = job.jobType === 'party-turn';
  // PR-6 (B+): AUTH_RECOVERY_EXHAUSTED is the wrapper's tag after 2 failed
  // OAuth re-reads. Treat it as a distinct nonRetriable category — the
  // attention item below uses 'auth-recovery-failed' instead of the generic
  // auth banner, and the job row carries triggeredBy='AUTH_RECOVERY_EXHAUSTED'.
  const isAuthRecoveryExhausted = err?.code === 'AUTH_RECOVERY_EXHAUSTED';
  const nonRetriable =
    err?.name === 'ShellGuardViolation' ||
    /OAuth expired|authentication expired|Not logged in|Please run \/login/i.test(message) ||
    isAuthRecoveryExhausted ||
    isConversationalTurn;

  // T0.3 — Pipeline v2.0 efficiency fix.
  // Story pipelines (per-story DEV→REVIEWER→COMPILER) get a tighter budget:
  // a no-op story that DEV genuinely fails on shouldn't retry up to the
  // generic 3-attempt ladder ($5+ per attempt). Default 2 attempts (1 retry).
  // T0.1 catches the COST_HARD-after-DONE case; this is the safety net for
  // genuine pre-DONE failures.
  const isStoryPipeline = Boolean(job.pipeline?.initialVariables?.STORY_ID);
  const effectiveMaxRetries = isStoryPipeline ? STORY_PIPELINE_MAX_RETRIES : MAX_RETRIES;

  const currentAttempt = job.retryAttempt || 0;
  const nextAttempt = currentAttempt + 1;
  const canRetry = !nonRetriable && nextAttempt <= effectiveMaxRetries;

  if (canRetry) {
    // Story pipelines reuse the same backoff ladder, just truncated.
    const delayMs = RETRY_DELAYS_MS[currentAttempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    const retryAfter = new Date(Date.now() + delayMs).toISOString();
    log(
      'warn',
      `[${job.jobId.slice(0, 8)}] retry ${nextAttempt}/${effectiveMaxRetries} scheduled for ${retryAfter} (delay ${delayMs}ms)${isStoryPipeline ? ' [story-pipeline]' : ''}`,
    );
    await updateJobFields(job.jobId, {
      status: 'PENDING',
      retryAttempt: nextAttempt,
      retryAfter,
      errorMessage: `retry ${nextAttempt}/${effectiveMaxRetries} queued: ${message}`.slice(0, 500),
    });
    return;
  }

  // PR-6 (B+): if auth recovery was exhausted, mark NEEDS_ATTENTION (not
  // FAILED) so the operator can re-authorize and click Retry — at which
  // point PR-6 (A)'s resume-from-session takes over and the work isn't
  // re-done from scratch.
  if (isAuthRecoveryExhausted) {
    await updateJobFields(job.jobId, {
      status: 'NEEDS_ATTENTION',
      errorMessage:
        `OAuth recovery failed after ${err?.authRecoveryAttempts || 2} reload attempts: ${message}`.slice(
          0,
          500,
        ),
      triggeredBy: 'AUTH_RECOVERY_EXHAUSTED',
    });
    try {
      const planId = await resolvePlanIdFromEpicId(ddb, job.epicId);
      if (planId) {
        await writeAttentionItem(
          ddb,
          {
            planId,
            // PR-7 (G): plan-scoped, not job-scoped — repeated auth-recovery
            // failures across different jobs in the same plan dedupe to one
            // row. Operator's action (Re-Authorize) fixes them all at once.
            dedupKey: `auth-recovery-failed:${planId}`,
            severity: 'critical',
            category: 'auth-recovery-failed',
            title: 'OAuth recovery exhausted — re-authorize required',
            body:
              `The daemon attempted ${err?.authRecoveryAttempts || 2} OAuth reloads ` +
              `but the access token remained invalid. Click "Re-Authorize" in the ` +
              `admin UI to push fresh tokens from your Mac Keychain to EC2. After ` +
              `that, click Retry on this job — the resume-from-session path will ` +
              `pick up where the agent left off without re-running completed steps.`,
            context: {
              jobId: job.jobId,
              epicId: job.epicId,
              storyId: job.pipeline?.initialVariables?.STORY_ID,
              authRecoveryAttempts: err?.authRecoveryAttempts || 2,
            },
            suggestedActions: [
              { label: 'Re-Authorize', kind: 'open-logs' /* admin-ui surfaces auth banner */ },
              { label: 'Retry step', kind: 'retry-step' },
              { label: 'Open logs', kind: 'open-logs' },
            ],
          },
          log,
        );
      }
    } catch (attnErr) {
      log('error', `Failed to write auth-recovery-failed attention item: ${attnErr.message}`);
    }
    return;
  }

  // Final failure: mark FAILED and emit a retry-exhausted attention item
  // (skip the attention item for non-retriable auth errors — operator needs
  // to see the fix-auth banner, not a stale item).
  await updateJobFields(job.jobId, {
    status: 'FAILED',
    errorMessage: nonRetriable
      ? message
      : `retry exhausted after ${effectiveMaxRetries} attempts: ${message}`,
    // T0.3 — surface the trigger reason on the job row so the UI can
    // disambiguate "step failed once" from "exhausted dev budget".
    ...(isStoryPipeline && !nonRetriable ? { triggeredBy: 'DEV_RETRY_BUDGET_EXHAUSTED' } : {}),
  });

  if (!nonRetriable) {
    try {
      const planId = await resolvePlanIdFromEpicId(ddb, job.epicId);
      if (planId) {
        // T0.3: distinct attention category for story-pipeline budget exhaustion
        // so operators can spot dev-loop pathologies at a glance and the inbox
        // can render targeted resolution actions (Salvage with last
        // WORK_SUMMARY vs. generic Retry).
        const category = isStoryPipeline ? 'dev-retry-exhausted' : 'retry-exhausted';
        const title = isStoryPipeline
          ? `Story DEV exhausted retry budget (${effectiveMaxRetries + 1} attempts)`
          : `Step failed after ${effectiveMaxRetries} retries`;
        const body = isStoryPipeline
          ? `Story DEV step failed ${effectiveMaxRetries + 1} time(s) without emitting ---DONE---. ` +
            `If the scaffold already implements the AC, salvage with the last WORK_SUMMARY. ` +
            `Final error: ${message.slice(0, 300)}`
          : `Step exhausted its retry budget (${RETRY_DELAYS_MS.map(
              (d) => `${Math.round(d / 1000)}s`,
            ).join(' / ')}). Final error: ${message.slice(0, 300)}`;
        // PR-7 (G): one row per (story, exhaustion-category). A retry that
        // fails again bumps recurrence; a successful retry auto-resolves
        // the row via PR-7 (I) in executePipeline.
        const storyId = job.pipeline?.initialVariables?.STORY_ID;
        const dedupKey =
          isStoryPipeline && storyId ? `${category}:${storyId}` : `${category}:${job.jobId}`;
        await writeAttentionItem(
          ddb,
          {
            planId,
            dedupKey,
            severity: 'high',
            category,
            title,
            body,
            context: {
              jobId: job.jobId,
              epicId: job.epicId,
              ...(isStoryPipeline ? { storyId } : {}),
            },
            suggestedActions: isStoryPipeline
              ? [
                  { label: 'Salvage with last WORK_SUMMARY', kind: 'salvage-step' },
                  { label: 'Retry step', kind: 'retry-step' },
                  { label: 'Skip story', kind: 'skip-step' },
                  { label: 'Open logs', kind: 'open-logs' },
                ]
              : [
                  { label: 'Retry step', kind: 'retry-step' },
                  { label: 'Open logs', kind: 'open-logs' },
                  { label: 'Open story', kind: 'open-story' },
                ],
          },
          log,
        );
      }
    } catch (attnErr) {
      log('error', `Failed to write retry-exhausted attention item: ${attnErr.message}`);
    }
  }
}

// FIX 1a — one-time boot sweep for orphaned scan-engine jobs. A daemon restart
// loses the in-memory child tracker, so a scan that was mid-flight sits RUNNING
// forever and sticks the UI on "scanning…". Flip any scan-engine job left RUNNING
// with a stale heartbeat to FAILED so the operator can re-launch. Never touches a
// job currently running on THIS daemon (activeJobs), and is best-effort.
async function reapOrphanedScanJobs() {
  const SCAN_ORPHAN_STALE_MS = 8 * 60 * 1000;
  try {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :running',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':running': 'RUNNING' },
        Limit: 50,
      }),
    );
    if (!Items || Items.length === 0) return;
    const now = Date.now();
    const orphans = Items.filter((j) => {
      if (j.jobType !== 'scan-engine') return false;
      if (activeJobs.has(j.jobId)) return false; // owned by this daemon — not dead
      const beatAt =
        Date.parse(j.lastHeartbeatAt || j.updatedAt || j.createdAt || '') || 0;
      return now - beatAt > SCAN_ORPHAN_STALE_MS;
    });
    for (const job of orphans) {
      try {
        await updateJobFields(job.jobId, {
          status: 'FAILED',
          errorMessage: 'orphaned by daemon restart',
          triggeredBy: 'RETRY_EXHAUSTED',
        });
        log('warn', `[${job.jobId.slice(0, 8)}] orphaned scan-engine job reaped → FAILED (daemon restart)`);
      } catch (err) {
        log('error', `Failed to reap orphaned scan-engine job ${job.jobId.slice(0, 8)}: ${err.message}`);
      }
    }
    if (orphans.length) log('info', `Boot sweep: reaped ${orphans.length} orphaned scan-engine job(s)`);
  } catch (err) {
    log('warn', `[boot] scan-engine orphan sweep failed (non-blocking): ${err.message}`);
  }
}

// One-time boot sweep for orphaned ultracode-bench RUNS. A daemon restart kills the
// live capture children, but nothing finalized the run ROW — it sat CAPTURING forever
// and the bench UI spun on it with no way to stop (deploy-restart incident 2026-07-11,
// run cf9e7e6a). Any run still mid-flight at boot is by definition dead: its claude
// children died with the previous daemon process. QUEUED rows are NOT touched (their
// PENDING job survives the restart and will be claimed normally).
async function reapOrphanedUltracodeRuns() {
  try {
    const { Items } = await ddb.send(
      new ScanCommand({
        TableName: ULTRACODE_RUNS_TABLE,
        FilterExpression: '#s IN (:capturing, :scoring, :halted)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':capturing': 'CAPTURING',
          ':scoring': 'SCORING',
          ':halted': 'HALTED',
        },
        ProjectionExpression: 'runId',
      }),
    );
    for (const it of Items || []) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: ULTRACODE_RUNS_TABLE,
            Key: { runId: it.runId },
            UpdateExpression:
              'SET #s = :err, case1Status = :e, case2Status = :e, errorMessage = :msg, updatedAt = :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':err': 'ERROR',
              ':e': 'ERROR',
              ':msg': 'interrupted: daemon restarted mid-run',
              ':now': new Date().toISOString(),
            },
          }),
        );
        log('warn', `[${String(it.runId).slice(0, 8)}] orphaned ultracode-bench run finalized → ERROR (daemon restart)`);
      } catch (err) {
        log('error', `Failed to finalize orphaned ultracode run ${String(it.runId).slice(0, 8)}: ${err.message}`);
      }
    }
  } catch (err) {
    log('warn', `[boot] ultracode-run orphan sweep failed (non-blocking): ${err.message}`);
  }
}

async function poll() {
  log('info', 'Agent daemon started');
  // Print a deploy fingerprint so logs make stale deploys obvious. The
  // 2026-05-02 dino1 incident took hours to diagnose because the daemon
  // was running 2-week-old code from before PR-11/12/13 — yet logs gave
  // no indication of which version was live. SHA-256 over agent-daemon.mjs
  // identifies the bytes; mtime ties it to a calendar date.
  try {
    const selfPath = new URL(import.meta.url).pathname;
    const buf = readFileSync(selfPath);
    const sha = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const stat = statSync(selfPath);
    log(
      'info',
      `  Build:      sha256=${sha} mtime=${stat.mtime.toISOString()} bytes=${buf.length}`,
    );
  } catch (err) {
    log('warn', `  Build:      <fingerprint failed: ${err.message}>`);
  }
  log('info', `  Region:     ${REGION}`);
  log('info', `  Jobs table: ${JOBS_TABLE}`);
  log('info', `  Events:     ${EVENTS_TABLE}`);
  log('info', `  Interval:   ${POLL_INTERVAL}ms`);
  log(
    'info',
    `  Concurrency: ${MAX_CONCURRENT} jobs (ConcurrencyManager ${CONCURRENCY_MANAGER_ENABLED ? 'enabled — interactive-first' : 'disabled — legacy FIFO'})`,
  );
  log('info', `  Claude:     ${CLAUDE_BIN}`);
  log('info', `  OAuth file: ${OAUTH_CREDS_PATH}`);

  // Pipeline-3 — fact-force memo TTL sweep (development-plan §9, open-question 7).
  // Mandatory before enforce-at-scale; harmless (unref'd interval) otherwise.
  try {
    startGateMemoSweep();
    log('info', '  Gate memo:  30-min TTL sweep started');
  } catch (err) {
    log('warn', `  Gate memo:  sweep start failed (non-blocking): ${err.message}`);
  }

  // Servers module (Task 19, spec §6) — fleet daemons pull fresh Claude OAuth
  // creds from the admin API before their first loadOAuth/probeAuth so a
  // freshly-provisioned server boots authenticated. No-op when ENROLL_TOKEN
  // is unset (EC2/local seeded daemons).
  await maybeFetchAgentCredentials('boot');

  loadOAuth('startup');
  await probeAuth();

  // NDJSON event forwarder: tails per-job logs written by emit-event.sh and
  // mirrors them into the events table with monotonic eventSeq + idempotent puts.
  try {
    const store = createDdbEventStore({ ddb, tableName: EVENTS_TABLE });
    ndjsonForwarder = createNdjsonForwarder({
      logDir: EVENT_LOG_DIR,
      store,
      pollMs: FORWARDER_POLL_MS,
      logger: {
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
        info: () => {},
      },
    });
    await ndjsonForwarder.start();
    log('info', `NDJSON forwarder started`, { logDir: EVENT_LOG_DIR, pollMs: FORWARDER_POLL_MS });
  } catch (err) {
    log('error', `NDJSON forwarder failed to start: ${err.message}`);
  }

  // Loopback HTTP receiver for wave-complete / heartbeat from orchestrator subagents.
  try {
    // epicRepo is module-scope (hoisted for shared use with PR-4 touch-point
    // inference); the receiver passes it through to its handlers.
    daemonReceiver = createDaemonReceiver({
      ddb,
      jobsTable: JOBS_TABLE,
      epicRepo,
      logger: {
        warn: (msg) => log('warn', msg),
        error: (msg) => log('error', msg),
        info: (msg) => log('info', msg),
      },
    });
    const addr = await daemonReceiver.listen(DAEMON_RECEIVER_PORT, '127.0.0.1');
    log('info', `Daemon receiver listening`, { host: addr.address, port: addr.port });
  } catch (err) {
    log('error', `Daemon receiver failed to start: ${err.message}`);
  }

  // Re-check OAuth + probe on a slow interval. The Mac helper pushes fresh
  // tokens on a similar cadence (and on-demand via the UI button), so we
  // don't need to spin.
  setInterval(() => {
    loadOAuth('interval');
    probeAuth()
      .then(() => {
        // Servers module (Task 19, spec §6) — a failed probe on a fleet
        // daemon may mean its local creds file is stale relative to the
        // last Re-auth push; pull the current one from the admin API.
        // No-op when ENROLL_TOKEN is unset (EC2/local seeded daemons).
        if (!authState.valid) {
          maybeFetchAgentCredentials('probe-failure').catch((e) =>
            log('error', `[creds-fetch:probe-failure] uncaught: ${e.message}`),
          );
        }
      })
      .catch((e) => log('error', `Auth probe failed: ${e.message}`));
  }, AUTH_PROBE_INTERVAL_MS).unref();

  // 2026-05-27 (unification) — one-shot startup migration. Removes the legacy
  // `/home/ubuntu/free-agent-worktrees/` root, marks in-flight free-agent
  // sessions as EXPIRED, and writes a sentinel so subsequent restarts skip
  // the work. Best-effort: failures are logged but don't block daemon boot.
  try {
    await maybeRunUnificationMigration({
      sessionsRepo: buildFreeAgentSessionsRepoFacade(),
      log: (level, msg, ctx) => log(level, msg, ctx),
    });
  } catch (err) {
    log('error', `[unification-migration] uncaught failure: ${err.message}`);
  }

  // FIX 1a — reap scan-engine jobs orphaned RUNNING by a prior daemon crash/restart.
  await reapOrphanedScanJobs();

  // Finalize ultracode-bench runs orphaned mid-flight by a prior restart (zombie-spinner fix).
  await reapOrphanedUltracodeRuns();

  // 2026-05-19 — Phase 1 worktree rollout. Hourly reaper for per-story
  // worktrees + coordinator worktrees + node_modules store entries +
  // (since 2026-05-27 unification) the `_assist` namespace.
  // First run after 5 min so the daemon doesn't reap stuff during
  // startup race windows. See docs/concepts/pipeline-v2/worktree-rollout-design.md §3.
  startReaperTicker(
    {
      log,
      // Story-row lookup: find a story by (appId, planSlug, storyId).
      // We don't have a direct (appId, planSlug, storyId) → story index;
      // walk the epics under the plan and find the story by id.
      findStoryByIds: async ({ appId, planSlug, storyId }) => {
        const plan = await ddb
          .send(
            new ScanCommand({
              TableName: PLANS_TABLE,
              FilterExpression: '#nm = :nm AND appId = :app',
              ExpressionAttributeNames: { '#nm': 'name' },
              ExpressionAttributeValues: { ':nm': planSlug, ':app': appId },
              Limit: 1,
            }),
          )
          .then((r) => r.Items?.[0] || null)
          .catch(() => null);
        if (!plan || !Array.isArray(plan.epicIds)) return null;
        for (const epicId of plan.epicIds) {
          const epic = await ddb
            .send(new GetCommand({ TableName: EPICS_TABLE, Key: { epicId } }))
            .then((r) => r.Item || null)
            .catch(() => null);
          if (!epic || !Array.isArray(epic.stories)) continue;
          const s = epic.stories.find((x) => x?.storyId === storyId);
          if (s) return s;
        }
        return null;
      },
      getJobById: async (jobId) => {
        return ddb
          .send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }))
          .then((r) => r.Item || null)
          .catch(() => null);
      },
      findPlanByAppAndSlug: async (appId, planSlug) => {
        return ddb
          .send(
            new ScanCommand({
              TableName: PLANS_TABLE,
              FilterExpression: '#nm = :nm AND appId = :app',
              ExpressionAttributeNames: { '#nm': 'name' },
              ExpressionAttributeValues: { ':nm': planSlug, ':app': appId },
              Limit: 1,
            }),
          )
          .then((r) => r.Items?.[0] || null)
          .catch(() => null);
      },
      // Story 20.15 — wire the party-session lookup into the reaper deps.
      // This lights up Story 19.7's no-op classifier: party worktrees
      // under /home/ubuntu/worktrees/<app>/_party/<sidShort>/ are now
      // evaluated for reap based on session.status + session.updatedAt
      // age (>7 days terminal + stale → reap).
      findPartySessionByShort: partyFindBySessionIdShort,
      // 2026-05-27 (unification) — wire the free-agent-session lookup
      // into the reaper deps. Activates the `_assist` namespace classifier
      // (see worktree-reaper.mjs `classifyAssistWorktree`).
      findFreeAgentSessionByShort: freeAgentFindBySessionIdShort,
    },
    {
      intervalMs: 60 * 60 * 1000, // 1 hour
      initialDelayMs: 5 * 60 * 1000, // 5 min
    },
  );

  // 2026-05-27 PR D.b — Rung 5 attention-items poller. 30s cadence; gated
  // by `agent.paused` (same flag as the main poll loop) so the operator's
  // [⏸ Pause agent] stops autotriggers too. First tick after 60s to avoid
  // probing DDB during the daemon's startup race window.
  startAttentionPoller(
    {
      isPaused: isAgentPausedCached,
      scanOpenItems: scanOpenAttentionItems,
      getPolicy: getRemediationPolicy,
      claimForAgent: claimAttentionItemForAgent,
      enqueueSession: enqueueFreeAgentSessionFromAttention,
      log: (level, msg, ctx) => log(level, msg, ctx),
    },
    { intervalMs: 30_000, initialDelayMs: 60_000 },
  );

  // Skills Institution Story 1.2 — reflection-apply poller. Confirmed
  // reflections are landed on disk by REFLECTOR-APPLY (authors the app-evolved
  // SKILL.md, Gate-1-scanned, commits). 60s cadence, gated by `agent.paused`.
  // All I/O lives in these closures (raw DDB + fs) so the poller module stays
  // pure + unit-tested. The working dir is the project's trunk checkout under
  // PROJECTS_ROOT; a row whose repo isn't checked out is skipped (retried next
  // tick), never stamped.
  const REFLECTIONS_TABLE = process.env.REFLECTIONS_TABLE || 'futurator-reflections';
  startReflectionApplyPoller(
    {
      isPaused: isAgentPausedCached,
      listConfirmed: async () => {
        const out = [];
        let ExclusiveStartKey;
        do {
          const res = await ddb.send(
            new ScanCommand({
              TableName: REFLECTIONS_TABLE,
              FilterExpression: '#status = :confirmed AND attribute_not_exists(appliedAt)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':confirmed': 'confirmed' },
              ExclusiveStartKey,
            }),
          );
          if (res.Items) out.push(...res.Items);
          ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return out;
      },
      resolveWorkingDir: (projectSlug) => {
        const dir = pathJoin(PARTY_PROJECTS_ROOT, projectSlug);
        return existsSync(dir) ? dir : null;
      },
      applyReflection,
      markApplied: async ({ projectSlug, id, outcome, commitSha, error }) => {
        const sets = ['appliedAt = :now', 'applyOutcome = :outcome'];
        const values = { ':now': new Date().toISOString(), ':outcome': outcome };
        if (commitSha) {
          sets.push('appliedCommitSha = :sha');
          values[':sha'] = commitSha;
        }
        if (error) {
          sets.push('applyError = :err');
          values[':err'] = String(error).slice(0, 500);
        }
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: REFLECTIONS_TABLE,
              Key: { projectSlug, id },
              UpdateExpression: `SET ${sets.join(', ')}`,
              ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(appliedAt)',
              ExpressionAttributeValues: values,
            }),
          );
        } catch (err) {
          // ConditionalCheckFailed = a racing tick already stamped it; benign.
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        }
        return null;
      },
      log: (level, msg, ctx) => log(level, msg, ctx),
    },
    { intervalMs: 60_000, initialDelayMs: 90_000 },
  );

  log('info', 'Polling for PENDING jobs...\n');

  while (!shuttingDown) {
    try {
      await writeHeartbeat();

      // Stale-heartbeat scan (EO-4.5) — throttled so we don't hammer DDB.
      if (Date.now() - lastStaleScanAt >= STALE_SCAN_INTERVAL_MS) {
        lastStaleScanAt = Date.now();
        scanStaleEpicDevJobs().catch((e) => log('error', `Stale scan uncaught: ${e.message}`));
      }

      // Reality-Spine reconciliation sweep — re-drive all-resolved plans stuck in
      // developing/fixing toward integrate/review so a lost integrator enqueue
      // self-heals. Throttled; idempotent no-op for genuinely-in-flight plans.
      if (Date.now() - lastIntegrateSweepAt >= INTEGRATE_SWEEP_INTERVAL_MS) {
        lastIntegrateSweepAt = Date.now();
        scanStalledPlansForIntegrate().catch((e) => log('error', `Integrate sweep uncaught: ${e.message}`));
      }

      // Pipeline-3 ready-frontier shadow scan — inert unless P3_READY_FRONTIER
      // is set. Throttled; logs would-dispatch vs legacy waves (development-plan §5.2).
      if (Date.now() - lastFrontierScanAt >= FRONTIER_SCAN_INTERVAL_MS) {
        lastFrontierScanAt = Date.now();
        runFrontierScan().catch((e) => log('error', `Frontier scan uncaught: ${e.message}`));
      }

      // Pipeline-3 mid-turn cost-ceiling halt watch (development-plan §5.4). Only
      // meaningful in enforce mode (the PostToolUse hook writes the sentinel
      // then); each active job's workingDir is checked for .futurator/halt and
      // its children signalled to stop. Cheap (one existsSync per active job).
      if ((process.env.P3_COST_CEILING || 'off').toLowerCase() === 'enforce') {
        for (const [jobId, info] of activeJobs) {
          if (!info?.workingDir) continue;
          const h = checkAndSignalHalt({ dir: info.workingDir, jobId, signalChildren: signalChildrenForJob });
          if (h.halted) log('warn', `[cost-ceiling] halted job ${jobId} mid-turn: ${h.reason}`);
        }
      }

      // 2026-05-27 (unification) — the dedicated free-agent GC tick was
      // removed. Assist worktrees are now reaped by the hourly unified
      // `worktree-reaper.mjs` alongside per-story + party + store entries.

      // 2026-05-27 PR B.f — global pause gate. When `agent.paused` is set
      // (via POST /api/admin/pause), the poll loop skips dispatch entirely
      // and waits for the next tick. In-flight jobs are NOT cancelled —
      // they complete on their own; only NEW work is blocked.
      const paused = await isAgentPausedCached();
      if (paused) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      // Queues module — apply the operator-set concurrency cap (5s cache).
      // Mutates effectiveMaxConcurrent + concurrencyManager._max in place so a
      // change in the EC2 Monitor takes effect within ~5s, no daemon restart.
      // Also refreshes serverAwareDispatch, which the fleet gate below reads.
      await applyCapOverrideCached();

      // Servers module — fleet-daemon gate. A fleet box only has a coordinated
      // share of the work when dispatch.serverAware is ON: that is what routes
      // it to its OWN partition of assignedServerId-status-index and makes it
      // claim via CAS lease. With the flag OFF it would fall back to the legacy
      // global-pool poll with no atomic claim — an uncoordinated worker racing
      // the Mac/EC2 daemons for the same rows, i.e. the same job executed
      // twice. Idle instead (still heartbeating, so the fleet card shows it
      // alive and waiting rather than pretending to work).
      if (IS_FLEET_DAEMON && !serverAwareDispatch) {
        if (Date.now() - (global.__lastFleetGateLogAt || 0) > 60_000) {
          global.__lastFleetGateLogAt = Date.now();
          log(
            'info',
            `[poll-gate] ${SERVER_ID}: idle — dispatch.serverAware is off, so this fleet server has no assigned queue to poll. Enable it in Servers → Dispatch Policy.`,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      // snake3 (2026-06-10) — auth circuit breaker. During the 17:50–18:48
      // OAuth outage the daemon kept claiming PENDING jobs and feeding them
      // to a CLI that exits 1 instantly: compile steps FAILED, the conflict
      // resolver "failed", waves halted — all burned on a token everyone
      // knew was dead. When the access token is expired AND a re-read of
      // the credentials file doesn't produce a fresh one, stop claiming NEW
      // work until it does (in-flight jobs finish; auth-recovery handles
      // them). Recovery is automatic: the interval probe + SIGUSR1 + this
      // pre-claim reload all refresh authState.
      if (authState.expiresAt && authState.expiresAt <= Date.now()) {
        loadOAuth('poll-gate-expired');
        if (authState.expiresAt && authState.expiresAt <= Date.now()) {
          if (Date.now() - (global.__lastAuthGateLogAt || 0) > 60_000) {
            global.__lastAuthGateLogAt = Date.now();
            log(
              'warn',
              `[poll-gate] access token expired (${new Date(authState.expiresAt).toISOString()}) and no fresh credentials on disk — pausing NEW job claims until re-auth`,
            );
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          continue;
        }
      }

      // Story 20.16 — gate the DDB query on capacity. When the
      // ConcurrencyManager is enabled, fetch a window (CM_CANDIDATE_LIMIT)
      // so selectNext can apply interactive-first priority across the
      // queue, then dispatch up to the free-slot count from that window.
      // When disabled, fall back to the legacy MAX_CONCURRENT - size gate.
      const hasCapacity = CONCURRENCY_MANAGER_ENABLED
        ? concurrencyManager.canAcquire()
        : activeJobs.size < effectiveMaxConcurrent;
      if (hasCapacity) {
        const nowIso = new Date().toISOString();
        const queryLimit = CONCURRENCY_MANAGER_ENABLED
          ? CM_CANDIDATE_LIMIT
          : effectiveMaxConcurrent - activeJobs.size;
        // Servers module (Task 18) — with `dispatch.serverAware` on, poll ONLY
        // the jobs the dispatcher assigned to THIS server (its own partition of
        // `assignedServerId-status-index`) instead of the global PENDING pool;
        // the retry-backoff filter is kept. Flag off ⇒ legacy query untouched.
        const { Items } = await ddb.send(
          new QueryCommand(
            serverAwareDispatch
              ? {
                  TableName: JOBS_TABLE,
                  IndexName: 'assignedServerId-status-index',
                  KeyConditionExpression: 'assignedServerId = :sid AND #s = :pending',
                  FilterExpression: 'attribute_not_exists(retryAfter) OR retryAfter <= :now',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: {
                    ':sid': SERVER_ID,
                    ':pending': 'PENDING',
                    ':now': nowIso,
                  },
                  Limit: queryLimit,
                }
              : {
                  TableName: JOBS_TABLE,
                  IndexName: 'status-createdAt-index',
                  KeyConditionExpression: '#s = :pending',
                  // Pipeline Enhancement Plan v2 — Phase A.3: skip jobs still
                  // inside their retry backoff window (retryAfter > now).
                  FilterExpression: 'attribute_not_exists(retryAfter) OR retryAfter <= :now',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':pending': 'PENDING', ':now': nowIso },
                  Limit: queryLimit,
                  ScanIndexForward: true,
                },
          ),
        );

        if (Items?.length > 0) {
          if (CONCURRENCY_MANAGER_ENABLED) {
            // Story 20.16 — priority-respecting dispatch loop. Iteratively
            // pick the highest-priority candidate not already in flight and
            // not the same row a prior iteration dispatched. Stops when
            // either the window is exhausted or capacity runs out (a
            // late-arriving in-flight job changed availableSlots).
            // Queues module — enforce Local/EC2 target routing + the queue-only
            // gate: skip a queue-request whose target isn't this daemon's
            // DAEMON_SOURCE, and (when DAEMON_QUEUE_ONLY) skip all non-queue jobs.
            // Server-aware mode replaces source routing entirely (spec §5.2):
            // the assigned-index partition + the CAS claim's assignedServerId
            // pin already scope every job to THIS server.
            const candidates = Items.filter(
              (j) => !activeJobs.has(j.jobId) && (serverAwareDispatch || canClaimJob(j)),
            );
            const dispatched = new Set();
            while (concurrencyManager.canAcquire() && candidates.length > dispatched.size) {
              const pool = candidates.filter((j) => !dispatched.has(j.jobId));
              const pick = concurrencyManager.selectNext(pool);
              if (!pick) break;
              dispatched.add(pick.jobId);
              // Fire-and-forget; runJobAsync acquires the slot + releases on close.
              runJobAsync(pick).catch((e) =>
                log('error', `runJobAsync uncaught: ${e.message}`),
              );
            }
          } else {
            for (const job of Items) {
              if (activeJobs.has(job.jobId)) continue;
              // Queues module — target routing + queue-only gate (see above);
              // bypassed in server-aware mode (assigned index + CAS pin).
              if (!serverAwareDispatch && !canClaimJob(job)) continue;
              runJobAsync(job).catch((e) => log('error', `runJobAsync uncaught: ${e.message}`));
            }
          }
        }
      }
    } catch (err) {
      log('error', `Poll error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// ── Shell-guard violation → attention item ──
//
// Pipeline Enhancement Plan v2 — Phase A.2. Called by spawn wrappers when
// shell-guard refuses a spawn. Looks up planId via job.epicId and writes a
// high-severity policy-violation attention item. Never throws.
function handleGuardViolation(jobId, details) {
  (async () => {
    try {
      const row = await ddb.send(
        new GetCommand({
          TableName: JOBS_TABLE,
          Key: { jobId },
          ProjectionExpression: 'epicId',
        }),
      );
      const epicId = row.Item?.epicId;
      const planId = await resolvePlanIdFromEpicId(ddb, epicId);
      if (!planId) return;
      const reason =
        details?.kind === 'cwd'
          ? `cwd "${details.cwd}" escaped allowed roots`
          : details?.kind === 'arg'
            ? `${details.command} arg "${details.arg}" escaped allowed roots`
            : details?.kind === 'script'
              ? `bash script: ${details.command} targets "${details.arg}" outside allowed roots`
              : 'spawn refused by shell-guard';
      await writeAttentionItem(
        ddb,
        {
          planId,
          severity: 'high',
          category: 'policy-violation',
          title: 'Shell-guard refused a spawn',
          body:
            `The daemon's shell-guard refused a spawn because it escaped the ` +
            `allowed project roots. Step: ${details?.stepId || 'n/a'}. Reason: ${reason}. ` +
            `The step failed cleanly — no processes were created.`,
          context: {
            jobId,
            epicId,
            stepId: details?.stepId,
          },
          suggestedActions: [
            { label: 'Open logs', kind: 'open-logs' },
            { label: 'Open story', kind: 'open-story' },
          ],
        },
        log,
      );
    } catch (err) {
      log('error', `handleGuardViolation failed: ${err.message}`);
    }
  })();
}

// ── Graceful shutdown ──
//
// Pipeline Enhancement Plan v2 — Phase A.1.
// On SIGTERM/SIGINT: stop accepting new work, SIGTERM every tracked child,
// wait up to GRACEFUL_SHUTDOWN_MS (default 30s), then SIGKILL stragglers.
// Children that exit cleanly within the window let their own close handlers
// update job status; only the SIGKILL'd jobs get marked FAILED here and get
// a daemon-shutdown-timeout attention item.

async function shutdown(signal) {
  const initialActive = activeJobs.size;
  const initialChildren = getChildCount();
  log(
    'warn',
    `Received ${signal}. Graceful shutdown begun — ${initialActive} active jobs, ${initialChildren} tracked children, ${GRACEFUL_SHUTDOWN_MS}ms window`,
  );
  shuttingDown = true;

  // Phase 3 / Story 3-C-1-1 — clear federation backup interval so the
  // event loop can drain.
  if (federationBackupHandles) {
    clearTimeout(federationBackupHandles.startupTimer);
    clearInterval(federationBackupHandles.intervalHandle);
    federationBackupHandles = null;
  }

  if (ndjsonForwarder) {
    try {
      await ndjsonForwarder.stop();
    } catch (err) {
      log('error', `NDJSON forwarder stop failed: ${err.message}`);
    }
  }

  if (daemonReceiver) {
    try {
      await daemonReceiver.close();
    } catch (err) {
      log('error', `Daemon receiver close failed: ${err.message}`);
    }
  }

  // Step 1: SIGTERM every tracked child so they can flush and exit cleanly.
  const signaled = signalAllChildren('SIGTERM');
  log(
    'info',
    `SIGTERM sent to ${signaled} tracked children — waiting up to ${GRACEFUL_SHUTDOWN_MS}ms`,
  );

  // Step 2: wait for children to exit, or the window elapses.
  const allExited = await waitForAllChildrenToExit(GRACEFUL_SHUTDOWN_MS);

  if (allExited) {
    log('info', 'All tracked children exited within graceful window');
  } else {
    // Step 3: SIGKILL stragglers and record which jobs got force-killed.
    const survivors = [];
    for (const jobId of activeJobs.keys()) {
      survivors.push(jobId);
    }
    const killed = killAllChildren();
    log(
      'warn',
      `Graceful window elapsed — SIGKILL'd ${killed} children; ${survivors.length} jobs will be marked FAILED with daemon-shutdown-timeout`,
    );

    // Step 4: mark surviving jobs FAILED + emit an attention item each.
    for (const jobId of survivors) {
      try {
        await updateJobFields(jobId, {
          status: 'FAILED',
          errorMessage: `Daemon ${signal} — step did not exit within ${GRACEFUL_SHUTDOWN_MS}ms graceful window`,
        });
      } catch (err) {
        log('error', `Failed to update job on shutdown: ${err.message}`);
      }

      // Resolve planId via the job's epicId for the attention item.
      try {
        const row = await ddb.send(
          new GetCommand({
            TableName: JOBS_TABLE,
            Key: { jobId },
            ProjectionExpression: 'epicId',
          }),
        );
        const epicId = row.Item?.epicId;
        const planId = await resolvePlanIdFromEpicId(ddb, epicId);
        if (planId) {
          await writeAttentionItem(
            ddb,
            {
              planId,
              severity: 'medium',
              category: 'daemon-shutdown-timeout',
              title: `Daemon ${signal} during running step`,
              body:
                `The daemon received ${signal} and the in-flight step did not exit within the ` +
                `${GRACEFUL_SHUTDOWN_MS}ms graceful window. The step was force-killed and the job ` +
                `was marked FAILED. Retry the step when the daemon is back up.`,
              context: { jobId, epicId },
              suggestedActions: [
                { label: 'Open story', kind: 'open-story' },
                { label: 'Retry step', kind: 'retry-step' },
              ],
            },
            log,
          );
        }
      } catch (err) {
        log('error', `Failed to write shutdown attention item: ${err.message}`);
      }
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// SIGUSR1 = fresh OAuth tokens just landed at OAUTH_CREDS_PATH — re-read the
// file and re-probe. Triggered by scripts/mac-oauth-sync.sh (the Mac →
// Keychain → SSM pipeline) after a successful push. No restart, no killed
// jobs — in-flight spawns keep their own env and new spawns get the new file.
//
// Phase 3 / Story 3-C-1-1 multiplexes this signal: the skill federation
// cache also re-reads `~/.futurator/skill-federation.yaml`. Operators
// editing either resource use the same `kill -USR1 <daemon-pid>`.
process.on('SIGUSR1', async () => {
  log('info', 'SIGUSR1 received — reloading OAuth and re-probing');
  try {
    loadOAuth('sigusr1');
    await probeAuth();
  } catch (err) {
    log('error', `SIGUSR1 reload failed: ${err.message}`);
  }
  if (federationCache) {
    try {
      const result = federationCache.refresh();
      if (result.error) {
        log('error', `SIGUSR1 federation refresh fell back: ${result.error} (path=${result.path})`);
      } else if (result.changed) {
        log(
          'info',
          `SIGUSR1 federation refreshed: ${result.source} (${result.previousSha.slice(0, 8)} → ${result.newSha.slice(0, 8)})`,
        );
      } else {
        log('info', 'SIGUSR1 federation refresh: no change');
      }
    } catch (err) {
      log('error', `SIGUSR1 federation refresh failed: ${err.message}`);
    }
  }
  // Story 3-C-1-2 — drop the resolver's per-source index cache so next
  // resolveSkill() re-fetches against the (possibly new) source set.
  if (federationResolver) {
    federationResolver.invalidate();
    log('info', 'SIGUSR1 federation-resolver: index cache invalidated');
  }
});

// Story 1.1.3 — configure git identity (PAT from SSM → global git config)
// before the main poll loop. Idempotent. Failure here is fatal because every
// git op the daemon will subsequently run depends on it.
async function configureGitIdentity() {
  if (process.env.SKIP_GIT_IDENTITY === '1') {
    log('info', 'configure-git-identity skipped (SKIP_GIT_IDENTITY=1)');
    return;
  }
  const scriptPath = new URL('./scripts/configure-git-identity.sh', import.meta.url).pathname;
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`configure-git-identity.sh exited ${code}`));
    });
    child.on('error', reject);
  });
}

(async () => {
  try {
    await configureGitIdentity();
  } catch (err) {
    log('error', `configure-git-identity failed: ${err.message}`);
    log('error', 'Daemon refusing to start — fix PAT or set SKIP_GIT_IDENTITY=1 to bypass.');
    process.exit(3);
  }

  // Phase 3 / Story 3-C-1-1 — load skill federation manifest. Missing file
  // falls back to the embedded default (Anthropic-official + futurator-
  // internal + community at p99). Parse/validation errors fall back to the
  // same default but log an error — operator authors a valid file or accepts
  // the default until SKILL-SCOUT (3-C-3) starts consuming it.
  try {
    const federationPath = process.env.FUTURATOR_FEDERATION_PATH || undefined;
    federationCache = createFederationCache(federationPath);
    const { manifest, source, path: loadedPath, error } = federationCache.get();
    if (error) {
      log('error', `federation-loader: ${error} (path=${loadedPath}) — using embedded default`);
    } else {
      log(
        'info',
        `federation-loader: ${source} (path=${loadedPath}, ${manifest.sources.length} sources, sha=${manifestSha(manifest).slice(0, 8)})`,
      );
    }
    // Start the daily S3 backup. Disabled in env=test or when explicitly
    // opted out — operators on tiny EBS quotas can skip the S3 write.
    if (process.env.FUTURATOR_FEDERATION_BACKUP_DISABLED !== '1') {
      federationBackupHandles = startFederationBackupSchedule(() => federationCache?.get(), log);
      log('info', 'federation-backup: daily schedule armed');
    }
    // Story 3-C-1-2 — resolver built on top of the cache. SKILL-SCOUT
    // (3-C-3) will be the primary consumer.
    federationResolver = createFederationResolver(federationCache);
    log('info', 'federation-resolver: ready');
  } catch (err) {
    log('error', `federation-loader setup failed: ${err.message}`);
  }

  // Phase 3 / Story 3-E-1-1 — provision the inter-agent memory hierarchy
  // (/mnt/memory by default; FUTURATOR_MEMORY_ROOT for tests + alt mounts).
  // Idempotent — re-running the daemon adds no new dirs. REFLECTOR (3-E-2)
  // and TRIAGE (3-E-6) consume `memoryStore` directly.
  try {
    const memProvision = provisionMemoryRoot();
    memoryStore = createMemoryStore();
    if (memProvision.created.length > 0) {
      log(
        'info',
        `memory-store: provisioned ${memProvision.created.length} dir(s) under ${memProvision.root}`,
      );
    } else {
      log('info', `memory-store: ready at ${memProvision.root} (already provisioned)`);
    }
  } catch (err) {
    // Memory-store failure is non-fatal — REFLECTOR/TRIAGE features degrade
    // gracefully (those agents check memoryStore != null before using).
    log('error', `memory-store setup failed: ${err.message}`);
  }

  // Story 15.4 — startup probe. Per-project secrets load lazily; this
  // just surfaces a single log line so the operator knows whether the
  // legacy shared secret is reachable.
  await probeBrownfieldPatAtStartup();

  poll();
})();
