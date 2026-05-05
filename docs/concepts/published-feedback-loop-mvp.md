# Published Feedback Loop — MVP (Bug Fixes Only)

**Status:** Draft for brainstorm.
**Date:** 2026-04-25.
**Scope of this doc:** the smallest possible change that closes the loop from "I found a bug in the live app" → "the bug is fixed live." Refinements and new-feature flows are explicitly **out of scope** for this MVP and discussed only at the end.

---

## 1. The motivating example

Brick Breaker is live at `https://futurator.ai/apps/brick-breaker/`. It ships:

- 11/11 stories done, 8/8 visual tests passing, AC 41/41, automated gate 30/30
- Plan `status = delivered`, all epics in `review`/`delivered`

While playing, the operator finds a real bug:

> **The ball does not bounce on the vertical axis when it hits a brick — it passes through or only reflects horizontally.**

This is unambiguously a regression against the Game Logic epic's collision-detection story. The fix is almost certainly a one-line change in a physics file (likely a missing `dy = -dy` branch). The current pipeline has **no path to take this report and ship a fix automatically.** The operator has to:

1. SSH or remember which story owned collision
2. Manually trigger send-back
3. Hope the dev agent picks the right file
4. Wait for QA
5. Manually re-deploy

We can do better. Target cycle time, end to end: **≤ 15 minutes from report to live.**

---

## 2. What's actually in the codebase today

Verified facts (file refs are authoritative; remove this section once acted on):

| Capability | Status | Reference |
|---|---|---|
| Story has comment / decisions / notes field | **No** — only `description`, `visualTests[]` | `functions/shared/types/epic-workflow.ts:112` |
| Dev agent emits structured decisions/tradeoffs | **No** — prompt asks for `<DEV_RESULT>` but nothing parses it | `daemon/pipelines/templates/dev-subagent-prompt.md.tpl:21` |
| Story-level send-back works | **Yes** — appends timestamped markdown to `story.description`, flips story + epic to `fixing`, re-launches | `functions/api/index.ts:2007–2058` |
| Plan-level `delivered → fixing` transition | **No** — pipeline is one-way at plan level | `functions/shared/types/plan.ts:17` |
| Operator-filed feedback type | **No** — `AttentionItem` is system-generated only (`retry-exhausted`, `test-gate-failed`, etc.) | `functions/shared/types/attention.ts:29` |
| Triage / routing agent | **No** | — |

**Two real gaps:** (1) no story-level memory of what the dev decided; (2) no entry point back into the pipeline once shipped. Everything else can be assembled from existing pieces.

---

## 3. The MVP — bug fixes only

### 3.1 What's in scope

- A single new operator action: **"Report a bug"** on the Published stage (and QA Review stage, since bugs can surface during manual testing).
- A new lightweight agent role: **Triage** (read-only — grep, read, git blame; no writes).
- Triage classifies and routes the bug to a specific story, drafts a remediation note, and proposes a `send-back` action.
- Operator clicks **Accept** to execute. Existing `send-back-to-dev` endpoint runs unchanged.
- Wave-completion cron (already exists) will auto-run QA and re-deploy when the fix completes.
- A new plan-status transition `delivered → fixing` is allowed; cron flips back to `delivered` on successful re-deploy.

### 3.2 What's out of scope (for this MVP)

