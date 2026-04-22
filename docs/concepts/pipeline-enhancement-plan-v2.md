# Pipeline Enhancement Plan v2 — Built on the New Labs UI

**Status:** Approved 2026-04-22 — decisions locked, questions retired. Supersedes
`pipeline-enhancement-plan.md` (kept for history).

**Source screenshots:** Plan Hero with Project Pipeline stepper
(Concept → Developing → QA Review → Deploy → Published → Party Mode), the
Hierarchy/Kanban/Gantt/Deploy tab strip, the Concept stage with Intent + Epics +
Wave cards, and the Start-a-new-plan form with Advanced Settings (Execution mode,
YOLO, Dev/Reviewer model).

## Decisions locked in

| #   | Decision                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Daemon gives the current Claude subprocess **30s graceful shutdown** on SIGTERM before SIGKILL                                                           |
| 2   | Retry policy: exponential backoff (30s → 2m → 8m), max 3 attempts per step, then attention item                                                          |
| 3   | Shell guard is a **generic path-scoped policy** — any spawn with cwd outside `/home/ubuntu/projects/<planSlug>` is refused                               |
| 4   | Attention items come from **both** the reducer (post-hoc) and live daemon signals (immediate)                                                            |
| 5   | Reducer auto-creates attention items using its **gut** — severity inferred from failure class                                                            |
| 6   | Resolved attention items are **kept for history** (soft-delete + filter, not hard-delete)                                                                |
| 7   | Attention surface is **in-app only** for MVP — no email, no Slack                                                                                        |
| 8   | Attention list sort: **severity desc, then recency desc**                                                                                                |
| 9   | **Rigor dial = dropdown in Advanced Settings** before development starts: `prototype / mvp / production`, with a `<small>` explanation under each option |
| 10  | TEST agent defaults to **sonnet**, exposed in the Advanced Settings model selector (haiku/sonnet/opus)                                                   |
| 11  | Tamper detection → **auto-revert** the tampered file and let the next dev retry correct it                                                               |
| 12  | Playwright/browser tests toggle lives in Advanced Settings, **right under the execution-type selector**                                                  |
| 13  | Daemon **also writes attention items directly** (not only via reducer) — observe + dedupe later                                                          |
| 14  | Budget overruns = **loud warning banner**, no hard enforcement                                                                                           |
| 15  | Published URL = **same route** as now; no preview subdomain                                                                                              |
| 16  | Per-story **Logs tab** on the story detail UI with a copy-to-clipboard button                                                                            |
| 17  | Attention tray = **right-side dock**, slides out over the main content                                                                                   |
| 18  | On "Resolve" click → optimistic **switch to "resolving"** state, then confirm                                                                            |

---

## Pillar 1 — Resilience

### 1.1 Graceful daemon shutdown (30s window)

- On SIGTERM, the daemon sets `shuttingDown` and stops pulling new jobs.
- For each in-flight Claude subprocess: send SIGTERM to the child and wait up
  to 30s.
- Clean exit → step marked `done` (if completion marker emitted) or `failed`
  with reason `daemon-shutdown-clean`.
- 30s elapses → SIGKILL + step `failed` reason `daemon-shutdown-timeout` →
  attention item (severity: medium).
- Before exit, flush ring-buffered stdout to the per-story **Logs tab**
  (S3-persisted).

**UI touchpoint:** the Project Pipeline stepper shows a subtle
"daemon restarting — 30s grace" toast anchored to the current stage. The
affected story's row gets an amber border and its Logs tab preserves partial
output.

### 1.2 Generic path guard

- Single middleware in `daemon/pipelines/lib/shell-guard.mjs`.
- Every `spawn`/`exec` passes through `resolveAllowed(cwd, planSlug)`.
- Allowed roots: `/home/ubuntu/projects/<planSlug>`, `/tmp`, plus static
  allowlist for `npm`, `node`, `git` global paths.
- Violation → refuse + emit attention item (severity: high, category:
  `policy-violation`).
- Neutralizes the runaway-`grep -rn /` incident pattern.

### 1.3 Retry ladder

- Per step, transient failure:
  - Attempt 2 after 30s
  - Attempt 3 after 2m
  - Attempt 4 after 8m
- Retry counter surfaces on story row as `retry 2/3` pill.
- After attempt 4 fails → `failed` + attention item (severity: high).
- Daemon restarts during retry window re-queue cleanly.

---

## Pillar 2 — Attention Inbox

### 2.1 Right-side dock

- Persistent bell icon top-right of plan hero (next to theme toggle).
- Badge count = unresolved items for this plan.
- Click opens right-side dock (420px) sliding over current tab; does not
  navigate away or collapse the plan hero.
- Closes with Esc or click-outside.

### 2.2 Item schema (DDB `futurator-attention-items`)

```
planId (PK), itemId (SK),
createdAt, resolvedAt (null until resolved),
severity: 'low' | 'medium' | 'high' | 'critical',
category: 'policy-violation' | 'retry-exhausted' | 'daemon-shutdown-timeout'
        | 'tamper-reverted' | 'budget-warning' | 'test-gate-failed'
        | 'dev-server-down' | 'other',
title, body (markdown),
context: { epicId?, storyId?, jobId?, stepId? },
suggestedActions: Array<{ label, kind: 'retry-step' | 'open-story' | 'open-logs' | 'archive' }>,
status: 'open' | 'resolving' | 'resolved'
```

### 2.3 Sort & filter

- Default sort: **severity desc, then recency desc**.
- Filter chips: `All / Critical / High / Medium / Low / Resolved`.
- Resolved items soft-kept, dimmed when surfaced.

### 2.4 Optimistic resolve

