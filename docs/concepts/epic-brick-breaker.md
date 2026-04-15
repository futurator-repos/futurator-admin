# Epic: Brick Breaker Game

A canvas-based brick breaker game built with React + TypeScript. 3 levels, powerup system, combo scoring, particle effects, and screen shake.

---

## Story 0 — Project Scaffolding & Folder Structure

**As a** developer  
**I want** the project initialised with all tooling, dependencies, and folder structure  
**So that** all subsequent stories can be implemented without setup friction.

**Acceptance Criteria:**

- Project created with Vite + React + TypeScript template (`npm create vite@latest brick-breaker -- --template react-ts`)
- Folder structure created:
  ```
  src/
    constants.ts
    types.ts
    engine/
      collision.ts
      particles.ts
      powerups.ts
      levelManager.ts
    hooks/
      useGameLoop.ts
      useInput.ts
    renderer/
      draw.ts
    components/
      OverlayScreen.tsx
    App.tsx
    main.tsx
  ```
- All files created as empty stubs exporting TODOs
- `tsconfig.json` configured with strict mode
- Dev server runs without errors (`npm run dev`)
- `.gitignore` includes `node_modules`, `dist`
- `README.md` with project description and run instructions

---

## Story 1 — Game Constants & Types

**File:** `src/constants.ts`, `src/types.ts`

**As a** developer  
**I want** all game constants and TypeScript interfaces in shared modules  
**So that** every other module imports from a single source of truth with zero magic numbers.

**Acceptance Criteria:**

- `constants.ts` exports: `CANVAS_W`, `CANVAS_H`, `PADDLE_W`, `PADDLE_H`, `BALL_R`, `BALL_SPEED_INIT`, `BALL_SPEED_MAX`, `BRICK_ROWS`, `BRICK_COLS`, `BRICK_W`, `BRICK_H`, `BRICK_PAD`, `BRICK_TOP`, `BRICK_LEFT`, `POWERUP_CHANCE`, `POWERUP_R`, `POWERUP_SPEED`, `COLORS` object (bg, panel, border, paddle, ball, rows[], powerups{})
- `types.ts` exports interfaces: `Ball`, `Brick`, `Paddle`, `Powerup`, `Particle`, `Effects`, `GameState`, `PowerupType` (union: `"wide" | "multi" | "slow"`), `GameScreen` (union: `"menu" | "play" | "gameover" | "win"`)
- `GameState` includes: `paddle`, `balls[]`, `bricks[]`, `powerups[]`, `particles[]`, `score`, `lives`, `level`, `combo`, `effects`, `shakeFrames`
- A `createInitialState(level: number): GameState` factory function is exported from `types.ts`
- No other file in the project contains hardcoded dimensions, speeds, or color values

---

## Story 2 — Collision Engine

**File:** `src/engine/collision.ts`

**As a** developer  
**I want** a pure-function collision module  
**So that** collision detection is testable independently of rendering or React.

**Acceptance Criteria:**

- `checkWallCollision(ball: Ball): Ball` — reflects off top, left, right walls; clamps position to inside bounds
- `checkPaddleCollision(ball: Ball, paddle: Paddle): { ball: Ball; hit: boolean }` — detects ball entering paddle zone, reflects with angle derived from hit position (-0.5 to 0.5 across paddle width), caps speed at `BALL_SPEED_MAX`
- `checkBrickCollisions(ball: Ball, bricks: Brick[]): { ball: Ball; hitBricks: Brick[] }` — uses overlap-based axis reflection (smaller overlap axis gets reflected), decrements `hp`, returns list of bricks that reached `hp <= 0`
- All functions are **pure**: no mutation of input objects, return new instances
- `isBallDead(ball: Ball): boolean` — returns true when `ball.y - BALL_R > CANVAS_H`

---

## Story 3 — Particle System

**File:** `src/engine/particles.ts`

**As a** developer  
**I want** a particle system for brick destruction effects  
**So that** the game has satisfying visual feedback.

**Acceptance Criteria:**

- `spawnBrickParticles(brick: Brick): Particle[]` — returns 6 particles centered on brick, random velocity (-2 to 2 each axis), lifetime 20–35 frames, color matching `COLORS.rows[brick.row]`
- `tickParticles(particles: Particle[]): Particle[]` — advances `x += vx`, `y += vy`, decrements `life`, filters out particles with `life <= 0`
- Pure functions, no side effects

---

## Story 4 — Powerup System

**File:** `src/engine/powerups.ts`

**As a** developer  
**I want** a powerup module handling spawn, movement, collection, and effect lifecycle  
**So that** gameplay has variety and strategic depth.

**Acceptance Criteria:**

- `maybeSpawnPowerup(brick: Brick, chance: number): Powerup | null` — rolls random, returns powerup at brick center with random type from `["wide", "multi", "slow"]`, or null
- `tickPowerups(powerups: Powerup[], paddle: Paddle): { remaining: Powerup[]; collected: PowerupType[] }` — moves each down by `POWERUP_SPEED`, detects paddle overlap for collection, removes off-screen drops
- `applyEffect(type: PowerupType, state: GameState): GameState` — wide: sets `effects.wide = 600` and `paddle.w = 140`; slow: sets `effects.slow = 480`; multi: clones 2 new balls from first ball with offset `vx`
- `tickEffects(effects: Effects, paddleW: number): { effects: Effects; newPaddleW: number }` — decrements timers, resets paddle width to `PADDLE_W` when wide expires

---

## Story 5 — Level Manager

**File:** `src/engine/levelManager.ts`

**As a** developer  
**I want** a level manager for brick generation and progression logic  
**So that** the game has 3 distinct levels with increasing difficulty.

