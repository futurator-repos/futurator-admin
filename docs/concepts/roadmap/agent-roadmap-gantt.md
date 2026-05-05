# Agent Roadmap Gantt — Technical Documentation

A real-time Gantt visualization for agentic development pipelines. Unlike traditional project management Gantt charts that display a static plan, this component treats time as a live simulation: downstream stories physically reposition frame-by-frame when upstream blockers overrun their estimates.

---

## 1. Purpose & Philosophy

Traditional Gantt charts assume the future is known. Agentic pipelines break that assumption — an agent might finish a task in 30 seconds or spend 10 minutes spinning on an edge case, and you only discover the overrun as it happens.

This component models that reality. Its core principle:

> **We do not predict when an overrunning story will finish. While it is still running past its planned end, its projected end is simply _right now_ (`t`). As `t` advances, every dependent downstream story's position advances with it.**

The result: when a blocker runs long, the entire dependent chain visibly slides rightward in real-time. When the blocker finally completes, the chain locks into its new displaced position.

---

## 2. Data Model

### 2.1 Hierarchy

The visualization renders four levels of hierarchy:

```
Version
 └── Epic
      └── Wave
           └── Story
```

- **Version**: The top-level release or iteration container. Shows aggregate progress across all work.
- **Epic**: A major functional area (e.g., "Core Infrastructure", "Agent Pipeline Engine"). Epics run sequentially — the next epic cannot start until the previous one finishes.
- **Wave**: A group of stories that execute **in parallel**. This is the key primitive from the agentic orchestration model — the BMAD-style concept where an orchestrator spawns multiple agents simultaneously to work on independent stories. Waves run sequentially within an epic (wave 2 waits for wave 1 to fully complete).
- **Story**: A single unit of work executed by an individual agent. Has a planned duration (derived from story points) and a hidden speed factor that represents reality.

### 2.2 Story Definition

Each story is defined in `EPIC_DEFS` with:

| Field | Purpose |
|-------|---------|
| `id` | Unique identifier |
| `label` | Display name |
| `sp` | Story points (1 SP = 7 sim-seconds of planned time, configurable via `SP_UNIT`) |
| `speedFactor` | **Hidden reality**. `1.0` = on time, `0.5` = earns progress at half speed (takes 2× longer), `2.0` = finishes twice as fast |
| `tool` | Optional badge (e.g., `BROWSER` for stories that use browser automation) |
| `desc` | Description shown in the detail popover |

### 2.3 Timing Constants

```js
const SP_UNIT = 7;       // 1 story point = 7 seconds of planned time
const WAVE_GAP = 1.5;    // Gap between consecutive waves
const EPIC_GAP = 2.5;    // Extra gap between epics
```

---

## 3. The Simulation Engine

The heart of the component is `simulate(t)` — a pure function that takes the current time `t` and returns the complete state of every story, wave, and epic at that instant.

### 3.1 How It Works

`simulate(t)` walks the hierarchy top-down, maintaining two cursors:

- `cursor` — the **actual** timeline position, which shifts rightward whenever an upstream wave overruns
- `plannedCursor` — the **planned** timeline position, which never shifts (reference baseline)

For each story, it computes a `projectedEnd` based on the story's current state:

| Status | projectedEnd |
|--------|--------------|
| Queued (not started yet) | `actualStart + plannedDur` (assume on-time) |
| Running, within plan | `actualStart + plannedDur` (still assume on-time) |
| Running, past plan (**overrunning**) | `t` — we don't know when it will end |
| Done | `actualStart + actualDur` (frozen at true completion) |

The wave's `projectedEnd` is the max of its stories' `projectedEnds`. The next wave's `actualStart` is that value plus the gap. The cascade propagates automatically.

### 3.2 The Critical Line

```js
projectedEnd = isOverrunning ? t : actualStart + plannedDur;
```

This is what produces the live movement. When a story is overrunning:
- As `t` advances by 1 sim-second, its `projectedEnd` advances by 1 sim-second
- The wave's projected end advances by 1 sim-second
- The next wave's `actualStart` advances by 1 sim-second
- Every downstream story's `actualStart` advances by 1 sim-second

