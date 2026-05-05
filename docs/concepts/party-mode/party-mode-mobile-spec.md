# Party Mode — Mobile UX/UI Spec

**Audience:** the agent building the Futurator mobile app.
**Purpose:** translate every Party Mode feature shipped on the web admin
(admin.futurator.ai) into a mobile-first design + interaction model. This
doc is self-contained — read it, build from it, no need to refer back to
the desktop UI to make decisions.
**Scope:** UX & UI only. Backend contracts are summarized in §11; no need
to implement them.

---

## 0. TL;DR

Party Mode is a **multi-agent group chat** where the user types one message
and N AI agents (typically 3–5) respond as a single streamed conversation,
moderated by an orchestrator. On the web it's three panes
(sessions / debate / rounds); on mobile it's **one screen with a swipe-out
drawer for rounds and a sticky bottom composer**.

The mental model the user has:

> "I'm chatting with a roundtable of named experts. The orchestrator
> chooses who weighs in. I can rename the topic, scroll back through
> rounds, and tap any file path the agents reference to open it."

The whole experience hangs off a single Session. A Session is a continuous
thread of Rounds. A Round = one user message + the orchestrator + N agent
responses + a closing summary. Each Round is **part of the same scrolling
thread** — never a separate screen, never a reset.

---

## 1. Mental model — what to build first

Build these in order:

1. **Sessions list** — entry point. Tap to open a session.
2. **Chat screen** — the heart of the app. Single scrollable thread.
3. **Composer** — sticky bottom. Send a message → new round appears at the
   bottom of the thread, agents stream in.
4. **Round rail (drawer)** — swipe from right edge or tap a "rounds" icon.
   Lists every round as a card; tap to anchor-scroll to it in the main
   thread.
5. **File preview drawer (overlay)** — tap any file path link in agent
   text → modal sheet slides up showing the file content.
6. **Project settings sheet** — tap settings icon in the header. Toggle
   web search on/off, etc.

If you don't ship #4–#6, the app still works as a chat. They're enhancements
that grow naturally once #1–#3 feel right.

---

## 2. Information architecture (screens & nav)

```
┌───────────────────────────┐
│  Sessions list (project)  │  ← entry point per project
└─────────────┬─────────────┘
              │  tap session
              ▼
┌───────────────────────────┐
│  Chat screen (one thread) │  ← the main screen
│  ─ header (title, status) │
│  ─ scrollable thread      │
│  ─ composer (sticky)      │
└─────────────┬─────────────┘
              │
   ┌──────────┴──────────────────┐
   ▼                              ▼
┌─────────┐                 ┌──────────────┐
│ Rounds  │                 │  File        │
│ drawer  │                 │  preview     │
│ (right) │                 │  (modal)     │
└─────────┘                 └──────────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Project settings    │
   │  (modal sheet)       │
   └──────────────────────┘
```

### Navigation primitives

- **Push** — Sessions list → Chat (full-screen push, back arrow returns).
- **Drawer (right)** — Rounds rail. Slide-in from right edge or tap "rounds"
  icon in header. Backdrop dim. Swipe-right or tap-outside to dismiss.
- **Sheet (bottom)** — Project settings. Slide up from bottom, ~70% screen
  height. Pull down to dismiss.
- **Modal overlay (bottom-sheet, full-height)** — File preview. Slide up
  from bottom, full screen with a top close button. Esc / swipe-down /
  tap close button to dismiss.

There are NO separate screens for individual rounds, agents, or messages.
Every conversational view lives in the single Chat screen thread.

---

## 3. Sessions list screen

### Purpose
Show every party session for the current project, newest first. Let user
open one or start a new one.

### Layout

```
┌───────────────────────────┐
│  ← Projects     ⚙          │  ← header: back button + project settings
│  dino3                    │  ← project name (h1)
│  Web search · ON          │  ← project status chip (small, muted)
│                           │
│  ┌─────────────────────┐  │
│  │ + New session       │  │  ← prominent CTA
│  └─────────────────────┘  │
│                           │
│  Active                   │  ← group header
│  ┌─────────────────────┐  │
│  │ Untitled session    │  │  ← session row
│  │ 4 turns · 2 min ago │  │
│  └─────────────────────┘  │
│                           │
│  Recent                   │
│  ┌─────────────────────┐  │
│  │ Game scoring debate │  │
│  │ 7 turns · yesterday │  │
│  └─────────────────────┘  │
│  ...                      │
│                           │
│  Archived ▾               │  ← collapsible
└───────────────────────────┘
```

### Components

- **Header bar** — 56 px, sticky. Back button + project name + settings gear.
- **Project status chip** — single line below project name. "Web search · ON",
  "Web search · OFF". Muted color when OFF.
- **New session button** — full-width, primary color, prominent. Tap →
  creates a new session, pushes to Chat screen.
- **Session group headers** — "Active", "Recent", "Archived". Small
  uppercase label, 11 px, muted, with letter-spacing.
- **Session row** — full width tap target. Two lines:
  - Line 1: topic (or "Untitled session" italic if blank), 14 px, weight 500
  - Line 2: turn count + time-ago, 12 px, muted
- **Status badge** — right-aligned on session row. Tiny rounded pill with
  state: ACTIVE (emerald), PROCESSING (amber pulse), IDLE (slate),
  ERROR (red), ARCHIVED (zinc).

