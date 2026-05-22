# Party Push — Status Tracker

**Last updated:** 2026-05-22 (Epic 21 + 22 CODE-COMPLETE in autonomous run)
**Owner:** Planner (Claude Opus 4.7), implementing solo
**Source docs:** `plan.md` (design + reviews) · `epics.md` (epic definitions) · `stories/*.md` (per-story tasks)

---

## Ship-blocker decisions (must resolve before Epic 20 starts)

Per `plan.md` §12.3. Each requires an explicit operator call. Defaults are reviewer recommendations.

| #       | Blocker                            | Recommended                                                          | Operator decision                                                                                                                                                                                                                                                                                              | Date       |
| ------- | ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| §12.3.1 | MAX_CONCURRENT policy              | Option (c) — partition 1 interactive + 1 batch (Free Explorer §13.3) | **OVERRIDE** — unified queue + interactive-first priority + ConcurrencyManager abstraction. Operator quote: "I don't want to separate like 1 batch dev work and 1 for interactive… 2 max agents no matter where they are coming, perhaps we need to abstract one layer of concurrency." Story 20.14 rewritten. | 2026-05-21 |
| §12.3.2 | Hook default-allow vs default-deny | Default-allow with audit logging (Free Explorer §13.1)               | **ACCEPTED**                                                                                                                                                                                                                                                                                                   | 2026-05-21 |
| §12.3.3 | Brownfield conversion trigger      | Explicit admin action (Free Explorer §13.7)                          | **ACCEPTED**                                                                                                                                                                                                                                                                                                   | 2026-05-21 |
| §12.3.4 | Auto-PR vs explicit click          | Explicit click (all 3 reviewers aligned)                             | **ACCEPTED**                                                                                                                                                                                                                                                                                                   | 2026-05-21 |

**Status:** All four ship-blockers resolved. Epic 19 + Epic 20 can proceed.

---

## Epic status

