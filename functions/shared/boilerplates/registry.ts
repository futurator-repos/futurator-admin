import type { BoilerplateMetadata } from './types';
import {
  FEATURE_WIRING_GENERATOR_MJS,
  FEATURE_REGISTRY_README,
  GITATTRIBUTES_GENERATED,
} from '../codegen/feature-wiring';

// ── Story D (agentic-integration, 2026-05-29) — generated-wiring augments ──
// Ship the feature-registry primitive into every nextjs-* app: a generator
// script, the convention README, and a .gitattributes marker. Features
// register themselves under src/features/<name>.feature.tsx; src/app/page.tsx
// is GENERATED from them, so no story hand-edits the hot wiring file and the
// single biggest merge-conflict source is eliminated by construction. The
// daemon's post-merge gate runs the generator before `next build` (see
// postMergeValidationCmd below), so the candidate always builds the correctly
// integrated page from the union of all merged features.
const FEATURE_WIRING_AUGMENTS: Array<{ path: string; content: string }> = [
  { path: 'scripts/generate-wiring.mjs', content: FEATURE_WIRING_GENERATOR_MJS },
  { path: 'src/features/README.md', content: FEATURE_REGISTRY_README },
  { path: '.gitattributes', content: GITATTRIBUTES_GENERATED },
];

// pacman1 disease (2026-06-11) — template-owned test infrastructure.
// The template shipped no test runner, so every story bolted vitest onto
// package.json itself: parallel stories conflicted on the file, waves
// pinned different vitest majors, the lockfile churned every wave, and
// test files written under one runner era hard-errored under the next
// ("No test suite found" on compile-time-only test files). Shipping the
// runner + config at bootstrap makes test infra story-immutable: stories
// write tests, never test plumbing. `@` alias mirrors tsconfig;
// `passWithNoTests` keeps wave-0 gates green before any tests exist.
// v2.6 wave-gate quality (2026-06-11) — template-owned code-quality infra,
// same template-owned/story-immutable doctrine as TEST_INFRA_AUGMENTS.
// Blocking enforcement (eslint budgets, knip, format:check) lives at the
// WAVE GATE scaled by plan rigor (see `qualityGate` below); these files only
// give every app the tools + configs. The husky pre-commit hook is
// mechanical-only (--fix/--write) and a fast no-op below production rigor,
// so a hook can never brick or slow an agent commit.
const QUALITY_INFRA_AUGMENTS: Array<{ path: string; content: string }> = [
  {
    path: '.prettierrc',
    content: `{
  "semi": true,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "all"
}
`,
  },
  {
    path: '.prettierignore',
    content: `node_modules
.next
out
dist
coverage
package-lock.json
.pipeline
.mycelium
.context
knowledge
src/app/page.tsx
*.gen.*
`,
  },
  {
    path: 'knip.json',
    content: `{
  "entry": [
    "src/app/**/{page,layout,template,loading,error,not-found,route}.{ts,tsx}",
    "src/features/*.feature.tsx"
  ],
  "project": ["src/**/*.{ts,tsx}"],
  "ignore": ["src/components/ui/**"]
}
`,
  },
  {
    path: 'lint-staged.config.mjs',
    content: `// @generated-template — mechanical-only staged fixes (see .husky/pre-commit).
export default {
  '*.{ts,tsx,js,jsx,mjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,css}': ['prettier --write'],
};
`,
  },
  {
    path: '.husky/pre-commit',
    content: `# @generated-template — pipeline pre-commit chain.
#
# 1) Frozen-file guard (PR-41, .husky/pre-commit-frozen) — BLOCKING,
#    rigor-independent tamper defense. Dormant until v2.6 wired husky
#    (nothing ever invoked the -frozen file: husky only runs hooks named
#    exactly after the git hook).
# 2) Mechanical-only quality fixes (lint-staged: eslint --fix + prettier
#    --write) — must NEVER fail a commit (|| true) and is a fast no-op
#    below production rigor. Blocking quality enforcement lives at the
#    wave gate, not here. .pipeline/rigor is written by the daemon at plan
#    start; missing file = unknown rigor = skip. Agent worktrees skip
#    hooks entirely (they never run npm prepare, so .husky/_ is absent).
if [ -f .husky/pre-commit-frozen ]; then
  bash .husky/pre-commit-frozen || exit 1
fi

RIGOR=$(cat .pipeline/rigor 2>/dev/null || true)
[ "$RIGOR" = "production" ] || exit 0
npx lint-staged --quiet || true
`,
  },
];

// ── ALWAYS-MOUNT harness base (QA-Review seam cure, layer 4) ────────────────
// The seam previously published ONLY from inside the boilerplate's seam hook —
// if a dev bypassed the hook (pacman3: hand-rolled useReducer) the publisher
// was dead code and `window.__harness` never existed, blinding every QA probe.
// This template-owned file mounts a BASE harness the instant the app boots
// (Next auto-loads src/instrumentation-client.ts on the client — no layout
// edit, nothing for a story to forget). The base is honest: `snapshot()`
// returns `{ registered:false, status:'unregistered' }` until a real store
// registers, so probes fail with real values ("status is 'unregistered'")
// instead of the blind "seam not mounted". The boilerplate seam hook, when
// wired, simply overwrites/extends this base with the live store.
// GENERIC by design — no game/dashboard specifics; every Next boilerplate
// inherits it via the base pack.
const HARNESS_BASE_MOUNT_AUGMENTS: Array<{ path: string; content: string }> = [
  {
    path: 'src/instrumentation-client.ts',
    content: `/**
 * TEMPLATE-OWNED — do not edit in stories. QA verifiability base mount.
 *
 * Mounts a minimal \`window.__harness\` the moment the client boots, gated on
 * NEXT_PUBLIC_TEST_HARNESS === '1' (build-time inlined; tree-shaken out of
 * normal builds — the seam is PRODUCTION-ABSENT by design).
 *
 * The scaffold's seam hook (see SCAFFOLD.md) publishes the REAL live-state
 * seam and will overwrite this base when it mounts. Until then the base
 * answers honestly: snapshot() says nothing registered yet, so QA probes read
 * concrete values instead of finding no seam at all. A feature may also wire
 * itself explicitly via \`window.__harness.register(store)\`.
 */

type HarnessStore = {
  snapshot: () => Record<string, unknown>;
  dispatch?: (action: unknown) => void;
  forceStatus?: (status: string) => void;
};

export function register() {
  // Next.js instrumentation-client entrypoint (runs once per client boot).
  if (process.env.NEXT_PUBLIC_TEST_HARNESS !== '1') return;
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __harness?: unknown };
  if (w.__harness) return; // the real seam beat us — never clobber it
  let store: HarnessStore | null = null;
  // OBSERVE-ONLY seam (QA-Review W2): the READ lane (snapshot) + INPUT lane
  // (synthetic key/click, dispatched by Playwright) are always available under
  // the test-harness build. The DRIVE lane (dispatch/forceStatus) is gated on a
  // SEPARATE flag so QA probes reach states as a user, not by forcing them. When
  // drive is disabled the methods are DEFINED as warning no-ops — never left
  // undefined (a probe calling an undefined method would throw → a false-fail).
  const driveEnabled = process.env.NEXT_PUBLIC_TEST_HARNESS_DRIVE === '1';
  const driveDisabled = () => console.warn('[harness] drive lane disabled (observe-only)');
  w.__harness = {
    ready: true,
    registered: false,
    events: [] as unknown[],
    snapshot: () =>
      store ? store.snapshot() : { registered: false, status: 'unregistered' },
    register(s: HarnessStore) {
      store = s;
      (w.__harness as { registered?: boolean }).registered = true;
    },
    dispatch: driveEnabled ? (action: unknown) => store?.dispatch?.(action) : () => driveDisabled(),
    forceStatus: driveEnabled ? (status: string) => store?.forceStatus?.(status) : () => driveDisabled(),
  };
}

register();
`,
  },
];

const TEST_INFRA_AUGMENTS: Array<{ path: string; content: string }> = [
  {
    path: 'vitest.config.ts',
    content: `import { defineConfig } from 'vitest/config';
import path from 'path';

// @generated-template — shipped by the app bootstrap. Stories must NOT
// modify test infrastructure (runner, config, deps); see CLAUDE.md.
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`,
  },
];

/**
 * All supported app boilerplate / starter-pack types.
 *
 * PR-13 — `nextjs` was renamed to `nextjs-base` (the legacy `'nextjs'`
 * literal is still accepted via `normalizeBoilerplateType` for backward
 * compatibility with existing App rows). New entries are starter packs
 * derived from a base (see `BoilerplateMetadata.baseStarter`).
 */
export type BoilerplateType =
  | 'nextjs-base'
  | 'nextjs-canvas-game'
  | 'nextjs-form-app'
  | 'nextjs-dashboard'
  | 'sst'
  | 'vite'
  | 'mobile';

/**
 * PR-13 — backward-compat shim for legacy App rows. Old apps stored
 * `boilerplateType: 'nextjs'`; the registry now keys on `'nextjs-base'`.
 * This helper lets every reader normalize without scattering ternaries.
 */
export function normalizeBoilerplateType(raw: string | undefined | null): BoilerplateType {
  if (!raw) return 'nextjs-base';
  if (raw === 'nextjs') return 'nextjs-base';
  return raw as BoilerplateType;
}

// ── PR-13 — nextjs-canvas-game scaffold contract + augment files ──────────
//
// The contract is the SCAFFOLD.md content (mirrored both into the augment
// files for the working tree AND into the registry's `scaffoldContract`
// field so the API Lambda can pass it to the PM prompt without reading
// from the cloned tree). Keep the two in sync via the augment file's
// content field always being `NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT`.

const NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT = `# Scaffold contract — nextjs-canvas-game

## Pre-baked (DO NOT generate stories that recreate)
- Next.js 16 + TS strict + Tailwind v4 + shadcn primitives (from nextjs-base)
- \`src/hooks/useGameLoop.ts\` — RAF-based, typed, auto-cancel on unmount
- \`src/hooks/useKeyboard.ts\` — typed keydown/keyup with auto-cleanup
- \`src/game/physics.ts\` — \`applyGravity()\`, \`collide(a, b)\`, \`tween()\`
- \`src/game/state-machine.ts\` — typed \`useReducer\` wrapper for game state.
  ALSO publishes the test-only \`window.__harness\` verifiability seam
  (QA probes read it). It is PRE-BAKED — do NOT author or edit the seam;
  just use \`useGameStateMachine\` and your state is exposed automatically.
- \`src/game/types.ts\` — \`GameStatus\`, \`Entity\`, \`GameState<T>\` generics.
  QA \`assert\` probes read \`window.__harness.snapshot()\` →
  \`{ status, score, tick, entities, gameOver }\` + any domain fields you add
  to \`GameState\` (e.g. \`lives\`). Conform your game to this shape.
- \`src/components/GameCanvas.tsx\` — canvas mount + ResizeObserver wiring
- \`src/app/page.tsx\` — **generated** from \`src/features/\` by
  \`scripts/generate-wiring.mjs\` (DO NOT edit; register a feature instead)
- \`scripts/generate-wiring.mjs\` + \`src/features/README.md\` — the feature
  registry (additive wiring; no hot-file conflicts)

## Forbidden story patterns (PM must NOT emit)
- "Define core game types" → use the \`GameState<T>\` generic, extend with your domain entities
- "Set up game loop" → import \`useGameLoop\`
- "Wire keyboard input" → import \`useKeyboard\`
- "Create canvas component" → use \`<GameCanvas/>\`
- "Set up Tailwind / tsconfig / Next config" → done in nextjs-base
- "Install Next.js / React / TypeScript" → done in nextjs-base
- "Bootstrap project from scratch" → done in nextjs-base
- "Wire the game into the home page / edit src/app/page.tsx" → \`page.tsx\` is
  GENERATED from \`src/features/\`. Register a feature instead (see below).

## Required story patterns
- "Implement <entity> rendering on the canvas"
- "Wire <gameplay-event> through the state machine"
- "Add <input-action> via useKeyboard"
- "Implement collision rules between <entity-a> and <entity-b>"
- "Add scoring / lives / game-over UI overlay"

## Authoring visual tests (QA probes)
Author each AC's \`visual-tests.md\` entry by its \`verify\` intent:
- \`appearance\` → ONE screenshot of the relevant surface (no flow).
- \`state\` / \`behavior\` → a \`flow:\` probe that DRIVES the game, then
  \`assert\`s \`window.__harness.snapshot()\` (the PRE-BAKED seam) — do NOT
  author a single idle-frame screenshot for these; an idle frame cannot
  observe post-interaction state and will fail / come back UNVERIFIABLE.
- \`build\` → no visual test (a unit/typecheck covers it).
Worked behavior probe:
  flow:
    - { action: press, key: "Space" }                  # start
    - { action: clock, clockMode: runFor, ms: 5000 }   # advance time, no real wait
    - { action: screenshot, label: "mid-play" }
    - { action: assert, expr: "snapshot.status", op: eq, expected: "running" }
The seam exposes \`{ status, score, tick, entities, gameOver }\` + any field
you add to \`GameState\` (e.g. \`lives\`). Assert against those keys.

## The feature DESCRIPTOR is NOT a test surface (slug / order / primary)
\`feature.slug\`, \`feature.order\`, and \`feature.primary\` are WIRING metadata:
\`generate-wiring.mjs\` reads them by STATIC PARSE and visual QA verifies the
right app renders at \`/\`. They are MUTATED by the promotion lifecycle — the
final-assembly story flips an interim preview's \`primary\`/\`order\`/\`slug\` to the
real app values. A unit test asserting \`feature.slug\` / \`feature.order\` /
\`feature.primary\` therefore FREEZES a transient value as a permanent contract:
once the feature is promoted that test is unsatisfiable AND the promotion story
cannot fix it (it must not edit another story's test). HARD RULES:
- NEVER write a test that asserts \`feature.slug\`, \`feature.order\`, or
  \`feature.primary\`. Test the component's RENDERED OUTPUT instead.
- The promotion/assembly story sets \`primary: true\`; that is verified by the
  generator + the \`/\` visual-QA frame, NOT by a unit test.
- An interim preview and the final assembly should be SEPARATE feature files;
  the assembly DELETES each retired preview \`*.feature.tsx\` AND its colocated
  test, listing both in its \`touchPoints\`.

## Conventions
- Add domain entity types to \`src/game/types.ts\` (extend, don't replace)
- Place new entities under \`src/game/entities/<name>.ts\`
- Place render helpers under \`src/components/canvas/<Entity>Render.tsx\`
- ALL game logic must be reducer-pure — no side effects in tick handlers
- Mount the game by REGISTERING A FEATURE — create
  \`src/features/<name>.feature.tsx\` exporting \`{ feature: { slug, order } }\`
  + a default component (see \`src/features/README.md\`). \`src/app/page.tsx\` is
  **generated** from that directory by \`scripts/generate-wiring.mjs\`; NEVER
  hand-edit it. Each feature is its own file on a disjoint path, so parallel
  stories never collide on the wiring file.
`;

// VQA v3 E5.1/E5.2 — the canvas-game seam snapshot shape, defined ONCE so the
// registry `testHarness.snapshotShape`, the generator-emitted
// `__harness.schema.json` (E5.5 tamper-guarded), and any read path stay in
// sync. Domain games ADD keys to GameState (e.g. `lives`); those ride the
// snapshot additively and need no change here.
const CANVAS_GAME_SNAPSHOT_SHAPE: Record<string, { type: string; enum?: string[] }> = {
  status: { type: 'string', enum: ['idle', 'running', 'paused', 'over', 'win'] },
  score: { type: 'number' },
  tick: { type: 'number' },
  entities: { type: 'array' },
  gameOver: { type: 'boolean' },
};

// E5.5 (H1/§6.2) — the LOCKED `__harness.schema.json` manifest format:
// `{ globalKey, snapshot:{<jsonPath>:{type,enum?}}, events:[] }`. Shipped as a
// committed scaffold file so the seam's SHAPE is generator-owned; the
// story-pipeline tamper-check reverts any DEV/fixer edit to it (DEV may only
// conform the running app + populate values — FR-30).
const CANVAS_GAME_HARNESS_SCHEMA_JSON = `${JSON.stringify(
  { globalKey: 'window.__harness', snapshot: CANVAS_GAME_SNAPSHOT_SHAPE, events: [] },
  null,
  2,
)}\n`;

