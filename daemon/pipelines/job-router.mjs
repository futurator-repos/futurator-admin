/**
 * Job router — decides which pipeline entry point runs a given job
 * (EO-4.3). The daemon polls DynamoDB and calls `selectHandler(job)` to
 * decide between the legacy step-based pipeline and the new epic-dev
 * orchestrator pipeline.
 *
 * Legacy jobs have `pipeline.steps` and (usually) no `phase`.
 * New orchestrator jobs MUST set `phase: 'epic-dev'` and carry
 * `epicDevPayload` per `functions/shared/types/agent-orchestrator.ts`.
 */

export const JOB_HANDLER_LEGACY = 'legacy';
export const JOB_HANDLER_EPIC_DEV = 'epic-dev';
// Pipeline-3 (development-plan §4) — per-story dev. One Claude per ready StoryNode,
// minted by ready-frontier, scoped to the story's touches under the live gate.
export const JOB_HANDLER_STORY_DEV = 'story-dev';
export const JOB_HANDLER_PARTY_BOOTSTRAP = 'party-bootstrap';
export const JOB_HANDLER_PARTY_INSPECT = 'party-inspect';
export const JOB_HANDLER_PARTY_TURN = 'party-turn';
export const JOB_HANDLER_PARTY_DOCS_SYNC = 'party-docs-sync';
export const JOB_HANDLER_PARTY_DOCS_UNLINK = 'party-docs-unlink';
// Story 15.4 — brownfield refresh pipeline.
export const JOB_HANDLER_PARTY_REFRESH = 'party-refresh';
// Pipeline v2 / Story 1.4.3 — App-bootstrap saga (steps 3–5).
export const JOB_HANDLER_APP_BOOTSTRAP = 'app-bootstrap';
// Epic 18 / Story 18.2 — Free Claude Code Agent session turn.
export const JOB_HANDLER_FREE_AGENT_SESSION = 'free-agent-session';
// Queues module — inbound external REST call (atlassinator/applicator/…).
export const JOB_HANDLER_QUEUE_REQUEST = 'queue-request';
// 2026-05-19 — Phase 1 worktree rollout. Wave-merge job runs the per-story
// `git merge --no-ff` sequence + post-merge validation in a coordinator
// worktree at /home/ubuntu/worktrees/<app>/<plan>/_merge/.
export const JOB_HANDLER_WAVE_MERGE = 'wave-merge';
// Epic 3 Story 3.1 (2026-05-20) — SKILL-SCOUT job runner. Spawns the
// SKILL-SCOUT agent for T1 (post-bootstrap) / T2 (pre-PM) triggers,
// extracts proposals JSON, validates via Zod, then either auto-confirms
// (prototype + high-confidence T1/T2/T5/T7) or surfaces a decision card.
export const JOB_HANDLER_SKILL_SCOUT = 'skill-scout';
// Epic 3 Story 3.6 (2026-05-20) — SKILL-INSTALL job runner. Applies
// operator-confirmed proposals to .claude/skills.manifest.yaml, re-runs
// vendor-skills, commits with `Agent: SKILL-SCOUT` trailer.
export const JOB_HANDLER_SKILL_INSTALL = 'skill-install';
// Epic 6 wire-in (2026-05-20) — REFLECTOR job runner. Plan-reducer
// enqueues these at plan close; the runner spawns the REFLECTOR agent
// and writes proposals into futurator-reflections for the operator's
// Reflection Inbox.
export const JOB_HANDLER_REFLECTOR = 'reflector';
// Plan Retrospect / The Assessor (plan-retrospect-spec §4b). The API enqueues
// these after storing the deterministic slice; the runner grades the stage's
// [LLM] criteria and writes Assessor slices into futurator-scorecards.
export const JOB_HANDLER_SCORECARD_ASSESS = 'scorecard-assess';
// Refactoring Assessment Module (Epic B). Deterministic recon (~0 LLM) over a
// migrated brownfield clone; the runner spawns recon.mjs as a plain Node child.
export const JOB_HANDLER_REFACTOR_AUDIT = 'refactor-audit';
// Ultracode-Reverse bench. The runner spawns two single `claude` runs (Case 1 = native
// ultracode w/ capture+halt, Case 2 = our meta-prompt), AST-parses both, scores, persists.
export const JOB_HANDLER_ULTRACODE_BENCH = 'ultracode-bench';
// Dual-agent comparison harness. The runner spawns two `claude` agents on the
// same question over an assessed app's clone — Agent A vanilla, Agent B + the
// Mycelium graph MCP — and captures answer/latency/tokens/cost/graph-tool usage.
export const JOB_HANDLER_DUAL_AGENT_COMPARE = 'dual-agent-compare';
// Refactoring Scan Engine v2. Hybrid deterministic recon + LLM swarm → a
// dimension-tagged finding pool + a phased, dependency-ordered refactoring plan.
export const JOB_HANDLER_SCAN_ENGINE = 'scan-engine';
export const JOB_HANDLER_QUICK_PLANSPEC = 'quick-planspec';
// QA-Review W2 — the deployed-app QA Review job (journeys + VQA against plan.devUrl).
export const JOB_HANDLER_P3_QA = 'p3-qa';
// Reality-Spine P3 (redesign Part 2 P3 INTEGRATE-RUN) — the whole-tree
// Integrator. ONE Opus agent with whole-tree write authority loops to full
// green (tsc && lint && test && build && boot-liveness) then commits; it is the
// mandatory INTEGRATE-RUN before `review` and the FIRST responder to a blocking
// QA verdict (before per-symptom fix stories).
export const JOB_HANDLER_INTEGRATOR = 'integrator';

