# Pipeline v2 — Phase 3 Epic Plan

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | **Authored, backlog** — entry point Phase 3-C. Phase 2 is still active; this doc unblocks parallel planning per the 2026-05-14 scoping decision (UI roadmap-strip Phase-3 narrative is authoritative for scope; pulled `explore/`+EVALUATOR and production rigor into Phase 3 over the spec's Phase B/D placement).                                                                                                                                                                                                                 |
| **Authored**     | 2026-05-15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Source spec**  | `docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md` (v2.5 consolidated). Part IV §33–§45 (skills + federation + SKILL-SCOUT + distillation), Part VI §38–§45 (REFLECTOR + Reflection Inbox + CLAUDE.md + memory stores), Part III §28 + §31 (speculation + branch protection), Part V §31/§36 (deploy gate + 24h soak), Part VIII §53/§55/§56 (phase enumeration C/E/F).                                                                                                                                            |
| **Phase scope**  | Compounding — Skills federation + SKILL-SCOUT (3-C), REFLECTOR + Reflection Inbox + memory stores (3-E), brownfield migration of pre-v2 projects (3-F), and Speculation + production-rigor (3-S, pulled from spec Phase B.10 + D.12 + D.15 to match the roadmap-strip narrative). Four sub-phases. v2.5 Parts IV/V/VI and §53/§55/§56 in order.                                                                                                                                                                                     |
| **Effort**       | ~25–30 dev days fixed (3-C ~17d, 3-E ~17d, 3-F ~4d, 3-S ~6d) + ~2 dev days per existing project for Phase 3-F.4 migration runbooks. With ~30% leverage from Phase 2 substrate (CLAUDE.md template already in `template-nextjs`, attention-dock component, Husky frozen-file hook, RolePolicy resolver), net-new is closer to ~36 days.                                                                                                                                                                                              |
| **Ship gate**    | See §3 below — composite condition with four verifiable sub-checks. Mirrors the roadmap-strip Phase-3 pending block.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Out of scope** | Claude Managed Agents (MA) migration (Phase G, blocked on EU residency); skill-set-as-speculation production-rigor variant per v2.5 §43 (basic speculation lands here, skill-set variant deferred to v2.6); REFLECTOR-REVIEWER full multi-LLM verdict pipeline (3-E.10 ships the baseline allowlist check; the Haiku second-pass reviewer is itemized but tagged `defer-after-baseline`); persona forking (explicitly forbidden per v2.5 §42); MCP transport switch from stdio to HTTP (deferred until federation has > 10 skills). |

---

## 1. Big-picture: where Phase 3 sits in v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PIPELINE v2 (overview)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1 — SUBSTRATE                                       ✅ shipped    │
│  ─────────────────────                                                  │
│  GitHub repo per App, typed boilerplates, App-bootstrap saga,           │
│  Roadmap visibility, Timer Intelligence. PR-1 → PR-31. (~16-18d)        │
│                                                                         │
│  Phase 2 — PIPELINE                                       ▶ active      │
│  ──────────────────                                                     │
│  Inner-loop discipline + branch-per-story `wip/` worktrees +            │
│  ARCHITECT + aws.manifest.yaml + OIDC + basic CDK + framework           │
│  detection + runtime-review + bundle source-check. PR-32 → PR-68.       │
│  v2.5 §9–§32 + §51–§54. ~25-30 days.                                    │
│                                                                         │
│  Phase 3 — COMPOUNDING                            ◄── you are here      │
│  ─────────────────────                                                  │
│  Skills federation + SKILL-SCOUT (3-C), REFLECTOR + Reflection Inbox    │
│  + memory stores (3-E), brownfield migration (3-F), speculation         │
│  `explore/` + EVALUATOR + production rigor 24h soak + drift             │
│  detection (3-S). v2.5 §33–§45 + §28 + §31 + §36. ~25-30 days fixed.    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Phase 3 is the **compounding phase**: every prior phase produced a substrate
or a discipline that one or more managed resources can now grow on top of.
Phase 1 produced repos; Phase 2 produced disciplined inner loops with
manifests and OIDC deploys; Phase 3 wires those substrates into self-
improving feedback. The thesis is non-trivial — **a pipeline that watches its
own commits, observes patterns, and proposes its next skill is the only way
solo-developer leverage compounds beyond linear effort spent per project.**

The Phase 3 entry point is **Skills (Phase 3-C)** because every other Phase 3
mechanism (REFLECTOR proposing skill candidates, brownfield audit emitting
manifest deltas, speculation racing two skill sets) needs the federation +
project manifest + SKILL-SCOUT machinery in place to write into. 3-E
(reflection) and 3-S (speculation + prod-rigor) are independent of 3-C only
in their internal mechanics; their **output surfaces** depend on 3-C's
manifest shape. 3-F (brownfield) trails 3-C and Phase 2-D (ARCHITECT + AWS
manifest) because brownfield audit is the cross-cutting consumer of all three
manifest schemas.

Phase 3 deliberately combines what v2.5 splits into Phases C, E, F (and a
slice of B + D). The roadmap-strip narrative the operator sees calls them
"Phase 3" as one unit; the spec sequences them for incremental shippability.
Both perspectives are valid — this doc reconciles them by enumerating four
sub-phases (C, E, F, S) within a single calendar phase.

---

## 2. Where Phase 2 leaves things — substrate inventory

A forward-looking snapshot of what Phase 2 ships into Phase 3. Reading this
against Phase 2's §2 inventory (which describes what Phase 1 left for Phase 2)
shows what each managed resource expects to find when it lands.

| Area                   | Phase 2 ships (assumed)                                                                                                                                 | Phase 3 target                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest layer         | `aws.manifest.yaml` + `integrations.manifest.yaml` (Phase 2-D). `.claude/skills.manifest.yaml` placeholder in starter (PR-8) but not actively resolved. | Three live manifests, one resolver pattern (`manifest + resolver agent + trigger map + lifecycle + rigor matrix` per v2.5 §32 abstract). Skills join AWS and Integrations as a first-class managed resource.           |
| Resolver agents        | ARCHITECT (Phase 2-D). PM exists from v1.                                                                                                               | + SKILL-SCOUT (3-C). + REFLECTOR (3-E). + EVALUATOR (3-S). PM gains coordination logic — when SKILL-SCOUT + ARCHITECT propose overlapping changes, PM combines into one decision card (v2.5 §27.3 / §46).              |
| Commit metadata        | v2.5 §23 template + per-agent type (Phase 2-B). No `Skills-Used:` line yet.                                                                             | + `Skills-Used:` + `Skills-Manifest-Sha:` per commit (3-C.4). + `Skill-Encounter:` lines emitted by COMPILER during distillation (3-C.6). + `Speculation-Result:` artifact in winner-merge commit (3-S).               |
| Branch namespace       | `wip/<storyId>`, `stream/<n>`, `experiment/<n>`, `hotfix/<tag>` (Phase 2-B). Branch protection by rigor (Phase 2-B.7).                                  | + `explore/<plan-id>-<approach>` (3-S). + `archive/<plan-id>-<approach>-rejected` after EVALUATOR (3-S).                                                                                                               |
| Attention surface      | `attention-dock.tsx` + global bell + cross-plan inbox (`/inbox`). v1 + Phase 2.                                                                         | + Reflection Inbox (3-E.3) reusing the dock component family. Confirm / Decline / Defer actions (vs. Resolve / Snooze for attention items). Same severity-grouped layout.                                              |
| CLAUDE.md              | Template in `template-nextjs` from Phase 1 (PR-8); skeleton only — empty sections.                                                                      | Living document loaded into every agent session prefix. Sections populated by PM (initial) + DEV (architecture decisions) + REFLECTOR (patterns, constraints, future enhancements) — see v2.5 §41.2 ownership table.   |
| Inter-agent memory     | None. Daemon spawns each agent fresh.                                                                                                                   | `/mnt/memory/` file-backed hierarchy: `futurator-org/` (read-only org-wide), `project-<slug>/` (read-write project), `inbox/` (read-write inter-agent comms). Reflections, decisions, glossary, triage history.        |
| Skill format           | None resolved. Anthropic CLI skills format (`SKILL.md` + `examples/` + `templates/` + `meta.json`) is the de-facto target.                              | Project skills at `.claude/skills/<n>/`, org skills in `futurator-skills` monorepo with semver tags per skill. Three scopes: operator (`~/.claude/skills`), project (`.claude/skills/`), plan (ephemeral).             |
| Speculation            | Not implemented. Single approach per plan.                                                                                                              | `explore/<plan-id>-<approach>` branches off main, parallel pipeline runs per worktree, EVALUATOR reads both tips and merges winner. Loser archives. Production rigor only. v2.5 §28.                                   |
| Production deploy gate | Phase 2-D.15 reservation: declared in `aws.manifest.yaml` `deploy-gate.requires` but no enforcing flow.                                                 | 24h staging soak + security-audit-clean + operator-approval gate. v2.5 §36. Soak window measured by daemon polling staging metrics dashboards.                                                                         |
| Drift detection        | Phase 2-D ships `aws.manifest.yaml` + CDK derive. Weekly drift scan deferred.                                                                           | T6 weekly drift scan: `cdk diff` against running stacks; non-zero diff emits `architect-drift` attention item. Cost overrun T5 also lives here (Phase D.12 was the umbrella; this doc carries the bits).               |
| Brownfield             | None — assumes greenfield per Phase 1 + Phase 2.                                                                                                        | `Plan.kind: brownfield-audit` with fixed 6-epic template (v2.5 §32.1). `cdk import` for existing AWS resources. Rigor-upgrade plan auto-generation when operator promotes prototype → production.                      |
| Persona surface        | BMAD personas (`Bedrock`, `Nimbus`, `Docker Harbor`, `Rick`) live in operator's home dir. No versioning.                                                | Versioned in `futurator-personas` org repo with semver tags per persona file. Plans pin a persona version at creation. REFLECTOR proposes additions in the inbox; operator approval required regardless of confidence. |

This inventory's invariant: **every Phase 3 sub-phase plugs into a Phase 2 substrate; nothing requires Phase 2 to be torn up.** A working Phase 2 plan should run unmodified after Phase 3 lands; the new mechanisms add output surfaces (decision cards, inbox items) and metadata (commit lines, manifest entries) without changing the existing 11-step inner-loop contract.

---

## 3. Ship gate (Phase 3 done = this composite condition passes)

> **One plan exercises every Phase 3 mechanism end-to-end on a real project.**
>
> Concretely: A production-rigor plan on a Phase-2-completed App proposes
> skill changes via SKILL-SCOUT, races two `explore/` branches that EVALUATOR
> declares a winner on, completes its waves, fires REFLECTOR which produces
> at least one Reflection Inbox proposal, and survives the 24h staging soak
> before the operator promotes it to production. A brownfield audit on one
> existing Futurator project completes with the three manifests committed.

Decomposed into four verifiable sub-checks (mirrors the roadmap-strip
narrative the operator sees today):

1. **SKILL-SCOUT proposal lands in the manifest.**
   For a fresh plan against `dino-runner-1`, SKILL-SCOUT T2 fires, surfaces a
   decision card with proposed skill additions (rationale + source priority +
   verify result), operator confirms, the manifest commit (`Agent:
SKILL-SCOUT`) lands on `main`, and the next agent invocation in the same
   plan shows the new skill in its loaded set (verified via the agent's
   forensic `loadedSkills[]` field). A skill promoted from project-local to
   org-wide via REFLECTOR proposal (`target: org-skill`) is visible in the
   federation manifest (`futurator-skills` repo) on the next weekly refresh.

2. **REFLECTOR fires after plan close and inbox receives a proposal.**
   The plan's last wave reaches `delivered`. Within 10 minutes of daemon
   quiet-window detection, REFLECTOR runs on the low-priority daemon slot,
   reads the diff-only window (`last-seen-sha` frontmatter), and emits at
   least one structured proposal to `inbox/reflections.md` and the UI
   Reflection Inbox. Operator sees the unified diff + rationale + confidence.
   Confirm action lands an `Agent: REFLECTOR-APPLY` commit. Pre-flight
   allowlist check is exercised by a synthetic proposal with a non-allowlisted
   `entrypoint` (e.g. `curl ...`) — it surfaces with the `flagged-for-manual-
review` badge.

3. **Speculation `explore/` branches race; EVALUATOR declares a winner.**
   PM emits a speculation marker on one epic. Pipeline forks two `explore/
<plan-id>-<a>` and `explore/<plan-id>-<b>` branches off main. Both
   worktrees run their respective stories to completion (per-branch manifest
   delta if skill-set speculation; per-branch CDK if infra speculation).
   EVALUATOR reads both branch tips, applies the declared winner-rule,
   surfaces a decision card naming the winner with measured metrics. On
   confirm, winner merges to main via wave-merge; loser renames to
   `archive/<plan-id>-<b>-rejected`. Commit metadata includes the
   `Speculation-Result:` line.

4. **Production deploy gate passes via 24h soak.**
   The same plan tagged production rigor enters staging. Daemon polls
   staging health (5xx rate, dependency error rate, smoke-test pass-rate)
   over a 24-hour window. Gate fires once all three soak conditions hold +
   security-audit-clean + operator-approval. CloudFront's production origin
   swaps to the new semver tag's S3 prefix. Failure mode: any soak condition
   trips → attention item `production-soak-failed` (high), staging stays
   live, operator can re-run soak or roll back.

**Cross-cutting brownfield ship sub-check (3-F):** One existing Futurator
project (suggested: `dino-runner-1`, the first to receive end-to-end Phase 2
mechanics) completes a `brownfield-audit` plan with the three manifests
(skills, AWS, integrations) committed and CDK imports existing resources
without recreation. Validated by `cdk diff` returning empty against the
imported stack after the audit's first commit.

REFLECTOR-REVIEWER (3-E.10) is **not** part of the ship gate — it's the
"defer-after-baseline" guardrail that lands once the rest of Phase 3 has
soaked for one operating cycle.

---

## 4. Prerequisite resolutions (PR-69 onward)

Continuing PR numbering from Phase 2. Phase 2's design-doc itemized PR-32
→ PR-44, but the actual implementation continued through PR-68 with 24
additional PRs (rigor-keyed cost ceilings, tamper-check heredoc fixes,
single-pass verification, runtime framework detection, build-hash
visibility, visual-test classifier floor, PM/Dev screen-verifiable AC
prompts, test-author integration-test contract, review-runtime Haiku
judge, compile-commit non-empty diff guard, wave-build bundle-source-
check). Latest shipped at this doc's authoring (2026-05-15) is **PR-68
— wave-build bundle-source-check**. PR-37, PR-53–PR-58, and PR-66 are
unused gaps in the Phase 2 PR sequence and remain reserved for any
backfill Phase 2 work. **Phase 3 starts at PR-69.**

These are the named decisions Phase 3 inherits from Phase 2 wrap and must
be re-confirmed before each sub-phase starts.

| #     | Decision                                | Resolution                                                                                                                                                                                                                                                                                                                                                                                          | Owner of action |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| PR-69 | Federation manifest location            | **Operator home `~/.futurator/skill-federation.yaml`** (per v2.5 §35.1). Daemon reads at startup and on `kill -USR1 <daemon-pid>` (manual refresh). Backup copy synced to `s3://futurator-config/<operator-id>/skill-federation.yaml` daily for restoration after EC2 instance replacement. Schema versioned via `manifest-version: 1` field.                                                       | Story 3-C-1-1   |
| PR-70 | Federation refresh cadence              | **Weekly** (default per v2.5 §35.1 `refresh-cadence: weekly`), implemented as a cron Lambda firing each Monday 06:00 UTC. Per-source override field permitted (`refresh-cadence: daily` for fast-moving sources like `community`). Refresh emits diff per source as a low-severity attention item; operator confirms or declines new versions.                                                      | Story 3-C-5-2   |
| PR-71 | Skill scope storage                     | **Project-local** at `.claude/skills/<n>/SKILL.md` (committed to project repo). **Plan-local** at `.claude/skills/<plan-id>/` (per worktree, deleted on plan close unless graduated). **Org-wide** at `futurator-skills` repo, fetched into project on manifest sync. **Operator-wide** at `~/.claude/skills/` (untouched by pipeline).                                                             | Story 3-C-2-1   |
| PR-72 | SKILL-SCOUT model + sandbox             | **Sonnet by default, Opus when federation has no fit and SKILL-SCOUT must author** (v2.5 §37 + §37.3). Read-only tools per v2.5 §10. Authoring sub-plan runs in `.skill-creator/<n>/` worktree under sandbox account (`futurator-sandbox`); production AWS access requires explicit operator approval at sub-plan close.                                                                            | Story 3-C-3-1   |
| PR-73 | Commit metadata line format             | **`Skills-Used: <skill>@<source>` comma+space-separated**, sorted alphabetically for deterministic diffs. **`Skills-Manifest-Sha: <40-char>`** (SHA of the manifest file at commit time, not the manifest file's name). COMPILER emits both lines under mvp+ rigor; prototype skips per v2.5 §42 rigor matrix.                                                                                      | Story 3-C-4-1   |
| PR-74 | REFLECTOR daemon slot                   | **Dedicated low-priority slot, FIFO with one concurrent reflection**. Wake schedule: opportunistic on `no plans in 'developing' for ≥ 10 min`; hard floor at ≥ once / 24h if any plan activity since last reflection. Slot occupies one Bedrock concurrent invocation budget at most — independent of dev concurrency.                                                                              | Story 3-E-2-2   |
| PR-75 | REFLECTOR tool gate enforcement         | **Daemon-level: `--disallowedTools "Write,Edit,NotebookEdit,Bash"` plus an MCP wrapper** exposing read-side git verbs (`git log`, `git diff`, `git show`) only. Wrapper rejects `git push`, `git commit`, write-tree operations. Implementation: `daemon/lib/mcp-wrappers/git-readonly.mjs` per v2.5 §38.2.                                                                                         | Story 3-E-2-1   |
| PR-76 | Reflection Inbox UI component family    | **Reuse `attention-dock.tsx` family** per v2.5 §49. New component `reflection-inbox.tsx` shares the chip-filter + severity sort + optimistic-action pattern. Diff renderer (`unified-diff.tsx`) is new — needed for proposal review per v2.5 §39.1. Same global-bell button family; second bell icon (sparkle?) for inbox vs alerts.                                                                | Story 3-E-3-1   |
| PR-77 | Memory store path                       | **`/mnt/memory/`** on the daemon EC2 instance per v2.5 §45, backed by EBS. Subdirs: `futurator-org/` (read-only by agents, writable only by operator + REFLECTOR-APPLY commits), `project-<slug>/`, `inbox/`. EBS snapshot daily to S3 backup bucket. Migration target when MA arrives: MA Memory Store, per-Futurator-user. Today: file-backed.                                                    | Story 3-E-1-1   |
| PR-78 | Persona versioning store                | **`futurator-personas` org repo** with one file per persona at `personas/<n>.md`. Semver tags per file (`bedrock-v1.2.0`). Plans pin a persona version at plan-create time in `Plan.personaPinned: { bedrock: 'v1.2.0', nimbus: 'v0.4.0' }`. Updating a persona repo doesn't retroactively change running plans.                                                                                    | Story 3-E-8-1   |
| PR-79 | Wrap-it threshold scoring location      | **COMPILER computes; REFLECTOR proposes**. COMPILER aggregates command repetitions + failure rate from `metrics.csv` (Phase 2-A.10) across the plan. REFLECTOR reads the aggregate at plan-close, applies the threshold formula (`score = reps × tokens × (1 + fail × 4) ≥ 5000`), surfaces a `tool-wrapper` proposal if exceeded.                                                                  | Story 3-E-7-1   |
| PR-80 | EVALUATOR model                         | **Opus** — speculation evaluation is high-leverage and binary. Read-only tools (Read, Grep, Glob, Bash for `git diff` via MCP wrapper). EVALUATOR is a one-shot agent per speculation; it doesn't iterate.                                                                                                                                                                                          | Story 3-S-1-2   |
| PR-81 | Speculation winner-rule format          | **YAML-declared in plan's speculation marker** per v2.5 §28.1. Three flavor templates: `implementation` (e.g. "highest fps-benchmark with all tests passing"), `skill-set` ("REVIEWER-rejection-count == 0 with smaller bundle size"), `infra` ("lowest monthly-cost-USD with all-tests-pass"). EVALUATOR rejects malformed rules at speculation start with `attention.speculation-rule-malformed`. | Story 3-S-1-1   |
| PR-82 | Production deploy gate trigger          | **Phase D's `deploy-gate.requires` block in `aws.manifest.yaml`** is the source of truth (per v2.5 §25 production env). 3-S enforces it: daemon listens on plan-tag creation; if rigor=production, starts 24h soak; after soak + audit + approval, swaps CloudFront origin. Phase 2-D ships the schema reservation; 3-S ships the enforcing flow.                                                   | Story 3-S-2-1   |
| PR-83 | Drift detection cadence                 | **Weekly** per v2.5 §30.2. Cron Lambda runs `cdk diff` against each project's running stacks (per-environment). Non-empty diff emits `architect-drift` attention item (medium severity), never auto-reverts (v2.5 §25 `drift-policy: on-drift: file-attention-item`). Cost-overrun T5 piggybacks on the same Lambda — emits `cost-overrun` when 80% of `monthly-usd-max` is crossed.                | Story 3-S-3-1   |
| PR-84 | Brownfield-audit kind                   | **New `Plan.kind: brownfield-audit` enum value** added to the Phase 2-A.7 expansion (PR-39). Fixed 6-epic template per v2.5 §32.1. Operator-initiated only — no auto-spawn. After completion, the project transitions from "pre-v2" to "v2-managed" state in `projects` table.                                                                                                                      | Story 3-F-1-1   |
| PR-85 | `cdk import` orchestration              | **ARCHITECT runs `cdk import` per resource** during the brownfield audit's "Generate CDK that imports existing resources" epic. Each import is one stack-change commit (`Agent: ARCHITECT`). Failure to import any resource (e.g. resource is in a state CDK can't import — most CloudFormation-incompatible state) emits `brownfield-import-blocked` and the operator handles manually.            | Story 3-F-2-1   |
| PR-86 | Rigor-upgrade plan template             | **Fixed epics per v2.5 §32.3 + Part VII §50.3 runbook**: backfill tests (target ≥ 60% coverage), SKILL-SCOUT brownfield audit, ARCHITECT brownfield audit, configure dev/staging/production deploy targets, set up cost-envelope, configure drift detection, configure GitHub Actions OIDC, audit IAM for least-privilege. Auto-generated by daemon on operator "promote rigor" click.              | Story 3-F-3-1   |
| PR-87 | Per-project migration runbook authoring | **One per Futurator project**, ~2 dev days each. Author the runbook from the Phase 2 + 3 substrate (manifests + CDK + brownfield audit plan + rigor-upgrade plan + CLAUDE.md template) tailored to the project's existing state. Order: `dino-runner-1` first (smoke test the runbook against the test bed), then high-value projects (Songster, goMAD, Mycelium, Atlassinator).                    | Story 3-F-4-1   |

---

## 5. Architectural decisions encoded in this phase

These are the choices that bind every Phase 3 surface — and downstream v2.6+
add-ons. Captured here so a reader of this doc one quarter from now can
reconstruct intent.

1. **Manifest-first, agent-second.** Every managed resource (skills, AWS,
   integrations) is a manifest before it's an agent. The agent (SKILL-SCOUT,
   ARCHITECT) is the resolver that proposes manifest edits; the manifest is
   the durable artifact. This decouples the agent's lifecycle (model
   upgrades, prompt changes) from the resource's lifecycle (manifest history
   is git-grep-able forever).

