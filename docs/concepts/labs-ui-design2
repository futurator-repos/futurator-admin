# Labs Plan Dashboard — Implementation Document

> Handoff doc for the implementation agent. Scope: the **Labs → Plans** page — the view a user lands on after selecting or creating a plan. This doc pairs with the prototype under `Labs Plan Dashboard.html` + companion JSX/CSS files.

---

## 1 · Overview

The Labs page lets a user monitor and drive a **plan** (intent → epics → waves → stories) through its lifecycle. The page has three composed layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Header        — L A B S / Plans   +   Project Selector    │
├─────────────────────────────────────────────────────────────┤
│  Project Hero  — plan name, status pill, stories / cost     │
├─────────────────────────────────────────────────────────────┤
│  Pipeline      — Concept → Developing → QA → Deploy → Pub.  │
├─────────────────────────────────────────────────────────────┤
│  Tabs          — Hierarchy | Kanban | Gantt     [actions]   │
├─────────────────────────────────────────────────────────────┤
│  Active view   — lazy-mounted; persisted to localStorage    │
└─────────────────────────────────────────────────────────────┘
```

The aesthetic mirrors the Futurator homepage: near-black canvas (`#050608`), thin/wide-tracked uppercase mono labels, hairline dividers, restrained monochrome palette with amber for financial signal and purple/red for live/stress signals. **No heavy cards, no gradients, no emoji.**

---

## 2 · File Map (from prototype)

| File | Responsibility |
|---|---|
| `Labs Plan Dashboard.html` | Root: composes Header, Hero, Pipeline, Tabs, ViewSwitcher |
| `styles.css` | CSS tokens (`--bg`, `--text`, type scale) + resets + keyframes |
| `helpers.jsx` | Status taxonomies, formatters, bottom-up aggregators |
| `data.js` | Mock `PROJECTS[]` and `PLAN` fixture with epics/waves/stories |
| `ProjectSelector.jsx` | Header combobox — search, keyboard nav, intent-on-hover tooltip |
| `Pipeline.jsx` | 5-stage project pipeline (between Hero and Tabs) |
| `HierarchyView.jsx` | Tree view: Epic → Wave → Story, rollups, story detail expansion |
| `KanbanView.jsx` | 5-column board, epic filter, story detail modal |
| `GanttView.jsx` | Time-scaled simulator, scrubber, side drawer |

---

## 3 · Domain Model

### 3.1 Project / Plan lifecycle (top-level pipeline)

```
concept ─► developing ─► qa review ─► deploy ─► published
                │
              fixing  (side-state of developing; pipeline still highlights "Developing")
```

Stored as `project.status` with values: `concept | developing | fixing | review | delivered | archived`. Map them to pipeline index via `Pipeline.stageIndexFor()`:

| status | pipeline stage |
|---|---|
| `concept` | 0 Concept |
| `developing` / `fixing` | 1 Developing |
| `review` | 2 QA Review |
| `delivered` | 4 Published |
| `archived` | 0 (hidden by default) |

> `fixing` is rendered as "recovering" copy + red accent inside the Developing node.

### 3.2 Plan hierarchy

```
Plan
 └─ Epic  (status: pending | in_progress | completed | fixing | failed)
     └─ Wave  (parallel execution gate)
         └─ Story  (status: pending | queued | running | in_review | fixing | done | failed | blocked | skipped)
```

Stories carry: `id, label, desc, sp, status, progress%, plannedSec, actualSec, cost, tokens, touchPoints[], criteria[], logs[], epicId, wave`.

Kanban collapses the 9 story statuses into 5 columns via `KANBAN_COLS` in `helpers.jsx`:

| Column | Matches |
|---|---|
| Backlog | `pending`, `skipped` |
| Queued | `queued` |
| Developing | `running`, `fixing` |
| In review | `in_review` |
| Done | `done` |

### 3.3 Aggregation rules (authoritative — used everywhere)

Implemented in `helpers.jsx` as `aggregateWave/aggregateEpic/aggregatePlan`.

- **Wave time** = `max(story.plannedSec)` — waves are parallel.
- **Wave actual** = `max(story elapsed)` where elapsed = `plannedSec * progress%` for live stories, `actualSec` for done.
- **Epic time** = `sum(wave.plannedSec)` — waves inside an epic are sequential.
- **Plan time** = `sum(epic.plannedSec)`.
- **Cost / tokens** = `sum` all the way up.
- **Progress** = story-count-weighted average.

The backend must expose these rollups or the frontend must recompute on every change.

---

## 4 · Visual / Interaction Spec

### 4.1 Header (`<Header/>`)

- Sticky. Background `--bg`, bottom border `--border`.
- Logotype: `L A B S` — `fontWeight: 300`, `letterSpacing: 0.42em`, uppercase.
- Separator pipe + mono caption `Plans`.
- `<ProjectSelector/>` sits left-of-center.
- Right cluster (system chips, mono, letter-spaced): Daemon status · EC2 · `N/3` slots · `↻ Re-auth`. These are ambient status; wire later.

