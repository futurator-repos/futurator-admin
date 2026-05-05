# Party Mode — Claude Output Format Reference

**Audience:** designers and engineers redesigning the Party Mode chat UI.
**Purpose:** show *exactly* what text Claude produces today (verbatim), the structural patterns we have to render, and the constraints from the streaming pipeline. Use this as the spec when proposing visual/UX improvements — no insider context required.

---

## 0. TL;DR

Party Mode is a multi-agent chat: the user types one message, Claude responds with N agents (typically 3-5) in a single output stream. Each turn looks like:

1. A short BMad Master intro (welcomes the user, prints a roster table, names which agents are joining).
2. N agent contributions, one after another, each prefixed by `<emoji> **Name:**`.
3. An `**Orchestrator Note:**` summary at the end (sometimes).

The stream is **all one continuous text body** — separated into sections by `---` rules and bold-colon headers, but with **no machine-readable boundary markers** today. That's what makes the rendering hard. (See §6 for the planned fix.)

---

## 1. Real example #1 — "How do I make my game more competitive?"

This is the **complete verbatim output** from a real session (`8c7dce30-c1e6-459b-b8c2-713cc8afc6ca`, 2026-04-24, brick-breaker plan, turn 1). Raw text from the daemon, no editing. **Length: 6,301 characters.**

### User input

```
I want to create a scoring system for this game, help me find a great way to make it more competitive
```

### Claude output (verbatim)

> Now let me get a quick overview of the current game code.Welcome to **Party Mode**, Ubuntu! Here's your agent roster:
>
> | Icon | Name | Role |
> |------|------|------|
> | 📊 | Mary | Strategic Business Analyst |
> | 📋 | John | Product Manager |
> | 🎨 | Sally | UX Designer |
> | 🏗️ | Winston | System Architect |
> | 💻 | Amelia | Developer Agent |
> | 📚 | Paige | Technical Writer |
> | 🧪 | Rick | Innovation Disruptor |
> | ⚡ | Sue Render | Animation Architect |
> | 🎼 | Ludwig | Orchestration Architect |
>
> Your brick-breaker game already has a basic scoring system (10 points per brick destroyed). Let's get some perspectives on how to make it truly competitive. I'm bringing in **John** (product thinking), **Sally** (UX/feel), **Mary** (competitive analysis), and **Rick** (wild ideas) for this first round.Here are your four perspectives:
>
> ---
>
> 📋 **John:**
>
> Let me stop you right before we start throwing features at this. *Why* do you want it more competitive? Who are you competing against?
>
> That question matters enormously because the answer splits into two very different product directions:
>
> **If it's single-player competition** (beat your own best score, climb a personal leaderboard):
> The job-to-be-done is "give me a reason to play one more round." The smallest thing that validates this? A persistent high score with a streak multiplier. Dead simple, high motivation. Here's what I'd actually ship first:
>
> - **Combo multiplier** — consecutive brick hits without missing rack up a multiplier (x2, x3, x4). This rewards skill, creates tension, and costs almost nothing to implement.
> - **High score persistence** (localStorage) — gives the player something to beat next session.
>
> **If it's multiplayer competition** (beat other people):
> That's a completely different product. You need a backend, identity, leaderboards. Way more scope. Don't go here unless you've validated players actually want to compare scores with strangers.
>
> My strong recommendation based on Jobs-to-be-Done: **ship the combo multiplier first.** It directly rewards the core skill loop (keeping the ball in play, hitting chains of bricks), makes every second of gameplay feel consequential, and you can measure if players are actually playing longer or replaying more often.
>
> **Three questions before anyone writes a line of code:**
> 1. Are players currently replaying levels, or quitting after one attempt?
> 2. Is the frustration point the scoring feeling meaningless, or the difficulty curve?
> 3. Do you have any data on where players drop off?
>
> ---
>
> 🎨 **Sally:**
>
> Let me paint you a picture. Imagine two players sitting side by side, both finishing Level 2. One player methodically cleared every brick, taking their time. The other was frantic, chaining combos, barely surviving. Right now, your game gives them nearly the same score. That's not competitive — that's just arithmetic.
>
> **The Core Problem With "10 Points Per Brick":** It rewards *completion*, not *skill*. Competitive scoring needs to reward *how* you play, not just *that* you played.
>
> **What I'd Recommend (in layers, so you can ship incrementally):**
>
> - **Layer 1 — Combo Multiplier** (highest impact, simplest to build): Every brick hit in rapid succession multiplies your score. Miss the ball or let the combo timer expire, and it resets. The stress IS the fun.
> - **Layer 2 — Speed Bonus:** Reward players who clear levels faster. A countdown timer bonus gives competitive players a concrete target to race.
> - **Layer 3 — Accuracy / Style Points:** Hitting multi-hit bricks with precise angles could award bonus points. Rewards mastery.
> - **Layer 4 — Leaderboard / High Score Persistence:** Even a simple local high score display with initials changes behavior dramatically.
>
> **The UX Moment That Matters Most:** When a combo breaks — when the ball slips past — the score flash should *show the player what they lost*. "You were on a 5x combo" creates the itch to try again. That's the loop that makes games competitive.
>
> ---
>
> 📊 **Mary:**
>
> The current flat 10 points per brick is essentially leaving competitive tension on the table. Here's what the evidence from successful arcade games tells us:
>
> | Priority | Feature | Competitive Impact | Complexity |
> |----------|---------|-------------------|------------|
> | Must-Have | Combo multiplier | Very High | Medium |
> | Must-Have | Lives bonus at level end | High | Low |
> | Should-Have | Time bonus | High | Low |
> | Should-Have | Brick tier scoring | Medium | Low |
> | Nice-to-Have | Precision zone bonuses | Medium | High |
>
> **The Real Insight:** Competitiveness isn't just about higher numbers — it's about *visible feedback loops*. The score display needs to show the current multiplier, combo streak, and time.
>
> ---
>
> 🧪 **Rick:**
>
> Look, Morty, your current scoring system is a participation trophy. *burrrp*
>
> **Combo Multipliers.** GREAT SCOTT, it's so obvious. Every consecutive brick hit *without the ball touching the paddle* increases a multiplier — x2, x3, x4... The moment that ball touches your paddle, combo resets.
>
> **Speed Bonus.** Reward aggressive play. The faster the ball is moving when it hits a brick, the more points. You already have paddle angle reflection physics, so you're *halfway there*.
>
> **Time pressure decay.** Points per brick *decrease* over time. Clock's ticking, Morty.
>
> The implementation is embarrassingly simple — track `consecutiveHits`, `ballSpeed` (you already have this), and `levelTimer`. Stack those multipliers and suddenly your flat-score game rewards mastery, not just completion.
>
> Don't build a database. Don't build a leaderboard server. Ship a local high-score array in `localStorage` first. Five entries. Done. Delete the flat scoring. Ship the multiplier. Everything else is overthinking it.
>
> ---
>
> **Orchestrator Note:** Strong consensus across all four agents on **combo multiplier** as the highest-impact, lowest-effort first move. Interesting divergence on the second priority — Sally and Mary lean toward time bonuses, Rick wants speed-based scoring tied to existing physics, and John wants to validate player behavior before building anything else. Worth exploring which direction resonates with you. Want to dig deeper into any of these ideas, or should we bring in Sue Render to talk about how to make the scoring *feel* satisfying with animation and feedback?

