import type { BoilerplateType } from './registry';

/**
 * A single post-create scaffold step the daemon executes after cloning the
 * boilerplate template. Steps are ordered and idempotent — re-running the
 * app-bootstrap pipeline does not duplicate work.
 */
export interface PostCreateStep {
  id:
    | 'inject-app-values'
    | 'prepin-default-skills'
    | 'vendor-skills'
    | 'npm-install'
    | 'bmad-bootstrap'
    | 'commit-and-push';
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
  /**
   * Pipeline v2 Phase 3-C Epic 2 (Story 2.1, 2026-05-19) — default skill
   * loadout pre-pinned at app-bootstrap time, bypassing SKILL-SCOUT for
   * the v1 cut. Each entry is a `<skill>@<source>` token where `<source>`
   * matches a federation source id from
   * `daemon/lib/federation-loader.mjs::EMBEDDED_DEFAULT_FEDERATION` (e.g.
   * `anthropic-official`, `futurator-internal`).
   *
   * The new bootstrap step `prepin-default-skills` (Story 2.2) rewrites
   * the empty `.claude/skills.manifest.yaml` scaffold (PR-71) to declare
   * these under `core[]`. The subsequent `vendor-skills` step (Story 2.3)
   * runs `scripts/skills-sync.mjs` to fetch each SKILL.md into
   * `.claude/skills/<name>/`. Claude Code's built-in `Skill` tool then
   * auto-activates them on relevance — verified by the Story 2.0 probe
   * (`docs/concepts/logs/skills-probe-2026-05-19/`).
   *
   * `null` for stub boilerplates (sst/vite/mobile) — the daemon skips
   * the prepin + vendor steps. `undefined` is treated identically by
   * the step (skips with reason `no-default-loadout`); explicit `null`
   * is preferred for documentation parity with `skillManifest` /
   * `baselineCapture`.
   *
   * SKILL-SCOUT (Epic 3) will eventually replace this hardcoded loadout
   * with intent-driven proposals — when that ships, this field becomes
   * the bootstrap-time fallback for projects pre-SKILL-SCOUT.
   */
  defaultSkillLoadout?: string[] | null;

  /**
   * Pipeline v2 Phase 2-A Story 2-A-4-2 (PR-35) — baseline-diff regression
   * gate config. `null` for stub boilerplates that haven't shipped tests
   * yet (SST / Vite / Mobile in Phase 2); the daemon skips the gate when
   * null. Wired starters point at scripts shipped in the template repo.
   *
   * See `docs/concepts/pipeline-v2/baseline-diff-design.md` for the full
   * design (capture-test-baseline.sh + check-regressions.sh, daemon hook
   * placement, rigor matrix, acceptBaselineDrift mechanism).
   */
  baselineCapture?: {
    /** Path within the working tree to the wave-start capture script. */
    scriptPath: string;
    /** Path within the working tree to the post-DEV regression check. */
    regressCheckPath: string;
    /** Stable name for the test runner — surfaced in attention items. */
    testRunner: 'vitest' | 'jest' | 'playwright' | 'mocha';
  } | null;

  /**
   * Pipeline v2 Phase 1 worktree rollout (2026-05-19) — post-merge
   * validation command. Run by the wave-merge service in the coordinator
   * worktree AFTER `git merge --no-ff wip/<storyId>` succeeds for all
   * stories in the wave. Non-zero exit triggers `wave-build-failed`
   * attention and flips the wave to `fixing`.
   *
   * `null` for stub boilerplates that haven't shipped test infra (sst /
   * vite / mobile). The wave-merge service treats `null` as "skip
   * validation, accept the clean merge" and logs a note. Adding a new
   * framework = one-line registry change.
   *
   * See `docs/concepts/pipeline-v2/worktree-rollout-design.md` §4.
   */
  postMergeValidationCmd?: string | null;

  /**
   * v2.6 wave-gate quality stages (2026-06-11) — rigor-aware replacement for
   * the single `postMergeValidationCmd` string, consumed by the wave-merge
   * runner. Two stage kinds:
   *
   *  - `mechanical`: run ALWAYS at mvp+ rigor, NEVER fail the gate (each
   *    command is `|| true`-guarded by the runner); their file output rides
   *    the existing "regenerated files from post-merge validation" commit.
   *    Formatting/auto-fix is never a gate failure — enforcement is a
   *    blocking concern.
   *  - `blocking`: ordered commands per rigor tier; non-zero exit fails the
   *    gate and flows into the agentic build-fix path. Tiers compose UP:
   *    prototype = build only (and PR-30 skips the gate entirely at
   *    prototype today); production adds zero-warning lint, knip and
   *    format:check on top of mvp.
   *
   * `null`/undefined ⇒ the runner falls back to `postMergeValidationCmd`
   * unchanged (legacy apps + stub boilerplates keep today's behavior).
   * Commands that reference scripts/configs the app may not have MUST be
   * self-guarding (`--if-present` / `if [ -f … ]`) so apps bootstrapped
   * before this field landed keep merging.
   */
  qualityGate?: {
    mechanical: string[];
    blocking: { prototype: string[]; mvp: string[]; production: string[] };
  } | null;