- Click **Resolve** → item instantly enters `resolving`: soft opacity, spinner
  replaces Resolve button.
- API confirm → moves under Resolved filter with `resolvedAt`.
- API failure → toast + bounce back to `open`.

### 2.5 Sources (both)

- **Wave reducer** scans completed waves, synthesizes items by severity gut.
- **Daemon** writes inline for: tamper-revert, path-guard violation,
  budget-warning, daemon-shutdown-timeout, dev-server-down.
- Both write to same table; UI dedupes on `title + storyId` within 60s window.

---

## Pillar 3 — Tier 1 Tests + Rigor Dial

### 3.1 Rigor dropdown (Start-a-new-plan Advanced Settings)

Placed above Execution mode:

```
Rigor level
[ mvp ▼ ]
  prototype  — fastest. No tests, lenient review, skip tamper check.
  mvp        — balanced. Unit tests + basic Playwright smoke if browser toggle is on.
  production — strict. Full TEST agent gate, tamper-check, red-green-tamper cycle.
```

Each option renders description as `<small>` (`text-xs text-muted-foreground`).

Also exposed on Concept tab as read-only pill (`RIGOR: MVP`) next to the
`DEVELOPING` badge — clickable to change if plan has no in-flight stories.

### 3.2 Playwright toggle

- Lives directly under Execution mode in Advanced Settings.
- Label: `Include browser tests (Playwright)` — toggle switch.
- Default: `off` for prototype, `on` for mvp/production (overridable).
- When on, story pipeline includes `test-author-browser` →
  `test-gate-red-browser` → ... → `visual-verify`.

### 3.3 TEST agent model

Advanced Settings has three model dropdowns:

- **Dev model** (default sonnet)
- **Reviewer model** (default haiku)
- **Test model** (default sonnet; haiku/sonnet/opus)

### 3.4 Red-green-tamper cycle

- `test-author` writes failing tests → `test-gate-red` asserts failure →
  `dev` implements → `test-verify` asserts pass → `tamper-check` diffs test
  files vs `test-author` output.
- Tamper found → **auto-revert**, increment per-story tamper counter, re-enter
  `dev`. No hard block.
- 3 tamper events on same story → attention item (severity: high).

### 3.5 Rigor affects pipeline builder

| Rigor      | TEST agent                  | Tamper-check | Review rigor | Budget warning |
| ---------- | --------------------------- | ------------ | ------------ | -------------- |
| prototype  | off                         | off          | lenient      | $5             |
| mvp        | unit only                   | auto-revert  | standard     | $10            |
| production | unit + browser (if toggled) | auto-revert  | strict       | $25            |

---

## Pillar 4 — Per-Story Logs Tab

New fourth tab in Story detail view:

```
OVERVIEW    DIFF    KNOWLEDGE    LOGS
```

- Header: step selector (`dev / review / test-author / test-verify /
tamper-check / compile-diff / compile-knowledge / compile-sync`),
  stdout/stderr toggle.
- Body: monospace, virtualized (10k+ lines).
- Top-right: **Copy to clipboard**, **Download .log**.
- Auto-scrolls to bottom while running; stops when user scrolls up.
- Persisted to S3 `logs/<planSlug>/<storyId>/<stepId>.log` — survives daemon
  restart.

---

## Pillar 5 — UI Canvas Changes

### 5.1 Project Pipeline stepper

- Each stage node shows a tiny attention badge if unresolved items are
  attached to that stage's work.
- Current stage also shows animated pulse when a daemon step is actively
  running.

### 5.2 Hierarchy tab

- Each epic row shows: progress bar, TIME, WAVES, TOKENS, COST (existing), plus
  an **attention dot** (amber) with unresolved count.
- Expanded epic shows wave cards with per-wave rollup (existing).
- Story rows get **status chip with retry count** (`queued`, `running`,
  `retry 2/3`, `done`, `failed`, `blocked`).

### 5.3 Concept stage

- Intent textarea + Generate Plan (existing) + "Regenerate epics" affordance.
- Epic cards show wave cards with story lists (existing) — plus retry pill
  and logs-tab entry point per story.

### 5.4 Deploy tab

- Same cards (DevServer, Visual QA, Publish).
- Same route for Published URL (no preview subdomain).
- Budget banner: loud amber above the three cards when `spent > rigorThreshold`;
  dismissible per-plan, reappears on next overrun.

### 5.5 Right-side dock

- Trigger: bell icon top-right of plan hero, badge with unresolved count.
- Panel: 420px, full height, `bg-card/95 backdrop-blur`.
- Header: "Attention" title + filter chips.
- List: cards with severity color bar (red/orange/yellow/blue), title,
  relative time, suggestedActions as inline buttons.
- Item click → scrolls underlying hierarchy to referenced story, flashes row.

---

## Rollout phases

**Phase A — Resilience foundations** (~2 days)

- Graceful shutdown + path guard + retry ladder
- Attention table + daemon write path
- Simple unresolved-count counter on plan hero (no dock yet)

**Phase B — Right-side dock + optimistic resolve** (~2 days)

- Full dock UI, filter chips, sort, resolve flow
- Reducer path for attention items
- Dedupe layer

**Phase C — Rigor + TEST agent + Logs tab** (~4 days)

- Rigor dropdown in Start-a-new-plan form + Advanced Settings
- Playwright toggle
- TEST agent integration (prototype/mvp/production variants)
- Tamper-check with auto-revert
- Per-story Logs tab with S3-persisted logs + copy-to-clipboard

**Phase D — Polish + budget warning** (~1 day)

- Budget banner
- Attention badges on stepper + epic rows
- Retry-count pills on story rows

Total: ~9 working days.
