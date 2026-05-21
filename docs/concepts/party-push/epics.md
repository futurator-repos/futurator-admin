# Party Push — Epics

**Date:** 2026-05-21 (planner takeover)
**Source design:** `docs/concepts/party-push/plan.md` (§1–§13)
**Owner:** Planner (Claude Opus 4.7), implementing solo
**Tracking:** `docs/concepts/party-push/status.md`
**Stories:** `docs/concepts/party-push/stories/*.md`

---

## Epic numbering rationale

Continuing the project's epic-numbering convention (15-party, 16-recovery, 17-plan-based-labs, 18-free-agent). Party-push spans **Epic 19 (shared substrate)** and **Epic 20 (party-push daemon implementation)**. Epic 21 and Epic 22 are reserved placeholders for the UI half (PR 2 + PR 3) so the implementing pass owns numbered slots for the followup work.

Two epics rather than one because:

1. Epic 19's changes are shared with pipeline-v2 + free-agent; they have to ship green independently of party-push landing. If party-push is rolled back, Epic 19's substrate stays in place serving the existing surfaces.
2. Epic 20 contains the brownfield bare-repo conversion and the new `party-checkpoint` flow — the riskiest individually-revertable changes. Keeping them in their own epic isolates blast radius.

---

## Epic 19: Shared agent substrate (PR 0)

**Slug:** `party-push-substrate`
**Project Level:** 2 (Multi-story, 8 stories, ~16 story points)
**Sibling:** depends only on existing Phase 1 worktree-rollout infrastructure (already shipped 2026-05-21)
**Estimated effort:** ~2 hours of focused work

### Goal

Extract the shared primitives that party-push, pipeline-v2, and free-agent all need into reusable modules. Land them with no behavioral change to existing surfaces (free-agent + pipeline-v2 regression tests must stay green). This epic is a refactor + extension; Epic 20 is the new behavior on top.

### Scope

**In Scope (Epic 19):**

