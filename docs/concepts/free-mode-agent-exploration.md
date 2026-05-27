# Free-Mode Agent — Exploration: from "read-only consultant" to "autonomous remediator"

**Status:** Exploration draft — not a spec, not a decision. Source material for a follow-up brainstorm session.
**Authors:** Richie + Claude (conversational session 2026-05-18 → 2026-05-19)
**Scope:** what the Free Agent (Epic 18) does today, and the design ladder for evolving it into a phone-first system that can intervene, fix, deploy, and roll back — safely.
**Out of scope:** implementation; Pipeline v2 redesign; cross-product strategy.

---

## 1. Why this document exists

Today the Free Agent ([docs/epics-free-agent.md](../epics-free-agent.md)) is a sandboxed forensic + drafting tool. It runs Claude Code in an isolated worktree per session, with IAM least-privilege STS credentials and a path-confinement Bash hook. It can read DDB, query plan state, look at code, draft commits — but its writes are trapped on a one-way `assist/<projectId>/<sessionId>` branch that nobody ever merges back automatically.

Operator's vision (verbatim from the conversation):

> "this app at some point should fix things no matter the device (i am mainly creating this app with aws and daemons, so i can work only with my phone, now things when developing needs action, i would need an agent capable to not only answer plans, but interviene and fix things at ec2 level, rollback with github, everything could also be responsible, like creating tests and security checks (high) before deploying (to itself), i know there is danger, but we should able always to rollback. i am not afraid of those irresponsible consequences, because we can design properly like we have been doing already"

Distilled goal: **the operator should be able to direct meaningful remediation work from their phone**, with the agent doing the actual edits, deploys, and (when needed) rollbacks. Safety comes from gates and reversibility, not from blanket sandboxing.

This document captures the design space we explored, the safety primitives required at each level, and an incremental rollout that lets each rung prove out before the next is built.

---

## 2. Glossary

| Term               | Meaning                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free Agent**     | The chat-widget agent on `admin.futurator.ai`. Operator opens it from a project / plan / app / workspace context, types questions, gets answers. Runs as a `claude -p` subprocess on EC2 inside a per-session worktree. See Epic 18.         |
| **Pipeline v2**    | The autonomous plan-execution pipeline that generates code in waves of dev/test/review jobs. Lives in `daemon/pipelines/`. Distinct from the Free Agent. Both share the same daemon process + `MAX_CONCURRENT=2` cap.                        |
| **Worktree**       | A git working tree checked out at a specific path. Free Agent uses `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` on branch `assist/<projectId>/<sessionId>`. Pipeline v2 uses `/home/ubuntu/projects/<projectId>/` on `main`. |
| **Sandbox**        | The composite security boundary: path-confinement Bash hook + IAM least-privilege role + worktree isolation.                                                                                                                                 |
| **Invasion level** | The depth at which the agent can write/affect production. Used in this doc as a synonym for "capability rung."                                                                                                                               |
| **Daemon**         | The Node.js process at `/opt/futurator-daemon/agent-daemon.mjs` that polls the `futurator-agent-jobs` DDB table and spawns `claude -p` subprocesses. The Free Agent is one of its job types.                                                 |
| **DeployerLambda** | A hypothetical Lambda (does not exist yet) that owns daemon self-update — sits outside the daemon's process tree, so the daemon can safely update its own source without the bootstrap problem.                                              |

---

## 3. Today's posture — Rung 0 (read + draft, no merge)

What the Free Agent can do right now (in production):

**Read:**

- Full project source via its worktree
- Git history (`log`, `diff`, `show`, `blame`)
- DDB tables: `futurator-plans`, `futurator-agent-jobs`, `futurator-attention-items`, `futurator-free-agent-sessions`, `futurator-free-agent-conversations`
- S3 prefix: `s3://futurator-ai-website/knowledge-live/<projectId>/`
- Arbitrary `aws` CLI calls within its IAM scope

**Write (sandboxed):**

- Files inside `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/`
- Commits on its own `assist/<projectId>/<sessionId>` branch (with auto-trailer `Agent: FREE-AGENT-<sid>`)
- Run tests / lint / typecheck in the worktree, get real pass/fail signals

**Cannot:**

