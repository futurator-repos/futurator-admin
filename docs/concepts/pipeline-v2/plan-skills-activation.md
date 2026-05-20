# Plan — Skills activation (`plan-skills-activation`)

> **Purpose.** Wire the Pipeline v2 Phase 3 skills substrate end-to-end so
> agents actually load and use skills during plan development. The substrate
> (federation loader, SKILL-SCOUT runner, manifest scaffold, commit trailers)
> shipped under PR-69..PR-83 but is dormant — daemon hooks and operator-side
> org provisioning are the missing pieces.
>
> **Authored 2026-05-19 against HEAD `feat/treesitter-slice-c-brownfield-bootstrap`.**
> Source forensic: `plan_snake-4_mpcdwkto-forensic.json` (mvp rigor, 7
> stories, all 36 agent invocations received a 1942-byte empty CLAUDE.md
> scaffold; zero `Skills-Used:` content; zero SKILL.md files vendored).
>
> **Sibling files.**
>
> - `blueprint-spyhunter-2-and-pr-59-65-expectations.md` §5.5 — full list of trigger-wiring follow-ons
> - `architecture.md` §4 + §10 — Phase 3 status drift
> - `futurator-pipeline-v2-5-consolidated.md` §33–§45 — v2.5 skills spec
> - `epics-pipeline-v2-phase-3.md` Epics 3-C-1..3-C-5 — original story breakdown
> - `testing-v2-substrate.md` §1.6 + §2.7 — hands-on validation script

---

## 0. Intent

Make agents actually use skills during plan development. Today:

- Federation loader runs at daemon startup but loads the embedded fallback (only 1 of 3 sources is real on GitHub: `anthropics/skills`).
- `pv2.skill-scout.queued` and `pv2.architect.queued` markers fire at app bootstrap but no agent ever spawns.
- `.claude/skills.manifest.yaml` ships empty per app and stays empty forever.
- `.claude/skills/<name>/` is never populated — Claude Code's built-in skill loader finds nothing.
- `CLAUDE.md` ships as a 1942-byte empty scaffold (boilerplate template) and never grows during plan execution. Same SHA across every agent invocation in snake-4.
- `Skills-Used:` commit trailer emits as label-only because `.context/loaded-skills.json` is never written by the daemon.
- `futurator-reflections` table is empty (REFLECTOR scheduler is PR-74-followup).

Success criteria — observable in a future forensic:

1. `claude_md_loaded` events show **distinct sha values** within a single plan (CLAUDE.md grew during DEV/REFLECTOR appends).
2. Commits include `Skills-Used: <skill>@<source>, ...` with non-empty content.
3. `.claude/skills/<name>/SKILL.md` exists per app on disk + in git.
4. `pv2.skill-scout.*` events fire BEYOND the T1 bootstrap markers (T2 plan-intent at minimum).
5. `/labs/skills` page lists each app's pinned skills + recent Skills-Used aggregate.
6. `/labs/reflections` shows at least one REFLECTOR proposal after plan close.

---

## 1. The "skills database" — clarification

The design (v2.5 §35.1) is a **federation of GitHub repos**, not a single
catalog. Three concentric stores:

```
~/.futurator/skill-federation.yaml         ← Operator's list of trusted GitHub repos
    │
    ▼  (SKILL-SCOUT walks these, ranks candidates per intent + stack)
.claude/skills.manifest.yaml               ← Project lockfile (skills × pinned SHA)
    │
    ▼  (npx skills sync vendors them in)
.claude/skills/<name>/SKILL.md             ← Vendored body the agent reads
```

### Federation source reality check (verified 2026-05-19)

| Source               | URL                                      | Auto-trust | Live?                          |
| -------------------- | ---------------------------------------- | ---------- | ------------------------------ |
| `anthropic-official` | `github.com/anthropics/skills`           | ✓          | **YES — 17 skills**            |
| `futurator-internal` | `github.com/futurator/futurator-skills`  | ✓          | **404 — operator must create** |
| `vercel-web`         | `github.com/vercel/skills`               | ✓          | (planned)                      |
| `stripe-official`    | `github.com/stripe/skills`               | ✓          | (planned)                      |
| `zxkane-aws`         | `github.com/zxkane/aws-skills`           | ✓          | (planned)                      |
| `community`          | `github.com/anthropics/skills-community` | confirm    | **404**                        |