### Empty state
"No sessions yet. Start one to debate this project with the agents."
Plus the New session CTA.

### Tap behavior
- Tap row → push to Chat screen with that session.
- Long-press → action sheet: "Rename", "Archive", "Delete" (delete is
  destructive — confirm with native alert).

---

## 4. Chat screen — the heart of the app

This is where 95% of the user's time goes. Get this right.

### 4.1 Layout

```
┌───────────────────────────┐
│ ← # Untitled  ✏  🔍 on   ⋯│  ← header (56 px, sticky)
├───────────────────────────┤
│                           │
│  ── Round 1 ──            │  ← round divider (subtle)
│                           │
│  ┌─────┐                  │
│  │ RA  │ Ricardo · 2:47 PM│  ← user question banner
│  └─────┘ "Let's debate    │
│           the scoring..." │
│                           │
│  ┌─────────────────────┐  │
│  │ 🧙 ORCHESTRATOR     │  │  ← orchestrator open card
│  │    BMad Master sets │  │     (purple gradient)
│  │    the round        │  │
│  ├─────────────────────┤  │
│  │ Bringing in John,   │  │
│  │ Sally, and Rick.    │  │
│  │                     │  │
│  │ ▸ Actions · 3 calls │  │  ← collapsed tool log
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │
│  │ ━━━━━━━━━━━━━━━━━━ │  │  ← agent card (top accent edge
│  │ 📋 John  PM 2:49 ⧉  │  │     in agent's accent color)
│  │                     │  │
│  │     Why do you      │  │
│  │     want it more    │  │
│  │     competitive?    │  │
│  │     ...             │  │
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │
│  │ ━━━━━━━━━━━━━━━━━━ │  │
│  │ 🎨 Sally  UX 2:50 ⧉ │  │
│  │     ...             │  │
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │  ← orchestrator close card
│  │ 🧙 closes Round 1   │  │     (softer purple)
│  ├─────────────────────┤  │
│  │ Strong consensus on │  │
│  │ combo multiplier... │  │
│  └─────────────────────┘  │
│                           │
│  ── Round 2 ──            │  ← divider, then next round
│  ...                      │
│                           │
├───────────────────────────┤
│ Type a message...     ➤   │  ← composer (sticky bottom)
│ 📎 @                      │
└───────────────────────────┘
```

### 4.2 Header (56 px)

- **Back arrow** (left) — pops to Sessions list.
- **# icon + editable session title** (center-left) — tap to edit inline.
  When empty: italic muted "Untitled session". Save on Enter, cancel on
  Esc. Persist via PATCH endpoint.
- **🔍 web chip** (center-right) — `🔍 on` (emerald) or `🔍 off` (muted).
  Tap toggles the WebSearch tool for this project.
- **⋯ overflow menu** (right) — opens action sheet with: Rename session,
  Archive session, Project settings, Delete session.

The header should remain visible while scrolling; never collapse. Critical
because the title is editable and the web toggle is the only visible
permission affordance.

### 4.3 Thread (scrollable middle)

**Critical principle:** The thread is **continuous across rounds**. When
the user sends round 2, it appends below round 1, NEVER replaces it. The
"round divider" is just a visual landmark, not a content break.

#### Round divider

Between rounds (not before round 1):

```
─────  Round 2  ─────
```

Centered pill, 10.5 px font, mono, uppercase, with thin gradient lines on
either side. **When the round is currently streaming**, the pill changes
to green ("● Round 2"). The divider lets the user find the boundary
without losing the conversation flow.

#### User question banner

Once per round, top of round:

- 28 px circular avatar (OAuth profile picture if present, else initial
  on brand-blue circle).
- Two lines of text:
  - Line 1: user's name (bold) + "·" + time.
  - Line 2: the prompt they sent (preserves whitespace, normal color).
- Subtle off-white tint background, 10 px corner radius.
- Pull from OAuth: `user.name` (else email-prefix, else "You"); `user.picture`.

#### Orchestrator OPEN card

The first response after the user banner. Purple gradient header band:

```
┌──────────────────────────────────────┐
│ 🧙  ORCHESTRATOR                  ⧉  │  ← header band, purple gradient
│     BMad Master sets the round       │
│     4 agents weighing in             │
├──────────────────────────────────────┤
│                                      │
│ <intro paragraph from orchestrator>  │
│                                      │
│ ▸ Actions · 3 tool calls             │  ← collapsible tool log
│                                      │
└──────────────────────────────────────┘
```

- Solid 14 px corner radius.
- Header band: purple-tinted background with bottom border.
- 32 px circular wizard icon avatar.
- "ORCHESTRATOR" text uppercase, bold, accent purple.
- Subline: "{N} agents weighing in".
- Copy button on the right (floating ⧉ icon, 28 px hit target).

#### Tool log (inside orchestrator open card)

Collapsible section at the bottom of the orchestrator open card. Default
**collapsed** unless the round is mid-streaming with no agent text yet
(then auto-expand so the user has something to look at during cold-start).

Collapsed state:
```
▸  🔧 ACTIONS · 3 tool calls   [📄 1 🌐 2]
```

The chevron + label + count are always shown. When collapsed, also show
small icons + counts for the tool kinds called (Read = 📄, WebSearch = 🌐,
Bash = ⌨, Edit = ✏, etc).

