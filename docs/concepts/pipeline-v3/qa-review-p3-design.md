# QA Review + Deployment for Pipeline-3 — Design

> 2026-07-04. Synthesis of (a) a deep-research pass on dynamic visual QA (106 agents, every claim
> adversarially verified 3-0; sources: WebTestBench arXiv 2603.25226, WebDevJudge arXiv 2510.18560,
> VISTA / I-WebGenBench / WebGen-Bench / WebGen-Agent, Focus arXiv 2604.21523, Playwright docs,
> Meticulous.ai) and (b) a full code map of the legacy QA-Review/Deployment machinery.
> Companion: `qa-review-delivery-rethink.md`, `deployment-v2.5.md`, `tdd-native-pipeline-3-design.md`.

---

## 0. The lifecycle returns

P3 today ends at "all stories done" — the plan literally stays `status:'concept'` forever (pacman3
shows the CONCEPT badge at 6/6 done). The legacy lifecycle comes back, P3-native:

```
● CONCEPT ───── ● DEVELOPMENT ───── ● QA REVIEW ───────────── ● DEPLOYED
  intent→plan     batches 0..N        auto dev-deploy →          promote ladder
                  (frontier strip      dev.futurator.ai/<plan>    dev→staging→prod
                   nests here)         + 3-lane QA + human        + rollback
                                       approve / send-back
```

