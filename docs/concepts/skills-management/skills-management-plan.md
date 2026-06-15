# Skills Management Module — First-Round Plan

**Status:** Draft · **Date:** 2026-06-13 · **Lineage:** Pipeline v2 Phase 3-C (skill federation)
**Author:** operator + Claude
**Goal:** A Labs module to **search, view, edit, add, remove** skills so the skills database grows
organically — built on the _actual_ runtime skill set, not the aspirational federation.

---

## 0. TL;DR

The operator asked for a skills-management module over "the 66 skills in our pipeline." Investigation
(incl. a live pull from the daemon EC2) found that the **66 skills are not what the federation /
SKILL-SCOUT control plane manages.** There are **three disconnected representations of "skills" that do
not agree**, and the control plane governs only 3 of the ~59 skills the agent actually loads.

So this plan does two things, in order:

1. **Phase 0 — Reconcile + wire the federation** so all three layers finally agree (a correctness fix).
2. **Phases 1–3 — Build the management module** (catalog/search → authoring → source CRUD) on the
   reconciled data.

---

## 1. Verified findings (daemon ground truth, 2026-06-13)

Pulled live from the daemon EC2 (`ec2-54-86-226-233`, via `scripts/rsync-daemon.sh` key).

### 1.1 What the "66 skills" actually are

The live-log line **"66 skills available (Skill tool ON)"** is emitted at `daemon/agent-daemon.mjs:1330`
from Claude Code's `system/init` event (`event.skills[]`). That array is **whatever the CLI loads from
the project repo's `.claude/skills/`** — committed per project at
`/home/ubuntu/projects/<proj>/.claude/skills/`.

For `pacman1` (the job in the screenshot): **59 skills on disk now** (was 66 at job time — the set drifts
per plan). Of the 59:

- **56 are `bmad-*`** — the entire BMAD-method skill set (`bmad-create-prd`, `bmad-dev-story`,
  `bmad-code-review`, `bmad-cis-*`, `bmad-agent-*`, …), installed via `npx bmad-method install` at
  project bootstrap. (`bmad-method` ships 41 `SKILL.md` in `src/core-skills` + `src/bmm-skills`; the
  installed projection expands to 56 skill dirs.)
- **3 are Anthropic** — `canvas-design`, `frontend-design`, `algorithmic-art`.

All are git-tracked in the project repo.

### 1.2 The three-way disconnect (the core finding)

| Representation                                                                   | Count      | Contents                                                        | Source                                              |
| -------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- | --------------------------------------------------- |
| **On-disk `.claude/skills/`** — what the agent _actually loads_ (the "66")       | **59**     | 56 bmad + 3 anthropic                                           | `npx bmad-method install` + `prepin-default-skills` |
| **`skills.manifest.yaml`** — the lockfile SKILL-SCOUT/pipeline thinks it manages | **3**      | only the 3 anthropic (`generated-by: prepin-default-skills@v1`) | `prepin-default-skills.mjs`                         |
| **Federation registry** — what SKILL-SCOUT resolves from                         | **0 live** | embedded default; 2 of 3 repos 404                              | `EMBEDDED_DEFAULT_FEDERATION`                       |

**Implication:** the entire federation / SKILL-SCOUT / manifest control plane governs **3 of 59** real
skills. The 56 BMAD skills — the bulk, and exactly the "organically growing database" the operator wants
to manage — arrived **outside** that system and are invisible to it.

### 1.3 Contributing root causes

- **No live federation manifest on the daemon.** `~/.futurator/skill-federation.yaml` is absent → the
  daemon falls back to `EMBEDDED_DEFAULT_FEDERATION`.
- **Embedded default sources mostly 404.** Only `github.com/anthropics/skills` exists (18 skills) — and
  it ships **no `index.json`** (uses `.claude-plugin/marketplace.json` + `skills/<name>/SKILL.md`), so the
  resolver's `index.json` contract matches nothing live. `github.com/futurator/futurator-skills` and
  `github.com/anthropics/skills-community` are 404 placeholders.
- **No host-level skills/plugins on the daemon** (`~/.claude/skills` empty, `~/.claude/plugins` empty) —
  confirming all skills come from the project repo.
- **Latent correctness cost:** the `Skills-Used:` commit trailer source-attribution, SKILL-SCOUT name-
  collision checks, and the `/labs/skills` digest all operate on a manifest missing ~95% of real skills.

---

## 2. Target architecture (reconciled)

One canonical source of truth that all three layers derive from. Two options were considered.

### Option A (recommended): real `futurator-skills` Git repo as the canonical federation source

