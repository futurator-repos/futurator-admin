# `browser-agent/` — vendored BrowserAgent core

These four modules are **vendored** from the operator's BrowserAgent project:

> `~/GetReal/elevenLabsConcepts/BrowserAgent/server/`

BrowserAgent is a self-hosted, "Claude in Chrome"-style visual-QA agent: one
computer-use brain driving interchangeable browser backends. The daemon needs
the **headless (embedded) path only**, so we vendor the minimal library surface
rather than depending on the whole Express/WS service. (The **extension** path is
service-only by construction — the daemon reaches it over HTTP+SSE via
`agentic-vqa-runner.mjs`, it is not vendored here.)

## Files

| file                      | upstream                                 | notes                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions.mjs`             | `server/executors/actions.js`            | Verbatim. Action schema, `validateAction`, xdotool→Playwright/CDP key maps.                                                                                                                                                                                                                                              |
| `playwright-executor.mjs` | `server/executors/playwrightExecutor.js` | Verbatim except the sibling import path. Executor interface (`start`/`execute`/`screenshot`/`getViewport`/`stop`) kept **exactly** as upstream.                                                                                                                                                                          |
| `prompts.mjs`             | `server/agent/prompts.js`                | Upstream body verbatim + a Futurator `QA_VERDICT_EPILOGUE` appended (agent must end with a `QA_VERDICT:` / `QA_FINDINGS:` block).                                                                                                                                                                                        |
| `loop.mjs`                | `server/agent/loop.js`                   | Express/session coupling removed: takes an injected `emit(type,data)` callback and `saveFrame(stepIndex, base64Png)` callback; optional injected `client`. The computer-use tool spec (`computer_20251124`, beta `computer-use-2025-11-24`), 3-recent-image pruning, and retry/backoff are kept **exactly** as upstream. |

## Adaptation contract (what changed vs upstream)

`runAgentLoop` no longer touches `session.emitter` or the `runs/` directory:

```js
runAgentLoop({
  emit, // (type, data) => void   — replaces session.emitter.emit
  saveFrame, // (stepIndex, base64Png) => void|Promise — replaces runs/<id>/step-NNN.png
  executor, // the vendored PlaywrightExecutor (or a fake, for tests)
  instruction,
  url,
  model,
  apiKey,
  baseURL,
  mode,
  client, // optional pre-built Anthropic-compatible client (tests inject a fake)
  maxSteps,
  signal,
});
```

## API-key isolation (important)

The Anthropic client is built **only** from `BROWSER_AGENT_API_KEY` (wired by the
caller, `agentic-vqa-runner.mjs`). The daemon must **never** export
`ANTHROPIC_API_KEY` into its global env — it spawns the `claude` CLI on the Max
subscription, and a global key would silently flip that to per-token billing.

## Keeping in sync

If upstream's action schema or the computer-use tool spec changes, re-vendor
`actions.mjs` / `loop.mjs` from the paths above. Do not hand-edit the copied
bodies beyond the documented adaptations.
