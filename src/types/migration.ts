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
}

export interface UpdateMigrationResponse {
  projectId: string;
  patRotated: boolean;
  envVarKeys: string[];
  envVarCount: number;
}

export interface DeleteMigrationResponse {
  projectId: string;
  sessionsDeleted: number;
  secretScheduled: boolean;
  note?: string;
}