- Refinements ("better animations") and new features ("5-hit bricks") — these need PM re-planning and/or new-story creation, which adds significant routing logic. **Phase 2.**
- Auto-accept (Triage applies decisions without operator click) — adds risk; we always require Accept in MVP. **Phase 2.**
- Visitor / dogfooder feedback widget injected into deployed apps. **Phase 3.**
- Back-fill of `devNotes` on existing stories. We move forward with new work only.
- Multi-bug batching (one feedback item = one fix loop in MVP).
- Plan-level metrics ("3 fixes shipped post-launch") — nice-to-have, not blocking.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  PUBLISHED STAGE (or QA Review)                                    │
│                                                                    │
│  [ Report bug ] ──┐                                                │
│                   │  POST /api/plans/:id/feedback                  │
│                   ▼                                                │
│             FeedbackItem (DDB) — status=pending                    │
│                   │                                                │
│                   │  Operator clicks "Triage now" (or auto)        │
│                   ▼                                                │
│             Triage agent job (PENDING → RUNNING → COMPLETED)       │
│             ─ reads plan.epics + story descriptions                │
│             ─ greps the working tree                               │
│             ─ git-blames suspect files                             │
│             ─ outputs: targetStoryId + draft remediation note      │
│                   │                                                │
│                   ▼                                                │
│             FeedbackItem.triageDecision populated                  │
│                   │                                                │
│                   │  Operator reviews → clicks "Accept"            │
│                   ▼                                                │
│             POST /api/plans/:id/feedback/:fid/accept               │
│             ─ plan.status: delivered → fixing                      │
│             ─ calls existing send-back-to-dev with the note        │
│             ─ FeedbackItem.status = in-fix                         │
│                   │                                                │
│                   ▼                                                │
│             Existing pipeline takes over                           │
│             ─ Dev agent re-runs the story                          │
│             ─ Reviewer runs                                        │
│             ─ Wave-completion cron auto-launches QA                │
│             ─ On QA pass + auto-deploy success:                    │
│                FeedbackItem.status = resolved                      │
│                plan.status: fixing → delivered                     │
└────────────────────────────────────────────────────────────────────┘
```

The orange path is **all new**. The blue path (post-Accept) is existing machinery — no changes.

---

## 5. The Triage agent

A new agent role registered alongside `Dev`, `Reviewer`, `QA`, `Deploy`. Same orchestration model: a Claude subprocess spawned by the daemon with allowed tools.

### 5.1 Tools

`Read, Grep, Glob, Bash` (for `git log`, `git blame`, `git show`). **No** `Edit` or `Write` — Triage is purely analytical.

### 5.2 Prompt sketch

```
You are Triage. A user reported a bug on a shipped app. You have:

- The plan's working tree at <workingDir>
- The plan's stories (titles, descriptions, acceptance criteria)
- The bug report (title + body + optional repro + optional screenshot URL)

Produce a single structured output (no prose around it):

---TRIAGE---
TARGET_STORY_ID: <storyId>
CONFIDENCE: <0-1>
REASONING: <2-3 sentences on how you concluded which story owns this>
DRAFT_NOTE: |
  <the markdown the dev agent will see when re-launched. Be specific
  about what's broken, what was expected, and (if you found it) the
  file/function most likely needing the change. Reference the story's
  original AC.>
---END_TRIAGE---

Investigation steps you should perform:

1. Read all story descriptions to understand which one OWNS the
   functional area mentioned in the bug.
2. Grep the codebase for symbols named in the bug (e.g. "collision",
   "brick", "ball", "vy"). Note the matching files.
3. For each candidate file, run `git log --oneline -- <file>` to find
   the commit that created or last changed it, then `git show <hash>`
   to see what story-job's session produced it. (Story IDs are in
   commit messages by convention.)
4. Cross-reference with the story acceptance criteria. If the AC
   explicitly covers the broken behavior, this is a regression and
   confidence is high. If the AC is silent on it, it's a missed-spec
   bug — confidence is medium and DRAFT_NOTE should suggest expanding
   the AC, not just patching code.

If you cannot identify a single owning story with confidence ≥ 0.5,
return TARGET_STORY_ID: UNKNOWN with reasoning, and the operator will
decide manually.
```

### 5.3 Why an agent, not a prompt-only LLM call

The Triage agent needs to **read the working tree** — that's why it must run via the daemon (which has shell access on EC2, where the repo lives). A prompt-only API call would have to be fed file contents up-front; the agent model lets Triage decide what to look at.

---

## 6. Data model changes

### 6.1 New table: `futurator-feedback-items`

```typescript
interface FeedbackItem {
  feedbackId: string;            // primary key
  planId: string;                // GSI for "list by plan"
  reporter: 'operator';          // visitor reporter is Phase 3
  kind: 'bug';                   // refinement|new-feature deferred
  title: string;
  body: string;
  capturedContext?: {
    url?: string;
    screenshotUrl?: string;      // S3 reference, optional
    userAgent?: string;
  };