Expanded state — list of rows, one per tool call:

```
  📄 Read      _bmad/_config/agent-manifest.csv
  🌐 WebSearch "best endless runner games 2024"
  ⌨  Bash      ls -la (List project files)
```

Each row is one line of monospace 11.5 px text, with:
- Tool-kind icon (small, accent-purple)
- Tool name (bold, monospace)
- One-line summary of the most informative input (file path, command,
  pattern, query, etc — see §11.3 for the rules per tool)

Tap the header to toggle; smooth height animation (~150 ms ease-out).

#### Agent card

One per `⟪AGENT:Name⟫` block:

```
┌──────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │  ← 4 px top edge in accent color
│ ┌────┐                            ⧉ │  ← copy on right
│ │ 📋 │ John  [Product Manager]      │
│ │    │ 2:49 PM                      │
│ └────┘                              │
│        <body markdown — paragraphs, │
│         lists, code blocks, tables, │
│         links, mentions>            │
│                                     │
└──────────────────────────────────────┘
```

- Corner radius 12 px. Subtle dark elevated surface.
- **Top edge** — 4 px tall, full agent accent color (per the agent
  identity table). The identity strip.
- **Avatar** — 48×48 square, 14 px radius, agent's accent color tinted
  background, 2 px solid accent border, status dot bottom-right (green
  when this agent is currently streaming, gray when done).
- **Header** — name (16 px bold white) + role pill (12 px, 600 weight,
  accent-tinted bg, 10 px radius) + timestamp (12 px muted, right-aligned).
- **Body** — full markdown via the rich-text renderer. See §6 for support.
- **Streaming indicator** — when this agent is the currently-streaming
  one (last agent block in an active round), show 3 pulsing dots in agent
  accent color below the body, not a typing cursor.

#### Mid-round orchestrator note (rare)

Slim interjection between agents — the orchestrator handing off:

```
   🧙 SALLY → MARY
   "Sally raised the layered approach; Mary, what's
    your read on which layer ships first?"
```

- Indented to align with avatar gutter (~76 px).
- 22 px wizard avatar.
- Eyebrow: "{prevAgent} → {nextAgent}", 11 px uppercase, accent purple.
- Body: 13 px italic, muted.
- Soft fade-in animation (~220 ms).

#### Orchestrator CLOSE card

Last block of a round. Same anatomy as the open card but with a softer
appearance:
- Lower opacity background (rgba(167,139,250,0.05))
- Smaller header band
- Subline reads "closes Round N" instead of "sets the round"
- Often contains a leading question to the user ("Want to dig deeper?",
  "Should I bring in X?")

#### Cold-start skeleton

While the in-flight round has zero agent blocks yet:

- Show 2-3 shimmer agent-card placeholders below the orchestrator open
  card.
- Animate background-position-x for ~1.6s linear loop.
- Replace with real agent cards as they stream in.
- **Never** show skeletons in front of a completed round — keep prior
  content visible.

### 4.4 Composer (sticky bottom)

```
┌───────────────────────────┐
│ Type a message — agents   │
│ will respond              │
│                           │
│ 📎  @          ➤ Send     │
└───────────────────────────┘
```

- Sticky to the keyboard. When the soft keyboard opens, composer rises
  with it; thread above auto-shrinks. Use the platform's keyboard-avoid
  pattern.
- Multi-line `<textarea>` equivalent. Min height 60 px, expands to ~3
  lines max before scrolling internally.
- Bottom action row:
  - 📎 attach button (opens file picker — sends to /docs upload)
  - @ mention button (future — shows roster picker; out of scope v1)
  - Send button (primary color, brand blue, "Send →"). Disabled when
    draft is empty or session is busy and not yet recovered.

#### Composer states

- **Idle** — placeholder: "Type a message — agents will respond".
- **Processing** (a turn is in flight) — placeholder changes to: "Ask a
  follow-up while the debate runs…". Send button stays enabled (you can
  queue another message — the daemon will run it as turn N+1 once the
  current one completes).
- **Error** (last turn ended in ERROR) — show a red banner above the
  composer: "Last turn ended in error (likely timeout — agents take time
  on large projects). Send a new message to start a fresh round; the
  previous round's partial output is preserved above." Placeholder:
  "Session errored. Type a new message to start a fresh round…".

### 4.5 Auto-scroll behavior

This is subtle. Read carefully.

- **Default** — when new content arrives in the latest round, scroll the
  thread to the bottom so the user sees it.
- **User-pinned** — once the user scrolls up (away from bottom), STOP
  auto-scrolling. Show a "↓ New messages" floating button in the bottom
  right that scrolls back to bottom on tap.
- **Round selected from drawer** — anchor-scroll to that round's user-
  banner element. Don't keep auto-scrolling to bottom.

Heuristic for "is at bottom": within ~80 px of the scrollable area's
bottom edge.

---

## 5. Round rail (drawer)

### Purpose

Quick navigation across rounds in long sessions. **Not** a content view —
just an index. Tapping anchors back into the main thread.

### When to show

- Tap the "rounds" icon in the header.
- Swipe in from the right edge.

### Layout