- Push to GitHub (daemon code never calls `git push`)
- Modify the bare repo's `main` branch
- Touch `/home/ubuntu/projects/<projectId>/` (Pipeline v2's working tree)
- Mutate DDB rows outside its own conversation rows (IAM `LeadingKeys` condition)
- Reach Secrets Manager, IAM, Lambda update functions (explicit `Deny`)
- Restart any service
- Trigger new Pipeline v2 jobs

**The friction:** when the agent identifies a fix, the diff is trapped on a branch nobody merges. The operator has to either ask for the diff as text in chat, apply it manually on the laptop, and push — or SSH in and cherry-pick. Works, but breaks the "from my phone" promise.

---

## 4. The capability ladder — five levels of invasion

The design space is not "sandboxed vs unsandboxed." It's a ladder where each rung unlocks the next only after its safety primitive is in place.

| Rung  | Capability                                      | What gets unlocked                                                              | Required safety primitive                                                                                                                                      |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Read + draft on `assist/` branch                | Forensics, code reading, plan analysis                                          | _Today's state: path confinement + IAM least-priv + assist-only writes_                                                                                        |
| **1** | **Open PRs on GitHub**                          | Operator reviews on GitHub mobile, one-tap merge                                | GitHub PAT scoped to `pull_request:write` only; PR body includes auto-generated risk classification + gate summary                                             |
| **2** | **Auto-merge green PRs** (no operator click)    | Trivial / test-only / docs / low-risk fixes land without operator               | Pre-deploy contract: lint + tsc + test + security scan + diff-blast-radius check, ALL must pass; risk classifier labels the PR; only `green` class auto-merges |
| **3** | **Auto-deploy on merge** + health-gate rollback | Lambda + frontend fixes self-deploy with auto-revert on health signal           | Watcher Lambda monitors error rate / latency / agent-events for N minutes post-deploy; auto-revert via `sst rollback` if breached                              |
| **4** | **Self-modify the daemon**                      | Agent can fix its own runtime (e.g., the snake-4 cancel-poller bug we hit)      | DeployerLambda (outside daemon's process tree) owns the swap; daemon health-check + `/opt/futurator-daemon/.rollback/` snapshot                                |
| **5** | **Trigger remediation from attention items**    | Agent autonomously addresses surfaced incidents without operator opening a chat | Daily spend cap + paused-by-default + every action audited + 2FA escalation for anything `red` class                                                           |

Each row of the safety-primitive column is built once and stays in place. The investment is mostly net-new; what's already there carries up the ladder.

---

## 5. The seven safety primitives

These are the load-bearing pieces. Each is concretely buildable, scoped, and testable.

### 5.1 Pre-deploy contract (Rung 2+)

The agent CANNOT commit (let alone push) unless these gates all pass, in the worktree, before commit:

| Gate              | Command                                                            | Why                                            |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Lint              | `npm run lint`                                                     | Code-style + obvious bugs                      |
| Typecheck         | `npm run typecheck`                                                | Type safety                                    |
| Tests             | `npm run test` (full suite, not just touched-files)                | Behavior preservation                          |
| Secret scan       | `git diff --staged \| gitleaks detect --staging`                   | No accidentally committed credentials          |
| Security lint     | `semgrep --config=auto`                                            | OWASP top-10 patterns, eval, command injection |
| Dependency audit  | `npm audit --audit-level=high`                                     | Block high-severity CVE intros                 |
| Diff-blast radius | custom check (touched files count, total lines, danger-list paths) | Refuses oversized or scary changes             |

The commit message includes a verifiable hash of each gate's output (e.g., `Gates: lint=ok tsc=ok test=251/251 semgrep=ok audit=ok diff=1f/3l`). Audit trail = unfalsifiable.

**Open question:** should the agent be allowed to _write new tests_ as part of the same commit, or must tests pre-exist? Pro: agent can fix coverage gaps. Con: agent could write a tautological test to pass its own gate. Provisional answer: allow only test additions, never modifications to existing test files in the same commit. This is enforceable via diff inspection.

### 5.2 Risk classification per PR (Rung 2+)

Every agent-generated PR gets one of three labels, auto-assigned:

- **green** — touches only test files, OR docs (`*.md`), OR a single function under 50 lines, OR config keys not in the danger-list
- **yellow** — application code, but no danger-list files, no IAM/infra
- **red** — touches `sst.config.ts`, `*.iam.json`, `.github/workflows/*`, daemon entrypoint files, schema migrations, deploy scripts

Rules:

- **green** → auto-merge if all gates pass (Rung 2)
- **yellow** → 1-tap operator approval on phone (Rung 1)
- **red** → 2-tap approval + a written reason captured in the PR body

The danger-list is a JSON file in the repo (`/.agent-policy/danger-paths.json`) so changes to it are themselves classified `red` (meta-rule).

**Open question:** does the operator override get logged? Yes — every approval/rejection writes to `futurator-deploy-log` with the operator's identity + the reason.

### 5.3 Deploy with health-gate (Rung 3)

Triggered on merge-to-main:

```
[Merge to main]
   ↓
[Existing CI: sst deploy]
   ↓
[WatcherLambda fires — new Lambda, ~50 lines]
   ↓
[For 5 minutes:
   - Sample API Lambda error rate (CloudWatch metric)
   - Sample futurator-agent-jobs error rate
   - Sample futurator-free-agent-sessions ERROR-status count]
   ↓
[Healthy?] ── yes → mark deploy as confirmed
   │
   no
   ↓
[Auto-rollback: sst rollback to previous version]
[Notify operator: "deploy reverted, see CloudWatch link"]
```

Thresholds are configurable per metric (e.g., error rate breaches if > 2σ above baseline OR absolute count > 10/min).

**Open question:** how do we baseline? Probably the last 6 hours of pre-deploy metrics. Cold-start would need a "no baseline yet → require operator approval" fallback.

### 5.4 Daemon self-update — the bootstrap-safe pattern (Rung 4)

The daemon cannot update its own source. The bootstrap problem: if the agent breaks the daemon while editing it, the daemon dies → the agent loses its handler → no recovery loop possible.

Pattern: **DeployerLambda** owns the swap. The daemon never touches `/opt/futurator-daemon/`. Flow:

```
[Agent commits daemon fix to main]
   ↓
[GitHub webhook → DeployerLambda]
   ↓
[DeployerLambda:
   - Snapshot current bundle → /opt/futurator-daemon/.rollback/<timestamp>/
   - rsync new bundle → /opt/futurator-daemon/
   - systemctl restart futurator-daemon
   - Wait 60s
   - Check daemon heartbeat in DDB]
   ↓
[Heartbeat fresh?] ── yes → done; emit deploy-log row
   │
   no
   ↓
[DeployerLambda:
   - rsync /opt/futurator-daemon/.rollback/<latest>/ → /opt/futurator-daemon/
   - systemctl restart futurator-daemon
   - Wait 30s
   - Re-check heartbeat
   - If STILL not healthy → page operator via SNS]
```

DeployerLambda is intentionally minimal so it rarely needs updates. It has SSM RunCommand to the EC2 host. Worth ~4h to build.

**Open question:** how does the DeployerLambda authenticate to GitHub? Via the same write-scoped PAT used for PR opening. The Lambda just receives the webhook and pulls.

**Open question:** what if the rollback ALSO fails? The DeployerLambda pages the operator. Manual SSH recovery. Probability is low (rollback is a known-good bundle), but the path must exist.

### 5.5 Audit trail (Rung 1+, mostly extension of existing)

You already have `futurator-agent-events` for in-turn events. Add `futurator-deploy-log` with one row per agent-driven change:

```yaml
deployId: uuid
sessionId: <agent session that produced this>
commitSha: <main branch commit>
gates: { lint: ok, tsc: ok, test: 251/251, semgrep: ok, audit: ok, diff: 1f/3l }
riskClass: green | yellow | red
operatorApprovedBy: <user id or "auto">
operatorApprovedReason: <free text, required for red>
deployedAt: ISO-8601
deployTarget: lambda | frontend | daemon
healthGate: passed | rolled-back | pending
rolledBack: bool
rolledBackAt: ISO-8601 | null
rolledBackReason: <metric breach details>
```

Mobile UI: a timeline view at `/agent-deploys` showing the row stream with deep links to the PR, diff, CloudWatch logs.

### 5.6 The kill switch (Rung 1+ — must exist before any auto-merge)

Three independent layers, all reachable from the phone:

1. **Pause flag** — a row in `futurator-agent-flags` with `paused: true`. The daemon checks this before picking up free-agent + pipeline-v2 jobs. Operator toggles in 1 tap. ~20 lines of daemon code + 1 API route. Affects only NEW work; in-flight turns continue (use the existing Stop button for those).
2. **Revoke deploy capability** — detach the agent's deploy IAM role binding via one SST CLI command behind a button. Agent loses write but keeps read. Reversible.
3. **Nuclear** — stop the EC2 instance from the AWS console. Already wired into the admin top bar.

**Open question:** should the pause flag also be settable from CLI? Yes — `npm run agent:pause` and `npm run agent:resume` for laptop sessions where you don't want to open the UI.

### 5.7 Cost discipline as a hard gate (Rung 3+)

Per-session caps already exist (`$10` default). For autonomous operation, also need:

- **Daily total cap** across all agent sessions for this operator (e.g., $200/day)
- If today's spend > 80% of daily cap → agent refuses new deploys (read-only allowed)
- If > 100% → agent refuses new turns entirely
- Reset at UTC midnight
- Operator can raise the cap from mobile

**Open question:** does the spend cap include Pipeline v2? Probably yes — same daemon, same operator, same wallet. Or split? Worth deciding before implementation.

---

## 6. Inventory — what's in place vs net-new

| Primitive                                     | Status                                          | Effort to ship                            |
| --------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| IAM least-priv per session (Rung 0)           | ✅ FreeAgentSessionRole + session tags          | done                                      |
| Path confinement Bash hook                    | ✅ daemon/pipelines/lib/free-agent-path-hook.sh | done                                      |
| Audit trail for agent turn events             | ✅ futurator-agent-events + GET /audit endpoint | done                                      |
| Per-session budget cap                        | ✅ $10 default + inline editor in panel header  | done                                      |
| Test/lint/typecheck commands                  | ✅ npm scripts exist, agent has tools           | done                                      |
| GitHub PAT (read-only)                        | ⚠️ exists as brownfield-pat (read scopes only)  | needs a separate write-scoped PAT for PRs |
| Risk classifier                               | ❌ net-new                                      | ~3h (TS function + danger-paths.json)     |
| Auto-PR on commit                             | ❌ net-new                                      | ~2h (gh pr create + API route)            |
| Auto-merge if-gates-pass                      | ❌ net-new                                      | ~2h (GitHub Actions workflow)             |
| WatcherLambda for health-gate                 | ❌ net-new                                      | ~3h                                       |
| DeployerLambda for daemon                     | ❌ net-new                                      | ~4h                                       |
| Daemon .rollback/ snapshot in rsync-daemon.sh | ❌ net-new                                      | ~30m                                      |
| Lambda rollback via sst                       | ⚠️ `sst rollback` works manually                | wire it into WatcherLambda                |
| futurator-deploy-log table                    | ❌ net-new                                      | ~1h (DDB + API + UI list view)            |
| Pause-the-agent flag                          | ❌ net-new                                      | ~30m                                      |
| Revoke-deploy button                          | ❌ net-new                                      | ~1h                                       |
| Daily spend cap                               | ❌ net-new                                      | ~1h                                       |
| Mobile push (SNS → APNS/FCM)                  | ❌ net-new                                      | ~half-day if native; ~2h if PWA Push API  |
| Mobile approval sheet UI                      | ❌ net-new                                      | ~half-day                                 |

**Rough total** for full Rungs 1–5: ~3–4 days of focused work. Not a single sprint, but not a quarter either. Phasing matters — see §7.

---

## 7. Phased rollout

> **2026-05-27 RE-SEQUENCED.** The original 5-phase rollout (kept below as historical context in §7.OLD) targeted "Phase 1 ships in half a day" — that was for the v0 scope before the §9.2 resolution added inline merge-approval and before the operator decided to fold all originally-deferred items into the MVP. The binding implementer guide is now the 4-PR sequence in §7.1–§7.4, sized at ~8 days total.
>
> **Why re-sequence:** (a) §9.2 turned "open a PR" into "open a PR + inline approval card + 3 events + 3 endpoints," (b) the §7 binding rule ("pause flag must exist before any auto-merge") moves the kill switch from Phase 2 into PR B, and (c) the operator's confirmed v1 scope includes Rungs 1–5 plus the deferred items (DeployerLambda, auto-merge-green, retry-wave, daily spend enforcement, cycle cap enforcement, attention-items autotrigger). The PR boundaries below preserve the original safety-first property — each PR's smoke gate can be exercised before the next PR's surface lands — while folding everything into one coherent MVP.

### §7.1 PR A — Free-Agent Unification (~½ day)

**Source-of-truth doc:** `docs/concepts/free-agent-unification.md` §3.1–§3.11 (file-level work plan) + §4 (10 acceptance criteria).

**Prerequisites:** party-push Epics 19–22 in production. ✅ MET as of 2026-05-27.

**Scope:**

- Move `/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` → `/home/ubuntu/worktrees/<projectId>/_assist/<sessionIdShort>/`. Same shared root + `_<reserved>` namespace pattern as party's `_party` worktrees.
- Branch shortens: `assist/<projectId>/<fullUuid>` → `assist/<projectId>/<sessionIdShort>` (matches party convention).
- Extend `daemon/lib/worktree-reaper.mjs` with the `_assist` namespace walker. Single reaper now sweeps per-story + coordinator + node-modules-store + party + assist namespaces.
- One-time migration script at daemon startup (`daemon/lib/free-agent-unification-migration.mjs`): `rm -rf /home/ubuntu/free-agent-worktrees/`, mark in-flight free-agent sessions as `EXPIRED` with `errorReason='WORKTREE_UNIFICATION_MIGRATION'`. Sentinel file prevents re-run.
- Delete `daemon/lib/free-agent-gc.mjs` (subsumed by the unified reaper).
- CLAUDE.md "Recent changes" entry.

**Smoke gate (do not start PR B until all green):**

1. `npx vitest run daemon/ functions/` — green (pre-existing baseline failures stay green).
2. `./scripts/rsync-daemon.sh` — daemon restarts cleanly; log shows `[unification-migration] complete: oldRoot=removed, sessionsMarked=N`.
3. `ssh ec2 ls /home/ubuntu/free-agent-worktrees/` returns "No such file or directory".
4. Operator opens a fresh free-agent chat on `snake-4`: spawned with `cwd=/home/ubuntu/worktrees/snake-4/_assist/<sid8>/`; tool calls render normally; `git status` (read-only allowed) shows the new branch.
5. Open a chat on `applicator` (brownfield, already converted to bare topology): same behavior — `_assist` worktree comes off the same bare repo party uses.
6. Reaper hourly sweep includes the new namespace: log line ends with `assist N/M scanned/reaped`.
7. Existing party + pipeline-v2 flows unaffected (operator opens a party debate on applicator → still works).

**Estimated effort:** ~4 hours of focused work.

---

### §7.2 PR B — Rung 1 + Pause/Kill Switch + Spend Instrumentation (~2.5 days)

The phone-first remediation loop, with the safety net that **must** exist before any auto-merge surface lands.

**Prerequisites:** PR A merged. Smoke gate green.

**Scope:**

**a. Bootstrap endpoint** (Gap 1 from the §9.1 RESOLVED block):

- `POST /api/admin/bootstrap-self-edit-repo` — one-time admin action, idempotent. Mirrors Story 20.4's brownfield converter:
  - Bare-clone `https://github.com/futurator-repos/futurator-admin.git` → `/home/ubuntu/repos/futurator-admin.git` (with admin GitHub PAT).
  - `git worktree add /home/ubuntu/projects/futurator-admin main` as the operator's "checkout mirror" (read-only by convention; lets the operator's free-agent sessions diff against `main` without re-cloning).
  - Idempotent: returns `{ converted: false, reason: 'already-bare-topology' }` on re-run.
  - Audit row in CloudWatch.
- ~1 hour. Same SSM-script + preflight pattern as Story 20.4.

**b. Risk classifier (red / yellow / green)** (§9.6 layer 1):

- New module `daemon/pipelines/lib/agent-risk-classifier.mjs` — pure function `classifyDiff(touchedPaths, additions, deletions) → { class, reasons[] }`.
- `red` class: any touched path matches a pattern in `daemon/lib/agent-danger-paths.json`. v1 patterns:
  - `daemon/**`, `functions/cron/**`, `sst.config.ts`, `functions/shared/auth-middleware.ts`, `functions/shared/repositories/**`, `.github/workflows/**`, `daemon/lib/agent-danger-paths.json` itself, `daemon/pipelines/lib/agent-risk-classifier.mjs` itself, `daemon/lib/git-deny-list.json`.
- `yellow` class: more than 50 lines changed across non-test files, OR touched paths in `functions/api/index.ts`, OR new files in `src/components/labs/`.
- `green` class: everything else — typically test-only diffs, docs, copy fixes, single-file UI tweaks.
- Self-referential: the classifier source file is in `agent-danger-paths.json`. Any change to the classifier is `red`.

**c. Spend instrumentation** (§9.5 gap-fix; enforcement deferred to PR C):

- New DDB table `futurator-agent-spend-log` (PAY_PER_REQUEST, 90d TTL): `{ logId (PK), jobId, sessionId, projectId, agentClass, walltimeSec, costUsd, createdAt, GSI1PK=date, GSI1SK=createdAt }`.
- Daemon `runJobAsync`'s finally block writes one row per completed job: `walltimeSec = (now - startedAt)/1000`, `costUsd = walltimeSec × 0.02` (the configurable constant; env var `AGENT_COST_PER_SEC`, default 0.02).
- New repo helper `getDailySpend(date)` queries GSI1 by date.
- Read-only in PR B — UI panel surfaces today's spend in the daemon-status pill. Enforcement (refuse new sessions when cap exceeded) lands in PR C.

**d. Rung 1 surface — agent opens PRs:**

- New API: `POST /api/free-agent/sessions/:id/open-pr` — body: `{ title, body? }`. Server-side flow:
  1. Runs `agent-risk-classifier.mjs` against the session's assist-branch diff vs `main`. Classification result goes into the PR body + the event.
  2. Daemon executes a new `daemon/pipelines/lib/free-agent-commit-push.sh` (mirror of `party-checkpoint.sh` — runs in the `_assist` worktree, secrets scan via `git-deny-list.json`, `git push --set-upstream origin assist/<app>/<sid8>`).
  3. Uses the project's contents:write PAT (same Secrets Manager pattern as party-push Story 21.2). The Free Agent's PAT scope = `contents:write` + `pull_requests:write` on the brownfield repo (or the admin repo when targeting `futurator-admin`).
  4. Opens the PR via the GitHub connector's `createPullRequest()` (already shipped by Story 22.3 — extend to populate the templated body with `riskClass`, `gateResults`, `diffSummary`, chat-session deep link, and `Risk-Class: <class>` label).
  5. Emits `free-agent.merge.requested` event with `{ prNumber, prUrl, riskClass, diffSummary, gateResults }`.
- New API: `POST /api/free-agent/sessions/:id/approve-merge` — server-side merge via `gh api -X PUT /repos/.../pulls/N/merge`. Emits `free-agent.merge.completed`. For `red` class, requires `{ typedConfirmation: <exact PR title> }` in the body (§9.1 non-negotiable rider).
- New API: `POST /api/free-agent/sessions/:id/reject-merge` — closes PR via `gh api -X PATCH /repos/.../pulls/N -f state=closed`. Emits `free-agent.merge.rejected`. Reason gets injected back into the chat as the next user-turn so the agent can revise.

**e. Inline merge-approval card** (the §9.2 UX surface):

- New event types in `functions/shared/types/free-agent-events.ts`: `free-agent.merge.requested`, `free-agent.merge.completed`, `free-agent.merge.rejected`.
- Frontend `src/components/free-agent/merge-approval-card.tsx`:
  - Diff summary (file count + lines added/removed; expandable to show actual diff via `gh api /repos/.../pulls/N/files`).
  - Gate pass/fail chips (lint / typecheck / test / secrets scan).
  - Risk class chip (green/yellow/red).
  - `[Approve]` and `[Reject + Explain]` buttons.
  - For `red` class: replace `[Approve]` with a modal that requires the operator to type the PR title verbatim.
- Renders inline in the free-agent widget's round stream (same pattern as party's CheckpointCard from Story 22.5).