/**
 * Decide which handler should run a given job.
 *
 * Returns one of:
 *   - 'party-bootstrap' when `job.jobType === 'party-bootstrap'`
 *   - 'party-inspect'   when `job.jobType === 'party-inspect'`
 *   - 'party-turn'      when `job.jobType === 'party-turn'`
 *   - 'epic-dev'        when `job.phase === 'epic-dev'`
 *   - 'legacy'          for every other job (including undefined phase)
 *
 * Party jobs take precedence over `phase` since they have no phase.
 *
 * This function is intentionally pure — no I/O, no spawning. Keeping it
 * pure lets us unit-test the dispatch without mocking the Claude CLI or
 * DynamoDB.
 */
export function selectHandler(job) {
  if (!job || typeof job !== 'object') return JOB_HANDLER_LEGACY;
  if (job.jobType === 'party-bootstrap') return JOB_HANDLER_PARTY_BOOTSTRAP;
  if (job.jobType === 'party-inspect') return JOB_HANDLER_PARTY_INSPECT;
  if (job.jobType === 'party-turn') return JOB_HANDLER_PARTY_TURN;
  if (job.jobType === 'party-docs-sync') return JOB_HANDLER_PARTY_DOCS_SYNC;
  if (job.jobType === 'party-docs-unlink') return JOB_HANDLER_PARTY_DOCS_UNLINK;
  if (job.jobType === 'party-refresh') return JOB_HANDLER_PARTY_REFRESH;
  if (job.jobType === 'app-bootstrap') return JOB_HANDLER_APP_BOOTSTRAP;
  if (job.jobType === 'free-agent-session') return JOB_HANDLER_FREE_AGENT_SESSION;
  if (job.jobType === 'queue-request') return JOB_HANDLER_QUEUE_REQUEST;
  if (job.jobType === 'wave-merge') return JOB_HANDLER_WAVE_MERGE;
  if (job.jobType === 'skill-scout') return JOB_HANDLER_SKILL_SCOUT;
  if (job.jobType === 'skill-install') return JOB_HANDLER_SKILL_INSTALL;
  if (job.jobType === 'reflector') return JOB_HANDLER_REFLECTOR;
  if (job.jobType === 'scorecard-assess') return JOB_HANDLER_SCORECARD_ASSESS;
  if (job.jobType === 'refactor-audit') return JOB_HANDLER_REFACTOR_AUDIT;
  if (job.jobType === 'ultracode-bench') return JOB_HANDLER_ULTRACODE_BENCH;
  if (job.jobType === 'dual-agent-compare') return JOB_HANDLER_DUAL_AGENT_COMPARE;
  if (job.jobType === 'scan-engine') return JOB_HANDLER_SCAN_ENGINE;
  if (job.jobType === 'story-dev') return JOB_HANDLER_STORY_DEV;
  if (job.jobType === 'quick-planspec') return JOB_HANDLER_QUICK_PLANSPEC;
  if (job.jobType === 'p3-qa') return JOB_HANDLER_P3_QA;
  if (job.jobType === 'integrator') return JOB_HANDLER_INTEGRATOR;
  if (job.phase === 'epic-dev') return JOB_HANDLER_EPIC_DEV;
  return JOB_HANDLER_LEGACY;
}

