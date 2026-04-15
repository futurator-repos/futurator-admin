import type { CreateEpicInput } from '@/types/epic-workflow';

export function makeBrickBreakerEpic(): Omit<CreateEpicInput, 'workingDir'> {
  return {
    title: 'Brick Breaker Game',
    description:
      'A canvas-based brick breaker game built with React + TypeScript. 3 levels, powerup system, combo scoring, particle effects, and screen shake.',
    acceptanceCriteria: `- Code compiles with zero TypeScript errors
- No \`any\` types except where unavoidable (canvas context)
- Each module exports only what's needed
- Game is playable end-to-end with 3 levels
- Dev server runs without errors (\`npm run dev\`)`,
    stories: [
      {
        title: 'Story 0 — Project Scaffolding & Folder Structure',
        description: `Create the project with Vite + React + TypeScript template (npm create vite@latest brick-breaker -- --template react-ts).

Acceptance Criteria:
- Folder structure: src/ with constants.ts, types.ts, engine/ (collision.ts, particles.ts, powerups.ts, levelManager.ts), hooks/ (useGameLoop.ts, useInput.ts), renderer/ (draw.ts), components/ (OverlayScreen.tsx), App.tsx, main.tsx
- All files created as empty stubs exporting TODOs
- tsconfig.json with strict mode
- Dev server runs without errors (npm run dev)`,
      },
      {
        title: 'Story 1 — Game Constants & Types',
        description: `Files: src/constants.ts, src/types.ts

Acceptance Criteria:
- constants.ts exports: CANVAS_W, CANVAS_H, PADDLE_W, PADDLE_H, BALL_R, BALL_SPEED_INIT, BALL_SPEED_MAX, BRICK_ROWS, BRICK_COLS, BRICK_W, BRICK_H, BRICK_PAD, BRICK_TOP, BRICK_LEFT, POWERUP_CHANCE, POWERUP_R, POWERUP_SPEED, COLORS object
- types.ts exports interfaces: Ball, Brick, Paddle, Powerup, Particle, Effects, GameState, PowerupType, GameScreen
- createInitialState(level) factory function exported from types.ts
- No hardcoded dimensions, speeds, or colors in other files`,
      },
      {
        title: 'Story 2 — Collision Engine',
        description: `File: src/engine/collision.ts

Acceptance Criteria:
- checkWallCollision(ball): Ball — reflects off top, left, right walls
- checkPaddleCollision(ball, paddle): { ball, hit } — angle derived from hit position
- checkBrickCollisions(ball, bricks): { ball, hitBricks } — overlap-based axis reflection
- All functions are pure (no mutation)
- isBallDead(ball): boolean — true when ball.y - BALL_R > CANVAS_H`,
      },
      {
        title: 'Story 3 — Particle System',
        description: `File: src/engine/particles.ts

Acceptance Criteria:
- spawnBrickParticles(brick): Particle[] — 6 particles, random velocity, lifetime 20-35 frames
- tickParticles(particles): Particle[] — advances position, decrements life, filters expired
- Pure functions, no side effects`,
      },
      {
        title: 'Story 4 — Powerup System',
        description: `File: src/engine/powerups.ts

Acceptance Criteria:
- maybeSpawnPowerup(brick, chance): Powerup | null
- tickPowerups(powerups, paddle): { remaining, collected }
- applyEffect(type, state): GameState — wide/multi/slow effects
- tickEffects(effects, paddleW): { effects, newPaddleW }`,
      },
      {
        title: 'Story 5 — Level Manager',
        description: `File: src/engine/levelManager.ts

Acceptance Criteria:
- createBricks(level): Brick[] — 6x8 grid, level 2+ has hp:2 on top rows
- isLevelClear(bricks): boolean
- isGameWon(level, bricks): boolean — true when level 3 is clear
- advanceLevel(state): GameState`,
      },
      {
        title: 'Story 6 — Input Handler Hook',
        description: `File: src/hooks/useInput.ts

Acceptance Criteria:
- usePaddleInput(canvasRef, paddleWidth): number — returns clamped paddle X
- Handles mousemove and touchmove
- Scales input coordinates for responsive canvas
- Cleans up event listeners on unmount`,
      },
      {
        title: 'Story 7 — Renderer',
        description: `File: src/renderer/draw.ts

Acceptance Criteria:
- drawFrame(ctx, state): void
- Draw order: background, bricks, powerups, particles, paddle, balls, HUD
- HUD: score, level, lives, combo counter, effect timers
- Screen shake when shakeFrames > 0
- Uses COLORS from constants`,
      },
      {
        title: 'Story 8 — Game Loop Hook',
        description: `File: src/hooks/useGameLoop.ts

Acceptance Criteria:
- Tick order: tickEffects, move balls, wall/paddle/brick collision, ball death, powerups, particles, level check, shake, draw
- Runs RAF only when gameScreen === "play"
- Handles game over and win callbacks
- Exposes stateRef for input hook`,
      },
      {
        title: 'Story 9 — Overlay Screens',
        description: `File: src/components/OverlayScreen.tsx

Acceptance Criteria:
- Props: title, subtitle?, buttonText, onAction
- Dark semi-transparent backdrop
- Styled title, subtitle, button
- Purely presentational — no game logic`,
      },
      {
        title: 'Story 10 — Root App Component',
        description: `File: src/App.tsx

Acceptance Criteria:
- Manages screen state: menu/play/gameover/win
- Renders canvas with CANVAS_W x CANVAS_H, responsive CSS
- Calls useGameLoop and usePaddleInput when playing
- Renders OverlayScreen for each screen state
- Full-viewport dark background, centered layout
- Game is playable end-to-end`,
      },
    ],
  };
}
