# Party Mode Chat — UI/UX Implementation Spec

**Version:** 1.0  
**Source design:** `Party Mode Chat Visualizations.html` → V2 artboard  
**Inspiration:** Discord (identity, density), Slack (sessions), Linear (round history)

---

## 1. Purpose

Render a multi-agent debate ("Party Mode") where the user can:

1. Read agents in parallel as they respond.
2. Chat with the orchestrator while the debate is running (without losing focus).
3. Switch between past and current debate rounds.
4. Copy any single agent's contribution (or the orchestrator's) for reuse.

---

## 2. Three-pane layout

```
┌─────────────┬─────────────────────────┬──────────────┐
│   LEFT      │       MAIN              │    RIGHT     │
│ Chat &      │   Debate stream         │   Rounds     │
│ Sessions    │   (current round)       │   history    │
│             │                         │              │
│ [composer]  │                         │              │
└─────────────┴─────────────────────────┴──────────────┘
```

### 2.1 Pane sizing & resize behavior

| Pane | Default | Min | Max | Resizable |
|---|---|---|---|---|
| Left  | 340 px | 240 px | 600 px | Yes (drag right edge) |
| Main  | flex   | —      | —      | Auto (grows/shrinks) |
| Right | 280 px | 200 px | 480 px | Yes (drag left edge) |

- **Dividers:** 4 px wide, transparent until hover → blue accent (`rgba(88,101,242,0.5)`), `cursor: col-resize`.
- **Persist** widths in `localStorage` (key: `partyMode.paneSizes`).
- **Mobile (< 720 px):** stack to single column with bottom tab bar (`Chat | Debate | Rounds`).

### 2.2 Aligned headers

**All three panes share a 56 px header** (`HEADER_H = 56`). The horizontal separator (`1px solid #1e1f22 + 0 1px 0 rgba(0,0,0,0.2) shadow`) must align pixel-perfectly across all panes.

---

## 3. Color tokens

```
--bg-deepest:    #1e1f22   (server gutters, dividers)
--bg-surface:    #2b2d31   (left + right pane bg, agent cards)
--bg-content:    #313338   (main feed bg)
--bg-elevated:   #383a40   (composer, hover surfaces)
--bg-input:      #1e1f22   (code blocks, table headers)

--text-primary:  #f2f3f5
--text-body:     #dbdee1
--text-muted:    #949ba4
--text-faint:    #80848e

--accent-brand:  #5865f2   (user, send button, dividers on hover)
--accent-orch:   #a78bfa   (orchestrator)
--accent-orch-2: #c4b5fd   (orchestrator text)
--accent-live:   #4ade80   (live round indicator, status dot)
--accent-success:#23a55a   (copy confirmed)

--inline-code:   #f9a8d4   (foreground)
--inline-link:   #00a8fc
```

### Per-agent accent colors

Each agent has a unique accent used in: avatar border, top edge of card, name color, role pill background.

| Role | Accent |
|---|---|
| Orchestrator    | `#a78bfa` |
| Business Analyst| `#60a5fa` |
| Product Manager | `#38bdf8` |
| UX Designer     | `#f472b6` |
| Architect       | `#fbbf24` |
| Developer       | `#34d399` |
| Innovation      | `#4ade80` |
| Animation       | `#f9a8d4` |
| Tech Writer     | `#22d3ee` |

---

## 4. Typography

- **UI font:** `"gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif`
- **Code font:** `ui-monospace, "Cascadia Mono", Menlo, monospace`
- **Sizes:** body 14.5 / titles 15–16 / metadata 11–12 / code 12.5
- **Line-height:** 1.55 (body), 1.45 (chat bubbles), 1.35 (round titles)

---

## 5. LEFT PANE — Chat + Sessions

### 5.1 Tabs

Two tabs in the header (replacing a generic title):
- **💬 Chat** (default)
- **# Sessions**

Active tab: 2 px bottom border in `--accent-brand`, text `--text-primary`.  
Inactive: text `--text-muted`.

### 5.2 Chat tab body

Scrollable feed, grouped by round with horizontal labeled dividers:

