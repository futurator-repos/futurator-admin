# Agentic Office — Enhancements (Epics A–F) Concept Doc

**Audience:** another agent working on the agentic office module (`src/components/agentic-office/**`).
**Dated:** 2026-04-23.
**Scope:** surfaces Pipeline Enhancement v2 (Phases A–C) features in the 3D office, adds multi-plan visual language, and hardens performance. Companion to `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md`.

This doc captures the decisions locked in the party-mode design session. It is the single source of truth for scope/boundaries/invariants during execution.

---

## 1. Decisions at a glance

| Area | Decision |
| --- | --- |
| TEST-agent representation | New `tester` pool, 4 named characters (Nadia, Olaf, Priya, Quinn), spawn/despawn per active terminal — matches existing dev/reviewer pool model |
| PM + Orchestrator | Stay portfolio-wide singletons (Milena, Ricardo). One of each, regardless of active plan count |
| Attention inbox in scene | Red tray mesh on Ricardo's supervisor desk. `3/7` dual display (filtered / portfolio). Clickable → opens existing `attention-dock.tsx`. Ricardo points once on critical onset — no repeat |
| Retry ladder visual | Hourglass sprite over dev desk with countdown from `job.retryAfter`. Persona walks to coffee station (reuse `drinking` clip). Story card orange border at attempt 2, red at attempt 3. Terminal fail → defeat clip + leave |
| Multi-plan color | Curated 8-color palette hashed by `planId`. Tints chair cushion, desk tag, chat-bubble border, kanban filter chips. Single source of truth (`plan-palette.ts`) |
| In-scene boards | **3 low-fi proxies** (EC2, Gantt, Plans) with status lights + click to open **2D modal overlays** that mount existing `/development/monitor` and `agent-roadmap-gantt` React components. **NO iframes.** Canvas pauses (`frameloop="demand"`) while modal open |
| Chat bubbles | 4 tiers: `thought` / `action` / `milestone` / `blocker`. DOM pool of 6, coalesce identical within 2s. `blocker` retires to persistent red desk ring after 60s |
| Performance | Baseline profile before Epic A. Kanban-filter-gated `EpicTracker` mount. GLTF lazy-load. Poll backoff (per-epic 10s→30s idle, per-story 2s→10s idle). `frameloop="demand"` |

---

## 2. Cast additions

```
PM (singleton):           Milena — whiteboard-0
Orchestrator (singleton): Ricardo — supervisor-0 (red tray attached)
Dev pool (4, UNCHANGED):  Bob, Carol, Dave, Eve — desk 0..3
Reviewer pool (4, UNCHANGED): Frank, Joseph, Sonia, Manuel — desk 4..7
Tester pool (4, NEW):     Nadia, Olaf, Priya, Quinn — desk 8..11 (lab-coat tint)
```

**Seating layout:** tester desks sit between dev row (0..3) and reviewer row (4..7) in the office, reflecting pipeline flow dev → test → review. Reuse the existing desk GLTF — **no new furniture asset**. Lab-coat tint = shirt color override + small clipboard prop on the desk.

---

## 3. Epic breakdown

### Epic A — Tester Pool (foundational)

Unblocks Phase C TEST agent visualization. 5 stories.

- **A.1** Extend `PersonaRole` union (+`'tester'`), `CharacterId` union (+4 IDs), add 4 persona entries to `CAST`.
- **A.2** Add `TEST_POOL` + `MAX_TESTER_CAPACITY` exports. Extend `useOfficeStore.assignStory()` to accept `tester` role and pull from pool (same pattern as dev/reviewer).
- **A.3** Add desk slots 8..11 in `scene/constants.ts` with positions between rows 0..3 and 4..7. Render 4 extra desks with lab-coat tint in `scene/furniture.tsx`.
- **A.4** Extend `story-tracker.tsx:22` `roleFromStep()` — return `'tester'` when `agentId === 'TEST'`. Testers return directly home on step advance (skip couch detour — test steps are short).
- **A.5** Extend `event-translator.ts` — add TEST branch in `step_start`/`step_complete`/`tool_use`. Copy: `Writing tests...`, `Checking tests pass...`, `Scanning for tamper...`.

**Daemon contract — no change needed.** Pipeline already emits `agentId: 'TEST'` on test-author/test-verify/tamper-check steps (`functions/shared/pipelines/story-pipeline.ts:88, 218, 237`). Office just reads the step's `agentId`.

**AC:** When a story runs a TEST step, a tester persona spawns at an available desk; pool exhaustion queues the story; step advance releases tester and picks up dev/reviewer correctly.

### Epic B — Attention Tray + Retry Visuals