Anthropic's catalog (`anthropics/skills/skills/`): `algorithmic-art`,
`brand-guidelines`, `canvas-design`, `claude-api`, `doc-coauthoring`, `docx`,
`frontend-design`, `internal-comms`, `mcp-builder`, `pdf`, `pptx`,
`skill-creator`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder`,
`webapp-testing`, `xlsx`.

### When skills load — two distinct moments

**Phase A — INSTALL** (per project + per plan, BEFORE any `claude -p` runs).
SKILL-SCOUT proposes → operator confirms → daemon writes the manifest +
runs `skills-sync.mjs` to fetch SKILL.md bodies onto disk. Triggered by 8
trigger types (T1 init, T2 plan, T3 brownfield, T4 speculation, T5 new-dep,
T6 reviewer-cluster, T7 stream-graduation, T8 weekly).

**Phase B — ACTIVATION** (per `claude -p` invocation, automatic). Claude
Code's CLI auto-discovers `.claude/skills/*/SKILL.md` in the agent's `cwd`
at startup — no flag needed. Pipeline v2 layers two extras: CLAUDE.md
prepended via `--append-system-prompt` (live), and `loadedSkills[]`
tracking for the commit trailer (not live).

### Three scopes layered at every agent activation

| Scope    | Location                                 | Lifetime            | Kinds                         |
| -------- | ---------------------------------------- | ------------------- | ----------------------------- |
| operator | `~/.claude/skills/`                      | across all projects | `process`                     |
| project  | `<workingDir>/.claude/skills/`           | this app's lifetime | `core, stack, domain, vendor` |
| plan     | `<workingDir>/.claude/skills/<plan-id>/` | this plan only      | `plan` (speculative)          |

Per-story worktrees (architecture.md §5.5) would clone the project-level
set; speculation branches (`explore/`) override with their own manifest
per v2.5 §43.

---

## 2. Execution order

```
Week 1:   Epic 1 (operator provisioning, 1 day)
          Epic 2 (default skill loadout — quick win, 2-3 days)
          → first measurable signal: SKILL.md files on disk in new apps

Week 2:   Epic 4 (loadedSkills tracking, ½ day)
          Epic 3.1-3.2 (SKILL-SCOUT T1 wire-in, 1.5 days)
          → first measurable signal: Skills-Used trailers populated

Week 3:   Epic 3.3-3.5 (T2 + decision card UI, 2.5 days)
          Epic 5 (CLAUDE.md write hooks, 2 days)
          → first measurable signal: CLAUDE.md sha changes within a plan

Week 4:   Epic 6 (REFLECTOR scheduler, 2 days)
          Epic 7 (observability, 2 days)
          → first measurable signal: /labs/skills + reflections inbox active
```

Total: ~4 weeks single-operator. **Critical path: Epic 1 → 2 → 4 → 3.**
Epics 5–7 parallelize once SKILL-SCOUT fires.

---

## 3. Epic 1 — Operator-side org provisioning (no code)

Blocks every downstream wire-in. Architecture.md §10 "Operator-side org
provisioning (not code)" enumerates these; we tackle the skill-relevant
subset here.

| Story | Action                                                                                                                                                                                                                                                                                                              | Effort |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.1   | Create `github.com/futurator/futurator-skills` repo with seed skills as top-level dirs (each containing `SKILL.md` + `meta.json` per Anthropic's `template/` shape). Seed set: `bmad-conventions`, `memgraph-query-patterns`, `pixel-art-canvas-game`, `mycelium-knowledge-compile`, `next-app-router-conventions`. | ½ day  |
| 1.2   | Author `~/.futurator/skill-federation.yaml` on the daemon EC2 host (`/home/ubuntu/.futurator/skill-federation.yaml`) per v2.5 §35.1 shape. Point at `anthropics/skills` + the new `futurator/futurator-skills`. Keep `community` as opt-in (auto-trust: false).                                                     | 15 min |
| 1.3   | Send `kill -USR1 <daemon-pid>` to trigger live refresh; verify `journalctl -u futurator-daemon` emits `[info] federation-loader: source=file (sha=<8-char>)` instead of `fallback`.                                                                                                                                 | 5 min  |
| 1.4   | Provision `s3://futurator-config/` bucket so `federation-backup.mjs`'s daily sync has a target. (Architecture.md §10 lists this; ~3 lines of `aws s3 mb` + bucket policy.)                                                                                                                                          | 15 min |

**Validation:** Daemon log shows `source=file`. `aws s3 ls
s3://futurator-config/default/skill-federation.yaml` returns the parsed
manifest after 24h.

**Deferred from this epic** (not blocking):
`futurator-personas`, `futurator-org-memory`, CodeArtifact `futurator/mcp`
domain provisioning, AWS Layer B per-project IAM roles. Track separately.

---

## 4. Epic 2 — Default skill loadout per starter (quick win, bypasses SKILL-SCOUT)

Lowest-cost path to "agents see skills in this week's plans." Hardcodes
2–4 skills per boilerplate type. `defaultSkillLoadout` field already
exists in `boilerplates/types.ts:57` but is never read.

| Story | Action                                                                                                                                                                                                                                                                                                                     | Code touch                                                                                                         | Effort |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| 2.1   | Populate `defaultSkillLoadout` per starter in the registry. Mapping below.                                                                                                                                                                                                                                                 | `functions/shared/boilerplates/registry.ts`                                                                        | ½ day  |
| 2.2   | New `daemon/lib/app-bootstrap-steps/prepin-default-skills.mjs`: read the starter's `defaultSkillLoadout`, write entries into `.claude/skills.manifest.yaml` under `core[]` (replaces the empty array from PR-71's scaffold). Inserts between `apply-starter-augments` and `npm-install`.                                   | `daemon/lib/app-bootstrap-steps/prepin-default-skills.mjs` (new), `daemon/pipelines/app-bootstrap.mjs` (call site) | ½ day  |
| 2.3   | New `daemon/lib/app-bootstrap-steps/vendor-skills.mjs`: shell out to `node scripts/skills-sync.mjs` in the worktree. Inserts AFTER `npm-install` (so `yaml` dep is on disk). Emits `pv2.skills-sync.completed { vendoredCount, drift, durationMs }`. Failure → attention `skill-sync-failed` (low severity, non-blocking). | `daemon/lib/app-bootstrap-steps/vendor-skills.mjs` (new), `daemon/pipelines/app-bootstrap.mjs`                     | 1 day  |
| 2.4   | E2E test: create new `dino-test-2` app on `nextjs-canvas-game`. Verify SSH `ls /home/ubuntu/projects/dino-test-2/.claude/skills/` shows `canvas-design/` + `frontend-design/` each with `SKILL.md`, and `git ls-files .claude/skills/` shows both files committed.                                                         | (verification only)                                                                                                | 30 min |

### 2.1 — `defaultSkillLoadout` mapping

```ts
// functions/shared/boilerplates/registry.ts

const NEXTJS_BASE_DEFAULT_SKILLS = [
  'frontend-design@anthropic-official',
  'webapp-testing@anthropic-official',
];

// Spread into derived starters with overrides:
'nextjs-canvas-game': {
  ...NEXTJS_BASE_PACK,
  defaultSkillLoadout: [
    'canvas-design@anthropic-official',
    'frontend-design@anthropic-official',
    'algorithmic-art@anthropic-official',
  ],
},
'nextjs-form-app': {
  ...NEXTJS_BASE_PACK,
  defaultSkillLoadout: [
    'frontend-design@anthropic-official',
    'webapp-testing@anthropic-official',
  ],
},
'nextjs-dashboard': {
  ...NEXTJS_BASE_PACK,
  defaultSkillLoadout: [
    'frontend-design@anthropic-official',
  ],
},
// sst, vite, mobile stubs → null (skip prepin-default-skills step)
```

**Validation:** After bootstrap, `ls /home/ubuntu/projects/<app>/.claude/skills/`
shows N dirs each with `SKILL.md`. The next `claude -p` invocation in that
worktree auto-discovers them (Anthropic CLI's built-in loader). Forensic
should now show `claude_md_loaded` events as before, plus a side-effect
visible in the DEV agent's tool_use events: it can now reference skill
content without us injecting anything per-prompt.

**Why this first:** Decouples value (agents see skills) from the hardest
piece (SKILL-SCOUT wire-in). Comparative A/B: forensic of one plan
pre-Epic-2 vs post-Epic-2 on the same starter is the cleanest "did skills
move the needle?" signal we can buy for ~3 days of work.

---

## 5. Epic 3 — SKILL-SCOUT activation (T1 + T2 only)

> **Detailed tech-spec at `tech-spec-epic-3-skill-scout-activation.md`**
> (2026-05-19) — 7 stories, ~5 dev-days, with risk pre-flight (Story 3.0)
> covering job-router extensibility, plan-reducer wait-state design, and
> attention-payload shape verification. Read that doc before
> implementing.

Brings the dormant `daemon/pipelines/skill-scout-runner.mjs` to life for
the two highest-value triggers. Runner is fully tested and orphaned today
(zero importers in the daemon).

| Story | Action                                                                                                                                                                                                                                                                                                                                  | Code touch                                                                                                                     | Effort |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 3.1   | Daemon spawns SKILL-SCOUT when a `pv2.skill-scout.queued` event is observed in the agent-events stream OR when explicitly enqueued by the orchestrator. Pipeline definition baked at job-create time per architecture.md §5.3 — reuse the existing job-row pattern.                                                                     | `daemon/agent-daemon.mjs` (new branch), `functions/shared/pipelines/skill-scout-pipeline.ts` (new — same shape as PM pipeline) | 1 day  |
| 3.2   | Wire T1 trigger: after `app-bootstrap.completed`, daemon enqueues a SKILL-SCOUT job with `trigger: 'T1'`, `projectSlug`, `boilerplateType`, `existingManifest`. Output → decision card via the existing `buildDecisionCard()` helper in `skill-scout-runner.mjs`. Under prototype rigor + all proposals confidence ≥0.9 → auto-confirm. | `daemon/pipelines/app-bootstrap.mjs`                                                                                           | ½ day  |
| 3.3   | Wire T2 trigger: in plan-pipeline (PM dispatch path), enqueue SKILL-SCOUT with `trigger: 'T2'` + `planIntent` BEFORE the PM agent spawns. Plan-reducer waits for the SKILL-SCOUT job to terminate (or auto-confirm) before launching PM. New plan-reducer state: `awaiting-skill-scout`.                                                | `daemon/pipelines/plan-pipeline.mjs`, `functions/shared/services/plan-reducer.ts`                                              | 1 day  |
| 3.4   | UI decision card. Existing attention-item rendering already supports `category: manifest-change-proposed`; just need a dedicated render for the YAML diff + confirm/edit/decline/defer actions.                                                                                                                                         | `src/components/labs/plan-dashboard/views/attention-dock.tsx`, `src/components/labs/app-detail/skill-scout-card.tsx` (new)     | 1 day  |
| 3.5   | API `POST /api/skill-scout/proposals/:itemId/confirm`: writes manifest entries, kicks `skills-sync.mjs`, commits with `Agent: SKILL-SCOUT` trailer. Uses already-shipped `daemon/pipelines/skill-promoter.mjs` helpers.                                                                                                                 | `functions/api/index.ts`                                                                                                       | ½ day  |

**Validation:** Create new plan against an existing app under mvp rigor →
SKILL-SCOUT card appears in attention dock → confirm → `.claude/skills.manifest.yaml`
and `.claude/skills/<new>/` updated → next story's commit message shows
`Skills-Used: <new>@<source>`.

**Deferred** (substrate exists, no immediate value gate): T3 brownfield
audit, T5 dep-added git hook, T6 reviewer-cluster, T7 stream-graduation,
T8 weekly cron. All have shipped helpers in `daemon/lib/skill-scout-triggers.mjs`.

---

## 6. Epic 4 — `loadedSkills[]` tracking → populated `Skills-Used:` trailer

Commit-metadata wire is already live (verified in snake-4: the bake
includes `SKILLS_CSV=$(node -e "...")` reading `.context/loaded-skills.json`).
Just need the daemon to write that JSON.

| Story | Action                                                                                                                                                                                                                                                                                                                              | Code touch                          | Effort            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------- |
| 4.1   | At `runAgent()` spawn (~line 1675 in `agent-daemon.mjs`, near the CLAUDE.md load), scan `<workingDir>/.claude/skills/*/SKILL.md`. Write `<workingDir>/.context/loaded-skills.json` as `[{ skill, source }, ...]`. Append-merge across agents within one job (each agent run unions its loadout into the existing file). Idempotent. | `daemon/agent-daemon.mjs::runAgent` | ½ day             |
| 4.2   | Emit a `loaded_skills_recorded` forensic event with the list + sha so we can confirm activation per agent invocation.                                                                                                                                                                                                               | `daemon/agent-daemon.mjs`           | (included in 4.1) |
| 4.3   | (Optional, smarter) Filter the loadout per role-policy hint. E.g. don't claim REVIEWER used `webapp-testing` if it never matched the agent's stepId. Defer until we have data.                                                                                                                                                      | —                                   | (deferred)        |

**Validation:** snake-5 forensic shows `Skills-Used: canvas-design@anthropic-official, frontend-design@anthropic-official`
per story commit. `git log --grep="Skills-Used:.*canvas-design"` returns non-zero.

---

## 7. Epic 5 — CLAUDE.md write hooks (the file finally GROWS during a plan)

Today CLAUDE.md ships as a 1942-byte empty scaffold and stays that way
forever (verified — same SHA `a58a3fb3f46d0205` across all 36 agent
invocations in snake-4). Per v2.5 §41.2 each section has a designated
writer; we wire two of them.

| Story | Action                                                                                                                                                                                                                                                                                                                                                    | Code touch                                                                                        | Effort   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| 5.1   | PM agent populates `## What this is` at project init from the App's intent. New sub-step `claude-md-seed-purpose` in `pm-plan.mjs` does a one-line Edit on CLAUDE.md before plan commit. Idempotent — skips if section non-empty.                                                                                                                         | `daemon/pipelines/pm-plan.mjs`                                                                    | ½ day    |
| 5.2   | DEV agent appends to `## Architecture decisions` on milestone-story completion. Detect milestone via AC text marker (`Architecture:` prefix) or wave-0 foundation stories. New shell step `claude-md-append-decision` after `review`, before `compile-commit-on-pass`. Format per v2.5 §41.2: `<date> — <decision> — <rationale> — DEV @story <storyId>`. | `functions/shared/pipelines/story-pipeline.ts`, `daemon/pipelines/lib/claude-md-writer.mjs` (new) | 1 day    |
| 5.3   | Each write emits a `claude_md_updated` event with new sha so forensics can confirm growth. Append `writeAppendingSection()` export to `claude-md-loader.mjs`.                                                                                                                                                                                             | `daemon/lib/claude-md-loader.mjs`                                                                 | ½ day    |
| 5.4   | Idempotency guard — key each decision entry by `<storyId> + <date>`. Re-running a story must not duplicate.                                                                                                                                                                                                                                               | (same module)                                                                                     | (in 5.2) |