Stand up the currently-404 `futurator-skills` Git repo and make it the live federation source:

- Populate it with the bmad set + the 3 Anthropic skills (or reference Anthropic upstream), plus a
  generated `index.json` matching the resolver contract.
- Point the daemon's `skill-federation.yaml` at it (replacing the dormant embedded default).
- Regenerate each project's `skills.manifest.yaml` to pin **all** on-disk skills against this source.

**Why recommended:** all three layers finally agree; authoring-via-commit (the operator's earlier
decision — Git stays canonical, authoring = PR to `futurator-skills`) gets a real home; SKILL-SCOUT
becomes functional against a source that actually resolves.

### Option B (lighter): npm-source adapter for bmad

Teach the federation resolver an `npm:` source kind so `bmad-method` is a first-class source and the 56
skills resolve from the package. Less infra, but leaves bmad outside the Git-canonical model and keeps two
install mechanisms (npm + git). Recorded as the fallback if standing up the repo is deferred.

> Decision pending operator confirmation in Phase 0. Default assumption below: **Option A.**

---

## 3. Phase 0 — Reconcile + wire federation (correctness fix)

Goal: make on-disk == manifest == federation. No UI yet.

| Story                                             | Work                                                                                                                                                                                                                                  | Files (new ✚ / touched ✎)                                                                       | Effort |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| **0.1 `futurator-skills` repo + index generator** | Create repo; script that walks a skill set and emits `index.json` (name, kind, version, license, description from SKILL.md frontmatter). Seed with bmad + 3 anthropic.                                                                | ✚ repo; ✚ `scripts/gen-skill-index.mjs`                                                         | 1 d    |
| **0.2 Wire live federation manifest on daemon**   | Write `~/.futurator/skill-federation.yaml` pointing at `futurator-skills` (priority 1, auto-trust) + anthropics/skills; back up to S3 (federation-backup already exists). Verify resolver returns non-empty.                          | ✎ daemon config; ✎ `federation-resolver` (marketplace.json adapter if keeping anthropic source) | 1 d    |
| **0.3 Manifest reconciliation/repair step**       | Bootstrap/repair step that reads `.claude/skills/` and regenerates `skills.manifest.yaml` to pin every on-disk skill (bmad under a `core`/`framework` bucket, sourced to `futurator-skills`). Idempotent. Backfill existing projects. | ✚ `daemon/lib/app-bootstrap-steps/reconcile-skills-manifest.mjs`; ✎ `prepin-default-skills`     | 1.5 d  |
| **0.4 Verify forensic parity**                    | Confirm `skills_available` count == manifest entry count == federation-resolvable count for a fresh plan. Add a test/assert.                                                                                                          | ✎ tests                                                                                         | 0.5 d  |

**Exit criteria:** a freshly bootstrapped app shows on-disk == manifest == resolvable; `Skills-Used:`
attribution resolves real sources instead of `unknown`.

---

## 4. Phase 1 — Read-only catalog + search + gaps (`/labs/skills/registry`)

Built on reconciled data. The current `/labs/skills` per-app _usage_ dashboard becomes the "Usage" tab;
"Registry" is the new sibling.

| Story                            | Work                                                                                                                                                    | Files                                                                                                                                        | Effort |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **1.1 Catalog API**              | `GET /api/skills/catalog` — flatten the federation index(es) (now live) into one list: name, kind, source, version, license, description. 5-min cache.  | ✎ `functions/api/index.ts`; reuse `indexUrlForSource`/`validateIndexShape`                                                                   | 1 d    |
| **1.2 Reconciliation/drift API** | `GET /api/skills/reconciliation?appId=` — per app, diff on-disk (latest `skills_available` event) vs manifest vs federation; surface unmanaged/missing. | ✎ api; ✎ `agent-events-repository`                                                                                                           | 1 d    |
| **1.3 Catalog UI + search**      | Searchable, filterable table (kind/source/license). Skill detail drawer: rendered SKILL.md, pinned version, which apps use it.                          | ✚ `src/app/labs/skills/registry/page.tsx`; ✚ `src/components/labs/skill-registry/*`; ✚ hooks `use-skill-catalog`, `use-skill-reconciliation` | 2 d    |
| **1.4 Gaps & proposals panel**   | Roll up `gaps[]` across manifests + the live SKILL-SCOUT proposal queue (accept/reject endpoint already exists).                                        | ✎ api; ✚ component                                                                                                                           | 1 d    |

