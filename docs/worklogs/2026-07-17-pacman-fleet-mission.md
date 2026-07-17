# Worklog — Pacman 3-Plan Fleet Mission (2026-07-17)

Operator directive (verbatim intent): run 3 Pacman plans **sequentially** through pipeline v3,
dispatched across the **GCP fleet box (cap 2)** and the **local Mac (cap 2)**; dispatcher must
**prioritise local over cloud**; the Queue UI and all related views must **record which machine
ran each job**; local connectivity should be a **simple local runner** (no more daemon pain, and
generic enough that any other local machine can connect); I may **fix plan-generation logic**;
**QA review stage is bypassed** — I verify each finished plan myself by playing the game in the
browser, fix what's broken, then launch the next plan. Ultracode allowed, **agent cap 10**,
model tiering: sonnet-5 normal / opus-4.8 difficult / fable-5 heavy redesign. Worklog (this file)
must audit thoughts + changes each loop iteration.

## Phase index

- [ ] P0 Recon — map dispatcher/policy, queue UI, pipeline lifecycle, local-daemon requirements
- [ ] P1 Build prep (ultracode workflow, cap 10)
  - local runner for the Mac (srv_local_mac live with cap 2)
  - dispatch policy: local-first priority
  - machine attribution in Queue UI + pipeline views
  - QA-review bypass switch
  - caps: GCP=2, local=2
- [ ] P2 Deploy + smoke (pong on BOTH machines, attribution visible)
- [ ] P3 Plan 0 — base Pacman (pixel art, ghosts+vault, coins, power pellets, 2 stages, 3 lives)
- [ ] P4 Verify plan 0 in browser → fix → worklog
- [ ] P5 Plan 1 — menu w/ name, Easy/Difficult, 3rd stage, day/night switch
- [ ] P6 Verify plan 1 → fix → worklog
- [ ] P7 Plan 2 — 3 ghost AI types, score recording persistent/cached
- [ ] P8 Verify plan 2 → final report

## Iteration log

### 2026-07-17 — P0 recon started

- Fleet state going in: `srv_gcp_t4shwd` ACTIVE/auth:true (proven e2e yesterday with a pong
  queue-request), `srv_ec2_main` disabled ghost, `srv_local_mac` seeded but NO daemon running.
- `dispatch.serverAware` = 'true' (set via DDB; UI toggle still missing).
- 4 Explore agents dispatched: policy engine, queue/pipeline UI, pipeline v3 lifecycle
  (incl. QA-bypass seam + planner logic), local-Mac daemon feasibility (hardcoded
  /home/ubuntu paths are the main risk).
- Open questions to resolve before build: (a) can daemon run on macOS unpatched or does it
  need a path-audit fix; (b) where exactly QA review is scheduled so bypass is one clean flag;
  (c) does the S3 daemon bundle include all pipeline code needed by dev jobs on the GCP box;
  (d) is assignedServerId already in API payloads or does attribution need backend work too.

### 2026-07-17 — P0 recon complete → build design locked

Answers: (a) macOS needs a small patch set — 3 non-overridable `/home/ubuntu` literals
(agent-daemon.mjs:426 bareOpCwd, :4299-4326 worktree shape assertion, :8345/8426/8492
skill-scout) + a deterministic path-remap (`/home/ubuntu/projects`→PROJECTS_ROOT,
`/home/ubuntu/worktrees`→FUTURATOR_WORKTREE_ROOT); (b) QA enqueue happens in exactly one
place — wave-completion-check.ts:103-110 — so a per-plan `skipQa` field is a one-guard
bypass and dev-deploy (devUrl) still runs; (c) the S3 bundle prefix carries the daemon tree
and the GCP box already booted from it — but our daemon edits require a re-upload +
box reset (no uploader script exists; one will be written); (d) `assignedServerId/
assignedAt/assignReason` already reach the client untyped — attribution is typing+rendering.

**Architectural decision (the one that matters):** a P3 plan's stories share ONE git
checkout; the repo lives on ONE box; distributed-plan substrate (spec §12) is not built and
will not be rebuilt here. Therefore: one plan = one machine, enforced by finishing the
half-built plan-affinity feature (engine reads `affinityKey`, nothing writes it → we stamp
`plan:<planId>` at every plan-scoped job creation site). Machines trade the app BETWEEN
sequential plans via GitHub: push-to-origin at plan close + clone-if-missing at job intake.
Run assignment: Plan 0 (greenfield, most moving parts) pinned to GCP via the affinity-owner
map — native /home/ubuntu, least risk; Plans 1–2 flow to the Mac naturally through the
local-first priority policy, exercising path-remap + repo handoff. Local-first stays the
standing policy (`priorityOrder: [srv_local_mac, srv_gcp_t4shwd]`).

**"Desktop app" scoping:** MVP = a proper local runner script (start/stop/status/logs,
pipeline-capable env) rather than an Electron/Swift app — same operator value, none of the
packaging surface. Generic other-machine onboarding already exists via the `local-machine`
server type's installCommand. Noted trade-off: daemon boot runs configure-git-identity.sh
which rewrites the Mac's GLOBAL git identity to "Futurator Daemon" — already the case on
this machine from earlier local runs; acceptable for now, flagged for a scoped-config fix.

**Build tasks (ultracode, cap 10):**

- A (opus-4.8): affinity write-side — stamp `affinityKey:'plan:<planId>'` on all plan-scoped
  jobs (api quick-p3, cron deploy/p3-qa/fix jobs, daemon frontier story-dev/integrator/
  reflector); when creating daemon already owns the plan, stamp assignedServerId directly
  (skips up-to-60s sweeper latency); type the field.
- B (fable-5, after A): Mac pipeline enablement — path-remap module, patch 3 literals,
  clone-if-missing repo materialization, push-on-plan-close.
- C (sonnet-5, after A): per-plan `skipQa` end-to-end (quick-p3 payload → plan row → QA guard).
- D (sonnet-5): machine attribution UI — type + render server name (via useServers map) on
  queue rows/detail + plan story/job views.
- E+G (sonnet-5): local fleet runner script + daemon-bundle uploader + P3 env-flag parity
  audit (cloud-init env block).
- F (sonnet-5, after C): `dispatch.serverAware` toggle endpoint + Dispatch Policy tab UI
  (closes a standing follow-up).
- Reviews (opus-4.8) on A and B (the risky ones); I integrate, typecheck, commit, deploy.