2. **Propose-only writes for REFLECTOR.** REFLECTOR never edits state — it
   produces structured proposals consumed by the Reflection Inbox. Operator
   approval is the mutation. This protects against compromised-REFLECTOR
   risk (a malicious skill proposal can't silently land) and aligns with the
   v2.5 §38.2 tool-gate. REFLECTOR-REVIEWER (3-E.10, deferred-after-baseline)
   adds a second LLM verdict but the propose-only invariant holds even
   without it.

3. **Distillation is COMPILER's job, not REFLECTOR's.** REFLECTOR consumes
   distillation signals; COMPILER produces them. This separation matters
   because (a) COMPILER already runs per-wave and per-plan with bounded
   token budgets, and (b) REFLECTOR runs opportunistically and shouldn't be
   blocked on scanning every helper-script repetition. COMPILER emits
   `Skill-Encounter:` commit lines; REFLECTOR queries those lines at
   reflection time.

4. **Speculation is gated to production rigor.** Per v2.5 §28.4 — the cost
   (running plans twice) is meaningful, evaluation criteria need rigorous
   tests, and archived loser branches are discoverable in code review. In
   prototype/mvp, PM's uncertainty manifests as a single chosen approach + a
   RetroNote (separate doc) flagging the alternative for later evaluation.
   This keeps 3-S out of the path of small experiments.

5. **24h soak measures stability, not duration.** Soak success isn't "no
   alarms went off for 24 hours" — it's "the staging environment processed N
   real synthetic requests, dependency calls stayed within their P99
   latency envelope, and the dependency-error rate stayed below threshold."
   Synthetic load is generated by a stack-specific load-script declared in
   `aws.manifest.yaml` `soak-script` field. Without synthetic load, soak is
   theatre.

6. **Brownfield audit is one-way: import, never recreate.** `cdk import` is
   the only acceptable path for bringing existing AWS resources under
   pipeline management. Recreation would destroy state (DDB tables, S3
   objects, Secrets). Audit epics are sequenced so import precedes
   verification; failure to import any resource halts the audit at that
   resource (rather than rebuilding around it).

7. **The Reflection Inbox is operator-facing UI, not agent-facing.** A
   different agent reading the inbox would tempt premature automation. Phase
   3 ships the operator-only surface; v2.6+ may add agent-readable
   reflection summaries (always derived, never primary).

8. **Persona forking is forbidden.** Per v2.5 §42. Capability variation
   lives in the skill manifest, not the persona prompt. A "TTS-aware Dev"
   is just DEV with `audio-pipeline` and `tts-cloning` skills loaded. This
   decision prevents a persona explosion as projects diversify.

9. **Phase 3 sub-phases can land out of strict numerical order.** 3-C (skills)
   is the entry point because it's the manifest layer the other three plug
   into. After 3-C lands, 3-E (reflection) and 3-S (speculation +
   prod-rigor) can interleave; 3-F (brownfield) trails because it consumes
   all three. Effort estimates assume this sequencing.

10. **Phase 3 ends; Phase G (MA migration) does not start automatically.**
    Phase G is opt-in per project, blocked on EU residency + checkpoint TTL.
    File-backed memory stores (PR-77) deliberately mirror the MA Memory Store
    shape so migration is mechanical, not architectural.

---

## 6. Phase 3-C — Skills managed resource (the entry point sub-phase)

**Goal.** Wire skills into the same managed-resource pattern as AWS and
integrations. Land the federation, project manifest, SKILL-SCOUT agent
(triggers T1–T8), commit-metadata lines, auto-distillation, and the
skill-authoring sub-plan automation. v2.5 §53 (Phase C, 9 items).

**Source.** v2.5 Part IV §33–§45.

**Dependency.** Phase 2-D ARCHITECT + manifests pattern (3-C reuses the
manifest+resolver shape). Phase 2-B branch-per-story (3-C-7 sub-plan
automation spawns child plans against `wip/<storyId>` branches).

**Sequencing within sub-phase.** 3-C-1 (federation) and 3-C-2 (project
manifest) first — prerequisites for everything else. Then 3-C-3 (SKILL-SCOUT
agent + T1/T2/T3 — the foundational triggers). Then 3-C-4 (commit metadata)
in parallel with 3-C-5 (T4–T8) and 3-C-6 (distillation). 3-C-7 (skill-creator
sub-plan), 3-C-8 (cross-project propagation), 3-C-9 (CodeArtifact) wrap up.

### Epic 3-C-1 — Federation manifest + resolver 🌐

**Goal:** Read `~/.futurator/skill-federation.yaml` at daemon startup,
resolve skill candidates by priority + auto-trust policy, return the first
match. Closes Phase C item C.1.

**Dependency:** none.

#### Story 3-C-1-1 — Federation manifest schema + storage

`pv2-p3-c-1-1-federation-manifest` · **M** · **review** — PR-69, 2026-05-15

**Acceptance Criteria:**

1. `functions/shared/schemas/skill-federation-schema.ts` exports `SkillFederationSchema` (Zod) + `SkillFederation` type per v2.5 §35.1: `{ sources: [{ id, url, auto-trust: boolean, priority: number, refresh-cadence?: string }], refresh-cadence: string, manifest-version: number }`.
2. Daemon reads `~/.futurator/skill-federation.yaml` at startup; missing file falls back to the embedded default (Anthropic-official + futurator-internal + community at priority 99). Parse error emits `attention.federation-manifest-invalid` (high severity).
3. Backup sync: daemon emits the parsed manifest to `s3://futurator-config/<operator-id>/skill-federation.yaml` once daily via `daemon/cron/federation-backup.mjs`. EBS instance replacement restores from the backup.
4. Manual refresh via `kill -USR1 <daemon-pid>` re-reads the file without daemon restart. Signal handler emits a `federation-refreshed` event with the new manifest's SHA.
5. Unit tests cover: valid manifest parses, missing-file fallback, malformed YAML emits attention, signal-handler refresh updates the in-memory copy.
6. Operator-only manifest editing — no API surface to mutate from Labs UI in Phase 3 (3-E weekly-refresh proposals are the agent-side write path).

**Touch points:**

- `functions/shared/schemas/skill-federation-schema.ts` (new)
- `functions/shared/schemas/__tests__/skill-federation-schema.test.ts` (new)
- `daemon/lib/federation-loader.mjs` (new — reads file + signal handler)
- `daemon/lib/__tests__/federation-loader.test.mjs` (new)
- `daemon/cron/federation-backup.mjs` (new — daily S3 sync)
- `daemon/agent-daemon.mjs` (call loader at startup, install signal handler)

**Tasks:**

- [ ] Author Zod schema
- [ ] Implement loader with fallback default
- [ ] Wire SIGUSR1 handler
- [ ] Author backup cron
- [ ] Unit tests for all paths
- [ ] Smoke: start daemon with malformed file → attention emitted, fallback used

#### Story 3-C-1-2 — Federation resolver

`pv2-p3-c-1-2-federation-resolver` · **M** · **review** — PR-70, 2026-05-15

**Acceptance Criteria:**

1. `daemon/lib/federation-resolver.mjs` exports `resolveSkill(query, federation): { source, skillName, score, autoTrust } | null` where `query` is `{ skillName, kind?, projectStack? }`.
2. Walks sources in priority order; for each, checks if the source's index lists `skillName`; returns the first match. `auto-trust: false` sources still return matches but flag `autoTrust: false` so the caller knows to require operator confirm.
3. Source index fetching: for `github.com/<org>/<repo>`-style URLs, fetches `index.json` from the repo's `main` branch via the existing GitHub connector (Phase 1). Indexes are cached in memory with a 1h TTL; signal-handler refresh (PR-69) invalidates.
4. Unit tests cover: priority ordering, missing skill returns null, non-auto-trust source returns flag, cached index served on second call within TTL.
5. Resolver is read-only — never writes to manifest or fetches the skill body itself; that's SKILL-SCOUT's job (3-C-3).

**Touch points:**

- `daemon/lib/federation-resolver.mjs` (new)
- `daemon/lib/__tests__/federation-resolver.test.mjs` (new)
- `functions/shared/github/connector.ts` (extend `getFileContent` to support arbitrary repos beyond `futurator-repos`)

**Tasks:**

- [ ] Implement resolver
- [ ] Extend GitHub connector for arbitrary repo reads
- [ ] In-memory cache with 1h TTL + signal-invalidation
- [ ] Unit tests for priority ordering + cache behavior
- [ ] Smoke: resolve `frontend-design` → returns anthropic-official source

---

### Epic 3-C-2 — Project skill manifest + sync command 📜

**Goal:** Per-project manifest at `.claude/skills.manifest.yaml`. Schema +
parse + `npx skills sync` CLI in starter. Closes Phase C item C.2.

**Dependency:** Epic 3-C-1.

#### Story 3-C-2-1 — Project manifest schema + sync command

`pv2-p3-c-2-1-project-skill-manifest` · **M** · **review** — PR-71, 2026-05-15

**Acceptance Criteria:**

1. `functions/shared/schemas/project-skill-manifest-schema.ts` exports `ProjectSkillManifestSchema` (Zod) + `ProjectSkillManifest` type per v2.5 §36: `{ project, manifest-version, generated-by, core[], stack[], domain[], vendor[], plans: Record<planId, { skills[], graduate-policy }>, gaps[] }`.
2. Each skill entry shape: `{ source: <source-id>, skill: <name>, version: 'sha:<40-char>' | 'tag:<semver>' }`. Version is required (PR-73 commit metadata depends on it).
3. `npx skills sync` CLI (lives in `template-nextjs/scripts/skills-sync.mjs`, syncs to starter for brownfield via boilerplate sync per v2.5 §13.2) reads manifest, fetches each declared skill into `.claude/skills/<n>/`, verifies SHA matches.
4. Drift detection: if any local skill folder's content SHA doesn't match the manifest entry's `version`, emit `manifest-skill-drift` attention item (medium). Operator chooses re-sync (overwrite local) or re-pin (update manifest from local).
5. `.claude/skills/` is gitignored except `SKILL.md` files (those are committed for diff review). `meta.json` (`{ version, createdAt, lastUsedAt, evidenceJobIds[] }`) is committed.
6. Brownfield: existing `dino-runner-1` gets an empty manifest committed during brownfield audit (3-F.1).

**Touch points:**

- `functions/shared/schemas/project-skill-manifest-schema.ts` (new)
- `functions/shared/schemas/__tests__/project-skill-manifest-schema.test.ts` (new)
- (out-of-repo) `futurator-repos/template-nextjs/scripts/skills-sync.mjs` (new)
- (out-of-repo) `futurator-repos/template-nextjs/.claude/skills.manifest.yaml` (new — empty placeholder)
- `functions/shared/boilerplates/registry.ts` (add `skillsManifestPath`, `syncScriptPath` fields)
- `functions/shared/boilerplates/types.ts` (extend `BoilerplateType` metadata)

**Tasks:**

- [ ] Author Zod schema
- [ ] CLI script (Node, no deps beyond `js-yaml`)
- [ ] SHA verification path
- [ ] Drift detection + attention emission
- [ ] Update template-nextjs + boilerplate registry
- [ ] Smoke: sync against an empty manifest → no-op; sync after adding one entry → fetches skill

---

### Epic 3-C-3 — SKILL-SCOUT agent + T1/T2/T3 triggers 🔭

**Goal:** Resolver agent. Surfaces decision cards proposing manifest changes
at three foundational triggers: project init, plan intent submitted,
brownfield audit. Closes Phase C item C.3.

**Dependency:** Epic 3-C-1 + Epic 3-C-2.

#### Story 3-C-3-1 — SKILL-SCOUT agent definition + decision card

`pv2-p3-c-3-1-skill-scout-agent` · **L** · **review** — PR-72, 2026-05-15

**Acceptance Criteria:**

1. `functions/shared/pipelines/skill-scout-pipeline.ts` defines the SKILL-SCOUT agent. Model: Sonnet (Opus when authoring per PR-72). Tools via `resolveRolePolicy('skill-scout-pipeline', rigor, 'SKILL_SCOUT')`: `Read, Glob, Grep, Bash` with disallow `Write, Edit, NotebookEdit` and an MCP wrapper for federation lookups.
2. Inputs: `{ trigger: 'T1' | 'T2' | 'T3', projectSlug, planIntent?, existingManifest, federation }`. Output: `Array<SkillProposal>` where `SkillProposal = { kind: 'add' | 'remove' | 'upgrade', source, skill, version, rationale, confidence }`.
3. Verify step (deterministic, post-LLM): for each proposal, fetch `SKILL.md`, check license header (`license: MIT|Apache-2.0|...`), check freshness (last-commit < 18 months ago), check description-collision against existing manifest entries. Verify failures downgrade confidence + add `verify-failure: <reason>` to proposal.
4. Decision card surfaced via Phase 2 attention machinery: `kind: 'manifest-change-proposed'`, severity `medium`, action `[confirm, edit, decline, defer]`. On confirm, `daemon/pipelines/lib/skill-installer.mjs` applies the manifest edit + commits with `Agent: SKILL-SCOUT` metadata + bumps `Skills-Manifest-Sha:` line.
5. Forensic JSON: SKILL-SCOUT run emits `step.skill-scout.{trigger}` events with `proposalCount`, `acceptedCount`, `verifyFailureCount`.
6. PR-72 sandbox: any SKILL-SCOUT shell-out that touches AWS (rare, only when verifying a cost-shim skill or MCP wrapper) runs against `futurator-sandbox` account profile.

**Touch points:**

- `functions/shared/pipelines/skill-scout-pipeline.ts` (new)
- `functions/shared/pipelines/__tests__/skill-scout-pipeline.test.ts` (new)
- `functions/shared/prompts/skill-scout-prompt.ts` (new)
- `functions/shared/pipelines/role-policy.ts` (add `SKILL_SCOUT` role from Phase 2-A.1)
- `daemon/pipelines/lib/skill-installer.mjs` (new)
- `functions/shared/types/agent-orchestrator.ts` (extend `Role` enum)
- `functions/shared/timer/types.ts` + `slicer.ts` (new step category `skill-scout`)

**Tasks:**

- [ ] Author SKILL-SCOUT prompt template
- [ ] Implement pipeline + verify step
- [ ] Skill installer (manifest edit + commit + SHA bump)
- [ ] Forensic step events
- [ ] Decision card wiring (attention emission)
- [ ] Negative test: license-missing skill → confidence < 0.5
- [ ] Smoke: run T1 against an empty project → proposes core skills

#### Story 3-C-3-2 — Triggers T1 (init) + T2 (plan intent) + T3 (brownfield audit)

`pv2-p3-c-3-2-skill-scout-triggers-t1-t2-t3` · **M** · **review** — PR-72, 2026-05-15 (runner shipped; trigger-point wiring follow-on)

**Acceptance Criteria:**

1. T1: daemon fires SKILL-SCOUT at end of app-bootstrap (Phase 1 Epic 1.4) with `trigger: 'T1'`. Full federation sweep, all kinds. Operator confirms before any first commit lands.
2. T2: daemon fires SKILL-SCOUT before PM decomposition (Phase 2 inner-loop step) with `trigger: 'T2'`, plan intent + existing manifest as input. Auto-confirm under prototype (no decision card), surface card under mvp+ per v2.5 §38.
3. T3: operator runs `/skills audit` command (new API route `POST /api/skills/audit` triggers daemon job). Reports against current code; never auto-installs even under prototype.
4. T1 + T2 conditional: if SKILL-SCOUT returns zero proposals, no card surfaces (no operator interruption for the empty case).
5. Per v2.5 §27.3: when ARCHITECT also proposes changes for the same plan, PM combines them into one decision card. Coordination: PM reads both agents' outputs from `inbox/pm-to-dev.md` (Phase 2 substrate) before surfacing.
6. Forensic JSON: trigger events emitted with `Tn` tag for queryability.

**Touch points:**

- `daemon/pipelines/app-bootstrap.mjs` (wire T1)
- `daemon/pipelines/plan-pipeline.mjs` (wire T2 before PM)
- `functions/api/index.ts` (new `POST /api/skills/audit` route)
- `functions/shared/services/skill-audit-service.ts` (new)
- `functions/shared/prompts/pm-plan-prompt.ts` (extend to read SKILL-SCOUT + ARCHITECT outputs)

**Tasks:**

- [ ] Wire T1 in app-bootstrap
- [ ] Wire T2 in plan pipeline
- [ ] API route + daemon job for T3
- [ ] PM coordination logic (combined card)
- [ ] Smoke: T1 on fresh app → card with core skills; T2 on plan → card with stack-skill proposal

---

### Epic 3-C-4 — Skills in commit metadata 🪪

**Goal:** Every commit under mvp+ rigor carries `Skills-Used:` +
`Skills-Manifest-Sha:` lines. Closes Phase C item C.4.

**Dependency:** Epic 3-C-2 + Phase 2-B.1 (commit-metadata template lives in
COMPILER step).

#### Story 3-C-4-1 — Commit metadata lines emitted by COMPILER

`pv2-p3-c-4-1-skills-used-commit-metadata` · **S** · **review** — PR-73, 2026-05-15

**Acceptance Criteria:**

1. COMPILER step (last step of story pipeline, Phase 2-A.7) extended to emit two new lines in commit message: `Skills-Used: <skill>@<source>, <skill>@<source>` (sorted alphabetically) and `Skills-Manifest-Sha: <40-char>`.
2. Lines emitted under mvp+ rigor only per v2.5 §42 rigor matrix; prototype skips with no line.
3. `Skills-Used` content = the set of skills loaded into the agent session that produced the change. Daemon tracks `loadedSkills[]` per agent invocation (in forensic JSON); COMPILER aggregates across all agents in the story.
4. `Skills-Manifest-Sha` = SHA-256 of the manifest file's text at commit time (not the file's git SHA, which would chicken-and-egg the commit).
5. `git log --grep="Skills-Used:.*music-theory-engine"` returns commits where that skill was active (verified by smoke test).
6. Manifest-Sha rolls forward on every commit that touches `.claude/skills.manifest.yaml`; unchanged otherwise.

