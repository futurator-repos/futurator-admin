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
  /**
   * Migrate-module — AWS Secrets Manager secret name holding the
   * fine-grained PAT for THIS brownfield project. Defaults to
   * `futurator/brownfield-pat/<projectId>` so the daemon can derive it
   * without an extra lookup. When unset (legacy rows like the original
   * `applicator` migration), the daemon falls back to the shared
   * `futurator/labs-brownfield-github-pat`.
   */
  patSecretName?: string;
  /**
   * Migrate-module — environment variables the project needs at runtime.
   * Written verbatim to `<projectPath>/.env` after clone + refresh.
   * Stored in DDB (encrypted at rest with AWS-managed KMS); operator can
   * rotate via the Migrate UI. Use Secrets Manager for the PAT (above)
   * because IAM scoping is per-secret; envVars are not subject to the
   * same auth boundary so DDB is fine.
   */
  envVars?: Record<string, string>;
  /**
   * Story 21.1 (party-push Epic 21) — when true, the daemon's
   * `party-checkpoint.sh` is allowed to run its push step. Defaults to
   * undefined (treated as false). Flipped on by the operator via the
   * Migrate UI's "Push enabled" toggle, which atomically rotates the
   * project's PAT to a contents:write scope at the same time. Per
   * `plan.md` §1 decision 2 this is opt-in per project, never default-on.
   */
  pushEnabled?: boolean;
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
  /**
   * Working-directory the daemon spawns `claude -p` in.
   *
   * Pre-party-push (legacy) — `/home/ubuntu/projects/<projectId>`, the
   * single shared project folder.
   *
   * Post-party-push (Epic 20) — bootstrap rewrites this to the
   * per-session worktree path (`/home/ubuntu/worktrees/<projectId>/_party/<sidShort>/`)
   * so the daemon's `cwd: session.projectPath` line in party-turn.mjs
   * still resolves correctly without code changes. The canonical
   * worktree path also lands in `worktreePath` (below) for the
   * reaper + delete cascade.
   */
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
  /**
   * Story 19.4 (party-push Epic 19) — per-session worktree path. Written by
   * the post-migration bootstrap (Story 20.6). Equal to `projectPath` for
   * post-party-push sessions; undefined for legacy sessions that still use
   * the shared `/home/ubuntu/projects/<projectId>` folder.
   */
  worktreePath?: string;
  /**
   * Story 19.4 — branch name `party/<projectId>/<sessionIdShort>`. Written
   * by Story 20.6 bootstrap when the worktree is created. Undefined for
   * legacy sessions.
   */
  partyBranch?: string;
  /**
   * Story 19.4 — operator cancel flag, set by `POST /api/party/sessions/:id/cancel`
   * (route lives in Epic 22). The daemon's shared cancel-poller
   * (`daemon/pipelines/lib/cancel-poller.mjs`, Story 19.2) reads this each
   * tick and SIGTERMs the subprocess on `true`. Cleared atomically by
   * `poller.stop()` at turn close (§13.2).
   */
  cancelRequested?: boolean;
  /** Story 19.4 — ISO 8601 timestamp the cancel flag was set. */
  cancelRequestedAt?: string;
  /** Story 19.4 — ISO 8601 timestamp of the last write to this row. */
  updatedAt?: string;
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
  /**
   * Migrate-module — per-project PAT lookup. Daemon resolves this via
   * Secrets Manager before the clone step. Falls back to the legacy
   * shared secret when absent (back-compat for `applicator`).
   */
  patSecretName?: string;
  /** Migrate-module — env vars written to <projectPath>/.env post-clone. */
  envVars?: Record<string, string>;
}

export interface PartyRefreshJobPayload {
  projectId: string;
  projectPath: string;
  gitBranch: string;
  /** Migrate-module — re-syncs <projectPath>/.env after `git reset --hard`. */
  envVars?: Record<string, string>;
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
  | 'party.refresh.failed'
  // Story 21.4 + 21.5 (party-push Epic 21) — daemon-emitted checkpoint
  // events. The .pushed variant carries `commitSha + branch + pushed:true`
  // when party-checkpoint.sh successfully pushes to GitHub; .composed
  // means the commit landed locally but push was gated off; .blocked
  // means the secrets scan stopped the commit; .failed covers any other
  // non-zero exit (incl. exit 5 = push attempted but failed — commit DID
  // land locally with `pushed:false`).
  | 'party.checkpoint.composed'
  | 'party.checkpoint.pushed'
  | 'party.checkpoint.blocked'
  | 'party.checkpoint.failed'
  // Story 20.7 (Epic 20) — already wired by party-turn.mjs but missing
  // from the union. The agent-extracted ASK_HUMAN marker becomes this
  // event; the UI's inline-questions list (Story 22.6) renders it.
  | 'party.agent.question'
  // Story 20.3 (Epic 20) — party-tool-hook.sh's default-allow audit
  // emits this when it falls through to allow. The audit drawer
  // (Story 22.7) surfaces these so operators can grow the deny-list
  // from real signal.
  | 'party.tool.default-allow';

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

/** Derive the Secrets Manager secret name for a brownfield project's PAT. */
export function brownfieldPatSecretNameFor(projectId: string): string {
  return `futurator/brownfield-pat/${projectId}`;
}

/** Legacy shared secret name (pre-Migrate-module migrations like `applicator`). */
export const LEGACY_SHARED_BROWNFIELD_PAT_SECRET = 'futurator/labs-brownfield-github-pat';
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
