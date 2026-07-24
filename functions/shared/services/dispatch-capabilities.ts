/**
 * Dispatch capability matrix — the eligibility half of the multi-host dispatcher.
 *
 * The dispatcher picks a host along FOUR orthogonal axes:
 *   1. ELIGIBILITY  — CAN this box run this job at all?  ← THIS FILE (capabilities)
 *   2. CAPACITY     — is it below its `maxConcurrent` cap right now?
 *   3. LIVENESS     — is its heartbeat fresh AND `auth.valid`?
 *   4. PREFERENCE   — server-selection policy (priority / weighted / cheapest) + plan affinity.
 *
 * This module owns axis (1): a pure function from (server capabilities, job
 * requirements) → boolean. Kept dependency-free so it can be shared by the API,
 * the Servers UI, and (via a small `.mjs` mirror) the daemon claim gate.
 *
 * Capabilities are DAEMON-SELF-REPORTED (see ServerCapability doc). Requirements
 * are STATIC per jobType (this map) UNION a DYNAMIC per-job set
 * (`job.requiredCapabilities`) — e.g. a `story-dev` job whose story carries
 * browser acceptance criteria adds `'browser'` at dispatch time.
 */
import type { ServerCapability } from '../types/compute-server';

/** Minimal shape this matcher needs from a server (structural — no import cycle). */
export interface CapabilityServer {
  capabilities?: ServerCapability[];
}

/** Minimal shape this matcher needs from a job. */
export interface CapabilityJob {
  jobType?: string;
  /** Dynamic, per-job requirements on top of the static jobType map (e.g. a
   *  story-dev job with browser ACs adds 'browser'). */
  requiredCapabilities?: ServerCapability[];
}

/**
 * STATIC capabilities a jobType always needs, regardless of payload. A jobType
 * absent here (or mapped to `[]`) has NO static requirement — any live host may
 * run it. Browser is intentionally NOT static on `story-dev`/`p3-qa`: not every
 * story is a UI story, so 'browser' is added DYNAMICALLY per-job via
 * `job.requiredCapabilities` only when the story actually has browser ACs.
 *
 * String-keyed (jobType) to stay decoupled from the large AgentJob union; the
 * canonical jobTypes are documented in agent-orchestrator.ts.
 */
export const JOB_CAPABILITY_REQUIREMENTS: Record<string, ServerCapability[]> = {
  // Greenfield app scaffold creates AND pushes a private repo.
  'app-bootstrap': ['git-push'],
  // Debates: clone/checkout + push, and turns are interactive.
  'party-bootstrap': ['git-push'],
  'party-turn': ['git-push', 'interactive'],
  'party-refresh': ['git-push'],
  // Free Claude Code agent — a live, low-latency operator session.
  'free-agent-session': ['interactive'],
  // Everything else (story-dev, quick-planspec, scan-engine, refactor-audit,
  // queue-request, epic-dev, wave-merge, integrator, reflector, scorecard-assess,
  // dual-agent-compare, ultracode-bench, skill-*, file-browse) has NO static
  // requirement here; browser is layered on per-job when a story needs it.
};

/** The full set of capabilities a specific job needs = static(jobType) ∪ dynamic(job). */
export function jobRequiredCapabilities(job: CapabilityJob): ServerCapability[] {
  const stat = (job.jobType && JOB_CAPABILITY_REQUIREMENTS[job.jobType]) || [];
  const dyn = job.requiredCapabilities ?? [];
  return Array.from(new Set<ServerCapability>([...stat, ...dyn]));
}

/**
 * ELIGIBILITY (axis 1): does `server` have EVERY capability `job` requires?
 *
 * PERMISSIVE-WHEN-UNDECLARED: a server whose `capabilities` is `undefined` (a
 * daemon that hasn't reported yet, or a legacy row) is treated as able to run
 * anything — so enabling this matrix never silently starves existing hosts
 * before daemons start reporting. Once a server reports `capabilities` (even
 * `[]`), the check is strict. A job with no requirements is always eligible.
 */
export function serverHasCapabilitiesFor(server: CapabilityServer, job: CapabilityJob): boolean {
  const required = jobRequiredCapabilities(job);
  if (required.length === 0) return true;
  // Not yet reported → permissive (see doc above).
  if (server.capabilities === undefined) return true;
  const have = new Set(server.capabilities);
  return required.every((c) => have.has(c));
}

/** Convenience: the capabilities `job` needs that `server` is MISSING (for diagnostics/UI). */
export function missingCapabilitiesFor(
  server: CapabilityServer,
  job: CapabilityJob,
): ServerCapability[] {
  if (server.capabilities === undefined) return [];
  const have = new Set(server.capabilities);
  return jobRequiredCapabilities(job).filter((c) => !have.has(c));
}