**Touch points:**

- `daemon/pipelines/lib/commit-metadata.mjs` (extend with two new fields)
- `daemon/pipelines/compile-pipeline.mjs` (call extended commit metadata)
- `functions/shared/types/agent-orchestrator.ts` (add `loadedSkills` to forensic event)
- `daemon/lib/skill-loader.mjs` (new — populates `loadedSkills` per agent run)

**Tasks:**

- [ ] Add fields to commit-metadata helper
- [ ] Populate `loadedSkills` in forensic JSON per agent run
- [ ] Aggregate in COMPILER
- [ ] Smoke: plan completes → `git log --grep "Skills-Used:"` returns rows

---

### Epic 3-C-5 — SKILL-SCOUT triggers T4–T8 ⚡

**Goal:** Speculation (T4), new-dependency (T5), REVIEWER-repeat-failure
(T6), stream-graduates-to-plan (T7), weekly refresh (T8). Closes Phase C
item C.5.

**Dependency:** Epic 3-C-3 (foundational triggers). T4 also depends on
Epic 3-S-1 (speculation infrastructure).

#### Story 3-C-5-1 — T4 (speculation) + T5 (new dependency)

`pv2-p3-c-5-1-skill-scout-t4-t5` · **M** · **review** — PR-79, 2026-05-15

