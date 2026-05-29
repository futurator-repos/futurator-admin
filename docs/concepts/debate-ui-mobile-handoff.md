# Debates / Party-Mode UI — Mobile Port Handoff

**Audience:** the UI agent porting the debates experience to the mobile app.
**Purpose:** describe the six debate-UI enhancements shipped on `admin.futurator.ai`
so they can be reimplemented on mobile with matching behavior and the _same backend
contracts_ (no API changes needed — the endpoints below are live in production).

**Reference implementation (web):** `src/components/labs/party/` (especially `v2/`),
entry at `src/app/debates/page.tsx` → `src/components/labs/party/v2/session-chat-v2.tsx`.
**Backend:** single Hono app at `functions/api/index.ts`, routes prefixed `/api`.
**Date:** 2026-05-29.

> The web UI is inline-style + CSS-variable driven and uses `position: fixed`
> overlays. A React Native port **cannot** reuse the CSS or the DOM-rect math —
> port the _contracts and behaviors_ here, and reimplement overlays with native
> modal/sheet primitives. File:line references are given so you can read the
> exact web logic when in doubt.

---

## 0. Shared concepts (read first)

- **Session vs project:** a debate is a _session_ (`sessionId`, a UUID) inside a
  _project_ (`projectId`, a kebab slug). Most reads are session-scoped.
- **Two distinct "document" concepts — do not conflate:**
  1. **Uploaded docs** (doc-tray) — context files the _operator_ attaches to a
     debate. Session-scoped or project-shared. (Features 4B, 4C.)
  2. **Agent-generated artifacts** — files the _agents_ write during the debate,
     surfaced as **checkpoint cards** and opened via the **file drawer**.
     (Features 4A, 5, 6.)
- **Round anchoring:** each round is a DOM node with `data-round-anchor={round.id}`
  and agent blocks carry `data-agent-name`. Round IDs are formatted `r-<n>`.
  Selection-to-ask and jump-to-answer both depend on this anchoring — replicate
  an equivalent scheme on mobile (e.g. a ref/registry keyed by round id).
- **Auth:** Bearer JWT in the `Authorization` header (no cookies). Same as the
  rest of the app.

---

## 1. Light / Dark theme corrections

**What it does (UX):** earlier the chat used a fixed dark Discord palette, so in
light mode dark text sat on dark surfaces (unreadable). Now every party surface
is theme-aware and flips with the app's light/dark toggle. The whole surface is
treated as a "command center" — panes, tool-call cards, drawers, and message
bubbles all theme together, not just the message bubbles.

**How it works (web):** `tokens.ts` `COLORS` holds **CSS-variable references**
(strings like `'var(--party-bg-surface)'`), not hex. The hex values live once in
`globals.css`, split between `:root` (light) and `.dark` (dark). Components apply
them via inline `style`, so toggling the `.dark` class re-resolves everything.

**Port this:** build a theme object keyed by `light`/`dark` from the table below
and resolve colors at render. (Lower index = darker in _both_ modes, so dividers
stay visible.)

| Token (`--party-*`) | Light     | Dark (Discord) |
| ------------------- | --------- | -------------- |
| `bg-deepest`        | `#d8dade` | `#1e1f22`      |
| `bg-surface`        | `#eef0f3` | `#2b2d31`      |
| `bg-content`        | `#ffffff` | `#313338`      |
| `bg-elevated`       | `#ffffff` | `#383a40`      |
| `bg-input`          | `#ffffff` | `#1e1f22`      |
| `text-primary`      | `#0a0b0f` | `#f2f3f5`      |
| `text-body`         | `#1f2127` | `#dbdee1`      |
| `text-muted`        | `#52555d` | `#949ba4`      |
| `text-faint`        | `#6b6f78` | `#80848e`      |
| `accent-brand`      | `#4a6b92` | `#5865f2`      |
| `accent-orch-soft`  | `#6b4ea8` | `#c4b5fd`      |
| `inline-code`       | `#b45309` | `#f9a8d4`      |

Some accents reuse **global** tokens (not `--party-*`): orchestrator = `--accent-purple`,
live/success = `--success`, inline links = `--accent-blue`. Mirror those from the
app's existing global theme.

**Hover/snippet tints (theme-agnostic pattern):** instead of `bg-white/[x]`, the web
uses `color-mix(in srgb, <foreground> N%, transparent)` (≈6–8% for hover, 8% for
quoted snippets). On native, emulate with a low-opacity foreground overlay.