```
┌──────────────────────────┐
│  Rounds        4 total  ×│
├──────────────────────────┤
│ ┌──────────────────────┐ │
│ │ ● ROUND 4       now  │ │  ← live (green pill + dot)
│ │ Search runner games  │ │
│ │ 🧙📋🎨🧪              │ │
│ │ 4 agents · 6 turns   │ │
│ └──────────────────────┘ │
│                          │
│ ┌──────────────────────┐ │
│ │ ROUND 3       42 min │ │  ← done (muted pill)
│ │ Write a .md doc      │ │
│ │ 🧙📋🎨🧪              │ │
│ │ 3 agents · 4 turns   │ │
│ └──────────────────────┘ │
│ ...                      │
└──────────────────────────┘
```

### Round card

- 12 px padding, 10 px corner radius.
- **Status badge** (top-left): "● ROUND N" green pill when live; muted
  pill otherwise. 10 px font, 700 weight, uppercase.
- **Time-ago** (top-right): "now" / "5 min" / "2h" / "3d", 11 px muted.
- **Title** (line 2): the user's prompt, 13 px, semibold, 2-line clamp.
- **Participant strip** (line 3): up to 6 stacked overlapping circular
  agent avatars (22 px, -4 px overlap), each colored with the agent's
  accent. "+N" if more than 6.
- **Meta** (line 4): "{N} agents · {M} turns", 11 px muted.
- **Active state**: blue-tinted background + blue border when this round
  is the one currently anchored in the main view.

### Tap behavior

- Tap card → close drawer + anchor-scroll the main thread to that round's
  user-banner element. Smooth scroll, ~300 ms.

### Empty state

"No rounds yet — send a message to start." Centered, italic, muted.

---

## 6. File preview drawer (modal overlay)

### Purpose

When agents reference files (`_bmad-output/planning-artifacts/foo.md`),
those become tappable links in the agent text. Tapping opens a full-screen
overlay that fetches the file from EC2 and renders it.

### Layout

```
┌───────────────────────────┐
│ 📄 foo.md          ⧉  ×   │  ← header (56 px)
│ planning-artifacts/foo.md │  ← path + size
│ · 4.2 KB                  │
├───────────────────────────┤
│                           │
│ # Document content here   │
│                           │
│ Markdown rendered through │
│ the same rich-text        │
│ pipeline as agent         │
│ messages.                 │
│                           │
│ - bullets                 │
│ - tables                  │
│ - code blocks             │
│ - inline links            │
│                           │
│                           │
└───────────────────────────┘
```

### Header

- 📄 file icon (left, brand color)
- Filename (bold, 14 px)
- Path + size below (11 px monospace, muted)
- ⧉ copy button (copies full file content to clipboard)
- × close button (top right; also dismissable by swipe-down)

### Body