**Acceptance Criteria:**

1. T4: when PM emits a speculation marker (Epic 3-S-1), SKILL-SCOUT proposes candidate skill sets per `explore/` branch. Output: `Array<{ branch: 'explore/<plan-id>-<a>', proposals: SkillProposal[] }>` — each branch's worktree gets its own manifest delta.
2. T5: daemon git-hook (new `daemon/lib/git-hooks/dependency-added.mjs`) fires on commits that add entries to `package.json` `dependencies` or `devDependencies`. SKILL-SCOUT searches federation for `<dep>-best-practices` skill, surfaces proposal if found.
3. T5 noise control: only fires for top-level `dependencies`/`devDependencies` changes, not transitive lockfile diffs. Debounce 5 minutes per project — multiple deps added in quick succession produce one card.
4. Both triggers respect rigor matrix: auto-confirm under prototype if confidence ≥ 0.9, surface card otherwise.
5. Forensic JSON: T4/T5 events emitted.

**Touch points:**

- `daemon/lib/git-hooks/dependency-added.mjs` (new)
- `daemon/agent-daemon.mjs` (wire hook on commit events)
- `functions/shared/pipelines/skill-scout-pipeline.ts` (extend with T4/T5 branches)

**Tasks:**

- [ ] Git hook for new dep
- [ ] T4 plumbing tied to PM speculation marker
- [ ] Debounce logic
- [ ] Smoke: add `stripe` to package.json → SKILL-SCOUT proposes stripe-checkout

#### Story 3-C-5-2 — T6 (REVIEWER repeat-failure) + T7 (stream graduates) + T8 (weekly refresh)

`pv2-p3-c-5-2-skill-scout-t6-t7-t8` · **M** · **review** — PR-79, 2026-05-15

**Acceptance Criteria:**

1. T6: COMPILER tracks REVIEWER rejections by file-cluster; when same cluster rejected ≥ 3 stories in a wave, emits `Skill-Encounter:` line and triggers SKILL-SCOUT T6. SKILL-SCOUT searches for a skill addressing the cluster (e.g. repeated React hooks misuse → `react-hooks-discipline` skill).
2. T7: when `stream/<n>` graduates to a Labs plan (Phase 2-B.6), daemon re-runs SKILL-SCOUT against the crystallized plan intent. The stream's commits inform the proposal.
3. T8: weekly cron Lambda (`futurator-skill-federation-refresh`) runs Monday 06:00 UTC. Polls each federation source for new versions, surfaces an attention item per relevant project (`federation-update-available`, low severity).
4. T8 per-source override: source-level `refresh-cadence: daily` field (PR-70) is honored; default `weekly`.
5. Forensic JSON: T6/T7/T8 events emitted with `proposalCount` per trigger.
6. Deprecation flow: when T8 detects a deprecated skill (federation source declares `deprecate-by: <date>` and date is past), attention item severity is `medium` per v2.5 §36.2 production track.

**Touch points:**

- `daemon/pipelines/lib/reviewer-cluster-tracker.mjs` (new)
- `daemon/cron/skill-federation-refresh.mjs` (new)
- `functions/shared/pipelines/skill-scout-pipeline.ts` (extend with T6/T7/T8)
- `daemon/pipelines/stream-graduation.mjs` (wire T7)

**Tasks:**

- [ ] REVIEWER cluster tracker in COMPILER
- [ ] Weekly refresh cron
- [ ] Stream graduation hook
- [ ] Deprecation handling
- [ ] Smoke: 3 REVIEWER rejections on same file → SKILL-SCOUT proposes; weekly cron emits update card

---

### Epic 3-C-6 — Auto-distillation in COMPILER 🧪

**Goal:** COMPILER watches for repeated patterns and emits distillation
signals that feed into 3-E.5 (REFLECTOR skill-promotion proposals). Closes
Phase C item C.6.

**Dependency:** Epic 3-C-4 (commit metadata is the signal carrier).

#### Story 3-C-6-1 — Distillation signals in COMPILER

`pv2-p3-c-6-1-compiler-distillation-signals` · **L** · backlog

**Acceptance Criteria:**

1. COMPILER (post-plan-close, runs as final step of `plan-build-pipeline.ts`) scans plan's commits for distillation signals per v2.5 §41.1:
   - Same helper script appears in ≥ 2 plans → strong signal (compares against `git log --all --grep "Skill-Encounter:"` history across all plans)
   - Same architectural pattern (file-tree shape, naming pattern) repeats ≥ 3 times → medium signal
   - Same multi-step REVIEWER fix sequence repeats → strong signal
   - Recurring naming or testing convention in stream branches → medium signal (file-tree heuristic)
2. Each signal emits a `Skill-Encounter: <pattern-id> attempt:<n>` commit metadata line on the plan-close commit.
3. Auto-distill rigor matrix per v2.5 §41.2: prototype = manual, mvp = manual, production = auto-spawn skill-creator sub-plan (handled by Epic 3-C-7).
4. Encounters counter persists across plans via `git log --grep "Skill-Encounter: <pattern-id>"`; threshold checked against full history, not just the current plan.
5. Distillation signal output also surfaces as a REFLECTOR-readable line in `inbox/reflections.md` so 3-E REFLECTOR proposals can reference it.

**Touch points:**

- `daemon/pipelines/lib/distillation-detector.mjs` (new)
- `daemon/pipelines/plan-build-pipeline.mjs` (wire detector at plan-close)
- `daemon/pipelines/lib/commit-metadata.mjs` (extend with `Skill-Encounter` line)
- `daemon/pipelines/lib/__tests__/distillation-detector.test.mjs` (new)

**Tasks:**

- [ ] Implement four signal detectors
- [ ] Wire at plan-close
- [ ] Commit metadata extension
- [ ] History query helper
- [ ] Smoke: run two plans with same helper script → second emits `Skill-Encounter:` with attempt=2

---

### Epic 3-C-7 — Skill-creator sub-plan automation 🤖

**Goal:** When auto-distill fires under production rigor, daemon spawns a
sub-plan that runs the skill-creator skill through the full story pipeline.
Closes Phase C item C.7.

**Dependency:** Epic 3-C-6 (distillation signals trigger this).

#### Story 3-C-7-1 — Sub-plan spawning on encounters ≥ 3

`pv2-p3-c-7-1-skill-creator-subplan` · **L** · backlog

**Acceptance Criteria:**

