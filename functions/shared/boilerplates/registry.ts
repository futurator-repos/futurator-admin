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

// Frozen-file augments. Husky integration: the hook installs into
// .husky/pre-commit alongside the existing lint-staged hook (the daemon's
// `husky install` runs as part of post-create scaffolding for nextjs-base
// per BMAD's pre-existing setup).
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
*
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
  },
  // PR-35 — baseline-diff regression gate config + scripts. Inherited by
  // all nextjs-* starter packs via createStarterPack's augment merge.
  baselineCapture: {
    scriptPath: 'scripts/capture-test-baseline.sh',
    regressCheckPath: 'scripts/check-regressions.sh',
    testRunner: 'vitest',
  },
  // PR-71 — Project skill manifest + sync script (Story 3-C-2-1).
  // Inherited by all nextjs-* starter packs.
  skillManifest: {
    manifestPath: '.claude/skills.manifest.yaml',
    syncScriptPath: 'scripts/skills-sync.mjs',
  },
  // PR-35 + PR-41 + PR-71 + PR-80 — base augments concat baseline-diff
  // scripts + frozen-file husky guard + skill manifest scaffold + CLAUDE.md
  // template. createStarterPack merges starter-specific augments on top.
  augmentFiles: [
    ...BASELINE_DIFF_AUGMENTS,
    ...FROZEN_FILE_AUGMENTS,
    ...SKILL_MANIFEST_AUGMENTS,
    ...CLAUDE_MD_AUGMENTS,
  ],
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