```
─── Round 1 · initial brick layout ───
🧙 Round 1 started → Sally, Paige, Winston   ← system bubble
[user bubble: "Let's start with the brick layout..."]
🧙 Round 1 closed. 3 contributions captured.

─── Round 2 · powerup system ───
...
```

**System bubbles (orchestrator):**
- Left-aligned, `rgba(167,139,250,0.1)` bg, `--accent-orch-2` text
- 6 px radius, 12 px font, italic, 6×10 padding
- Prefix with 🧙 emoji

**User bubbles:**
- Right-aligned, `--accent-brand` bg, white text
- 14 px radius (4 px on bottom-right corner)
- Show timestamp below in `--text-faint`, 10 px

### 5.3 Composer (sticky bottom)

- 8/12 px outer margin, `--bg-elevated` bg, 10 px radius
- `<textarea>` with no border, transparent bg, min-height 60 px, resize: none
- Bottom action bar: ＋ (attach), @ (mention), 📎 (file), then **Send** button
- Send button: `--accent-brand` bg, 6 px radius, "Send ↵"

### 5.4 Sessions tab body

Slack-style grouped channel list (no composer):
- "Active" group → current channel highlighted with `#404249` bg
- "Recent" group → other sessions
- "Agents available" group → small dot in agent accent + name

---

## 6. MAIN PANE — Debate stream

Header: `# brick-breaker · Round 3 · scoring system` (channel mark muted, round info gray).

Body order, top to bottom:

### 6.1 Question banner

```
┌────────────────────────────────────┐
│ [U]  USER ASKED · 2:47 PM          │
│      <user prompt text>            │
└────────────────────────────────────┘
```
- 24 px horizontal margin, `rgba(255,255,255,0.03)` bg, 10 px radius
- 28 px circular avatar with user initial, `--accent-brand` bg

### 6.2 Orchestrator opens (top container — strong)

```
┌────────────────────────────────────┐
│ 🧙  ORCHESTRATOR · BMad sets...    │  ← purple gradient header
│     4 agents weighing in    [⧉]    │
├────────────────────────────────────┤
│ <intro paragraph>                  │
└────────────────────────────────────┘
```
- 14 px radius, gradient `linear-gradient(180deg, rgba(167,139,250,0.18), rgba(167,139,250,0.05))`
- 1 px border `rgba(167,139,250,0.4)`
- Header band: `rgba(167,139,250,0.12)` + bottom border
- 32 px circular avatar (purple), 2 px border `--accent-orch`
- Title: 13 px, 700, uppercase, letter-spacing 0.6, `--accent-orch-2`
- Sub: 12 px, `#a89fc4`
- Copy button on right (see §8)

### 6.3 Agent cards

```
┌────────────────────────────────────┐  ← 4px top edge in agent accent
│ [📋] John  [Product Manager] 2:49 [⧉]│
│                                    │
│      <body content, 76px left pad> │
└────────────────────────────────────┘
```
- 24 px horizontal margin, `--bg-surface` bg, 12 px radius
- **Top edge:** 4 px tall, full agent accent color
- **Avatar:** 48 px square, 14 px radius, accent×33% bg, 2 px solid accent border, status dot at bottom-right (14 px green)
- **Name:** 16 px, 700, white
- **Role pill:** 12 px font, 600 weight, accent×22% bg, accent text, 10 px radius, 2/8 padding
- **Time:** right-aligned, 12 px, muted
- **Body:** padding `0 16px 14px 76px` (76 px aligns with avatar+gap)

### 6.4 Mid-round orchestrator notes

Smaller interjections between agent cards:

```
   🧙 ORCHESTRATOR · sally → mary
   <handoff text in italic>
```
- Left margin 76 px, right margin 60 px
- `rgba(167,139,250,0.06)` bg, 1 px border `rgba(167,139,250,0.2)`, 10 px radius
- 22 px small avatar, 13 px italic body
- Eyebrow label: 11 px, uppercase, letter-spacing 0.6, `--accent-orch`

### 6.5 Orchestrator closes (bottom container — softer)

