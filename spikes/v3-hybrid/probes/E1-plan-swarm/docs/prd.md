# PRD — Pac-Man (browser, single-player)

A faithful single-screen Pac-Man clone in TypeScript + HTML canvas. No backend.

## Functional requirements

- **FR1 — Maze & dots.** Render the classic 28×31 tile maze. Pac-Man eats dots and power pellets; the board tracks remaining dots.
- **FR2 — Pac-Man movement.** Arrow/WASD input moves Pac-Man through corridors at a constant speed; walls block movement; the tunnel row wraps left↔right.
- **FR3 — Four ghosts with distinct AI.** Blinky, Pinky, Inky, Clyde each use their classic targeting strategy; ghosts alternate scatter/chase modes on a timer.
- **FR4 — Collisions.** Ghost touching Pac-Man costs a life; Pac-Man touching a dot/pellet clears the tile and scores.
- **FR5 — Power pellets & frightened mode.** Eating a power pellet flips ghosts to frightened (blue, flee, edible) for a timed window; eating a frightened ghost scores and sends it home.
- **FR6 — Scoring & lives.** Dots=10, pellet=50, ghost=200×combo. Start with 3 lives; lose one per ghost hit; game over at 0.
- **FR7 — Stage progression.** Clearing all dots advances to the next stage (faster ghosts, shorter frighten window).
- **FR8 — Screens.** Start screen, in-game HUD (score, lives, stage), game-over screen with restart.
- **FR9 — Pause.** Player can pause/resume; timers freeze while paused.