### 4.2 Project selector (`ProjectSelector.jsx`)

- Trigger is a minimal 1-line button: dot · name · status pill · caret.
- Dropdown (460px, `--bg-elev`):
  - Search input, filters by name/intent/status/path.
  - Rows: dot + name + status + mono metrics (`done/total · cost · sizeMB · lastUpdate`) + hairline progress bar.
  - **Intent tooltip**: on row hover, a 300px panel slides in to the right showing `Intent` label, full intent text, and path. (Intent is **not** shown inline on rows or in the hero.)
- Keyboard: `↑/↓` navigate, `↵` select, `Esc` close.
- Footer chip: `＋ New Plan` action (route to plan creation).

### 4.3 Project hero (`ProjectHero` in `.html`)

- Breadcrumb in mono (Labs / Plans / {name}).
- Large display name: `fontSize: 56, fontWeight: 200, letterSpacing: -0.02em`.
- Below name: status pill + mono `path`.
- Right: three minimalist metrics (Stories, Progress, Cost) — tiny uppercase label over a `fontWeight: 300` number.
- **No intent here.** Intent lives in the selector tooltip only.

### 4.4 Pipeline (`Pipeline.jsx`)

- Render horizontally, 5 stages, connector lines between.
- Each node: dot (6–12px) + stage label + mono sub-copy.
- Current stage: filled amber dot with subtle glow + pulse ring, label color = `--text`.
- Past stages: filled `--text-dim` dot, connector is solid `--text-dim`.
- Future stages: ring (transparent fill + 1px border), label `--text-faint`, connector fades to `--border`.
- `fixing` status: current-stage dot turns `--red`, sub-copy reads "— recovering —".

### 4.5 Tabs

- Underline tabs (no pill group): Hierarchy · Kanban · Gantt.
- `fontSize: 12, letter-spacing: 0.14em, uppercase`.
- Right side: `Regenerate` (ghost) + `Start development →` (solid, inverted — white bg / black text).
- Active indicator: 1px bottom border `--text`.

### 4.6 Hierarchy view

- Plan-level rollup strip at top: 6 metrics (plan time, done/total, in flight, epics, tokens, cost).
- Each **epic** is a hairline-bordered row group; click header to expand/collapse waves.
- Each **wave** is a nested row with a parallel indicator (`∥`), aggregated progress bar, tokens, cost, done count.
- Each **story** row: disclosure caret + id + title + SP + agent + touch count + progress bar + time + tokens + cost + status pill.
- Expanding a story reveals a 2-col panel:
  - Left: description, acceptance criteria (checkable), touch-point chips.
  - Right: live log (mono, color-coded by event type) + action buttons (View Logs, Retry, Amend).

### 4.7 Kanban view

- 5 columns. Card: id + epic tag + wave tag + title + SP + time + cost + tokens. Left border colored by status.
- Active cards pulse a dot and show a progress bar.
- Epic filter chips above columns; total cost of filtered view in the top-right.
- Clicking a card opens a centered modal with description + 6 metric tiles + action row.

### 4.8 Gantt view

- Adapted from the uploaded simulator. Clock at 0–X min; play/pause, speed (1/2/4/8×), scrubber.
- Bars:
  - Purple = developing; Green = done on time; Amber = done late; Red = overrunning now; Grey dashed ghost = planned position; Arrow on connector = slip.
- Row collapse by plan → epic → wave. Aggregate bars summarize children.
- Clicking a bar opens a **right-side drawer** (480px wide) with:
  - Title, status, description.
  - Estimate accuracy bar (planned vs actual).
  - 8-tile metric grid.
  - Acceptance criteria.
  - Recent activity log.
  - Actions: Open in Hierarchy, Retry, Amend.
- Lazy-mount: the Gantt only starts its RAF loop once visible.

---

## 5 · State & Persistence

- `active tab` → `localStorage["labs.view"]`, default `hierarchy`.
- `project` → currently from `PROJECTS[0]`; in production, read from route: `/labs/plans/:projectId`.
- Story expand state, kanban filter, gantt scrub position → component-local (ephemeral).

---

## 6 · Data Contracts (to replace the `data.js` fixture)

### GET `/api/plans`
Returns the list used by the selector:
```ts
type ProjectSummary = {
  id: string;
  name: string;
  path: string;            // repo / folder
  intent: string;          // shown in hover tooltip
  status: "concept"|"developing"|"fixing"|"review"|"delivered"|"archived";
  doneStories: number;
  totalStories: number;
  cost: number;            // USD
  sizeMb: number;
  lastUpdate: string;      // human: "12m ago"
};
```

