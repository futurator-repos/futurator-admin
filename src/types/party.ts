export type BmadStatus =
  | 'MISSING'
  | 'INSTALLING'
  | 'HEALTHY'
  | 'DRIFTED'
  | 'CORRUPTED'
  | 'FAILED'
  | 'REFRESHING';

export type PartySessionStatus = 'ACTIVE' | 'PROCESSING' | 'IDLE' | 'ERROR' | 'ARCHIVED';

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
  | 'party.refresh.failed';

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