/**
 * Queues module — target routing (Local vs EC2 toggle enforcement).
 *
 * A queue-request job carries a `target` ('ec2' | 'local') captured from the
 * submitter's runtime toggle (the topbar Local/EC2 switch, or an external
 * caller's explicit `target`). Only the daemon whose `DAEMON_SOURCE` matches
 * may claim it, so a 'local' call routes to the operator's laptop daemon and an
 * 'ec2' call to the EC2 daemon. A mismatched job is simply left PENDING for the
 * correct daemon to claim (or to wait until that daemon comes online) — it never
 * occupies a concurrency slot on the wrong host.
 *
 * Defaults: an absent target resolves to 'ec2' (the always-on workhorse and the
 * UI's default runtime), mirroring the API's `input.target ?? 'ec2'`. Non-queue
 * jobs are unaffected — they are claimable by whichever daemon is polling.
 *
 * @param {object} job — the PENDING agent-job row
 * @param {string} daemonSource — this daemon's DAEMON_SOURCE ('ec2' | 'local')
 * @returns {boolean} true if this daemon may claim the job
 */
export function isJobClaimableBySource(job, daemonSource) {
  if (!job || job.jobType !== 'queue-request') return true;
  const target = job.queueRequestPayload?.target || 'ec2';
  return target === daemonSource;
}

/**
 * Queues module — structural check for a queue-request job. Rejects malformed
 * rows before the daemon spawns a Claude session for an external call. Needs an
 * identity (`jobId`), and a payload carrying the originating `requestId` + the
 * `prompt` handed to `claude -p`. Returns { ok } or { ok:false, reason }.
 */
export function validateQueueRequestJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'queue-request') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.queueRequestPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'queueRequestPayload-missing' };
  if (!p.requestId) return { ok: false, reason: 'requestId-missing' };
  if (!p.prompt || !String(p.prompt).trim()) return { ok: false, reason: 'prompt-missing' };
  return { ok: true };
}

/**
 * Reality-Spine P3 — structural check for an integrator job. Rejects malformed
 * rows before the daemon spawns an Opus whole-tree session. Needs the plan it
 * integrates (`planId`), an identity (`jobId`), and the app tree it rewrites
 * (`workingDir`). Returns { ok } or { ok:false, reason }.
 */
export function validateIntegratorJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'integrator') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  if (!job.planId) return { ok: false, reason: 'planId-missing' };
  if (!job.workingDir) return { ok: false, reason: 'workingDir-missing' };
  return { ok: true };
}

/**
 * Structural check for dual-agent-compare jobs. Rejects malformed rows before
 * the daemon spawns two `claude` agents. Returns { ok } or { ok:false, reason }.
 */
export function validateDualAgentCompareJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'dual-agent-compare') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.dualAgentComparePayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'dualAgentComparePayload-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.projectPath) return { ok: false, reason: 'projectPath-missing' };
  if (!p.question || !String(p.question).trim()) return { ok: false, reason: 'question-missing' };
  return { ok: true };
}

/**
 * QA-Review W2 — structural check for a p3-qa job. Needs the plan it QAs, the
 * deployed URL to drive, and the frozen commit it pins to. Rejects malformed
 * rows before the daemon boots playwright. Returns { ok } or { ok:false, reason }.
 */
export function validateP3QaJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'p3-qa') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  if (!job.planId) return { ok: false, reason: 'planId-missing' };
  if (!job.devUrl || !String(job.devUrl).startsWith('http')) return { ok: false, reason: 'devUrl-missing' };
  if (!job.qaCommitSha || !/^[a-f0-9]{40}$/.test(String(job.qaCommitSha))) {
    return { ok: false, reason: 'qaCommitSha-invalid' };
  }
  return { ok: true };
}

/**
 * Structural check for scan-engine jobs (Refactoring Scan Engine v2). Rejects
 * malformed rows before the daemon runs recon + spawns the LLM swarm.
 */
export function validateScanEngineJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'scan-engine') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.scanEnginePayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'scanEnginePayload-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.projectPath) return { ok: false, reason: 'projectPath-missing' };
  return { ok: true };
}

/**
 * 2026-05-19 — wave-merge job validation. Wave-merge jobs carry a
 * `waveMergePayload: { appId, planId, planSlug, epicId, waveNumber,
 * storyIds[], postMergeValidationCmd }` so the runner has all inputs
 * without doing additional DDB reads.
 */
export function validateWaveMergeJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'wave-merge') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.waveMergePayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'waveMergePayload-missing' };
  if (!p.appId || !p.planId || !p.planSlug || !p.epicId) {
    return { ok: false, reason: 'identity-fields-missing' };
  }
  if (typeof p.waveNumber !== 'number') return { ok: false, reason: 'waveNumber-missing' };
  if (!Array.isArray(p.storyIds) || p.storyIds.length === 0) {
    return { ok: false, reason: 'storyIds-empty' };
  }
  return { ok: true };
}