**Acceptance Criteria:**

- `createBricks(level: number): Brick[]` — 6 rows × 8 cols grid with correct spacing; level 2+ sets `hp: 2` on top 2 rows
- `isLevelClear(bricks: Brick[]): boolean` — true when all bricks have `alive === false`
- `isGameWon(level: number, bricks: Brick[]): boolean` — true when level === 3 and level is clear
- `advanceLevel(state: GameState): GameState` — increments level, calls `createBricks`, resets balls (single ball from paddle center), clears powerups and effects

---

## Story 6 — Input Handler Hook

**File:** `src/hooks/useInput.ts`

**As a** developer  
**I want** a React hook that translates mouse/touch input into paddle position  
**So that** input handling is decoupled from game logic and rendering.

**Acceptance Criteria:**

- `usePaddleInput(canvasRef: RefObject<HTMLCanvasElement>, paddleWidth: number): number` — returns clamped paddle X position
- Handles `mousemove` and `touchmove` (with `preventDefault` on touch)
- Correctly scales input coordinates when canvas CSS size differs from `CANVAS_W` (responsive scaling)
- Clamps paddle X to `[0, CANVAS_W - paddleWidth]`
- Cleans up event listeners on unmount
- Returns `CANVAS_W / 2 - paddleWidth / 2` as default before any input

---

## Story 7 — Renderer

**File:** `src/renderer/draw.ts`

**As a** developer  
**I want** a stateless render function that draws a full frame from GameState  
**So that** rendering is decoupled from logic and easy to refactor visually.

**Acceptance Criteria:**

- `drawFrame(ctx: CanvasRenderingContext2D, state: GameState): void`
- Draw order: background + subtle grid → bricks (rounded rect, row-colored glow, stroke indicator for `hp > 1`) → powerups (colored circles with letter label W/M/S) → particles (small squares with alpha = `life / 35`) → paddle (rounded rect with glow) → balls (circles with glow) → HUD
- HUD elements: score (top-left), level (top-center), lives as colored dots (top-right), combo counter when `combo > 1` (below score, gold), active effect timers with countdown in seconds (right side)
- Screen shake: when `state.shakeFrames > 0`, apply random canvas translation (-2 to 2 px each axis) via `ctx.save/translate/restore`
- Function contains **zero game logic** — purely visual
- Uses `COLORS` from constants for all colors

---

## Story 8 — Game Loop Hook

**File:** `src/hooks/useGameLoop.ts`

**As a** developer  
**I want** a React hook that orchestrates the game loop via `requestAnimationFrame`  
**So that** all engine modules are composed into a running game.

**Acceptance Criteria:**

- Tick order per frame:
  1. `tickEffects` → update paddle width
  2. Move each ball (`x += vx * speedMul`, `y += vy * speedMul`), where `speedMul = 0.55` if slow active, else `1`
  3. `checkWallCollision` per ball
  4. `checkPaddleCollision` per ball (reset combo on hit)
  5. `checkBrickCollisions` per ball → for each destroyed brick: increment combo, add `10 * combo` to score, `spawnBrickParticles`, `maybeSpawnPowerup`, set `shakeFrames = 4`
  6. Check `isBallDead` → remove dead balls
  7. If no balls remain: decrement lives, respawn or trigger game over
  8. `tickPowerups` → `applyEffect` for each collected
  9. `tickParticles`
  10. `isLevelClear` → `isGameWon` or `advanceLevel`
  11. Decrement `shakeFrames`
  12. `drawFrame`
- Hook accepts: `canvasRef`, `gameScreen`, callbacks for `onGameOver(score, level)` and `onWin(score, level)`
- Runs RAF only when `gameScreen === "play"`, cancels on cleanup
- Exposes `stateRef` for input hook to write paddle position into

---

## Story 9 — Overlay Screens

**File:** `src/components/OverlayScreen.tsx`

**As a** developer  
**I want** a reusable overlay component for menu, game over, and win states  
**So that** screen transitions are consistent and easy to modify.

**Acceptance Criteria:**

- Props: `title: string`, `subtitle?: string`, `buttonText: string`, `onAction: () => void`
- Renders: dark semi-transparent backdrop (`rgba(10,14,23,0.92)`), centered layout
- Title in `COLORS.accent`, 36px bold, letter-spacing 2
- Subtitle in `COLORS.dimText`, 14px, max-width 300px, centered
- Button styled with `COLORS.paddle` background, dark text, rounded, pointer cursor, JetBrains Mono font
- Component is purely presentational — no game logic

---

## Story 10 — Root App Component

**File:** `src/App.tsx`

**As a** developer  
**I want** a root component that composes everything and manages screen state  
**So that** the game is playable end-to-end.

**Acceptance Criteria:**

- Manages `screen` state: `"menu" | "play" | "gameover" | "win"`
- Renders `<canvas>` with `width={CANVAS_W} height={CANVAS_H}`, responsive CSS scaling (`width: 100%`, `height: auto`)
- Calls `useGameLoop` and `usePaddleInput` hooks when screen is `"play"`
- Renders `<OverlayScreen>` for menu (title: "BRICK BREAKER", instructions subtitle, "START" button), game over (shows score + level, "RETRY"), win (shows score, "PLAY AGAIN")
- Hides cursor on canvas during play (`cursor: "none"`)
- Full-viewport dark background, centered layout

---

## Definition of Done (all stories)

- Code compiles with zero TypeScript errors
- No `any` types except where unavoidable (canvas context)
- Each module exports only what's needed (no barrel exports of internals)
- Game is playable and visually matches the monolithic prototype