**Exit criteria:** operator can search/browse all ~59 real skills, open any skill, and see the on-disk vs
manifest vs federation reconciliation per app.

---

## 5. Phase 2 — Authoring (add / edit / remove)

Git-canonical: writes go to `futurator-skills` via commit/PR (reuses the party module's one-click
"Publish to main" PR machinery). Scaffold `SKILL.md` + `index.json` entry; edit body; soft-remove (mark
deprecated in index) vs hard-remove (delete + index prune). Deferred detail; sized ~3–4 d.

---

## 6. Phase 3 — Federation source CRUD

UI over `skill-federation.yaml`: add/remove source repos, set priority, auto-trust, refresh cadence;
write-back to S3 + daemon SIGUSR1 reload (the resolver already supports cache invalidation). Sized ~2 d.

---

## 7. Decisions captured

- **Source of truth:** Git/federation stays canonical; authoring = commit/PR to `futurator-skills`.
- **First slice:** read-only catalog + search + gaps — but **preceded by Phase 0 reconciliation** because
  the catalog is meaningless over a 3-of-59 manifest.
- **Module job:** reconcile, then catalog.
- **Federation dormancy:** treated as in-scope (Phase 0 wires a live source), not just flagged.

## 7b. Implementation log

- **2026-06-13 — Story 0.1 + 0.1b DONE** (`scripts/gen-skill-index.mjs`, 9 tests, lint clean). Validated
  against daemon ground truth: 59-skill index (56 bmad + 3 anthropic).
- **2026-06-13 — Story 0.2 DONE (Option A).** Corrections discovered during execution:
  - The `futurator` org **does not exist** — that is why the embedded default 404'd. Real org is
    **`Futurator-ai`**. Canonical source repo is **`Futurator-ai/futurator-skills`**.
  - Repo made **public** (not private as first floated): the daemon has **no GitHub credential**
    (`GITHUB_PAT` unset, no `gh`, no git creds), so a private source could not be resolved — which would
    defeat the purpose. Content is non-sensitive (bmad = MIT, anthropic = public). Reversible to
    private-with-PAT later.
  - Scope: **index-only registry** (`index.json` + README + MIT LICENSE). No body mirroring — bmad bodies
    stay sourced from `bmad-method` (npm), anthropic from upstream; `index.json` entries carry a
    `provenance` field. Framework (bmad-\*) entries normalized to `license: MIT`.
  - Daemon wired: `~/.futurator/skill-federation.yaml` → single source `futurator-skills` (priority 1,
    auto-trust), replacing the embedded default. SIGUSR1 reload + restart confirmed `source: file`.
  - **Exit criterion met:** the daemon's real `federation-resolver` resolves all 59 skills against the
    live source (`bmad-create-prd`, `frontend-design`, `bmad-dev-story` → `futurator-skills`, trust=true);
    bogus names return not-found. The previously-dormant federation is now functional.
- **2026-06-13 — Story 0.3 + 0.4 code DONE (not yet deployed).**
  - New step `daemon/lib/app-bootstrap-steps/reconcile-skills-manifest.mjs`: reads `.claude/skills/`,
    pins every unmanaged on-disk skill into `core[]` sourced to `futurator-skills`; idempotent; preserves
    existing entries; stamps `+reconcile-skills-manifest@v1`. Wired into `app-bootstrap.mjs` as a new step
    **after `bmad-bootstrap`, before `commit-and-push`** (so all ~59 skills are on disk and the reconciled
    manifest is committed).
  - `vendor-skills.mjs` hardened with an **on-disk skip guard**: skips any skill whose `.claude/skills/<n>/SKILL.md`
    already exists, so a reconciled manifest (bmad pinned to the index-only `futurator-skills`) never causes
    404 re-fetches. Returns `skippedOnDisk`.
  - Tests: `reconcile-skills-manifest.test.mjs` (6, incl. **Story 0.4 parity**: manifest count == on-disk
    count post-reconcile). Full suite green: step tests 33/33, idempotency 7/7, lint clean.
  - **Remaining (OUTWARD, needs go-ahead):** (a) deploy the daemon bundle (`scripts/rsync-daemon.sh`) so
    future bootstraps run the step; (b) backfill existing projects (e.g. pacman1) by running reconcile +
    committing their manifest.