**Validation:** 7-story mvp plan forensic shows `claude_md_loaded` events
with **3+ distinct sha values** as the file grew (1 from PM seed, 2+ from
DEV milestone appends).

---

## 8. Epic 6 — REFLECTOR scheduler + Reflection Inbox surfacing

The loop that promotes Tier 0 (inline CLAUDE.md) → Tier 1 (project skill)
→ Tier 2 (org skill, v2.5 §44). Substrate fully shipped; scheduler is the
missing wire.

| Story | Action                                                                                                                                                                                                                   | Code touch                                                             | Effort |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------ |
| 6.1   | Daemon quiet-window scheduler: when plan flips to `review` (or wave closes under mvp+), enqueue REFLECTOR. Existing `reflector-runner.mjs` is the executor. Use `shouldFireReflection()` rigor matrix (already shipped). | `daemon/agent-daemon.mjs`, `functions/shared/services/plan-reducer.ts` | 1 day  |
| 6.2   | Hook proposals into `/labs/reflections` page (page exists, empty today). The producer side (REFLECTOR writing to `futurator-reflections`) is what was missing.                                                           | (verification — page renders existing rows)                            | 30 min |
| 6.3   | Confirm-action wires `daemon/pipelines/reflector-apply.mjs` (existing helper, no caller) to actually write CLAUDE.md patterns or promote skills. POST endpoint exists; wire it.                                          | `functions/api/index.ts`                                               | ½ day  |
| 6.4   | Global bell sparkle when a Reflection Inbox row is `pending`.                                                                                                                                                            | `src/components/layout/header.tsx`, `src/hooks/use-attention-items.ts` | ½ day  |