  // Triage output (filled when triage job completes):
  triageJobId?: string;
  triageDecision?: {
    targetStoryId: string | 'UNKNOWN';
    confidence: number;
    reasoning: string;
    draftNote: string;           // exact markdown for send-back
  };

  // Operator action:
  acceptedAt?: string;
  acceptedAction?: 'send-back' | 'manual-edit-then-send-back' | 'reject';
  resolvedByJobId?: string;      // the dev re-run job
  resolvedAt?: string;

  status: 'pending' | 'triaging' | 'triaged' | 'in-fix' | 'resolved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}
```

### 6.2 Plan status transition

Currently: `delivered → archived` is the only legal next-state from delivered.
Add: `delivered → fixing → delivered` cycle.

In `wave-completion-check.ts`, when a fix-driven QA + deploy completes, transition `fixing → delivered` if the plan's `lastReason` was `feedback-fix`. Otherwise existing behavior unchanged.

### 6.3 No story-level changes (yet)

We don't add `story.devNotes` in MVP. Triage will work harder without it (read agent-events history, git blame). It'll be slower / lower confidence, but it'll work. **Adding `devNotes` is the highest-leverage Phase 2 follow-up** and will significantly improve Triage quality.

---

## 7. API endpoints (new)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/plans/:id/feedback` | Create FeedbackItem (operator submits bug) |
| `GET` | `/api/plans/:id/feedback` | List feedback items for a plan |
| `GET` | `/api/plans/:id/feedback/:fid` | Detail (with triage decision) |
| `POST` | `/api/plans/:id/feedback/:fid/triage` | Enqueue Triage agent job |
| `POST` | `/api/plans/:id/feedback/:fid/accept` | Accept triage → call send-back, transition plan to `fixing` |
| `POST` | `/api/plans/:id/feedback/:fid/reject` | Mark rejected with reason |

The `accept` endpoint is the only one that mutates plan/story state. It calls the existing `sendStoryBack()` logic with `triageDecision.draftNote` as the note payload — so the existing remediation flow is fully reused.

---

## 8. UX surface (admin UI)

### 8.1 Where it lives

A new card on **Published** and **QA Review** stages: **Feedback Inbox**.

Layout:

```
┌─ FEEDBACK INBOX ───────────────────────── [ + Report bug ] ──┐
│                                                                │
│  ◉ pending · 1                                                 │
│  ⚙ triaging · 0                                                │
│  ▸ triaged (awaiting accept) · 1                               │
│  ◐ in-fix · 0                                                  │
│  ✓ resolved · 0                                                │
│                                                                │
│  ─────────────────────────────────────────────────────────     │
│                                                                │
│  ▸ Ball doesn't bounce vertically off bricks                   │
│    triaged · routed to E2-S3 (Collision detection) · 0.86      │
│    [ View triage ] [ Accept & send back ] [ Reject ]           │
│                                                                │
│  ◉ Score doesn't reset on Game Over                            │
│    pending · click to triage                                   │
│    [ Triage now ]                                              │
└────────────────────────────────────────────────────────────────┘
```

### 8.2 Report-bug modal

Three fields: title, body (markdown), optional screenshot upload. Submit creates the FeedbackItem in `pending`, optionally auto-kicks off triage if confidence-on-autopilot is enabled (off in MVP).

### 8.3 Triage detail drawer

When the operator clicks **View triage**:

- Shows `targetStoryId` (with link to the story in Hierarchy view)
- Shows the agent's reasoning
- Shows the draft remediation note with **edit-in-place** before accepting
- Shows file paths the agent grep'd / blamed (so operator can sanity-check)
- Buttons: **Accept & send back**, **Edit note then accept**, **Reject**

---

## 9. End-to-end walkthrough — the brick-breaker bug

1. Operator plays the live app at `futurator.ai/apps/brick-breaker/`. Notices ball passing through bricks vertically.
2. Goes to admin → Brick Breaker plan → Published stage. Clicks **+ Report bug**.
3. Title: "Ball doesn't bounce vertically off bricks". Body: "When the ball hits the top or bottom of a brick, it does not reverse vertical velocity. Brick still breaks but ball passes through." Submits.
4. FeedbackItem created (`status=pending`). Operator clicks **Triage now**.
5. Daemon spawns Triage agent. It:
   - Reads stories — sees `E2-S3: Collision detection` and `E2-S5: Brick destruction`.
   - Greps `src/` for `collide`, `bounce`, `vy`, `dy`. Finds `src/game/physics.ts`.
   - `git log --oneline -- src/game/physics.ts` → commit by job `<jobId>` belonging to story `E2-S3`.
   - Reads `physics.ts:collideBrick` — sees the function flips `dx` on side hits but is missing the `dy` flip on top/bottom hits (or has a buggy axis-detection).
   - Cross-checks `E2-S3` AC: "Ball reflects off brick on collision (both axes)" — explicit coverage. **Regression.**
6. Triage emits:
   ```
   TARGET_STORY_ID: E2-S3
   CONFIDENCE: 0.86
   REASONING: Story E2-S3 (Collision detection) explicitly covers
   bidirectional reflection. Inspection of physics.ts:collideBrick shows
   the side-hit branch flips dx but the top/bottom-hit branch is missing
   or never reached. This is a regression against the original AC.
   DRAFT_NOTE: |
     **Regression — vertical bounce on brick collision.**

     **Bug:** Ball passes through bricks on top/bottom hits without
     reflecting vertical velocity. Brick destruction still fires.

     **Expected (per original AC):** Ball reflects off brick on every
     collision; flip dx for left/right hits, flip dy for top/bottom hits.

     **Likely fix:** `src/game/physics.ts:collideBrick` — verify the
     axis-detection branch and ensure `vy = -vy` runs on top/bottom hits.
     Consider using previous-frame-position to determine collision side
     reliably.

     **Test added:** Add a visual test where a ball is launched
     vertically into a brick row from below; verify the ball returns
     downward after impact.
   ```
7. Operator opens the drawer, reads the note, agrees, clicks **Accept & send back**.
8. Backend: `plan.status: delivered → fixing`. Existing `sendStoryBack(E2-S3, draftNote)` runs:
   - `story.description` gets the note appended
   - `story.status = 'fixing'`
   - Story re-launches via `launchStoryRerun()`
   - Daemon picks up the dev job
9. Dev agent fixes `physics.ts`, re-runs unit tests, hands off.
10. Wave-completion cron sees the wave finished, auto-launches QA. QA runs the new visual test (which now exists). Passes.
11. Cron sees `auto-run-qa` finished green, kicks off auto-deploy. Vite build, S3 sync, CloudFront invalidate. Live in ~60s.
12. Cron transitions `plan.status: fixing → delivered`. FeedbackItem flips to `resolved`. Operator gets a notification (or sees the inbox update).

**Total elapsed:** ~12 minutes assuming nothing flakes.

---

## 10. Phasing

| Phase | Adds | Effort | Dependency |
|---|---|---|---|
| **MVP (this doc)** | Bug-fix loop with Triage + Inbox + plan re-cycle | 3–4 days | None |
| Phase 2 | `story.devNotes` (structured) — improves Triage quality | 1–2 days | MVP shipped |
| Phase 3 | Refinements & new-feature classification (Triage routes to new-story or new-epic) | 3–5 days | Phase 2 |
| Phase 4 | In-app feedback widget injected into deployed apps | 2–3 days | MVP shipped |
| Phase 5 | Auto-accept for high-confidence bugs (≥ 0.85) | 1 day | Trust earned |

---

## 11. Open questions for the brainstorm

These are the calls I couldn't make alone:

1. **Triage trigger.** Auto-trigger triage on every feedback submission, or always require operator to click **Triage now**? Auto saves a click but consumes Claude budget on every report.
2. **Confidence threshold.** What's the minimum `confidence` for the Accept button to be enabled? Below that, force the operator to either edit the note or reject. Suggestion: 0.5.
3. **Multiple candidates.** What if Triage thinks two stories could own the bug (e.g. collision logic spans `physics.ts` and `bricks.ts`)? Pick one and let operator override, or surface both as candidates and let operator choose?
4. **Note ownership.** Currently the operator-edited note overrides Triage's draft when accepting. Should we keep both for audit (the agent's original + the operator's edit), or just the final?
5. **Inbox visibility.** Inbox card on Published only, on QA Review too, or as a global pill in the top nav (like an attention-inbox)? Bugs can be discovered anywhere.
6. **Re-cycle UX.** While the plan is in `fixing` post-launch, what should the Pipeline visual do? Show the dot pulsing back on Developing? Add a small "fixing" badge on Published? I lean: keep pulsing on Published, show a "1 fix in flight" subline. Avoid making it look like the plan regressed.
7. **Multi-fix batching.** If two bug reports come in quickly, should they coalesce into one fix wave (faster) or run independently (clearer attribution)? Independent is simpler for MVP.
8. **Reject reason taxonomy.** Should Reject require a reason from a fixed list (`duplicate`, `wont-fix`, `not-a-bug`, `working-as-designed`) or free text? List makes future analytics possible but adds friction.
9. **Deploy gating.** When the fix completes, do we auto-deploy (current cron does this in MVP rigor) or require manual confirmation given it's touching live? My instinct: auto for `prototype` rigor, require confirm for `mvp`/`production`. The plan rigor field already drives this.
10. **Story description bloat.** Each send-back appends to `story.description` (existing behavior). After 5 fixes, descriptions get unwieldy. Do we tolerate, or move historical notes into a separate `story.history[]` field? Tolerate in MVP, fix in Phase 2.

---

## 12. Risks & open concerns

- **Triage accuracy depends on commits naming stories.** If `git log` doesn't link commits to story IDs, Triage falls back to grep-only — confidence drops. Worth checking if the dev agent's commit messages already include story IDs (they probably do via the orchestrator template).
- **Plan rigor interaction.** If a plan was `prototype` rigor (auto-pass AC, no browser tests), the original AC may not cover the bug at all. Triage should detect this and produce a `missed-spec` flavor of remediation note that asks the dev to also add a test, not just fix.
- **Daemon slot pressure.** Triage is a new kind of job competing for the 2-slot daemon. A slow triage during active dev work could starve dev jobs. Maybe Triage runs out-of-band on a dedicated low-priority slot? Or just accept that triage waits in queue (it's the operator's signal anyway).
- **Concurrent feedback during fixing.** What if a second bug is reported while the plan is already in `fixing`? Allow queueing (save as pending, triage when current fix completes), or reject with "already fixing"? Suggest queueing.
- **Story-context regression.** When Triage routes back to a story that already has 3 prior remediation notes appended, the dev agent gets a long compound description. This is the existing send-back's compound behavior — not new — but the inbox amplifies it.

---

## 13. Why this is the right MVP

- **One new agent, one new table, four new endpoints, one new UI card.** Everything else is reused.
- **Zero new behavior in the deployed apps.** No widget injection in MVP. Just an admin-side capability.
- **Demonstrates the loop end-to-end on a real bug** (the brick-breaker vertical-bounce one) without needing PM re-planning, new-feature classification, or auto-accept.
- **Sets up Phase 2 trivially.** Adding `story.devNotes` is purely additive once the plumbing exists.
- **Hits the cycle-time target** (≤15 min) on first try, because Triage is a single short Claude call and everything downstream is the existing fast pipeline.

If we ship just this, we go from "shipping is the end" to "shipping is the start of the second loop." Every additional phase compounds on it.