const NEXTJS_CANVAS_GAME_AUGMENTS: Array<{ path: string; content: string }> = [
  // SCAFFOLD.md FIRST — convention. Mirror of NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT.
  { path: 'SCAFFOLD.md', content: NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT },

  // VQA v3 E5.5 — generator-owned seam shape contract (tamper-guarded).
  { path: '__harness.schema.json', content: CANVAS_GAME_HARNESS_SCHEMA_JSON },

  {
    path: 'src/game/types.ts',
    content: `/**
 * Game type primitives — PR-13 nextjs-canvas-game starter.
 *
 * Extend with domain-specific entity types in this file or in
 * \`src/game/entities/<name>.ts\`. Do NOT replace these primitives.
 */

export type GameStatus = 'idle' | 'running' | 'paused' | 'over' | 'win';

export interface Entity {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GameState<TEntity extends Entity = Entity> {
  status: GameStatus;
  score: number;
  tick: number;
  entities: TEntity[];
}

export const initialGameState = <T extends Entity = Entity>(): GameState<T> => ({
  status: 'idle',
  score: 0,
  tick: 0,
  entities: [],
});
`,
  },

  {
    path: 'src/game/physics.ts',
    content: `/**
 * Physics primitives — PR-13 nextjs-canvas-game starter.
 *
 * Pure functions only. Reducer-callable. No DOM, no timers, no state.
 */

import type { Entity } from './types';

/** Apply gravity to a vertical velocity. \`newVy = vy + gravity * dtSec\`. */
export function applyGravity(vy: number, gravity: number, dtSec: number): number {
  return vy + gravity * dtSec;
}

/** AABB collision test. Returns true when rectangles overlap. */
export function collide(a: Entity, b: Entity): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Linear interpolation. Used for tween animations. */
export function tween(from: number, to: number, t: number): number {
  return from + (to - from) * Math.max(0, Math.min(1, t));
}
`,
  },

  {
    path: 'src/game/state-machine.ts',
    content: `/**
 * Typed reducer wrapper — PR-13 nextjs-canvas-game starter.
 *
 * Wraps React's useReducer with a typed action union. The reducer is
 * called from the game-loop hook every RAF tick AND from event handlers
 * (keyboard / touch). Reducer must be pure.
 */

import { useReducer, useCallback, useRef, useEffect } from 'react';
import type { GameState, Entity } from './types';

export type GameAction<TEntity extends Entity = Entity> =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'over' }
  | { type: 'tick'; dtSec: number }
  | { type: 'addEntity'; entity: TEntity }
  | { type: 'removeEntity'; id: string }
  | { type: 'addScore'; delta: number }
  // VQA v3 Phase 2b — TEST-ONLY force-state action. The seam wrapper handles it
  // (sets status directly) so a QA probe can reach a terminal state (over/win)
  // deterministically in <1 frame instead of playing to it. Never dispatched by
  // app code; only via window.__harness.forceStatus under NEXT_PUBLIC_TEST_HARNESS.
  | { type: '__force'; status: string };

export type GameReducer<TEntity extends Entity = Entity> = (
  state: GameState<TEntity>,
  action: GameAction<TEntity>,
) => GameState<TEntity>;

/**
 * Returns \`[state, dispatch, latestState]\`.
 *
 * \`latestState\` is a ref-backed live value — useful inside tick handlers
 * where dispatch is async and the next frame may need the latest state
 * synchronously without stale closures.
 */
export function useGameStateMachine<TEntity extends Entity = Entity>(
  reducer: GameReducer<TEntity>,
  initial: GameState<TEntity>,
) {
  // VQA v3 Phase 2b — the seam wrapper intercepts the TEST-ONLY \`__force\`
  // action (set status directly) before delegating to the app reducer, so a QA
  // probe can reach a terminal state deterministically. Pure for all real actions.
  const wrapped = useCallback(
    (s: GameState<TEntity>, a: GameAction<TEntity>): GameState<TEntity> =>
      a.type === '__force' ? { ...s, status: (a as { status: string }).status } : reducer(s, a),
    [reducer],
  );
  const [state, dispatch] = useReducer(
    wrapped as React.Reducer<GameState<TEntity>, GameAction<TEntity>>,
    initial,
  );
  const ref = useRef(state);
  ref.current = state;
  const safeDispatch = useCallback(dispatch, []);

  // ── VQA v3 verifiability seam (test-only) ──────────────────────────────
  // Publishes the live game state to \`window.__harness\` so QA probes can
  // read it deterministically (the L2-state \`assert\` oracle) instead of
  // guessing from a screenshot. The snapshot reads the \`ref\` (always the
  // latest state — no stale closure), so this mounts ONCE.
  //
  // PRODUCTION-ABSENT: gated on \`NEXT_PUBLIC_TEST_HARNESS === '1'\`, which
  // Next.js inlines at build time. In a normal build the env is unset, the
  // branch is statically false, and the seam is tree-shaken out —
  // \`window.__harness\` never exists in production. The QA dev server boots
  // with the flag set; nothing else does. DO NOT remove the guard.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TEST_HARNESS !== '1') return;
    if (typeof window === 'undefined') return;
    // OBSERVE-ONLY seam: snapshot (READ) is always live under the test build;
    // the DRIVE lane (dispatch/forceStatus) is gated on a SEPARATE flag so QA
    // probes reach terminal states as a user plays, not by forcing them. When
    // disabled, the methods are DEFINED as warning no-ops (never undefined — a
    // probe calling an undefined method would throw → a false-fail).
    const driveEnabled = process.env.NEXT_PUBLIC_TEST_HARNESS_DRIVE === '1';
    const driveDisabled = () => console.warn('[harness] drive lane disabled (observe-only)');
    (window as unknown as { __harness?: unknown }).__harness = {
      ready: true,
      // Generator-owned shape (boilerplate registry testHarness): the raw
      // GameState plus a derived \`gameOver\`. Domain fields added to
      // GameState (e.g. \`lives\`) ride along automatically.
      snapshot: () => ({ ...ref.current, gameOver: ref.current.status === 'over' }),
      events: [] as unknown[],
      // VQA v3 Phase 2b — TEST-ONLY command channel (DRIVE lane), gated on
      // NEXT_PUBLIC_TEST_HARNESS_DRIVE. Tree-shaken in production with the rest
      // of the seam (the NEXT_PUBLIC_TEST_HARNESS guard).
      dispatch: driveEnabled
        ? (action: GameAction<TEntity>) => safeDispatch(action)
        : () => driveDisabled(),
      forceStatus: driveEnabled
        ? (status: string) => safeDispatch({ type: '__force', status } as GameAction<TEntity>)
        : () => driveDisabled(),
    };
  }, [safeDispatch]);

  // VQA v3 Phase 2b — push a status-transition event so a probe can
  // \`waitForEvent\` on \`events\` (e.g. wait until a 'win' transition fires)
  // rather than only polling the latest snapshot.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TEST_HARNESS !== '1') return;
    if (typeof window === 'undefined') return;
    const h = (window as unknown as { __harness?: { events?: unknown[] } }).__harness;
    if (h && Array.isArray(h.events)) h.events.push({ type: 'status', value: state.status, at: Date.now() });
  }, [state.status]);

  return [state, safeDispatch, ref] as const;
}
`,
  },

  {
    path: 'src/hooks/useGameLoop.ts',
    content: `'use client';
/**
 * RAF-based game loop hook — PR-13 nextjs-canvas-game starter.
 *
 * Calls \`onTick(dtSec)\` every animation frame while \`running\` is true.
 * Auto-cancels on unmount. dtSec is delta-time in seconds since the
 * previous frame (capped at 0.1s to avoid catastrophic jumps after tab
 * backgrounding).
 */

import { useEffect, useRef } from 'react';

export function useGameLoop(onTick: (dtSec: number) => void, running: boolean) {
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      tickRef.current(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);
}
`,
  },

  {
    path: 'src/hooks/useKeyboard.ts',
    content: `'use client';
/**
 * Typed keyboard hook — PR-13 nextjs-canvas-game starter.
 *
 * Returns a stable \`isDown\` predicate keyed on \`event.code\` strings
 * (e.g. \`"Space"\`, \`"ArrowUp"\`). Auto-cleanup on unmount.
 */

import { useEffect, useRef, useCallback } from 'react';

export function useKeyboard() {
  const downRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => downRef.current.add(e.code);
    const onUp = (e: KeyboardEvent) => downRef.current.delete(e.code);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  const isDown = useCallback((code: string) => downRef.current.has(code), []);
  return { isDown };
}
`,
  },

  {
    path: 'src/components/GameCanvas.tsx',
    content: `'use client';
/**
 * GameCanvas — PR-13 nextjs-canvas-game starter.
 *
 * Mounts a <canvas> element with ResizeObserver wiring + a 2D context.
 * Calls \`render(ctx, w, h)\` whenever \`redrawTrigger\` changes AND after
 * every resize — including the FIRST one. A game passes a tick counter
 * from \`useGameLoop\` as \`redrawTrigger\`; a static scene (an idle
 * preview feature) may omit it entirely and still draws.
 *
 * pong1 (2026-06-12): the previous version only drew on redrawTrigger
 * changes, and the mount-time draw ran BEFORE the ResizeObserver
 * delivered the first size (sizeRef was 0×0 → early return). Anything
 * without a running game loop rendered a permanently blank canvas — every
 * idle preview feature shipped invisible. Drawing from the resize
 * callback (via a ref to the latest render) closes the race for both
 * static scenes and loop-driven games.
 *
 * Sized to fill its parent. DPR-aware. Non-prescriptive about gameplay.
 */

import { useEffect, useRef } from 'react';

export interface GameCanvasProps {
  render: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  /** Increment to force a redraw (tick from useGameLoop). Optional —
   *  static scenes draw on mount/resize without it. */
  redrawTrigger?: number;
  className?: string;
}

export function GameCanvas({ render, redrawTrigger = 0, className }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  // Latest render callback — lets the ResizeObserver draw without
  // re-subscribing (and without stale closures).
  const renderRef = useRef(render);
  renderRef.current = render;

  const drawRef = useRef(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderRef.current(ctx, width, height);
  };

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        sizeRef.current = { width, height };
        const canvas = canvasRef.current;
        if (canvas) {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';
        }
        // Resizing clears the canvas — redraw immediately (this is also
        // the FIRST draw: the observer fires once on observe()).
        drawRef.current();
      }
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    drawRef.current();
  }, [redrawTrigger, render]);

  return (
    <div ref={wrapperRef} className={className ?? 'w-full h-full relative'}>
      <canvas ref={canvasRef} className="absolute inset-0 block" />
    </div>
  );
}
`,
  },

  // Empty directory placeholders so git tracks the convention paths.
  { path: 'src/game/entities/.gitkeep', content: '' },
  { path: 'src/components/canvas/.gitkeep', content: '' },
];

// ── PR-35 — Baseline-diff regression gate scripts ──────────────────────────
//
// Per `docs/concepts/pipeline-v2/baseline-diff-design.md` §3. The daemon's
// app-bootstrap saga writes these into the working tree as augment files
// alongside SCAFFOLD.md. Wave-start hook calls capture-test-baseline.sh;
// post-DEV hook calls check-regressions.sh.
//
// All Next.js-derived boilerplates (base + canvas-game + form-app +
// dashboard) inherit them via `createStarterPack`'s augment merge.

const CAPTURE_TEST_BASELINE_SH = `#!/usr/bin/env bash
# Pipeline v2 baseline-diff — wave-start capture.
# See docs/concepts/pipeline-v2/baseline-diff-design.md §3.1.
set -e
cd "\${PROJECT_DIR:?PROJECT_DIR required}"
mkdir -p .pipeline
npm test --silent --reporter=json > .pipeline/baseline.json 2>&1 || true
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not installed — baseline capture cannot continue" >&2
  exit 2
fi
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \\
  .pipeline/baseline.json 2>/dev/null | sort > .pipeline/baseline-passing.txt
echo "captured $(wc -l < .pipeline/baseline-passing.txt | tr -d ' ') passing tests"
`;

const CHECK_REGRESSIONS_SH = `#!/usr/bin/env bash
# Pipeline v2 baseline-diff — post-DEV regression check.
# See docs/concepts/pipeline-v2/baseline-diff-design.md §3.2.
set -e
cd "\${PROJECT_DIR:?PROJECT_DIR required}"
mkdir -p .pipeline
if [ ! -s .pipeline/baseline-passing.txt ]; then
  echo "BASELINE_EMPTY: skip regression check"
  exit 0
fi

npm test --silent --reporter=json > .pipeline/after.json 2>&1 || true
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not installed — regression check cannot continue" >&2
  exit 2
fi
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \\
  .pipeline/after.json 2>/dev/null | sort > .pipeline/after-passing.txt

# Distinct case: runner produced empty after-passing — likely runner crash.
if [ ! -s .pipeline/after-passing.txt ]; then
  echo "TEST_RUNNER_FAILURE: post-DEV run produced zero passing tests" >&2
  echo "Inspect .pipeline/after.json for the runner error."
  exit 2
fi

regressions=$(comm -23 .pipeline/baseline-passing.txt .pipeline/after-passing.txt)
if [ -n "$regressions" ]; then
  echo "BASELINE_REGRESSION_DETECTED"
  echo "$regressions" | head -5
  count=$(echo "$regressions" | wc -l | tr -d ' ')
  echo "REGRESSION_COUNT=$count"

  case "\${RIGOR:-mvp}" in
    prototype)
      echo "WARNING — proceeding under prototype rigor"
      exit 0
      ;;
    mvp|production)
      exit 1
      ;;
  esac
fi
echo "BASELINE_OK"
`;

const BASELINE_DIFF_AUGMENTS: Array<{ path: string; content: string }> = [
  { path: 'scripts/capture-test-baseline.sh', content: CAPTURE_TEST_BASELINE_SH },
  { path: 'scripts/check-regressions.sh', content: CHECK_REGRESSIONS_SH },
  // .gitignore entry so .pipeline/ doesn't pollute commits.
  {
    path: '.pipeline/.gitignore',
    content: '# Pipeline v2 baseline-diff working dir — never commit\n*\n!.gitignore\n',
  },
];