**Validation:** After 3 plan runs, `/labs/reflections` shows ≥1 proposal.
Confirming one triggers a commit by `Agent: REFLECTOR` with `Reflection-Id:`
trailer populated.

---

## 9. Epic 7 — Observability ("did it work?")

Without this, success is hard to measure across plan runs.

| Story | Action                                                                                                                                                                                                   | Code touch                                                                                               | Effort |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| 7.1   | `/labs/skills` admin page: per-app card showing manifest contents + vendored skill count + last SKILL-SCOUT run + recent `Skills-Used:` aggregate (`git log --grep="Skills-Used:"` top-10 by frequency). | `src/app/labs/skills/page.tsx` (new), `functions/api/index.ts` (new `GET /api/apps/:slug/skills/digest`) | 1 day  |
| 7.2   | Forensic JSON gains a `skills` block: per-job `loadedSkills` + per-plan manifest sha at start/end. Threads through `forensic-builder.ts`.                                                                | `functions/shared/timer/forensic-builder.ts`                                                             | ½ day  |
| 7.3   | Plan dashboard sidebar shows `Skills loaded: N` chip when non-zero.                                                                                                                                      | `src/components/labs/plan-dashboard/index.tsx`                                                           | ½ day  |

**Validation:** `/labs/skills` shows real numbers per app. snake-4 = 0;
post-Epic-2 dino-test-2 = 3.