Surfaces Phase A.3 (retries) + Phase B (attention inbox). ~7 stories.

- **B.1** Attention tray mesh on supervisor-0 desk (reuse box geometry, new material).
- **B.2** Rim-light shader with **shared clock** driving pulse (none / amber / red-slow / red-fast).
- **B.3** Aggregate `useAttentionItems(planId)` across kanban-filtered plans (uses the existing multi-plan filter). Render `filtered/portfolio` counter.
- **B.4** `onPointerDown` on tray → open existing `attention-dock.tsx`. Ricardo "point once" on critical-onset (existing clip).
- **B.5** Hourglass sprite + countdown above dev desk from `job.retryAfter`. Verify `useAgentJob` surfaces `retryAfter` — if not, Lambda response shape fix first.
- **B.6** Attempt dots on kanban card (1/2/3). Story card orange border at attempt 2, red at attempt 3.
- **B.7** Retry-wait behavior: persona walks to coffee, `drinking` clip, returns. Terminal fail → defeat + leave stage.

**AC:** Unresolved attention items reflect in tray glow + count within 10s. Clicking opens dock. Retries animate: hourglass + coffee walk. Exhaustion = defeat clip + kanban reddens.

### Epic C — Multi-plan Color System

Makes parallel-plan execution legible. 3 stories.

- **C.1** New file `src/components/agentic-office/plan-palette.ts`: 8-color curated palette (Tailwind accent-ramp), `hashPlanIdToPaletteIndex(planId)` deterministic. Unit-tested.
- **C.2** Extend `StoryAssignment` with `planColor` captured at assign time. Cushion mesh + desk tag mesh read `planColor` from assignment. Update on re-assignment (persona reused across plans in one session).
- **C.3** Align `kanban-board.tsx` chip colors to the shared palette.

**AC:** Two+ active plans show distinct colors on desks and bubbles; colors consistent between kanban chips and in-scene tints.

### Epic D — Proxy Boards + 2D Modals

Low-fi in-scene signal + rich 2D detail on click. ~5 stories.

- **D.1** EC2 proxy board (wall near entrance): 3 LED meshes (daemon/api/DB), text "N jobs running".
- **D.2** Gantt proxy (by whiteboard): wave-columns via flat meshes.
- **D.3** Plans proxy (by entrance): stacked cards per active plan, rigor badge per card (prototype/mvp/production icon), cushion-matching color.
- **D.4** 2D modal components that mount existing `/development/monitor` and `agent-roadmap-gantt` React trees. **No iframes. Component re-use, not URL re-use.**
- **D.5** Modal mount triggers `frameloop="demand"` on the office canvas.

**D.4 risk:** extracted components must not call `useRouter` or route-level side effects. Refactor first if needed.

**AC:** Three proxy boards live; click opens 2D modal with real data; canvas FPS recovers to modal's benefit while modal is open.

### Epic E — Bubble Tiering + DOM Pool

Chat bubble scalability + tiering. ~4 stories.

- **E.1** DOM pool of 6 reusable bubble nodes (`chat-bubble-pool.tsx`).
- **E.2** Four tiers — `thought` / `action` / `milestone` / `blocker` — each with lifecycle + style.
- **E.3** Tool-type dot icons in `action` tier (green=Read, orange=Edit, red=Bash, blue=Write).
- **E.4** Identical-content coalescing within 2s; 60s `blocker` cap → hand off to persistent red desk ring.
- **E.5** Plan-color border from Epic C. (Depends on C.1+C.2.)

**AC:** Max 6 bubbles on-screen at any time; blockers promote to desk ring after 60s; all tiers respect plan color.

### Epic F — Perf Hardening + Lazy Load

Runs concurrent with all others. ~6 stories.

- **F.1** Baseline profile report committed at `docs/agentic-office-perf-baseline.md` — FPS / draw calls / polling fan-out at 4-active-plan scenario. Done BEFORE Epic A merges.
- **F.2** Gate `EpicTracker` mount on current kanban filter (empty filter = all, but warn at >3 plans with no filter).
- **F.3** Reconcile-on-mount for trackers that mount mid-flight (already exists at `epic-tracker.tsx:25` — verify it handles "story already running when tracker first mounts"). Integration test required.
- **F.4** GLTF lazy-load: tester meshes fetched only on first TEST step.
- **F.5** Event-poll backoff: per-epic 10s → 30s when idle >60s, per-story 2s → 10s when idle >30s.
- **F.6** `frameloop="demand"` globally + invalidate on state change only. `useAgentEvents` throttled at 500ms coalesce.

