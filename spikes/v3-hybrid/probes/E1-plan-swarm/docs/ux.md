# UX Specification — Pac-Man

Single 448×520 canvas (28×31 tiles @ 16px + 24px HUD strip). Retro arcade look.

## Screens / flows

- **SCREEN-Start.** Title, blinking "PRESS START", high score. Any key → Playing.
- **SCREEN-Playing.** The maze fills the canvas; HUD strip on top shows SCORE (left), STAGE (center), LIVES as Pac-icons (right).
- **SCREEN-Paused.** Dimmed maze with centered "PAUSED"; resume on key.
- **SCREEN-GameOver.** "GAME OVER", final score, "PRESS R TO RESTART".
- **FLOW-DeathAnim.** On ghost collision: brief Pac-Man death animation, then respawn at start tile (if lives remain) or → GameOver.
- **FLOW-FrightenFlash.** Frightened ghosts blink white in the last ~2s before reverting.

## Interaction

- Arrow keys + WASD steer; input is buffered (next-turn-at-intersection feel).
- `P` toggles pause; `R` restarts from GameOver.