---

## 10. Deferred / stretch (Phase 3 substrate, not blocking)

Substrate shipped, no immediate value gate — wire in when relevant signal
appears:

- **ARCHITECT T1/T2 wire-in** (PR-90-followup) — only matters for AWS infrastructure plans.
- **T3 brownfield audit** (`/skills audit` route) — relevant when migrating debatator/applicator/songster.
- **T5 dependency-added git hook** — fires SKILL-SCOUT on `npm install <new-dep>`.
- **T6 REVIEWER cluster detection** — fires SKILL-SCOUT when ≥3 reviewer fails hit the same area.
- **T8 weekly federation refresh cron** — Monday 06:00 UTC, version-bump proposals.
- **Persona evolution** (`Plan.personaPinned` schema shipped) — snapshot personas at plan creation.
- **CDK generation from manifest** — AWS infrastructure plans only.
- **Speculation branches with per-branch manifest** (v2.5 §43).

---

## 11. Open questions / risks

1. **Claude Code skill loader behavior under `claude -p` (non-interactive).** ✅ **RESOLVED 2026-05-19** via the Story 2.0 probe (artifacts at `docs/concepts/logs/skills-probe-2026-05-19/`). `claude -p` 2.1.144 auto-discovers `.claude/skills/<name>/SKILL.md` in cwd AND auto-activates via the built-in `Skill` tool when the prompt content matches the skill's frontmatter `description`. No `--append-system-prompt` injection or `/skill-name` slash command needed. Epic 2 ships as designed.