// ── PR-41 — Frozen-file husky pre-commit hook (Story 2-A-5-2) ─────────────
//
// Defense-in-depth alongside the runtime tamper-check (Story 2-A-5-1). Per
// v2.5 §16: the husky pre-commit hook reads .pipeline/frozen.txt and
// refuses commits that touch any file listed there. Even if the
// `--disallowedTools` glob is somehow bypassed, git won't accept the
// commit.
//
// The hook is a no-op when `.pipeline/frozen.txt` is missing — for
// projects that haven't run a v2 plan yet, or for legacy commits
// originating outside the pipeline.

const FROZEN_FILE_PRECOMMIT_SH = `#!/usr/bin/env bash
# Pipeline v2 — frozen-file pre-commit guard (Story 2-A-5-2 / v2.5 §16).
# Refuses to commit changes to any file listed in .pipeline/frozen.txt.
# No-op when .pipeline/frozen.txt is missing.

if [ ! -f .pipeline/frozen.txt ]; then
  exit 0
fi

# Iterate staged files; fail with a clear message on the first match.
violations=""
while IFS= read -r staged; do
  if grep -qxF "$staged" .pipeline/frozen.txt 2>/dev/null; then
    violations="$violations\n  $staged"
  fi
done < <(git diff --cached --name-only)

if [ -n "$violations" ]; then
  echo "BLOCKED: pre-commit refuses staged changes to frozen files:" >&2
  printf "$violations\\n" >&2
  echo "" >&2
  echo "These files were locked at the end of the test-author step." >&2
  echo "If you legitimately need to modify them, the pipeline's" >&2
  echo "tamper-check + acceptBaselineDrift mechanism is the path." >&2
  exit 1
fi

exit 0
`;

// Frozen-file augments. Husky integration (v2.6, 2026-06-11): this file is
// NOT a hook name git/husky invokes — it is chained from the real
// `.husky/pre-commit` shipped by QUALITY_INFRA_AUGMENTS, and husky itself is
// installed by the template's `prepare: "husky"` script at bootstrap
// npm-install. (Before v2.6 nothing invoked this file and no `husky install`
// ever ran — the guard was dormant; the runtime tamper-check carried the
// defense alone.)
const FROZEN_FILE_AUGMENTS: Array<{ path: string; content: string }> = [
  { path: '.husky/pre-commit-frozen', content: FROZEN_FILE_PRECOMMIT_SH },
];

// ── PR-71 — Project skill manifest + sync script (Story 3-C-2-1) ──────────
//
// Every wired starter ships:
//   1. `.claude/skills.manifest.yaml`     — empty manifest scaffold; SKILL-
//                                            SCOUT T1 (Story 3-C-3-2) writes
//                                            the first set of pins.
//   2. `scripts/skills-sync.mjs`         — Node CLI invoked as `npx skills
//                                            sync` (or `node scripts/skills-
//                                            sync.mjs`). Fetches each declared
//                                            skill into `.claude/skills/<n>/`,
//                                            verifies SHA matches the manifest
//                                            entry's `version` pin, exits 0
//                                            on clean sync / 2 on drift.
//   3. `.claude/skills/.gitignore`       — Skills are vendored via sync;
//                                            only `SKILL.md` + `meta.json`
//                                            are committed. Skill bodies
//                                            (examples/, templates/, etc.)
//                                            stay local.
//
// v2.5 §36 + Phase 3 doc Story 3-C-2-1.

const SKILLS_MANIFEST_YAML = `# Project skill manifest — Pipeline v2.5 §36
# Operators don't edit by hand; SKILL-SCOUT (Story 3-C-3-2) writes pins
# at project init (T1) and at every plan intent (T2). Run
#   node scripts/skills-sync.mjs
# to materialize the listed skills into .claude/skills/<name>/.
project: __APP_SLUG__
manifest-version: 1
generated-by: bootstrap@v2.5
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`;

const SKILLS_SYNC_MJS = `#!/usr/bin/env node
/**
 * skills-sync.mjs — Pipeline v2 Phase 3 / Story 3-C-2-1.
 *
 * Reads .claude/skills.manifest.yaml from cwd. For each declared skill,
 * fetches its SKILL.md (+ optional helpers) from the federation source's
 * GitHub repo, pinned by sha:/tag: in the manifest, verifies the local
 * SHA matches, and writes to .claude/skills/<name>/.
 *
 * Exit codes:
 *   0  clean sync (all skills materialized + SHAs match)
 *   1  fatal error (manifest missing/malformed, network)
 *   2  drift — at least one local skill's SHA does not match the pin.
 *      Operator runs the script again with --resync to overwrite local,
 *      or invokes SKILL-SCOUT (\`/skills audit\`) to re-pin the manifest.
 *
 * No external deps beyond Node stdlib + yaml (transitive via project root).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'path';
import { parse as parseYaml } from 'yaml';

const MANIFEST_PATH = '.claude/skills.manifest.yaml';
const SKILLS_DIR = '.claude/skills';
const RESYNC = process.argv.includes('--resync');

function die(msg, code = 1) {
  console.error('[skills-sync] ' + msg);
  process.exit(code);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function rawUrl(sourceRepo, refPart, path) {
  return \`https://raw.githubusercontent.com/\${sourceRepo}/\${refPart}/\${path}\`;
}

async function fetchSkillFile(sourceUrl, version, path) {
  const refPart = version.startsWith('sha:') ? version.slice(4) : version.slice(4);
  const u = new URL(sourceUrl);
  const repo = u.pathname.replace(/^\\/+|\\/+$/g, '');
  const url = rawUrl(repo, refPart, path);
  const headers = { Accept: 'text/plain' };
  if (process.env.GITHUB_PAT) headers.Authorization = \`Bearer \${process.env.GITHUB_PAT}\`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(\`HTTP \${res.status} for \${url}\`);
  return await res.text();
}

if (!existsSync(MANIFEST_PATH)) die(\`manifest missing: \${MANIFEST_PATH}\`);
let manifest;
try {
  manifest = parseYaml(readFileSync(MANIFEST_PATH, 'utf-8'));
} catch (e) {
  die(\`manifest parse failed: \${e.message}\`);
}

const FEDERATION_PATH = process.env.FUTURATOR_FEDERATION_PATH
  || join(process.env.HOME || '', '.futurator', 'skill-federation.yaml');
if (!existsSync(FEDERATION_PATH)) {
  die(\`federation missing: \${FEDERATION_PATH} (operator must author this)\`);
}
const federation = parseYaml(readFileSync(FEDERATION_PATH, 'utf-8'));
const sourceById = new Map();
for (const src of federation.sources || []) sourceById.set(src.id, src);

const ALL_ENTRIES = [
  ...(manifest.core || []),
  ...(manifest.stack || []),
  ...(manifest.domain || []),
  ...(manifest.vendor || []),
];

if (ALL_ENTRIES.length === 0) {
  console.log('[skills-sync] manifest declares no skills — nothing to sync');
  process.exit(0);
}

let drift = 0;
for (const entry of ALL_ENTRIES) {
  const source = sourceById.get(entry.source);
  if (!source) {
    console.error(\`[skills-sync] WARN skipped \${entry.skill}: source '\${entry.source}' not in federation\`);
    continue;
  }
  const skillDir = join(SKILLS_DIR, entry.skill);
  const skillMdPath = join(skillDir, 'SKILL.md');
  let skillMd;
  try {
    skillMd = await fetchSkillFile(source.url, entry.version, \`\${entry.skill}/SKILL.md\`);
  } catch (e) {
    console.error(\`[skills-sync] ERROR fetch \${entry.skill}@\${entry.source}: \${e.message}\`);
    drift++;
    continue;
  }
  const remoteSha = sha256(skillMd);
  if (existsSync(skillMdPath) && !RESYNC) {
    const localSha = sha256(readFileSync(skillMdPath, 'utf-8'));
    if (localSha !== remoteSha) {
      console.error(\`[skills-sync] DRIFT \${entry.skill}@\${entry.source}: local SHA \${localSha.slice(0, 8)} != remote \${remoteSha.slice(0, 8)}\`);
      drift++;
      continue;
    }
    console.log(\`[skills-sync] OK    \${entry.skill}@\${entry.source}\`);
    continue;
  }
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillMdPath, skillMd, 'utf-8');
  console.log(\`[skills-sync] WROTE \${entry.skill}@\${entry.source} (\${remoteSha.slice(0, 8)})\`);
}

if (drift > 0) {
  console.error(\`[skills-sync] \${drift} drift(s) — rerun with --resync to overwrite local, or run /skills audit to re-pin\`);
  process.exit(2);
}
console.log('[skills-sync] all skills in sync');
process.exit(0);
`;

const SKILLS_DIR_GITIGNORE = `# Skill bodies are vendored via scripts/skills-sync.mjs (Story 3-C-2-1).
# Skill manifests + meta.json are the source of truth and are committed;
# the full skill content is fetched on demand from federation sources.
#
# 2026-05-30 (Story F) — the leading \`*\` ignores the skill SUBDIRECTORIES,
# and git never descends into an ignored directory, so \`!*/SKILL.md\` could
# never re-include anything: SKILL.md/meta.json were NEVER committed, so
# per-story worktrees had no skills and zero activation fired (dino1 forensic:
# skills:null). \`!*/\` re-includes the directories first, which is what makes
# the deeper un-ignore rules reachable. Heavy bodies (examples/, templates/)
# stay ignored because nothing un-ignores them.
*
!*/
!.gitignore
!*/SKILL.md
!*/meta.json
`;

const SKILL_MANIFEST_AUGMENTS: Array<{ path: string; content: string }> = [
  { path: '.claude/skills.manifest.yaml', content: SKILLS_MANIFEST_YAML },
  { path: 'scripts/skills-sync.mjs', content: SKILLS_SYNC_MJS },
  { path: '.claude/skills/.gitignore', content: SKILLS_DIR_GITIGNORE },
];

// ── PR-80 — Project CLAUDE.md template (Story 3-E-4-1) ────────────────────
//
// Per v2.5 §41.1 — the project's living document. PM agent populates the
// "What this is" section at project init; DEV agent appends to
// "Architecture decisions" on milestone-story completion; REFLECTOR
// proposes additions to "Patterns to use / avoid" and "Constraints
// discovered" via the Reflection Inbox (Story 3-E-3-1).
//
// The template OVERWRITES whatever the external template-nextjs repo's
// CLAUDE.md scaffolds. v2.5 §41.1 is the source of truth for shape; the
// boilerplate stays in sync via this augment.