**Reference:** `tokens.ts:17-37`; `globals.css` light block `:root` ~144-157,
dark block `.dark` ~221-234; helper classes `.party-agent-card`, `.party-inline-code`,
`.party-hover-tint`, `.party-snippet-tint`, `.party-resize-handle`, `.party-link-file`,
`.party-mention`, `.party-quote` (all in `globals.css`). Consumers: `agent-card.tsx`,
`left-pane.tsx`, `round-rail.tsx`, `file-drawer.tsx`, `checkpoint-card.tsx`,
`inline-questions-list.tsx`, `selection-popover.tsx`.

---

## 2. Document processing (large-file read, no truncation)

**What it does:** lets the drawer show _complete_ large files. Previously a 58 KB
doc was cut at ~24 KB and an AWS marker `--output truncated--` leaked into the
displayed text. This is a **backend** concern — mobile gets the full content for
free through the same `/files` endpoint (Feature 6). Documented here so you know
why large docs now load (and may take a moment).

**How it works (web/backend):** `readFileChunkedViaSsm(filePath, size)`
(`functions/api/index.ts:~3888`) reads the file from EC2 over AWS SSM in
**12 000-byte chunks**, **4 in parallel**, base64-encoded, stripping the trailing
`--output truncated--` marker per chunk, then concatenates. SSM caps a single
command's stdout at 24 000 chars, hence chunking. ~60 KB ≈ 3 s; capped at 1 MiB
for text (413 over that). Used by the `/files` read and the binary/image EC2 read.

**Mobile note:** no client work required, but show a loading state — large docs
stream over several SSM round-trips.

---

## 3. Selecting text to ask questions ✅ (exists, fully wired)

**What it does (UX):** the operator selects any text inside the chat, a small
floating popover appears ("Ask a question"), they type a question scoped to that
selection, and an answer is generated inline (and saved to the right-rail
Questions list). This is **not** quote-to-composer — it's a focused Q&A about the
highlighted passage.

**How it works (web):** `src/components/labs/party/v2/selection-popover.tsx`,
mounted in `session-chat-v2.tsx` with a `scopeRef` to the chat content div.

- Listens on `document` `mouseup`; reads `window.getSelection()`; ignores
  collapsed/empty/`<2`-char selections and mouseups inside the popover.
- Requires both selection endpoints inside `scopeRef`.
- Walks up to `[data-round-anchor]` → `roundId` and `[data-agent-name]` →
  optional `agentName`; captures ±40 chars of surrounding context for
  disambiguation; snippet capped at 4000 chars.
- Positions with `position: fixed` from the selection's bounding rect (flips
  below if near the top).
- Modes `idle → composing → answering`. Submit = `⌘/Ctrl+Enter`; `Esc` dismisses.

**API contract:**

- **POST** `/api/party/sessions/:sessionId/inline-questions` → **201**
  - Body: `{ question: string, anchor: { roundId, agentName?, snippet, contextBefore, contextAfter } }`
  - Server calls Claude (`claude-haiku-4-5`, `max_tokens: 500`) with a cached
    system prompt, persists, and returns the full record:
    `{ questionId, sessionId, projectId, roundId, agentName?, snippet, question, answer, model, usage, createdAt, createdBy }`
  - Limits: `question ≤ 1000`, `snippet ≤ 4000`, context ≤ 80 each. 503 if the
    server's `ANTHROPIC_API_KEY` is unset.
- **GET** `/api/party/sessions/:sessionId/inline-questions` → `{ questions: InlineQuestion[] }`

**Right-rail list:** `inline-questions-list.tsx` — each row shows the question,
snippet preview, "Round N · agentName", relative time. Tap → jump to that round
(scroll + flash outline); expand → show the stored answer.

**Mobile port notes:** native text selection + a context action ("Ask") is the
natural equivalent of the popover. Keep the anchor payload identical so answers
persist and render in the same list. You need round/agent anchoring (Section 0)
to populate `anchor`.

**Reference:** `selection-popover.tsx`, `src/hooks/use-inline-questions.ts`,
`src/types/inline-question.ts`, `functions/api/index.ts` inline-questions routes,
`functions/shared/types/inline-question.ts` (constants).

---

## 4. Document generation

Two unrelated surfaces. Don't share code.

### 4A. Agent-generated artifacts → checkpoint cards

**What it does (UX):** when a debate round produces files, an in-chat card
summarizes the system-driven git checkpoint: a title, summary, branch, short
commit SHA, and (when pushed) an **Open PR** action + a **Start story-pipeline**
deep link.

**How it works (web):** `checkpoint-card.tsx`, rendered per round when
`round.checkpoint` exists. The daemon emits a checkpoint event after the round;
the turn adapter maps it to `RoundCheckpoint { kind, title?, summary?, branch?,
commitSha?, pushed, reason }`. Four `kind` variants:

