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

  // ── Pipeline v2.0 PR-5: PM-prompt context ───────────────────────────────
  //
  // Consumed by `buildPmPlanPrompt` to generate boilerplate-aware Plan JSON
  // instead of the previous "every plan is Vite+React+TS" hardcode. When
  // missing the prompt falls back to a generic shape; populate this for any
  // boilerplate that has its own conventions.
  pmContext?: {
    /** One-line framework descriptor used in the PM prompt header. */
    framework: string;
    /**
     * Files / structure that are ALREADY in the cloned boilerplate. The PM
     * agent must NOT propose stories that "set up" these — they exist.
     * Examples: "package.json with Next.js 16 deps", "src/app/page.tsx",
     * "tsconfig.json strict mode".
     */
    scaffoldedAlready: string[];
    /**
     * Conventional file locations the PM should reference when writing story
     * descriptions. Boilerplate-specific so the LLM doesn't invent paths.
     */
    conventions: {
      /** Where domain types live, e.g. "src/types/" or "app/types/". */
      typesPath: string;
      /** Source root, e.g. "src/" or "app/". */
      sourceRoot: string;
      /** Where pages/routes live, e.g. "src/app/" (Next 15+) or "src/pages/" (Vite). */
      pagesOrAppPath: string;
      /** Where shared components live. */
      componentsPath: string;
      /** Where the global stylesheet is. */
      stylesPath: string;
      /** Where unit tests are colocated, e.g. "src/**\/__tests__/". */
      testsPath: string;
      /** Top-level config files the PM should leave alone unless intent requires it. */
      configFiles: string[];
    };
    /**
     * Example AC bullets that match this boilerplate's voice. Used as the
     * "match this style" exemplar in the prompt. 3-5 entries; verifiable;
     * boilerplate-specific (e.g., Next: "next dev exits 0", Vite: "vite build exits 0").
     */
    exampleAcceptanceCriteria: string[];
  };
}
