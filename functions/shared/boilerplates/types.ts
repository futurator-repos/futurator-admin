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

  // ── Pipeline v2.0 PR-8 (Q2.3) — QA-stage context ────────────────────────
  //
  // Consumed by the qa-prepare shell step so each boilerplate boots its
  // dev server with the right command, port, and warm-up. Replaces the
  // PR-7-and-earlier hardcode that assumed every plan was Vite at :5173.
  // Reviewer addendum §16.11 motivated extending the registry instead of
  // duplicating these constants in the qa pipeline.
  qaContext?: {
    /** Default dev-server port. Bash kills any process on this port before
     *  boot, so it MUST be unique per boilerplate. Vite=5173, Next=3000. */
    defaultPort: number;
    /** HTTP path the boot loop curl-checks for HTTP 200. Usually `/`. */
    healthcheckPath: string;
    /** Shell command (run from `workingDir`) that boots the dev server.
     *  Must background itself and write logs; qa-prepare does NOT add
     *  any subshell-detach wrapping (see visual-qa-pipeline for the
     *  detach idiom). Example: `npm run dev -- --host 0.0.0.0 --port`. */
    devCommand: string;
    /** Extra ms to wait AFTER the healthcheck returns 200 before taking
     *  screenshots — covers SSR shells that 200 immediately but render
     *  asynchronously (Next.js, SST). 0 for client-rendered Vite. */
    warmupMs: number;
    /** Console-error regex patterns the QA stage tolerates. Each entry
     *  matches a substring of a console.error line; matched lines do not
     *  count toward an L0 console-error failure. */
    consoleErrorAllowList: string[];
  };

  // ── PR-13 — Starter pack architecture (Option A) ────────────────────────
  //
  // Each registry entry can optionally be a "starter pack" — a curated
  // domain-specific scaffold that pre-bakes the primitives an LLM would
  // otherwise re-derive every plan. See
  // docs/concepts/pipeline-v2/starter-pack-architecture.md for the full
  // design.

  /**
   * If set, this entry IS a starter pack inheriting from `baseStarter`.
   * The daemon's app-bootstrap saga clones the BASE template repo, then
   * writes `augmentFiles[]` on top, then commits + pushes. Inline-augment
   * model — see §3 of the architecture doc for rationale.
   *
   * Undefined for `*-base` entries; their `templateRepo` is the actual
   * GitHub template the daemon clones.
   */
  baseStarter?: BoilerplateType;

  /**
   * Domain taxonomy for the recommender + UI grouping. `general` is the
   * fallback when no specific domain matches (`*-base` entries).
   */
  domain?: 'general' | 'game' | 'form' | 'dashboard' | 'ecommerce' | 'api';

  /**
   * Plain-English capability sentences fed verbatim to the recommender's
   * Haiku call. Examples: "Canvas2D rendering with RAF game loop",
   * "Multi-step form wizards with zod validation".
   */
  capabilities?: string[];

  /**
   * Sample intents this starter handles well. Pasted into the recommender
   * prompt as positive examples. 3-5 entries.
   */
  exampleIntents?: string[];

  /**
   * Files to write on top of the base after clone, before commit. Each
   * entry is `{ path: <relative-to-workingDir>, content: <UTF-8 string> }`.
   * The first entry by convention is `SCAFFOLD.md` (mirrored as
   * `scaffoldContract` for fast PM access without disk reads).
   *
   * The daemon's app-bootstrap step writes these atomically — on any
   * write error, the saga fails and the operator retries.
   */
  augmentFiles?: Array<{ path: string; content: string }>;

  /**
   * Mirror of the SCAFFOLD.md augment file, embedded as a string so the
   * API Lambda can include it in the PM prompt without depending on the
   * cloned working tree being readable from Lambda. Stays in sync with
   * `augmentFiles[0]` via a registry-level test.
   *
   * The PM prompt builder reads this as the AUTHORITATIVE contract: any
   * story whose touch points intersect the contract's "Pre-baked" file
   * list is REJECTED at API time.
   */
  scaffoldContract?: string;
}