---

## 2. Real example #2 — "Suggest level designs"

Same plan, different turn (`0b0071c9-54a3-417c-8788-02fbe3e2a6f2`, 2026-04-24, length **6,640 chars**). Shorter excerpt to show the variation.

### User input

```
Help me design more levels for the brick-breaker game
```

### Notable differences from example #1

- The intro paragraph is **glued directly** to the first agent header with no whitespace at all: `...Sue (visual/motion flair).🎨 **Sally:**`. Worst case for any naive splitter.
- Sally's body contains a **section heading** that mimics an agent header pattern — `**Mechanical opportunities I'd explore:**`. Same shape as `**Name:**`.
- Sue Render's body ends with `**My hot take:**` — also matches the speaker pattern. **This is the exact text that the current parser misreads as a fake "MT" agent in the chat UI.**
- Roster table is the same as example #1 but with slightly different role labels (e.g. "Architect" vs "System Architect"). The table is generated freshly each turn.
- Final orchestrator note uses the same `**Orchestrator Note:**` pattern.

---

## 3. Structural patterns observed

Distilled from both examples + 4 more I sampled but didn't include verbatim.

### 3.1 Top-level skeleton

```
[BMad Master intro paragraph — 1-2 sentences, conversational]

[Markdown roster table: | Icon | Name | Role |]

[Routing paragraph: which agents are being brought in for this turn,
 with their names in **bold**]

[Optional micro-line like "Here are your four perspectives:"]

---

<emoji> **<AgentName>:**

[Agent body — usually 200-800 words of markdown]

---

<emoji> **<NextAgentName>:**

[next agent body]

---

[... repeat per agent ...]