Statuses reuse `PlanStatus` (`concept → developing → review → delivered`; `fixing` recoverable).
P3 gets its own tiny status driver (legacy's `reducePlan` is epic-shaped and does not port):

- quick-planspec ingest / first dispatch → `developing`
- all stories done (the existing plan-close hook in `agent-daemon.mjs` that already fires the plan
  reflector) → `review` + `reviewAt` + **auto dev-deploy** + **auto QA launch**
- production deploy completed → `delivered` (+ `deployUrl`)

---

## 1. What the research settled (the numbers that decide the architecture)

1. **Agentic browser agents cannot be the verdict.** Best frontier model: **26.4% F1** on
   end-to-end web testing; coverage <70%; defect detection ~30% precision / <25% recall
   (WebTestBench). Agentic _judges_ underperform static LLM judges (53-56% vs 66% human agreement,
   WebDevJudge) and skew **high-precision/low-recall — they miss working features**, i.e. exactly
   our false-negative disease.
2. **Single-frame VLM judging is structurally broken, not prompt-fixable.** ~98% build/visual
   success vs ~50% interactive pass (I-WebGenBench); visual similarity and behavior scores are
   _anti-correlated_ across models (VISTA); single-frame judge failure rates 46-68% (Focus).
   Before/after pairwise comparison cuts failure to ~11-18% (directional, favored).
3. **The strongest evaluators all converged on our hybrid**: deterministic DOM/state-grounded
   Playwright probes as the PRIMARY functional verdict + VLM judge as SECONDARY appearance signal.
   Done well (WebGen-Agent), screenshot judge reaches 93-96% human agreement, interactive
   functional judge 89-93%.
4. **Feed the judge SOURCE CODE.** Withholding code from the judge drops accuracy **6.4-8.7 pts**;
   withholding screenshots only 1.1-1.2 pts (WebDevJudge). A screenshot-only judge discards the
   strongest signal.
5. **Human/PM-curated contract-style tests beat auto-generated exploration** (WebGen-Bench's 647
   cases were manually filtered; fully auto cases weren't accurate enough) → the PM's declared
   `deliveryJourneys` (Stage C) is the right source of _what_ to test.
6. **Operational**: Playwright `toHaveScreenshot` already does two-consecutive-capture
   stabilization + animation freezing; baselines are NOT portable — generate them on the same
   EC2/Docker box. Meticulous (the leading commercial autonomous preview-QA) uses base-vs-head
   **replay diffing**, never single-frame grading. Headless chromium suffices (no xvfb).

## 2. Confronting L0-L2 (what actually failed, and the replacement)

Legacy's "AI deciding levels" = the **PM tagging each AC with a `verify` intent in prose**, then a
pure map tag→level (`visual-test-classifier.ts`). Structural failures, confirmed in code: an
untagged browser AC "collapses to a blind idle-frame judge" (the prompt admits it verbatim); rigor
caps silently downgraded mis-tagged ACs to L0 smoke; nothing ever validated the tag against
reality. **Replacement: no coverage-level decision at all.** Every plan gets the same three fixed
lanes; the PM decides only _what the journeys are_ (a research-validated human-curated contract),
never _how much verification_ each gets:

| Lane                                   | What                                                                                                                                                                                                        | Verdict power                                                                            | Research basis                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **1. Deterministic journeys** (always) | Playwright drives the **deployed dev URL** through the PM's `deliveryJourneys` via the `window.__harness` seam — reach/act/observe, real assertions (`qa-author` probe compiler + `browser-probe-executor`) | **GATE** — a journey fail blocks                                                         | probe-based verification is the convergent primary verdict (VISTA, I-WebGenBench) |
| **2. VQA judge** (always)              | Before/after screenshot pairs around each journey step, judged by a VLM given the **spec + the app's source diff** + both frames; verdict lanes stay honest (fail blocks / uncertain→operator, F12)         | **GATE for real fails**, uncertain never blocks                                          | pairwise > single-frame; +code = +6.4-8.7 pts                                     |
| **3. Agentic exploratory** (budgeted)  | ONE Claude agent per plan plays the app at the dev URL (fixed interaction budget, headless Playwright) and files findings with screenshots                                                                  | **ADVISORY ONLY** — findings become operator cards / candidate fix stories, never a gate | 26.4% F1 + high-precision/low-recall ⇒ useful scout, unreliable judge             |
| **4. Human**                           | The dev URL itself (harness ON), before/after galleries, exploratory findings → **Approve → Deployment** or send-back                                                                                       | Final authority                                                                          | ~85% human-human agreement is the ceiling everything else approximates            |

## 3. What ports free vs what we build (from the legacy code map)

**Free (app/plan-generic, verified):** `deploy-targets.ts` (dev/staging/prod resolution, F29
identity split), `build-deploy-pipeline.ts` (Haiku deploy job; dev builds with
`NEXT_PUBLIC_TEST_HARNESS=1` so the seam stays ON), `build-promote-pipeline.ts` (copy vs rebuild,
smoke, release archive) + rollback, `mergePlanToMain`, `qa-author.ts` (before/after frames + human
tier + visible scripts — Stage A ✓), `selectDeliveryTests` (Stage B ✓), `browser-probe-executor.mjs`
(already P3), Stage C schema/prompt/gate.

**Build (P3-native):**

- the P3 **status driver** (replaces epic-shaped `reducePlan` + `wave-completion-check` triggers)
- the **QA launcher adapter** (feed tests/ACs from `StoryNodeRow`/`testBinding`, not `epics[]`)
- the **Stage C consumer** (`selectDeliveryTests` prefers declared `plan.deliveryJourneys`; quick
  flow's PM prompt emits journeys)
- **QA against the immutable dev URL** (the deferred F11 fix — kills the dev-server/deploy worktree
  mutex; matches the Meticulous model)
- **judge context upgrade**: add the story-diff/source to the L2 judge prompt
- the **agentic exploratory lane** (new)
- **Labs3 UI**: top-level lifecycle strip; QA Review tab grows the dev-URL card, journey results
  with before/after galleries, exploratory findings, **Approve / send-back**; a Deploy stage view
  (environment ladder, promote, history, rollback)
- plan-keyed **deploy/promote endpoints** (legacy's are epicId-keyed)
- ⚠️ branch naming: P3 commits to `plan/<planId>`; `mergePlanToMain`/deploy expect `plan/<name>` —
  unify (also fixes the Git Graph tab).

## 4. Build waves

- **W1 — Lifecycle + dev deploy**: P3 status driver; auto dev-deploy at review (plan-keyed);
  `devUrl` on the plan row; Labs3 lifecycle strip. _Exit: a finished plan auto-appears at
  dev.futurator.ai/<plan> with the badge on QA REVIEW._
- **W2 — QA lanes 1+2**: P3 QA adapter; Stage C consumer + quick-flow journey emission; run
  against the dev URL; judge gets source-diff; results persisted per journey. _Exit: QA tab shows
  journey verdicts with before/after frames._
- **W3 — Approve/send-back + Deployment**: accept endpoints; send-back mints fix stories
  (re-opens the frontier); promote ladder + rollback UI; `review→delivered`. _Exit: operator
  approves pacman → promote → live under /apps._
- **W4 — Agentic exploratory lane** (advisory cards) + polish (galleries, exploratory budget knob).

Every wave dark/flag-gated per the TDD-rollout discipline (D1-D6).