const CLAUDE_MD_TEMPLATE = `# Project: __APP_DISPLAY_NAME__

> **Slug:** __APP_SLUG__
> **Repo:** https://github.com/futurator-repos/__APP_SLUG__
> **Created:** (set by daemon on first commit)

## Shared infrastructure is template-owned — do NOT modify

Stories run in PARALLEL worktrees and merge at a wave gate. Any file that is
global to the project will collide or drift if individual stories edit it.
Therefore stories must NEVER modify:

- \`package.json\` / lockfiles — no new dependencies or scripts. The test
  runner (\`npm test\` → vitest) and lifecycle hooks already ship with the
  scaffold. If your story seems to need a new dependency, implement with
  what the scaffold provides instead.
- \`vitest.config.ts\`, \`tsconfig.json\`, \`next.config.*\`, \`eslint\`/build
  config — test and build plumbing is fixed.
- \`.prettierrc\` / \`.prettierignore\` / \`knip.json\` /
  \`lint-staged.config.mjs\` / \`.husky/\` — code-quality plumbing is fixed;
  formatting and lint budgets are enforced at the wave gate, scaled by plan
  rigor. Never reformat files you don't own to satisfy a linter.
- \`@generated\` files (e.g. \`src/app/page.tsx\`) — regenerated by
  \`scripts/generate-wiring.mjs\`; register a \`src/features/*.feature.tsx\`
  instead (see \`src/features/README.md\`).

Your story owns ONLY its declared touch points. Tests must assert YOUR
story's code (plus already-merged contracts) — never a sibling story's
behavior.

## What this is

<!-- PM agent populates from project intent at init -->
<!-- One paragraph. The reader (or agent) opening this project for the
     first time should learn the user-facing purpose in three sentences. -->

## Architecture decisions

<!-- Append-only. Each entry: date — decision — rationale — proposed by.
     DEV agent appends on completing a milestone story (Story 3-E-4-1).
     Past entries are immutable; superseding decisions go below, never
     edit-in-place. -->

## Constraints discovered

<!-- REFLECTOR promotes things like "this client doesn't allow third-party
     fonts", "deployment region must be eu-central-1 for GDPR".
     Operator approval gates each addition (Reflection Inbox). -->

## Patterns to use

<!-- Project-specific patterns. REFLECTOR promotes from "what worked
     repeatedly" — v2.5 §44 Tier 0. -->

## Patterns to avoid

<!-- REFLECTOR promotes from "what hurt". Past mistakes that should
     stop showing up in future DEV output. -->

## Domain glossary

<!-- PM seeds at init from operator-named terms; subsequent agents append
     new terminology as they encounter it. -->

## Skills loaded by default for this project

<!-- Pointer to .claude/skills.manifest.yaml (the lockfile). This section
     lists the human-readable rationale: which skills, why they're here. -->

## AWS scoping reminder

<!-- For stream branches and operator terminals: which AWS profile to use,
     which resources are in-scope. Customized at project init from
     aws.manifest.yaml when ARCHITECT runs (Phase 2-D wire). -->

## Known issues / future enhancements

<!-- REFLECTOR promotes from "future-enhancement" proposals. Items here
     are NOT scheduled work — they're observations the operator may
     elevate to a plan when ready. -->
`;

const CLAUDE_MD_AUGMENTS: Array<{ path: string; content: string }> = [
  { path: 'CLAUDE.md', content: CLAUDE_MD_TEMPLATE },
];

// ── D1-A6/A7 (2026-06-22) — generic app-state verifiability seam + non-game
// scaffold contract for the nextjs-dashboard starter ───────────────────────
//
// The canvas-game seam (above) exposes GAME state ({status,score,tick,…}).
// Real multi-route apps (dashboards, SaaS, admin panels) have no game loop —
// their deterministic, QA-readable state is "where am I / am I signed in / did
// my last action succeed". This generic seam exposes exactly that, so a
// route-based app gets an L2-state oracle (not screenshot-only judging). Shape
// is generator-owned (tamper-guarded) and additive: a story may add fields to
// the snapshot, but must not author the seam itself.

const DASHBOARD_SNAPSHOT_SHAPE: Record<string, { type: string; enum?: string[] }> = {
  route: { type: 'string' },
  authStatus: { type: 'string', enum: ['loading', 'anonymous', 'authenticated'] },
  // `lastMutation` is an object|null ({ name, ok, at }) — declared as object so
  // probes can `assert snapshot.lastMutation.ok eq true` after a create/update.
  lastMutation: { type: 'object' },
  ready: { type: 'boolean' },
};

const DASHBOARD_HARNESS_SCHEMA_JSON = `${JSON.stringify(
  { globalKey: 'window.__harness', snapshot: DASHBOARD_SNAPSHOT_SHAPE, events: [] },
  null,
  2,
)}\n`;

// The REAL seam module (additive on nextjs-base, which already compiles). A
// component calls `useAppHarness().setRoute(...)` / `.setAuthStatus(...)` /
// `.recordMutation(...)`; the provider publishes `window.__harness` under the
// NEXT_PUBLIC_TEST_HARNESS guard (QA sets it; production never does → the seam
// is tree-shaken out). snapshot() reads a ref so it's always the latest state.
const APP_HARNESS_SEAM_TSX = `'use client';
/**
 * Generic app-state verifiability seam — nextjs-dashboard starter (D1-A6).
 *
 * PRE-BAKED — do NOT author or edit this seam (the story-pipeline tamper-check
 * reverts edits to __harness.schema.json). Wrap your app in <AppHarnessProvider>
 * (already wired in the root layout) and call the imperative API from your
 * routes/components to expose deterministic state to QA probes:
 *   - setRoute(pathname)          on navigation
 *   - setAuthStatus(status)       when auth resolves
 *   - recordMutation(name, ok)    after a create/update/delete settles
 *
 * QA reads window.__harness.snapshot() → { route, authStatus, lastMutation, ready }.
 * PRODUCTION-ABSENT: gated on NEXT_PUBLIC_TEST_HARNESS === '1' (QA dev server
 * only); a normal build tree-shakes the publish out. DO NOT remove the guard.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface LastMutation {
  name: string;
  ok: boolean;
  at: number;
}

export interface AppSnapshot {
  route: string;
  authStatus: AuthStatus;
  lastMutation: LastMutation | null;
  ready: boolean;
}

export interface AppHarnessApi {
  setRoute(route: string): void;
  setAuthStatus(status: AuthStatus): void;
  recordMutation(name: string, ok: boolean): void;
  snapshot(): AppSnapshot;
}

const AppHarnessContext = createContext<AppHarnessApi | null>(null);

export function AppHarnessProvider({
  children,
  initialRoute = '/',
}: {
  children: ReactNode;
  initialRoute?: string;
}) {
  const snap = useRef<AppSnapshot>({
    route: initialRoute,
    authStatus: 'loading',
    lastMutation: null,
    ready: false,
  });
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const apiRef = useRef<AppHarnessApi | null>(null);
  if (apiRef.current === null) {
    apiRef.current = {
      setRoute: (route) => {
        snap.current = { ...snap.current, route };
        bump();
      },
      setAuthStatus: (authStatus) => {
        snap.current = { ...snap.current, authStatus };
        bump();
      },
      recordMutation: (name, ok) => {
        snap.current = { ...snap.current, lastMutation: { name, ok, at: Date.now() } };
        bump();
      },
      snapshot: () => snap.current,
    };
  }
  const api = apiRef.current;

  useEffect(() => {
    snap.current = { ...snap.current, ready: true };
    if (typeof window === 'undefined') return;
    if (process.env.NEXT_PUBLIC_TEST_HARNESS !== '1') return;
    // OBSERVE-ONLY seam: this app-state seam exposes only READ (snapshot); it
    // has no DRIVE lane. Still DEFINE dispatch/forceStatus as warning no-ops
    // (gated for symmetry with the other seams) so a QA probe that calls them
    // never hits an undefined method and throws a false-fail.
    const driveDisabled = () => console.warn('[harness] drive lane disabled (observe-only)');
    (window as unknown as { __harness?: unknown }).__harness = {
      ready: true,
      snapshot: () => api.snapshot(),
      events: [] as unknown[],
      dispatch: driveDisabled,
      forceStatus: driveDisabled,
    };
  }, [api]);

  return <AppHarnessContext.Provider value={api}>{children}</AppHarnessContext.Provider>;
}

export function useAppHarness(): AppHarnessApi {
  const ctx = useContext(AppHarnessContext);
  if (ctx === null) {
    throw new Error('useAppHarness must be used within <AppHarnessProvider>');
  }
  return ctx;
}
`;

const NEXTJS_DASHBOARD_SCAFFOLD_CONTRACT = `# Scaffold contract — nextjs-dashboard

## Pre-baked (DO NOT generate stories that recreate)
- Next.js 16 + TS strict + Tailwind v4 + shadcn primitives (from nextjs-base)
- \`src/lib/app-harness.tsx\` — the test-only \`window.__harness\` app-state seam
  (\`AppHarnessProvider\` + \`useAppHarness\`). PRE-BAKED — do NOT author or edit it.
  Wrap is already in the root layout; call \`setRoute\` / \`setAuthStatus\` /
  \`recordMutation\` from your routes so QA \`assert\` probes can read state.
- \`scripts/generate-wiring.mjs\` + \`src/features/\` — the feature registry
  (additive wiring; parallel stories never collide on a hot file)

## This is a MULTI-ROUTE app — slice by ROUTE, not by single-page feature
- \`/\` is the dashboard shell / landing; real features live on their OWN routes
  (\`/billing\`, \`/users\`, \`/reports/<id>\`). A feature story MUST add a page under
  \`src/app/<route>/page.tsx\` and a browser AC describing what that route shows.
- Auth-gated surfaces: state the route's POST-navigation idle frame (a signed-in
  view), NOT what \`/\` shows at first load.

## Forbidden story patterns (PM must NOT emit)
- "Define an app-state store / context for route+auth state" → use \`useAppHarness\`
- "Author a window.__harness / test seam" → PRE-BAKED in \`src/lib/app-harness.tsx\`
- "Set up Tailwind / tsconfig / Next config" → done in nextjs-base
- "Install Next.js / React / TypeScript" → done in nextjs-base
- "Bootstrap project from scratch" → done in nextjs-base

## Required story patterns
- "Add the <name> route at \`src/app/<route>/page.tsx\` rendering <surface>"
- "Add the <resource> table/list with <columns> on the <route> route"
- "Wire <action> (create/update/delete) and call \`recordMutation('<action>', ok)\`"
- "Gate <route> behind auth; call \`setAuthStatus\` when the session resolves"

## Authoring visual tests (QA probes)
- \`appearance\` → ONE screenshot of the feature's ROUTE (post-navigation idle).
- \`state\` / \`behavior\` → a \`flow:\` that navigates + acts, then \`assert\`s
  \`window.__harness.snapshot()\` (PRE-BAKED seam) — e.g. after a create,
  \`assert snapshot.lastMutation.ok eq true\`. Do NOT author an idle screenshot
  for post-action state.
- \`build\` → no visual test (a unit/typecheck covers it).
The seam exposes \`{ route, authStatus, lastMutation, ready }\`. Assert those keys.

## Conventions
- One route = one \`src/app/<route>/page.tsx\`; shared UI under \`src/components/\`.
- Call the seam from a client component on each route so QA can verify it.
- Mount a feature by REGISTERING \`src/features/<name>.feature.tsx\` (additive) OR
  by adding its route page — both are disjoint paths, so parallel stories never
  collide on a hot wiring file.
`;

