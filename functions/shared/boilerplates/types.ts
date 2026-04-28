import type { BoilerplateType } from './registry';

/**
 * A single post-create scaffold step the daemon executes after cloning the
 * boilerplate template. Steps are ordered and idempotent — re-running the
 * app-bootstrap pipeline does not duplicate work.
 */
export interface PostCreateStep {
  id: 'inject-app-values' | 'npm-install' | 'bmad-bootstrap' | 'commit-and-push';
  /**
   * For `inject-app-values` only: which files contain placeholders
   * (`__APP_SLUG__`, `__APP_DISPLAY_NAME__`) that the daemon will substitute.
   */
  targetFiles?: string[];
}

/**
 * Metadata for a single boilerplate type. This is the single source of truth
 * consumed by the API Lambda (`POST /api/apps`), the daemon's `app-bootstrap`
 * pipeline, and the `+ New App` modal (via a slim client-side view).
 *
 * Fields marked as Phase 2/3 are declared here so the field exists in the
 * type but are not consumed until those phases ship.
 */
export interface BoilerplateMetadata {
  type: BoilerplateType;
  displayName: string;
  /** Emoji used in the type-picker grid. */
  icon: string;
  /** GitHub repo that serves as the template, e.g. "futurator-repos/template-nextjs". */
  templateRepo: string;
  /**
   * Phase 1: only `'nextjs'` is `'wired'`. All others are `'stub'` — real GitHub
   * template repos (README only) that exercise the same `createRepoFromTemplate`
   * code path without a full scaffold.
   */
  status: 'wired' | 'stub';
  defaultStack: {
    runtime: 'node' | 'bun' | 'react-native';
    packageManager: 'npm' | 'pnpm' | 'bun';
    testCommand: string;
    devCommand: string;
    buildCommand: string;
  };
  /** Ordered post-create steps the daemon runs after cloning. */
  postCreateSteps: PostCreateStep[];
  /** Whether the BMAD inject step (`bmad-bootstrap`) can run for this type. */
  bmadSupported: boolean;

  // ── Phase 2/3 hooks (declared now; consumed later) ──────────────────────

  /** Phase 2: how the app is deployed. */
  defaultDeployFlavor?: 'static-site' | 'sst-app' | 'spa-on-cloudfront' | 'mobile-store';
  /** Phase 2: ARCHITECT default manifest seed (shape tightened in Phase 2). */
  defaultManifestSeed?: unknown;
  /** Phase 3: SKILL-SCOUT default skill loadout (shape tightened in Phase 3). */
  defaultSkillLoadout?: string[];
}