**f. Pause/kill switch** (moved from original Phase 2 — binding rule: must exist before auto-merge):

- New DDB table `futurator-agent-flags`: `{ flagName (PK), value, updatedBy, updatedAt }`. v1 keys: `agent.paused: 'true' | 'false'`.
- Daemon poll-loop checks the flag BEFORE claiming any PENDING job. Cached 5s.
- New API: `POST /api/admin/pause`, `POST /api/admin/resume` (both require admin auth).
- Panel header in the admin UI gets a global `[⏸ Pause agent]` toggle. Visible across all admin routes (lives in the existing daemon-status pill).
- CLI shortcuts: `npm run agent:pause`, `npm run agent:resume`.
- Pause is global across all agent classes (party + free-agent + pipeline-v2). Existing in-flight jobs complete normally; new sessions / new turns are blocked.

**Smoke gate (do not start PR C until all green):**

1. `npx vitest run` — green.
2. Bootstrap endpoint: `curl -X POST /api/admin/bootstrap-self-edit-repo` → returns `{ converted: true, bareRepoPath, worktreePath, headSha }`. Re-run → returns `{ converted: false, reason: 'already-bare-topology' }`.
3. **The "develop a new module" test:** operator opens a chat on `applicator`, asks: _"Add a new file `docs/agents/free-agent-smoke-test.md` with a 5-line summary of this conversation."_ Agent edits, commits to `_assist` branch, operator says _"open the PR"_ → agent calls `/open-pr` → push lands on GitHub at `assist/applicator/<sid8>` → inline card appears in chat with green risk class, all gates passing → operator taps `[Approve]` → server merges to `main` → chat shows "✅ Merged".
4. **Red-class typed confirmation:** operator asks agent to "change `MAX_CONCURRENT` to 3 in `daemon/agent-daemon.mjs`". Classifier marks `red`. Inline card requires typed confirmation. Operator types the PR title verbatim → merge proceeds.
5. **Reject flow:** operator asks for a fix → agent opens PR → operator taps `[Reject + Explain]` → enters "Use Map instead of object for the new cache". The rejection becomes a new user-turn in the chat. Agent re-investigates + opens a new PR.
6. **Pause:** operator taps the panel header `[⏸ Pause agent]` toggle → opens a new chat in the same project → daemon does NOT claim the new turn job → DDB row stays `PENDING`. Operator taps Resume → job claims and runs.
7. Daily spend pill shows today's accumulated wall-clock spend.