Same structure as 6.2 but with reduced opacity (`rgba(167,139,250,0.05)` bg) and title "Orchestrator · closes Round N".

---

## 7. RIGHT PANE — Rounds

Header: "Rounds" (left) · "{N} total" (right, muted).

### 7.1 Round card

```
┌──────────────────────────────────┐
│ ● Round 3              now       │  ← live: green pill + dot
│ Make scoring more competitive    │
│ 🧙📋🎨📊🧪                        │  ← stacked overlapping avatars
│ 5 agents · 8 turns               │
└──────────────────────────────────┘
```

- 12 px padding, 10 px radius, 8 px bottom margin
- **Status badge:** 10 px font, 700, uppercase, 10 px radius, 2/7 padding
  - Live: `rgba(74,222,128,0.18)` bg, `--accent-live` text, green border, ● prefix
  - Done: `rgba(255,255,255,0.06)` bg, `--text-muted` text
- **Time-ago:** right-aligned in head row, 11 px muted
- **Title:** 13 px, 600, white, 2-line clamp
- **Participant strip:** 22 px circles, 2 px border in `--bg-surface` (creates the overlap effect), `-4 px` margin-left for stacking
- **Meta:** 11 px muted, "X agents · Y turns"
- **Active state:** `rgba(88,101,242,0.12)` bg, blue border
- **Click:** swap entire main pane content to that round

---

## 8. Copy button (icon-only)

Reusable component, placed on every container that contains agent or orchestrator content.

- 28×28 px button, 6 px radius
- Default: `rgba(255,255,255,0.04)` bg, `rgba(255,255,255,0.06)` border, `#b5bac1` icon
- Hover: `rgba(255,255,255,0.1)` bg, white icon
- Confirmed (1.4s): `rgba(35,165,90,0.18)` bg, green border, checkmark icon
- **Title attr:** "Copy" / "Copied"

### Icons (14 px SVG, stroke 1.5)

```svg
<!-- Copy -->
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="5" width="9" height="9" rx="1.5" />
  <path d="M3 11V3a1 1 0 0 1 1-1h7" />
</svg>

<!-- Check (stroke 2) -->
<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 8.5l3.5 3.5L13 4.5" />
</svg>
```

### Copy payload format (plain text)

```
{Agent Name} ({tagline})
────────────────────────────────────────

{paragraph or block text — markdown stripped to plain}

## {heading}

• {bullet}
1. {numbered}

> {blockquote}

```{lang}
{code}
```

{table as pipe-delimited markdown}
```

---

## 9. Content blocks (used in agent bodies)

Agent message body is an array of typed blocks. Renderer must support all of:

| Type | Shape | Render |
|---|---|---|
| `p`     | `{ text }`            | `<p>` with inline markdown |
| `h`     | `{ text }`            | Bold heading, 14.5 px, white |
| `ul`    | `{ items: [] }`       | Bulleted list |
| `ol`    | `{ items: [] }`       | Numbered list |
| `quote` | `{ text }`            | Left-border blockquote, dark inset bg |
| `code`  | `{ lang, text }`      | Code block (see §9.1) |
| `table` | `{ headers, rows }`   | See §9.2 |
| `image` | `{ alt, caption }`    | Image with caption (see §9.3) |

### 9.1 Code block

- 1e1f22 bg, 8 px radius, monospace 12.5 px
- Header band: 6/12 padding, `#171819` bg, language label left, copy icon right
- Body: 12/14 padding, `#f2f3f5` text, `white-space: pre`, `overflow: auto`

### 9.2 Table

- 8 px radius, `#1e1f22` bg, full width
- TH: `#171819` bg, 11 px uppercase, letter-spacing 0.4, muted color
- TD: 8/12 padding, 13 px, top border `--bg-surface`

### 9.3 Image

- 10 px radius, 1 px border `rgba(255,255,255,0.08)`
- Use real image when available; fallback: 140 px striped placeholder with `[ image · {alt} ]` label
- Caption below: 12 px, muted, faint bg band

### 9.4 Inline markdown

