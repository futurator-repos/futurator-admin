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
  if (job.jobType === 'wave-merge') return JOB_HANDLER_WAVE_MERGE;
  if (job.jobType === 'skill-scout') return JOB_HANDLER_SKILL_SCOUT;
  if (job.jobType === 'skill-install') return JOB_HANDLER_SKILL_INSTALL;
  if (job.jobType === 'reflector') return JOB_HANDLER_REFLECTOR;
  if (job.jobType === 'scorecard-assess') return JOB_HANDLER_SCORECARD_ASSESS;
  if (job.jobType === 'refactor-audit') return JOB_HANDLER_REFACTOR_AUDIT;
  if (job.phase === 'epic-dev') return JOB_HANDLER_EPIC_DEV;
  return JOB_HANDLER_LEGACY;
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