const NEXTJS_DASHBOARD_AUGMENTS: Array<{ path: string; content: string }> = [
  // SCAFFOLD.md FIRST — convention (mirror of NEXTJS_DASHBOARD_SCAFFOLD_CONTRACT).
  { path: 'SCAFFOLD.md', content: NEXTJS_DASHBOARD_SCAFFOLD_CONTRACT },
  // Generator-owned seam shape contract (tamper-guarded).
  { path: '__harness.schema.json', content: DASHBOARD_HARNESS_SCHEMA_JSON },
  // The real, self-contained app-state seam module.
  { path: 'src/lib/app-harness.tsx', content: APP_HARNESS_SEAM_TSX },
];

// PR-13 — nextjs-base config extracted to a top-level const so derivative
// starter packs can spread it (`{ ...NEXTJS_BASE_PACK, type: 'nextjs-...' }`)
// during the registry literal's construction. Inlining inside the literal
// would create a circular reference (the pack reads from a registry that
// is not yet bound).
const NEXTJS_BASE_PACK: BoilerplateMetadata = {
  type: 'nextjs-base',
  displayName: 'Next.js (base)',
  icon: '⚛️',
  templateRepo: 'futurator-repos/template-nextjs',
  status: 'wired',
  domain: 'general',
  // D1-A1 (2026-06-22) — this pack ships scripts/generate-wiring.mjs +
  // src/features/*.feature.tsx (FEATURE_WIRING_AUGMENTS), so it uses the
  // progressive-feature-registration model. Inherited by every nextjs-*
  // starter via createStarterPack. sst/vite/mobile omit it → route-based.
  wiring: 'feature-registry',
  capabilities: [
    'Generic Next.js 16 with App Router, TypeScript strict, Tailwind v4, shadcn primitives',
    "No domain-specific scaffolding — best fit when the intent doesn't match a more specific starter",
  ],
  exampleIntents: [
    'A simple landing page',
    'A blog with markdown posts',
    "Any Next.js app that doesn't fit a more specific starter",
  ],
  defaultStack: {
    runtime: 'node',
    packageManager: 'npm',
    testCommand: 'npm test',
    devCommand: 'npm run dev',
    buildCommand: 'npm run build',
  },
  postCreateSteps: [
    {
      id: 'inject-app-values',
      // PR-71 (Story 3-C-2-1): skills.manifest.yaml carries
      // `project: __APP_SLUG__` per the augment template.
      targetFiles: ['package.json', 'README.md', 'CLAUDE.md', '.claude/skills.manifest.yaml'],
    },
    { id: 'npm-install' },
    { id: 'bmad-bootstrap' },
    { id: 'commit-and-push' },
  ],
  bmadSupported: true,
  defaultDeployFlavor: 'static-site',
  pmContext: {
    framework: 'Next.js 16 with App Router (TypeScript, strict mode)',
    scaffoldedAlready: [
      'package.json with Next.js 16, React 19, TypeScript deps installed',
      'tsconfig.json (strict mode, paths alias `@/*` → `./src/*`)',
      'next.config.ts with output: "export" for static-site deploy',
      'src/app/layout.tsx + src/app/page.tsx (App Router root)',
      'src/app/globals.css (Tailwind v4 wired)',
      'src/components/ui/ (shadcn primitives)',
      '_bmad/ (BMAD agents installed)',
    ],
    conventions: {
      typesPath: 'src/types/',
      sourceRoot: 'src/',
      pagesOrAppPath: 'src/app/',
      componentsPath: 'src/components/',
      stylesPath: 'src/app/globals.css',
      testsPath: 'src/**/__tests__/',
      configFiles: ['package.json', 'tsconfig.json', 'next.config.ts', 'tailwind.config.ts'],
    },
    exampleAcceptanceCriteria: [
      'npm run build exits with code 0',
      'tsc --noEmit reports zero errors',
      'src/app/page.tsx renders without hydration warnings in dev mode',
      'All exports from src/types/index.ts are importable via `@/types`',
    ],
  },
  qaContext: {
    defaultPort: 3000,
    healthcheckPath: '/',
    devCommand: 'npm run dev -- --hostname 0.0.0.0 --port',
    warmupMs: 2000,
    consoleErrorAllowList: [
      'webpack-dev-server.*HMR',
      'next-route-announcer',
      'Download the React DevTools',
    ],
    // v2.6 — wave VQA env-fix path: delete + reboot on environment-classed
    // failures (dino1 corrupted-Turbopack-cache class).
    buildCacheDir: '.next',
  },
  // PR-35 — baseline-diff regression gate config + scripts. Inherited by
  // all nextjs-* starter packs via createStarterPack's augment merge.
  baselineCapture: {
    scriptPath: 'scripts/capture-test-baseline.sh',
    regressCheckPath: 'scripts/check-regressions.sh',
    testRunner: 'vitest',
  },
  // 2026-05-19 Phase 1 worktree rollout — post-merge validation runs in
  // the coordinator worktree after wave-merge completes successfully.
  // Inherited by all nextjs-* starter packs via createStarterPack.
  //
  // 2026-05-28 — was `npm test`, but the scaffold ships NO `test` script
  // (no vitest / no standalone tsc), so `npm test` always exited 1
  // ("Missing script: test") → every wave falsely blocked. The real
  // correctness gate that exists is `next build`, which type-checks
  // (verified on EC2: "Running TypeScript ... Finished") AND compiles —
  // exactly what validates a types/scaffold wave and catches cross-story
  // integration breakage. Tests run too when a future scaffold adds a
  // `test` script (`--if-present` is a no-op otherwise; the runner also
  // treats a no-op/"no tests" exit as pass — defense in depth).
  // Story D (2026-05-29) — regenerate the wiring file from src/features/
  // BEFORE the build, so the candidate compiles the correctly-integrated page
  // from the union of every merged feature. `--if-present`-style guard: the
  // generator is shipped via FEATURE_WIRING_AUGMENTS, so it exists on every
  // nextjs-* app; the `[ -f ]` test keeps the gate green on any legacy app
  // bootstrapped before the augment landed.
  postMergeValidationCmd:
    '[ -f scripts/generate-wiring.mjs ] && node scripts/generate-wiring.mjs; npm run build && npm run test --if-present',
  // PR-71 — Project skill manifest + sync script (Story 3-C-2-1).
  // Inherited by all nextjs-* starter packs.
  skillManifest: {
    manifestPath: '.claude/skills.manifest.yaml',
    syncScriptPath: 'scripts/skills-sync.mjs',
  },
  // Epic 2 Story 2.1 (2026-05-19) — default skill loadout pre-pinned at
  // app-bootstrap time. The base loadout applies to any nextjs-* starter
  // that doesn't override it (form-app inherits). canvas-game and dashboard
  // override below with starter-specific picks. Story 2.0 probe confirmed
  // these are auto-activated by Claude Code's built-in `Skill` tool when
  // prompt content matches the SKILL.md frontmatter description.
  defaultSkillLoadout: ['frontend-design@anthropic-official', 'webapp-testing@anthropic-official'],
  // PR-35 + PR-41 + PR-71 + PR-80 — base augments concat baseline-diff
  // scripts + frozen-file husky guard + skill manifest scaffold + CLAUDE.md
  // template. createStarterPack merges starter-specific augments on top.
  augmentFiles: [
    ...BASELINE_DIFF_AUGMENTS,
    ...FROZEN_FILE_AUGMENTS,
    ...SKILL_MANIFEST_AUGMENTS,
    ...CLAUDE_MD_AUGMENTS,
    ...FEATURE_WIRING_AUGMENTS,
    ...TEST_INFRA_AUGMENTS,
    ...QUALITY_INFRA_AUGMENTS,
    // Always-mount harness base (seam cure layer 4) — every Next boilerplate.
    ...HARNESS_BASE_MOUNT_AUGMENTS,
  ],
  // dino1 root-cause (2026-06-10) — the generator's own docblock always said
  // "wire as a package.json prebuild script" but nothing ever did it: the
  // template's package.json had bare `next dev`/`next build`, so every dev
  // server (in-story VQA, QA preview) served the starter page while the
  // wave-merge gate validated a wired build it then threw away. predev +
  // prebuild make the app self-wiring everywhere npm runs it.
  packageJsonScripts: {
    predev: 'node scripts/generate-wiring.mjs',
    prebuild: 'node scripts/generate-wiring.mjs',
    // pacman1 disease (2026-06-11) — template-owned test entry point so
    // story agents never add their own (see TEST_INFRA_AUGMENTS).
    test: 'vitest run',
    // v2.6 wave-gate quality (2026-06-11) — quality entry points consumed by
    // the rigor-scaled gate stages (`qualityGate` below). All gate usages are
    // `--if-present`-guarded, so legacy apps without these keep merging.
    format: 'prettier --write .',
    'format:check': 'prettier --check .',
    knip: 'knip',
    // husky installs its hook shims on npm-install (augments are written
    // BEFORE npm-install, so .husky/pre-commit exists when prepare runs).
    // Agent worktrees materialize node_modules without npm lifecycle, so
    // .husky/_ never exists there and hooks stay out of agent commits.
    prepare: 'husky',
  },
  // pacman1 disease (2026-06-11) — pin the runner at bootstrap. Stories
  // adding their own vitest caused per-wave version drift (^2 vs ^4) and
  // lockfile churn. Merged before npm-install, so the bootstrap lockfile
  // (and the shared node_modules store entry) carries it from day one.
  // v2.6 — same doctrine for the quality toolchain (prettier/knip/husky/
  // lint-staged): template-owned, story-immutable, pinned from day one.
  packageJsonDevDependencies: {
    vitest: '^4.1.8',
    prettier: '^3.5.3',
    knip: '^5.46.0',
    husky: '^9.1.7',
    'lint-staged': '^15.5.0',
  },
  // v2.6 wave-gate quality stages (2026-06-11) — consumed by the wave-merge
  // runner in place of the single `postMergeValidationCmd` (which stays as
  // the legacy fallback for apps/boilerplates without this field).
  // `mechanical` never fails the gate; `blocking` failures flow into the
  // agentic build-fix path. Guarded `if [ -f … ]` forms exit 0 on apps
  // bootstrapped before the corresponding config landed.
  qualityGate: {
    mechanical: [
      '[ -f scripts/generate-wiring.mjs ] && node scripts/generate-wiring.mjs || true',
      'npm run format --if-present',
      'if [ -f eslint.config.mjs ]; then npx eslint . --fix || true; fi',
    ],
    blocking: {
      prototype: ['npm run build'],
      mvp: [
        'npm run build',
        'npm run test --if-present',
        'if [ -f eslint.config.mjs ]; then npx eslint . --max-warnings 200; fi',
      ],
      production: [
        'npm run build',
        'npm run test --if-present',
        'if [ -f eslint.config.mjs ]; then npx eslint . --max-warnings 0; fi',
        'npm run knip --if-present',
        'npm run format:check --if-present',
      ],
    },
  },
};

