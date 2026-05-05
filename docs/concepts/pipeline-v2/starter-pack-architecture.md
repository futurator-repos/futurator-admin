# Starter pack architecture (Option A)

The pattern of "Story 1 is always project setup" is wasteful — every plan
pays Opus rates for work a curated scaffold could pre-bake. This redesign
replaces "boilerplate metadata + LLM-generated scaffolding stories" with
"domain-specific starter packs whose contract the PM treats as inviolable."

## 1. The rule

A **starter pack** is static, curated, hand-reviewed scaffolding code
that captures every domain primitive an LLM would otherwise re-derive.
Each starter declares a `SCAFFOLD.md` contract: forbidden territory +
required conventions + what's left to build. The PM consumes the
contract verbatim and is constrained at the API layer from emitting
stories that would touch forbidden files.

Starters inherit from a **base** (e.g., `nextjs-base`). New starter =
new top-level entry; the bar to add one is **≥3 apps in that domain**.

## 2. Domain taxonomy (Phase 1)

```
nextjs-base                  generic Next.js 16 + Tailwind + shadcn
├── nextjs-canvas-game       Canvas2D + RAF loop + keyboard/touch + physics
├── nextjs-form-app          react-hook-form + zod + multi-step wizard
└── nextjs-dashboard         recharts + tanstack-table + URL-state hooks

vite-base, sst-base, mobile-base   Phase 2+ (those base templates are stubs today)
```

## 3. Inline-augment vs. separate-repo (Phase-1 implementation choice)

Two viable physical layouts:

- **Separate repo**: each starter is its own GitHub template repo. Clean
  separation, real branches/PRs, but every new starter requires repo
  creation ceremony.
- **Inline augment**: the registry declares `augmentFiles[]` (path +
  content) on each starter. App-bootstrap clones the base template
  repo, then writes augment files on top before committing. Single
  source of truth in the codebase.

**Phase 1 ships inline-augment** because:
- One source of truth = no drift between registry and repo
- Adding a starter = a code-review-driven PR, not GitHub repo theatre
- Tests + types catch typos
- Easy to graduate to separate repos later (extract augment files →
  push to new repo → flip to `templateRepo` mode)

## 4. Registry shape

```ts
// functions/shared/boilerplates/types.ts

export type StarterPackKey =
  | 'nextjs-base'
  | 'nextjs-canvas-game'
  | 'nextjs-form-app'
  | 'nextjs-dashboard'
  | 'vite-base' | 'sst-base' | 'mobile-base';

export interface StarterPack extends BoilerplateMetadata {
  /** Inheritance — every non-base starter has a parent. */
  baseStarter?: StarterPackKey;
  /** For the recommender + UI grouping. */
  domain: 'general' | 'game' | 'form' | 'dashboard' | 'ecommerce' | 'api';
  /** Plain-English capability sentences fed to the recommender Haiku call. */
  capabilities: string[];
  /** Sample intents this starter handles well. */
  exampleIntents: string[];
  /**
   * Files written on top of the base after clone. Each entry is
   * `{ path: <relative>, content: <string> }`. SCAFFOLD.md is the first
   * entry by convention. Empty for `*-base` starters.
   */
  augmentFiles?: Array<{ path: string; content: string }>;
  /**
   * Mirror of `augmentFiles` SCAFFOLD.md content. Embedded as a string
   * so the API Lambda can pass it to the PM prompt without reading
   * the cloned tree. Stays in sync with the SCAFFOLD.md augment file
   * via a registry-side test.
   */
  scaffoldContract?: string;
}
```

`App.boilerplateType` is renamed to `App.starterPackKey` (the old field
auto-maps: `'nextjs' → 'nextjs-base'`).

## 5. `SCAFFOLD.md` — the contract format

```markdown
# Scaffold contract — nextjs-canvas-game

## Pre-baked (DO NOT generate stories that recreate)
- Next.js 16 + TS strict + Tailwind v4 + shadcn primitives
- `src/hooks/useGameLoop.ts` — RAF-based, memoized, auto-cancel on unmount
- `src/hooks/useKeyboard.ts` — typed, debounced, autorelease
- `src/game/physics.ts` — gravity(), collide(rect, rect), tween()
- `src/game/state-machine.ts` — typed `<TState, TEvent>` reducer pattern
- `src/game/types.ts` — `GameState<T>`, `Entity<T>` generics
- `src/components/GameCanvas.tsx` — canvas mount + ResizeObserver

## Forbidden story patterns (PM must NOT emit)
- "Define core game types" → use `GameState<T>` with your domain entities
- "Set up game loop" → import `useGameLoop`
- "Wire keyboard input" → import `useKeyboard`
- "Create canvas component" → use `<GameCanvas/>`
- "Set up Tailwind / tsconfig / Next config" → done

## Required story patterns
- "Implement <entity> rendering on the canvas"
- "Wire <gameplay-event> through the state machine"
- "Add <input-action> via useKeyboard/useTouch"
- "Implement collision rules between <entity-a> and <entity-b>"

## Conventions
- Game state types in `src/game/types.ts` — extend, don't replace
- New entities in `src/game/entities/<name>.ts`
- Render helpers in `src/components/canvas/<Entity>Render.tsx`
- ALL game logic must be reducer-pure; no side effects in tick handlers
```