**Orchestrator Note:** [1-3 sentence summary, optional next-step question]
```

### 3.2 Agent header anatomy

Every per-agent header is one of these forms (sampled from real output):

```
🎨 **Sally:**
🧪 **Rick:**
📋 **John:**
📊 **Mary:**
⚡ **Sue Render:**
🏗️ **Winston:**
🔬 **Dr. Quinn:**
🎼 **Ludwig:**
```

Notes:
- **Always emoji + space + bold-name + colon-bold-close**, on its own line.
- **No close marker** (no `</agent>`) — the next header (or end of message) terminates.
- The emoji always matches the agent's roster icon (see §4).
- Multi-word names (`Sue Render`, `Dr. Quinn`, `Dave ups!`, `Sean Tinel`, `BMad Master`) appear as-is inside the bold.

### 3.3 Body patterns inside an agent message

What agents put under their header (frequencies are eyeballed across ~20 real turns):

| Element | Frequency | Example |
|---|---|---|
| Paragraphs (1-3 sentences) | every message | Free prose |
| Bolded section headers `**Topic:**` | very common | `**The Core Problem:**` ← collides with header pattern |
| Bulleted lists (`-`) | very common | `- **Combo multiplier** — explanation` |
| Numbered lists (`1.`) | common | Three-question lists, prioritized recommendations |
| Inline `code` | common | `localStorage`, `consecutiveHits` |
| Fenced ``` ``` ``` blocks | occasional | Mostly when Architect/Dev agents respond |
| Markdown tables | occasional | Mary often uses them; see §1 example |
| Blockquotes `>` | rare | |
| Links `[text](url)` | rare | |
| Italics `*emphasis*` | very common | `*burrrp*` for Rick, `*motion*` for Sue |
| Em-dashes `—` | very common | Heavy stylistic use |
| Horizontal rules `---` | between agents only | Used as visual separator |
| Per-agent stylistic tics | varies | Rick: `*burrrp*`, "Morty", "GREAT SCOTT". Sue: nature/speed metaphors. Sally: "Let me paint a picture". |

### 3.4 Length characteristics

From a sample of 6 turns:

- **Whole-turn length:** 4,500 - 8,500 chars (typical: ~6,500).
- **Per-agent body:** 600 - 1,800 chars.
- **Number of agents per turn:** 3-5 (typically 4).
- **Number of stream chunks per turn:** 1-3 (yes, only ONE to THREE — Claude buffers heavily, so the user does NOT see token-by-token streaming today; they see one or two large drops).
- **Time-to-first-chunk:** typically 5-20 s (Claude cold start + tool exploration).
- **Total turn duration:** typically 90-180 s.

### 3.5 Orchestrator note

Always at the very end. Patterns observed:

- Bold prefix: `**Orchestrator Note:**` (sometimes `**BMad Master:**` instead).
- Body: 1-3 sentences summarising convergence/divergence across the agents.
- Often ends with a leading question to the user ("Want to dig deeper on…?", "Should I bring in Amelia next?").
- Rendered slightly differently from agent messages — currently treated as just another bold-colon line, but design-wise should probably be visually distinct (it's the "moderator").

### 3.6 First-message vs follow-up turn

- **Turn 1** (no prior context): always opens with the BMad Master intro + roster table.
- **Turn 2+** (resume): often skips the roster table, goes straight to picking agents. Less verbose preamble.
- The roster table at turn 1 is informationally redundant with the avatar rail in our UI — design question: do we still want to render it, or hide/collapse it?

---

## 4. Agent roster — full reference

The 23 agents currently installed per project (6 stock BMAD + 8 custom from this repo + 9 stock BMM/CIS/etc). Source of truth: `bmad/_cfg/agent-manifest.csv` per project.

| Emoji | Display name | Role | Accent (hex) | Communication style |
|---|---|---|---|---|
| 🧙 | BMad Master | Orchestrator | `#a78bfa` violet | Direct, third-person, numbered lists |
| 🧙 | BMad Builder | BMad Builder | `#a78bfa` violet | Pulp super-hero voice |
| 📊 | Mary | Business Analyst | `#60a5fa` blue | Analytical, evidence-driven |
| 🏗️ | Winston | Architect | `#fbbf24` amber | Architectural metaphors, pragmatic |
| 💻 | Amelia | Developer | `#34d399` emerald | Succinct, checklist-driven |
| 📋 | John | Product Manager | `#38bdf8` sky | Probing questions, JTBD |
| 🏃 | Bob | Scrum Master | `#fb923c` orange | Process-oriented |
| 🧪 | Murat | Test Architect | `#e879f9` fuchsia | Risk-based, data-driven |
| 📚 | Paige | Technical Writer | `#22d3ee` cyan | Patient, clear examples |
| 🎨 | Sally | UX Designer | `#f472b6` pink | Storytelling, "let me paint a picture" |
| 🧠 | Carson | Brainstorming Coach | `#facc15` yellow | Energetic, encouraging |
| 🔬 | Dr. Quinn | Problem Solver | `#2dd4bf` teal | Detective + scientist, "Aha!" moments |
| 🎨 | Maya | Design Thinking | `#fb7185` rose | Jazz-like riffs, sensory metaphors |
| ⚡ | Victor | Innovation Strategist | `#eab308` yellow | Bold declarations, military metaphors |
| 📖 | Sophia | Storyteller | `#818cf8` indigo | Whimsical, flowery |
| 🎼 | Ludwig | Orchestration | `#c084fc` purple | "Show me the code" |
| 🪨 | Pedrock | AWS Bedrock | `#a8a29e` stone | Technical precision, anti-hype |
| 🔥 | Dave ups! | AWS DevOps | `#f87171` red | Industrial metaphors, blunt |
| 🔒 | Sean Tinel | AWS Security | `#a3e635` lime | Layers and attack surfaces |
| ☁️ | Nimbus | AWS Solutions Architect | `#7dd3fc` sky-light | Trade-off tables |
| 🚢 | Kube Rick | Containers | `#93c5fd` blue-light | Nautical metaphors |
| ⚡ | Sue Render | Animation | `#f9a8d4` pink-light | Speed + nature metaphors |
| 🧪 | Rick | Innovation Disruptor | `#4ade80` green | "*burrrp*", "Morty", "GREAT SCOTT" |

The full identity-to-color mapping lives at `src/components/labs/party/agent-identity.ts` if a designer wants to tweak palettes.

---

## 5. The current parser and why it produces fake agents

Source: `src/components/labs/party/session-chat.tsx` → `parseAssistantTokens()`.

### 5.1 Algorithm

```js
// 1. Concatenate all token events into one big string.
const merged = events
  .filter(e => e.eventType === 'party.turn.assistant.token')
  .map(e => e.text ?? '')
  .join('');

// 2. Split on blank lines.
const parts = merged.split(/\n\n+/);

// 3. For each paragraph, see if it starts with **Name:**.
for (const part of parts) {
  const m = part.match(/^\*\*([^:*]+):\*\*\s*([\s\S]*)$/);
  if (m) {
    blocks.push({ speaker: m[1].trim(), text: m[2] });
  } else {
    // Append to the previous block.
  }
}
```

### 5.2 Why this produces wrong output

Three failure modes confirmed in production:

**Failure mode 1 — Glued boundary.** When the intro paragraph runs directly into the first agent header:
```
...for this first round.Here are your four perspectives:

---

📋 **John:**
```
Splitting on `\n\n+` produces a paragraph containing `📋 **John:**`. The regex `^\*\*([^:*]+):\*\*` requires `**` to be the very first characters — the leading emoji `📋 ` defeats it. **John never gets recognised** in this case.

**Failure mode 2 — Bolded section header.** Sue Render's body ends with `**My hot take:**`. After the previous `\n\n` split, "My hot take" matches the regex perfectly. **A fake speaker called "My hot take" appears as its own avatar in the UI**, with the content of Sue's tail attributed to it.

**Failure mode 3 — Orchestrator Note.** `**Orchestrator Note:**` matches identically. **A fake "Orchestrator Note" speaker appears**, when really it should be a system-level moderator card visually distinct from agents.

These are the visible bugs in the current chat. The fix is structural (see §6).

---

## 6. Planned future format — `⟪AGENT:Name⟫` markers

Once we ship the format-contract change, Claude will be instructed (via `--append-system-prompt`) to use:

```
⟪AGENT:Sally⟫
[markdown body]

⟪AGENT:Rick⟫
[markdown body]

⟪SYSTEM⟫
[orchestrator note]
```

Properties:
- Marker is always on its own line.
- Unicode brackets `⟪` (U+27EA) and `⟫` (U+27EB) — never appear in normal text or code.
- Open-only (no `</agent>` close marker) — next marker terminates the previous block.
- `Name` is one of the 23 roster names. Anything else is rejected (treated as section heading).
- `⟪SYSTEM⟫` carves out a distinct visual lane for the moderator/orchestrator.

The body inside is still markdown — bold, italic, code blocks, tables, blockquotes, lists, links — all rendered exactly as today. **Designers should design for the marker world**, since:
- It's deploying soon.
- Old sessions get rendered through a backwards-compat fallback (roster-validated `**Name:**` matching), which produces the same visual structure.

What changes in the rendered DOM:
- Each `⟪AGENT:Name⟫` block becomes one `<PartyMessage>` card.
- Each `⟪SYSTEM⟫` block becomes one `<SystemCard>` (different styling — more muted, smaller).
- The intro/roster-table content (everything before the first marker) becomes one `<SystemIntro>` block.

---

## 7. Streaming pipeline constraints (for animation/perf design)

Things that affect "feel" beyond the static format:

- **Claude doesn't truly token-stream.** What looks like 73 events in DDB is mostly tool-use noise (Glob, Read, Bash) — only **3 of those are actual text deltas**, and they're **multi-thousand-character chunks**. The user typically sees 1-3 large "drops" of content, not a continuous typing animation.
- **Frontend polls every 600 ms while session is PROCESSING**, every 2 s when idle (`useSessionEvents` in `src/hooks/use-party-session.ts`). So a chunk can take up to 600 ms after Claude emits it to appear on screen.
- **No reordering**. Events arrive in monotonic `eventSeq` order. Any UI animation can assume append-only.
- **Time to first paint** ranges from 5-20 s after the user sends. This is mostly Claude's cold start + the first tool calls (Glob/Read of the project). UX-wise this is the "thinking…" window — the most important moment for a good loading affordance.

Implications for design:
- Token-by-token typing animations would be misleading — content arrives in lumps.
- A "still thinking, agents reading the codebase" indicator that lasts up to 20 s is the bigger UX problem than mid-stream rendering.
- When a chunk lands, scroll-pinning and "new message" affordances matter more than typewriter effects.
- Per-agent message size is **substantial** (600-1,800 chars). Design must read well at sustained reading lengths, not optimise for short snappy messages.

---

## 8. Information architecture — what should the UI surface?

For each turn, the renderer needs to handle:

1. **System intro** (1-3 paragraphs, optional roster table, routing announcement).
2. **N per-agent messages** in markdown, each attributable to a known roster member.
3. **Orchestrator note** at the end (1-3 sentences, often a question).
4. **Per-message metadata** the design might want to surface:
   - Speaker name + role + emoji + accent color.
   - Approximate time received (hard since chunks land in lumps — could just say "just now").
   - Word count or read-time estimate (helpful for long agent essays).
   - Any quoted code/files (for jumping back to source).

Things the UI does NOT need to render:
- Tool-use events (Glob, Read, Bash) — they're internal to Claude's reasoning, not user-facing.
- Rate-limit warnings (separate badge if needed).
- The system_init event (just used to capture Claude session ID).

---

## 9. Files / source-of-truth pointers

For the designer-engineer pair-up:

- **Where the chat renders:** `src/components/labs/party/session-chat.tsx`
- **Per-message component:** `src/components/labs/party/party-message.tsx`
- **Rich markdown renderer:** `src/components/labs/party/rich-text.tsx`
- **Avatar:** `src/components/labs/party/avatar.tsx`
- **Agent identity (emoji+color+role):** `src/components/labs/party/agent-identity.ts`
- **Existing prototype HTML/CSS work:** `docs/concepts/party-ui/party-mode/` (sibling directory — has a 411-line CSS prototype + JSX mockups)
- **Where Claude is invoked (will gain `--append-system-prompt`):** `daemon/pipelines/party-turn.mjs`
- **Format-contract proposal:** §6 of this doc + future PR

---

## 10. Open design questions

For the UI agent / designer to chew on:

1. **Containment** — Slack-leaning (subtle, left-stripe in agent color, transparent body) or Teams-leaning (full card, rounded, distinct background per agent)? Reading-length-wise, Slack scales better; identity-wise, Teams pops harder.
2. **System intro + roster table** — render them at all, or hide behind a "Show context" disclosure since the avatar rail already tells you who's in the room?
3. **Orchestrator note** — visually distinct from agents (centered? muted card? different left border?) or the same treatment with `⟪SYSTEM⟫` styling?
4. **Loading state** — what does the 5-20 second cold-start window feel like? A typing-dots-on-the-rail? A "Mary is reviewing the code…" status? Avatar-shimmer?
5. **Per-message density** — agent messages are *long* (600-1,800 chars). Do we offer a "collapse all but last 3" mode for long sessions? Per-agent filter?
6. **Mobile / narrow viewports** — out of scope for now but worth noting: today's UI assumes ~900px+ width. Avatar rail could collapse to a horizontal strip.
