# BMM Readiness Assessment — App/Plan v1

**Date:** 2026-04-27
**Project Level:** 2 (cross-cutting: data model + API + daemon + prompt + frontend)
**Mode:** Standalone gate-check (no `bmm-workflow-status.yaml`)
**Reviewer:** Manual cross-validation following the gate-check workflow at `bmad/bmm/workflows/3-solutioning/solutioning-gate-check/instructions.md`

---

## Executive Summary

**Verdict: Ready-with-Conditions.** The planning trio is structurally coherent — all 10 tech-spec acceptance criteria map to stories per the epics file's self-validation table; sprint-status.yaml has 34 implementation stories + 7 epics + 7 retrospectives matching the epics file 1:1 with kebab-case keys; sequencing has no forward-dependency violations. The conditions are six pre-drafting clarifications (one High, four Medium, one Low) that are scope/contract gaps rather than structural defects. Address the High item (Story 1.5 Projects-table deletion overreach) and the four Mediums before Epic 1 begins drafting; the Low is cosmetic. After those, the trio is fit for SM story-drafting.

---

## Document Inventory

| Artifact | Path | Lines | Status |
|---|---|---|---|
| Tech Spec (PRD + arch) | `docs/tech-spec-app-plan-v1.md` | 565 | Present, complete |
| Epics + Stories | `docs/epics-app-plan-v1.md` | 750 | Present, complete |
| Sprint Status | `docs/sprint-status.yaml` | 339 (App/Plan v1: lines 269-339) | All 48 new entries at `backlog`/`optional` |
| Superseded predecessor | `docs/concepts/published-feedback-loop-mvp.md` | (referenced) | Marked superseded in tech spec frontmatter ✓ |

Scope alignment: all three docs describe the same Pipeline v1 cut. Three Plan kinds (`initial`/`change`/`experiment`) appear consistently. Working-tree-shared-per-App, no-git-branching, no-Mycelium boundaries are echoed identically.

---

## Findings by Severity

### Critical

None.

### High

#### H1 — Story 1.5 wipe script targets `Projects` table; potential overreach

**Location:** `docs/epics-app-plan-v1.md` §"Story 1.5: Pre-epic data wipe script", Acceptance Criteria.

**Problem:** Story 1.5's AC says *"all rows in the Projects table are deleted (legacy table — confirm with user before deleting if this conflicts with current usage)."* The Projects table is from the original Project Registry (Epic 2 of the base build, status `done`) and is **actively used** for the AWS portfolio dashboard, cost tracking, and resource map (Epics 2-8 in sprint-status). Deleting it would destroy live admin functionality unrelated to App/Plan v1. The story's own AC parenthetical hedges on this but does not resolve it.

**Recommendation:** Strike the Projects table from Story 1.5's AC entirely. Limit the wipe to: (a) Plans table rows (App/Plan v1 territory), (b) Epics table rows for those Plans (cascade), (c) optional `/home/ubuntu/projects/*` folder cleanup (operator-driven, manual). Update the story before drafting.

### Medium

#### M1 — `bash` tool grant on PM-augmentation needs scope guidance

**Location:** `docs/tech-spec-app-plan-v1.md` §"PM-Augmentation Prompt" tool-grant table; `docs/epics-app-plan-v1.md` Story 4.4.

**Problem:** The tech spec grants `Read, Grep, Glob, Bash` to the PM-augmentation agent, citing belt-and-suspenders enforcement at both daemon level and prompt level. `Bash` is broad — it can run any shell command in the working dir (curl, network calls, package installs). The intent is read-only inspection (`git log`, `git blame`, `find`), but neither the prompt nor Story 4.4 lists allowed commands or denied patterns.

**Recommendation:** In Story 4.1's prompt-template AC, restrict Bash to a documented allowlist (e.g., `git log`, `git blame`, `git show`, `find`, `wc`, `head`, `tail`) explicitly inside the prompt. Or grant a more restrictive tool. Sean Tinel's analysis in tech spec §"API Endpoints" — Story 3 calls input validation "the perimeter" — should extend to agent tool grants too.

#### M2 — Story 2.3 cascade-delete non-atomicity has no recovery path

**Location:** `docs/epics-app-plan-v1.md` Story 2.3, Technical Notes.

**Problem:** Story 2.3 documents that DELETE App cascade is sequential (not transactional) because DDB `transactWrite` caps at 100 items and an App with many Plans/Epics could exceed it. The note says *"partial failures need operator follow-up via the wipe script."* But Story 1.5's wipe script (after H1 fix) targets only Plans — it won't fix orphaned Epic rows from a partial App-cascade. There's a gap.

**Recommendation:** Either (a) make Story 2.3's cascade a "best effort + report orphans" pattern that returns 202 with a list of items needing manual cleanup, or (b) extend Story 1.5's wipe script to also clean orphaned Epics with no parent Plan. Decide before drafting.

#### M3 — `appId` slug-reuse-after-delete vs. lingering S3 bundles

**Location:** `docs/tech-spec-app-plan-v1.md` §"Apps Grid" + §"App Detail" + §"Acceptance Criteria" #5.

**Problem:** Apps are hard-deleted in v1 (Story 6.7 + 2.3). After delete, the slug becomes available for reuse. But deploy bundles persist at `s3://futurator-ai-website/apps/<slug>/` — the public bucket scoped paths the admin owns per CLAUDE.md. A user creating a new App with a previously-deleted slug would inherit the old bundles silently. Confusing at best, dangerous at worst (live URL serves wrong app).