## 6. App-bootstrap saga changes

```
Operator picks starterPackKey at App creation
       ↓
Daemon's app-bootstrap saga (existing) clones BASE template repo
       ↓
NEW STEP: write augmentFiles[] from registry (relative paths under workingDir)
       ↓
Existing postCreateSteps: inject-app-values, npm-install, bmad-bootstrap
       ↓
Existing commit-and-push: commits include the augment files
```

Augment writing is a deterministic shell loop (mkdir -p + write each file).
No LLM involvement, no race conditions.

## 7. PM contract changes

`buildPmPlanPrompt(args)` gets:

- `args.scaffoldContract: string` — read from `BOILERPLATE_REGISTRY[key].scaffoldContract` at PM time
- New required prompt block: `## SCAFFOLD CONTRACT (READ FIRST)\n${scaffoldContract}\n`
- New constraint paragraph: stories whose touch points fall inside the
  "Pre-baked" list will be REJECTED at runtime
- API-side validation: `applyPlanOutput` checks each story's touch
  points against the starter's forbidden file globs; rejects with
  `PLAN_REJECTED:scaffold-violation` and surfaces diagnostic for the
  operator to click Regenerate.

## 8. App creation flow

Phase 1 (manual pick):

```
NewAppModal:
  display name
  intent (optional, ≥10 chars)
  starter dropdown   ← NEW (replaces today's "boilerplate" radio)
    nextjs-base
    nextjs-canvas-game  (Phase 1)
    nextjs-form-app     (Phase 1)
    nextjs-dashboard    (Phase 1)
  rigor selector
```

Phase 3 (LLM recommender):

```
POST /api/starter-recommend
  body: { intent: string }
  → Haiku call (~$0.001) over registry capabilities + exampleIntents
  → returns { starterPackKey, confidence, reason }

Modal flow: operator types intent → recommender suggests → operator confirms or overrides
```

## 9. Sync model

Within inline-augment Phase 1: `npm run sync-starters` is a no-op — the
augments live in code, code review covers drift. Phase 5+ (when starters
graduate to separate GitHub repos): a weekly cron rebases derivatives
onto base updates.

## 10. Failure modes

| Failure | Handling |
|---|---|
| PM emits forbidden story | API rejects PLAN_JSON; operator clicks Regenerate |
| Augment write fails (filesystem error) | App-bootstrap step fails normally; operator retries |
| New domain emerges (no starter fits) | Recommender returns `<domain>-base`; ≥3 apps signals "add new starter" |
| Starter contract is wrong (devs hit forbidden patterns repeatedly) | Code review revises `scaffoldContract`, propagates to all future apps |

## 11. Implementation phases (in order)

1. **Phase 1** — Registry refactor: `StarterPackKey`, `StarterPack`,
   `nextjs-base` rename, `nextjs-canvas-game` with augmentFiles
2. **Phase 2** — PM prompt + API touch-point validation
3. **Phase 3** — Daemon augment-write step
4. **Phase 4** — NewAppModal: starter dropdown
5. **Phase 5** — LLM recommender + intent-driven UI
6. **Phase 6** — Add `nextjs-form-app`, `nextjs-dashboard`
7. **Phase 7** — Sync model + base-version tracking (only when graduating to separate repos)

## 12. Migration

- Legacy apps with `boilerplateType: 'nextjs'` auto-map to `'nextjs-base'`
- In-flight plans unaffected — only NEW App creations see the dropdown
- API endpoint accepts BOTH `boilerplateType` and `starterPackKey` until
  the legacy field is sunset (after all UI updates)

## 13. What this solves vs. what it doesn't

**Solved:**
- "Define core types" stories disappear — types live in starter
- PM generates feature-only plans on starter-equipped apps
- First story is real product work, not scaffolding
- Cost-per-app on scaffolding trends toward $0 at scale
- PROJECT_CONTEXT pack stays small (no need to ship full project tree)

**Not solved (separate work):**
- DDB item-size on agent-jobs (PR-12 already addressed)
- Touch-point inference still LLM-driven on retries (separate concern)
- Concurrent App-bootstrap + PM (Option C) — orthogonal latency win

---

*This doc is a living spec — update §11 as phases ship.*