/**
 * Lightweight structural check for epic-dev jobs. Used by the daemon to
 * reject malformed epic-dev jobs with a clear error BEFORE spawning the
 * orchestrator. Returns { ok: true } or { ok: false, reason }.
 */
export function validateEpicDevJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.phase !== 'epic-dev') return { ok: false, reason: 'phase-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  if (!job.workingDir) return { ok: false, reason: 'workingDir-missing' };
  const p = job.epicDevPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'epicDevPayload-missing' };
  if (!p.orchestratorModel) return { ok: false, reason: 'orchestratorModel-missing' };
  if (!Array.isArray(p.stories) || p.stories.length === 0) {
    return { ok: false, reason: 'stories-empty' };
  }
  return { ok: true };
}

export function validatePartyBootstrapJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-bootstrap') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyBootstrapPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyBootstrapPayload-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.projectPath) return { ok: false, reason: 'projectPath-missing' };
  return { ok: true };
}

export function validatePartyInspectJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-inspect') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyInspectPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyInspectPayload-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.projectPath) return { ok: false, reason: 'projectPath-missing' };
  return { ok: true };
}

export function validatePartyTurnJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-turn') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyTurnPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyTurnPayload-missing' };
  if (!p.sessionId) return { ok: false, reason: 'sessionId-missing' };
  if (!p.content || typeof p.content !== 'string') return { ok: false, reason: 'content-missing' };
  return { ok: true };
}

export function validatePartyDocsSyncJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-docs-sync') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyDocsSyncPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyDocsSyncPayload-missing' };
  if (!p.projectId || !p.projectPath || !p.filename || !p.s3Bucket || !p.s3Key) {
    return { ok: false, reason: 'partyDocsSyncPayload-incomplete' };
  }
  return { ok: true };
}

/**
 * Story 15.4 — refresh job structural check. Mirrors validatePartyBootstrapJob
 * but requires `gitBranch` on the payload (brownfield-only operation).
 */
export function validatePartyRefreshJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-refresh') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyRefreshPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyRefreshPayload-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.projectPath) return { ok: false, reason: 'projectPath-missing' };
  if (!p.gitBranch) return { ok: false, reason: 'gitBranch-missing' };
  return { ok: true };
}

export function validatePartyDocsUnlinkJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'party-docs-unlink') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.partyDocsUnlinkPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'partyDocsUnlinkPayload-missing' };
  if (!p.projectId || !p.projectPath || !p.filename) {
    return { ok: false, reason: 'partyDocsUnlinkPayload-incomplete' };
  }
  return { ok: true };
}

/**
 * Pipeline v2 / Story 1.4.3 — App-bootstrap job structural check.
 * Mirrors `validatePartyBootstrapJob` shape for consistency.
 */
export function validateAppBootstrapJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'app-bootstrap') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.appBootstrapPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'appBootstrapPayload-missing' };
  if (!p.appId) return { ok: false, reason: 'appId-missing' };
  if (!p.boilerplateType) return { ok: false, reason: 'boilerplateType-missing' };
  if (typeof p.bmadEnabled !== 'boolean') return { ok: false, reason: 'bmadEnabled-missing' };
  return { ok: true };
}

/**
 * Epic 18 / Story 18.2 — Free-agent session job structural check.
 * Mirrors the existing party validators but requires the credentials envelope
 * and a non-empty messages array.
 */
export function validateFreeAgentSessionJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'free-agent-session') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.freeAgentSessionPayload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'freeAgentSessionPayload-missing' };
  }
  if (!p.sessionId) return { ok: false, reason: 'sessionId-missing' };
  if (!p.projectId) return { ok: false, reason: 'projectId-missing' };
  if (!p.model) return { ok: false, reason: 'model-missing' };
  if (typeof p.costCapUsd !== 'number') return { ok: false, reason: 'costCapUsd-missing' };
  if (!p.credentials || typeof p.credentials !== 'object') {
    return { ok: false, reason: 'credentials-missing' };
  }
  const c = p.credentials;
  if (!c.accessKeyId || !c.secretAccessKey || !c.sessionToken) {
    return { ok: false, reason: 'credentials-incomplete' };
  }
  if (!Array.isArray(p.messages) || p.messages.length === 0) {
    return { ok: false, reason: 'messages-empty' };
  }
  return { ok: true };
}
