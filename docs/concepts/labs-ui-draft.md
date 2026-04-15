# Labs UI — Current State Draft

Reference document for brainstorming UX/UI improvements to the Labs module.

---

## Page Structure (top to bottom)

### 1. Page Header

```
Labs                    [Daemon status] [Runtime toggle] [EC2 state]
```

- **Title:** "Labs" (page-title style)
- **Daemon status:** Red/green dot + "Daemon running" or "Daemon offline" + shell command hint to start locally
- **Runtime toggle:** Pill button "EC2" (blue when active) or "Local"
- **EC2 state:** "running" / "stopped" / "starting" text next to the toggle

**Issues:**

- The daemon command hint (`run cd daemon && node agent-daemon.mjs`) is developer-facing, not user-friendly
- EC2 status is text-only, no visual distinction between states
- No obvious way to start/stop EC2 from this header

---

### 2. Tab Bar

```
[Agentic Workflow]  [Claude Code Pipeline]
```

- Two tabs; only "Agentic Workflow" is fully built
- "Claude Code Pipeline" is a separate, older experiment
- No visual indicator of which tab has active work

---

### 3. Your Projects (grid)

```
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Tron Hunter —... │ │ Guess the Number │ │ Guess the Number │
│ spyhunter        │ │ guess-the-number │ │ guess-the-number │
│ ████████████ 9/9 │ │ ████████████ 7/7 │ │                  │
│         Completed│ │         Completed│ │            Draft │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

- **Layout:** 3-column responsive grid of project cards
- **Each card shows:**
  - Title (truncated if long)
  - App name (monospace, grey)
  - Progress bar (green fill)
  - Story count (e.g., "9/9 stories")
  - Status badge: Draft / Ready / In Progress / Completed / Deployed
  - Deploy URL (if deployed, blue text)
- **Active card:** Highlighted border (primary color)
- **"+ New Project" button:** Top-right of section
- **Click action:** Loads that project's full details below

**Issues:**

- Duplicate project names visible (multiple "Guess the Number" drafts from failed PM attempts)
- No way to delete or archive old/failed projects
- No creation date shown — hard to tell which is which
- No search or filter
- Cards are small — title truncation loses important info
- No distinction between "never started" and "PM failed to generate stories"

---

### 4. New Project Creation (shown when no project selected or "+ New Project" clicked)

#### 4a. Config Bar

```
┌─────────────────────────────────────────────────────────────────┐
│ App Name: [_______________]  Dev Model [▼] Dev Effort [▼]      │
│ /home/ubuntu/projects/app-name → futurator.ai/apps/app-name/   │
│                                  Reviewer Model [▼]  YOLO [○]  │
└─────────────────────────────────────────────────────────────────┘
```

- **App Name:** Text input, auto-derives working directory + deploy URL
- **Model selectors:** Dev Model (Default/Opus/Sonnet/Haiku), Reviewer Model
- **Effort selectors:** Dev Effort, Reviewer Effort (Default/Low/Medium/High)
- **YOLO toggle:** Green pill when active
- Shows derived paths below the input

**Issues:**

- "App Name" field doesn't validate (spaces, special chars could break paths)
- Model/effort dropdowns are small, labels are abbreviated
- No explanation of what YOLO means for new users
- Config bar disappears when viewing an existing project — can't change models mid-project

#### 4b. Product Manager Agent

```
┌─────────────────────────────────────────────────────────────────┐
│ Product Manager Agent                                           │
│ [textarea: Describe your product idea...]                       │
│ [Generate Epic]                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Textarea:** Free-form product idea input (3 rows)
- **"Generate Epic" button:** Triggers PM agent job
- **Loading state:** Button shows "PM is thinking..."
- **PM Working card:** Appears below while generating, shows live agent actions
- **Error state:** Red card with error message + auth help text + Retry button

**Issues:**

- No examples or templates for product ideas
- No indication of what makes a "good" idea description
- PM agent output can take 30-60 seconds — no progress indicator beyond "thinking..."
- Can't cancel a running PM job

#### 4c. Generated Epic Preview

```
┌─────────────────────────────────────────────────────────────────┐
│ Guess the Number Game         7 stories · 4 waves               │
│                                          [Start Development]    │
│ Description text...                                             │
│                                                                 │
│ WAVE 0                                                          │
│ ┌─────────────────────┐                                         │
│ │ S1: Scaffold & Types│                                         │
│ └─────────────────────┘                                         │
│ ↓                                                               │
│ WAVE 1 (5 parallel)                                             │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│ │ S2: ... │ │ S3: ... │ │ S4: ... │ │ S5: ... │ │ S7: ... │   │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│ ↓                                                               │
│ WAVE 2                                                          │
│ ┌──────────────────┐                                            │
│ │ S6: Win State    │ depends: S2, S3, S4                        │
│ └──────────────────┘                                            │
│                                                                 │
│ ▶ Epic XML Source (collapsible)                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Header:** Epic title + story/wave counts + green "Start Development" button
- **Description:** 2-3 sentence epic summary
- **Wave visualization:** Grouped cards with wave labels, dependency arrows (↓), parallel count
- **Story cards in waves:** Show ID, short title, dependencies
- **XML source:** Collapsible raw XML view

**Issues:**

- Stories are not editable before starting development
- No way to add/remove/reorder stories
- No way to re-generate if the PM got it wrong (have to create a whole new project)
- Wave visualization disappears once development starts
- Dependencies only shown as text ("depends: S2, S3") — no visual lines/arrows

---

### 5. Active Project View (shown when a project is selected)

#### 5a. Epic Header

```
┌─────────────────────────────────────────────────────────────────┐
│ Tron Hunter — 2D Arcade Racer    9/9 stories  3 waves           │
│                                  COMPLETED  YOLO [●] [New Epic] │
│ ████████████████████████████████████████████████████████ 100%    │
│ Description text...                                             │
└─────────────────────────────────────────────────────────────────┘
```

- **Title + stats:** Story count, wave count, status badge
- **YOLO toggle:** Live toggle, can be activated/deactivated during development
- **Progress bar:** Green fill proportional to completed stories
- **"New Epic" button:** Returns to project creation view
- **Description:** Epic description text

#### 5b. Epic Actions & Info Panel

```
┌─────────────────────────────────────────────────────────────────┐
│ Epic Actions & Info                                             │
│ Working directory: /home/ubuntu/projects/spyhunter              │
│ Test command: cd /home/ubuntu/projects/spyhunter && npm run dev │
│                                                                 │
│ ┌─── Dev Server ──────────────────────────────── [Start] ──┐   │
│ │ Running  http://54.86.226.233:5176  PID: 3050            │   │
│ │ Server is running in background. To stop: kill 3050      │   │
│ └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│ ┌─── Product Owner Review ────────────────────── [Run PO] ──┐  │
│ │ PASS  $0.1887  73.628s                                     │  │
│ │ ▶ Full PO Report (collapsible)                             │  │
│ └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│ ┌─── Publish to Web ──────────────────────────── [Publish] ──┐ │
│ │ Published  https://futurator.ai/apps/spyhunter/            │ │
│ │ Shareable link — anyone can access this URL                │ │
│ └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