### GET `/api/plans/:id`
Returns the full plan tree + pipeline position:
```ts
type Plan = {
  id: string;
  name: string;
  path: string;
  intent: string;
  status: ProjectSummary["status"];
  epics: Epic[];
};
type Epic = {
  id: string; label: string; goal: string;
  planWave: number;        // position in plan's outer wave sequencing
  status: "pending"|"in_progress"|"completed"|"fixing"|"failed";
  dependsOn: string[];     // other epic ids
  waves: Wave[];
};
type Wave = { id: string; label: string; stories: Story[] };
type Story = {
  id: string; label: string; desc: string;
  sp: number;              // story points
  status: StoryStatus;
  progress: number;        // 0–100
  plannedSec: number;
  actualSec: number | null;
  cost: number; tokens: number;
  agent?: string;
  touchPoints: string[];
  criteria: { text: string; done: boolean }[];
  logs: { t: string; type: string; step: string; msg: string }[];
  epicId: string;
  wave: number;            // index within epic
};
```

### Real-time updates
Open an SSE or WS stream on `/api/plans/:id/events`. Events:
- `story.status` — `{ storyId, status, progress? }`
- `story.log` — append to `story.logs`
- `story.progress` — `{ storyId, progress }`
- `story.done` — `{ storyId, actualSec, cost, tokens }`
- `epic.status` / `wave.status` — coarse rollup events
- `plan.status` — pipeline transitions

Aggregation is recomputed client-side on every event (it's cheap).

### Actions (optimistic on client, confirmed by server)
| UI | Endpoint |
|---|---|
| Regenerate plan | `POST /api/plans/:id/regenerate` |
| Start development | `POST /api/plans/:id/start` |
| Retry story | `POST /api/stories/:id/retry` |
| Amend story | `POST /api/stories/:id/amend` |
| Promote to QA | `POST /api/plans/:id/promote?to=qa` |
| Promote to Deploy | `POST /api/plans/:id/promote?to=deploy` |
| Publish | `POST /api/plans/:id/publish` |

---

## 7 · Design Tokens (copy verbatim from `styles.css`)

```css
--bg:        #050608;
--bg-elev:   #0a0b0f;
--surface:   #101217;
--surface-2: #161920;
--border:    #1c1f27;
--border-2:  #2a2e38;

--text:       #ededee;
--text-dim:   #a0a3ab;
--text-mute:  #6b6f78;
--text-faint: #3c404a;

--green:  #22c55e;  /* done */
--purple: #a78bfa;  /* live / running */
--amber:  #d1a54f;  /* cost + current pipeline stage */
--red:    #ef4444;  /* stress / fixing / overrun */
--blue:   #7893b8;
--cyan:   #8ab4c7;

--font-sans:    'Inter', system-ui, sans-serif;
--font-display: 'Inter', sans-serif;
--font-mono:    'JetBrains Mono', ui-monospace, monospace;
```

### Type rules
- Display name: 56px / weight 200 / −0.02em.
- Section micro-labels: 8–9px mono, uppercase, `0.22em` tracking, `--text-faint`.
- Tab labels: 12px, uppercase, `0.14em`.
- Metric numbers: weight 300.
- Body copy: 12–14px, `--text-dim`, line-height 1.5–1.6, `text-wrap: pretty`.

### Spacing / geometry
- Page padding: 40px horizontal.
- Radii: 2px for controls, 10–12px only for the pipeline panel.
- Dividers: always 1px solid `--border` — no shadows, no heavy separators.

---

## 8 · Accessibility

- Project selector: full keyboard support implemented. Replicate in production (ARIA combobox pattern, `aria-activedescendant`).
- Status pills: color is not the sole signal — every status has a text label and dot shape/weight variation.
- Pulse animation (`@keyframes pulse`) should respect `prefers-reduced-motion: reduce`.
- Min tap target 32×32 for row actions; story rows are fully clickable.

---

## 9 · Build Order (recommended)

1. Shell: tokens + Header + ProjectSelector + routing scaffold.
2. `/api/plans` wiring, fixture-parity.
3. ProjectHero + Pipeline (static, driven by `project.status`).
4. Hierarchy view + aggregation functions (pure, easy to unit test).
5. Kanban view (reuse `STORY_STATUS` + `KANBAN_COLS`).
6. Gantt view + simulator (keep the current math — it handles overrun/slip visualization).
7. SSE stream + optimistic action handlers.
8. Pipeline transitions wired to `promote/publish` endpoints.

---

## 10 · Definition of Done

- [ ] All three views render from real API data; no fixture leakage.
- [ ] SSE updates reflect in all three views without reload.
- [ ] Selector lists every plan owned by the user; intent shows only on hover.
- [ ] Pipeline reflects current `plan.status` and can advance via actions.
- [ ] Keyboard nav works in the selector and on tabs.
- [ ] Lighthouse a11y ≥ 95.
- [ ] `prefers-reduced-motion` disables pulses, shimmer, slide-downs.
