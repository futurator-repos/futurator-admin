# Agent Prompt Templates — Cache Audit

**Pipeline v1, Story 5.5.** This doc records the audit of cache-busters in
agent prompt templates and the recommended cache-stable prefix structure.
The goal is >50% input-token cache hits between same-kind back-to-back
agent invocations within Anthropic's 5-minute prompt-cache window.

## TL;DR

| Template                          | Cache-stable prefix length | Status                                          |
| --------------------------------- | -------------------------- | ----------------------------------------------- |
| `dev-subagent-prompt.md.tpl`      | 0 bytes                    | ❌ Per-story variables interpolated at line 1   |
| `reviewer-subagent-prompt.md.tpl` | 0 bytes                    | ❌ Per-story variables interpolated at line 1   |
| `epic-orchestrator-prompt.md.tpl` | ~variable                  | ⚠️ Orchestrator sees epic-specific payload      |
| `remediation-prompt.md.tpl`       | 0 bytes                    | ❌ Per-blocker variables interpolated at line 1 |
| `touch-point-inference.md.tpl`    | 0 bytes                    | ❌ Per-epic variables interpolated at line 1    |

`EXIT_SIGNALS_PROMPT_SUFFIX` (Story 1.2) is identical across all spawns and
is currently appended at the **end** of the assembled prompt, after the
per-call variable content. Moving it to the **front** would create a
cache-stable head — but the suffix is small (~600 chars), so the
incremental cache savings are bounded.

## Cache-stable prefix structure (target)

For each agent kind, prompts should be assembled in this order:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. System role + universal protocol                         │  ← CACHE-STABLE
│    (EXIT_SIGNALS_PROMPT_SUFFIX, role-defining preamble)     │
│                                                             │
│ 2. Tool definitions / project policy                        │  ← CACHE-STABLE
│    (allowedTools list, shell-guard reminders)               │
│                                                             │
│ 3. Cache-stable context                                     │  ← CACHE-STABLE
│    (codebase index header, run_command snippet, rubric      │
│     EXCERPT — only the parts that don't vary per story)     │
│ ─────────────────────────────────────────────────────────── │
│ 4. Per-call variables                                       │  ← CACHE-MISS
│    (storyId, touch points, blocker payload, etc.)           │
│                                                             │
│ 5. Final user instruction                                   │  ← CACHE-MISS
└─────────────────────────────────────────────────────────────┘
```

The cache miss starts at the first byte that differs between calls. So a
50%+ hit rate requires: every byte before the first variable substitution
is identical across same-kind invocations.

## Cache-busters found in v1

Searched: `daemon/pipelines/templates/*.tpl`, `daemon/pipelines/lib/`,
`daemon/agent-daemon.mjs` prompt-assembly site (`substituteTemplate` →
`appendExitSignalsSuffix` → spawn).

| Source                                         | Pattern                      | Disposition                                                 |
| ---------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `dev-subagent-prompt.md.tpl:1`                 | `{{storyId}}` at line 1      | KEEP — refactor blocked by orchestrator's positional read.  |
| `reviewer-subagent-prompt.md.tpl:1`            | `{{storyId}}` at line 1      | KEEP — same.                                                |
| `remediation-prompt.md.tpl:1`                  | `{{blockerCode}}` at line 1  | KEEP — remediation flow assumes blocker context is leading. |
| `touch-point-inference.md.tpl`                 | epic-specific glob list      | ACCEPT — per-epic, not per-story; cache hits between waves. |
| `agent-daemon.mjs:executeStep` prompt assembly | suffix appended **after**    | FUTURE — flip to prefix-injection for cache-stable head.    |
| `lib/attention-writer.mjs`                     | `randomUUID()`, `Date.now()` | NOT IN PROMPT — only used for DDB row keys.                 |
| `lib/epic-repo.mjs`                            | `new Date().toISOString()`   | NOT IN PROMPT — only used for DDB updatedAt.                |

No `Math.random()`, `${timestamp}`, or unbounded string interpolation was
found in any `.tpl` file.

## v1 verdict

The templates **do not** currently produce a cache-stable prefix. The path
to >50% cache hit rate is:

1. **High ROI (recommended):** flip `EXIT_SIGNALS_PROMPT_SUFFIX` from suffix
   to prefix (`prompt = EXIT_SIGNALS + '\n' + body` instead of
   `prompt = body + '\n' + EXIT_SIGNALS`). Buys ~600 cached bytes per
   spawn — small, but free. Tracked in v1.x.
2. **Medium ROI (deferred):** restructure `dev-subagent-prompt.md.tpl` so
   the per-story header lives at the bottom and the cache-stable rubric
   excerpt + tool reminders live at the top. Requires a coordinated
   change to the orchestrator's prompt-reading code; tracked separately.
3. **Low ROI:** dedupe per-pipeline boilerplate that's currently duplicated
   between `dev-subagent` and `reviewer-subagent`. Saves a few hundred
   bytes; not worth the refactor cost yet.

## Verification plan

When item 1 lands, measure:

```sh
# Daemon emits per-step `result` events with usage.cache_read_input_tokens.
# Sample 10 same-kind back-to-back jobs (e.g. 10 dev steps within 5 min)
# and confirm:
#   sum(cache_read_input_tokens) / sum(input_tokens) > 0.5
```

The `agent-events` table already records `cost`, `inputTokens`, and
`cacheReadInputTokens` per step (Phase A.4 metrics). A simple aggregation
query against that table proves the AC.

## Related

- Story 1.2 — `EXIT_SIGNALS_PROMPT_SUFFIX` and the universal exit-signal
  protocol. Lives in `daemon/pipelines/lib/exit-signals.mjs`.
- Story 5.1 — token tracking per session turn. Records the metrics this
  audit's verification step relies on.
- Story 5.3 — auto-compaction. Reduces _resume_ cost; orthogonal to
  prefix-cache hit rate but reinforces the same goal (cheap session reuse).
