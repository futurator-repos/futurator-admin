# Agentic Office — Technical Spec

**Audience:** another engineer working on `src/components/agentic-office/**` or
anyone reviewing the office for perf / architecture questions.
**Scope:** what the office is, how data flows, which libraries carry the
weight, and where the perf edges are when we push to 15 active workers.

This doc is the reference. For decision history see
`docs/concepts/agentic-office-enhancements-epics-a-f.md`.

---

## 1. Purpose

The Agentic Office is a 3-D isometric **portfolio dashboard**. It turns the
DDB state of our agent pipeline (plans → epics → stories → jobs → events)
into a live-action scene where each Claude subprocess is visually
represented by a named character at a desk. It's diagnostic, not
decorative — a scroll of chat bubbles tells you *what* an agent is doing
right now, a red badge tells you *something broke*, and a pulsing tray
tells you *the inbox needs attention*.

The scene is mounted at `/development/agentic-office` and is the single
view where all concurrent plan activity is visible at once.

---

## 2. Libraries

| Library | Version | Role |
| --- | --- | --- |
| **Next.js** | 16.2.2 | App Router, static export (`output: 'export'`); the page is a plain static HTML bundle deployed to S3 |
| **React** | 19.2.4 | Component model; no React Server Components in the office — everything is `'use client'` |
| **three** | 0.183 | Core WebGL engine |
| **@react-three/fiber** | 9.6 | Declarative React renderer for Three; the Canvas + useFrame loop |
| **@react-three/drei** | 10.7 | Helpers: `OrthographicCamera`, `OrbitControls`, `useGLTF`, `useAnimations`, `Billboard`, `Text` (SDF) |
| **three-stdlib** | 2.36 | `SkeletonUtils.clone()` — independent skeleton instances per character |
| **zustand** | ^5 | `useOfficeStore` — persona runtime, kanban, action queue, UX state |
| **TanStack Query** | ^5 | DDB fetches (apps / epic workflows / jobs / events / attention / EC2 status) |
| **Tailwind 4** | ^4 | 2-D overlays (kanban, character panel, event log, attention panel, board modals) |

**GLTF assets** live under `/public/models/universal-gltf/` (Quaternius
characters) and `/public/models/environment/furniture|restaurant/`. There
are 10 unique `CharacterKind` meshes shared across 14 personas, plus
~15 furniture GLTFs.

---

## 3. Scene layout

Top-down map of the main office (`ROOM`) and adjoining server room
(`ROOM2`) — all coordinates in metres. `y` is up.

```
              -Z  (back of scene)
       ┌────────────────────────────┬─────────────┐
       │ Supervisor    whiteboard   │             │
       │ (-7,-9)       (-10.5, 0)   │  Server     │
       │                             │  room       │
       │  Dev row    z=-3           │  (ROOM2)    │
       │  [-9,-3,3,9] × 4 desks     │  x=[12,24]  │
       │                             │  z=[-12,-2] │
       │  Tester row z=0.5           │  ← EC2      │
       │  [-9,-3,3,9] × 4 desks     │    board    │
       │                             │             │
       │  Reviewer row z=4           ├─────────────┤
       │  [-9,-3,3,9] × 4 desks     │ Management  │
       │                             │ room        │
       │         Couch (8,9)         │             │
       │                             ├─────────────┤
       │  Entrance (0,11)            │ Meeting     │
       └────────────────────────────┴─────────────┘
              +Z  (camera side)
```

**Cast (14):**
- **Singletons** — Milena (PM, at whiteboard), Ricardo (orchestrator, at
  supervisor desk with the attention tray).
- **Dev pool (4)** — Bob / Carol / Dave / Eve at desks 0–3.
- **Reviewer pool (4)** — Frank / Joseph / Sonia / Manuel at desks 4–7.
- **Tester pool (4)** — Nadia / Olaf / Priya / Quinn at desks 8–11.

Presence (`offstage` / `entering` / `onstage` / `leaving`) gates mesh
visibility and overlay rendering — offstage characters return `null`
entirely from `<Character>` so they cost nothing.

---

## 4. Data flow

