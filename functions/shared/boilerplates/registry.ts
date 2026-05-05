import type { BoilerplateMetadata } from './types';

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
- \`src/game/state-machine.ts\` — typed \`useReducer\` wrapper for game state
- \`src/game/types.ts\` — \`GameStatus\`, \`Entity\`, \`GameState<T>\` generics
- \`src/components/GameCanvas.tsx\` — canvas mount + ResizeObserver wiring
- \`src/app/page.tsx\` — game-canvas mount point (stub)

## Forbidden story patterns (PM must NOT emit)
- "Define core game types" → use the \`GameState<T>\` generic, extend with your domain entities
- "Set up game loop" → import \`useGameLoop\`
- "Wire keyboard input" → import \`useKeyboard\`
- "Create canvas component" → use \`<GameCanvas/>\`
- "Set up Tailwind / tsconfig / Next config" → done in nextjs-base
- "Install Next.js / React / TypeScript" → done in nextjs-base
- "Bootstrap project from scratch" → done in nextjs-base

## Required story patterns
- "Implement <entity> rendering on the canvas"
- "Wire <gameplay-event> through the state machine"
- "Add <input-action> via useKeyboard"
- "Implement collision rules between <entity-a> and <entity-b>"
- "Add scoring / lives / game-over UI overlay"

## Conventions
- Add domain entity types to \`src/game/types.ts\` (extend, don't replace)
- Place new entities under \`src/game/entities/<name>.ts\`
- Place render helpers under \`src/components/canvas/<Entity>Render.tsx\`
- ALL game logic must be reducer-pure — no side effects in tick handlers
- Mount the game from \`src/app/page.tsx\` via \`<GameCanvas/>\`
`;

const NEXTJS_CANVAS_GAME_AUGMENTS: Array<{ path: string; content: string }> = [
  // SCAFFOLD.md FIRST — convention. Mirror of NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT.
  { path: 'SCAFFOLD.md', content: NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT },

  {
    path: 'src/game/types.ts',
    content: `/**
 * Game type primitives — PR-13 nextjs-canvas-game starter.
 *
 * Extend with domain-specific entity types in this file or in
 * \`src/game/entities/<name>.ts\`. Do NOT replace these primitives.
 */

export type GameStatus = 'idle' | 'running' | 'paused' | 'over';

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

import { useReducer, useCallback, useRef } from 'react';
import type { GameState, Entity } from './types';

export type GameAction<TEntity extends Entity = Entity> =
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'over' }
  | { type: 'tick'; dtSec: number }
  | { type: 'addEntity'; entity: TEntity }
  | { type: 'removeEntity'; id: string }
  | { type: 'addScore'; delta: number };

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
  const [state, dispatch] = useReducer(
    reducer as React.Reducer<GameState<TEntity>, GameAction<TEntity>>,
    initial,
  );
  const ref = useRef(state);
  ref.current = state;
  const safeDispatch = useCallback(dispatch, []);
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
 * Calls \`render(ctx, w, h)\` whenever \`redrawTrigger\` changes. The
 * consumer drives redraws by passing a tick counter from \`useGameLoop\`.
 *
 * Sized to fill its parent. DPR-aware. Non-prescriptive about gameplay.
 */

import { useEffect, useRef } from 'react';

export interface GameCanvasProps {
  render: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  /** Increment to force a redraw. Driven by the game loop. */
  redrawTrigger: number;
  className?: string;
}

export function GameCanvas({ render, redrawTrigger, className }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });

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
      }
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(ctx, width, height);
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
      targetFiles: ['package.json', 'README.md', 'CLAUDE.md'],
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
  return {
    ...NEXTJS_BASE_PACK,
    type,
    baseStarter: 'nextjs-base',
    status: overrides.status ?? 'wired',
    ...overrides,
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
    augmentFiles: NEXTJS_CANVAS_GAME_AUGMENTS,
    scaffoldContract: NEXTJS_CANVAS_GAME_SCAFFOLD_CONTRACT,
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
    status: 'stub',
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
