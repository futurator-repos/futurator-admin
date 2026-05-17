export type BmadStatus =
  | 'MISSING'
  | 'INSTALLING'
  | 'HEALTHY'
  | 'DRIFTED'
  | 'CORRUPTED'
  | 'FAILED'
  | 'REFRESHING';

export type PartySessionStatus = 'ACTIVE' | 'PROCESSING' | 'IDLE' | 'ERROR' | 'ARCHIVED';

/**
 * Brownfield projects (Story 15.4) clone an existing GitHub repo into the
 * project folder instead of running the full BMAD bootstrap. The `kind`
 * discriminator gates which bootstrap branch the daemon runs and which UI
 * card variant renders. Existing rows without a `kind` attribute are
 * lazy-migrated to 'greenfield' on read by the repository.
 */
export type PartyProjectKind = 'greenfield' | 'brownfield';

export interface PartyProject {
  projectId: string;
  path: string;
  kind: PartyProjectKind;
  bmadStatus: BmadStatus;
  bmadVersion?: string;
  customAgentsSHA?: string;
  agentCount?: number;
  expectedAgentCount: number;
  lastInspectedAt?: string;
  lastBootstrapJobId?: string;
  failureReason?: string;
  /**
   * Tools the daemon is allowed to pass to `claude --allowedTools` when
   * spawning a turn for this project. When undefined, the daemon falls
   * back to DEFAULT_ALLOWED_TOOLS (web search / fetch). Set to [] to
   * explicitly deny all extra tools.
   */
  allowedTools?: string[];
  /** Brownfield-only — HTTPS GitHub URL of the source repo. */
  gitRepoUrl?: string;
  /** Brownfield-only — branch tracked on EC2 (default 'main'). */
  gitBranch?: string;
  /** Brownfield-only — ISO timestamp of last successful clone or refresh. */
  lastPulledAt?: string | null;
  /** Brownfield-only — HEAD SHA captured at last clone/refresh. */
  lastCommitSha?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Tools that are allowed by default when `PartyProject.allowedTools` is
 * undefined. Existing projects (created before this field shipped) get
 * web search "for free" — that's the cold-start UX we want.
 *
 * Stays out of the dangerous-tool zone: no Bash, no Edit/Write (those go
 * through `--permission-mode acceptEdits` which the daemon already passes).
 */
export const DEFAULT_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'] as const;

/** Tools the user is allowed to flip on/off via the project settings UI. */
export const TOGGLEABLE_TOOLS = ['WebSearch', 'WebFetch'] as const;

export interface PartySession {
  sessionId: string;
  projectId: string;
  projectPath: string;
  claudeSessionId: string | null;
  status: PartySessionStatus;
  turnCount: number;
  lastTurnAt?: string;
  createdAt: string;
  topic?: string;
  bmadVersionAtStart: string;
  GSI1PK: string;
  GSI1SK: string;
}

export type PartyJobType =
  | 'party-bootstrap'
  | 'party-inspect'
  | 'party-turn'
  | 'party-docs-sync'
  | 'party-docs-unlink'
  | 'party-refresh';

export interface PartyBootstrapJobPayload {
  projectId: string;
  projectPath: string;
  forceReinstall?: boolean;
  createFolder?: boolean;
  /**
   * Brownfield-only payload extension (Story 15.4). When kind='brownfield',
   * the daemon runs the 4-step clone/verify/sha/persist branch instead of
   * the 8-step BMAD-install pipeline.
   */
  kind?: PartyProjectKind;
  gitRepoUrl?: string;
  gitBranch?: string;
}

export interface PartyRefreshJobPayload {
  projectId: string;
  projectPath: string;
  gitBranch: string;
}

export interface PartyInspectJobPayload {
  projectId: string;
  projectPath: string;
}

export interface PartyTurnJobPayload {
  sessionId: string;
  content: string;
}

export interface PartyDocsSyncJobPayload {
  projectId: string;
  projectPath: string;
  filename: string;
  s3Bucket: string;
  s3Key: string;
}

export interface PartyDocsUnlinkJobPayload {
  projectId: string;
  projectPath: string;
  filename: string;
}

export type PartyEventType =
  | 'party.bootstrap.step.started'
  | 'party.bootstrap.step.output'
  | 'party.bootstrap.step.completed'
  | 'party.bootstrap.step.failed'
  | 'party.bootstrap.completed'
  | 'party.bootstrap.failed'
  | 'party.inspect.completed'
  | 'party.inspect.drift.detected'
  | 'party.turn.user'
  | 'party.turn.started'
  | 'party.turn.assistant.token'
  | 'party.turn.assistant.tool'
  | 'party.turn.assistant.agent'
  | 'party.turn.awaiting_user'
  | 'party.turn.completed'
  | 'party.turn.error'
  | 'party.docs.sync.started'
  | 'party.docs.sync.completed'
  | 'party.docs.sync.failed'
  | 'party.docs.unlink.started'
  | 'party.docs.unlink.completed'
  // Story 15.4 — refresh pipeline events. The lifecycle mirrors the
  // bootstrap pipeline taxonomy: one `.started` per pipeline, one
  // `.step.started` per step, optional `.step.output` for streamed
  // stdout/stderr, one `.step.completed` per step, one terminal
  // `.completed` or `.failed`.
  | 'party.refresh.started'
  | 'party.refresh.step.started'
  | 'party.refresh.step.output'
  | 'party.refresh.step.completed'
  | 'party.refresh.completed'
  | 'party.refresh.failed';

export interface PartyEvent {
  jobId: string;
  eventSeq: number;
  eventType: PartyEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * HTTPS GitHub repo URL. Accepts both `.git` and non-`.git` forms. SSH
 * (git@github.com:...) is intentionally rejected — brownfield clones use
 * a fine-grained PAT over HTTPS.
 */
export const GITHUB_HTTPS_URL_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

/** Failure reason emitted when a brownfield clone lacks BMAD. */
export const FAIL_REASON_BMAD_NOT_FOUND = 'BMAD_NOT_FOUND_IN_REPO';
export const MAX_MESSAGE_BYTES = 8192;
// BMAD 6.3.x stock install yields 6 agents (bmad-agent-{analyst,tech-writer,pm,
// ux-designer,architect,dev}). Custom-agent overlay (8 more) is deferred to a
// later story — see docs/recovery-orchestration-plan.md for context.
// BMAD 6.3.x ships 6 stock agents. Our 8 custom agents get injected post-install
// (Path 3b from docs/concepts/party-module-implementation §15).
export const EXPECTED_AGENT_COUNT = 14;
export const DEFAULT_BMAD_VERSION = '6.0.0-alpha.7';

// Allow-list for admin-uploaded Party project docs. These are the types
// Claude can read natively via its Read tool during a Party session.
export const PARTY_DOC_ALLOWED_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/pdf',
  'application/json',
  'text/csv',
  'application/yaml',
  'text/yaml',
];
export const PARTY_DOC_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const PARTY_DOCS_S3_PREFIX = 'party-docs';
