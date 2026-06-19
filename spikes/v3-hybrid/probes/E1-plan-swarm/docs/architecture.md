# Architecture — Pac-Man

TypeScript, Vite, HTML canvas. Pure-logic core separated from rendering so logic is unit-testable headless. No framework.

## Module boundaries & file layout

- **MOD-types** (`src/game/types.ts`) — all shared contracts: enums `TileType`, `GamePhase`, `Direction`, `GhostMode`, `GhostId`; interfaces `GridPos`, `PixelPos`, `EntityPos`, `PacManState`, `GhostState`, `StageConfig`, `PacmanDomainState`; coordinate helpers `colRowToPixel`/`pixelToColRow`; constants `TILE_SIZE=16`, `HUD_HEIGHT=24`, `CANVAS_WIDTH=448`, `CANVAS_HEIGHT=520`.
- **MOD-maze** (`src/game/entities/maze-data.ts`) — the 28×31 layout, `getTile`/`setTile`, dot/pellet inventory.
- **MOD-state** (`src/game/entities/game-state.ts`) — the game-state reducer + lifecycle (phase transitions, lives, score, stage).
- **MOD-ghost-ai** (`src/game/entities/ghost-ai.ts`) — the four targeting strategies + scatter/chase/frightened mode timer.
- **MOD-collision** (`src/game/entities/collision.ts`) — pure tile/entity collision: `getPacManTile`, `getCollidingGhost`, `isWraparoundTile`.
- **MOD-render** (`src/game/render/*.ts`) — canvas draw of maze, entities, HUD; no game logic.
- **MOD-input** (`src/game/input.ts`) — keyboard → buffered Direction.
- **MOD-loop** (`src/game/loop.ts`) — requestAnimationFrame loop wiring input→state→render.
- **MOD-screens** (`src/game/screens/*.tsx`) — Start, Playing, Paused, GameOver shells + feature registry.

## Decisions

- **DEC-pure-core.** All of types/maze/state/ghost-ai/collision are pure (no canvas, no DOM) → unit-tested without a browser.
- **DEC-grid-coords.** Logic works in grid (col,row); rendering converts to pixels via the helpers in MOD-types.
- **DEC-contract-first.** MOD-types is authored first; every other module imports from it and must not redefine its shapes.