| Epic | Slug                          | Status                                                                                | Stories         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19   | party-push-substrate          | **DONE** (2026-05-21 — Epic 19 complete, all 8 stories landed)                        | 8 (19.1–19.8)   | PR 0 substrate shipped. Free-agent + pipeline-v2 regressions stay green (1380/1384 daemon tests; 4 unrelated pre-existing failures in `epic-dev-pipeline.test.mjs`). Typecheck baseline 79 maintained. Deferred items: Story 19.3 AC 7 manual smoke (post-rsync), Story 19.6 AC 3+4 push-callsite wire-up (rolls into Story 20.2's JS push-wrapper), Story 19.6 AC 6 PAT-rotation smoke (post-PR-0 operator action). |
| 20   | party-push-daemon             | **CODE-COMPLETE** (2026-05-21, 15/16 stories merged; 20.16 deploy is operator-driven) | 16 (20.1–20.16) | All 15 implementable stories landed; Story 20.16 (integration sweep + rsync + sst deploy + manual smoke on `applicator`) requires operator action. Several stories carry deferred sub-tasks marked PARTIAL/Tasks-N (manual smokes, UI deep-links to Epic 22). Ship gate before flipping `PARTY_PUSH_V1_ENABLED=1`: run the integration sweep + smoke on applicator.                                                  |
| 21   | party-push-ui-pat-toggle      | **CODE-COMPLETE** (2026-05-22, 5/5 stories)                                           | 5 (21.1–21.5)   | UI half PR 2: pushEnabled type + repo helper + PATCH gate + Migrate UI modal + party-checkpoint.sh push (gated on env + per-project flag) + checkpoint event types + inline renderer wiring. Typecheck baseline 79 maintained; 12 party-checkpoint.sh tests + 6 party-turn-checkpoint integration tests green.                                                                                                       |
| 22   | party-push-ui-checkpoint-card | **CODE-COMPLETE** (2026-05-22, 7/7 stories)                                           | 7 (22.1–22.7)   | UI half PR 3: PartyEvent typed union + audit endpoint + Open-PR endpoint + epic-start sourceCommitSha plumb-through + checkpoint card + ASK_HUMAN card + audit drawer. 9 party-events parser tests + 4 turn-adapter tests green. UI is browser-untested locally (no dev session this run).                                                                                                                           |

Status legend: TODO / IN_PROGRESS / REVIEW / DONE / TODO / RESERVED.

---

## Epic 19 stories

| #    | Story                                              | Status                                                            | File                                                     |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| 19.1 | Canonical git deny list                            | **DONE** (2026-05-21)                                             | `stories/19-1-git-deny-list.md`                          |
| 19.2 | Shared cancel-poller module                        | **DONE** (2026-05-21)                                             | `stories/19-2-cancel-poller-shared-module.md`            |
| 19.3 | Refactor free-agent-session to use cancel-poller   | **DONE** (2026-05-21, AC 7 manual smoke deferred)                 | `stories/19-3-refactor-free-agent-session.md`            |
| 19.4 | PartySession type + repo extensions                | **DONE** (2026-05-21)                                             | `stories/19-4-party-session-type-and-repo-extensions.md` |
| 19.5 | Agent commit composer                              | **DONE** (2026-05-21)                                             | `stories/19-5-agent-commit-composer.md`                  |
| 19.6 | PAT-loader refresh awareness                       | **DONE** (2026-05-21, AC 3+4 deferred to Story 20.2 push-wrapper) | `stories/19-6-pat-loader-refresh-aware.md`               |
| 19.7 | Worktree-reaper `_party` walker (no-op classifier) | **DONE** (2026-05-21)                                             | `stories/19-7-worktree-reaper-party-namespace.md`        |
| 19.8 | `findBySessionIdShort` repo method                 | **DONE** (2026-05-21)                                             | `stories/19-8-find-by-session-id-short.md`               |

## Epic 20 stories

| #     | Story                                                           | Status                                                            | File                                                    |
| ----- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| 20.1  | Party marker extractor                                          | **DONE** (2026-05-21)                                             | `stories/20-1-party-marker-extractor.md`                |
| 20.2  | `party-checkpoint.sh` (push disabled)                           | **DONE** (2026-05-21)                                             | `stories/20-2-party-checkpoint-script.md`               |
| 20.3  | `party-tool-hook.sh` + adversarial tests                        | **DONE** (2026-05-21)                                             | `stories/20-3-party-tool-hook-and-adversarial-tests.md` |
| 20.4  | `POST /api/admin/migrate-brownfield/:projectId`                 | **DONE** (2026-05-21, UI button + manual smoke deferred)          | `stories/20-4-admin-migrate-brownfield-endpoint.md`     |
| 20.5  | Bootstrap rejects non-bare topology                             | **DONE** (2026-05-21, UI deep-link deferred to Epic 22)           | `stories/20-5-bootstrap-rejects-non-bare-topology.md`   |
| 20.6  | Per-session party worktree setup                                | **DONE** (2026-05-21)                                             | `stories/20-6-setup-party-worktree.md`                  |
| 20.7  | Party-turn rewiring                                             | **DONE** (2026-05-21, feature-flagged `PARTY_PUSH_V1_ENABLED`)    | `stories/20-7-party-turn-rewiring.md`                   |
| 20.8  | Orchestrator system-prompt update                               | **DONE** (2026-05-21)                                             | `stories/20-8-orchestrator-system-prompt.md`            |
| 20.9  | Plan-folder-service party helpers                               | **DONE** (2026-05-21)                                             | `stories/20-9-plan-folder-service-party-helpers.md`     |
| 20.10 | `DELETE /api/party/sessions/:id` cascade                        | **DONE** (2026-05-21)                                             | `stories/20-10-delete-party-session-route.md`           |
| 20.11 | App-delete party-cleanup step                                   | **DONE** (2026-05-21)                                             | `stories/20-11-app-delete-party-cleanup.md`             |
| 20.12 | Pipeline-launcher `sourceCommitSha`                             | **DONE** (2026-05-21)                                             | `stories/20-12-pipeline-launcher-source-commit-sha.md`  |
| 20.13 | `commit-metadata.ts` uses composer                              | **DONE** (2026-05-21)                                             | `stories/20-13-commit-metadata-uses-composer.md`        |
| 20.14 | ConcurrencyManager — unified queue + interactive-first priority | **PARTIAL** (2026-05-21 — module + tests; daemon wiring in 20.16) | `stories/20-14-concurrency-manager.md`                  |
| 20.15 | Worktree-reaper real classifier                                 | **DONE** (2026-05-21, manual reaper smoke deferred to 20.16)      | `stories/20-15-worktree-reaper-real-classifier.md`      |
| 20.16 | Integration test sweep + deploy                                 | TODO                                                              | `stories/20-16-integration-deploy.md`                   |

## Epic 21 stories

| #    | Story                                             | Status                | File                                                  |
| ---- | ------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| 21.1 | PartyProject.pushEnabled type + repo plumbing     | **DONE** (2026-05-22) | `stories/21-1-party-project-push-enabled-type.md`     |
| 21.2 | PATCH /api/migrations/:id pushEnabled toggle      | **DONE** (2026-05-22) | `stories/21-2-patch-migrations-push-enabled.md`       |
| 21.3 | Migrate UI "Push enabled" toggle + modal          | **DONE** (2026-05-22) | `stories/21-3-migrate-ui-push-toggle.md`              |
| 21.4 | Enable party-checkpoint.sh push step (gated)      | **DONE** (2026-05-22) | `stories/21-4-enable-party-checkpoint-push.md`        |
| 21.5 | party.checkpoint.\* event types + inline renderer | **DONE** (2026-05-22) | `stories/21-5-checkpoint-event-types-and-renderer.md` |

## Epic 22 stories

| #    | Story                                            | Status                | File                                              |
| ---- | ------------------------------------------------ | --------------------- | ------------------------------------------------- |
| 22.1 | PartyEvent discriminated union                   | **DONE** (2026-05-22) | `stories/22-1-party-event-discriminated-union.md` |
| 22.2 | GET /api/party/sessions/:id/audit endpoint       | **DONE** (2026-05-22) | `stories/22-2-audit-endpoint.md`                  |
| 22.3 | POST /api/party/sessions/:id/checkpoints/:sha/pr | **DONE** (2026-05-22) | `stories/22-3-open-pr-endpoint.md`                |
| 22.4 | epic-workflows /start sourceCommitSha extension  | **DONE** (2026-05-22) | `stories/22-4-pipelines-source-extension.md`      |
| 22.5 | checkpoint-card.tsx React component              | **DONE** (2026-05-22) | `stories/22-5-checkpoint-card-component.md`       |
| 22.6 | ASK_HUMAN card in right rail                     | **DONE** (2026-05-22) | `stories/22-6-ask-human-card.md`                  |
| 22.7 | Audit drawer UI in party session                 | **DONE** (2026-05-22) | `stories/22-7-audit-drawer.md`                    |

---

## Operator action checklist

Items the operator needs to act on, ordered by urgency.

- [x] **Resolve ship-blockers §12.3.1–§12.3.4** — done 2026-05-21. §12.3.2/3/4 accepted; §12.3.1 overridden in favor of ConcurrencyManager abstraction.
- [ ] **Schedule 2GB swap on the EC2 host** (Free Explorer §13.3 follow-up; cheap, defense-in-depth, not a PR 1 prereq).
- [ ] **PAT-rotation smoke test** (Story 19.6 AC 6): after PR 0 ships, rotate the applicator brownfield PAT in `/migrate` and verify pipeline-v2 picks up the new PAT without daemon restart.
- [ ] **Pick a quiet window for brownfield conversion** (Story 20.4 manual test on applicator). The endpoint refuses conversion while any pipeline-v2 plan / free-agent session / party session is active on the project.
- [ ] **Decide whether to gate Epic 20 behind `PARTY_PUSH_V1_ENABLED` env flag** (Story 20.7 + 20.16). Recommended: yes — gives a clean rollback during the first 1-2 weeks of operation.

---

## Operator decisions log

| Date       | Decision                                                             | Reasoning                                                                                                                                                                                                                                                                                                                              |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-21 | §12.3.2 hook default-allow with audit logging — ACCEPTED             | Free Explorer §13.1's argument: free-agent's hook is already default-allow; consistency + lower maintenance + IAM is the load-bearing layer.                                                                                                                                                                                           |
| 2026-05-21 | §12.3.3 brownfield conversion via explicit admin endpoint — ACCEPTED | Free Explorer §13.7: don't couple a one-time migration to a frequent action. New endpoint at `POST /api/admin/migrate-brownfield/:projectId`.                                                                                                                                                                                          |
| 2026-05-21 | §12.3.4 explicit "Open PR" click — ACCEPTED                          | All 3 reviewers aligned. Auto-PR creates phone-notification load + many checkpoints aren't PR-ready.                                                                                                                                                                                                                                   |
| 2026-05-21 | §12.3.1 — OVERRIDE of reviewer recommendation                        | Operator: "2 max agents no matter where they're coming, perhaps we need to abstract one layer of concurrency." Story 20.14 rewritten: unified queue, interactive-first priority, new ConcurrencyManager class as the abstraction. Reviewer recommendation (lane partition) rejected because it wastes capacity when one class is idle. |

---

## Open questions for the operator

These aren't blockers, but the implementing agent will want answers eventually:

1. **First brownfield project to convert** — `applicator` is the operational-priority candidate (most-used brownfield). Schedule the conversion after PR 0 lands but before Epic 20's full integration test (Story 20.16). One run, ~30 seconds.
2. **Test brownfield project** — is there a non-production brownfield repo we can use for E2E without impacting daily work? If not, propose creating one (`futurator-repos/test-brownfield-party`).
3. **PR-style or commit-by-commit landing for PR 0** — the planner's strong recommendation is one PR per epic, but stories within an epic can land as separate commits with clear messages.

---

## Cross-doc references

- **Design + reviews**: `plan.md` (this folder)
- **Epic definitions**: `epics.md` (this folder)
- **Per-story tasks**: `stories/*.md` (this folder)
- **Phase 1 worktree infra (shipped 2026-05-21)**: `docs/concepts/pipeline-v2/worktree-rollout-plan.md`, `docs/concepts/pipeline-v2/worktree-rollout-design.md`
- **Architecture**: `docs/concepts/pipeline-v2/architecture.md` §10 (worktree drift), §5.3 (job-baked pipelines), §11 (v3 entry points)
- **CLAUDE.md amendment lands in Story 20.3** (hook default-allow posture per Free Explorer §13.1)
- **Multi-Agent Operator Workflow doc** — deferred (Free Explorer §13.5 / Worktree agent §10) — drafted 14 days post-Epic-20 OR upon first operator-reported friction

---

## Notes for future-Claude picking this up cold

If you're reading this in a fresh session:

1. Start with `plan.md` end to end — §1 (locked decisions) + §10 (worktree adoption argument) + §11 (code patches) + §12 (planner corrections) + §13 (Free Explorer final). About 30 minutes of reading.
2. Then `epics.md` for the implementation framing.
3. Then this file (`status.md`) to see what's blocked / pending / done.
4. Then dive into the next TODO story.

The plan is shipped-ready — implementation is mechanical execution of the 24 stories.