```
      DDB (futurator-*) ──────► /api/* Lambda (Hono)
                                      │
                                      ▼
       ┌──────── TanStack Query hooks (src/hooks/**) ───────┐
       │  usePublishedApps   useEpicWorkflow    useAgentJob │
       │  useAgentEvents     useAggregatedAttention         │
       │  usePlansList       useEc2Status                   │
       └───────────────────────────┬────────────────────────┘
                                   │ React state
                                   ▼
                ┌──────── EpicTracker (one per active epic) ───────┐
                │  • reconcileOrchestratorFromStories              │
                │  • updateKanban(epic, stories, planId)            │
                │  • Milena chat bubbles on story transitions      │
                │  • Mounts StoryTracker per running story         │
                └───────────────────────────┬──────────────────────┘
                                            ▼
                ┌──────── StoryTracker ────────┐
                │  translateEvent  per AgentEvent       │
                │  → enqueueAction into useOfficeStore  │
                │  setStoryRetry on job.retryAfter      │
                └────────────────┬──────────────────────┘
                                 ▼
                ┌──── useOfficeStore (Zustand) ────┐
                │  runtimes, assignments, actionQueue,
                │  bubbles, kanbanStories, orchestrator
                │  scene state, UX flags           │
                └─────────────┬────────────────────┘
                              ▼
                  ┌─── Canvas (r3f) ───┐
                  │  ActionProcessor   │  (useFrame — drains actionQueue)
                  │  Character x N     │  (useFrame — walks toward targets)
                  │  Workstation x 12  │  (Monitor useFrame content tick)
                  │  AttentionTray     │  (useFrame — pulse)
                  │  ProxyBoards x 3   │  (useFrame — LED breathing)
                  │  RetryHourglass    │  (1s setInterval for countdown)
                  │  FailureBadge      │  (useFrame — pulse)
                  └────────────────────┘
```

**Event pipeline** — the critical hot path:
1. `/agent-jobs/:id/events?after=seq` polled every 1000 ms while the job is
   active (`src/hooks/use-agent-events.ts`).
2. New events flow into `translateEvent(event, ctx)` which emits
   `OfficeAction` objects.
3. Actions enqueue into `useOfficeStore.actionQueue`.
4. `<ActionProcessor>` drains up to **10 actions per frame** inside the
   Canvas `useFrame` loop, pushing bubbles and retargeting personas.
5. `pruneBubbles()` runs every 500 ms to retire expired tier-specific
   bubbles.

---

## 5. Scene components

| Component | File | Cost pattern |
| --- | --- | --- |
| `Character` | `scene/character.tsx` | 1 GLTF clone + `AnimationMixer` + `useFrame` per persona |
| `Workstations` | `scene/furniture.tsx` | 12 × (chair GLTF + desk GLTF + procedural monitor mesh + optional `PlanFlag`) |
| `Monitor` | `scene/furniture.tsx` + `scene/monitors.tsx` | per-role `Content` component (Dev/Reviewer/Tester/Matrix/PM) — each subscribes one `useFrame` |
| `SpeechBubble` | `scene/speech-bubble.tsx` | Billboard → 3 planes + drei Text per bubble |
| `AttentionTray` | `scene/attention-tray.tsx` | Box + pulsing additive plane; `useFrame` for alpha lerp |
| `RetryHourglass` | `scene/retry-hourglass.tsx` | Billboard + 2 Text; 1-second `setInterval` + `useFrame` for bob |
| `FailureBadge` | `scene/failure-badge.tsx` | Billboard + 2 planes + 2 Text; `useFrame` for pulse |
| `EC2ProxyBoard` / `GanttProxyBoard` / `PlansProxyBoard` | `scene/proxy-boards.tsx` | Flat panels + data-driven child meshes; click opens 2-D modal |
| `Decorators` | `scene/decorators.tsx` | Orchestrator-intent meshes: wave bands, blocker cards, terminal-fail ribbons |
| `Rooms`, `RoomProps`, `RoomScreens` | `scene/rooms.tsx`, `decor.tsx` | Static geometry; walls, floors, wall-mounted boards (Gantt, KG, git, constellation) |

---

## 6. Persistence boundaries

- **Never** on disk in the browser. Office state is entirely server-
  derived (DDB) plus ephemeral Zustand UX flags. A refresh reloads
  from DDB via the hooks above.
- Zustand has no middleware — no localStorage, no devtools wiring.
- TanStack Query keeps its default in-memory cache (no persister).

---

## 7. Performance — a 15-worker × 3-plan scenario

