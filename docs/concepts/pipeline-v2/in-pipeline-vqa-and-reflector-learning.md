# In-Pipeline Per-Story VQA + Dev-Feedback Loop + Reflector Learning

Status: **DESIGN — approved for build (2026-06-02)**
Author: pipeline-v2 work session
Supersedes: nothing (additive to the existing plan-level VQA in `visual-qa-pipeline.ts`)

---

## 1. Motivation (why shift VQA left into development)

Today visual QA runs **once, plan-level, after every story is merged**
(`buildQaExecutePipeline`). When it finds a visual defect ("dino floats above
the ground line", "no obstacles spawn") three things are already lost:

1. **Attribution** — the end-gate sees a symptom across the assembled app, not
   the story/DEV that introduced it.
2. **Live context** — the DEV agent + its worktree + its reasoning are torn
   down; the only fix path left is a cold-start free-agent PR.
3. **The tight loop** — the story pipeline ALREADY has a DEV↔REVIEWER iteration
   (`maxIterations`): REVIEWER fails → DEV revises in the same worktree/context.
   VQA can be just another reviewer in that loop.

The real prize is **#2 of the win below**: a per-story failure→fix delta is a
clean, attributable learning signal the REFLECTOR can turn into a durable skill
or CLAUDE.md rule — so the factory stops re-making the same visual mistake on
every new game.

### Wins

- **W1 — fix at the source:** the failing screenshot + judge observations feed
  the _same_ DEV that wrote the code, in-context, immediately.
- **W2 — true learning:** `{story, expectation, before/after screenshot, judge
observation, dev fix rationale, diff}` → REFLECTOR → skill / CLAUDE.md delta.
- **W3 — cheaper end-gate:** plan-level VQA increasingly becomes a confirmation
  pass, not the first time anything is looked at.

---

## 2. The hard constraint: renderability

A story's output is often **not visible in isolation.** "Implement the obstacle
spawner" or "implement `DinoRender`" render nothing watchable until a later
_Feature Assembly_ story wires them into a bootable page. Booting a dev server
in the spawner story's worktree would screenshot a blank canvas → a false fail.

**Scoping rule (the gate for per-story VQA):** a `story-vqa` step runs IFF

```
story has ≥1 criterion with needsBrowser === true
  AND the app boots in the story worktree (framework-detect + healthcheck 200)
```

- **Greenfield:** mostly the late integration/assembly stories satisfy this.
- **Brownfield (plan 2+):** nearly every story does, because `main` is already
  a delivered, bootable app (see the merge-to-main delivery model). This is the
  mode where in-pipeline VQA pays off most.

If `needsBrowser` is set but the app does not boot, `story-vqa` **skips with a
recorded reason** (`skipped: app-not-bootable`) — it never false-fails, and the
skip is visible so coverage gaps are honest.

Plan-level VQA (`buildQaExecutePipeline`) is **retained** as the holistic,
cross-story, full-playthrough final gate. Per-story = shift-left catch;
plan-level = integration catch.

---

## 3. Architecture

### 3.1 Where it slots in (`functions/shared/pipelines/story-pipeline.ts`)

Existing story step order (abridged): `dev → test-author → test-execute →
review → (iterate) → commit`. Insert:

```
dev → test-author → test-execute → review → [story-vqa]* → commit
                                      ^___________|
                            VQA fail re-injects into a DEV fix iteration
```

`story-vqa` only materializes when the scoping rule (§2) passes; otherwise the
step is omitted from the generated pipeline entirely.

### 3.2 The `story-vqa` step (one shell step, reuses plan-level infra)

1. **Boot** — reuse `buildFrameworkDetectSnippet` + the healthcheck loop from
   `qa-prepare` to bring up the dev server in the **story worktree**
   (`/home/ubuntu/worktrees/<app>/<plan>/<storyId>`). node_modules is already
   symlinked there.
2. **Screenshot** — `npx playwright screenshot` for each `needsBrowser`
   criterion's viewport, into `<tmp>/story-vqa/<storyId>/<criterionId>.png`.
3. **Judge** — L1 (Haiku) / L2 (Sonnet) per criterion, **reading the LOCAL png
   via the Read tool** (the fix already shipped to plan-level judges), judging
   against that criterion's _specific_ `expect`/`judge` text. Emits
   `verdict ∈ {pass|fail|uncertain}` + a written `observations` string.
4. **Upload + record** — every screenshot → S3 under a per-story prefix
   (`s3://futurator-ai-website/qa-snapshots/<plan>/<jobId>/story-vqa/...`), and
   a structured `STORY_VQA_RESULTS` JSON (see §3.5) is emitted for extraction.

### 3.3 Dev-feedback fix loop (W1)

- On any `fail`: the step returns a non-pass verdict that the story pipeline's
  existing iteration machinery treats like a REVIEWER rejection, re-entering a
  **DEV fix iteration** with this injected context:
  - the failing **criterion expectation**,
  - the judge's **observations** ("the dino sprite renders ~40px above the
    ground baseline; obstacles never enter the viewport"),
  - the **local screenshot path** (DEV can Read it),
  - the iteration number.
- **Cap:** `STORY_VQA_MAX_FIX_ITERS = 3` (mirrors the §9.5 fix-cycle cap). On
  the 3rd consecutive fail → stop iterating, write a `story-vqa-exhausted`
  attention item, mark the story `needs-attention`, and let the operator decide.
- On `pass` (within the cap) → proceed to `commit`. The commit trailer records
  `VQA-Fix-Iterations: N`.

### 3.4 Notifications — the loop must be visible (user requirement)

One **evolving** attention card per `(story, story-vqa)`, updated via the
existing `upsertOpenAttentionItem` dedupKey path (so it never spams — recall the
15k-row pileup). The card's timeline shows, in order:

- `VQA fail (attempt 1)` — verdict + observations + screenshot thumbnail URL.
- `DEV fix (attempt 1)` — what the dev changed (WORK_SUMMARY excerpt).
- … repeated …
- `VQA pass (attempt N)` — resolves the card.
- or `VQA exhausted after 3` — severity `high`, stays open for the operator.

Category: `story-vqa-failed` (add to `AttentionCategory`). Context carries
`{ storyId, epicId, criterionId, screenshotUrl, observations, iteration }` so
the UI renders the screenshot + text inline.

### 3.5 UI proof — operator sees the real screenshot + observations (user requirement)

Data recorded per criterion-attempt (extracted from `STORY_VQA_RESULTS`):

```jsonc
{
  "storyId": "…",
  "criterionId": "AC-3",
  "level": "L2",
  "iteration": 1,
  "verdict": "fail",
  "observations": "Dino sprite baseline sits ~40px above the ground line; no obstacles visible in 3s.",
  "screenshotUrl": "https://futurator.ai/qa-snapshots/<plan>/<job>/story-vqa/AC-3-iter1.png",
  "expectation": "The dino's feet rest on the ground line and obstacles scroll in from the right.",
}
```

Surfaced in the plan dashboard's **VQA gallery** (`vqa-gallery.tsx`) and the
story row: each browser story shows its screenshot(s), the judge's verdict, the
**written observations**, and the **fix-iteration trail** (fail→fix→…→pass).
The operator can therefore confirm, visually: (a) a real screenshot was taken
and read, (b) the observations are concrete, (c) they were handed to DEV, (d) it
took N loops, (e) it ended green. This is the explicit acceptance bar.

### 3.6 Reflector learning (W2)

On a `fail → … → pass` sequence, emit a structured event the REFLECTOR consumes
(`reflector-runner.mjs` / self-reflection pipeline):

```jsonc
{
  "type": "story.vqa.fix",
  "storyId": "…",
  "expectation": "...",
  "beforeShotUrl": "...iter1.png",
  "afterShotUrl": "...iterN.png",
  "judgeObservation": "baseline offset; no spawn",
  "devRationale": "rendered sprite at y=groundY instead of y=groundY-spriteH; fixed baseline + started spawner interval",
  "diff": "<unified diff of the fix>",
}
```

REFLECTOR proposes, via the existing **reflection inbox / manifest-change-
proposed** card (operator confirms/edits/declines), one of:

- a **skill** delta (e.g., a `canvas-game` note: "sprites are top-left anchored;
  to sit on a baseline use `y = baseline - spriteHeight`; always start the
  spawner timer on game-start, not first input"), or
- a **CLAUDE.md** rule for the app.

This closes the learning loop the operator asked for: real fixes become reusable
knowledge, not one-off patches.

---

## 4. Data-model changes

- `EpicStory`: add `vqa?: { status: 'pending'|'pass'|'fail'|'exhausted'|'skipped', iterations: number, results: StoryVqaResult[] }`.
- `AttentionCategory`: add `'story-vqa-failed'`.
- New forensic/reflector event type `story.vqa.fix`.
- `qa-report` / deploy-readiness: a story in `vqa: exhausted` contributes a
  `needs-attention` pillar so the plan can't silently ship a known-bad visual.

---

## 5. Tradeoffs + mitigations

| Concern                                                | Mitigation                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cost/time: boot + screenshot + judge per browser story | Gate strictly on `needsBrowser` **and** boot-success; pure-logic stories skip entirely. Reuse the already-warm node_modules symlink. |
| Dev-server boot flakiness in a story worktree          | Reuse the proven `qa-prepare` framework-detect + 60-try healthcheck; on boot fail → `skipped: app-not-bootable` (never false-fail).  |
| Judge can't see screenshot                             | Already fixed: judges Read the **local** file (deployed 2026-06-01).                                                                 |
| Fix loop runs forever                                  | Hard cap `STORY_VQA_MAX_FIX_ITERS = 3` → attention item.                                                                             |
| Notification spam (cf. 15k pileup)                     | Single evolving card per (story, vqa) via `upsertOpenAttentionItem` dedupKey.                                                        |

---

## 6. Build slices (sequenced, each independently shippable)

- **S1 — `story-vqa` step:** scoping gate + boot + screenshot + judge (local
  Read) + `STORY_VQA_RESULTS` extraction + S3 upload. No fix loop yet (verdict
  recorded, advisory).
- **S2 — dev-feedback fix loop:** wire VQA-fail into a DEV fix iteration with
  observations injected; cap=3; `story-vqa-exhausted` attention on cap.
- **S3 — UI surfacing:** screenshots + observations + iteration trail in
  `vqa-gallery.tsx` + story row (the visual-proof requirement).
- **S4 — notifications:** the evolving `story-vqa-failed` card timeline.
- **S5 — reflector capture:** `story.vqa.fix` event → reflection-inbox proposal.

S1+S2 deliver the functional loop; S3+S4 deliver the operator-visible proof;
S5 delivers the learning.

---

## 7. Acceptance criteria (maps to the operator's explicit asks)

A test plan (brownfield, on a delivered app) with a browser story whose
criterion is deliberately failable must demonstrate, **visible in the UI**:

1. ✅ A real screenshot was **captured and read** by VQA (thumbnail visible, not "NO SCREENSHOT").
2. ✅ The judge's **observations** are concrete and shown.
3. ✅ Those observations were **passed to DEV** (visible fix iteration referencing them).
4. ✅ After a **few fix loops**, the story-vqa verdict flips to **pass**.
5. ✅ The whole loop is reflected in **notifications** (one evolving card, fail→fix→pass).
6. ✅ A `story.vqa.fix` reflector proposal appears in the reflection inbox.

---

## 8. Prerequisites already in place (2026-06-01/02)

- Playwright Chromium installed + ensured idempotently in `rsync-daemon.sh`.
- Plan-level judges read **local** screenshot files (not unfetchable CDN URLs).
- QA/deploy build the **plan branch**; `main` fast-forwards on delivery →
  brownfield iteration is the natural mode for per-story VQA.
- Notification table cleared to 0 for a clean test.
