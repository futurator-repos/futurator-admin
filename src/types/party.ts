export type BmadStatus =
  | 'MISSING'
  | 'INSTALLING'
  | 'HEALTHY'
  | 'DRIFTED'
  | 'CORRUPTED'
  | 'FAILED'
  | 'REFRESHING';

export type PartySessionStatus =
  | 'ACTIVE'
  | 'PROCESSING'
  | 'IDLE'
  | 'ERROR'
  /** Terminal — debate published to main; worktree reaped, not resumable. */
  | 'DONE'
  | 'ARCHIVED';

/** Story 15.4 — discriminator for greenfield vs brownfield Party projects. */
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
   * Tools the daemon is allowed to pass to `claude --allowedTools`. When
   * undefined, defaults to DEFAULT_ALLOWED_TOOLS. Set to [] to deny all
   * extras (and leave only the always-allowed Read/Glob/Grep set).
   */
  allowedTools?: string[];
  /** Story 15.4 — brownfield-only. */
  gitRepoUrl?: string;
  gitBranch?: string;
  lastPulledAt?: string | null;
  lastCommitSha?: string | null;
  /**
   * Story 21.1 (party-push Epic 21) — per-project push toggle. When true,
   * the daemon passes `--push` to party-checkpoint.sh. Mirrors the field
   * in functions/shared/types/party.ts. Defaults to false for legacy rows.
   */
  pushEnabled?: boolean;
  /** Opt-in: auto-open a draft PR after a successful checkpoint push. */
  autoOpenPr?: boolean;
  /** Opt-in: after a pushed checkpoint, auto-merge to main + reap + DONE. */
  autoMerge?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrored from functions/shared/types/party.ts. Keep in sync. */
export const DEFAULT_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'] as const;
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
  /**
   * Story 20.6 (party-push Epic 20) — per-session worktree path. Identical
   * to `projectPath` for post-party-push sessions; undefined for legacy.
   */
  worktreePath?: string;
  /**
   * Story 19.4 — branch name `party/<projectId>/<sessionIdShort>`. Used by
   * Story 22.3's Open-PR endpoint and Story 22.5's checkpoint card.
   */
  partyBranch?: string;
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
  | 'party.refresh.started'
  | 'party.refresh.step.started'
  | 'party.refresh.step.output'
  | 'party.refresh.step.completed'
  | 'party.refresh.completed'
  | 'party.refresh.failed'
  // Story 21.4 + 21.5 + 22.x (party-push Epic 21 + Epic 22)
  | 'party.checkpoint.composed'
  | 'party.checkpoint.pushed'
  | 'party.checkpoint.blocked'
  | 'party.checkpoint.failed'
  | 'party.agent.question'
  | 'party.tool.default-allow';

export interface PartyEvent {
  jobId: string;
  eventSeq: string;
  timestamp: string;
  eventType: PartyEventType | string;
  [key: string]: unknown;
}

// Kept in sync with functions/shared/types/party.ts.
// BMAD 6.3.x stock install ships 6 agents; custom-agent overlay deferred.
export const EXPECTED_AGENT_COUNT = 6;

export interface PartyListProjectsResponse {
  projects: PartyProject[];
  expectedAgentCount: number;
}

export interface PartyBootstrapResponse {
  jobId: string;
  projectId: string;
  projectPath?: string;
  kind?: PartyProjectKind;
}

/** Story 15.4 — brownfield create request body. */
export interface CreateBrownfieldProjectInput {
  name: string;
  gitRepoUrl: string;
  gitBranch?: string;
}

/** Story 15.4 — refresh response (202 Accepted). */
export interface PartyRefreshResponse {
  jobId: string;
  projectId: string;
}

export interface PartySendMessageResponse {
  jobId: string;
  sessionId: string;
}

export interface PartyEventsResponse {
  events: PartyEvent[];
  lastSeq: string;
}