- `composed` — committed locally, push gated off (neutral/purple).
- `pushed` — committed **and** pushed (green); shows **Open PR**.
- `blocked` — secrets scan blocked the commit (red).
- `failed` — checkpoint error (red).

**Open PR (only when `pushed` + project `pushEnabled`):**

- **POST** `/api/party/sessions/:sessionId/checkpoints/:sha/pr`
  - `:sha` must be 40-hex. Brownfield + `pushEnabled` required.
  - **Idempotent:** reuses an open PR with head `owner:branch`; else opens a
    **draft** PR `party/<id>/<short>` → canonical branch.
  - Returns `{ prNumber, prUrl, title, state, reused }`. After success the card
    shows "View PR ↗".
- **Start story-pipeline →** deep-links the plan-creation flow:
  `/labs?createPlanForApp=<projectId>&sourceCommitSha=<sha>&sourceBranch=<branch>`.

> Note: auto-PR can also happen server-side without the button when the project
> has the opt-in **`autoOpenPr`** flag on (toggled in the `/migrate` UI). The card
> button remains the manual/explicit path and reuses the same PR.

**Reference:** `checkpoint-card.tsx`, `turn-adapter.ts` (`RoundCheckpoint`,
`collectCheckpoint`), `src/hooks/use-party-audit.ts` (`useOpenCheckpointPr`),
`functions/api/index.ts` checkpoint-PR route.

### 4B. Uploaded docs — the doc-tray (session + shared scoping)

**What it does (UX):** a chip tray above the composer showing context docs.
**Session** docs ("This debate") are private to the session; **Shared** docs
("Shared", blue-tinted chip) are project-level and appear in _every_ debate of
the project. This fixed a leak where a previous debate's upload showed in a new
one. A dashed **"+ shared"** button uploads a project-level doc; the composer
paperclip uploads session-scoped. Each chip → tap to insert a
`./.party-uploads/<filename>` reference into the composer; X to delete.

**API contract:**

- **GET** `/api/party/projects/:projectId/docs?sessionId=<id>` →
  `{ projectId, sessionId, shared: PartyDoc[], session: PartyDoc[] }`
  where `PartyDoc = { filename, s3Key, size, uploadedAt, scope: 'session'|'shared' }`.
  (Omit `sessionId` to get shared-only — e.g. a project chooser.)
- **DELETE** `/api/party/projects/:projectId/docs/:filename?scope=<s>&sessionId=<id>`
  (session deletes require `sessionId`; shared deletes don't).

### 4C. Composer paperclip upload (3-step presigned flow)

Per file (defaults to `scope: 'session'`):

1. **POST** `/api/party/projects/:projectId/docs/upload-url`
   body `{ filename, contentType, scope, sessionId? }` →
   `{ uploadUrl, s3Bucket, s3Key, filename, scope }`.
2. **PUT** the raw bytes to `uploadUrl` (direct to S3).
3. **POST** `/api/party/projects/:projectId/docs/synced`
   body `{ filename, s3Key, scope, sessionId? }`.

**Accepted types:** `.md, .markdown, .txt, .pdf, .json, .csv, .yml, .yaml`
(MIME: `application/pdf, text/plain, text/markdown, application/json, text/csv,
text/yaml`). Filenames sanitized (`[^\w.\-]→_`, 200-char cap). Show per-file
`uploading | done | error` status while the 3 steps run.

> **Why `./.party-uploads/`:** S3 is the source of truth (session key
> `party-docs/<projectId>/_session/<sessionId>/<file>`, shared key
> `party-docs/<projectId>/_shared/<file>`). The daemon mirrors the union into the
> per-session worktree's `.party-uploads/` each turn so the agents' Read tool sees
> exactly this debate's docs — hence the inserted reference path.

**Reference:** `doc-tray.tsx`, `composer.tsx` (paperclip), `session-chat-v2.tsx`
`handleAttach`, `src/hooks/use-party-docs.ts`, `functions/api/index.ts` doc routes.

---

## 5. Links to documents (clickable paths → drawer)

**What it does (UX):** file paths the agents mention in chat (e.g.
`docs/recruiter-module-architecture.md`, `src/lib/foo.ts`) render as tappable
links; tapping opens the file in a drawer (Feature 6). Inline backtick code that
is exactly a file path is also tappable.

**How it works (web):** `rich-text.tsx` runs a regex over rendered text:

```
FILE_RE = /\b([\w./-]+\.(?:md|markdown|txt|ts|tsx|js|jsx|json|css|scss|html|py|go|rs|rb|java|kt|swift|c|cpp|h|sh|bash|zsh|yml|yaml|toml|xml|mjs|cjs|sql|env))\b/g
```

Binary formats (png/pdf/etc.) are deliberately excluded. A match becomes a button
that calls `openPath(rawPath)` from the `FileDrawer` context; the **raw,
project-relative path** is passed (no projectId/sessionId — the provider injects
those). The provider also enhances `@Mention` names via `MENTION_RE = /@([A-Z][a-z]+)/g`.

**Mobile port notes:** run the same regex over agent text when building rich
segments; render matches as pressable spans that call your drawer-open handler
with the raw path. Keep the extension allow-list identical so the same things are
linkified.

**Reference:** `rich-text.tsx` (`FILE_RE`, `enhanceString`, `code` renderer),
`file-drawer.tsx` (`FileDrawerProvider` / `useFileDrawer` / `openPath`),
provider wired in `session-chat-v2.tsx` with `projectId` + `sessionId`.

---

## 6. Document visualization (the file drawer)

**What it does (UX):** a right-anchored overlay that renders the file. Markdown is
rendered rich (and _its_ internal file links are themselves tappable, chaining);
other text renders as a syntax-highlighted code block. Header shows filename,
project-relative path, and size; there's a copy-to-clipboard button and close via
backdrop tap / Esc / X. On web it's horizontally resizable (drag the left edge,
persisted to `localStorage['partyMode.drawerWidth']`, default 680 px, min 360,
max 1200) — on mobile this is naturally a full-screen sheet/modal, so the resize
behavior can be dropped.