**Recommendation:** Add to Story 2.3 (or create a sub-story) AC: *"On hard-delete of an App, the deploy job enqueues an S3 cleanup of `apps/<slug>/` and `apps/<slug>/deploys/*`."* Or: forbid slug reuse via a `tombstone` table (more complex). v1 minimum is the cleanup.

#### M4 — Story 6.5 "View affected files" is underspecified

**Location:** `docs/epics-app-plan-v1.md` Story 6.5 Technical Notes.

**Problem:** The story says *"if a `.git` directory exists in the App's workingDir, run `git status --porcelain` via daemon to get the list; else show 'Check the working dir manually'. This requires a tiny new daemon endpoint or repurpose existing — defer if non-trivial."* "Defer if non-trivial" is not a deliverable spec. The dev agent will ship one of three things: a stubbed-out empty drawer, a half-built daemon endpoint, or a TODO. Decide which before drafting.

**Recommendation:** Either (a) cut "View affected files" from v1 — the `Mark resolved` flag-flip is enough; document the file inspection as a v1.x story; or (b) commit to a minimal daemon endpoint with explicit AC. Pick before Epic 6 is drafted.

### Low

#### L1 — Story numbering uses both `1-1-...` and `ap-1-1-...` interchangeably

**Location:** `docs/sprint-status.yaml` (uses `ap-N-M-...`) vs. `docs/epics-app-plan-v1.md` (uses `Story N.M`).

**Problem:** The epics file refers to stories internally as `Story 1.1`, `Story 2.4`, etc. Sprint-status keys are `ap-1-1-...`, `ap-2-4-...`. The mapping is unambiguous, but a dev agent looking at sprint-status alone won't immediately know `ap-2-4` is "Add `POST /api/apps/:appId/plans` with concurrency..." without opening the epics file.

**Recommendation:** Add a one-line comment above each story line in sprint-status mapping it to the epics-file story title (cosmetic, but cheap). Or rely on the existing Module section header which lists the file path.

---

## Positive Findings

- **Tech-spec ↔ epics coverage is genuinely complete.** Spot-checked all 10 tech-spec acceptance criteria → each maps to ≥1 story per the self-validation table; AC #1 (schema provisioned) → Stories 1.1 + 1.4; AC #4 (PM-augmentation prompt + parser + clarification) → Stories 4.1-4.4; AC #6 (conditional `+ New Plan` + dirty-tree banner) → Stories 6.4 + 6.5.
- **Sprint-status keys match epics 1:1.** Verified by `grep -c "^  ap-" sprint-status.yaml` → 34, matches the 34 implementation stories in the epics file. All 7 retrospectives present.
- **No forward dependencies detected.** Spot-checked Stories 2.4, 4.4, 5.4, 6.7, 7.3 — every Prerequisite references stories ≤ N.M or earlier epics.
- **BDD AC format is consistent across all 34 stories.** Every story uses Given/When/Then. `touchPoints` and `forbiddenAreas` populated where applicable; Story 7.3 correctly uses the `<EPIC_WIDE>` sentinel for the cross-cutting URL sweep per pipeline-v1 dev-correction Story D.2.
- **Three-Plan-kind model is consistently applied** across data model (Story 1.1), API validation (Story 2.4), PM-augmentation prompt scope (Story 4.1), UI badge rendering (Story 6.3). No drift.
- **The two-step App-then-first-Plan creation flow** is consistent across tech spec §"Apps Grid" and Stories 5.4 + 6.1.
- **Concurrency invariant (one non-terminal Plan per App)** is enforced at three layers — API (2.4), API transition (2.6), daemon dispatch (3.2) — defense-in-depth as designed.
- **Test deliverables are owned at the story level.** Every story includes ≥1 test-related AC and lists test files in `touchPoints`. Spot-checked Stories 1.1, 2.4, 3.2, 4.2, 5.4 — all have explicit test ACs and test file paths.

---

## Specific Next-Action Items (before story drafting begins)

- [ ] **H1** — Strip Projects-table deletion from Story 1.5 AC; constrain to Plans + cascade-Epics only.
- [ ] **M1** — Pin Bash command allowlist in Story 4.1 prompt-template AC (or swap to a narrower tool grant).
- [ ] **M2** — Decide: best-effort-cascade-with-202 OR extended wipe script; update Story 2.3.
- [ ] **M3** — Add S3 bundle cleanup to Story 2.3 (or create dedicated sub-story).
- [ ] **M4** — Decide: cut "View affected files" from v1 (recommended) OR commit to a minimal daemon endpoint with explicit AC; update Story 6.5.
- [ ] **L1** — Optional: inline story-title comments in sprint-status.yaml.

Once H1 + M1-M4 are resolved, the trio is fit for the SM story-drafting phase. The findings are concentrated in the data-cleanup edges (1.5, 2.3, 6.5) and in pinning down the Bash tool grant (4.1) — none touch the architectural shape of the feature.

---

## Notes on This Assessment

The first attempt at this gate-check (via a subagent) returned hallucinated findings referencing stories that don't exist in this project (e.g., "wave-summary-llm", "promotion-engine", "wizard-step-1-kind"). Those story names belong to a different feature elsewhere in BMAD's example corpus, not to Futurator-Admin's App/Plan v1. That report was discarded; this assessment was produced by manual cross-validation against the actual three artifacts in the project.