/**
 * PR-13 — derive a nextjs-base-derivative starter pack. Inherits every
 * inheritable field (postCreateSteps, defaultStack, pmContext, qaContext,
 * templateRepo) from `NEXTJS_BASE_PACK`; the caller overrides what's
 * distinct. `templateRepo` is intentionally inherited — the daemon clones
 * the BASE template and writes augment files on top (inline-augment model,
 * see docs/concepts/pipeline-v2/starter-pack-architecture.md §3).
 */
function createStarterPack(
  type: BoilerplateType,
  overrides: Partial<BoilerplateMetadata> & {
    domain: NonNullable<BoilerplateMetadata['domain']>;
  },
): BoilerplateMetadata {
  // PR-35 — concat base augments (baseline-diff scripts) with starter-
  // specific augments so derivative packs don't lose the base files when
  // they declare their own `augmentFiles`. Order: overrides first (so a
  // starter's SCAFFOLD.md stays at position 0 — registry-level invariant);
  // base augments after (minus any path the override shadows).
  const baseAugments = NEXTJS_BASE_PACK.augmentFiles ?? [];
  const overrideAugments = overrides.augmentFiles ?? [];
  const overridePaths = new Set(overrideAugments.map((a) => a.path));
  const mergedAugments = [
    ...overrideAugments,
    ...baseAugments.filter((a) => !overridePaths.has(a.path)),
  ];

  return {
    ...NEXTJS_BASE_PACK,
    type,
    baseStarter: 'nextjs-base',
    status: overrides.status ?? 'wired',
    ...overrides,
    // Augments are explicitly merged (the spread above would replace).
    augmentFiles: mergedAugments.length > 0 ? mergedAugments : undefined,
  };
}

/**
 * Single source of truth for every boilerplate type.
 *
 * The `Record<BoilerplateType, …>` type enforces at compile time that every
 * member of the union has an entry — adding a new type without a registry
 * entry is a type error.
 */