Goal: the user opens the office with **3 active plans**, each with ~5
stories in flight — totalling **15 concurrent Claude subprocesses**
across devs / reviewers / testers. This is the realistic upper bound
given pool capacity (4 + 4 + 4 = 12 pool slots plus Milena/Ricardo, so
~14 characters onstage plus some queued).

### 7.1 What the browser does each frame

At 60 fps the Canvas has **16.67 ms** per frame. Per-frame work:

| Work | Per-frame cost at 14 onstage characters |
| --- | --- |
| 14× skeletal `AnimationMixer.update(dt)` | ~0.8 ms (30 bones × quaternion slerp each) |
| 14× position / rotation interpolation + clip switching (`Character.useFrame`) | ~0.3 ms |
| 14× `computePath` runs (only on target change — rare) | ≈ 0 ms steady state |
| 12× `Monitor` useFrame (DevContent, ReviewerContent, TesterContent, MatrixContent, PMContent) | ~1.5 ms combined; matrix + dev are the heaviest (per-glyph `planeGeometry` scale writes) |
| 1× `AttentionTray` useFrame (alpha lerp) | <0.05 ms |
| 3× `LED` useFrame on EC2 board (scale sphere) | <0.1 ms |
| 0–14× `RetryHourglass` useFrame (bob) | <0.2 ms |
| 0–14× `FailureBadge` useFrame (pulse) | <0.2 ms |
| `ActionProcessor.useFrame` — drain up to 10 actions | ~0.1 ms typical |
| Draw pass — ~250+ meshes, ~400+ triangles-per-mesh avg, shadow pass | **4–6 ms** (dominant cost) |

Total expected: **7–9 ms on an M1**, ~**12–14 ms on an Intel i5 laptop**.
60 fps is achievable but tight on low-end hardware; 45 fps is the
practical floor.

### 7.2 What the browser does each second (async work)

Polling fan-out at 15 active stories × 3 plans:

| Hook | Interval | Instances at peak |
| --- | --- | --- |
| `/apps` | 5 000 ms | 1 |
| `useEpicWorkflow(epicId)` per active epic | variable (≤ 5 s while running) | 3–9 (one per epic) |
| `useAgentJob(jobId)` | 1 000 ms while job is RUNNING | 15 running stories + ≤3 QA/PO/Deploy bridges |
| `useAgentEvents(jobId)` | 1 000 ms while job is RUNNING | 15 |
| `usePlansList` | 5 000 ms active / 20 000 ms idle | 1 |
| `useEc2Status` | 5 000 ms | 1 |
| `useAggregatedAttention(planIds)` | 10 000 ms per plan | 3 |

**Peak fan-out:** ~35 HTTP requests per second at the **absolute worst**
(all 15 stories hitting both hooks on the same tick). TanStack Query
batches identical query keys and dedupes, so effective requests are
lower — but this is where the biggest win sits if we slow the poll.

### 7.3 Memory

- GLTF cache: 10 CharacterKind meshes × ~1.5 MB each ≈ 15 MB.
- Furniture GLTFs: ~8 MB total.
- Three.js scene graph with 14 animated skeletons + 12 workstations
  + decor: ~40 MB live RAM before tabs start eating.
- Event store: `actionQueue` capped at 400, `bubbles` at 3 per persona
  (14 × 3 = 42 max), `eventLog` at 200. Bounded and trimmed on push.
- TanStack Query cache holds last ~60 query results (events, jobs, epic
  workflows). Each event payload is small (bytes to low-KB per event).

---

## 8. Heavy lifting — what the browser actually struggles with

Ranked by likely cost on mid-tier hardware, biggest first.

### 8.1 Draw calls + shadow pass