**Estimated effort:** ~2.5 days of focused work.

---

### §7.3 PR C — Rung 2 + Rung 3 + Rung 4 (~3.5 days)

Auto-merge green PRs + self-deploy via DeployerLambda + cycle/spend enforcement. The load-bearing PR — the most safety-critical surface in the MVP.

**Prerequisites:** PR B merged. Smoke gate green. Operator has used the inline-approval card on at least 3 sessions to build confidence in classifier verdicts.

**Scope:**

**a. Auto-merge green PRs** (Rung 2):

- New GitHub Actions workflow `.github/workflows/agent-auto-merge.yml`:
  - Triggers on PR `opened` + `labeled` events with author = futurator-agent-bot (the contents:write PAT's identity).
  - Runs gates: lint + typecheck + test + (party-push's existing) secrets scan + the classifier (re-runs from `main` per §9.6 layer 2).
  - If all gates pass AND classifier returns `green` → posts approving review → enables auto-merge.
- The classifier runs from `main` (load-bearing per §9.6 layer 2). The workflow checks out `main` first, runs the classifier on the PR's diff, then merges only on green. A PR can physically not relax its own classification.
- `yellow` and `red` PRs are NEVER auto-merged. The inline-approval card still drives them.
- The inline-approval card becomes informational ("auto-merged + deployed in 2m13s") for green-class PRs — `free-agent.merge.completed` event still fires.

**b. Self-referential danger-list** (§9.6 layer 1, full coverage):

- Extend `daemon/lib/agent-danger-paths.json` to cover `agent-risk-classifier.mjs`, `agent-danger-paths.json` itself, the new `.github/workflows/agent-auto-merge.yml`, `daemon/lib/git-deny-list.json`, `functions/cron/deployer-lambda.ts` (new in this PR), `functions/cron/health-watcher.ts` (new), `sst.config.ts`.
- All listed paths trigger `red` class regardless of diff size. Operator approval (typed-confirmation card) is the only path to merge changes to these files. PR C ships the patterns, but the v1 enforcement is purely classifier-side.

**c. DeployerLambda** (§9.1 RESOLVED + Rung 4):

- New `functions/cron/deployer-lambda.ts` + SST resource. Triggered on `main` push via GitHub webhook (or cron poll every 60s as v1 fallback; webhook is the v2 refinement).
- Flow:
  1. Check `/opt/futurator-daemon/.last-rsync-mtime` via SSM. If rsync ran in the last 10 min (the §9.1 RESOLVED rsync-vs-DeployerLambda contract), back off. Write attention item: "operator-rsync detected at <time>, skipping self-deploy of <commitSha>."
  2. Otherwise: snapshot `/opt/futurator-daemon/` → `/opt/.rollback/<timestamp>/` (full `cp -a`; preserves env, node_modules, OAuth tokens).
  3. SSH (via SSM) into EC2, `cd /home/ubuntu/projects/futurator-admin`, `git pull origin main`, `rsync -a --delete /home/ubuntu/projects/futurator-admin/daemon/ /opt/futurator-daemon/`.
  4. Restart systemd unit: `systemctl restart futurator-daemon`. Wait 60s.
  5. Health-check loop (60s budget, 1 probe/sec): daemon must (a) be active per `systemctl is-active`, (b) write a fresh heartbeat row to DDB, (c) pass Auth probe (existing log line `Auth probe: OK`).
  6. If breached: auto-rollback via `cp -a /opt/.rollback/<timestamp>/ /opt/futurator-daemon/ && systemctl restart futurator-daemon`. Emit `free-agent.deploy.rolled-back` event. Write attention item.
  7. If healthy: emit `free-agent.deploy.completed` event with timing.
- `sst.config.ts` adds the DeployerLambda with `iam:Restart` + `ssm:SendCommand` permissions scoped to the daemon instance.

**d. Daily spend cap enforcement** (PR B's instrumentation now gated):

- New env var `AGENT_DAILY_SPEND_CAP_USD` (default $200/day).
- `POST /api/free-agent/sessions` (session creation) calls `getDailySpend(today)` first. If today's total >= cap → 429 with `{ code: 'DAILY_SPEND_CAP', spentUsd, capUsd }`.
- Existing sessions stay readable (chat history accessible) but cannot start new turns. Operator sees `[⛔ Daily spend cap reached — $200/$200]` in the widget header.
- Operator can override via `POST /api/admin/spend-cap/override-today` (one-day grace).

**e. Cycle cap enforcement** (§9.5 — 3 fix→retry cycles per (plan, wave)):

- New DDB table `futurator-fix-cycles`: `{ planId#waveNumber (PK), attempts, lastAttemptAt, sessionIds[], status: 'open' | 'exhausted' }`.
- When a free-agent session opens a PR targeting a pipeline-v2 wave fix (detected by `merge.requested` event's `metadata.targetWaveFailure`), increment the counter. At 3 attempts, the agent's next `/open-pr` call returns 409 with `{ code: 'CYCLE_CAP_EXHAUSTED', planId, waveNumber, attempts: 3 }` and emits an attention item: "3 fix attempts exhausted on plan X wave Y — manual investigation needed."
- The cap applies ONLY to pipeline-v2 wave fixes. Greenfield/brownfield module-development sessions (the §7.2 smoke-gate flow) are uncapped except by the daily spend cap.

**Smoke gate (do not start PR D until all green):**

1. `npx vitest run` — green.
2. **Auto-merge green:** operator asks for a docs-only fix on `applicator`. Classifier returns `green`. Operator does NOT tap Approve. GitHub Actions runs, marks the PR mergeable, auto-merge fires. Operator gets a push notification "auto-merged + deployed" (PR D wires push; PR C just emits the event to the widget). Chat shows the merge-card in "auto-merged" state.
3. **Self-deploy:** operator asks for a daemon-class change ("update WORKTREE_ROOT comment in `daemon/lib/worktree-paths.mjs`"). Classifier returns `red`. Inline card requires typed confirmation. Operator approves → PR merges to `main` → DeployerLambda triggers via webhook → snapshot taken at `/opt/.rollback/<ts>/` → rsync from worktree → restart → health-check passes → daemon comes back with the new code → emit `deploy.completed`.
4. **Auto-rollback:** intentionally land a syntax error in the daemon (operator-driven test: edit + `rsync` directly). DeployerLambda's NEXT trigger detects the rsync-in-last-10-min, skips. Now intentionally land a syntax error VIA the agent (PR + merge path). DeployerLambda rsyncs → restart fails → health-check fails at 60s → snapshot restored → daemon comes back on the prior commit → attention item written.
5. **Daily spend cap:** set `AGENT_DAILY_SPEND_CAP_USD=0.01` for the test. Try to open a new chat → 429 with `DAILY_SPEND_CAP`. Reset cap → works again.
6. **Cycle cap:** manually create 3 free-agent sessions that target the same pipeline-v2 wave failure. Fourth attempt → 409 with `CYCLE_CAP_EXHAUSTED`. Attention item appears.
7. **Self-referential gate:** operator tries to change `agent-risk-classifier.mjs` itself. Classifier (running from `main`) returns `red`. Card requires typed confirmation. Approved → PR merges; classifier on `main` advances on the next commit.

**Estimated effort:** ~3.5 days of focused work.

---

### §7.4 PR D — Rung 5: Attention-Items Autotrigger + Push Notifications (~1.5 days)

The "agent acts without me opening a chat" surface. The final rung.

**Prerequisites:** PR C merged. Smoke gate green. Operator has watched at least one auto-merge-green PR self-deploy successfully.

**Scope:**

**a. `remediationPolicy` field on attention items** (§9.7 RESOLVED):

- Add `remediationPolicy?: 'manual' | 'auto-draft' | 'auto-fix'` to the attention-items repo type. Default: `manual` (today's behavior for every item-type — no change for items already in the table).
- Configurable per item-type via a new admin UI panel: `Settings → Agent → Remediation Policies` (table of all known item-type values × policy dropdown).
- Initial defaults shipped in PR D: ALL types stay `manual`. Operator graduates types to `auto-draft` (then later `auto-fix`) as confidence builds.

**b. Attention-items poller in the daemon:**

- New ticker in `agent-daemon.mjs`, 30s cadence, gated by the pause flag (PR B's surface).
- Each tick: scan `futurator-attention-items` for `status=open AND remediationPolicy IN ('auto-draft', 'auto-fix') AND agentSessionId is null` (last filter prevents double-spawn).
- For each item: create a free-agent session (`POST /api/free-agent/sessions` server-side, bypassing the operator-auth layer with a special daemon-bot identity). Prime the first user-turn with the attention item's body. Stamp `agentSessionId` on the attention-item row.
- For `auto-draft` policy: agent's flow stops at `merge.requested` (operator approves via inline card or push notification).
- For `auto-fix` policy: if classifier returns `green` AND all gates pass, agent calls `/approve-merge` ITSELF (server-side endpoint, daemon-bot identity). For `yellow` or `red`: same as `auto-draft`.

**c. CloudWatch → attention-items Lambda:**

- New `functions/cron/cw-to-attention.ts` subscribed to a new SNS topic `futurator-cw-alarms`.
- CloudWatch alarms (Lambda errors, API 5xx rate, DDB throttling, daemon heartbeat missing) → SNS → Lambda → write attention item with severity-based `remediationPolicy` mapping.
- `sst.config.ts` provisions the SNS topic + the alarms + the Lambda.

**d. Pipeline-v2 failure → attention item:**

- Already happens today (pipeline-v2's wave-completion-check writes attention items on failure). Just verify the new `agentSessionId` stamping pattern doesn't break it.
- Add `remediationPolicy: 'auto-draft'` as a suggested default for `pipeline-v2-wave-failed` items in the policy panel's seed (operator still has to opt in).

**e. Retry-wave affordance** (§9.2 last-mile):

- After `free-agent.merge.completed` for a PR with `metadata.targetWaveFailure` set, the inline card surfaces a `[Retry wave N]` button.
- Tap → `POST /api/pipelines/:id/waves/:n/retry` (existing endpoint; just wire the UI call). Emits a new pipeline-v2 job. Chat shows "Wave N retry started — job ID …".
- Single-tap only — never auto-retry per the §9.2 RESOLVED reasoning (avoids cascade).

**f. Push notifications:**

- PWA Push API + service worker (NOT APNS — simpler infra, no Apple Developer account required). Lives in `src/sw.ts` + `src/lib/push-subscribe.ts`.
- New DDB table `futurator-push-subscriptions`: `{ subscriptionId, operatorId, endpoint, keys, createdAt }`. One row per device.
- New API: `POST /api/admin/push/subscribe` (registers the subscription), `DELETE /api/admin/push/subscribe/:id`.
- New module `functions/shared/push-sender.ts` — sends a push via the Web Push protocol (VAPID keys in Secrets Manager).
- Wired into 4 event types: `free-agent.merge.requested` (yellow/red only — green auto-merges silently), `free-agent.deploy.rolled-back`, `free-agent.deploy.completed`, `agent.daily-spend.high` (warn at 80%).
- Each notification deep-links to the relevant approval / status screen.

**Smoke gate (PR D acceptance — this is the operator's go-live demo):**

1. `npx vitest run` — green.
2. **PWA push subscription:** operator opens `admin.futurator.ai` on phone (PWA-installed or browser). `Settings → Notifications` toggle ON → granted permission → subscription row in DDB. Test notification button → push arrives on phone.
3. **Auto-draft cold-start:** operator graduates `pipeline-v2-wave-failed` to `auto-draft` via the policy panel. Manually fail a pipeline-v2 wave on a test plan. Within 30s, the daemon's poller spawns a free-agent session, the agent investigates + drafts a fix + opens a PR → operator's phone receives `agent.pr.opened` push → tap → opens widget on the approval card → tap Approve → merge → `[Retry wave N]` button → tap → wave retries → completes.
4. **Auto-fix end-to-end:** operator graduates `low-risk-test-flake` to `auto-fix`. Manually create such an attention item. Agent self-spawns session, classifier marks green, gates pass, agent server-merges itself, DeployerLambda runs (if daemon-class) OR brownfield CI deploys, operator receives `auto-merged + deployed` push notification (informational only — no action needed).
5. **CloudWatch → attention-item:** manually fire a CloudWatch alarm. SNS → Lambda → attention item appears. If its type is graduated to `auto-draft`, agent self-spawns within 30s.

**Estimated effort:** ~1.5 days of focused work.

---

### §7.5 Total + sequencing summary

| PR  | Title                                          | Days | Cumulative |
| --- | ---------------------------------------------- | ---- | ---------- |
| A   | Free-Agent Unification                         | 0.5  | 0.5        |
| B   | Rung 1 + Pause + Spend Instrumentation         | 2.5  | 3.0        |
| C   | Rung 2 + Rung 3 + Rung 4 + Spend/Cycle Enforce | 3.5  | 6.5        |
| D   | Rung 5: Autotrigger + Push                     | 1.5  | 8.0        |

**Hard rules between PRs:**

- PR A → PR B: PR A's 7-step smoke gate must be green before PR B starts. The unification is the substrate; everything downstream assumes the unified path + reaper.
- PR B → PR C: PR B's 7-step smoke gate must be green. The pause kill-switch must exist before auto-merge surfaces in PR C — this is the original §7's binding rule, preserved.
- PR C → PR D: PR C's 7-step smoke gate must be green. The DeployerLambda + auto-rollback must be proven by an intentional-failure rollback test before any cold-start trigger fires.
- Each PR ships its own commit + push + the equivalent of party-push's Story 20.16 deploy gate (rsync + sst deploy + operator-driven smoke). PR D's smoke gate IS the operator's go-live demo for the whole capability ladder.

**What the operator can do at each milestone:**

- After PR A: same Free Agent as today, but worktrees live in the unified namespace. Foundation for everything below.
- After PR B: open a chat from phone, ask for any module/feature work, agent edits + commits + pushes + opens PR, inline card approves, merge lands. **Operator-confirmed test workflow ("develop a new module") works end-to-end as of this milestone.**
- After PR C: green-class PRs land without operator taps. Daemon self-edits via DeployerLambda with auto-rollback. The system can fix itself; operator stays in the loop only on yellow/red.
- After PR D: agent acts on attention items autonomously (with operator-set per-type policy). Phone vibrates when human input is needed. The operator's "from my phone" vision is fully shipped.

---

### §7.OLD Historical context — original 5-phase rollout (superseded 2026-05-27)

The original phasing below is kept for reference. It was sized for the v0 scope (Phase 1 ships in ~half-day with no inline approval card and no auto-merge). The 2026-05-27 operator decision folded all originally-deferred items into the MVP, which is why §7.1–§7.4 above re-sequence the work into 4 PRs sized at ~8 days total. **Do not implement against the §7.OLD plan.**

#### Phase 1 — "Agent opens PRs" (~half-day) [SUPERSEDED]

- Write-scoped GitHub PAT stored in Secrets Manager
- New tool wired into the agent's `claude -p` env: `gh pr create` invocation with templated body
- API route `POST /api/free-agent/sessions/:id/open-pr` — agent calls it when confident in a fix
- PR body includes: risk classification, gate-pass summary, link back to the chat session for context
- **You manually merge from GitHub mobile.** No auto-merge yet.

Outcome: phone-driven remediation loop is real. Chat → agent drafts + opens PR → review on GitHub mobile → merge → existing CI deploys. No new Lambdas yet. Lowest possible risk.

#### Phase 2 — "Pause + kill switch" (~half-day) [SUPERSEDED — folded into PR B]

- futurator-agent-flags table + read in daemon poll loop
- API route `POST /api/admin/pause` / `POST /api/admin/resume`
- Panel header gets a global "pause agent" toggle (separate from per-turn Stop)
- CLI shortcuts: `npm run agent:pause` / `:resume`

**Build this before Phase 3.** Auto-merge without a kill switch is irresponsible.

#### Phase 3 — "Auto-merge green PRs" (~1 day) [SUPERSEDED — folded into PR C]

- Risk classifier function (3.h above)
- GitHub Actions workflow: if PR author = agent's PAT identity AND label = green AND all checks pass → auto-merge
- Operator gets a push notification "auto-merged + deployed" instead of approval ask
- Existing `sst deploy` runs (it already auto-deploys on main push)

Outcome: green-class fixes happen without operator intervention. The operator goes back to reading status updates rather than approving each one.

#### Phase 4 — "DeployerLambda + daemon self-update" (~1 day) [SUPERSEDED — folded into PR C]

- DeployerLambda built (5.4 above)
- rsync-daemon.sh updated to write `.rollback/<timestamp>/` snapshot
- Daemon code reachable for agent edits (worktree shape needs work — see open question §9.1)

Outcome: the cancel-poller bug we just hit could have been fixed by the agent.

#### Phase 5 — "Health-gate + auto-rollback" (~half-day) [SUPERSEDED — folded into PR C]

- WatcherLambda built (5.3 above)
- CloudWatch alarms wired
- futurator-deploy-log timeline UI

Outcome: the system can self-revert if something goes wrong. Operator gets a "deploy reverted" notification, not a "production is down" page.

---

## 8. Mobile-first UX

The whole premise is "from my phone." Concrete UX considerations:

### Push notifications

- SNS topic per operator → APNS (iOS) / FCM (Android) OR PWA Push API + service worker
- Each notification deep-links to the relevant approval / status screen
- Categories:
  - `agent.pr.opened` — yellow / red PRs needing approval
  - `agent.deploy.completed` — informational
  - `agent.deploy.rolled-back` — alert
  - `agent.budget.high` — soft warning at 80% daily cap
  - `agent.kill-switch.triggered` — alert

### Approval sheet

A simple list view at `/agent-approvals` showing pending PRs. Each row:

```
[Tap to expand]
🟢 8:42 AM  agent-fix-snake-4
   Wave 0 broke (TAMPER_DETECTED). Fix: GameHUD.test.tsx
   getByText → getAllByText.  green class · 1 file · 3 lines
   ✅ lint  ✅ tsc  ✅ test  ✅ semgrep  ✅ audit
   [auto-merged + deployed]   [✓ healthy 5/5 min]
```

Expanded: full diff inline (syntax highlighted), gate output, chat-session deep link.

Actions:

- **Approve** — merges + deploys
- **Reject** — closes PR, sends "rejected by operator" event back to chat session
- **Reject + Explain** — same as reject, but the rejection reason becomes a new turn in the chat session so the agent can revise

### Lock-screen widget (stretch)

- "Agent paused" / "Agent active" toggle as iOS widget
- Today's spend
- Last action timestamp

---

## 9. Open questions for the next session

These are the things to figure out before any of the above gets built.

> **Resolution status (2026-05-27 operator brainstorm).** §9.1, §9.2, §9.5, §9.6, §9.7 were resolved in a brainstorm session after party-push (Epics 19–22) landed in production. The `✅ RESOLVED` blocks below are binding for Phase 1. §9.3, §9.4, §9.8, §9.9, §9.10 remain open (deferred to when they become relevant).

### 9.1 Daemon-source worktree shape

Where does the agent edit daemon code? Options:

- **A.** A separate worktree mounted at `/home/ubuntu/daemon-edit-worktrees/<sessionId>/` checking out the futurator-admin repo. Agent edits there. DeployerLambda picks up the merged change from main and rsyncs.
- **B.** Agent edits via API call (no local worktree) — sends a patch to a GitHub API endpoint that creates the PR. No on-EC2 staging. Simpler infra.
- **C.** Same as the project worktree pattern but with `daemon-edit` as the scope kind.

Trade-off: option A lets the agent run the test suite locally first. Option B doesn't but is much simpler. Probably A is right — the gate contract requires `npm run test` to pass before commit.

**✅ RESOLVED (2026-05-27): Option A, refined for the unified worktree architecture.**

- Treat `futurator-admin` itself as a worktree-managed project. Bare-clone it to `/home/ubuntu/repos/futurator-admin.git` on EC2 (does not exist today — the daemon runs from rsync'd `/opt/futurator-daemon/`, not git).
- Agent edits in `/home/ubuntu/worktrees/futurator-admin/_assist/<sid-short>/` — the SAME unified namespace as every other worktree (post-unification PR). No special `daemon-edit-worktrees/` root.
- Agent runs `npm run lint/typecheck/test` in that worktree BEFORE committing. This is the deciding factor over Option B — the pre-deploy gate contract (§5.1) requires gates to run locally, and a blind API patch can't run them.
- Commit → `assist/futurator-admin/<sid-short>` → PR → DeployerLambda handles the self-deploy after merge (rsync + restart + 60s health-check + auto-rollback to `.rollback/` snapshot). DeployerLambda is the Rung 4 net-new piece; everything else reuses unified-worktree + party-push primitives.
- **Non-negotiable rider:** daemon edits are ALWAYS `red` class — never auto-merge, even at Rung 4. The daemon is the system's single point of failure; it gets the strictest gate regardless of diff size. The inline merge-approval card (see §9.2 resolution) requires a typed confirmation for daemon-class changes, not just a tap.

**Implementation gap-fixes added 2026-05-27:**

- **Bootstrap step:** `POST /api/admin/bootstrap-self-edit-repo` (mirrors Story 20.4's brownfield converter). One-time admin action, idempotent: clones `https://github.com/futurator-repos/futurator-admin.git` → `/home/ubuntu/repos/futurator-admin.git`, runs `git worktree add /home/ubuntu/projects/futurator-admin main` as the "operator's checkout" mirror. After this lands, the agent's `_assist` worktrees come from the same bare. ~1h of implementer work — same SSM script + preflight pattern as Story 20.4.
- **Rsync vs DeployerLambda contract:** `./scripts/rsync-daemon.sh` remains the operator's escape hatch and always wins on last-write. DeployerLambda is for agent-driven self-deploy ONLY (post-merge to `main`). The implementer must NOT remove or downgrade rsync — they coexist. DeployerLambda checks `mtime` of the rsync-touched marker file before rsyncing; if rsync ran in the last 10 minutes, DeployerLambda backs off and posts an attention item "operator-rsync detected, skipping self-deploy."

### 9.2 What about Pipeline v2 jobs that the agent might fix?

If a Pipeline v2 wave fails (like snake-4 Wave 0 with TAMPER_DETECTED), should the Free Agent's fix:

- (a) auto-trigger a Pipeline v2 retry, or
- (b) require operator to manually click "retry wave"?

(b) is safer for v1. The agent's fix lands in main, but the operator decides when to retry the wave. Avoids cascade effects.

**✅ RESOLVED (2026-05-27): inline-in-chat merge approval + manual one-tap retry. The whole loop stays in the widget — no GitHub context-switch.**

The operator's refinement is sharper than either original option. The flow:

1. Agent investigates the failed wave (reads attention item + worktree + DDB), drafts a fix in its `_assist` worktree, runs gates locally.
2. Agent opens a PR (Rung 1) and emits a `free-agent.merge.requested` event with `{prNumber, diffSummary, gateResults, riskClass, prUrl}`.
3. The widget renders a **merge-approval card inline in the chat** — diff summary, gate pass/fail, risk class, [Approve] / [Reject] buttons. The operator reviews WITHOUT leaving the widget (no GitHub mobile context-switch).
4. Operator taps **Approve** → `POST /api/free-agent/sessions/:id/approve-merge` merges the PR server-side via the gh API → emits `free-agent.merge.completed`.
5. Widget then shows a "Merged. Retry wave 0?" affordance → operator taps → pipeline retries (manual one-tap, NOT auto — avoids cascade per the original (b) reasoning).

Implications:

- **This collapses Rung 1 (open PR) + the approval UX into one inline flow.** Single surface for ask → investigate → fix → review → approve → merge → retry.
- **v1 does NOT need auto-merge-green (Rung 2).** The inline-approval card IS the merge mechanism; the operator stays in the loop on every merge, just with one tap instead of an app-switch. Rung 2 becomes a future option if the operator later wants to drop the approval step for green-class fixes.
- **`red`-class changes (daemon edits, IAM, infra) require a typed confirmation in the card**, not just a tap (see §9.1 rider).
- **New scope for Phase A (Rung 1):** the inline merge-approval card + `POST /approve-merge` endpoint + the two events. Slightly more than "open PR, merge on GitHub" but the right phone-first UX. Worth it.

### 9.3 Multi-operator collaboration

Today: single operator (you). What about a co-founder / contractor scenario? Per-operator daily cap? Approval routing rules ("anything red goes to Richie, anything green goes to either")? Punt for v1; design assuming single operator.

### 9.4 Audit log retention

The futurator-deploy-log table — does it need 90d TTL like agent-events? Or permanent? Argument for permanent: regulatory / forensic. Argument for TTL: cost + privacy. Probably permanent but archived to S3 Glacier after 1 year.

### 9.5 Agent-on-agent loops

What if the Free Agent's deploy triggers a Pipeline v2 wave, which surfaces another failure, which the Free Agent then fixes? Infinite loop potential. Mitigation: daily spend cap + max-deploys-per-session cap.

**✅ RESOLVED (2026-05-27): both caps, layered — hard cap of 3 fix→retry cycles per (plan, wave) + a daily spend soft cap as the independent backstop.**

- **Hard cap (primary brake):** the agent will propose at most **3 fixes for the same (plan, wave)** before it stops, posts a summary of what it learned across the 3 attempts ("tried X, Y, Z; the pattern suggests the root cause is …"), and pages the operator to look manually. 3 gives a genuinely-fixable issue enough shots without endlessly proposing fixes that don't work.
- **Daily spend soft cap (backstop):** the §5.7 daily budget. Even inside the 3-cycle limit, if today's spend crosses the threshold the agent stops proposing fixes (read-only investigation still allowed). Catches runaway cost from any cause, not just this loop.
- Note: because every merge requires the operator's inline approval (§9.2), the "loop" is never fully unattended — the operator gates each cycle. The cycle cap is really "how many times will the agent propose a fix for the same wave before giving up," which bounds wasted operator-approval-clicks + budget on an unfixable wave.
- The specific daily-$ number is operator-set in the budget config; default suggestion $200/day across all agent classes (free-agent + party + pipeline-v2 share the wallet).

**Implementation gap-fix added 2026-05-27 — how spend is measured:**

For v1, spend = **per-job wall-clock seconds × a constant cost-per-second** (reuses existing `startedAt`/`endedAt` on `futurator-agent-jobs` rows; no new tracking layer). The constant is configurable; suggested default `$0.02/sec` (back-of-envelope from Anthropic API pricing × typical token rate, calibrated against the first week of real spend). True token-level tracking is a deferred Phase 2 refinement: add `inputTokens`/`outputTokens` fields to the job row, compute cost via Anthropic's pricing table, swap the implementation behind the same `getDailySpend(date)` repo function.

### 9.6 Risk classifier — meta-rules

The classifier itself is code. Changes to it should be `red`-class. But the classifier classifies its own changes — chicken/egg. Mitigation: the danger-paths.json hardcodes the classifier source file as `red`, and the file imports a TypeScript module that's also danger-listed. Recursive but terminates.

**✅ RESOLVED (2026-05-27): the standard "a PR can't modify its own gates" CI pattern — three layers. This is a solved problem; adopt it as-is.**

1. **Self-referential danger-list.** `git-deny-list.json` (already shipped by party-push), `agent-risk-classifier.mjs`, the pre-deploy gate-runner, and `.github/workflows/*` are ALL hardcoded `red` class. Any PR touching them requires operator approval via the inline card with typed confirmation.
2. **CI runs the classifier from `main`, not from the PR branch.** The classifier that judges PR #N is the one already merged to `main`, never the (possibly weakened) one inside PR #N. A PR physically cannot relax its own classification. This is the load-bearing layer.
3. **Logged + (future) second-approver.** Classifier/gate changes log the full diff + operator approval reason to the audit trail. When there's ever more than one operator (§9.3, still open), these changes require a different approver than the PR author. For single-operator v1, this collapses to "operator approves, approval is logged with the diff."

### 9.7 Cold-start: how does the agent know what to fix?

Today the operator opens the chat and asks. For Rung 5 (autonomous remediation), the agent needs a trigger. Candidates:

- Attention items table — agent polls and acts on new items
- CloudWatch alarms — SNS → agent webhook → new session created with the alarm as the prompt
- Failed Pipeline v2 waves — same SNS pattern

This is the BIGGEST unknown. The agent autonomously starting new sessions is a different beast than the agent acting in response to a human-started session. Defer Rung 5 design until Rungs 1–4 ship.

**✅ RESOLVED (2026-05-27): attention-items as the SINGLE trigger source. Everything else (CloudWatch alarms, failed Pipeline v2 waves) CREATES attention items rather than being a separate trigger path.**

- One queue (`futurator-attention-items`, already exists), one poller, one place to reason about + audit. Avoids building + maintaining three parallel trigger paths, and avoids three places a runaway loop could start.
- CloudWatch alarms → SNS → a small Lambda that writes an attention item (not a direct agent webhook). Pipeline-v2 failures already create attention items. Both funnel into the same queue.
- **New field on attention items: `remediationPolicy: 'manual' | 'auto-draft' | 'auto-fix'`** with graduated autonomy:
  - `manual` (default — today's behavior): operator handles it; the agent does nothing autonomously.
  - `auto-draft`: agent investigates + drafts a fix PR + surfaces the inline merge-approval card (§9.2), but does NOT merge without the operator's tap.
  - `auto-fix`: agent fixes + auto-merges if green-class + auto-retries within caps (the full Rung 5 hands-off mode; opt-in per item-type, only for the most-proven types).
- **Rollout discipline:** start EVERY item-type at `manual`. Graduate specific low-risk types to `auto-draft` as they prove out. Only the most-trusted, highest-frequency types ever reach `auto-fix`. The operator controls the policy per item-type from the config; nothing is autonomous by default.
- Given the §9.2 resolution (inline approval on every merge), `auto-draft` is effectively the default autonomous mode for v1 — the agent proposes, the operator approves in-chat. `auto-fix` is a later graduation, not a v1 requirement.

### 9.8 Cost of the WatcherLambda

A Lambda running for 5 min every deploy = $0.0003 ish. Negligible. But CloudWatch metric polling at 1 sample/sec for 5 min × N deploys/day could add up. Worth modeling before building.

### 9.9 GitHub PR review storm

If the agent opens many PRs in a short time, GitHub mobile gets noisy. Mitigation:

- Daily PR cap (e.g., 10 PRs/day)
- Batch PRs ("3 related fixes to the snake-4 plan" as one PR with 3 commits)
- Threshold-based: only open a PR if the agent's self-confidence > X

### 9.10 The "agent edits its own gate code" attack

If the agent has write access to its own gate code (the risk classifier, the pre-deploy contract), it could in theory disable its own gates. Mitigation: those files are danger-listed, so any change to them is `red`-class and requires operator approval. Defense in depth: the GitHub Actions workflow re-runs the gates from a known-good source independent of the PR's own changes.

---

## 10. References

- **Epic 18 main spec:** [docs/epics-free-agent.md](../epics-free-agent.md)
- **Story 18.1 — IAM role + worktree:** [docs/stories/18-1-per-session-iam-role-and-worktree.md](../stories/18-1-per-session-iam-role-and-worktree.md)
- **Story 18.2 — Session lifecycle:** [docs/stories/18-2-session-lifecycle.md](../stories/18-2-session-lifecycle.md)
- **Story 18.3 — Audit trail:** [docs/stories/18-3-audit-trail.md](../stories/18-3-audit-trail.md)
- **Story 18.5 — Widget session wire-up:** [docs/stories/18-5-widget-session-wire-up.md](../stories/18-5-widget-session-wire-up.md)
- **AGENT.md generator** (per-session operator-context file): `daemon/pipelines/lib/free-agent-worktree.mjs:writeAgentMd`
- **Bash path-confinement hook:** `daemon/pipelines/lib/free-agent-path-hook.sh`
- **STS role + permissions policy:** `sst.config.ts` (FreeAgentSessionRole)
- **Daemon session handler:** `daemon/pipelines/free-agent-session.mjs`
- **Frontend hook:** `src/hooks/use-free-agent-session.ts`

### Related patterns / prior art

- **GitOps / ArgoCD** — same controller pattern as the DeployerLambda
- **Anthropic Claude Code agent SDK** — `--allowed-tools`, `--permission-mode`, hook system
- **Kubernetes admission controllers** — same idea as the risk classifier
- **Stripe Sigma / Datadog anomaly detection** — what the WatcherLambda is simulating
- **The party-mode debate that designed Epic 18** (2026-05-17) — the original safety-first framing came from that session

### Conversation snippets worth re-reading

- The "I think i was talking to it while the 2 agents where active" exchange (2026-05-18) — explains the `MAX_CONCURRENT=2` queueing model and why a 3rd concurrent claude would OOM the EC2.
- The "snake-4 worktree shows 3 FAILED stories" exchange (2026-05-19) — concrete example of forensic loop working end-to-end through the widget.
- The "what in reality the free agent can do" exchange (2026-05-19) — explicit acknowledgement that today's posture is "read + draft, no merge" and that's deliberate.

---

## 11. What to bring to the next session

If you want to brainstorm this further, the most productive starting points are:

1. **Pick a target rung.** Don't try to design Rung 5 directly. Start with Rung 1 and the smallest viable shape of Phase 1.
2. **Decide §9.1** (daemon-source worktree shape). It cascades into a lot of other decisions.
3. **Sketch the push-notification topology.** APNS native vs PWA Push — different infra commitments.
4. **Decide §9.5** (agent-on-agent loops). Hard cap or soft cap? Per-day or per-session?
5. **Draft the danger-paths.json file.** It's a starting point even without the classifier built.

You can also bring this doc to a fresh Claude session and say "let's expand §9.1" or "let's draft the WatcherLambda spec" — the doc is self-contained enough that a cold session can pick up from any section.

---

_End of exploration document. Re-read date: when next iterating._