Supported tokens: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`.

- `inline-code`: `#1e1f22` bg, 1/5 padding, 3 px radius, `--inline-code` color, 0.88 em
- `inline-link`: `--inline-link` color, no underline default, underline on hover

---

## 10. Data model

```ts
type AgentId = 'bmad' | 'mary' | 'john' | 'sally' | 'winston' | ...;

interface Agent {
  id: AgentId;
  emoji: string;       // or icon URL
  name: string;
  tagline: string;     // role
  accent: string;      // hex
}

type Block =
  | { type: 'p' | 'h' | 'quote'; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'image'; alt: string; caption?: string };

interface AgentMessage {
  speaker: AgentId;
  blocks: Block[];
  timestamp?: string;
}

interface OrchestratorNote {
  short: string;       // eyebrow label, e.g. "Sally → Mary"
  text: string;        // body
  afterIdx: number;    // appears after messages[afterIdx]
}

interface Round {
  id: string;          // 'r1', 'r2', ...
  n: number;           // 1, 2, ...
  status: 'active' | 'done';
  when: string;        // 'now' | '14 min ago'
  title: string;
  user: { name: string; text: string; timestamp: string };
  intro: { speaker: 'bmad'; text: string };  // orchestrator opens
  midNotes: OrchestratorNote[];
  messages: AgentMessage[];
  outro: string;       // orchestrator closes
}

interface ChatMessage {
  kind: 'self' | 'sys';
  text: string;
  round: string;       // round id this belongs to
  time?: string;
}
```

---

## 11. State

```ts
{
  activeRoundId: string;     // default: latest active round
  leftTab: 'chat' | 'sessions';
  paneSizes: { left: number; right: number };  // persisted
  draftMessage: string;
}
```

- **Round switch:** clicking a round in the right pane sets `activeRoundId`. The main pane re-renders fully (question banner → orchestrator open → messages + mid-notes → orchestrator close).
- **Chat & rounds are independent:** sending a message in the left pane does NOT navigate rounds. The message is appended to chat history with the current `activeRoundId`.

---

## 12. Streaming / live behavior

- **Active round** shows live green ● badge in the right rail.
- **Last agent in active round** shows a typing indicator beneath its card: 3 pulsing dots in agent accent (1.4s ease-in-out).
- **Status dot** on each agent avatar: green = currently in this turn; gray = done.
- Orchestrator mid-notes appear with a soft fade-in (200 ms) when their turn arrives.

---

## 13. Accessibility

- All copy buttons have `aria-label="Copy {agent name}'s message"` and a tooltip via `title`.
- Round cards are `<button>` with `aria-pressed={isActive}`.
- Color-on-color meets WCAG AA (4.5:1) for body text on `--bg-surface`.
- Resize dividers: `role="separator"`, `aria-orientation="vertical"`, keyboard support (←/→ to nudge by 8 px).
- Focus rings: 2 px solid `--accent-brand` on all interactive elements.

---

## 14. Empty / loading / error

- **No rounds yet:** main pane shows a centered "Start a debate" CTA + suggested prompts.
- **Round loading:** skeleton agent cards (3 placeholders, shimmer animation).
- **Stream error:** orchestrator close container with red accent + "Retry" button.

---

## 15. Open questions for product

1. Should chat in the left pane be **per-session** (scoped to current channel) or **global** across sessions?
2. When user sends a message during an active round, does it interrupt the round or queue for the next?
3. Are reactions / threads on agent messages in scope for v1?
4. Should mid-round orchestrator notes be **collapsible** to reduce visual noise on long rounds?
5. Cap on rounds shown in the right rail (paginate after N=20)?

---

## 16. Reference implementation

See `v2-discord.jsx` in this project for a working React reference covering all of the above. Key components to lift:

- `V2()` — top-level layout, resize state, round switching
- `V2AgentCard` — agent card structure
- `CopyButton` — icon-only with confirm state
- `useDragResize` / `useDragResizeReverse` — pane resize hooks
- `V2Block` — block-type renderer
- `blocksToPlainText` — copy payload generator