- Markdown files (`.md`, `.markdown`) → rendered via the same RichText
  pipeline as agent messages. Inline file links inside chain naturally
  (tapping one swaps the drawer's content to that file).
- All other files → rendered as a syntax-highlighted code block with the
  file's extension as the language hint.

### States

- **Loading** — spinner + "Reading file…", 12 px muted.
- **Error 404** — "Couldn't open file. The file may have been moved or
  deleted since the agent referenced it."
- **Error 403** — "Access denied — file is outside the project root."
- **Error 413** — "File too large to preview (>1 MB)."

### Dismiss

- Tap × button.
- Swipe down on the drawer.
- Tap backdrop.
- Esc key (if a hardware keyboard is attached).

### Path detection rules

In agent text, treat any token matching this pattern as a file link
(button, not anchor):

```
[\w./-]+\.(md|markdown|txt|ts|tsx|js|jsx|json|css|scss|html|py|go|rs|rb|
            java|kt|swift|c|cpp|h|sh|bash|zsh|yml|yaml|toml|xml|mjs|cjs|
            sql|env)
```

Visual treatment:
- Monospace font
- Slightly smaller (0.9 em)
- Purple color (accent-purple)
- Dotted underline
- Hover/press feedback

---

## 7. Project settings sheet

### Purpose

Per-project toggles. Currently just the Web Search toggle, but designed
to grow.

### When to show

- Tap ⚙ on Sessions list header.
- Tap ⋯ → Project settings on Chat header.

### Layout

```
┌───────────────────────────┐
│ Project settings      ×   │
├───────────────────────────┤
│ dino3                     │  ← project name (h2)
│ /home/ubuntu/projects/    │  ← path, monospace muted
│ dino3                     │
│                           │
│ ─── Tools ────            │
│                           │
│ 🌐 Web search             │
│ Allow agents to search    │
│ the web. ~$0.01/query.    │
│                  [ON  ●]  │  ← native toggle switch
│                           │
│ 📥 Web fetch              │
│ Allow agents to fetch     │
│ specific URLs.            │
│                  [ON  ●]  │
│                           │
│ ─── BMAD ────             │
│                           │
│ Status: HEALTHY           │
│ Agents: 14 / 14           │
│ Last inspected 12 min ago │
│                           │
│ [ Re-inspect ]            │
│                           │
└───────────────────────────┘
```

Use the platform's native toggle switches (iOS UISwitch / Material Switch)
so they feel natural. Optimistic update — toggle flips immediately,
rolled back if API rejects.

---

## 8. Visual design tokens

### Colors

```
Background base:       #1e1f22  (deepest)
Background surface:    #2b2d31  (agent cards, sessions list)
Background content:    #313338  (main chat area)
Background elevated:   #383a40  (composer, hover surfaces)
Background input:      #1e1f22  (code blocks, dark inset)

Text primary:          #f2f3f5  (titles, agent names)
Text body:             #dbdee1  (paragraph text)
Text muted:            #949ba4  (timestamps, role labels)
Text faint:            #80848e  (sub-metadata)

Brand (user / send):   #5865f2  (Discord-blue)
Orchestrator:          #a78bfa  (violet)
Orchestrator soft:     #c4b5fd  (orchestrator text on dark)
Live indicator:        #4ade80  (round live, status dot)
Success confirmed:     #23a55a  (copy confirmed)

Inline code fg:        #f9a8d4
Inline link fg:        #00a8fc
File-path link fg:     accent-purple (#a78bfa-ish)

External link fg:      #7dd3fc (sky)
```

### Per-agent accent palette

Map by agent name (case-insensitive):

| Agent | Hex | Tailwind name |
|---|---|---|
| BMad Master / Builder | `#a78bfa` | violet |
| Mary | `#60a5fa` | blue |
| John | `#38bdf8` | sky |
| Sally | `#f472b6` | pink |
| Winston | `#fbbf24` | amber |
| Amelia | `#34d399` | emerald |
| Paige | `#22d3ee` | cyan |
| Bob | `#fb923c` | orange |
| Murat | `#e879f9` | fuchsia |
| Carson | `#facc15` | yellow |
| Dr. Quinn | `#2dd4bf` | teal |
| Maya | `#fb7185` | rose |
| Victor | `#eab308` | yellow-darker |
| Sophia | `#818cf8` | indigo |
| Ludwig | `#c084fc` | purple |
| Pedrock | `#a8a29e` | stone |
| Dave ups! | `#f87171` | red |
| Sean Tinel | `#a3e635` | lime |
| Nimbus | `#7dd3fc` | sky-light |
| Kube Rick | `#93c5fd` | blue-light |
| Sue Render | `#f9a8d4` | pink-light |
| Rick | `#4ade80` | green |
| Unknown agent | `#a3a3a3` | gray (fallback) |

The agent's accent is used in:
- Avatar background tint (12% opacity) + 2 px solid border (full opacity)
- Top edge of agent card (4 px)
- Agent name color
- Role pill text + tinted background
- Streaming dots
- Round-rail participant-strip avatar

### Typography

```
UI font:    "gg sans", "Helvetica Neue", system-sans
Mono font:  "JetBrains Mono", "SF Mono", ui-monospace

Sizes:
  16 px — agent name
  15 px — session title (header)
  14.5 px — body paragraph
  13.5 px — list item, table cell
  13 px — round-rail title
  12 px — metadata (role pills, timestamps)
  11 px — secondary meta
  10.5 px — uppercase labels (with letter-spacing 0.06em)
  10 px — round badge
```

Line heights:
- 1.55 for body
- 1.45 for chat bubbles
- 1.35 for headings

### Spacing & sizing

- Agent card horizontal margin: 24 px
- Card corner radius: 12 px (agent card), 14 px (orchestrator card),
  10 px (small surfaces)
- Avatar: 48 px (agent card), 32 px (orchestrator open), 28 px (user
  banner), 22 px (round-rail participant strip)
- Tap targets: minimum 44×44 px (Apple HIG / Material guideline)
- Header height: 56 px
- Composer min height: 60 px

### Animations

- **Fade-in for mid-notes**: 220 ms ease-out
- **Streaming dots pulse**: 1.2 s ease-in-out, 3 dots, 0.18 s stagger
- **Skeleton shimmer**: 1.6 s linear infinite
- **Drawer slide-in**: 280 ms ease-out
- **File-drawer slide-up**: 320 ms ease-out
- **Avatar streaming ring**: 1.6 s ease-out infinite (subtle box-shadow
  pulse around the active speaker's avatar)
- **Copy confirm**: 1.4 s before reverting from green checkmark to
  default copy icon
- **Round card tap**: 80 ms scale-down to 0.97 then back

Respect `prefers-reduced-motion` — disable all of the above except
streaming dots (those communicate liveness).

---

## 9. Interactions & gestures

### Taps

- **File path in agent text** → open file preview drawer.
- **External URL in agent text** → open in default browser (system
  handler).
- **@mention pill in agent text** → no action (display only in v1).
- **Copy button (⧉)** → copy block content, show 1.4s checkmark feedback.
- **Round card** → close drawer, anchor-scroll to round.
- **Header title** → enter edit mode for session title.
- **Web toggle chip** → flip immediately, persist.

### Long-press

- **Session row in Sessions list** → action sheet (Rename / Archive /
  Delete).
- **Agent message** → action sheet (Copy / Reply with quote — out of
  scope v1, just Copy).

### Swipes

- **Swipe right from left edge** (in Sessions list) → push back to
  Projects (if you have that screen).
- **Swipe left from right edge** (in Chat) → open Rounds drawer.
- **Swipe right on a session row** → reveals "Archive" action (iOS
  pattern).
- **Pull down on Chat thread** → refresh (refetch session events).
- **Swipe down on file drawer** → dismiss.

### Keyboard (when external)

- **Esc** → close any open drawer/modal.
- **Enter** in title editor → save and exit edit mode.
- **Cmd+Enter** in composer → send.

---

## 10. Empty / loading / error states

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Sessions list | "No sessions yet…" + New session CTA | Skeleton rows (3) | "Couldn't load sessions. Pull to retry." |
| Chat thread (no rounds) | "Start a debate" + suggested prompts | n/a | n/a |
| Round (cold start) | Skeleton agent cards (2-3) | n/a | n/a |
| Round (streaming, no text yet) | Tool log auto-expanded + "Agents reading the codebase…" hint | n/a | n/a |
| Round (errored) | n/a | n/a | Red inline banner: "Round N ended in error ({reason})" + "Send a new message to continue." |
| Round rail | "No rounds yet — send a message to start." | n/a | n/a |
| File drawer | n/a | Spinner + "Reading file…" | "Couldn't open file" + reason |
| Settings sheet | n/a | Skeleton toggles | "Couldn't load settings" |

### Special cold-start UX

The most important loading state: the user just sent their first message,
the daemon is spinning up Claude. This takes **5-20 seconds** (Claude
cold-start + initial tool exploration) before any agent text appears.

Sequence:
1. **0-200 ms** — Composer clears immediately, user banner appears at
   bottom of thread, draft is gone. Snap-scroll to bottom.
2. **200 ms - "claude.started" event** (~1-3 s) — Show "BMad Master is
   routing your message…" hint below the user banner. No skeleton yet.
3. **"claude.started" event - first token** (~3-15 s) — Replace the hint
   with skeleton agent cards (2-3) + auto-expanded tool log if any tools
   have fired.
4. **First token** — Replace skeletons with the orchestrator open card,
   start streaming agent cards as they arrive.

### Special error: session in ERROR

If the session's status is ERROR (last turn timed out or crashed), show
a persistent red banner above the composer:

> Last turn ended in ERROR (likely a timeout — agents take time on large
> projects). Send a new message to start a fresh round; the previous
> round's partial output is preserved above.

The Send button stays ENABLED — sending a new message creates Round N+1
fresh, doesn't try to "recover" the failed turn.

---

## 11. Backend contract (REST)

All endpoints accept `Authorization: Bearer <jwt>` (Identity Broker token).
Base URL: `https://admin.futurator.ai/api` (or your environment's API
gateway).

### 11.1 Sessions

```
GET    /api/party/projects/:projectId/sessions
       → { sessions: PartySession[] }

GET    /api/party/sessions/:sessionId
       → PartySession

POST   /api/party/sessions
       Body: { projectId: string, topic?: string }
       → PartySession

PATCH  /api/party/sessions/:sessionId
       Body: { topic: string | null }
       → PartySession

POST   /api/party/sessions/:sessionId/messages
       Body: { content: string }       (max 8192 bytes)
       → 202 { jobId, sessionId }

GET    /api/party/sessions/:sessionId/events?after=000000
       → { events: PartyEvent[], lastSeq: string }
```

### 11.2 Projects

```
GET    /api/party/projects
       → { projects: PartyProject[], expectedAgentCount: number }

GET    /api/party/projects/:projectId
       → PartyProject

PATCH  /api/party/projects/:projectId
       Body: { allowedTools: string[] | null }
         - Array of tool names → store as-is
         - null → clear (defaults apply)
         - [] → deny all extras
       → PartyProject

POST   /api/party/projects/:projectId/inspect
       → { jobId }
```

### 11.3 Files (drawer)

```
GET    /api/party/projects/:projectId/files?path=<rel>
       → { path, fullPath, size, contentType, content }
       Errors:
         404 → file not found
         403 → path resolves outside project root
         413 → file > 1 MiB
```

### 11.4 PartySession shape

```ts
interface PartySession {
  sessionId: string;
  projectId: string;
  projectPath: string;
  claudeSessionId: string | null;
  status: 'ACTIVE' | 'PROCESSING' | 'IDLE' | 'ERROR' | 'ARCHIVED';
  turnCount: number;
  topic?: string;        // editable session title
  lastTurnAt?: string;   // ISO
  createdAt: string;     // ISO
  bmadVersionAtStart: string;
}
```

### 11.5 PartyProject shape

```ts
interface PartyProject {
  projectId: string;
  path: string;
  bmadStatus: 'MISSING' | 'INSTALLING' | 'HEALTHY' | 'DRIFTED' |
              'CORRUPTED' | 'FAILED';
  bmadVersion?: string;
  agentCount?: number;
  expectedAgentCount: number;
  allowedTools?: string[]; // undefined → defaults (WebSearch, WebFetch)
  lastInspectedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 11.6 PartyEvent shape & polling

The events feed drives the entire chat UI. Poll
`GET /api/party/sessions/:id/events?after=<lastSeq>` and append the
returned events to local state.

Event shape:
```ts
interface PartyEvent {
  jobId: string;       // = sessionId for party events
  eventSeq: string;    // "000001", "000002", … monotonic per session
  timestamp: string;   // ISO — USE THIS for ordering, not eventSeq
  eventType:           // discriminant
    | 'party.turn.user'
    | 'party.turn.started'
    | 'party.turn.assistant.token'
    | 'party.turn.assistant.tool'
    | 'party.turn.awaiting_user'
    | 'party.turn.completed'
    | 'party.turn.error';
  // ── per-event payload, varies by eventType ──
  content?: string;    // user event: the prompt
  text?: string;       // assistant.token event: a chunk of text
  tool?: {             // assistant.tool event
    id: string;
    name: string;      // "Read", "WebSearch", "Bash", etc.
    input: Record<string, unknown>;
  };
  reason?: string;     // error event
  isFirstTurn?: boolean; // started event
  turnCount?: number;
}
```

### Polling cadence

```
- PROCESSING: poll every 600 ms (live streaming)
- After receiving events in a tick: poll again in 600 ms (likely more)
- Otherwise (ACTIVE/IDLE): poll every 2 s
- Terminal (ERROR / ARCHIVED): STOP polling
```

### CRITICAL: order events by timestamp, not eventSeq

The daemon used to have a bug where it would reset the eventSeq counter
on restart and overwrite earlier events at the same seq. That bug is
fixed at the daemon, but you should still sort by `timestamp` in the
client and dedupe by `eventSeq`. This is defense in depth; one weird seq
glitch can otherwise reorder rounds and confuse the user.

### 11.7 Marker-based output parsing (CRITICAL)

The orchestrator emits agent contributions wrapped in Unicode markers:

```
⟪SYSTEM⟫
Bringing in John (PM) and Sally (UX) to debate the scoring system.

⟪AGENT:John⟫
Why do you want it more competitive? Who are you competing against?

⟪AGENT:Sally⟫
Two players, same score, totally different play styles…

⟪SYSTEM⟫
Strong agreement. Want to dig deeper?
```

Brackets are U+27EA and U+27EB. Parse by:

1. Concatenating all `assistant.token` events' `text` fields in order.
2. Find every marker via `/⟪(AGENT:([^⟫\n]+)|SYSTEM)⟫/g`.
3. Slice the text **between** marker positions. Anything before the first
   marker is "intro" (BMad Master's exploration narration).
4. **Don't** require the marker to be on its own line — Claude
   occasionally glues `…analysis.⟪AGENT:Winston⟫` together. Splitting on
   global regex matches (not line-anchored) handles this.
5. Resolve the captured agent name against the canonical 23-name roster
   (table in §8). Anything not on the roster: still emit as an agent
   block (best-effort) using the raw name + fallback initials.

Legacy fallback: if NO markers are present in the stream, fall back to
`^[emoji ]?\*\*Name:\*\*` line matching with the same roster validation.
This handles older sessions started before the marker contract shipped.

### 11.8 Tool call summary rules

For each `assistant.tool` event, render a one-line summary in the tool
log. Pick the most informative input field per tool:

| Tool | Summary |
|---|---|
| Read | `<file_path>` — strip `/home/ubuntu/projects/<slug>/` prefix |
| Write / Edit / NotebookEdit | `<file_path>` (same prefix strip) |
| Grep | `"<pattern>" in <path>` |
| Glob / LS | `<pattern>` |
| Bash | `<description> — <command>` |
| WebFetch | `<url>` |
| WebSearch | `<query>` |
| Skill | `<skill>` |
| Task / Agent | `<description>` or `<subagent_type>` |
| Other | first non-empty string field as `key=value` |

Truncate any single field to 60 chars (with `…`).

### 11.9 Auth

- OAuth via Identity Broker. JWT bearer tokens. Refresh proactively when
  <2 min remaining.
- User shape:
  ```ts
  interface User {
    userId: string;
    email: string;
    name: string;        // display name in user banner
    picture?: string;    // OAuth profile picture URL
  }
  ```

---

## 12. State model

Minimum state the chat screen needs to hold:

```ts
{
  // Server state (cached via TanStack Query equivalent)
  session: PartySession | null;
  project: PartyProject | null;
  events: PartyEvent[];

  // Local state
  draft: string;          // composer text
  pinnedRoundId: string | null; // when user picks from rail
  editingTitle: boolean;
  draftTitle: string | null;
  toolLogExpanded: Map<string, boolean>; // by orchestrator-open-id

  // Drawer state (lifts to a higher provider)
  fileDrawerOpen: { projectId: string; path: string } | null;
  roundDrawerOpen: boolean;
  settingsSheetOpen: boolean;
}
```

The events array gets transformed into rounds by an adapter (run through
a useMemo equivalent on every event update). The adapter:

1. Dedupes events by `eventSeq`.
2. Sorts by `timestamp` (ms-precision; eventSeq breaks ties).
3. Splits on `party.turn.user` events into rounds.
4. For each round:
   - Concatenates `assistant.token` text → parses markers → blocks.
   - Collects `assistant.tool` events as a separate `tools` array.
   - Derives status (active / done / awaiting / error).
   - Marks the last round in-flight if session.status === 'PROCESSING'.

---

## 13. Mobile-specific UX guidance

### Keyboard handling

- Composer must rise with the keyboard. Don't let the keyboard hide the
  message being typed.
- Auto-grow textarea up to 3 lines, then internal scroll.
- Tapping an agent message body should NOT focus the composer (use
  delegate-tap-on-content to dismiss keyboard instead).

### Touch targets

- All buttons ≥ 44 px square (iOS HIG minimum).
- Copy buttons on agent cards: 28 px visual, 44 px hit area.
- Web toggle chip in header: 28 px visual, 44 px hit area.
- Tool-log expand row: full-width tap target inside the orchestrator card.

### Long messages

Agent messages are LONG (typical 600-1800 chars). Don't try to fit them
in viewport — they're meant to be scrolled through. Don't truncate or
"show more" — the whole point is reading the agent's full reasoning.

### Performance

- Long sessions can have 50+ rounds, each with ~5 agent cards. Plan for
  rendering ~250 cards. Use a virtualized list if your platform's
  default scrollview struggles past ~100 children.
- Markdown rendering is the heavy hit — memoize per-block render output
  keyed on `(blockId, text.length)`. The text only ever grows (never
  changes mid-stream for past blocks).
- The tool log can have 30+ rows. Virtualize if expanded.

### Network

- The events poll is the only "live" network activity once a session is
  open. 600 ms cadence while streaming, 2 s otherwise, stop entirely
  when the session is in a terminal state.
- Background-mode behavior: pause polling when the app is backgrounded.
  Resume + immediately fetch all missed events on foreground.
- Image avatars (OAuth `user.picture`) cache locally — they don't change.

### Offline / poor network

- When the events poll fails, show a tiny inline indicator at the top of
  the thread ("Reconnecting…") but DON'T block the UI. The user can keep
  reading what they already have. Resume polling exponentially
  (1s, 2s, 4s, max 8s) until success.
- Composer's Send button: disable and show "Offline" if no network
  connectivity at all. Re-enable when reachable.

### Dark mode (default) and light mode

- The current design IS dark mode. The user has a dark/light toggle in
  the admin app's profile menu. Mobile should follow the system setting
  by default and let the user override in settings.
- For light mode, swap the bg/surface colors but keep all per-agent
  accent colors the same. They're tuned to read well on both.

### Native-platform patterns to use

- **iOS** — use `SFSafariViewController` for external links, `ShareLink`
  for copy/share actions, native UISwitch in settings.
- **Android** — use Custom Tabs for external links, MaterialSwitch in
  settings, snackbar for confirmation toasts (instead of inline copy
  feedback if you prefer).

---

## 14. Out of scope for v1

Don't try to ship these on day one — they're nice-to-haves that pile on
complexity:

- @mention picker in composer (the @ button is a placeholder).
- Reactions on agent messages.
- Threaded replies.
- File drawer for binary files (images, PDFs) — only text in v1.
- Inline editing of past user messages.
- Voice input.
- Push notifications when an async turn completes.
- Multi-project workspace — one project per session for now.
- Bash tool toggle in project settings (currently only WebSearch is
  toggleable; the design supports adding more later).
- Plan / Epic / Story dashboards (those are admin-only — mobile is
  Party Mode focused).

---

## 15. Acceptance checklist

The mobile build is "done" when:

- [ ] User can sign in via OAuth (Identity Broker).
- [ ] User sees a list of party projects, taps one, sees its sessions.
- [ ] User can create a new session and start chatting.
- [ ] First turn streams in: cold-start hint → tool log → orchestrator
      open → agent cards → orchestrator close.
- [ ] User can send follow-up messages; rounds append to a continuous
      thread.
- [ ] Round divider pills appear between rounds; the active round shows
      a green badge.
- [ ] Round drawer opens from right edge / icon and lets user
      anchor-scroll to any round.
- [ ] Tapping a file path in agent text opens the file drawer with the
      content.
- [ ] Web search toggle in the header flips on/off.
- [ ] Editable session title in header persists rename.
- [ ] User's name + OAuth avatar appear on the user-question banner.
- [ ] Tool log is collapsible; auto-expanded only during cold start.
- [ ] All copy buttons work (agent message, orchestrator block, file).
- [ ] External links in agent text open in the system browser.
- [ ] Errored sessions show a red banner; sending a new message starts
      a fresh round (no recovery attempt).
- [ ] Pull-to-refresh refetches events.
- [ ] Background → foreground triggers a fresh poll.
- [ ] All animations respect `prefers-reduced-motion`.

---

## 16. Reference for visual fidelity

If the agent wants pixel-level reference, the desktop V2 implementation
lives at:

- `src/components/labs/party/v2/session-chat-v2.tsx` — three-pane shell
- `src/components/labs/party/v2/main-pane.tsx` — header + thread
- `src/components/labs/party/v2/agent-card.tsx` — per-agent card
- `src/components/labs/party/v2/orchestrator-cards.tsx` — open/close/mid
- `src/components/labs/party/v2/tool-log.tsx` — collapsible actions log
- `src/components/labs/party/v2/round-rail.tsx` — right-rail rounds
- `src/components/labs/party/v2/file-drawer.tsx` — file preview overlay
- `src/components/labs/party/v2/left-pane.tsx` — sessions list + composer
- `src/components/labs/party/v2/tokens.ts` — color/spacing constants
- `src/components/labs/party/turn-parser.ts` — marker parser
- `src/components/labs/party/turn-adapter.ts` — events → rounds
- `src/components/labs/party/agent-identity.ts` — per-agent palette

For the markdown rendering pipeline (used in agent bodies AND in the
file drawer):

- `src/components/labs/party/rich-text.tsx`

Mobile doesn't have to use these exact components — they're React/Web —
but the visual treatment, spacing, color choices, and component
boundaries should map 1:1 to the mobile equivalents.