**AC:** Baseline FPS ≥ 60 on M1 MacBook, ≥ 45 on Intel i5 laptop at 4 active plans. Polling fan-out reduced ≥ 60% at idle. No tester GLTF fetched until first TEST step observed.

---

## 4. Ship order + dependency graph

```
A (tester pool) ─┬──> B (attention + retry) ────┐
                 │                                ├──> E (bubble tiers, needs planColor from C)
                 └──> C (plan colors) ────────────┤
                                                  ├──> F (perf hardening, finalizer)
                      D (proxy boards + modals) ──┘
```

**First wave (parallel):** A + C. Independent scope, both touch type system.
**Second wave:** B (needs A). D ships whenever.
**Third wave:** E (needs C).
**Concurrent throughout:** F. Baseline profile before A merges.

---

## 5. Invariants to preserve

1. **Persona = active terminal.** Spawn/despawn lifecycle matches Claude subprocess lifecycle, driven by existing `subagent_dispatch`/`subagent_return` orchestrator events for dev/reviewer AND by per-story `agentId` step transitions for TEST. Never fake a spawn.
2. **Milena and Ricardo stay portfolio singletons.** Do not pool them.
3. **Pipeline `agentId: 'TEST'` is the contract.** If the pipeline refactors to rename TEST → something else, `story-tracker.tsx` `roleFromStep()` and `event-translator.ts` branches must update in lockstep.
4. **No iframes inside WebGL overlays.** For any external view (Gantt, EC2 monitor), mount the React component directly in a 2D modal.
5. **No new GLTF assets beyond what's in `/models/universal-gltf`.** Lab-coat tint = material color swap. Hourglass = geometry + material only. Tray = box geometry.
6. **Pool DOM bubbles.** Never create/destroy on every bubble event.
7. **Compositor-only properties.** All badge/aura/glow animations use `transform` + `opacity` + material color. No layout thrash.
8. **Filter-gate tracker mounts.** Out-of-filter plans do not mount `EpicTracker`. Reconcile on remount.

---

## 6. Known deferred / future work

- **Dedicated persistent desk ring geometry** for long-lived blockers beyond 60s (Epic E.4) — reuse a torus instanced on demand.
- **Rigor badges on persona avatars** — currently only on plan proxy cards (Epic D.3). Could propagate to each persona's desk tag in a future polish pass.
- **Per-plan portfolio zoning** — rejected in design (would fragment the metaphor). Revisit only if plan count regularly exceeds 5 concurrent.
- **Office ambient audio** (chair squeak on spawn, distant keyboard clatter) — deferred entirely; purely additive if requested later.
- **Orchestrator dispatch for testers** — current plan uses per-story `agentId` transitions. If the orchestrator later dispatches test subagents in parallel (outside the per-story pipeline), the translator needs a `role: 'tester'` branch in `translateOrchestratorIntent` — currently unimplemented.

---

## 7. Where things live (post-implementation)

| Concern | Path |
| --- | --- |
| Cast + pools (incl. testers) | `src/components/agentic-office/cast.ts` |
| Type system (roles, IDs, assignments) | `src/components/agentic-office/types.ts` |
| Office state store | `src/components/agentic-office/store.ts` |
| Scene constants (seat poses, incl. desks 8..11) | `src/components/agentic-office/scene/constants.ts` |
| Furniture (incl. tester desks + tray + hourglass) | `src/components/agentic-office/scene/furniture.tsx` |
| Per-story tracker (role routing) | `src/components/agentic-office/trackers/story-tracker.tsx` |
| Event translator (TEST + tier) | `src/components/agentic-office/event-translator.ts` |
| Plan palette + hash | `src/components/agentic-office/plan-palette.ts` (NEW) |
| Chat bubble DOM pool | `src/components/agentic-office/overlays/chat-bubble-pool.tsx` (NEW) |
| Attention tray mesh | `src/components/agentic-office/scene/attention-tray.tsx` (NEW) |
| Proxy boards | `src/components/agentic-office/scene/proxy-boards.tsx` (NEW) |
| 2D modal overlay | `src/components/agentic-office/overlays/board-modal.tsx` (NEW) |
| Perf baseline report | `docs/agentic-office-perf-baseline.md` (NEW, Epic F.1) |

---

## 8. Related docs

- **Pipeline contract:** `docs/concepts/pipeline-enhancement-phases-a-c-handoff.md`
- **Pipeline design notes:** `docs/concepts/pipeline-enhancement-plan-v2.md`
- **Agentic office module memory:** `/Users/ricardoarayafarias/.claude/projects/-Users-ricardoarayafarias-GetReal-Futurator-Admin/memory/project_agentic_office.md`
