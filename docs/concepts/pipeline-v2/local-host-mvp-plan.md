# Local-Host MVP — run a full plan on the laptop, dispatcher-ready

> Status: PLANNED 2026-06-12. Execution: a dedicated Claude session.
> Parent designs: `multi-host-dispatch-readiness.md` (§3.5 "local hosts are
> the same daemon"), `durable-planes-park-hydrate.md` (§5 phase 1).
> This doc is self-contained: context, audited blockers with file pointers,
> milestones with acceptance criteria.

## 0. Goal (operator's words)

Make the **Local** switch actually run the pipeline on the operator's Mac —
same daemon, same plans, same AWS/GitHub integration — with its **own cap
(4)**. Design so it scales to a mixed EC2+local fleet (v3 dispatcher), but
the MVP is:

1. **Test A:** a brand-new app + plan executed **100% locally** (bootstrap →
   stories → wave gates → VQA → QA → deploy/publish), EC2 stopped.
2. **Test B (the final proof):** the next plan executed **100% on EC2**,
   local daemon stopped — verifying nothing regressed and the two hosts are
   interchangeable.

NOT in scope (v3 later): scheduler host-selection, cross-host story fan-out
within one wave, SSM→job-channel for file-explorer/park, logical paths in
Lambda-built pipelines (we shim instead — see L1).

## 1. Current state (audited 2026-06-12)

**The "Local" toggle is a kill switch, not a mode.** `runtime-controls.tsx`
`handleToggle('local')` → `POST /api/ec2/disable` → SSM-stop daemon +
`StopInstancesCommand` (functions/api/index.ts:4540). Nothing starts
locally. Footgun: the `Local` tab stops EC2 **without** the confirm dialog
the explicit Stop-EC2 button has — aborts in-flight jobs silently.

**The daemon was born local** (daemon/README.md: "Local daemon that polls
DynamoDB… no inbound ports on your Mac"). Everything cloud-facing already
works from any host with credentials: DDB jobs/events/attention (AWS SDK),
S3 screenshots/knowledge, GitHub pushes via the bare repo's `origin`,
Claude OAuth (the Mac is the token _source_ — `scripts/mac-oauth-server.mjs`).
Worktree/store roots are already env-overridable
(`FUTURATOR_WORKTREE_ROOT`, `FUTURATOR_BARE_REPOS_ROOT`,
`FUTURATOR_LEGACY_PROJECTS_ROOT`, `FUTURATOR_NODE_MODULES_STORE_ROOT`).

**Blockers found (each becomes a milestone task):**

| #   | Blocker                                                                                                             | Where                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B1  | Jobs carry baked `/home/ubuntu/...` paths; daemon positionally parses `/home/ubuntu/worktrees/<app>/<plan>/<story>` | Lambda bakes `workingDir` + `cd ${workingDir}` inside step command strings; guard at `daemon/agent-daemon.mjs:2763` |
| B2  | Plan creation writes `plan.md` to EC2 **via SSM**                                                                   | `plan-folder-service.ts bootstrapPlanFolder`, called at `functions/api/index.ts:1707,1774`                          |
| B3  | `sudo -n -u ubuntu` exec surface for git/shell                                                                      | `daemon/lib/wave-merge-runner.mjs:119-141` (defaultGitRunner/defaultShellRunner)                                    |
| B4  | Linux-only port drains (`fuser …/tcp`, `ss`) — BSD/macOS lacks both                                                 | `functions/shared/pipelines/framework-detect.ts buildPortDrainLines`, `daemon/lib/dev-server-boot.mjs drainPort`    |
| B5  | `cp -al` hardlink farm — BSD `cp` has no `-l` (falls back to `cp -a`: correct but 700M/worktree)                    | `daemon/lib/node-modules-store.mjs` (fallback already exists)                                                       |
| B6  | Hardcoded `file:///opt/futurator-daemon/lib/claude-md-writer.mjs` import baked into a step                          | `functions/shared/pipelines/story-pipeline.ts` claude-md-append-decision                                            |
| B7  | No claim/lease on jobs — two daemons double-claim; exclusivity today = power off the other host                     | daemon poll loop                                                                                                    |
| B8  | Memgraph (knowledge sync) assumed on localhost EC2                                                                  | compile-sync steps; failures are already non-blocking                                                               |
| B9  | UI "daemon status" = EC2 instance status only                                                                       | `/api/ec2/status`, `runtime-controls.tsx`                                                                           |

## 2. Design principles (so v3 falls out instead of being rebuilt)

1. **One daemon binary, host config via env.** A host is
   `{ hostId, kind: ec2|local, capacity, roots, execMode }` — all env. No
   `if (isMac)` business logic; platform differences live in tiny exec
   helpers.
2. **DDB is the only coordination plane.** Hosts register + heartbeat in a
   `futurator-hosts` table; jobs are **claimed** (conditional write), never
   just polled. EC2 + laptop running simultaneously must be _safe_ on day
   one (even if the MVP runs them one at a time).
3. **Paths cross the wire as they are today; the HOST translates.** The
   clean fix (Lambda emits logical app/plan/story IDs) is v3. The MVP shim:
   the daemon rewrites the well-known prefixes in `workingDir` AND in shell
   step command strings at execution time. Contained, reversible, zero
   Lambda risk.
4. **Job-channel over SSM for anything a plan run needs.** SSM only reaches
   EC2. Whatever sits in the create→develop→deploy happy path must flow
   through the jobs table (which reaches every host).

## 3. Milestones

### L0 — Host identity, registry, claim/lease (the v3 seed)

- `daemon`: env `DAEMON_HOST_ID` (e.g. `mac-ricardo`, default `ec2-main`),
  `DAEMON_MAX_CONCURRENT` (operator's cap: 4 local / 2 EC2 — the
  concurrency-manager already enforces a cap; make it env-driven if not).
- New DDB table `futurator-hosts` (PAY_PER_REQUEST):
  `{ hostId, kind, capacity, activeCount, lastSeenAt, version }` —
  heartbeat upsert every poll tick (piggyback on the existing heartbeat).
- **Claim**: daemon transitions PENDING→RUNNING with
  `ConditionExpression: status=PENDING AND attribute_not_exists(claimedBy)`,
  setting `claimedBy=hostId, leaseExpiresAt=now+15m`. Long steps renew the
  lease (piggyback `lastHeartbeatAt` writes). A reaper (cron or daemon
  tick) re-queues jobs whose lease expired (host died) → this is also the
  spot/ephemeral-worker safety from durable-planes §5.
- **Affinity (MVP-simple):** optional `job.targetHostId`. When set, only
  that host claims it. Plan rows get `hostId` stamped at first claim; all
  subsequent jobs of that plan inherit `targetHostId` (a plan runs
  end-to-end on one host — phase-1 affinity from the dispatch doc).
- Tests: claim race (two fake hosts, one winner), lease expiry re-queue,
  affinity respected.

### L1 — Path portability shim

- `daemon/lib/host-paths.mjs`: `rewriteForHost(str)` replacing the two
  well-known prefixes with host roots:
  `/home/ubuntu` → `FUTURATOR_HOME_ROOT` (Mac: `~/FuturatorLabs`, contains
  `projects/ worktrees/ repos/ .node_modules_store/`), and
  `/opt/futurator-daemon` → `FUTURATOR_DAEMON_HOME` (Mac: the repo's
  `daemon/` checkout). Identity function on EC2 (roots equal defaults) —
  zero behavior change there.
- Apply at the execution boundary ONLY: `job.workingDir`, every shell
  step's `command`, agent `cwd`s, and the B6 `file://` import (B1+B6).
  Never rewrite content destined for DDB/S3/git (paths stored in events
  stay as-sent; forensics remain comparable).
- Fix the positional guard (agent-daemon.mjs:2763): parse
  `<app>/<plan>/<story>` as the LAST three segments under the worktree
  root instead of `parts[3..5]` of an absolute path.
- Tests: rewrite idempotence on EC2 (no-op), Mac mapping, guard parses
  both roots.

### L2 — Exec portability

- **Exec mode** (B3): env `DAEMON_EXEC_MODE=sudo-ubuntu|direct`. The
  wave-merge `defaultGitRunner/defaultShellRunner` and dev-server-boot
  `shell` choose `spawn('bash', ...)` directly under `direct` (Mac: daemon
  runs as the owner; sudo unnecessary). EC2 keeps `sudo-ubuntu`.
- **Portable port drain** (B4): extend `buildPortDrainLines` +
  `drainPort` with an lsof fallback chain —
  `fuser -k -TERM p/tcp || kill -TERM $(lsof -ti:p)` and the ss-wait loop
  guarded by `command -v ss` with an lsof-based wait fallback. (lsof is
  trustworthy on macOS; its blindness was an EC2/Next16 phenomenon —
  keep fuser/ss FIRST on Linux.) Regenerate the gate-registry snapshot if
  registry output changes.
- **APFS clone** (B5): in `materializeNodeModulesFromStore`, on
  `process.platform === 'darwin'` try `cp -c` (clonefile, copy-on-write —
  hardlink-equivalent cost, better isolation) before the `cp -a` fallback.
- **GNU userland**: prerequisite (documented in L3 script): laptop needs
  `brew install bash coreutils gnu-sed findutils`; the local daemon
  prepends gnubin dirs + brew bash to child `PATH`. Audit any step using
  GNUisms (`find -xtype`, `du -x`, `xargs -d`) under macOS in L5's dry run.

### L3 — Local runtime kit

- `daemon/.env.local.example`: region, table names, `DAEMON_HOST_ID`,
  `DAEMON_MAX_CONCURRENT=4`, `DAEMON_EXEC_MODE=direct`,
  `FUTURATOR_HOME_ROOT=$HOME/FuturatorLabs`, `FUTURATOR_DAEMON_HOME=<repo>/daemon`,
  `MEMGRAPH_URI` (optional).
- `scripts/run-local-daemon.sh`: preflight (aws creds valid, `claude`
  CLI authed, `git` pushes to github work, playwright chromium present —
  install if not, brew GNU tools present, roots created) → `npm start`
  with the env. Ctrl-C graceful (already implemented).
- **Memgraph** (B8): `docker-compose.local.yml` with memgraph, OR document
  "absent = compile steps degrade non-blocking" (they already do). MVP:
  optional container; knowledge md files still commit to git either way.
- **plan.md bootstrap over the job channel** (B2): replace the SSM write
  in `POST /api/plans` with (a) storing the markdown on the plan row /S3,
  and (b) the daemon writing `projects/<plan>/plan.md` lazily before the
  first claimed job of the plan if absent. SSM path stays as fallback for
  EC2-only operation until removed. (Audit for any other SSM call in the
  create→develop→deploy happy path; file-explorer/app-delete/park stay
  EC2-only for now.)

### L4 — UI: hosts panel + honest toggle

- `/api/hosts` (Lambda) reads `futurator-hosts` → UI DaemonPanel renders
  BOTH chips: `EC2 running 1/2` · `mac-ricardo online 0/4` (heartbeat
  age → online/offline). The Local tab = "this is the host I'm watching",
  not a power action.
- **Kill the footgun:** clicking `Local` must NOT silently stop EC2.
  Stopping EC2 is only the explicit confirmed button. (One-line fix in
  `runtime-controls.tsx handleToggle` — consider shipping immediately.)
- New-plan modal (or app row) gets a **host picker** when >1 host is
  online: `auto (prefer local) | mac-ricardo | ec2-main` → sets the first
  job's `targetHostId`. MVP default: auto = the host the operator's
  toggle selects.

### L5 — Acceptance (the two tests)

**Test A — 100% local (EC2 stopped):**

- [ ] `run-local-daemon.sh` preflight green; host heartbeat visible in UI.
- [ ] New app bootstrap (GitHub repo created from the Mac, boilerplate
      materialized under `~/FuturatorLabs/projects/<app>`).
- [ ] Plan with parallel stories: worktrees under
      `~/FuturatorLabs/worktrees/<app>/…`, hardlink/clonefile store
      (verify inode sharing), story smokes boot + screenshot.
- [ ] Wave gates: merge candidate, per-stage quality gate, wave VQA
      (judges, screenshots → S3), green advance pushed to GitHub.
- [ ] QA review populated (claims table, gate-VQA chips), deploy job
      publishes to `s3://futurator-ai-website/apps/<app>/`, main FF'd +
      pushed, app loads at its public URL.
- [ ] Forensic attribution sane (no machine-wait inflation), costs logged.

**Test B — 100% EC2 (local daemon stopped):**

- [ ] Same flow on a second plan, EC2-only, zero regressions — proving the
      L1/L2 changes are no-ops on Linux (the identity-rewrite + sudo mode).

**Both:** jobs table shows correct `claimedBy`/lease on every job; no job
ever claimed by the stopped host.

## 4. Risks / open questions

- **macOS bash 3.2 + BSD userland** under Lambda-baked step scripts — the
  brew-GNU PATH approach is the mitigation; L5 Test A is the real audit.
  Any step that still breaks gets a portability fix in the snippet builder
  (never a Mac fork of the pipeline).
- **Laptop sleep mid-plan**: lease expiry + re-queue (L0) is the safety
  net; document "keep lid open / caffeinate" for MVP.
- **Two hosts, one app**: phase-1 affinity pins a plan to a host; two
  PLANS of one app on two hosts also needs the DDB integration lease
  (durable-planes §5) — defer unless Test A/B want it; same-host plans
  keep the in-process lock.
- **Deploy from Mac**: deploy job runs `aws s3 cp` to the scoped
  `apps/<app>/` path — allowed writes only; verify the local AWS profile
  is the same account/permissions (NEVER the bucket root — CLAUDE.md
  deploy-safety rules apply identically on the laptop).

## 5. Suggested execution order

L0 → L1 → L2 (parallel with L3) → L4 → L5-A → fixes → L5-B.
L0+L1 are the load-bearing design; everything after is mechanical. Ship
the L4 footgun fix (silent StopInstances) immediately, independent of the
rest.