**Root cause:** each workstation is *not* instanced. 12 identical desks
+ chairs + monitors = ~36 individual `Prop` + `<boxGeometry>` meshes, and
the directional light casts shadows for most of them. Each mesh triggers
a separate draw call; the shadow pass doubles that (rendered from the
light's POV onto a 2048×2048 shadow map).

**Typical cost:** 4–6 ms per frame, single largest contributor.

### 8.2 Monitor content per-frame reflows

**Root cause:** `DevContent` renders 12 `planeGeometry` lines with
per-frame `m.scale.x` + `m.position.x` writes via `useFrame`.
`ReviewerContent` and `TesterContent` do per-row colour mutation.
`MatrixContent` has 9 × 12 = **108 Text glyphs** with per-frame position
updates. All of these are authored as React components re-running at
60 Hz even though the visual change rate is ≤ 10 Hz.

**Typical cost:** ~1.5 ms summed across all workstations. MatrixContent
alone is ~0.6 ms on M1.

### 8.3 Skeletal animation + GPU skinning

**Root cause:** 14 independent skeletons (SkeletonUtils.clone is required
per instance) × ~30 bones × Quaternius animations looping. CPU computes
bone matrices each frame; GPU skins ~1 K vertices per character.

**Typical cost:** ~1 ms on M1. Scales linearly with characters —
doubles if we go to 28 personas in a future expansion.

### 8.4 Polling fan-out

**Root cause:** 15 × `useAgentJob` + 15 × `useAgentEvents` at 1 s
intervals. Even with dedupe and `staleTime`, the browser makes a
burst of requests every second, each triggering JSON parse + React
state update + re-render of the subscribing tree (`StoryTracker`).

**Typical cost:** 2–6 ms of **main-thread** time per tick (during the
burst, not every frame) — enough to drop a frame during the burst
on a laptop under load.

### 8.5 DOM overlays under the Canvas

**Root cause:** Tailwind + React overlays (Kanban, CharacterPanel,
EventLog, AttentionPanel, BoardModal). These don't compete with the
canvas but do re-render on every store change that touches their
selector. The EventLog in particular mounts `MAX_LOG = 200` rows and
re-renders on every new event.

**Typical cost:** 0.3–1 ms per push (one push per event, once per
second per active story ≈ 15 Hz).

### 8.6 Speech-bubble churn

**Root cause:** every bubble is 4 meshes (shadow, body, stripe, Text).
Text (drei) is SDF-based — first mount is expensive (~1 ms for glyph
atlas warm-up), subsequent updates are cheap. Short bubbles (thought,
4 s TTL) churn at ~1–2 Hz per active persona; at 14 active personas
that's ~20 bubble create/destroys per second.

**Typical cost:** 0.5–1 ms intermittent, spikes on bursty tool_use
sequences.

---

## 9. Performance proposals

Ordered by effort-to-impact ratio (biggest win for lowest risk first).

### 9.1 Instanced workstations (biggest win)

All 12 desks use identical GLTF geometry. Replace 12 × `<Prop
url={CHAIR_URL}/>` + `<Prop url={DESK_URL}/>` with **one `InstancedMesh`
per shared geometry** (one for all 12 chairs, one for all 12 desks).
Drops ~24 draw calls → 2. Shadow pass also collapses.

Est. gain: **1.5–2.5 ms/frame** on mid-tier, no visual regression.

Caveat: the procedural monitor mesh (`boxGeometry` housing + screen +
stem) can't trivially be instanced because each monitor shows different
content. Leave those as-is for now.

### 9.2 Throttle monitor content to 10 Hz

Gate `DevContent` / `ReviewerContent` / `MatrixContent` / `TesterContent`
/ `PMContent` useFrame callbacks with a per-component "tick every Nth
frame" guard (or `useFrame` with a `dt` accumulator that advances the
content only every 100 ms). Visual effect is indistinguishable — these
are all ambient animations, nobody reads the matrix glyphs at 60 Hz.

Est. gain: **0.8–1.2 ms/frame**. Zero visual regression.

### 9.3 Poll backoff (Epic F.5, still open)

`useAgentJob` at 1 s never slows down. The design doc calls for
2 s → 10 s when no event in last 30 s. Implement it. Same for
`useAgentEvents`.

Est. gain: reduces steady-state request rate by **~60 %** at idle
(most stories spend long stretches waiting for Claude). Frees
main-thread bursts.

### 9.4 Shadow map tuning

Current `shadow-mapSize-width: 2048` and a generous frustum. For the
isometric camera's fixed angle, we don't need 2048 — 1024 is
indistinguishable. Also tighten `shadow-camera` bounds to the actual
scene extents (main office ~24 m × 24 m, not the current -20..30).

Est. gain: **0.5–1 ms** on the shadow pass (GPU-side), and **½** the
shadow-map memory.

### 9.5 Disable shadows on transient overlays

