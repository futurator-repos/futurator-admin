# Spike: AC-aware laziness injection

Proves the cheapest ponytail idea — inject a "minimum code to pass the bound AC" ruleset into every
dev spawn — with a non-invasive, reversible wiring point. See
`Mycelium/futurator-ponytail-analysis-1.md` for the full analysis.

## Files

- `futurator-lazy-skill.md` — the AC-aware laziness ladder (the source of truth).
- `inject-lazy.mjs` — `getLazyInstructions(mode)` + `lazyArgs(mode)` → `['--append-system-prompt', text]`.
- `__tests__/inject-lazy.test.mjs` — one runnable check.

## Run the check

```bash
node --test spikes/ponytail/__tests__/inject-lazy.test.mjs
```

## Wire it in (2 lines, reversible)

In `daemon/pipelines/epic-dev-pipeline.mjs` around line 255:

```js
import { lazyArgs } from '../../spikes/ponytail/inject-lazy.mjs'; // (move into daemon/lib on promotion)

const args = [
  '-p',
  prompt,
  '--model',
  payload.orchestratorModel,
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'bypassPermissions',
  ...lazyArgs(payload.lazyMode), // ← inject; undefined → 'full'
];
```

`--append-system-prompt` is additive — it changes nothing about how the spawn is gated or parsed, and
removing the spread fully reverts. Gate it behind `payload.lazyMode` so you can A/B per job.

## A/B method (one real story)

1. Pick one representative story; run it twice (lazyMode off vs `full`), same model, same inputs.
2. Compare on the `git diff` it leaves: **LOC added**, and the spawn's **token + cost** totals from the
   event ledger.
3. Honesty boundary (ponytail's rule): report only measured deltas between the two runs — do not invent a
   per-repo "saved N lines" figure against an unbuilt baseline.

## Promotion (if the A/B holds)

- Move `inject-lazy.mjs` + the skill into `daemon/lib/`, add an OpenCode adapter beside `lazyArgs`
  (the single-source / multi-adapter pattern), and harvest `ponytail:` markers at wave-close into the
  reflector/refactor-audit ledger.