Because React re-renders on every frame of the animation loop, this manifests visually as the downstream bars physically sliding rightward.

### 3.3 Progress Accumulation

Progress is not a direct function of time. It's a function of `workDone`, which is `elapsed * speedFactor`. A story with `speedFactor: 0.5` accumulates work at half the rate of elapsed time, so it takes 2× the planned duration to reach 100%.

```js
const elapsed = t - actualStart;
const workDone = elapsed * def.speedFactor;
const progressFrac = Math.min(workDone / plannedDur, 1.0);
```

The story completes (transitions from `running` to `done`) when `workDone >= plannedDur`.

### 3.4 Purity

`simulate(t)` is a **pure function**. Given the same `t`, it always returns the same result. Nothing is stored between calls. The simulation is derived entirely from `EPIC_DEFS` and the current time. This makes scrubbing (dragging the playhead backward or forward) work correctly — we simply call `simulate(newT)` and the UI renders the new state.

---

## 4. Visual Mechanics

### 4.1 Bar States & Colors

The component uses color to communicate story state instantly:

| State | Color | Meaning |
|-------|-------|---------|
| Queued | Grey `#3e4a5c` | Not started yet |
| Running, on schedule | Purple `#a78bfa` | In progress, within planned time |
| Running, overrunning | **Red** `#ef4444` | Past planned end, still not done |
| Done on time | Green `#22c55e` | Finished within plan (speedFactor ~1.0) |
| Done late | Orange `#f59e0b` | Finished, but took longer than planned |

Red vs orange distinction matters:
- **Red = active stress** (the story is currently blocking downstream work)
- **Orange = historical stress** (the damage is done, positions have settled)

### 4.2 Planned Ghost Outline

When a story is displaced or stretched, a dashed outline appears at its **original planned position**. This is the visual reference for "where it was supposed to be." The outline is rendered via `border: "1px dashed #33415588"` on an absolute-positioned div.

The ghost only appears when:
- The story's `displacement` > 0.3 sim-seconds (meaningfully shifted), OR
- The story has stretched past its planned width

For queued stories and on-time stories, no ghost is shown — the actual position IS the planned position, no visual clutter needed.

### 4.3 Displacement Connector

For stories that have visibly shifted from their planned position, a small arrow connector bridges the gap between the ghost outline's end and the actual bar's start. This is a subtle detail that makes the displacement feel causal — you can see the "push" from planned to actual.

```js
{showGhost && story.displacement > 0.5 && story.status !== "queued" && (
  <div style={{
    position:"absolute",
    left:`${pL + pW}%`,
    width:`${aL - (pL + pW)}%`,
    top:14, height:2,
    background:"linear-gradient(90deg, #33415566, #f59e0b88)",
  }}>
    <div style={{/* arrow head */}}/>
  </div>
)}
```

### 4.4 Progress Fill

Within each running bar, the colored fill represents percentage progress. The fill width is `${story.progress}%` of the bar's width. This means for an overrunning story:
- The **bar** stretches (elapsed time keeps growing)
- The **fill** keeps creeping toward 100% (but never reaches it until work completes)

Visually, this communicates: "I'm taking longer than expected AND I'm still not done."

### 4.5 Aggregate Bars (Epic, Wave, Version)

Parent nodes render a translucent aggregate bar spanning their children's actual extent. The aggregate bar:
- Spans from `min(childActualStart)` to `max(childActualEnd)`
- Fill percentage = average of children's progress
- Color shifts to orange/red if any child is stressed
- Shows the `+Ns` displacement badge if the aggregate is displaced from plan

### 4.6 Critical: No CSS Transitions on Position

```js
transition: "border-color 0.3s, box-shadow 0.3s", // NO transition on left/width
```

This is intentional. If we used `transition: "left 0.3s ease"`, the bars would lag behind the simulation — you'd see them smoothly catching up rather than tracking `t` exactly. For the live displacement effect to feel causal and real, position updates must be **instant** on every frame. Color and shadow transitions are fine because they don't affect layout.

---

## 5. The Animation Loop