`AttentionTray`, `RetryHourglass`, `FailureBadge`, `SpeechBubble`,
`PlanFlag` — none of these need `castShadow`. Confirm the default is
`false` and explicitly set `castShadow={false}` / `receiveShadow={false}`
on all billboard-region meshes. The rim-light pulse mesh in particular
currently drops a shadow blob on the supervisor desk.

Est. gain: **0.2–0.5 ms** on the shadow pass. Actually *improves*
visual quality (no weird pulsing shadow flicker).

### 9.6 Pool SpeechBubble meshes

Rather than create/destroy mesh + material + Text on every bubble push,
keep a fixed pool of 6 SpeechBubble instances per character and recycle
them (show/hide + update text). This trades one-time allocation for
zero-alloc steady state.

Est. gain: GC-pause elimination during bursty tool_use sequences.
Smooth frame pacing, not raw fps.

### 9.7 Lazy-mount StoryTracker by kanban filter (Epic F.2 deepened)

Today, when the kanban filter is non-empty, `EpicTracker` early-returns
`null`, which unmounts StoryTrackers (✓). But `useAgentJob` polling
still runs inside `StoryTracker` when it IS mounted. If we additionally
filter to **only mount trackers for stories whose kanban card is
visible in the current column**, polling scales with what the user is
looking at, not the whole portfolio.

Est. gain: at 15 active stories with a 2-plan filter, cuts polling
~1/3.

### 9.8 Frustum-cull character meshes when offstage

`<Character>` already returns `null` at `presence === 'offstage'`
(✓). What it does NOT do is skip animation-mixer updates when the
character is onstage-but-fully-off-camera (e.g., scrolled out of view).
Add `if (!g.matrixWorld && isInFrustum(g)) mixer.update()` gate.

Est. gain: 0.2–0.5 ms/frame, mostly helpful when a future larger scene
would need to scale.

### 9.9 Defer GLTF decode / Draco

Characters load via plain glTF. Converting to `.glb` + Draco
compression would cut 60–80 % of the download size. First-load
perceived perf only — steady-state frame cost is identical.

Est. gain: **faster cold load** (~200 KB saved × 10 models = ~2 MB off
the wire), no frame-cost change.

### 9.10 Drop `dpr={[1, 2]}` to `[1, 1.5]`

Canvas currently renders up to 2× DPR on retina. For an isometric
ortho camera with simple procedural art, 1.5× is the sweet spot —
4:1 pixel count vs DPR=1 is overkill.

Est. gain: **1–3 ms/frame on retina screens**. Marginal visual
degradation (slight aliasing on character outlines).

---

## 10. Quick wins summary

| Change | Effort | Frame-time saved | Visual impact |
| --- | --- | --- | --- |
| Instanced desks + chairs (§9.1) | 1 day | 1.5–2.5 ms | none |
| Monitor content @ 10 Hz (§9.2) | 2 hours | 0.8–1.2 ms | none |
| Shadow map 2048 → 1024 + tighter frustum (§9.4) | 1 hour | 0.5–1 ms | negligible |
| `castShadow={false}` on overlays (§9.5) | 30 min | 0.2–0.5 ms | positive |
| DPR cap 2 → 1.5 (§9.10) | 5 min | 1–3 ms on retina | mild aliasing |
| Poll backoff (§9.3) | 4 hours | not frame — bursty main-thread | none |

Sum if all ship: **3.5–6 ms/frame on retina M1**, **2–4 ms/frame on
Intel i5**. Enough headroom to absorb a future bump to 20+ concurrent
workers without dropping below 60 fps.

---

## 11. Known limits (do not deep-end here)

- **Max onstage cast = 14.** Past that, pool capacity is the bottleneck,
  not the scene.
- **Single orthographic camera, fixed zoom range.** No mini-map, no
  character-follow, no interior walk-through. Deliberate — this is a
  dashboard not a game.
- **No server-side rendering of the Canvas.** The office must hydrate
  on the client. On a cold deploy the first paint is empty for ~500 ms
  while GLTFs decode.
- **DDB is the single source of truth.** Anything the office shows
  must already be in a repository. We don't add office-only state.

---

## 12. Related docs

- **Epic history / decisions:** `docs/concepts/agentic-office-enhancements-epics-a-f.md`
- **Pipeline contract (jobs, retries, attention items):** `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md`
- **Memory:** `/Users/ricardoarayafarias/.claude/projects/-Users-ricardoarayafarias-GetReal-Futurator-Admin/memory/project_agentic_office.md`