- New canonical deny list at `daemon/lib/git-deny-list.json` (source-of-truth for both party + free-agent hooks; informational for typed callers).
- Extract the cancel-poller pattern from `daemon/pipelines/free-agent-session.mjs` into a reusable module at `daemon/pipelines/lib/cancel-poller.mjs` with §12.1.5 atomic-clear API (always-clear, per Free Explorer §13.2).
- Refactor `free-agent-session.mjs` to call the shared cancel-poller (must keep free-agent's tests green — same semantics).
- Extend `functions/shared/types/party.ts::PartySession` with `worktreePath?`, `partyBranch?`, `cancelRequested?`, `cancelRequestedAt?`, `updatedAt?`.
- Add `setCancelRequested`, `clearCancelFlag`, `setWorktreePath`, `findBySessionIdShort` to `functions/shared/repositories/party-sessions-repository.ts`.
- New `daemon/pipelines/lib/agent-commit-composer.mjs` — single source for system-driven commit messages. Supports both `kind: 'pipeline'` (v2.5 §23 trailers) and `kind: 'party'` (Session-Id / Project / Round / Participants trailers).
- PAT-loader refresh awareness — extend `ctx.loadBrownfieldPat` with a 60s cache TTL and an "on auth-fail force re-read once" retry pattern (mitigates §12.4 risk 27).
- Extend `daemon/lib/worktree-reaper.mjs` with the `_party` namespace walker + no-op classifier (real classifier ships in Epic 20 once `findBySessionIdShort` is wired into the reaper deps).

**Out of Scope (Epic 19):**

- Any new behavior triggered by party-push (Epic 20)
- UI surfaces (Epic 21, Epic 22)
- The brownfield bare-repo conversion (Epic 20)
- CloudWatch metrics emission (deferred per Free Explorer §13.6)

### Acceptance

- All existing tests stay green (`npx vitest run`).
- Typecheck error count ≤ 79 (current baseline as of 2026-05-21).
- `./scripts/rsync-daemon.sh` succeeds, daemon restarts, `Auth probe: OK` in log.
- Free-agent regression: a free-agent session opens, runs a turn, accepts a cancel via the existing Stop button; cancel-flag clears on close (verified via `aws dynamodb get-item` on the session row after a cancelled turn).
- New `agent-commit-composer.mjs` unit tests pass (control-char sanitize, zero-width strip, party + pipeline shapes).

### Stories

| #    | Story                                                          | Estimate |
| ---- | -------------------------------------------------------------- | -------- |
| 19.1 | `git-deny-list.json` — canonical deny list                     | XS       |
| 19.2 | Cancel-poller shared module + atomic-clear API                 | S        |
| 19.3 | Refactor free-agent-session to use shared cancel-poller        | S        |
| 19.4 | PartySession type + repo extensions (cancel + worktree fields) | XS       |
| 19.5 | Agent commit composer module + tests                           | M        |
| 19.6 | PAT-loader refresh awareness                                   | S        |
| 19.7 | Worktree-reaper `_party` namespace walker (no-op classifier)   | S        |
| 19.8 | `findBySessionIdShort` repo method                             | XS       |

---

## Epic 20: Party-push daemon implementation (PR 1)

**Slug:** `party-push-daemon`
**Project Level:** 3 (8+ stories, ~28 story points, includes brownfield migration + new hook surface)
**Sibling:** depends on Epic 19 shipped
**Estimated effort:** ~half a day of focused work + dogfood validation

### Goal

Turn debate mode into a worktree-isolated, branch-isolated git contributor. Every party session runs in its own `/home/ubuntu/worktrees/<app>/_party/<sessionIdShort>/` worktree on `party/<projectId>/<sessionIdShort>` branch. A PreToolUse hook denies all git mutation from the agent; the daemon commits system-side via the new `party-checkpoint.sh` flow consuming `[CHECKPOINT_SUMMARY]:` markers. The plan-delete + App-delete cascades from the Phase 1 worktree rollout extend to handle party residue cleanly. Push to GitHub is **disabled in this epic** (PAT stays `contents:read`) — Epic 21 enables push.

### Scope

**In Scope (Epic 20):**

- `daemon/pipelines/lib/party-marker-extractor.mjs` — pure-function extractor for `[CHECKPOINT_SUMMARY]:` and `[ASK_HUMAN]:` markers, with adversarial-input handling (markers in code fences, leading whitespace, repeated, mixed).
- `daemon/pipelines/lib/party-tool-hook.sh` — PreToolUse hook for party sessions. Tier-1 hard-denies (git mutation, `git -c`, force-push, branch escape, gh mutation, system danger, secret paths). Tier-2 auto-approves read-only commands. Tier-3 default-allow with `party.tool.default-allow` audit event (per Free Explorer §13.1).
- Adversarial test suite for the hook (~50 deny + ~15 allow cases).
- `daemon/pipelines/lib/party-checkpoint.sh` — system-driven git add+commit script. Reads composer-generated commit message from stdin. Push step **disabled** in this epic (echoes "push deferred until Epic 21").
- `daemon/pipelines/party-bootstrap.mjs` — brownfield bare-repo conversion (with §12.1.4 guard refusing conversion if any active work) + per-session party worktree setup.
- `daemon/pipelines/party-turn.mjs` — cwd assertion (defends against reaper mid-flight), cancel-poller wiring, settings.json written to `/tmp/party-settings-<sid>.json` (NOT in the worktree, per §12.1.2), `bypassPermissions` mode swap.
- Orchestrator system-prompt update — teaches `[CHECKPOINT_SUMMARY]:` + `[ASK_HUMAN]:` markers (§12.2.3).
- Worktree-reaper real classifier — wire `findBySessionIdShort` into the daemon's reaper deps so the Epic 19 walker actually evaluates session terminal state.
- `functions/shared/services/plan-folder-service.ts` party-\* cascade helpers (`cleanupPartyBranch`, `archivePartyBranch`, `reapPartyWorktree`, `countResidualPartyCommits`).
- `functions/api/index.ts::DELETE /api/party/sessions/:id` — full cascade (archive → branch drop → worktree reap → residual count → inline-questions cleanup → session row delete).
- `functions/shared/services/app-artifact-service.ts` — party-cleanup step BEFORE folder rm in App-delete cascade.
- `functions/shared/services/pipeline-launcher.ts` — accept optional `sourceCommitSha` to pin a story-pipeline launch to a specific party-branch SHA (§12.4 risk 26).
- Backfill `daemon/pipelines/lib/commit-metadata.ts` (pipeline-v2) to call `composeAgentCommit({kind: 'pipeline', ...})` instead of building trailers inline. Same output, one source of truth.
- New event types emitted: `party.checkpoint.composed`, `party.checkpoint.blocked` (secrets scan hit), `party.checkpoint.failed` (commit failure), `party.tool.default-allow` (hook fall-through audit), `party.agent.question` (ASK_HUMAN extractor).
- **ConcurrencyManager abstraction** (operator decision 2026-05-21, supersedes Free Explorer §13.3 lane-partition recommendation): 2 slots, any class, unified FIFO with interactive-first priority. New `daemon/lib/concurrency-manager.mjs` class with `tryAcquire/release/selectNext/getSnapshot`. Never preempts running jobs — priority only affects queue order. Feature-flagged via `PARTY_PUSH_CONCURRENCY_MANAGER` for rollback. ~80 lines + tests.

**Out of Scope (Epic 20):**

- Actual push to GitHub (Epic 21)
- `/migrate` UI toggle for `contents:write` (Epic 21)
- Checkpoint card UI (Epic 22)
- ASK_HUMAN UI card (Epic 22)
- `GET /api/party/sessions/:id/audit` endpoint (Epic 22)
- "Open PR" button + `POST /api/party/projects/:id/checkpoints/:sha/pr` (Epic 22)
- "Start story-pipeline" wiring (Epic 22)
- "Elicit further" child-branch debates (Epic 23+ / deferred)
- Auto-PR on first checkpoint (deferred per Free Explorer §13.5)
- CloudWatch metrics dashboard (deferred per Free Explorer §13.6)
- "Multi-Agent Operator Workflow" doc (deferred to Epic 23+ / Free Explorer §13.5)

### Acceptance

End-to-end manual scenario:

1. Operator clicks "Start Debate" on snake-4 (bare-repo topology already in place from Phase 1 greenfield).
2. Bootstrap creates `/home/ubuntu/worktrees/snake-4/_party/<sid-short>/` on branch `party/snake-4/<sid-short>` off main. `git worktree list` shows it alongside pipeline-v2 + free-agent worktrees, no contention.
3. Agent runs a turn, emits `[CHECKPOINT_SUMMARY]: <title>` + 3-line summary in the round's final message.
4. Daemon parses the marker, composes the commit via `agent-commit-composer`, runs `party-checkpoint.sh` → local commit lands with full Session-Id/Project/Round trailer; **no push to GitHub** (deferred).
5. Operator opens the round in the UI; sees a placeholder "checkpoint composed locally" event (UI surface ships in Epic 22).
6. Concurrently: operator starts a pipeline-v2 plan on snake-4 — `assertWorktreeClean` succeeds because the party worktree is on a separate path. Plan creates as normal. Both flows run without contention.
7. Operator clicks delete on the party session. API returns structured cascade results: branch archive → branch drop → worktree reap → residual-commit count (0) → session row delete.
8. Adversarial hook test: agent attempts `git commit` directly from Bash → hook denies with `DENIED: git mutation not allowed...`. Audit event `party.tool.default-allow` fires when agent runs an unenumerated command (e.g., `mkdir scratch`).
9. **Brownfield migration test (applicator):** operator runs the new admin endpoint `POST /api/admin/migrate-brownfield/applicator` during a quiet window (no active sessions). Bootstrap converts the existing working tree to bare+worktree topology; legacy SSH path still browsable. Subsequent debate starts work normally.
10. App-delete on a test project cleans up all party sessions + branches + worktrees + DDB rows.

Tests:

- All Epic 19 + Epic 20 unit + adversarial tests pass.
- Typecheck error count ≤ 79.
- Free-agent + pipeline-v2 regression suites stay green.
- `./scripts/rsync-daemon.sh` + `sst deploy --stage production` succeed.

### Stories

| #     | Story                                                                                    | Estimate |
| ----- | ---------------------------------------------------------------------------------------- | -------- |
| 20.1  | Party marker extractor + tests                                                           | S        |
| 20.2  | `party-checkpoint.sh` script (push disabled)                                             | M        |
| 20.3  | `party-tool-hook.sh` + adversarial test suite                                            | L        |
| 20.4  | `POST /api/admin/migrate-brownfield/:projectId` endpoint (operator-triggered conversion) | M        |
| 20.5  | Brownfield bare-repo conversion in party-bootstrap (with guard)                          | M        |
| 20.6  | Per-session party worktree setup (`setupPartyWorktree`)                                  | S        |
| 20.7  | Party-turn rewiring (cwd assertion + cancel-poller + settings.json + bypassPermissions)  | M        |
| 20.8  | Orchestrator system-prompt update (teaches markers)                                      | S        |
| 20.9  | Plan-folder-service party-\* cascade helpers                                             | M        |
| 20.10 | `DELETE /api/party/sessions/:id` cascade                                                 | M        |
| 20.11 | App-delete cascade: party-cleanup step                                                   | S        |
| 20.12 | Pipeline-launcher `sourceCommitSha` parameter                                            | S        |
| 20.13 | Commit-metadata.ts backfill to use `composeAgentCommit`                                  | S        |
| 20.14 | ConcurrencyManager — unified queue with interactive-first priority                       | M        |
| 20.15 | Worktree-reaper real classifier wired into daemon ticker deps                            | S        |
| 20.16 | Integration test sweep + deploy                                                          | M        |

---

## Epic 21: UI — PAT toggle + push enabled (RESERVED, planner-owned, future)

**Status:** RESERVED. Implementation deferred until Epic 19 + Epic 20 ship.

Scope summary (full design in `plan.md` §12.5):

- `/migrate` UI per-project "Push enabled (`contents:write`)" toggle wired through to PAT rotation.
- Daemon's `party-checkpoint.sh` push step enabled (was deferred in Epic 20).
- Branch-protection warning modal (§12.4 risk 28).
- Minimal "Pushed to <branch>" inline event renderer in the round stream (full card UX in Epic 22).
- New event `party.checkpoint.pushed` emitted by `party-checkpoint.sh` post-push.

---

## Epic 22: UI — Checkpoint card + ASK_HUMAN inbox + audit endpoint (RESERVED, planner-owned, future)

**Status:** RESERVED. Implementation deferred until Epic 21 ships.

Scope summary (full design in `plan.md` §12.5 + Free Explorer §13.4):

- `src/components/labs/party/v2/checkpoint-card.tsx` with three actions (Open PR / Continue locally / Start story-pipeline; "Elicit further" deferred).
- Unified inline-questions list with three-tier visual treatment (blocking / clarifying / informational) — Free Explorer §13.4. Source-chip per entry. Tier-1 triggers push notifications.
- `GET /api/party/sessions/:id/audit` endpoint.
- `PartyEvent` discriminated union in `functions/shared/types/party-events.ts` (Free Explorer §9.1 Q4 #7).
- `POST /api/party/projects/:id/checkpoints/:sha/pr` endpoint (gh API call).
- `POST /api/pipelines` extension consuming `sourceBranch` + `sourceCommitSha` from Epic 20.12.

---

## Ship-blocker resolution required before Epic 20 starts

Per `plan.md` §12.3, four operator decisions must land. Status tracked in `status.md`:

| Blocker                                      | Recommended resolution                                                                                                                           | Decided?             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| §12.3.1 — MAX_CONCURRENT policy              | **Unified queue + interactive-first priority** (operator override of Free Explorer §13.3 partition recommendation, 2026-05-21) — see Story 20.14 | RESOLVED 2026-05-21  |
| §12.3.2 — Hook default-allow vs default-deny | Default-allow with audit logging (Free Explorer §13.1)                                                                                           | tracked in status.md |
| §12.3.3 — Brownfield conversion trigger      | Explicit admin action (Free Explorer §13.7)                                                                                                      | tracked in status.md |
| §12.3.4 — Auto-PR vs explicit click          | Explicit click (all 3 reviewers aligned)                                                                                                         | tracked in status.md |

If any blocker is unresolved at Epic 20 start, the implementing agent halts and pings the operator.

---

## Dependencies

```
Phase 1 worktree rollout (shipped 2026-05-21)
   │
   ▼
Epic 19 — Shared substrate (PR 0)
   │
   ▼
Epic 20 — Party-push daemon (PR 1)
   │
   ├──▶ Epic 21 — UI: PAT toggle + push (PR 2)
   │       │
   │       ▼
   │     Epic 22 — UI: Checkpoint card + ASK_HUMAN inbox (PR 3)
   │
   └──▶ Multi-Agent Operator Workflow doc (Free Explorer §13.5, deferred 14d post-Epic-20)
```