```js
useEffect(() => {
  if (!playing) return;
  const tick = now => {
    const dtReal = (now - lastRef.current) / 1000 * speed;
    const dtSim = dtReal * simScale;
    setT(prev => prev + dtSim);
    animRef.current = requestAnimationFrame(tick);
  };
  animRef.current = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(animRef.current);
}, [playing, speed, simScale]);
```

Uses `requestAnimationFrame` for 60fps updates. On each frame:
1. Compute `dtReal` = real seconds since last frame (compensated by playback speed)
2. Compute `dtSim` = sim-seconds to advance (scaled so the planned timeline takes ~120 real seconds at 1×)
3. Update `t`, triggering a React re-render
4. `simulate(t)` runs, all bars reposition, the UI reflects the new state

Playback speed multipliers (1×, 2×, 4×, 8×) simply multiply `dtSim`.

### 5.1 Scaling

`simScale` is fixed at mount based on the initial planned total duration:

```js
const initialPlanned = useMemo(() => simulate(0).totalPlanned, []);
const simScale = initialPlanned / SIM_REAL;
```

This means 120 real seconds of playback covers the full planned timeline at 1× speed. If overruns extend the timeline beyond planned, playback continues past 120 seconds — this is correct behavior, since in reality projects that slip take longer to play back too.

---

## 6. UI Structure

### 6.1 Top Bar

| Element | Purpose |
|---------|---------|
| Play/Pause | Controls the animation loop. Auto-resets if called after completion. |
| Reset (↺) | Returns to `t = 0`, stops playback, clears selected story. |
| Speed buttons | 1×, 2×, 4×, 8× playback multipliers. |
| Live timer | Shows current sim-time (`MM:SS` format), tabular-numerics for stable width. |
| Progress ring | SVG circular progress at top-right. Color shifts: purple → red (if any story is stressed) → green (if all done). |
| Stats | Done / Live / Stress / Queue counts, total cost, and `+Slip` badge showing timeline displacement. |

### 6.2 Scrubber

A draggable bar beneath the top controls. Drag to seek to any point in the timeline. Dragging automatically pauses playback. The scrubber's fill shows progress through the total simulation time.

### 6.3 Time Ruler

Fixed header with time markers (every 10s or 15s depending on total duration). Major markers every 30s are taller and lighter. An amber playhead with a small flag indicates the current `t`. The ruler auto-expands if overruns push the total duration beyond the initial planned length.

### 6.4 Tree Rows

Each row has two sections:
- **Left pane (340px fixed width)**: hierarchy label with indent, icon, name, badges (story points, tool, displacement, status), expand/collapse chevron for parents.
- **Right pane (flex)**: the Gantt bar area. For stories, this is the live-moving bar. For parents, it's the aggregate bar.

Rows are collapsible. Click any epic or wave label to toggle. State is preserved in `exp` React state.

### 6.5 Story Detail Popover

Click any story bar to open a fixed-position popover on the right side of the viewport. Shows:
- Description paragraph
- 2-column grid: status, story points, planned vs actual duration, progress, cost, displacement, overrun factor
- Estimate accuracy bar (green portion = planned time fulfilled, orange/red portion = overrun)

Click outside to close. Click the same bar again to toggle off.

---

## 7. Integration Into Your Project

### 7.1 Current Props / Inputs

The component currently reads from a hardcoded `EPIC_DEFS` constant. To integrate with your BMAD + Claude Agents SDK orchestrator:

1. **Replace `EPIC_DEFS`** with a prop or context value fed from your real orchestration state.
2. **Replace `speedFactor`** with real-time telemetry. In production, you won't know a story's speed factor upfront — you'll receive progress updates from the agent. Adapt `simulate(t)` to consume:
   - For queued stories: planned start and duration (from the BMAD PM output)
   - For running stories: actual start timestamp + live progress % from the agent SDK
   - For done stories: actual start + actual end timestamps

### 7.2 Recommended Data Shape for Integration