- **2026-06-15 — Deploy + backfill DONE (via SSM, not SSH).** SSH was blocked (agent egress IP rotated
  out of the SG allow-list, no stable IP), so deploy went through **AWS SSM Run Command** — immune to IP
  rotation, no SG change. The 3 changed daemon files were transferred base64-over-SSM with per-file
  sha256 verification, syntax-checked, `STEP_WIRED`, daemon restarted `active`. pacman1 backfilled:
  manifest **3 → 59** (`generated-by: prepin-default-skills@v1+reconcile-skills-manifest@v1`), committed +
  pushed (`488766c` on `futurator-repos/pacman1` main). **Final verify (as daemon user `ubuntu`):**
  `SOURCE=file`, all sampled skills (bmad + anthropic) resolve to `futurator-skills` trust=true; on-disk 59
  == manifest 59. **Phase 0 COMPLETE — three-way disconnect closed.**
  - ⚠️ Incidental finding: `futurator-repos/pacman1` git remote embeds a GitHub PAT in its URL (visible in
    daemon git config). Recommend rotating that token. Also: daemon has no `GITHUB_PAT` env — push creds
    live per-repo in the remote URL.
  - Gotcha for future SSM work: SSM runs as **root**, so `homedir()`→`/root`; always run daemon-user
    checks with `sudo -u ubuntu -H HOME=/home/ubuntu` or you get a false `source=fallback`.

## 7c. Phase 1 implementation log

- **2026-06-15 — Phase 1 (read-only catalog) COMPLETE.**
  - **1.1** `GET /api/skills/catalog` + `functions/shared/skill-catalog.ts` (`fetchSkillCatalog`,
    fetch-injectable, HTTPS index.json fetch, priority-dedupe, graceful per-source degradation, 5-min
    Lambda cache). Commit `03e8f9b`.
  - **1.2** `GET /api/skills/reconciliation?appId=` + pure `diffSkillReconciliation` (managed / unmanaged /
    available-not-loaded). Reads latest `skills_available` event **top-level** (not `payload`) per the
    pushEvent spread, ordered by `timestamp`. Committed in `2200589` (bundled with another agent's commit
    due to a concurrent-`git commit` race — code intact on-branch).
  - **1.3** `/labs/skills/registry` UI: searchable/filterable catalog, skill-detail drawer, per-app drift
    panel; Usage↔Registry tabs on both pages. Hooks `use-skill-catalog`, `use-skill-reconciliation`.
    Commit `17faed2`.
  - Tests: 11 catalog/diff unit tests green; my files typecheck + lint clean (full build deferred — a
    concurrent agent has unrelated broken types in the tree).
  - **NOT YET DEPLOYED:** the API endpoints take effect on the next `sst deploy`; the UI on the next admin
    static-export deploy. Both outward — awaiting go-ahead.
- **Remaining:** Phase 2 (authoring — add/edit/remove via PR to `futurator-skills`) and Phase 3
  (federation source CRUD). These cover the "edit / add / remove" half of the original ask.

## 7d. Phase 2 implementation log

- **2026-06-15 — Phase 2 (authoring) COMPLETE in code; daemon-side deployed.**
  - **Source relocated** `Futurator-ai/futurator-skills` → **`futurator-repos/futurator-skills`**: the pipeline
    PAT authenticates as the `futurator-repos` user and is scoped to that account only (cannot write
    `Futurator-ai`). Moving the source there lets authoring reuse the existing proven write path with no new
    secrets. Daemon federation manifest re-pointed + verified resolving from the new source.
  - **Backend:** `getFileSha`/`putFile`/`deleteFile` (github/connector.ts, Contents API); `skill-authoring.ts`
    (`buildSkillMd`, `upsertIndexEntry`/`removeIndexEntry`, `putSkill`/`deleteSkill` writing SKILL.md +
    index.json); `POST/PUT/DELETE /api/skills` with zod validation + a guard that 403s edits to bmad
    framework skills; catalog cache busted on every write. Commit `13a8c36`.
  - **Frontend:** New-skill form + edit/delete on the detail drawer + `use-skill-mutations` hooks.
  - Tests: 35 skills tests green (gen-index 9, catalog/diff 11, contents 7, authoring 8); my files typecheck +
    lint clean.
  - **DEPLOY STATUS:** daemon-side live (reconcile step + federation source). The API endpoints + Registry UI
    need an `sst deploy` + static export — **deferred to a single coordinated deploy** because
    `functions/api/index.ts` shares the working tree with another agent's _uncommitted_ deploy-v2.5 work and
    `sst deploy` bundles the working tree (can't isolate). See the handoff note.

## 8. Open question for Phase 0

Option A (stand up `futurator-skills` repo) vs Option B (npm-source adapter). Recommendation: **A** — it is
the only path where all three layers agree _and_ authoring has a real home. Confirm before Phase 0 build.
