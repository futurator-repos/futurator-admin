/**
 * Migrate-module — shapes shipped by the `/api/migrations*` endpoints.
 *
 * The Migrate UI is the operator-facing wrapper around brownfield Party
 * projects. Each Migration is a `PartyProject` of `kind: 'brownfield'`,
 * enriched at the API layer with the `App` row's icon + displayName + a
 * session count so the list view can render without N+1 fetches.
 *
 * Env-var VALUES are never returned over the wire — only keys. The full
 * map lives in DDB (encrypted at rest) and is read at clone/refresh
 * time by the daemon. Operators update them via PATCH.
 */

import type { BmadStatus } from '@/types/party';

export interface Migration {
  projectId: string;
  bmadStatus: BmadStatus;
  gitRepoUrl?: string;
  gitBranch?: string;
  lastPulledAt?: string | null;
  lastCommitSha?: string | null;
  patSecretName?: string;
  /** Sorted list of env-var KEY names — values are write-only via PATCH. */
  envVarKeys: string[];
  envVarCount: number;
  displayName: string;
  icon: string;
  sessionCount: number;
  /**
   * Story 21.1 (party-push Epic 21) — surfaces whether the operator has
   * flipped the per-project "Push enabled" toggle. The UI uses this to
   * render the toggle state; the daemon gates the checkpoint-push step on
   * it server-side (UI value is informational, not load-bearing).
   */
  pushEnabled: boolean;
  /** Opt-in: auto-open a draft PR after a successful checkpoint push. */
  autoOpenPr: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListMigrationsResponse {
  migrations: Migration[];
}

export interface CreateMigrationInput {
  /** Kebab-case project name → also becomes the working-dir slug. */
  name: string;
  gitRepoUrl: string;
  gitBranch?: string;
  /** Fine-grained GitHub PAT for THIS project. Required for first migration. */
  pat?: string;
  /** Map of UPPER_SNAKE_CASE env var → value, written to `<projectPath>/.env`. */
  envVars?: Record<string, string>;
}

export interface CreateMigrationResponse {
  jobId: string;
  projectId: string;
  projectPath?: string;
  kind?: 'brownfield' | 'greenfield';
}

export interface UpdateMigrationInput {
  /** New PAT (rotates the Secrets Manager secret). */
  pat?: string;
  /** Replaces the env-var map entirely. */
  envVars?: Record<string, string>;
  /**
   * Story 21.2 — flip the per-project "Push enabled" toggle. Flipping ON
   * requires a fresh PAT in the same PATCH body (the existing PAT is
   * contents:read; the upgrade scope is contents:write). The API rejects
   * `pushEnabled: true` without `pat` because forgetting to rotate would
   * leave checkpoint pushes failing silently in 30 days when the read-only
   * PAT expires.
   */
  pushEnabled?: boolean;
  /**
   * Opt-in auto-PR. Independent of pushEnabled in the request (no PAT needed
   * to flip it), but only has effect server-side when pushEnabled is also on.
   */
  autoOpenPr?: boolean;
}

export interface UpdateMigrationResponse {
  projectId: string;
  patRotated: boolean;
  envVarKeys: string[];
  envVarCount: number;
  /** Story 21.2 — current state of the per-project push toggle. */
  pushEnabled: boolean;
  /** Current state of the per-project auto-open-PR toggle. */
  autoOpenPr: boolean;
}

export interface DeleteMigrationResponse {
  projectId: string;
  sessionsDeleted: number;
  secretScheduled: boolean;
  note?: string;
}