export const BOILERPLATE_REGISTRY: Record<BoilerplateType, BoilerplateMetadata> = {
  'nextjs-base': NEXTJS_BASE_PACK,

  sst: {
    type: 'sst',
    displayName: 'SST (Phase 2)',
    icon: '☁️',
    templateRepo: 'futurator-repos/template-sst',
    status: 'stub',
    defaultStack: {
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'sst-app',
    pmContext: {
      framework: 'SST v4 (TypeScript) — Lambda + DynamoDB serverless app',
      scaffoldedAlready: [
        'package.json with SST v4 deps',
        'sst.config.ts (Pulumi-based)',
        'tsconfig.json (strict mode)',
        'functions/ root directory (Lambda handlers)',
      ],
      conventions: {
        typesPath: 'functions/shared/types/',
        sourceRoot: 'functions/',
        pagesOrAppPath: 'functions/api/',
        componentsPath: 'functions/api/handlers/',
        stylesPath: '',
        testsPath: 'functions/**/__tests__/',
        configFiles: ['package.json', 'tsconfig.json', 'sst.config.ts'],
      },
      exampleAcceptanceCriteria: [
        'sst dev exits cleanly when started',
        'tsc --noEmit reports zero errors',
        'New Lambda handler at functions/api/<route>.ts responds to a synthetic event',
      ],
    },
    qaContext: {
      // SST dev mode runs Lambda locally — no public dev URL by default.
      // For Phase 2 we'll add a built-in dev gateway; meanwhile QA on SST
      // boilerplates is a no-op until that ships.
      defaultPort: 13557,
      healthcheckPath: '/health',
      devCommand: 'npm run dev -- --port',
      warmupMs: 4000,
      consoleErrorAllowList: ['DEBUG\\sSDK', 'Pulumi\\sup'],
    },
    // PR-35 — stub: no test runner shipped yet. Daemon skips the gate.
    baselineCapture: null,
    // PR-71 — stub: no skill scaffold shipped yet. Daemon skips SKILL-SCOUT.
    skillManifest: null,
    // Epic 2 Story 2.1 — stub: no skill scaffold + no SKILL.md auto-discovery
    // value yet for SST projects (no canonical SST skill exists in
    // anthropic-official). Daemon's prepin-default-skills step short-circuits
    // on null. Revisit when an SST-specific skill ships in futurator-internal.
    defaultSkillLoadout: null,
    // 2026-05-19 Phase 1 — stub: no test infra, wave-merge skips validation.
    postMergeValidationCmd: null,
  },

  vite: {
    type: 'vite',
    displayName: 'Vite + React (Phase 2)',
    icon: '⚡',
    templateRepo: 'futurator-repos/template-vite',
    status: 'stub',
    defaultStack: {
      runtime: 'node',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npm run dev',
      buildCommand: 'npm run build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'spa-on-cloudfront',
    pmContext: {
      framework: 'Vite + React + TypeScript (strict mode)',
      scaffoldedAlready: [
        'package.json with Vite, React 19, TypeScript deps',
        'tsconfig.json (strict mode)',
        'vite.config.ts',
        'index.html (Vite entry)',
        'src/main.tsx (React root)',
        'src/App.tsx',
      ],
      conventions: {
        typesPath: 'src/types/',
        sourceRoot: 'src/',
        pagesOrAppPath: 'src/pages/',
        componentsPath: 'src/components/',
        stylesPath: 'src/index.css',
        testsPath: 'src/**/*.test.{ts,tsx}',
        configFiles: ['package.json', 'tsconfig.json', 'vite.config.ts'],
      },
      exampleAcceptanceCriteria: [
        'vite build exits with code 0',
        'tsc --noEmit reports zero errors',
        'src/App.tsx renders without console errors at localhost:5173',
        'All exports from src/types/index.ts are importable',
      ],
    },
    qaContext: {
      defaultPort: 5173,
      healthcheckPath: '/',
      devCommand: 'npm run dev -- --host 0.0.0.0 --port',
      // Vite returns immediately on first request; nothing to warm up.
      warmupMs: 0,
      consoleErrorAllowList: ['vite\\b.*HMR'],
    },
    // PR-35 — stub: no test runner shipped yet. Daemon skips the gate.
    baselineCapture: null,
    // PR-71 — stub: no skill scaffold shipped yet. Daemon skips SKILL-SCOUT.
    skillManifest: null,
    // Epic 2 Story 2.1 — stub: Vite + React would naturally want
    // `frontend-design`, but skillManifest scaffold isn't shipped on this
    // boilerplate yet, so prepin would have nothing to write into. Wire
    // when the Vite starter graduates from stub status.
    defaultSkillLoadout: null,
    // 2026-05-19 Phase 1 — stub: no test infra, wave-merge skips validation.
    postMergeValidationCmd: null,
  },

  mobile: {
    type: 'mobile',
    displayName: 'Expo Mobile (Phase 3)',
    icon: '📱',
    templateRepo: 'futurator-repos/template-mobile',
    status: 'stub',
    defaultStack: {
      runtime: 'react-native',
      packageManager: 'npm',
      testCommand: 'npm test',
      devCommand: 'npx expo start',
      buildCommand: 'npx expo build',
    },
    postCreateSteps: [
      {
        id: 'inject-app-values',
        targetFiles: ['README.md', 'CLAUDE.md'],
      },
      { id: 'commit-and-push' },
    ],
    bmadSupported: false,
    defaultDeployFlavor: 'mobile-store',
    pmContext: {
      framework: 'Expo (React Native + TypeScript)',
      scaffoldedAlready: [
        'package.json with Expo SDK + React Native deps',
        'tsconfig.json',
        'app.json (Expo config)',
        'App.tsx',
      ],
      conventions: {
        typesPath: 'src/types/',
        sourceRoot: 'src/',
        pagesOrAppPath: 'src/screens/',
        componentsPath: 'src/components/',
        stylesPath: '',
        testsPath: 'src/**/__tests__/',
        configFiles: ['package.json', 'tsconfig.json', 'app.json'],
      },
      exampleAcceptanceCriteria: [
        'npx expo start launches without errors',
        'tsc --noEmit reports zero errors',
        'App renders on iOS simulator without runtime errors',
      ],
    },
    qaContext: {
      // Mobile QA on a headless EC2 doesn't run the actual app — it runs
      // Expo's web target so playwright can screenshot. defaultPort matches
      // expo's default web port.
      defaultPort: 19006,
      healthcheckPath: '/',
      devCommand: 'npx expo start --web --port',
      warmupMs: 5000,
      consoleErrorAllowList: ['expo-cli', 'react-native-web.*deprecated'],
    },
    // PR-35 — stub: no test runner shipped yet. Daemon skips the gate.
    baselineCapture: null,
    // PR-71 — stub: no skill scaffold shipped yet. Daemon skips SKILL-SCOUT.
    skillManifest: null,
    // Epic 2 Story 2.1 — stub: Expo mobile has no skillManifest scaffold
    // yet and `react-native` runtime differs enough from web (no Canvas2D,
    // different test infra) that base nextjs skills wouldn't transfer
    // cleanly. Daemon skips prepin + vendor.
    defaultSkillLoadout: null,
    // 2026-05-19 Phase 1 — stub: no test infra, wave-merge skips validation.
    postMergeValidationCmd: null,
  },

  // ── PR-13 — Starter packs derived from nextjs-base ────────────────────────

  'nextjs-canvas-game': createStarterPack('nextjs-canvas-game', {
    displayName: 'Next.js — Canvas2D Game',
    icon: '🎮',
    domain: 'game',
    capabilities: [
      'Canvas2D rendering with a typed RAF-based game loop',
      'Keyboard input hook with auto-cleanup',
      'Reusable physics primitives (gravity, collision detection)',
      'Typed reducer-based game state machine',
      'Best for runners, platformers, top-down shooters, arcade-style games',
    ],
    exampleIntents: [
      'Build a Chrome dino offline runner',
      'Make a simple Flappy Bird clone',
      'Create a 2D platformer with jump and dash',
      'Top-down shooter with mouse aim',
      'Snake clone with score tracking',
    ],
    // Epic 2 Story 2.1 — canvas-game-specific loadout. `canvas-design` for
    // 2D rendering idioms, `algorithmic-art` for procedural sprite/animation
    // patterns (pixel-art snake heads, dino sprites, brick-breaker tiles).
    // `frontend-design` retained from base for general UI conventions.
    // `webapp-testing` dropped — canvas games rarely use DOM-centric tests
    // and Vitest baseline is already enforced by the per-story test-author
    // step.
    defaultSkillLoadout: [
      'canvas-design@anthropic-official',
      'frontend-design@anthropic-official',
      'algorithmic-art@anthropic-official',
    ],
    // D1-A2/A3/A4/A10 (2026-06-22) — game-domain few-shots live HERE as DATA,
    // not hardcoded in pm-plan-prompt.ts. The prompt pulls these when present
    // and falls back to a domain-neutral spanning set otherwise, so a SaaS /
    // dashboard / API plan is never dragged toward sprite/HUD framing. Spread
    // the inherited base pmContext so framework/conventions/scaffoldedAlready
    // are preserved (shallow override would otherwise drop them).
    pmContext: {
      ...NEXTJS_BASE_PACK.pmContext!,
      exampleBrowserAc: [
        'At game start (before any input) the canvas shows the player sprite standing on the ground band, with the score HUD reading "0" in the top-left corner.',
        'After pressing Space once, the player sprite rises visibly above the ground band within 500ms, then falls back (a jump arc).',
        'On collision with an obstacle, a "GAME OVER" overlay appears centered over the canvas.',
      ],
      exampleDomainTypes: 'GameStatus, Entity, GameState',
      coupledSiblingExample:
        'story A implements ghost movement/state, sibling B implements "Pacman eats a frightened ghost" — B\'s tests assume A\'s entities B never saw, both pass alone, and the merged union fails the wave gate.',
    },
    augmentFiles: NEXTJS_CANVAS_GAME_AUGMENTS,
    scaffoldContract: NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT,
    // VQA v3 E2 (H6/H8) — the verifiability seam. v1 ships for canvas-game
    // ONLY (the only wired UI starter). The shape is generator-owned: it
    // mirrors `GameState<T>` from src/game/types.ts, which the scaffold's
    // `useGameStateMachine` publishes to `window.__harness` under the
    // NEXT_PUBLIC_TEST_HARNESS guard (see src/game/types.ts seam block). DEV
    // only conforms the running game to this shape + populates values
    // (FR-30); the probe `assert` step reads these keys deterministically.
    // Domain games may ADD keys to GameState (e.g. `lives`) — they appear in
    // the snapshot additively and are assertable without registry changes.
    testHarness: {
      globalKey: 'window.__harness',
      readySignal: 'ready',
      // DV-2 — a live game feature MUST import+call this hook to publish the seam;
      // a static preview never does (the SEAM_NEVER_PUBLISHED static catch).
      seamHook: 'useGameStateMachine',
      // jsonPath form (`snapshot.<key>`) derived from the shared shape const so
      // the registry, the `__harness.schema.json` file, and the probe `assert`
      // citations never diverge.
      snapshotShape: Object.fromEntries(
        Object.entries(CANVAS_GAME_SNAPSHOT_SHAPE).map(([k, v]) => [`snapshot.${k}`, v]),
      ),
    },
  }),

  'nextjs-form-app': createStarterPack('nextjs-form-app', {
    displayName: 'Next.js — Form-driven App',
    icon: '📝',
    domain: 'form',
    status: 'stub', // Augment files added when this starter is wired.
    capabilities: [
      'react-hook-form + zod for schema-validated forms',
      'shadcn form primitives wired to RHF Controller',
      'Multi-step wizard pattern with persistent draft state',
      'Best for surveys, registration flows, configuration UIs, onboarding',
    ],
    exampleIntents: [
      'A multi-step onboarding wizard',
      'A survey app with validation',
      'Customer signup flow with email + payment',
      'Configuration UI for a SaaS product',
    ],
  }),

  'nextjs-dashboard': createStarterPack('nextjs-dashboard', {
    displayName: 'Next.js — Dashboard',
    icon: '📊',
    domain: 'dashboard',
    // D1-A7 (2026-06-22) — kept 'stub' (not yet selectable in the picker) until
    // the augment set is e2e-verified on a real clone, BUT it now ships a REAL
    // generic app-state seam + non-game scaffold contract (the augments below).
    // The moment the operator verifies the clone compiles on EC2, flip to
    // 'wired'. The seam/contract are real data today, so a dashboard plan gets
    // first-class route + state-oracle support.
    status: 'stub',
    // D1-A1 — multi-route app: features mount on real routes (NOT the
    // single-page feature-registration model). Overrides the base's
    // 'feature-registry' so the PM prompt renders route-mounting guidance.
    wiring: 'route',
    capabilities: [
      'Recharts + tanstack-table primitives wired to URL state',
      'Filter / sort / pagination patterns with shareable URLs',
      'Card-grid + sidebar nav layout',
      'Best for analytics dashboards, admin panels, reporting tools',
    ],
    exampleIntents: [
      'A sales analytics dashboard',
      'Admin panel for managing users',
      'Reporting tool with filtered tables and charts',
      'Operations dashboard with KPI cards',
    ],
    // Epic 2 Story 2.1 — dashboard-specific loadout. `frontend-design` is
    // the primary value driver for dashboard layouts and information
    // density. `webapp-testing` is dropped from the base loadout since
    // dashboard stories tend to be data-shape changes that are better
    // tested at the data-pipeline layer than via DOM tests.
    defaultSkillLoadout: ['frontend-design@anthropic-official'],
    // D1-A7 — non-game scaffold contract (route-based required/forbidden patterns).
    scaffoldContract: NEXTJS_DASHBOARD_SCAFFOLD_CONTRACT,
    // D1-A6 — the generic app-state seam (real module shipped in augments below).
    augmentFiles: NEXTJS_DASHBOARD_AUGMENTS,
    // D1-A6 — generic app-state verifiability seam: route / auth / last-mutation.
    // Mirrors GameState's role for non-game apps so `verify:'state'/'behavior'`
    // ACs get a deterministic oracle instead of screenshot-only judging.
    testHarness: {
      globalKey: 'window.__harness',
      readySignal: 'ready',
      // DV-2 — the generic app-state seam publisher; a real route/feature calls
      // it, a static stub does not (the SEAM_NEVER_PUBLISHED static catch).
      seamHook: 'useAppHarness',
      snapshotShape: Object.fromEntries(
        Object.entries(DASHBOARD_SNAPSHOT_SHAPE).map(([k, v]) => [`snapshot.${k}`, v]),
      ),
    },
    // D1-A2/A3/A4/A10 — non-game few-shots as DATA (dashboard voice), so a
    // dashboard plan is never dragged toward sprite/HUD framing.
    pmContext: {
      ...NEXTJS_BASE_PACK.pmContext!,
      exampleBrowserAc: [
        'On the /reports route, the page shows a "Total Revenue" card with a numeric value and a line chart with at least one plotted series. FAIL if the card or chart is missing or shows "no data".',
        'On the /users route, a table renders with a header row ("Name", "Email", "Role") and at least one data row. FAIL if the table is empty or absent.',
        'After clicking "Add user" and submitting the form, a new row appears at the top of the users table. FAIL if no row is added.',
      ],
      exampleDomainTypes: 'User, Metric, DashboardConfig',
      coupledSiblingExample:
        'story A builds the "invoice list" route and sibling B builds "marking an invoice paid updates the account-balance card" — B\'s tests assume A\'s invoice rows B never saw, both pass alone, and the merged union fails the wave gate.',
    },
  }),
};

/**
 * Returns the metadata for the given boilerplate type.
 *
 * Throws `Error('unknown boilerplate type: <x>')` for any value not in the
 * registry. Use this at runtime when the type comes from an untrusted source
 * (e.g. an API request body that has been Zod-coerced but not yet validated
 * against the registry).
 */
export function getBoilerplateMetadata(type: BoilerplateType): BoilerplateMetadata {
  const metadata = BOILERPLATE_REGISTRY[type];
  if (!metadata) {
    throw new Error(`unknown boilerplate type: ${type}`);
  }
  return metadata;
}

/**
 * Returns the subset of boilerplate types whose `status === 'wired'`.
 * Phase 1: only `['nextjs']`.
 */
export function getWiredBoilerplateTypes(): BoilerplateType[] {
  return (Object.keys(BOILERPLATE_REGISTRY) as BoilerplateType[]).filter(
    (type) => BOILERPLATE_REGISTRY[type].status === 'wired',
  );
}
