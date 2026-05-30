/**
 * App — the immortal top-level unit of work in Labs (App/Plan v1).
 *
 * An App owns:
 *   • the deployed product identity (slug = URL segment = working-tree folder)
 *   • the working directory on EC2 (shared across all of the App's Plans)
 *   • the deploy history (every deploy job ever run, oldest first)
 *   • a pointer to whichever Plan produced the currently-live bundle
 *   • the working-tree cleanliness flag (set when a Plan abandons mid-flight)
 *
 * An App has 1..N Plans (one `kind=initial`, plus any number of `change` /
 * `experiment` Plans). Plans are iterations on the App; the App lives forever.
 *
 * See `docs/tech-spec-app-plan-v1.md` and `docs/epics-app-plan-v1.md`.
 */

export type AppExecutionMode = 'pipeline' | 'orchestrator';

export type AppWorkingTreeStatus = 'clean' | 'dirty-from-abandoned-plan';

/**
 * Pipeline v2 boilerplate type the App was provisioned from.
 *
 * Optional during the migration window (Stories 1.4.1–1.4.4): legacy Apps
 * created before the saga shipped will not have this field; consumers must
 * default to `'nextjs'` when undefined (matching the Story 1.8.3 fallback
 * cited in Story 1.4.4 constraints).
 */
// PR-13 — `nextjs` renamed to `nextjs-base`; new starter packs added.
// Legacy 'nextjs' kept for backward-compat with already-stored App rows;
// consumers normalize via `normalizeBoilerplateType` from registry.ts.
export type AppBoilerplateType =
  | 'nextjs-base'
  | 'nextjs-canvas-game'
  | 'nextjs-form-app'
  | 'nextjs-dashboard'
  | 'sst'
  | 'vite'
  | 'mobile'
  | 'nextjs'; // legacy

export interface App {
  /** Primary key. Kebab-case slug, locked at creation. URL segment under `futurator.ai/apps/<appId>/`. */
  appId: string;

  /** Human-readable display name. Mutable. */
  displayName: string;

  /** Optional emoji icon. Defaults to '📦' when absent. */
  icon?: string;

  /** Filesystem path on the daemon EC2 box: `/home/ubuntu/projects/<appId>`. */
  workingDir: string;

  /** Default execution mode for new Plans on this App. Plans may override. */
  executionMode: AppExecutionMode;

  /** PlanId that produced the currently-live bundle, or null pre-first-deploy. */
  currentlyDeployedPlanId: string | null;

  /** Append-only list of every deploy job ever run for this App (oldest first). */
  deployJobIds: string[];

  /**
   * Working-tree state. `'dirty-from-abandoned-plan'` is set atomically when a
   * Plan transitions to `abandoned` — the daemon then refuses to dispatch any
   * jobs for the App until the operator clicks "Mark resolved" (which flips
   * the flag back to 'clean').
   */
  workingTreeStatus: AppWorkingTreeStatus;

  /**
   * Pipeline v2 — boilerplate template the App was scaffolded from. Stored on
   * the App row so Phase 2 ARCHITECT (deploy taxonomy) and Phase 3 SKILL-SCOUT
   * (skill loadouts) can dispatch on it without a registry round-trip.
   * Optional — undefined for legacy pre-v2 Apps (default `'nextjs'`).
   */
  boilerplateType?: AppBoilerplateType;

  /**
   * Pipeline v2 — whether the BMAD pre-install step ran during App-bootstrap.
   * Optional — undefined for legacy Apps; defaults to `true` for `nextjs`,
   * `false` for stub types (sst/vite/mobile).
   */
  bmadEnabled?: boolean;

  /**
   * Pipeline v2 — ISO timestamp when the App-bootstrap saga last completed
   * successfully. Absent until the daemon's `commit-and-push` step finishes;
   * legacy Apps never set it.
   */
  bootstrappedAt?: string;

  /**
   * 2026-05-30 — the App's real GitHub repo, for ANY org (not just
   * `futurator-repos`). Populated for brownfield migrations from
   * `PartyProject.gitRepoUrl` (e.g. `https://github.com/Get-Really-Real/applicator.git`).
   * Absent for greenfield apps, which fall back to `futurator-repos/<appId>`.
   * The UI (RepositoryBadge, git-graph, file/tree views) reads this to link +
   * query the correct repo/owner instead of assuming `futurator-repos`.
   */
  githubRepoUrl?: string;

  /** 2026-05-30 — default branch tracked for `githubRepoUrl` (default 'main'). */
  githubBranch?: string;

  createdAt: string;
  updatedAt: string;
}

/**
 * Enriched shape returned by `GET /api/apps` to populate the Apps grid in one
 * round-trip. Computed server-side from the App + its Plans + its deploy jobs.
 */
export interface AppCardData extends App {
  /** Total Plans for this App (any status). */
  planCount: number;

  /** Iteration label of the currently-live Plan, or null. */
  currentlyLiveLabel: string | null;

  /** UI-friendly status, derived from App + active Plan + tree state. */
  derivedStatus: 'live' | 'building' | 'dirty-tree' | 'no-deploy';
}