```ts
interface LiveStory {
  id: string;
  label: string;
  epicId: string;
  waveId: string;
  sp: number;
  plannedDurSec: number;
  
  // Runtime state from your orchestrator
  status: "queued" | "running" | "done" | "failed";
  startedAt?: number;   // epoch ms when agent began
  completedAt?: number; // epoch ms when agent finished
  progress?: number;    // 0-100, reported by agent
  
  // Optional
  tool?: string;
  desc?: string;
  agentId?: string;
  model?: string;
  tokensUsed?: number;
  costUsd?: number;
}
```

The `simulate()` function would be rewritten to compute displacement from real timestamps rather than simulating from `speedFactor`.

### 7.3 Live Data Flow

For a real agentic pipeline, the data flow would be:

```
Agent SDK event → SSE stream → Client state update → React re-render → simulate() recomputes → Bars reposition
```

The component is already designed to re-render every frame via the animation loop. In production, you'd replace the internal playback clock with actual wall-clock time, and let status changes come from the SSE stream.

### 7.4 Critical Path Detection

The current implementation treats every wave as dependent on the previous wave. In a real system, you may want explicit dependency edges between stories (e.g., `s7` depends on `s5`, but not on `s6`). Extend the story definition with a `dependsOn: string[]` field and replace the sequential cursor advancement with a topological traversal.

### 7.5 Handling Agent Failures

The current model has four statuses: queued, running, done, overrunning. For production, you'll want:
- `failed` — agent errored out, needs human intervention (render in a distinct color, e.g., magenta)
- `retrying` — agent failed and is attempting recovery (pulsing yellow?)
- `paused` — user interrupted or escalation pending (striped pattern?)

---

## 8. Styling Approach

### 8.1 Color Palette

Dark engineering-studio aesthetic. All colors are explicit hex values, not Tailwind classes. Key palette:

```
Background   #070c16  (near-black with blue tint)
Surface      #0c1322 / #131c2e  (elevated panels)
Border       #151d2e / #1e293b  (subtle separators)
Text primary #e2e8f0  (off-white)
Text muted   #64748b / #94a3b8  (labels, secondary info)
Accents:
  Amber      #f59e0b  (playhead, timer, critical highlights)
  Purple     #a78bfa  (in-progress)
  Green      #22c55e  (done on time)
  Red        #ef4444  (actively overrunning)
  Orange     #f59e0b  (done late)
  Blue       #3b82f6  (epic marker)
  Violet     #8b5cf6  (wave marker)
```

### 8.2 Typography

Two font families loaded from Google Fonts:
- **DM Sans** — labels, headings, story names (readable humanist sans)
- **JetBrains Mono** — timers, numeric values, badges, status tags (technical feel, tabular numerics for stable-width numbers)

### 8.3 Inline Styles

The entire component uses inline `style={{}}` objects rather than CSS-in-JS or external stylesheets. This is intentional for portability — you can drop the JSX into any React environment without worrying about CSS bundler configuration. Trade-off: no media queries (component assumes desktop viewport).

---

## 9. Performance Notes

### 9.1 simulate() Cost

`simulate(t)` does an `O(total_stories)` walk. For portfolios under ~200 stories, this runs in well under a millisecond and can execute on every `requestAnimationFrame` tick without issue. For larger portfolios, memoization would need to be added — but note that memoization of `simulate(t)` by `t` gives little benefit, since every frame has a different `t`. Better optimization would be to cache per-epic or per-wave partial results and invalidate only when upstream state changes.

### 9.2 React Re-render Cost

Every frame triggers a full re-render of the tree. For deep hierarchies, this can become expensive. If you observe frame drops:

1. Split `<TreeNode>` into memoized sub-components keyed by story ID
2. Use `React.memo` with a custom comparison that checks only the story's own fields
3. Consider using a direct DOM update pattern (mutate `style.left` on refs) instead of React state for position updates

For current test data (18 stories), no optimization is needed.

### 9.3 Animation Smoothness

`requestAnimationFrame` targets 60fps. If the browser tab is backgrounded, RAF pauses — this is correct behavior (no wasted CPU). When the tab returns to focus, playback resumes from the current `t`, not where wall-clock time says it should be. This is a deliberate choice; if you need wall-clock behavior instead, swap RAF for `setInterval` or compute `dtReal` from `performance.now()` deltas.

---