1. COMPILER plan-close check: if any `Skill-Encounter` line has `attempt:3` or higher AND rigor=production, daemon spawns sub-plan with `Plan.kind: skill-author` and a fixed epic template from v2.5 §39 (resolve → verify → propose → confirm → install → validate → announce).
2. Sub-plan has its own `wip/<storyId>` branches under `.skill-creator/<n>/` worktree (per PR-72 sandbox isolation). Plan-tag on completion: `<project>-skill-<name>-v<semver>`.
3. On sub-plan success, new skill registers in `futurator-internal` repo via PR + the parent plan's manifest is updated to include the new skill.
4. Sub-plan dependency: parent plan stays in `developing` until sub-plan completes (parent's wave-merge is blocked on the manifest edit landing).
5. Failure mode: sub-plan red → `attention.skill-author-failed` (high), parent plan continues without the new skill (gap remains in manifest with `encounters` count incremented).
6. Decision card at sub-plan start: operator can opt out (`Decline — keep filing this gap manually`).

**Touch points:**

- `daemon/pipelines/skill-author-pipeline.mjs` (new)
- `daemon/pipelines/plan-pipeline.mjs` (sub-plan spawn logic)
- `functions/shared/schemas/plan-schema.ts` (add `skill-author` kind)
- `functions/shared/types/plan.ts` (extend `Plan.kind` enum — depends on Phase 2-A.7)

**Tasks:**

- [ ] Skill-author pipeline implementation
- [ ] Sub-plan spawning + parent-plan-blocking logic
- [ ] Plan.kind enum extension
- [ ] Sub-plan worktree isolation
- [ ] Smoke: synthetic 3rd encounter under production → sub-plan spawns → on success, parent's manifest updates

---

### Epic 3-C-8 — Cross-project propagation via weekly refresh 🌍

**Goal:** When a project promotes a local skill to org-wide (via REFLECTOR
proposal in 3-E.5), weekly refresh proposes it to other Futurator projects
whose stack matches. Closes Phase C item C.8.

**Dependency:** Epic 3-C-5 (T8 refresh is the carrier).

#### Story 3-C-8-1 — Stack-matched cross-project propagation

`pv2-p3-c-8-1-cross-project-propagation` · **M** · backlog

**Acceptance Criteria:**

1. When a skill is promoted (3-E.5 lands `REFLECTOR-APPLY` commit on `futurator-skills/<skill>/`), daemon tags the skill with its source project's stack fingerprint (`{ boilerplateKind, primaryFramework, awsServices[] }`).
2. Weekly refresh (T8) reads each project's manifest + stack fingerprint; for newly-promoted org skills whose source stack matches a project's stack ≥ 70% by Jaccard similarity, surfaces a `propagation-candidate` attention item with the source project named.
3. Operator confirms / declines per project. Confirm → project's manifest gets the new entry on next sync; decline → propagation-decline recorded so future refreshes don't re-propose for that project-skill pair.
4. Cross-project provenance visible: org skill's `meta.json` lists `firstAddedBy: <project>`, `propagatedTo: [<projects>]`.
5. Edge case: if propagation candidate's stack matches > 5 projects, batched into one card "this skill matches Songster, goMAD, dino-runner-1 — propose to all?"

**Touch points:**

- `daemon/cron/skill-federation-refresh.mjs` (extend with propagation logic)
- `functions/shared/services/stack-fingerprint.ts` (new — computes Jaccard similarity)
- `functions/shared/types/skill.ts` (new — extends `meta.json` shape)

**Tasks:**

- [ ] Stack-fingerprint computer
- [ ] Jaccard similarity helper
- [ ] Propagation card surfaced in refresh
- [ ] Decline persistence
- [ ] Smoke: promote a skill from one project → refresh proposes to a matching project

---

### Epic 3-C-9 — Private CodeArtifact MCP server registry 📦

**Goal:** `@futurator/mcp-*` packages live in private CodeArtifact in
eu-central-1. Sets up the publish + consume path. Closes Phase C item C.9.

**Dependency:** none (independent of other 3-C epics; pull into 3-S if 3-C
schedule overruns).

#### Story 3-C-9-1 — CodeArtifact setup + first MCP package

`pv2-p3-c-9-1-codeartifact-mcp` · **L** · backlog

**Acceptance Criteria:**

1. CodeArtifact domain `futurator` + repository `mcp` provisioned via SST in `eu-central-1` (added to `sst.config.ts`). Public-npm upstream allowed; `@futurator/*` scope is private.
2. CI workflow `.github/workflows/publish-mcp.yml` in `futurator-skills` repo publishes per-package on tag push (`<package>@<semver>` tag).
3. First `@futurator/mcp-*` package authored and published as a smoke test: `@futurator/mcp-git-readonly` (the wrapper from PR-75 that exposes read-side git verbs only). Used by REFLECTOR in 3-E.
4. Project consumes via `.npmrc` with `@futurator:registry=https://futurator-<acct>.d.codeartifact.eu-central-1.amazonaws.com/npm/mcp/`. Auth via CodeArtifact `aws codeartifact get-authorization-token` — daemon's instance profile already has the IAM permission.
5. MCP transport per v2.5 §36.2: in-process for daemon-state tools, stdio for external service wrappers. First package is in-process (consumed by REFLECTOR's daemon-slot session).

**Touch points:**

- `sst.config.ts` (provision CodeArtifact domain + repo)
- (out-of-repo) `futurator-skills/.github/workflows/publish-mcp.yml` (new)
- (out-of-repo) `futurator-skills/packages/mcp-git-readonly/` (new package)
- `daemon/.npmrc` (configure CodeArtifact)
- `daemon/lib/mcp-wrappers/git-readonly.mjs` (consume from package, replaces local impl from PR-75 reservation)

**Tasks:**

- [ ] SST provisioning
- [ ] Author publish workflow
- [ ] Author first MCP package
- [ ] Daemon `.npmrc` config + IAM check
- [ ] Smoke: install package from CodeArtifact in daemon → REFLECTOR uses it

---

## 7. Phase 3-E — Reflection loop

**Goal.** REFLECTOR agent (read-only, propose-only), Reflection Inbox UI,
inter-agent memory stores, project CLAUDE.md as living document, skill
promotion path, triage agent + cross-plan history, tool-wrap-it threshold,
persona evolution, pre-flight allowlist, REFLECTOR-REVIEWER. v2.5 §55
(Phase E, 10 items).

**Source.** v2.5 Part VI §38–§45.

**Dependency.** Phase 2 substrate. 3-C (manifest layer) for skill-related
proposals.

**Sequencing within sub-phase.** 3-E-1 (memory stores) first — every other
epic reads/writes here. Then 3-E-2 (REFLECTOR agent) + 3-E-3 (inbox UI) in
parallel. Then 3-E-4 (CLAUDE.md flow) + 3-E-5 (skill promotion) + 3-E-7
(wrap-it threshold) + 3-E-9 (pre-flight allowlist). 3-E-6 (triage agent)

- 3-E-8 (persona evolution) + 3-E-10 (REFLECTOR-REVIEWER, deferred-after-
  baseline tag) wrap up.

### Epic 3-E-1 — Inter-agent memory stores 🧠

**Goal:** File-backed `/mnt/memory/` hierarchy mirroring v2.5 §45. Read/
write conventions per agent role. Closes Phase E item E.1.

**Dependency:** none.

#### Story 3-E-1-1 — `/mnt/memory/` layout + read/write conventions

`pv2-p3-e-1-1-memory-stores` · **M** · **review** — PR-77, 2026-05-15

**Acceptance Criteria:**

1. Daemon provisions `/mnt/memory/` on startup (EBS volume mounted at boot per existing infra). Three subdirs created if missing: `futurator-org/`, `project-<slug>/` (one per project in DDB), `inbox/`.
2. `futurator-org/` files: `brand-voice.md`, `bmad-conventions.md`, `aws-patterns.md`, `known-pitfalls.md` — seeded from a starter set committed to a new repo `futurator-org-memory`. Read-only for agents; writable only by operator + REFLECTOR-APPLY commits.
3. `project-<slug>/` files: `CLAUDE.md` (the living document, 3-E.4), `decisions.md` (append-only architecture log), `glossary.md`, `known-issues.md`, `skills/` (project-local skills from 3-C.2). Read-write for project agents.
4. `inbox/` files: `pm-to-dev.md`, `dev-to-reviewer.md`, `reviewer-to-qa.md`, `qa-to-deploy.md`, `triage-history.md`, `reflections.md`, `decisions.md`. Read-write for inter-agent comms. Each agent writes to its own outbox file at session end; next agent reads at start.
5. Daemon helper `daemon/lib/memory-store.mjs` exports `read(scope, file)`, `appendLine(scope, file, content)`, `writeAtomic(scope, file, content)`. Path traversal checks (no `..`); scope param prevents cross-project reads.
6. EBS snapshot to S3 daily via `daemon/cron/memory-backup.mjs`. Restoration tested manually.
7. Migration target shape mirrors MA Memory Store API (per PR-77 architectural decision) — file-backed today, MA migration is mechanical.

**Touch points:**

- `daemon/lib/memory-store.mjs` (new)
- `daemon/lib/__tests__/memory-store.test.mjs` (new)
- `daemon/cron/memory-backup.mjs` (new)
- `daemon/agent-daemon.mjs` (mount + provision at startup)
- (out-of-repo) `futurator-org-memory/` (new repo with seed content)

**Tasks:**

- [ ] Implement memory-store helper
- [ ] Provisioning at startup
- [ ] EBS daily snapshot cron
- [ ] Author seed `futurator-org-memory` content
- [ ] Smoke: agent writes to outbox → next agent reads

---

### Epic 3-E-2 — REFLECTOR agent 🔍

**Goal:** Read-only, write-proposal agent. Triggers per v2.5 §38.1 (story-
close production-only, wave-close all-rigors, plan-delivered all-rigors,
plan-delivered-after-fixing). Diff-only mode keyed on `last-seen-sha`.
Closes Phase E item E.2.

**Dependency:** Epic 3-E-1.

#### Story 3-E-2-1 — REFLECTOR agent definition + diff-only mode

`pv2-p3-e-2-1-reflector-agent` · **L** · **review** — PR-74, 2026-05-15

**Acceptance Criteria:**

1. `functions/shared/pipelines/reflector-pipeline.ts` defines the REFLECTOR agent. Model: Sonnet. Tools via `resolveRolePolicy('reflector-pipeline', rigor, 'REFLECTOR')`: `Read, Grep, Glob` + MCP wrapper `@futurator/mcp-git-readonly` (from 3-C.9). Disallow `Write, Edit, NotebookEdit, Bash`.
2. Input: trigger type + scope (story / wave / plan / brownfield-cycle) + `last-seen-sha` from inbox frontmatter. Agent reads `inbox/reflections.md` frontmatter, then `git log --since=$last-reflection-at` to scope the diff.
3. Output format: structured proposals per v2.5 §38.4. Targets: `project-claude-md`, `project-skill`, `agent-persona`, `org-skill`, `pipeline-config`, `tool-wrapper`. Each proposal has `action`, `rationale`, `confidence`, `evidence`.
4. Output written as appendage to `inbox/reflections.md` (not a separate file) so the frontmatter `last-seen-sha` rolls forward atomically.
5. Pre-flight check (Epic 3-E-9 supplies the allowlist) runs before any proposal lands in the inbox UI; violations get a `flagged-for-manual-review` badge.
6. Forensic JSON: `step.reflector.{scope}` events emitted with `proposalCount`, `tokensConsumed`.

**Touch points:**

- `functions/shared/pipelines/reflector-pipeline.ts` (new)
- `functions/shared/pipelines/__tests__/reflector-pipeline.test.ts` (new)
- `functions/shared/prompts/reflector-prompt.ts` (new)
- `functions/shared/pipelines/role-policy.ts` (add `REFLECTOR` role)
- `functions/shared/types/agent-orchestrator.ts` (extend `Role` enum)

**Tasks:**

- [ ] Author REFLECTOR prompt template
- [ ] Implement pipeline
- [ ] Inbox frontmatter helper (`last-seen-sha` roll)
- [ ] Forensic step events
- [ ] Smoke: run on a small plan diff → produces ≥ 1 proposal

#### Story 3-E-2-2 — Wave + plan-close triggers + low-priority daemon slot

`pv2-p3-e-2-2-reflector-triggers-and-slot` · **M** · **review** — PR-74, 2026-05-15 (runner shipped; quiet-window scheduler + daemon slot wiring follow-on)

**Acceptance Criteria:**

1. Daemon adds a dedicated "low-priority" slot per PR-74: FIFO with one concurrent REFLECTOR job. Slot occupies one Bedrock concurrent invocation budget at most; independent of `dev` concurrency.
2. Wake conditions: no plans in `developing` for ≥ 10 minutes; OR ≥ 24h since last reflection if any plan activity since then. Implemented as `daemon/lib/reflection-scheduler.mjs` polling every 60s.
3. Triggers fire on: story → `done` under production rigor only (light per-story reflection); wave → complete under all rigors; plan → `delivered` first time; plan → `delivered` after a `fixing` cycle.
4. Quiet-window check: if a new plan starts during a reflection, REFLECTOR is allowed to complete its current iteration (no preemption) but the next reflection waits for the next quiet window.
5. Smoke: complete a plan → REFLECTOR fires within 11 minutes (10 min quiet window + scheduler poll).

**Touch points:**

- `daemon/lib/reflection-scheduler.mjs` (new)
- `daemon/agent-daemon.mjs` (wire scheduler + low-priority slot)
- `daemon/pipelines/wave-completion.mjs` (fire trigger)
- `daemon/pipelines/plan-completion.mjs` (fire trigger)

**Tasks:**

- [ ] Low-priority slot + FIFO queue
- [ ] Scheduler with quiet-window detection
- [ ] Trigger wires at wave + plan complete
- [ ] Hard-floor 24h timer
- [ ] Smoke: full plan → reflection lands

---

### Epic 3-E-3 — Reflection Inbox UI 📥

**Goal:** Operator UI to review, confirm, decline, or defer REFLECTOR
proposals. Reuses attention-dock component family. Closes Phase E item E.3.

**Dependency:** Epic 3-E-2.

#### Story 3-E-3-1 — Inbox UI + diff renderer + actions

`pv2-p3-e-3-1-reflection-inbox-ui` · **L** · **review** — PR-76, 2026-05-15 (DDB + API + UI shipped; unified-diff + global-bell + on-disk REFLECTOR-APPLY follow-on)

**Acceptance Criteria:**

1. `src/components/labs/reflection-inbox/reflection-inbox.tsx` is a panel + list, modeled on `attention-dock.tsx`. Lives at `/labs/reflections` and surfaces in the App detail view under a "Reflections" tab.
2. List items show: target (skill / claude-md / persona / pipeline-config / tool-wrapper), one-line summary, confidence chip, plan provenance, age. Click expands to show full diff (`unified-diff.tsx`) + rationale + evidence.
3. Three actions per item: **Confirm** (applies the diff — `daemon/pipelines/reflector-apply.mjs` lands `Agent: REFLECTOR-APPLY` commit), **Decline** (moves to declined list — REFLECTOR doesn't re-propose), **Defer** (stays in inbox, can revisit). Optimistic UI per attention-dock pattern.
4. Filter chips: `All` / `Skill proposals` / `CLAUDE.md edits` / `Persona` / `Tool wrappers` / `Pipeline tuning` / `Declined`.
5. Counter badge on global-bell (new icon — sparkle) shows open proposal count. Pulses on new arrival.
6. API endpoints: `GET /api/reflections` (list), `POST /api/reflections/:id/confirm` (apply), `POST /api/reflections/:id/decline`, `POST /api/reflections/:id/defer`.
7. Smoke: REFLECTOR proposes → operator confirms → diff lands on `main` with `Agent: REFLECTOR-APPLY` metadata.

**Touch points:**

- `src/components/labs/reflection-inbox/reflection-inbox.tsx` (new)
- `src/components/labs/reflection-inbox/unified-diff.tsx` (new)
- `src/app/labs/reflections/page.tsx` (new)
- `src/hooks/use-reflections.ts` (new)
- `src/components/layout/global-attention-bell.tsx` (extend with second bell icon)
- `functions/api/index.ts` (4 new routes)
- `functions/shared/services/reflections-service.ts` (new)
- `functions/shared/repositories/reflections-repository.ts` (new — DDB-backed)
- `daemon/pipelines/reflector-apply.mjs` (new)

**Tasks:**

- [ ] Repo + service layer
- [ ] API routes
- [ ] Inbox UI + diff renderer
- [ ] Confirm/decline/defer actions
- [ ] REFLECTOR-APPLY commit pipeline
- [ ] Global-bell extension
- [ ] Smoke: end-to-end confirm flow

---

### Epic 3-E-4 — Project CLAUDE.md flow 📓

**Goal:** PM populates initial CLAUDE.md from boilerplate template; DEV
appends architecture decisions on milestones; REFLECTOR proposes pattern

- constraint edits via the Reflection Inbox. Closes Phase E item E.4.

**Dependency:** Epic 3-E-1 + Epic 3-E-3.

#### Story 3-E-4-1 — CLAUDE.md ownership flow

`pv2-p3-e-4-1-claude-md-flow` · **M** · **review** — PR-80, 2026-05-15

**Acceptance Criteria:**

1. PM agent (project init) populates the boilerplate `CLAUDE.md` template (per v2.5 §41.1) with project name, slug, rigor, repo URL, "What this is" section seeded from intent, and "Domain glossary" seeded with operator-named terms.
2. DEV agent prompt extended: on completing a story tagged "milestone" (set by PM at decomposition time), DEV appends an entry to `## Architecture decisions` with date + decision + rationale + agent name. Append-only — no edits.
3. REFLECTOR proposals for CLAUDE.md target the four sections: `Constraints discovered`, `Patterns to use`, `Patterns to avoid`, `Known issues / future enhancements`. Operator approval per v2.5 §41.2 ownership table.
4. Daemon reads `CLAUDE.md` at every agent session start and prepends to the system prompt per v2.5 §41.3. Context pack (Phase 2-A.2) is appended after CLAUDE.md. New session-start log line emits `claudeMdSha` for provenance.
5. CLAUDE.md is committed to the project repo; not in `.claude/` or `/mnt/memory/`. (The memory-store `project-<slug>/CLAUDE.md` is a symlink to the repo file.)
6. Migration to MA: file-backed today, MA Memory Store mechanical port (PR-77).

**Touch points:**

- `daemon/lib/agent-prompt-builder.mjs` (prepend CLAUDE.md to system prompt)
- `functions/shared/prompts/pm-plan-prompt.ts` (extend for init template population)
- `functions/shared/prompts/dev-prompt.ts` (extend for milestone-decision append)
- (out-of-repo) `futurator-repos/template-nextjs/CLAUDE.md` (template per v2.5 §41.1)
- `daemon/lib/memory-store.mjs` (symlink project-<slug>/CLAUDE.md → repo file)

**Tasks:**

- [ ] Author boilerplate template
- [ ] PM init flow
- [ ] DEV milestone-decision flow
- [ ] Agent session prepend
- [ ] Symlink wiring
- [ ] Smoke: new app → CLAUDE.md populated → next agent session loads it

---

### Epic 3-E-5 — Skill promotion path (project → org-wide) ⬆️

**Goal:** REFLECTOR proposal of `target: org-skill, action: promote-from-
project` lands the skill in `futurator-skills` monorepo and removes the
project-local copy. Closes Phase E item E.5.

**Dependency:** Epic 3-E-3 + 3-C.

#### Story 3-E-5-1 — Promotion pipeline

`pv2-p3-e-5-1-skill-promotion` · **M** · **review** — PR-83, 2026-05-15

**Acceptance Criteria:**

1. Promotion proposal format per v2.5 §38.4: `{ target: 'org-skill', action: 'promote-from-project', source_skill, source_project, rationale, confidence }`.
2. On operator Confirm in Reflection Inbox: `daemon/pipelines/skill-promoter.mjs` (a) copies project-local skill folder to `futurator-skills/<skill>/`, (b) opens a PR against `futurator-skills` repo with `Agent: REFLECTOR-APPLY` commit, (c) on PR merge, removes the project-local copy from `<project>/.claude/skills/<skill>/`, (d) updates the project's manifest to reference the org skill instead.
3. PR template in `futurator-skills` repo prompts operator to bump semver + ship CI.
4. Demotion path per v2.5 §44: org skill unused in any new plan for 90 days → REFLECTOR flags `target: org-skill, action: review-for-demotion` proposal.
5. Cross-project propagation hook (3-C.8) fires on PR merge.
6. Smoke: project has a local skill → REFLECTOR proposes promotion → operator confirms → PR opens in `futurator-skills` → on merge, project manifest updates.

**Touch points:**

- `daemon/pipelines/skill-promoter.mjs` (new)
- `daemon/pipelines/skill-demotion-checker.mjs` (new — runs in weekly refresh cron)
- (out-of-repo) `futurator-skills/.github/PULL_REQUEST_TEMPLATE.md` (new)

**Tasks:**

- [ ] Skill-promoter pipeline
- [ ] PR opening logic
- [ ] Post-merge cleanup
- [ ] Demotion checker
- [ ] Smoke flow

---

### Epic 3-E-6 — Triage agent + cross-plan history 🗂️

**Goal:** Triage agent (feeds bugfix plans from feedback) reads
`inbox/triage-history.md` across all projects with project-match weighting.
Closes Phase E item E.6.

**Dependency:** Epic 3-E-1.

#### Story 3-E-6-1 — Triage agent + relevance scoring

`pv2-p3-e-6-1-triage-agent` · **L** · **review** — PR-81, 2026-05-15

**Acceptance Criteria:**

1. `functions/shared/pipelines/triage-pipeline.ts` defines the TRIAGE agent. Model: Sonnet. Read-only tools.
2. Input: feedback item + cross-project triage history. Triage history shape: each entry = `{ planId, issueSummary, resolution, project, productFamily }`.
3. Relevance scoring per v2.5 §43: `relevance_score = base_similarity × project_match_modifier` where modifier = 1.0 (same project), 0.7 (same product family — e.g. Songster + Songster Live), 0.4 (cross-product).
4. Triage prompt instructed to surface top 3 by score with project provenance shown.
5. Operator "this isn't relevant" flag on a case-pair decays the modifier for that pair only (stored in `inbox/triage-decline-history.md`).
6. TRIAGE outputs a proposed bugfix plan (decision card); operator confirms → plan starts.

**Touch points:**

- `functions/shared/pipelines/triage-pipeline.ts` (new)
- `functions/shared/pipelines/__tests__/triage-pipeline.test.ts` (new)
- `functions/shared/prompts/triage-prompt.ts` (new)
- `functions/shared/services/triage-relevance.ts` (new — scoring helper)
- `functions/shared/repositories/triage-history-repository.ts` (new)
- `functions/shared/pipelines/role-policy.ts` (add `TRIAGE` role)

**Tasks:**

- [ ] Triage prompt + pipeline
- [ ] Relevance scoring helper
- [ ] Decline-history persistence
- [ ] Bugfix-plan proposal card
- [ ] Smoke: feedback item → triage proposes bugfix plan with cited prior incidents

---

### Epic 3-E-7 — Tool-wrap-it threshold scoring 🛠️

**Goal:** REFLECTOR proposes wrapping a repeated Bash pattern as an MCP
tool when score exceeds threshold per v2.5 §38.5. Closes Phase E item E.7.

**Dependency:** Epic 3-E-2 + Phase 2-A.10 (`metrics.csv`).

#### Story 3-E-7-1 — Wrap-it score + tool-wrapper proposal

`pv2-p3-e-7-1-wrap-it-threshold` · **S** · backlog

**Acceptance Criteria:**

1. COMPILER aggregates per-command statistics from `metrics.csv` across the plan: `{ command-pattern, reps, avgInputTokens, failureCount }`.
2. Score formula per v2.5 §38.5: `score = reps × avgInputTokens × (1 + failure_rate × 4)`. Threshold: 5000.
3. REFLECTOR reads the aggregate at plan-close; for each command-pattern exceeding threshold, emits a `target: tool-wrapper` proposal with `pattern`, `recurrences`, `failure-rate`, `score`, `proposed-name`, `rationale`.
4. Pattern normalization: replaces variable args with `<placeholder>` to group similar invocations (e.g. `aws ecs describe-services --cluster <c> --services <s>` collapses cluster/service args).
5. Proposed name follows `@futurator/mcp-<domain>/<verb>` convention (e.g. `@futurator/mcp-ecs/describe-deployments`).
6. Operator confirm → opens a `skill-author` sub-plan (3-C.7) for the new MCP wrapper.

**Touch points:**

- `daemon/pipelines/lib/command-pattern-aggregator.mjs` (new)
- `functions/shared/prompts/reflector-prompt.ts` (extend with wrap-it section)
- `daemon/pipelines/compile-pipeline.mjs` (call aggregator at plan-close)

**Tasks:**

- [ ] Pattern normalization
- [ ] Score formula
- [ ] Aggregator at plan-close
- [ ] REFLECTOR prompt extension
- [ ] Smoke: synthetic plan with 50 repeated AWS calls + 25% failure → REFLECTOR proposes wrap

---

### Epic 3-E-8 — Persona evolution + versioning 🎭

**Goal:** BMAD personas versioned in `futurator-personas` repo. REFLECTOR
proposes edits; operator approval required regardless of confidence. Plans
pin a persona version at creation. Closes Phase E item E.8.

**Dependency:** Epic 3-E-2.

#### Story 3-E-8-1 — Persona repo + version pinning

`pv2-p3-e-8-1-persona-evolution` · **M** · **review** — PR-82, 2026-05-15

**Acceptance Criteria:**

1. `futurator-personas` org repo provisioned with seed content: `personas/bedrock.md`, `personas/nimbus.md`, `personas/docker-harbor.md`, `personas/rick.md` (current BMAD personas).
2. Each persona file is semver-tagged independently: `bedrock-v1.0.0`, `nimbus-v1.0.0`, etc.
3. `Plan.personaPinned` field added: `Record<personaName, semver>`. Populated at plan creation from the latest tag per persona; never changes for the plan's lifetime.
4. Daemon loads pinned persona content at agent session start (per Plan.personaPinned[role]). Falls back to latest if pin missing.
5. REFLECTOR proposals targeting `agent-persona` per v2.5 §38.4 surface in Reflection Inbox; **always require operator confirm regardless of confidence** (v2.5 §42).
6. Confirm → daemon opens PR in `futurator-personas` repo. On merge + tag, future plans pin to the new version. **Running plans are unchanged.**

**Touch points:**

- (out-of-repo) `futurator-personas/` (new repo with seed)
- `functions/shared/repositories/plan-repository.ts` (extend with `personaPinned`)
- `functions/shared/types/plan.ts` (extend schema)
- `daemon/lib/persona-loader.mjs` (new)
- `daemon/lib/agent-prompt-builder.mjs` (load pinned persona)
- `daemon/pipelines/persona-applier.mjs` (new — handles approved-persona-edit PRs)

**Tasks:**

- [ ] Create persona repo + seed
- [ ] Plan.personaPinned schema + reducer
- [ ] Persona-loader + prompt-builder
- [ ] REFLECTOR persona-target proposal flow
- [ ] PR + tag flow
- [ ] Smoke: confirm persona edit → new tag → next plan pins it

---

### Epic 3-E-9 — Pre-flight allowlist on REFLECTOR proposals 🛡️

**Goal:** REFLECTOR cannot propose a skill whose `entrypoint` runs commands
outside an allowlist per v2.5 §39.1. Violations get flagged for manual
review. Closes Phase E item E.9.

**Dependency:** Epic 3-E-3.

#### Story 3-E-9-1 — Pre-flight check + manual-review badge

`pv2-p3-e-9-1-preflight-allowlist` · **S** · **review** — PR-78, 2026-05-15

**Acceptance Criteria:**

1. `daemon/lib/reflection-preflight.mjs` exports `checkProposal(proposal): { allowed: boolean, reason?: string }`.
2. For `target: project-skill | org-skill` proposals: parses the proposed skill's `entrypoint` (if any) from `SKILL.md` frontmatter; allowlist = `['npm', 'pnpm', 'uv', 'python', 'node', 'bash <local-script>']`. Commands outside the allowlist (e.g. `curl`, `wget`, `gh release download`) fail the check.
3. Failed pre-flight does NOT block the proposal — proposal still lands in the inbox but with a `flagged-for-manual-review` badge prominently displayed in the UI. Operator can still confirm but the friction is intentional.
4. Pre-flight runs before the proposal hits the inbox; flag stored in `inbox/reflections.md` proposal entry.
5. Reflection Inbox UI renders the flag with red border and "Manual review required: <reason>" sub-line.

**Touch points:**

- `daemon/lib/reflection-preflight.mjs` (new)
- `daemon/lib/__tests__/reflection-preflight.test.mjs` (new)
- `daemon/pipelines/reflector-pipeline.mjs` (wire pre-flight after REFLECTOR output)
- `src/components/labs/reflection-inbox/reflection-inbox.tsx` (render flag)

**Tasks:**

- [ ] Pre-flight helper + allowlist
- [ ] Wire into REFLECTOR pipeline
- [ ] UI flag rendering
- [ ] Smoke: synthetic `entrypoint: curl ...` → proposal flagged

---

### Epic 3-E-10 — REFLECTOR-REVIEWER (defer-after-baseline) 🔬

**Goal:** Second LLM (Haiku, read-only) validates each REFLECTOR proposal
before it hits the inbox. Closes Phase E item E.10. Tagged
**defer-after-baseline** — lands once 3-C/3-E baseline soaks for one cycle.

**Dependency:** Epic 3-E-2 + Epic 3-E-3 + one operating cycle of soak data.

#### Story 3-E-10-1 — REFLECTOR-REVIEWER agent + verdict in inbox

`pv2-p3-e-10-1-reflector-reviewer` · **M** · backlog · `defer-after-baseline`

**Acceptance Criteria:**

1. `functions/shared/pipelines/reflector-reviewer-pipeline.ts` defines REFLECTOR-REVIEWER agent. Model: Haiku (read-only, low-latency).
2. Input: a single proposal from REFLECTOR. Output: `{ verdict: 'pass' | 'reject' | 'flag', reasoning, supplyChainConcerns: string[] }`.
3. Checks: (a) does the skill match its description?, (b) are the commands plausible for the stated purpose?, (c) are there obvious supply-chain red flags (curl-piping-bash, network calls during install, unusual entrypoint patterns)?
4. Production rigor only — for prototype/mvp, REFLECTOR-REVIEWER is skipped to save latency.
5. Verdict ships with the proposal in the Reflection Inbox as a chip ("REVIEWER: pass" / "REVIEWER: flag" / "REVIEWER: reject"). Reject verdict prominently shown but does not auto-decline — operator still confirms.

**Touch points:**

- `functions/shared/pipelines/reflector-reviewer-pipeline.ts` (new)
- `functions/shared/prompts/reflector-reviewer-prompt.ts` (new)
- `functions/shared/pipelines/role-policy.ts` (add `REFLECTOR_REVIEWER` role)
- `daemon/pipelines/reflector-pipeline.mjs` (wire REVIEWER after pre-flight in production)
- `src/components/labs/reflection-inbox/reflection-inbox.tsx` (render verdict chip)

**Tasks:**

- [ ] REFLECTOR-REVIEWER prompt + pipeline
- [ ] Wire into REFLECTOR pipeline (production only)
- [ ] Verdict chip in inbox UI
- [ ] Smoke: synthetic malicious proposal → REVIEWER outputs `flag`

---

## 8. Phase 3-F — Brownfield migration

**Goal.** Bring existing Futurator projects (Songster, goMAD, Mycelium, etc.)
into v2.5. Brownfield audit plan template, `cdk import`, rigor-upgrade
auto-generation, per-project runbook. v2.5 §56 (Phase F, 4 items + 2/project).

**Source.** v2.5 Part III §32 + Part VIII §56.

**Dependency.** Phase 2-D (ARCHITECT + AWS manifest) + 3-C (skill manifest).

**Sequencing within sub-phase.** 3-F-1 (audit plan template) → 3-F-2 (cdk
import) → 3-F-3 (rigor-upgrade auto-generation). 3-F-4 (per-project
runbooks) runs in parallel after F.1–F.3 land; each runbook authored
separately per Futurator project.

### Epic 3-F-1 — Brownfield audit plan template 🏗️

**Goal:** New `Plan.kind: brownfield-audit` with fixed 6-epic template per
v2.5 §32.1. Closes Phase F item F.1.

**Dependency:** Phase 2-A.7 `Plan.kind` enum expansion + Phase 2-D ARCHITECT.

#### Story 3-F-1-1 — Brownfield audit plan kind + epics

`pv2-p3-f-1-1-brownfield-audit-template` · **L** · backlog

**Acceptance Criteria:**

1. `Plan.kind` enum (Phase 2-A.7) extended with `brownfield-audit`.
2. Plan creator at this kind auto-populates 6 epics per v2.5 §32.1: (1) SKILL-SCOUT T3, (2) ARCHITECT T3 for AWS, (3) ARCHITECT T3 for integrations, (4) Generate CDK that imports existing resources via `cdk import` (no recreation), (5) Verify Layer A → Layer B credential chain works for the project, (6) First commit: initial three manifests + CDK + IAM scaffolding.
3. Each epic auto-generates its stories (no PM decomposition) — fixed template per kind.
4. Operator initiates from project detail UI: "Bring this project into v2 management" button (only visible for projects with no manifests).
5. On successful audit, project transitions from "pre-v2" to "v2-managed" state in `projects` table (`projects.managedBy: 'v2'`).
6. Forensic JSON: brownfield-audit-specific step entries for traceability.

**Touch points:**

- `functions/shared/schemas/plan-schema.ts` (extend `Plan.kind`)
- `functions/shared/services/brownfield-audit-template.ts` (new — auto-populates epics)
- `functions/shared/repositories/projects-repository.ts` (add `managedBy` field)
- `src/components/labs/app-detail/brownfield-audit-button.tsx` (new)
- `functions/api/index.ts` (new `POST /api/apps/:slug/brownfield-audit` route)

**Tasks:**

- [ ] Plan.kind extension
- [ ] Epic template generator
- [ ] Project state transition
- [ ] UI button + API route
- [ ] Smoke: trigger brownfield-audit on a project → 6-epic plan created → run to completion

---

### Epic 3-F-2 — `cdk import` for existing resources 📥

**Goal:** ARCHITECT generates CDK code that declares the resource, then runs
`cdk import` to associate the stack with existing AWS state. Closes Phase F
item F.2.

**Dependency:** Epic 3-F-1.

#### Story 3-F-2-1 — `cdk import` orchestration

`pv2-p3-f-2-1-cdk-import-orchestration` · **L** · backlog

**Acceptance Criteria:**

1. ARCHITECT (T3 brownfield) scans the AWS account for resources tagged with the project slug, produces CDK code declaring each resource with `removalPolicy: 'retain'` to be extra-safe.
2. `daemon/pipelines/cdk-import-runner.mjs` runs `cdk import` per resource per stack. Each successful import is one commit (`Agent: ARCHITECT`, scope: `import-<resource-name>`).
3. Resources that CDK cannot import (e.g. state CloudFormation can't represent) emit `brownfield-import-blocked` attention item (high severity). Operator handles manually; project state transition is held until import-blocked items are resolved.
4. `cdk diff` post-import returns empty against the imported stack (verified as part of audit's final epic).
5. Idempotency: re-running `cdk import` for an already-imported resource is a no-op.

**Touch points:**

- `daemon/pipelines/cdk-import-runner.mjs` (new)
- `functions/shared/prompts/architect-prompt.ts` (extend with T3 brownfield-specific instructions)
- `functions/shared/services/aws-resource-scanner.ts` (new — uses AWS SDK to list tagged resources)

**Tasks:**

- [ ] AWS resource scanner
- [ ] ARCHITECT T3 brownfield prompt extension
- [ ] CDK import runner + per-resource commit
- [ ] Import-blocked attention emission
- [ ] Smoke: audit on a synthetic AWS account with a few tagged resources → all imported

---

### Epic 3-F-3 — Rigor-upgrade plan auto-generation ⬆️

**Goal:** Operator clicks "promote to production" → daemon auto-generates
a rigor-upgrade plan per v2.5 §32.3. Closes Phase F item F.3.

**Dependency:** Epic 3-F-1.

#### Story 3-F-3-1 — Rigor-upgrade plan template

`pv2-p3-f-3-1-rigor-upgrade-template` · **M** · backlog

**Acceptance Criteria:**

1. `Plan.kind` (Phase 2-A.7) extended with `rigor-upgrade`.
2. Rigor-upgrade plan auto-populates epics per v2.5 §32.3 + Part VII §50.3:
   - Backfill tests (target ≥ 60% coverage)
   - SKILL-SCOUT brownfield audit (T3)
   - ARCHITECT brownfield audit (T3)
   - Configure dev/staging/production deploy targets
   - Set up cost-envelope thresholds
   - Configure drift detection
   - Configure GitHub Actions OIDC for keyless CI deploys
   - Audit IAM policies for least-privilege violations
     For mvp → production also: migrate from shared to dedicated AWS account (if approved); enable production deploy gate (audit + soak + approval).
3. Plan runs at the **outgoing rigor** (e.g. prototype-promoting-to-production runs at prototype rigor, the last time). On completion, future plans run at production rigor.
4. Project `rigor` field updates atomically on plan-tag commit (`<project>-rigor-upgrade-<semver>`).
5. Decision card at start: operator confirms cost impact (`+€80 staging, +€420/mo production capacity` style breakdown computed from AWS manifest delta).

**Touch points:**

- `functions/shared/schemas/plan-schema.ts` (extend `Plan.kind`)
- `functions/shared/services/rigor-upgrade-template.ts` (new)
- `functions/shared/repositories/projects-repository.ts` (atomic rigor update)
- `src/components/labs/app-detail/promote-rigor-button.tsx` (new)

**Tasks:**

- [ ] Plan.kind extension
- [ ] Rigor-upgrade epic template
- [ ] Cost-delta decision card
- [ ] Atomic project rigor update
- [ ] Smoke: promote synthetic project prototype → production → plan runs → rigor flips

---

### Epic 3-F-4 — Per-project migration runbook 📘

**Goal:** One runbook per existing Futurator project. ~2 dev days each.
Closes Phase F item F.4 (the variable-effort item — `N projects × 2 days`).

**Dependency:** Epic 3-F-1 + 3-F-2 + 3-F-3.

#### Story 3-F-4-1 — Migration runbook authoring

`pv2-p3-f-4-1-migration-runbooks` · **L** · backlog (per project)

**Acceptance Criteria:**

1. One runbook doc per project at `docs/migration-runbooks/<project>.md`.
2. Runbook structure: project profile (existing AWS resources, existing integrations, code skill heuristics), audit-plan invocation order, expected attention items + how to handle them, post-audit verification checklist.
3. Order: `dino-runner-1` first (smoke-test the runbook against the test bed); then high-value projects in order: Songster, goMAD, Mycelium, Atlassinator. Other projects (Applicator, Contento, MBE, IndexForge, Contax, cayambe.de, Sellebra, Dasher) authored as their managed-resource transition becomes valuable.
4. Each runbook is one PR per project; merge requires successful audit run on the project (or a documented blocker if running against the project isn't yet possible).
5. Cross-cutting learnings (recurring blockers, ARCHITECT prompts that need tuning) feed back into 3-F-1/2/3 stories as follow-up PRs.

**Touch points:**

- `docs/migration-runbooks/dino-runner-1.md` (new)
- `docs/migration-runbooks/songster.md` (new)
- (subsequent runbooks added per project — separate story instances)

**Tasks:**

- [ ] Author `dino-runner-1.md` runbook
- [ ] Run audit against `dino-runner-1` — capture results
- [ ] Author `songster.md` runbook
- [ ] (For each remaining project: separate story instance, ~2 dev days each)

---

## 9. Phase 3-S — Speculation + production rigor

**Goal.** Pull `explore/`+EVALUATOR (spec Phase B.10) and production rigor /
24h soak / drift detection (spec Phase D.12 + D.15) into Phase 3 per the
2026-05-14 scoping decision. The roadmap-strip narrative the operator sees
treats these as Phase 3 capabilities; the spec sequences them in Phase B/D
for incremental shippability. This sub-phase reconciles the two views.

**Source.** v2.5 Part III §28 (speculation) + §31 (branch protection) + Part
V §30.2 (drift) + §36 (24h soak).

**Dependency.** Phase 2-B branch namespace + worktree isolation (3-S-1
needs `wip/` and worktree machinery in place to fork `explore/` branches).
Phase 2-D AWS manifest + CDK (3-S-3 drift detection runs `cdk diff`
against running stacks).

**Sequencing within sub-phase.** 3-S-1 (speculation infra) first — biggest
piece. Then 3-S-2 (production deploy gate + soak) and 3-S-3 (drift detection)
in parallel.

### Epic 3-S-1 — Speculation infrastructure + EVALUATOR 🧪

**Goal:** `explore/<plan-id>-<approach>` branches, per-branch worktree +
manifest delta, EVALUATOR agent with winner-rule schema, winner-merge +
loser-archive flow. Closes spec item B.10.

**Dependency:** Phase 2-B branch namespace + worktree isolation.

#### Story 3-S-1-1 — `explore/` branch infrastructure + speculation marker

`pv2-p3-s-1-1-explore-infrastructure` · **L** · backlog

**Acceptance Criteria:**

1. PM speculation marker schema per v2.5 §28.1: `Plan.speculations: [{ id, epicId, kind: 'implementation' | 'skill-set' | 'infra', approaches: [{ id, description }], evaluation: { metrics, winner-rule } }]`. Validated at plan-create time. Production rigor only (PR-81 winner-rule).
2. When pipeline reaches a speculation marker, daemon forks two `explore/<plan-id>-<approach>` branches off current main. Each branch gets its own worktree under `/home/ubuntu/worktrees/<project>/<plan>/explore-<approach>`.
3. Each branch's worktree carries its own `aws.manifest.yaml` / `integrations.manifest.yaml` / `skills.manifest.yaml` delta (per v2.5 §28.3 three flavors).
4. Both branches run the speculation-scoped epic to completion in parallel (existing wave-merge machinery + new per-branch context).
5. Speculation forensic JSON: `step.speculation-fork` + `step.speculation-branch-complete` events emitted per branch.

**Touch points:**

- `functions/shared/schemas/plan-schema.ts` (extend with `speculations`)
- `functions/shared/services/plan-reducer.ts` (handle speculation states)
- `daemon/pipelines/speculation-forker.mjs` (new)
- `daemon/lib/worktree-manager.mjs` (extend for explore worktrees)

**Tasks:**

- [ ] Speculation schema + validation
- [ ] Speculation marker recognition in PM output
- [ ] Branch forker + per-branch worktree
- [ ] Wave merge per branch (parallel)
- [ ] Smoke: synthetic 2-approach speculation → both branches run

#### Story 3-S-1-2 — EVALUATOR agent + winner declaration

`pv2-p3-s-1-2-evaluator-agent` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/pipelines/evaluator-pipeline.ts` defines the EVALUATOR agent. Model: Opus (PR-80). Read-only tools per v2.5 §28.
2. Input: both `explore/` branch tips + winner-rule + measured metrics. Output: `{ winner: 'approach-a' | 'approach-b' | 'tie', rationale, metricEvaluations }`.
3. Tie handling: EVALUATOR emits `attention.speculation-tied` (medium severity); operator picks via decision card.
4. On winner declaration, daemon surfaces a decision card naming the winner with cited metric evaluations. On confirm:
   - Winner merges to main via wave-merge (`Agent: WAVE-MERGE`)
   - Loser branch renames to `archive/<plan-id>-<approach>-rejected`
   - Speculation result stored as commit-metadata artifact (`Speculation-Result: id=<id>, winner=<approach>, metrics={...}, evaluated-by=EVALUATOR@<sha>`)
5. Forensic JSON: `step.evaluator.*` event with winner + reasoning length.

**Touch points:**

- `functions/shared/pipelines/evaluator-pipeline.ts` (new)
- `functions/shared/pipelines/__tests__/evaluator-pipeline.test.ts` (new)
- `functions/shared/prompts/evaluator-prompt.ts` (new)
- `functions/shared/pipelines/role-policy.ts` (add `EVALUATOR` role)
- `daemon/pipelines/speculation-merger.mjs` (new — winner merge + loser archive)

**Tasks:**

- [ ] EVALUATOR prompt
- [ ] Pipeline + winner-rule application
- [ ] Tie handling + attention
- [ ] Decision card flow
- [ ] Winner-merge + loser-archive
- [ ] Smoke: 2 explore branches → EVALUATOR picks → archive + merge

---

### Epic 3-S-2 — Production deploy gate + 24h soak 🚀

**Goal:** Production rigor deploys gated on 24h staging soak +
security-audit + operator approval. Closes spec item D.15.

**Dependency:** Phase 2-D `aws.manifest.yaml` + production stack.

#### Story 3-S-2-1 — 24h soak + deploy gate enforcement

`pv2-p3-s-2-1-production-deploy-gate` · **L** · backlog

**Acceptance Criteria:**

1. Daemon listens on plan-tag creation events (per Phase 2-B.6 plan tag). If `Plan.rigor === 'production'`, starts 24h soak.
2. Soak conditions per v2.5 §36: (a) 5xx rate < 0.5% over 24h on staging, (b) dependency error rate < 1% (per-vendor for declared integrations), (c) smoke-test pass rate = 100% (smoke tests defined in `aws.manifest.yaml` `soak-script` field — required for production rigor; missing emits `production-soak-script-missing` at plan-create time).
3. Soak window measured from plan-tag commit timestamp. Daemon polls CloudWatch metrics every 5 min; on any condition trip, emits `production-soak-failed` (high severity) and pauses the soak clock.
4. Security-audit step: ARCHITECT runs IAM audit + dependency vulnerability scan on the staging tag. Result is `security-audit-clean` or `security-audit-flagged` + list of findings.
5. Operator-approval step: decision card surfaces only after soak passes + audit clean. Confirms triggers CloudFront swap to production origin pointing at the new semver tag's S3 prefix.
6. Failed soak: operator can re-run soak (after applying a fix) or roll back. Roll-back = production stays on previous semver tag; staging tag invalidated.

**Touch points:**

- `daemon/cron/production-soak-poller.mjs` (new — 5-min poll loop)
- `daemon/pipelines/security-auditor.mjs` (new — ARCHITECT-driven)
- `daemon/pipelines/production-promoter.mjs` (new — CloudFront swap)
- `functions/shared/schemas/aws-manifest-schema.ts` (add `soak-script` field, Phase 2-D dependency)
- `functions/shared/services/soak-metrics.ts` (new — CloudWatch queries)

**Tasks:**

- [ ] Soak-script schema field
- [ ] Soak poller + condition checks
- [ ] Security auditor
- [ ] Operator-approval decision card
- [ ] CloudFront swap
- [ ] Smoke: synthetic production plan → soak → swap

---

### Epic 3-S-3 — Drift detection (weekly) 🔍

**Goal:** Weekly cron Lambda runs `cdk diff` against each project's running
stacks. Non-empty diff → `architect-drift` attention item. Cost-overrun T5
piggybacks on the same Lambda. Closes spec item D.12 (drift slice).

**Dependency:** Phase 2-D `aws.manifest.yaml` + CDK derive.

#### Story 3-S-3-1 — Drift + cost-overrun weekly Lambda

`pv2-p3-s-3-1-drift-cost-overrun-cron` · **M** · backlog

**Acceptance Criteria:**

1. Cron Lambda `futurator-architect-drift-scan` runs weekly Monday 07:00 UTC (after federation refresh).
2. For each project with `managedBy === 'v2'` (Phase 3-F.1): run `cdk diff` against each declared environment's running stack. Non-empty diff emits `architect-drift` attention item (medium) with diff body + suggested-action ("Run audit to incorporate manual changes" or "Revert manual changes via re-deploy").
3. Cost-overrun check: read CloudWatch billing alarm + per-resource cost (via Cost Explorer) for each project. If project's MTD cost > 80% of `aws.manifest.yaml` `cost-envelope.<env>.monthly-usd-max`, emit `cost-overrun` attention item (medium severity).
4. Hard-cap-action per v2.5 §25: if `cost-envelope.<env>.hard-cap-action === 'page-operator'` and MTD exceeds 100% of cap → high severity + immediate notification.
5. Per v2.5 §25 `drift-policy: on-drift: file-attention-item` — drift never auto-reverts. Always operator decision.

**Touch points:**

- `sst.config.ts` (provision cron Lambda)
- `functions/cron/architect-drift-scan.ts` (new)
- `functions/shared/services/cost-explorer-client.ts` (new — AWS SDK wrapper)
- `functions/shared/services/cdk-diff-runner.ts` (new — invokes CDK via subprocess in Lambda)

**Tasks:**

- [ ] SST cron provisioning
- [ ] CDK diff runner
- [ ] Cost Explorer client
- [ ] Attention emission per project
- [ ] Smoke: manual AWS console change → next scan detects drift

---

## 10. Cross-cutting concerns

### 10.1 Plan.kind enum extensions

Phase 3 extends the `Plan.kind` enum (last touched by Phase 2-A.7, PR-39)
with three new values:

- `brownfield-audit` (3-F-1)
- `rigor-upgrade` (3-F-3)
- `skill-author` (3-C-7)

Migration: existing rows untouched. New plans of these kinds are
operator-initiated only (no auto-spawn for first deployment); `skill-author`
auto-spawns only after baseline soak.

### 10.2 RolePolicy resolver extensions

Phase 2-A.1 introduced `RolePolicy` keyed on `(boilerplateKind, rigor,
role)`. Phase 3 adds five new roles:

| Role                 | Allowlist                                         | Notes                                                |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `SKILL_SCOUT`        | `Read, Glob, Grep, Bash` + MCP federation wrapper | No `Write`/`Edit`; manifest writes via daemon helper |
| `REFLECTOR`          | `Read, Grep, Glob` + MCP git-readonly wrapper     | Strict propose-only; no `Bash` even via MCP          |
| `REFLECTOR_REVIEWER` | `Read` (single proposal context)                  | Haiku; production rigor only                         |
| `EVALUATOR`          | `Read, Grep, Glob` + MCP git-readonly wrapper     | One-shot; reads branch tips only                     |
| `TRIAGE`             | `Read, Grep, Glob` + MCP triage-history wrapper   | No `Bash`                                            |

### 10.3 Attention category taxonomy extensions

Phase 3 adds these attention categories (extends Phase 2's set):

| Category                         | Severity    | Source                                                 |
| -------------------------------- | ----------- | ------------------------------------------------------ |
| `federation-manifest-invalid`    | high        | 3-C-1                                                  |
| `manifest-skill-drift`           | medium      | 3-C-2                                                  |
| `federation-update-available`    | low         | 3-C-5 (T8)                                             |
| `propagation-candidate`          | low         | 3-C-8                                                  |
| `skill-author-failed`            | high        | 3-C-7                                                  |
| `production-soak-failed`         | high        | 3-S-2                                                  |
| `production-soak-script-missing` | high        | 3-S-2                                                  |
| `architect-drift`                | medium      | 3-S-3                                                  |
| `cost-overrun`                   | medium/high | 3-S-3                                                  |
| `speculation-tied`               | medium      | 3-S-1-2                                                |
| `speculation-rule-malformed`     | high        | 3-S-1-1                                                |
| `brownfield-import-blocked`      | high        | 3-F-2                                                  |
| `tamper-repeat`                  | high        | (Phase 2-A.5, listed here for cross-cutting reference) |

### 10.4 Forensic JSON step categories

Timer Intelligence (Phase 1 Epic 1.8) gains new step categories:

- `skill-scout` (3-C-3)
- `reflector` (3-E-2)
- `triage` (3-E-6)
- `evaluator` (3-S-1)
- `security-audit` (3-S-2)
- `soak-poll` (3-S-2)
- `drift-scan` (3-S-3)

Each new category gets a color/label in the stacked-bar UI (existing
slicer pattern from Phase 1).

### 10.5 Commit metadata extensions

| Line                   | Phase | Emitted by            |
| ---------------------- | ----- | --------------------- |
| `Skills-Used:`         | 3-C-4 | COMPILER (mvp+)       |
| `Skills-Manifest-Sha:` | 3-C-4 | COMPILER (mvp+)       |
| `Skill-Encounter:`     | 3-C-6 | COMPILER (all rigors) |
| `Speculation-Result:`  | 3-S-1 | WAVE-MERGE on winner  |

---

## 11. Sub-phase dependency graph

```
Phase 2-D ARCHITECT + AWS manifest ─┐
                                    │
                                    ├──▶ 3-C-1 federation ──▶ 3-C-2 project manifest ──▶ 3-C-3 SKILL-SCOUT T1/T2/T3
                                    │                                                          │
                                    │                                                          ├──▶ 3-C-4 commit metadata
                                    │                                                          ├──▶ 3-C-5 T4–T8
                                    │                                                          ├──▶ 3-C-6 distillation
                                    │                                                          ├──▶ 3-C-7 skill-creator subplan
                                    │                                                          ├──▶ 3-C-8 cross-project propagation
                                    │                                                          └──▶ 3-C-9 CodeArtifact MCP
                                    │
Phase 2-B branch namespace + worktrees ──▶ 3-S-1 speculation + EVALUATOR
                                    │
                                    └──▶ 3-S-3 drift + cost-overrun cron
                                    │
                                    └──▶ 3-S-2 production deploy gate + 24h soak
                                                          │
                                                          └──▶ ship-gate sub-check #4

3-C-2 + 3-C-3 + Phase 2 substrate ──▶ 3-F-1 brownfield audit template
                                              │
                                              ├──▶ 3-F-2 cdk import
                                              ├──▶ 3-F-3 rigor-upgrade auto-gen
                                              └──▶ 3-F-4 per-project runbooks

Phase 2 substrate ──▶ 3-E-1 memory stores ──▶ 3-E-2 REFLECTOR ──▶ 3-E-3 inbox UI
                                                          │
                                                          ├──▶ 3-E-4 CLAUDE.md flow
                                                          ├──▶ 3-E-5 skill promotion
                                                          ├──▶ 3-E-6 triage
                                                          ├──▶ 3-E-7 wrap-it
                                                          ├──▶ 3-E-8 persona evolution
                                                          ├──▶ 3-E-9 pre-flight
                                                          └──▶ 3-E-10 REFLECTOR-REVIEWER (defer-after-baseline)
```

---

## 12. Open questions

These are decisions deliberately left for in-flight resolution (or for
PR-conversation surfacing) rather than locked in this doc. Listed so a
reader of this doc one quarter from now can recognize the seams.

1. **Federation manifest precedence ties.** Two sources at the same priority
   with overlapping skill names — current spec returns first match (which is
   nondeterministic). Likely resolution: tie-break alphabetically by source
   ID. Pin via test in 3-C-1-2.

2. **REFLECTOR proposal expiry.** Currently proposals stay in the inbox
   until acted on. If REFLECTOR re-proposes the same target weeks later
   with different evidence, do we dedup or stack? Suggested: dedup by
   `(target, action, skill)` key; new evidence supersedes old.

3. **Speculation budget cap.** What if PM emits five speculations in one
   plan? Spec is silent on a cap. Suggested: hard cap at 2 simultaneous
   speculations per plan; PM warned at decomposition time.

4. **24h soak partial credit.** If soak fails at hour 23, must the next
   attempt restart at 0 or can it pick up at 0? Suggested: restart at 0 —
   the failure invalidates the prior window's data.

5. **`futurator-personas` repo bootstrap.** Personas live in the operator's
   home today. Migration: extract on first persona-edit confirmation.
   Authored deferred to 3-E-8 implementation.

6. **Triage history bootstrap.** `inbox/triage-history.md` starts empty for
   each project; cross-project propagation is meaningful only after a few
   plans have run. Suggested: skip relevance scoring for the first 5 plans
   per project; fall back to base similarity.

7. **CodeArtifact cost.** Private CodeArtifact in eu-central-1 has per-GB
   storage + per-request charges. Suggested: monitor in 3-S-3 cost-overrun
   alongside Bedrock; threshold a separate envelope line.

8. **Sub-plan plan-tag namespace.** 3-C-7 emits `<project>-skill-<name>-v
<semver>` tags. Naming collision with future kinds? Suggested:
   `<project>-<kind>-<id>-v<semver>` pattern; refactor at 3-C-7.

---

## 13. Effort estimate

| Sub-phase                      | Items                          | Effort                     |
| ------------------------------ | ------------------------------ | -------------------------- |
| 3-C — Skills                   | 9                              | ~17 dev days               |
| 3-E — Reflection               | 10                             | ~17 dev days               |
| 3-F — Brownfield               | 4 + 2/project                  | ~4 dev days fixed + 2/proj |
| 3-S — Speculation + prod-rigor | 3                              | ~6 dev days                |
| **Total Phase 3**              | **26 items + per-project F.4** | **~44 days fixed**         |

Substrate leverage from Phase 1 + 2 reduces some items below the spec's
estimate (attention-dock reuse, RolePolicy resolver reuse, commit-metadata
helper reuse). Net-new effort closer to ~36 days assuming Phase 2-D ships
clean. Calendar time is longer because solo-developer interleaves with
ongoing project work.

---

## 14. Out-of-scope deferrals

These are items deliberately not in Phase 3. Captured here so a reader of
this doc doesn't waste cycles looking for them.

- **Claude Managed Agents (MA) migration** — opt-in per project, blocked
  on EU residency + 30-day checkpoint TTL. v2.5 §57 (Phase G).
- **Skill-set-as-speculation production-rigor variant** — basic speculation
  lands in 3-S-1; skill-set variant per v2.5 §43 deferred to v2.6.
- **REFLECTOR-REVIEWER full multi-LLM verdict pipeline** — 3-E-10 ships the
  baseline allowlist check; the Haiku second-pass reviewer is itemized but
  tagged `defer-after-baseline`. Lands after one operating cycle of soak
  data.
- **Persona forking** — explicitly forbidden per v2.5 §42. Capability
  variation lives in the skill manifest.
- **MCP transport switch from stdio to HTTP** — deferred until federation
  has > 10 skills.
- **Cross-organization skill federation** — Phase 3 is single-org. Multi-
  org federation (e.g. shared skills with client orgs) is v2.7+ territory.
- **REFLECTOR autoscaling** — single low-priority slot is sufficient for
  the Futurator project count. Multi-slot REFLECTOR is a v2.7+ concern.
- **Soak-script library** — each project authors its own. A standard soak
  library (`futurator-soak-scripts/`) is a follow-on.
- **Brownfield audit for non-AWS infrastructure** — out of scope; v2.5
  assumes AWS. Multi-cloud is v2.7+.

---

## 15. Glossary

| Term                  | Definition                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| SKILL-SCOUT           | Resolver agent for skills. Sonnet (Opus when authoring). Read-only tools.                             |
| REFLECTOR             | Read-mostly, propose-only agent. Wakes on quiet windows. Sonnet.                                      |
| REFLECTOR-REVIEWER    | Haiku second-pass validator for REFLECTOR proposals (production rigor only, deferred-after-baseline). |
| EVALUATOR             | Speculation winner-rule applier. Opus, read-only, one-shot.                                           |
| TRIAGE                | Bugfix-plan proposer with cross-plan relevance scoring. Sonnet.                                       |
| Federation            | `~/.futurator/skill-federation.yaml` — operator-level registry of skill sources.                      |
| Project manifest      | `.claude/skills.manifest.yaml` — per-project skill state, lockfile semantics.                         |
| Reflection Inbox      | UI surface for REFLECTOR proposals. Reuses attention-dock component family.                           |
| Memory stores         | `/mnt/memory/futurator-org/`, `/mnt/memory/project-<slug>/`, `/mnt/memory/inbox/`.                    |
| Speculation           | PM-emitted A/B fork into two `explore/` branches, EVALUATOR picks winner. Production rigor only.      |
| Brownfield audit      | `Plan.kind: brownfield-audit` — 6-epic template bringing a pre-v2 project into v2 management.         |
| Rigor-upgrade plan    | `Plan.kind: rigor-upgrade` — auto-generated multi-epic plan when operator promotes rigor.             |
| 24h soak              | Production deploy gate: 24h staging stability window measured against `aws.manifest.yaml` conditions. |
| Drift detection       | Weekly `cdk diff` against running stacks; non-empty diff → attention item.                            |
| Skill graduation path | Tier 0 (CLAUDE.md inline) → Tier 1 (project skill) → Tier 2 (org-wide skill in `futurator-skills`).   |
| Distillation          | COMPILER detects repeated patterns; under production rigor, auto-spawns skill-creator sub-plan.       |
| Wrap-it threshold     | `score = reps × tokens × (1 + fail × 4) ≥ 5000` → propose MCP tool wrapper.                           |
