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

Each phase ships independently and proves out the next. **Do not skip a phase.** The pause flag (5.6) must exist before any auto-merge.

### Phase 1 — "Agent opens PRs" (~half-day)

- Write-scoped GitHub PAT stored in Secrets Manager
- New tool wired into the agent's `claude -p` env: `gh pr create` invocation with templated body
- API route `POST /api/free-agent/sessions/:id/open-pr` — agent calls it when confident in a fix
- PR body includes: risk classification, gate-pass summary, link back to the chat session for context
- **You manually merge from GitHub mobile.** No auto-merge yet.

Outcome: phone-driven remediation loop is real. Chat → agent drafts + opens PR → review on GitHub mobile → merge → existing CI deploys. No new Lambdas yet. Lowest possible risk.

### Phase 2 — "Pause + kill switch" (~half-day)

- futurator-agent-flags table + read in daemon poll loop
- API route `POST /api/admin/pause` / `POST /api/admin/resume`
- Panel header gets a global "pause agent" toggle (separate from per-turn Stop)
- CLI shortcuts: `npm run agent:pause` / `:resume`

**Build this before Phase 3.** Auto-merge without a kill switch is irresponsible.

### Phase 3 — "Auto-merge green PRs" (~1 day)

- Risk classifier function (3.h above)
- GitHub Actions workflow: if PR author = agent's PAT identity AND label = green AND all checks pass → auto-merge
- Operator gets a push notification "auto-merged + deployed" instead of approval ask
- Existing `sst deploy` runs (it already auto-deploys on main push)

Outcome: green-class fixes happen without operator intervention. The operator goes back to reading status updates rather than approving each one.

### Phase 4 — "DeployerLambda + daemon self-update" (~1 day)

- DeployerLambda built (5.4 above)
- rsync-daemon.sh updated to write `.rollback/<timestamp>/` snapshot
- Daemon code reachable for agent edits (worktree shape needs work — see open question §9.1)

Outcome: the cancel-poller bug we just hit could have been fixed by the agent.

### Phase 5 — "Health-gate + auto-rollback" (~half-day)

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