## 10. Known Limitations

1. **No real dependency graph** — dependencies are implicit through wave ordering. Two stories in the same wave cannot depend on each other.
2. **No branching / conditional paths** — the plan is linear. Real agentic workflows sometimes fork based on intermediate results.
3. **No parallelism across waves** — if wave 2 of epic A and wave 1 of epic B are actually independent, the current model still runs them sequentially.
4. **No retry visualization** — if an agent fails and retries, it just appears as a longer-running bar. A better UX would show retry attempts as segments within the bar.
5. **No user intervention surfaces** — as the CEO/operator watching the dashboard, there's no "redirect this agent" or "kill this wave" button. In production this is essential.
6. **Fixed viewport width** — the left pane is 340px hardcoded. Adjust via the `width` / `minWidth` values on the tree row divs.
7. **No mobile layout** — desktop only.

---

## 11. File Structure & Code Layout

The JSX file is organized top-to-bottom as:

1. **Header comment** — explains the core insight
2. **Constants** — `SP_UNIT`, `WAVE_GAP`, `EPIC_GAP`
3. **EPIC_DEFS** — the plan data
4. **simulate(t)** — the pure simulation function (the core of everything)
5. **Helpers** — `fmt()`, `stColor()`, `barGradient()`, color maps
6. **Popover** — story detail modal
7. **StoryBar** — individual story bar renderer
8. **AggBar** — aggregate bar for parent nodes
9. **TreeNode** — recursive tree row component
10. **TimeRuler** — top time axis with playhead flag
11. **Scrubber** — draggable timeline position control
12. **GridLines** — background vertical grid
13. **buildTree()** — converts EPIC_DEFS into the tree structure
14. **App (default export)** — orchestrates everything, manages state, runs the animation loop

Single-file deliberately. No external dependencies beyond React. Drop it into any project with React 16.8+ (needs hooks) and it works.

---

## 12. Extension Ideas

### Short-term

- **Tooltip on hover** (instead of click-to-popover) for quick info
- **Keyboard shortcuts** — space to play/pause, `[` and `]` to change speed, arrow keys to scrub
- **Story grouping by agent** — alternative view where rows are agents instead of stories
- **Cost budget warning** — red flash when accumulated cost crosses a threshold

### Medium-term

- **Live agent feed panel** — side panel showing current agent thoughts / tool calls for the selected story
- **Dependency arrows** — explicit arrows between stories showing the dependency graph
- **What-if simulation** — a second playhead showing "what happens if I kill this agent right now"
- **Historical comparison** — overlay a previous run's actuals as a ghost layer to compare progress

### Long-term

- **Intervention controls** — click a running story and get buttons: "Redirect with new prompt" / "Escalate to me" / "Kill and retry"
- **Portfolio view** — top-level across all your products (Songster, Atlassinator, goMAD, etc.) with agent-hour allocation
- **Model cost routing overlay** — show per-bar which model handled it, with cost/performance indicators
- **Auto-replan suggestions** — when displacement crosses a threshold, surface a suggestion like "Wave 3 of Epic 2 is 3 min behind. Kill the blocker and parallelize s11-s13 across different worktrees?"

---

## 13. Integration With Your Stack

This component fits naturally with:

- **BMAD methodology** — The hierarchy Version → Epic → Wave → Story maps directly to BMAD's output structure.
- **Claude Agents SDK** — The animation model assumes agent progress is reported as a progress percentage + status. The SDK provides this natively via its event streaming.
- **AWS Bedrock / EC2 orchestration** — Each story corresponds to an agent execution. The displacement model makes sense when agents run on shared compute (queued waves wait for GPU or context slots).
- **Memgraph / GraphRAG** — If you want true dependency awareness, the story graph can be stored in Memgraph and the component fed via a real-time query.
- **SSE streaming** — The component re-renders on state changes, so feeding it from an SSE stream of agent events is a natural fit.

The single most important adaptation for your Futurator orchestrator: replace the `speedFactor` simulation with real agent telemetry. Everything else in the visual language stays the same.

---

## License / Attribution

Generated as a reference implementation. Adapt freely for Futurator internal use.