**THE KEY FIX for mobile correctness — pass `sessionId`:** agent-generated docs
live in the **per-session worktree**, not the legacy project folder. The read
endpoint resolves the base directory from the session's worktree _only when
`sessionId` is supplied_. **Always send `sessionId`** or generated-doc links 404.

**API contract:**

- **GET** `/api/party/projects/:projectId/files?path=<relPath>&sessionId=<id>`
  - `path`: project-relative, ≤500 chars, no `..`/null bytes, charset
    `[A-Za-z0-9._/\-]`.
  - Server base dir: `session.worktreePath || session.projectPath || project.path`
    when `sessionId` is valid for the project; else the legacy project folder.
  - Requires the EC2 instance `running` (else `400 EC2_NOT_RUNNING`).
  - **Response:** `{ path, fullPath, size, contentType: 'text/markdown' |
'application/json' | 'text/html' | 'text/plain', content }` (content ≤ 1 MiB).
  - Errors: `404` not found, `403` outside root, `413` too large.
  - Client retry: do **not** retry 404/403/413; otherwise 1 retry. `staleTime`
    ~30 s; cache key includes `projectId`, `sessionId`, `path`.

**Rendering rule:** if `contentType === 'text/markdown'` → render with the rich
markdown pipeline; otherwise wrap in a fenced code block with the file's
extension as the language hint and render via the code-block component (with its
own copy button).

**Reference:** `file-drawer.tsx` (`FileDrawer`, `FileBody`, resize logic),
`src/hooks/use-party-file.ts` (`usePartyFile(projectId, path, sessionId?)`),
`functions/api/index.ts:~7012` `/files` route (sessionId→worktree resolution +
two-phase SSM read + `readFileChunkedViaSsm`).

---

## Appendix — endpoint quick-reference

| Feature            | Method | Path                                                       | Notes                 |
| ------------------ | ------ | ---------------------------------------------------------- | --------------------- |
| Inline Q&A (ask)   | POST   | `/api/party/sessions/:id/inline-questions`                 | 201, returns answer   |
| Inline Q&A (list)  | GET    | `/api/party/sessions/:id/inline-questions`                 | right-rail            |
| Open PR            | POST   | `/api/party/sessions/:id/checkpoints/:sha/pr`              | idempotent draft PR   |
| Docs list          | GET    | `/api/party/projects/:id/docs?sessionId=`                  | `{ shared, session }` |
| Doc upload URL     | POST   | `/api/party/projects/:id/docs/upload-url`                  | presigned PUT         |
| Doc synced         | POST   | `/api/party/projects/:id/docs/synced`                      | finalize upload       |
| Doc delete         | DELETE | `/api/party/projects/:id/docs/:filename?scope=&sessionId=` |                       |
| File read (drawer) | GET    | `/api/party/projects/:id/files?path=&sessionId=`           | **send sessionId**    |

**Cross-cutting reminders for the port:**

- Preserve round/agent anchoring (`data-round-anchor` / `data-agent-name`
  equivalents) — selection-to-ask and jump-to-answer depend on it.
- Always thread `sessionId` to `/files` and `/docs` reads.
- Theming = a light/dark object (Section 1 table), not the web CSS.
- `fixed`-position overlays (drawer, selection popover) → native sheets/modals.
- Two separate "doc" concepts: checkpoint cards (agent output) vs doc-tray
  (operator uploads).