- **Working directory:** Monospace code display
- **Test command:** Copy button
- **Dev Server section:** Start button, URL (auto-replaced with public IP), PID, kill instruction
- **PO Review section:** Run button, verdict badge, cost, duration, expandable report
- **Publish section:** Publish/Redeploy button, shareable URL, status

**Issues:**

- Dev server URL uses raw IP — not friendly
- "kill 3050" instruction is developer-facing
- No "Stop Dev Server" button — manual kill only
- PO Review shows "No verdict" when agent uses markdown bold in output (fixed in code, still visible in old runs)
- Publish section doesn't show deployment progress while running

#### 5c. Story List (grouped by wave)

```
WAVE 0 — 1/1  ████████████████████ 100%
┌─────────────────────────────────────────────────────────────────┐
│ ● Story 1 — Scaffold & Core Types           SONNET  1m 33s DONE│
│   ▶ Dev Summary (collapsible)                                   │
│   ▶ Reviewer Feedback (collapsible)                             │
│   ▶ Event Log (12 tools, 2 extractions, 0 validations)         │
│   ▶ Story Description (collapsible)                             │
└─────────────────────────────────────────────────────────────────┘

WAVE 1 — 5/5 (5 parallel)  ████████████████████ 100%
┌──────────────────────────────────────────────────────────────┐
│ ● Story 2 — GuessInput Component  ← S0    SONNET  45s  DONE │
│ ● Story 3 — FeedbackMessage       ← S0    SONNET  38s  DONE │
│ ● Story 4 — GuessList Component   ← S0    SONNET  52s  DONE │
│ ● Story 5 — DifficultySelector    ← S0    SONNET  41s  DONE │
│ ● Story 7 — ScoreBoard Component  ← S0    SONNET  47s  DONE │
└──────────────────────────────────────────────────────────────┘
```

- **Wave header:** Wave number, completion count, parallel indicator, mini progress bar
- **Story cards:** Expandable, show:
  - Status dot (grey=pending, yellow=running, green=done, red=failed)
  - Title + dependency links
  - Model badge (SONNET/OPUS/HAIKU)
  - Duration (running: live timer; done: total time)
  - Status phase: "Developing..." / "In Review..." / "Fixing..."
  - Status label: PENDING / DONE / FAILED
  - "Run" button (manual trigger, shown when pending and deps met)
- **Expanded story shows:**
  - Error banner (red, if failed, with error message)
  - Live output (while running): current thought, actions list, response
  - Dev Summary (collapsible)
  - Reviewer Feedback (collapsible)
  - Event Log (collapsible, with tool calls, extractions, validations, errors)
  - Story Description (collapsible)

**Issues:**

- Stories show `&amp;` instead of `&` (HTML entity encoding bug)
- Can't re-run a completed story
- Can't see which stories ran in parallel visually (just listed vertically)
- No total cost or time per wave
- No dependency arrows between waves
- Event Log is raw and technical — not friendly for non-developers
- "Run" button + arrow icon purpose unclear

---

## Overall UX Issues for Brainstorming

### Navigation & State

- Refreshing the page sometimes loses the selected project
- No breadcrumb (Labs > Project Name > Story)
- No URL-based routing (all state is client-side)
- Can't share a link to a specific project

### Project Management

- No delete/archive for failed or old projects
- No rename functionality
- No duplicate/clone project
- Projects with same name are confusing
- No project creation date or last-activity timestamp visible

### Development Flow

- No way to modify model/effort per-story (all stories use same settings)
- No way to skip a story
- No way to add a story mid-development
- No cost budget or warning ("this epic will cost approximately $X")
- No estimated time remaining

### Visual Design

- Dark theme only, no density options
- Cards use subtle borders — hard to distinguish sections
- Progress bars are thin (2px) — hard to see
- Status badges are small and use color only (accessibility)
- No animations or transitions for state changes
- Wave visualization only appears before development starts

### Agent Transparency

- Live output is text-heavy — hard to scan
- No visual distinction between tool types (Read vs Write vs Bash)
- No timeline/Gantt view of parallel execution
- No way to see total cost accumulating in real-time

### Error Handling

- Auth errors show technical messages
- No retry button on individual stories
- No "pause all" functionality
- No notification when all stories complete (have to watch)
