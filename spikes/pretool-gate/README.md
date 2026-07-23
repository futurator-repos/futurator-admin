# Spike: pretool-gate — the keystone live gate

The single deterministic `PreToolUse` gate the four harness analyses (jcode, SDD/Mycelium, ponytail, ecc)
all converged on. It moves gating from **post-hoc git-diff audit** to **live in-turn interception**, fusing:

- **ecc composite risk score** — `base + file-sensitivity + blast-radius + irreversibility` → tier
  (`allow / review / confirm / block`). Port of `repos/ecc/ecc2/src/observability/mod.rs`.
- **ecc GateGuard fact-force** — a `confirm`-tier action is **blocked once** with a required-facts message
  (callers / rollback / why-minimal), then the retry **clears** (memoized per session+target). Not "are you
  sure?" — the investigation _is_ the gate. Port of `repos/ecc/scripts/hooks/gateguard-fact-force.js`.
- **jcode/SDD scope gate** — `touchPoints` / `forbiddenAreas`, by **reusing the daemon's own
  `detectScopeViolations`** (`daemon/pipelines/lib/scope-violation-detector.mjs`) so the pre-write check is
  byte-identical to the post-hoc audit. Same rules, moved earlier on the timeline.

Posture: **deterministic, no LLM, FAIL-OPEN** (a broken gate never bricks a run).

## Files

- `pretool-gate.mjs` — pure fns (`computeRisk`, `decide`, `targetFile`, `parseHookPayload`, `loadPolicy`) + `main()` hook.
- `__tests__/pretool-gate.test.mjs` — 8 runnable checks.

## Run the checks

```bash
node --test spikes/pretool-gate/__tests__/pretool-gate.test.mjs
```

## Modes (env `FUTURATOR_GATE_MODE`)

| mode              | behaviour                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `off`             | allow everything (exit 0) — kill switch                                                     |
| `audit` (default) | never blocks; emits `[pretool-gate] would-block: …` / `audit: …` markers — **safe rollout** |
| `enforce`         | real `exit 2` blocks (reason → fed back to the model)                                       |

Policy env: `FUTURATOR_TOUCH_POINTS`, `FUTURATOR_FORBIDDEN_AREAS` (JSON array or comma list).
Guards: `FUTURATOR_HOOKS_DISABLED=1` (recursion/kill), `FUTURATOR_GATE_STATE_DIR` (fact-force memo dir).

## Wire it in (reversible)

1. Register as a `PreToolUse` hook in the spawn's `.claude/settings.json` (matcher `Edit|Write|MultiEdit|Bash`):
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Edit|Write|MultiEdit|Bash",
           "hooks": [
             { "type": "command", "command": "node /abs/path/spikes/pretool-gate/pretool-gate.mjs" }
           ]
         }
       ]
     }
   }
   ```
2. In `daemon/pipelines/epic-dev-pipeline.mjs` spawn `env`, pass the story's scope + start in audit:
   ```js
   env: { ...process.env, ...(opts.env || {}),
     FUTURATOR_GATE_MODE: payload.gateMode || 'audit',
     FUTURATOR_TOUCH_POINTS: JSON.stringify(story.touchPoints || []),
     FUTURATOR_FORBIDDEN_AREAS: JSON.stringify(story.forbiddenAreas || []) }
   ```
   (Set `FUTURATOR_HOOKS_DISABLED=1` for any sub-spawn that shells out, to avoid re-triggering.)

## Rollout & A/B

1. Ship in **`audit`** for one epic. Grep dev logs for `[pretool-gate] would-block` — these are the writes the
   post-hoc `scope-violation-detector` _would_ have caught later. Confirm zero false-positives on legit work.
2. Flip one story to **`enforce`**; verify out-of-scope writes never land in the diff and fact-force retries pass.
3. Compare: scope-violation ACs injected by the post-hoc detector (should drop to ~0), reviewer rounds, tokens.

## Promotion (if A/B holds)

Move `pretool-gate.mjs` into `daemon/lib/`, drive `touchPoints` straight from the job row, and treat the
post-hoc `scope-violation-detector` as the **backstop** (defense-in-depth: admission gate → live pre-tool
gate → post-diff audit). Feed `would-block`/`fact-force` events into the observability ledger.