2. **Cost impact.** Each vendored skill adds 1–10KB to the agent's system-prompt context. 3 skills × 5 KB × 5 agents × 7 stories × 7 plans/week ≈ 3.7MB/week extra prompt tokens. At ~$0.003/1K input tokens for Sonnet (cached after first hit per plan) the marginal cost is bounded but worth budgeting.

3. **Skill format drift.** Anthropic's `template/` shape is the de-facto target but not contractual. If Anthropic changes the SKILL.md frontmatter shape, `skills-sync.mjs`'s parser breaks. Mitigation: pin sources to specific SHAs once they're picked, refresh via T8 cron with operator confirmation.

4. **`futurator-skills` repo seeding.** Epic 1.1 lists 5 seed skills but the content for each (especially `mycelium-knowledge-compile` and `bmad-conventions`) is non-trivial to author. Realistic version: ship the repo with 2 minimal skills (1-page SKILL.md each) and grow from there as REFLECTOR auto-distills (Tier 1 → Tier 2 promotion per v2.5 §44).

5. **Order of operations under T2 + auto-confirm.** Plan-reducer waiting on SKILL-SCOUT could deadlock under unhappy paths (SKILL-SCOUT timeout, ambiguous proposals). Set a 90-second budget; on timeout, proceed with PM using the existing manifest (no new skills). Surface a `skill-scout-t2-timeout` attention item (low severity).

---

## 12. Post-mortem hooks

When each epic ships, capture and append below:

- **Epic 2 ship:** forensic of first plan run against `nextjs-canvas-game` post-Epic-2 vs pre-Epic-2 (snake-4 as the baseline).
- **Epic 4 ship:** `git log --grep="Skills-Used:"` count + content sample from first 3 plans.
- **Epic 5 ship:** sha-delta chart from a single plan's `claude_md_loaded` events.
- **Epic 6 ship:** `/labs/reflections` row count after 5 plan runs.
- **Comparative A/B:** identical intent run pre-Epic-2 (skills empty) vs post-Epic-2 (skills loaded). Compare cost, retry count, REVIEWER pass rate, time-to-green. This is the headline number that justifies the 4-week investment.

---

_Last reviewed: 2026-05-19 against HEAD `feat/treesitter-slice-c-brownfield-bootstrap`._
_Source forensic: `plan_snake-4_mpcdwkto-forensic.json`._
_When reality drifts, edit inline rather than appending notes._