  /**
   * Pipeline v2 Phase 3-C Story 3-C-2-1 (PR-71) — project skill manifest
   * paths. `null` for stub boilerplates that don't ship the skill
   * scaffold yet (SST / Vite / Mobile in Phase 1 stubs); the daemon
   * skips SKILL-SCOUT for those types until they're wired.
   *
   * `manifestPath` is the lockfile-semantics YAML the daemon reads to
   * compute the Skills-Used commit metadata line (Story 3-C-4-1) and the
   * Skills-Manifest-Sha SHA. `syncScriptPath` is the in-project Node
   * script (`npx skills sync`) operators or the daemon invoke to fetch
   * declared skill bodies from federation sources.
   *
   * See v2.5 §36 + `docs/concepts/pipeline-v2/epics-pipeline-v2-phase-3.md`
   * Story 3-C-2-1 for the full design (sync semantics, drift detection,
   * gitignore policy on `.claude/skills/`).
   */
  skillManifest?: {
    /** Path within the working tree to the manifest YAML, e.g. `.claude/skills.manifest.yaml`. */
    manifestPath: string;
    /** Path within the working tree to the Node sync script, e.g. `scripts/skills-sync.mjs`. */
    syncScriptPath: string;
  } | null;

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

    /**
     * D1-A2/A3 (2026-06-22) — 2-3 BROWSER-AC exemplars in THIS boilerplate's
     * domain voice, used as the "concrete, screen-verifiable" examples in the
     * PM prompt's visual-coverage block. Replaces the hardcoded canvas/sprite/HUD
     * few-shot that biased every plan toward games. Absent → the prompt falls
     * back to a domain-neutral spanning set (dashboard card / form field / nav).
     * Each must be screen-verifiable: count + color/style + position + a fail
     * clause where the signal isn't obvious.
     */
    exampleBrowserAc?: string[];

    /**
     * D1-A4 (2026-06-22) — neutral hint for the foundation "define core domain
     * types" example story. e.g. game: "GameStatus, Entity, GameState";
     * dashboard: "Metric, Series, DashboardConfig". Absent → a domain-neutral
     * placeholder ("the 2-3 core domain types the intent implies"). NEVER
     * hardcode one domain's entity names into the universal example.
     */
    exampleDomainTypes?: string;

    /**
     * D1-A10 (2026-06-22) — a coupled-sibling worked example in this domain (the
     * anti-pattern where ONE behavior spans two parallel stories). Absent → a
     * domain-neutral CRUD example. Avoids Pacman-as-universal-law in the prompt.
     */
    coupledSiblingExample?: string;
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
    /** v2.6 wave-gate VQA — gitignored dev-server build-cache directory
     *  (e.g. `.next`). The wave VQA env-fix path deletes it and reboots
     *  when triage classifies a failure as environmental (the dino1
     *  corrupted-Turbopack-cache class). Optional; absent = no cache
     *  clean available. */
    buildCacheDir?: string;
  };

  /**
   * Concept/VQA v3 (E5.1 / H6) — the verifiability seam contract. A UI-bearing
   * boilerplate declares a test-only `window.__harness` so probes can read app
   * state deterministically (L2-state oracle) instead of guessing from pixels.
   * The *shape* is generator-owned (the `__harness.schema.json` of §6.2); DEV
   * only conforms the running app to it + populates values (tamper-guarded, H1).
   * Absent for non-UI / not-yet-wired boilerplates (v1 = canvas-game only, H8).
   */
  testHarness?: {
    /** Global the probe reads, e.g. `window.__harness`. */
    globalKey: string;
    /** Property that flips true once the app is ready to inspect, e.g. `ready`. */
    readySignal: string;
    /** Domain snapshot shape: jsonPath → { type, enum? }. The locked manifest (§6.2). */
    snapshotShape: Record<string, { type: string; enum?: string[] }>;
    /** Test-mode boundary stubs (OAuth/payment/chat-partner) the seam can install (E11). */
    stubs?: string[];
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
   * D1-A1 (2026-06-22) — UI feature-mounting model, consumed by
   * `buildPmPlanPrompt` to render the "make visibility structural" block.
   *
   *  - `'feature-registry'`: the nextjs-* starters ship `scripts/generate-wiring.mjs`
   *    + a `src/features/*.feature.tsx` registry, so a UI story makes its output
   *    judgeable by REGISTERING a feature (additive, no hot-file conflicts) and the
   *    final assembly marks one feature `primary` to own `/`. Inherited by every
   *    nextjs-base derivative via `createStarterPack`.
   *  - `'route'` (or undefined): features mount on their own real routes; visual QA
   *    reaches each by navigating to the route the AC names. The general default
   *    for multi-route apps (SaaS dashboards, API admins) where `/` is a
   *    marketing/login page, not the feature surface.
   *
   * Before this flag, the prompt emitted feature-registration as universal law,
   * corrupting the file layout of any non-single-page app. The block is now
   * rendered from this capability instead.
   */
  wiring?: 'feature-registry' | 'route';

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
   * dino1 root-cause (2026-06-10) — npm scripts to merge into the
   * scaffolded package.json at bootstrap (only keys not already present).
   * Needed because `package.json` ships from the TEMPLATE repo, so plain
   * augmentFiles can't add lifecycle hooks without clobbering the file.
   * First use: `predev`/`prebuild` → the wiring generator, so every dev
   * server and build self-wires `src/features/*` into the page. Without
   * this the generator only ran at the wave-merge gate, its output was
   * discarded, and apps served the boilerplate starter at `/` while every
   * build gate stayed green.
   */
  packageJsonScripts?: Record<string, string>;

  /**
   * pacman1 disease (2026-06-11) — devDependencies to merge into the
   * scaffolded package.json at bootstrap (only keys not already present;
   * template wins). Root cause this closes: the template shipped NO test
   * runner, so every story bolted its own onto package.json — parallel
   * stories collided textually on the file, different waves pinned
   * different vitest majors (^2 vs ^4), the lockfile churned per wave
   * (full re-install + new node_modules store entry), and test files
   * written under one runner era hard-errored under the next. Shared
   * infrastructure must be template-owned and story-immutable; stories
   * only own their feature modules. Runs before npm-install so the
   * bootstrap lockfile pins these from day one.
   */
  packageJsonDevDependencies?: Record<string, string>;

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
