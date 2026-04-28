# Pipeline v2 — Phase 1 Epic Plan

| Field            | Value                                                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Draft for execution                                                                                                                                                                                                                                                        |
| **Authored**     | 2026-04-27                                                                                                                                                                                                                                                                 |
| **Source spec**  | `docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md` (v2.5 consolidated, 3,507 lines)                                                                                                                                                                       |
| **Phase scope**  | Substrate — GitHub-backed Apps with typed boilerplates, real PAT integration with `futurator-repos` org, the Pipeline v2 Roadmap strip for big-picture visibility, and the foundational **Timer Intelligence** measurement layer that every subsequent phase will leverage |
| **Effort**       | ~16–18 dev days, ~22–26 stories across 8 epics                                                                                                                                                                                                                             |
| **Ship gate**    | See §3 below — five pass/fail conditions                                                                                                                                                                                                                                   |
| **Out of scope** | The 11-step pipeline (Phase 2), tool allowlists at spawn (Phase 2), ARCHITECT/AWS manifest (Phase 2), skills federation (Phase 3), REFLECTOR (Phase 3), speculation `explore/` (Phase 3), production rigor 24h soak (Phase 3)                                              |

---

## 1. Big-picture: where Phase 1 sits in v2

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PIPELINE v2 (overview)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Phase 1 — SUBSTRATE        ◄── you are here                            │
│  ─────────────────────                                                  │
│  GitHub repo per App, typed boilerplates (Next.js / SST / Vite /        │
│  Mobile), real futurator-repos org integration, PAT in SSM, App-bootstrap  │
│  saga, big-picture roadmap visibility, Timer Intelligence measurement   │
│  layer (the instrument that proves Phase 2/3 actually improve things).  │
│  ~16–18 days.                                                           │
│                                                                         │
│  Phase 2 — PIPELINE                                                     │
│  ──────────────────                                                     │
│  The 11-step inner loop with tool allowlists at spawn time, branch-     │
│  per-story `wip/` worktrees, ARCHITECT + `aws.manifest.yaml`,           │
│  expanded Plan.kind enum, GitHub Actions OIDC, basic CDK deploys.       │
│  Brings v2.5 §51–54 (Phases A, B, D) to life. ~25–30 days.              │
│                                                                         │
│  Phase 3 — COMPOUNDING                                                  │
│  ─────────────────────                                                  │
│  Skills federation + SKILL-SCOUT, REFLECTOR + Reflection Inbox,         │
│  speculation `explore/` branches with EVALUATOR, production rigor       │
│  with 24h soak, drift detection, persona evolution. v2.5 §52–56         │
│  (Phases C, E, F). ~25–30 days.                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

The Timer Intelligence module (Epic 1.8) is in Phase 1 by design: it is the
measurement instrument that has to predate the things being measured. Without
it, every Phase-2 and Phase-3 claim of "this is faster" is anecdote.

---

## 2. Ship gate (Phase 1 done = these five pass)

1. **End-to-end App creation in 90 seconds.**
   Click `+ New App` in `admin.futurator.ai/labs` → pick "Next.js + BMAD" →
   type `dino6` → submit. Within 90s the following are true:
   - `github.com/futurator-repos/dino6` exists with the boilerplate contents.
   - `/home/ubuntu/repos/dino6.git` is a bare clone on the daemon EC2 box.
   - `/home/ubuntu/projects/dino6` is the primary worktree (App.workingDir).
   - BMAD is installed in the worktree (`bmad/` directory present).
   - `apps` table has the new App row; App detail page loads.
   - Repository badge in the App detail header links to GitHub.

2. **All four boilerplate types are selectable, three are gracefully empty.**
   The `+ New App` modal lists Next.js, SST, Vite, Mobile. Picking SST/Vite/Mobile
   creates a real GitHub repo from a real-but-empty template (README only, says
   "Wiring lands in Phase X"). The App row is created normally; the App detail
   shows a "Boilerplate scaffold pending" banner. No exception, no half-state.

3. **Timer Intelligence captures and reports a real plan.**
   Run any plan against `dino6`. The Plan dashboard shows a live "Timing"
   panel — stacked bar by category, total elapsed, updates every 5s. When the
   plan finishes, click "Export forensic JSON" and receive a file shaped for
   paste-into-Claude analysis with `schemaVersion: "timer-intel-v1.0"`. CI test
   asserts that for any completed plan the sum of category slices equals
   `endedAt − startedAt` to within 1 second (no `unattributed` leak).

4. **3× escalator fires after cohort accumulation.**
   After ≥5 plans of the same `(templateType=nextjs, planKind=initial)` shape
   have completed, a 6th plan whose `review` time exceeds 3× the cohort median
   triggers an `info`-severity attention item in the dock with the message
   _"Plan `<id>`: review time 3.4× cohort median — review may be looping"_ and
   a deep-link to the timing detail.

5. **Big-picture v2 visibility is on every App detail page.**
   The "Pipeline v2 Roadmap" strip is rendered on every App detail (collapsed
   by default, expandable). It shows three pills: Phase 1 ✅ (active), Phase 2
   ⏳, Phase 3 ⏳. Clicking opens `/labs/roadmap` with the full narrative
   sourced from `docs/concepts/pipeline-v2/futurator-pipeline-v2-5-consolidated.md`.

---

## 3. Prerequisite resolutions (PR-1 through PR-12)

| #     | Decision                         | Resolution                                                                                                                                                                                                                                         | Owner of action  |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| PR-1  | Org name                         | **`futurator-repos`** (already exists, 8 repos visible). Pipeline-managed repos enforce kebab-case slug `[a-z][a-z0-9-]{1,39}` matching `App.appId`. Existing repos keep their casing — they are not pipeline-managed.                             | Settled          |
| PR-2  | PAT vs GitHub App                | **PAT for Phase 1**, fine-grained, org-scoped. Connector designed so swapping to GitHub App in Phase 3 is one file.                                                                                                                                | Story 1.1.1      |
| PR-3  | PAT storage                      | **AWS SSM via `sst.aws.Secret('GithubPat')`**. SST CLI prompts on first deploy; encrypted at rest; only the API Lambda's role reads it. Local dev fallback to `.env.local`.                                                                        | Story 1.1.2      |
| PR-4  | Boilerplate distribution         | **GitHub template repos (`is_template: true`) + post-create scaffold script.** `createRepoFromTemplate` is one API call; the post-create step runs locally on the daemon to inject slug/displayName values.                                        | Epic 1.3         |
| PR-5  | Working tree layout              | **Bare clone at `/home/ubuntu/repos/<slug>.git`; primary worktree at `/home/ubuntu/projects/<slug>`** (= existing `App.workingDir`, semantics shift but field unchanged). Per-story worktrees under `/home/ubuntu/work/<storyId>` land in Phase 2. | Story 1.4.2      |
| PR-6  | Branch protection at create-time | **Off in Phase 1 for prototype/mvp; required-PR-on-main only when the future `production` rigor lands in Phase 3.** Encoded as a stub helper in the connector.                                                                                     | Story 1.2.4      |
| PR-7  | GitHub Actions at create-time    | **Stub workflow `pipeline-stub.yml`** that runs `lint && build` on push to `main` only. Proves OIDC wiring without committing to deploy logic. Real deploy workflows are Phase 2.                                                                  | Story 1.3.1      |
| PR-8  | Boilerplate kit contents         | Per-type minimum (see §5 App-Type Architecture). Common to all: `CLAUDE.md` skeleton, `.claude/skills.manifest.yaml` (empty placeholder), `README.md`, `.gitignore`, `pipeline-stub.yml`.                                                          | Epic 1.3         |
| PR-9  | Webhook strategy                 | **Outbound only in Phase 1.** No inbound webhook receiver Lambda. Phase 2 adds webhook handling for Actions completion events.                                                                                                                     | Phase 2 deferral |
| PR-10 | Repo-name = `App.appId`          | **Yes, locked at App creation.** Same slug, same URL, same identity end-to-end.                                                                                                                                                                    | Story 1.4.1      |
| PR-11 | Daemon git identity              | **Phase 1 reuses the same PAT** for daemon push/clone. Configured via `git config --global url.https://<token>@github.com/.insteadOf https://github.com/`. Phase 2 migrates to per-repo deploy keys when the manifest layer arrives.               | Story 1.4.3      |
| PR-12 | SST `Linkable` for the secret    | **Use `sst.aws.Secret`** declared in `sst.config.ts`, link to the API Lambda. Type-safe `Resource.GithubPat.value` accessor. Don't roll a custom SSM read.                                                                                         | Story 1.1.2      |

---

## 4. Architectural decisions encoded in this phase

These are the choices that bind every later phase. Captured here so a reader of
this doc one quarter from now can reconstruct intent.

1. **Identity = slug = repo name = working dir = URL segment.** One canonical
   string per App, locked at creation. `App.appId` regex enforces it.
2. **App-Type drives downstream behavior, not just initial scaffold.** The
   `BoilerplateType` is stored on the App row; Phase 2's ARCHITECT consults it
   to pick deploy taxonomy defaults; Phase 3's SKILL-SCOUT consults it to pick
   default skill loadouts. The architecture in §5 is not just for Phase 1.
3. **GitHub is the authoritative substrate for code; DynamoDB is metadata only.**
   No code lives in DDB. No git history lives in DDB. DDB stores App rows,
   Plan rows, Job rows, Event rows, Timer summaries.
4. **The App-bootstrap is a transactional saga, not a chain of independent jobs.**
   One `app-bootstrap` job kind with five idempotent sub-steps. Failure at any
   step surfaces a single attention item with concrete recovery actions.
5. **Timer measurement precedes every optimization.** Epic 1.8 is non-negotiable.
6. **Big-picture visibility precedes Phase 2 implementation.** Epic 1.6 is
   non-negotiable.

---

## 5. App-Type architecture (the multi-template pattern)

This is the place Ricardo asked for explicit care: _"include vite, sst, next js
— just to make sure we architected the app type well"_. Four types now, more
later. The architecture has to scale.

### 5.1 The `BoilerplateType` registry

```ts
// functions/shared/boilerplates/registry.ts
export type BoilerplateType = 'nextjs' | 'sst' | 'vite' | 'mobile';

export interface BoilerplateMetadata {
  type: BoilerplateType;
  displayName: string; // "Next.js + BMAD", etc.
  icon: string; // emoji for grid
  templateRepo: string; // "futurator-repos/template-nextjs"
  status: 'wired' | 'stub'; // Phase 1: only 'nextjs' is 'wired'
  defaultStack: {
    runtime: 'node' | 'bun' | 'react-native';
    packageManager: 'npm' | 'pnpm' | 'bun';
    testCommand: string; // 'npm test'
    devCommand: string; // 'npm run dev'
    buildCommand: string; // 'npm run build'
  };
  postCreateSteps: PostCreateStep[]; // ordered, idempotent
  bmadSupported: boolean; // can the BMAD inject step run?
  // Phase 2 hooks (declared here so the field exists; consumed later):
  defaultDeployFlavor?: 'static-site' | 'sst-app' | 'spa-on-cloudfront' | 'mobile-store';
  defaultManifestSeed?: AwsManifestSeed; // Phase 2 ARCHITECT default
  defaultSkillLoadout?: SkillId[]; // Phase 3 SKILL-SCOUT default
}

export const BOILERPLATE_REGISTRY: Record<BoilerplateType, BoilerplateMetadata> = {
  nextjs: {
    /* fully populated in Phase 1 */
  },
  sst: {
    /* status: 'stub' in Phase 1, real-but-empty repo */
  },
  vite: {
    /* status: 'stub' in Phase 1, real-but-empty repo */
  },
  mobile: {
    /* status: 'stub' in Phase 1, real-but-empty repo */
  },
};
```

### 5.2 Type-by-type Phase 1 commitment

| Type        | Template repo                     | Status in Phase 1 | What ships in the template                                                                                                                                                                         |
| ----------- | --------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Next.js** | `futurator-repos/template-nextjs` | **wired**         | Next.js 16 starter, App Router, Tailwind 4, Geist, BMAD pre-installed, `CLAUDE.md` skeleton, `.claude/skills.manifest.yaml` (empty), `pipeline-stub.yml` Action, `README.md`                       |
| **SST**     | `futurator-repos/template-sst`    | stub              | `README.md` saying "Phase 2: full SST starter with `sst.config.ts`, Lambda + API Gateway + DynamoDB scaffold, OIDC deploy workflow" + the common files (CLAUDE.md skeleton, empty skills manifest) |
| **Vite**    | `futurator-repos/template-vite`   | stub              | `README.md` saying "Phase 2: Vite + React + TypeScript SPA starter" + common files                                                                                                                 |
| **Mobile**  | `futurator-repos/template-mobile` | stub              | `README.md` saying "Phase 3: Expo + React Native + EAS build pipeline" + common files                                                                                                              |

The stub templates exist as **real GitHub template repos** (`is_template: true`)
so the type selector exercises the same `createRepoFromTemplate` code path
regardless of type. This is what de-risks the multi-template pattern: if the
flow works for an empty stub, wiring up the SST/Vite content in Phase 2/3 is
template content work, not infrastructure work.

### 5.3 Post-create scaffold steps (per type)

Each type declares an ordered list of `PostCreateStep`s the daemon executes
locally after cloning. Each step is idempotent — re-running the bootstrap
doesn't duplicate work. Steps for `nextjs`:

1. `inject-app-values` — Replace `__APP_SLUG__`, `__APP_DISPLAY_NAME__` placeholders in `package.json`, `README.md`, `CLAUDE.md`.
2. `npm-install` — Run `npm install` in the worktree.
3. `bmad-bootstrap` — If `bmadEnabled: true`, run the existing `daemon/pipelines/party-bootstrap.mjs` adapted for the new repo path.
4. `commit-and-push` — Commit "chore: post-create scaffold" with the daemon's git identity, push to `main`.

Stubs (`sst`, `vite`, `mobile`) only run step 1 + step 4. No `npm install` because
there's nothing to install.

### 5.4 Where the registry lives and how it's consumed

- **Server-side:** `functions/shared/boilerplates/registry.ts` — single source of truth, imported by the API Lambda's `POST /api/apps` handler and by the daemon's `app-bootstrap` pipeline.
- **Client-side:** the `+ New App` modal imports a slim view of the registry (display data only — never the full metadata) for the type picker.
- **Daemon:** `daemon/pipelines/app-bootstrap.mjs` reads the registry to know which post-create steps to run.

A new `BoilerplateType` in Phase 2/3 is a single file change plus a new template
repo — no API surface change, no DDB migration.

---

## 6. Epics — full breakdown

> **Story format.** Each story below is dev-agent-ready: numbered AC (testable
> bullets), per-story touch points, ordered tasks. Effort = S (≤½d) / M (~1d)
> / L (~2d). Sprint-status keys are `pv2-p1-<epic>-<story>-<kebab-title>`.

---

### Epic 1.1 — Prerequisite settle ⚙️

**Goal:** Resolve PR-1 through PR-12 in code. By end of epic the API Lambda
authenticates against GitHub and the daemon can clone/push.
**Dependency:** none — foundation for everything else.

#### Story 1.1.1 — Mint fine-grained PAT scoped to `futurator-repos` org

`pv2-p1-1-1-mint-fine-grained-pat` · **S** · backlog

**Acceptance Criteria:**

1. PAT minted at github.com/settings/personal-access-tokens with `Resource owner = futurator-repos`.
2. Repository permissions: `Contents = Read and write`, `Administration = Read and write`, `Metadata = Read-only`. **No `Workflows` permission.** No Account permissions.
3. Repository access = "All repositories" (so future apps don't require re-scoping).
4. Expiry = none (cannot lapse mid-plan); rotation cadence enforced via runbook + Story 1.7.1 attention item.
5. Token value recorded only in operator vault — never committed, never logged.
6. `docs/runbooks/pat-rotation.md` exists with: rotation cadence (quarterly), step-by-step rotation procedure, the SSM update command, and a smoke-test (`curl -H "Authorization: Bearer <token>" https://api.github.com/user`) returning HTTP 200 + the expected login.

**Touch points:**

- `docs/runbooks/pat-rotation.md` (new)
- (out-of-repo) github.com/futurator-repos org settings

**Tasks:**

- [ ] Mint the PAT in GitHub UI with the scopes above
- [ ] Curl-smoke `/user` endpoint, verify 200 + login
- [ ] Curl-smoke `/orgs/futurator-repos` to confirm org-level read
- [ ] Write `pat-rotation.md` runbook
- [ ] Hand the PAT value to Story 1.1.2 for SSM ingestion

---

#### Story 1.1.2 — Add `sst.aws.Secret('GithubPat')` and link to API Lambda

`pv2-p1-1-2-add-sst-secret-and-link` · **S** · backlog

**Acceptance Criteria:**

1. `sst.config.ts` declares `const githubPat = new sst.aws.Secret('GithubPat')` at top-level resources block.
2. The API Lambda (`functions/api/index.ts` handler) is configured with `link: [githubPat]`.
3. `npx sst secret set GithubPat <value>` succeeds in the production stage; SST stores encrypted in SSM.
4. `sst-env.d.ts` is regenerated and includes `Resource.GithubPat.value: string`.
5. A throwaway test-route `GET /api/_internal/secret-loaded` returns `{ loaded: true, length: <int> }` (length only — never the value) when the link is wired correctly. Route is removed after verification.
6. Local dev fallback: when running `npm run dev` without SST, the connector reads `process.env.GITHUB_PAT` from `.env.local` instead of `Resource.GithubPat.value`. The fallback is wrapped in a `try { Resource.GithubPat.value } catch { process.env.GITHUB_PAT }` pattern.

**Touch points:**

- `sst.config.ts` (extend)
- `functions/api/index.ts` (link config)
- `sst-env.d.ts` (regenerated)
- `.env.local.example` (document `GITHUB_PAT=ghp_...` for local dev)

**Tasks:**

- [ ] Declare `Secret('GithubPat')` in sst.config.ts
- [ ] Add link to the API function definition
- [ ] Run `npx sst secret set GithubPat <value>` in the production stage
- [ ] Add a temporary smoke route to verify load
- [ ] Confirm `Resource.GithubPat.value` shows up in `sst-env.d.ts`
- [ ] Document local-dev fallback in `.env.local.example`
- [ ] Remove the temporary smoke route

---

#### Story 1.1.3 — Configure daemon's git identity using PAT

`pv2-p1-1-3-configure-daemon-git-identity` · **S** · backlog

**Acceptance Criteria:**

1. `daemon/scripts/configure-git-identity.sh` exists and is invoked by `daemon/agent-daemon.mjs` once at startup (idempotent — re-running is a no-op).
2. The script reads the PAT from SSM (`/futurator/_pipeline/github-pat` or wherever SST stored `GithubPat`) using AWS CLI on the EC2 box.
3. It runs `git config --global url."https://x-access-token:${PAT}@github.com/".insteadOf "https://github.com/"` so subsequent git commands authenticate transparently.
4. It runs `git config --global user.email "daemon@futurator.ai"` and `git config --global user.name "Futurator Daemon"`.
5. Smoke-test: `git ls-remote https://github.com/futurator-repos/futurator-core.git HEAD` succeeds without prompting.
6. The PAT value is never echoed to logs (use `set +x` around the config commands).

**Touch points:**

- `daemon/scripts/configure-git-identity.sh` (new)
- `daemon/agent-daemon.mjs` (call the script at startup)

**Tasks:**

- [ ] Write `configure-git-identity.sh`
- [ ] Add the SSM read (`aws ssm get-parameter --name … --with-decryption`)
- [ ] Wire the call into daemon startup (one-shot, before main poll loop)
- [ ] Smoke-test ls-remote against an existing futurator-repos repo
- [ ] Verify logs don't leak the token

---

### Epic 1.2 — GitHub connector + API routes 🔌

**Goal:** Port and extend the Mycelium GitHub connector pattern into Futurator-Admin's Hono API. Rate-limit-aware, error-typed, no Octokit.
**Dependency:** Epic 1.1.

#### Story 1.2.1 — `functions/shared/github/connector.ts` — base + status

`pv2-p1-2-1-github-connector-base-and-status` · **M** · backlog

**Acceptance Criteria:**

1. `connector.ts` exports `githubFetch<T>(path, init?)` that prepends `https://api.github.com`, sets `Accept`, `Authorization: Bearer ${pat}`, `User-Agent: Futurator-Admin-GitHub/1.0`, parses JSON, returns `{ data: T, rateLimit: { limit, remaining, reset } }`.
2. Reads token via `Resource.GithubPat.value` with `process.env.GITHUB_PAT` fallback (per Story 1.1.2).
3. Exports a `GitHubError` class with `message`, `status`, `rateLimit?` fields. Thrown on any non-2xx response.
4. Exports `getUser()` returning `{ login, id, name?, email? }` and `checkConnection()` returning `{ connected: boolean, login?, error?, rateLimit? }`.
5. No Octokit dep. No Next.js imports. Pure module — testable with mocked `fetch`.
6. Vitest mock-fetch coverage: success path, 401, 403 (rate-limit branch), 404, 500 each yield the right typed result.

**Touch points:**

- `functions/shared/github/connector.ts` (new)
- `functions/shared/github/types.ts` (new — `GitHubError`, `RateLimit`, response shapes)
- `functions/shared/__tests__/github-connector.test.ts` (new)

**Tasks:**

- [ ] Define `GitHubError` and shared types
- [ ] Implement `githubFetch` with header construction + rate-limit capture
- [ ] Implement `getUser` and `checkConnection`
- [ ] Mock-fetch tests covering 4 error classes + success
- [ ] Lint/typecheck clean

---

#### Story 1.2.2 — Read surface: `listRepos`, `getRepo`, `getRepoTree`, `getFileContent`

`pv2-p1-2-2-github-connector-read-surface` · **M** · backlog

**Acceptance Criteria:**

1. `listRepos(opts?)` calls `GET /orgs/futurator-repos/repos?per_page=100` with auto-pagination, returning the full list (default sort = `pushed`).
2. `getRepo(owner, name)` returns the repo object including `default_branch`.
3. `getRepoTree(owner, name, branch?)` calls `GET /repos/{o}/{r}/git/trees/{b}?recursive=1`. If response `truncated=true`, returns `{ tree, truncated: true, count: <max-1000> }`. Default branch resolves via `getRepo` if `branch` omitted.
4. `getFileContent(owner, name, path, ref?)` returns `{ content: string, encoding: 'utf-8' | 'base64', sha, size }`. Files >1MB return `{ tooLarge: true, size }` instead of content.
5. All four functions surface rate-limit headers via the `githubFetch` envelope.
6. Vitest covers happy path + 404 (repo not found) + truncation + too-large file.

**Touch points:** `functions/shared/github/connector.ts` (extend); same test file as 1.2.1.

**Tasks:**

- [ ] Implement `listRepos` with pagination loop
- [ ] Implement `getRepo`, `getRepoTree`, `getFileContent`
- [ ] Truncation handling for tree responses
- [ ] Size guard for file content
- [ ] Test coverage

---

#### Story 1.2.3 — Write surface: `createRepoFromTemplate`

`pv2-p1-2-3-github-connector-create-from-template` · **M** · backlog

**Acceptance Criteria:**

1. `createRepoFromTemplate(templateOwner, templateRepo, newRepoName, opts?)` calls `POST /repos/{templateOwner}/{templateRepo}/generate` with body `{ owner: 'futurator-repos', name: newRepoName, private: true, include_all_branches: false }`.
2. Returns the full new repo object including `default_branch` and `clone_url`.
3. On 422 "Name already exists", returns a typed result `{ existing: true, repo }` instead of throwing — saga step uses this for idempotency.
4. On any other non-2xx, throws `GitHubError`.
5. Vitest covers: success, 422 (existing) → `existing: true`, 401/403/404/500 → throws.

**Touch points:** `functions/shared/github/connector.ts` (extend); same test file.

**Tasks:**

- [ ] Implement `createRepoFromTemplate`
- [ ] 422-existing branch returns typed result
- [ ] Test coverage incl. idempotency case

---

#### Story 1.2.4 — Hono routes under `/api/github/*`

`pv2-p1-2-4-github-hono-routes` · **M** · backlog

**Acceptance Criteria:**

1. `GET /api/github/status` → `{ connected, login?, rateLimit?, error? }`. 200 if connected, 503 otherwise. Public route allowed (no auth) so the Settings page can ping it.
2. `GET /api/github/repos` → list of repos in `futurator-repos`. Auth-required.
3. `GET /api/github/repos/:owner/:name` → single repo. Auth-required.
4. `GET /api/github/repos/:owner/:name/tree?branch=<>` → tree. Auth-required.
5. `GET /api/github/repos/:owner/:name/files?path=<>&ref=<>` → file content. Auth-required.
6. `POST /api/github/repos` body `{ templateType: BoilerplateType, name: string }` → calls `createRepoFromTemplate`. Auth-required. Validates `name` matches `^[a-z][a-z0-9-]{1,39}$`. Returns 409 on existing.
7. All routes translate `GitHubError(status)` → matching HTTP status; rate-limit headers passed through in JSON body.
8. Smoke test from `npm run dev`: hitting `/api/github/status` after Story 1.1.2 returns connected.

**Touch points:**

- `functions/api/index.ts` (extend with route group)
- `functions/api/__tests__/github-routes.test.ts` (new)

**Tasks:**

- [ ] Add the route group under existing Hono app
- [ ] Implement each route as thin pass-through to connector
- [ ] Error translation middleware for `GitHubError`
- [ ] Slug validation on create
- [ ] Tests covering each route + auth gating

---

### Epic 1.3 — Boilerplate template repos in `futurator-repos` 📦

**Goal:** Three real GitHub template repos in the org, one fully populated, three real-but-empty. The Boilerplate Registry is the single source of truth.
**Dependency:** Epic 1.1.

#### Story 1.3.1 — Create `template-nextjs` with full Next.js 16 + BMAD content

`pv2-p1-3-1-template-nextjs-full-content` · **M** · backlog

**Acceptance Criteria:**

1. Repo `futurator-repos/template-nextjs` exists, marked as a GitHub template (`is_template: true`).
2. Contents: `package.json` (Next.js 16, React 19, Tailwind 4, Geist, Vitest), `app/page.tsx` (placeholder home), `app/layout.tsx`, `tailwind.config.ts`, `tsconfig.json`, `.gitignore`, `README.md` with `__APP_DISPLAY_NAME__` placeholder, `CLAUDE.md` skeleton with `__APP_SLUG__` and `__APP_DISPLAY_NAME__` placeholders, `.claude/skills.manifest.yaml` (empty `{ skills: [] }`), `.github/workflows/pipeline-stub.yml` (lint + build job).
3. BMAD pre-seeded: `bmad/` directory at repo root with the same agent-manifest.csv structure as Futurator-Admin uses (so `*party-mode` etc. work in a freshly-cloned app from day one).
4. Smoke gate: `gh repo create new-test-app --template futurator-repos/template-nextjs --private` followed by clone + `npm install` + `npm run build` succeeds locally. Repo is then deleted.
5. README documents the placeholder substitution scheme so a human reading the template knows how `__APP_SLUG__` is filled.

**Touch points:** real GitHub repo `futurator-repos/template-nextjs` (out-of-repo).

**Tasks:**

- [ ] Generate the Next.js scaffold locally (`npx create-next-app@latest --typescript --tailwind --app`)
- [ ] Add CLAUDE.md skeleton with placeholders
- [ ] Add empty skills manifest and pipeline-stub workflow
- [ ] Vendor in BMAD scaffold (copy from this admin repo's `bmad/` minus per-project overrides)
- [ ] Push to `futurator-repos/template-nextjs`, set `is_template: true` in repo settings
- [ ] Smoke-test create-from-template → install → build

---

#### Story 1.3.2 — Create stubs `template-sst`, `template-vite`, `template-mobile`

`pv2-p1-3-2-stub-template-repos` · **S** · backlog

**Acceptance Criteria:**

1. Three repos exist under `futurator-repos/`: `template-sst`, `template-vite`, `template-mobile`. All marked `is_template: true`.
2. Each contains: `README.md` saying "Wiring lands in Phase X — see `docs/concepts/pipeline-v2/epics-pipeline-v2-phase-1.md`", `CLAUDE.md` skeleton with placeholders (same schema as Story 1.3.1), `.claude/skills.manifest.yaml` empty, `.gitignore`.
3. `template-sst.README` says "Phase 2"; `template-vite.README` says "Phase 2"; `template-mobile.README` says "Phase 3".
4. Smoke gate: `createRepoFromTemplate` successfully spawns a new repo from each stub.

**Touch points:** three real GitHub repos (out-of-repo).

**Tasks:**

- [ ] Create three repos via `gh repo create` with the README copy above
- [ ] Mark each as a template
- [ ] Smoke-test create-from-each-stub via the API once Story 1.2.3 lands (joint test)

---

#### Story 1.3.3 — `BoilerplateType` registry + post-create steps

`pv2-p1-3-3-boilerplate-registry` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/boilerplates/registry.ts` exports `BoilerplateType = 'nextjs' | 'sst' | 'vite' | 'mobile'` and `BOILERPLATE_REGISTRY: Record<BoilerplateType, BoilerplateMetadata>`.
2. `BoilerplateMetadata` matches §5.1 schema exactly: `type`, `displayName`, `icon`, `templateRepo`, `status`, `defaultStack`, `postCreateSteps`, `bmadSupported`, optional Phase-2/3 fields (`defaultDeployFlavor`, `defaultManifestSeed`, `defaultSkillLoadout`).
3. `nextjs.status === 'wired'`, all others `'stub'`. `nextjs.bmadSupported === true`, others `false`.
4. `nextjs.postCreateSteps` declares the four ordered steps (`inject-app-values`, `npm-install`, `bmad-bootstrap`, `commit-and-push`); stubs declare just `inject-app-values` + `commit-and-push`.
5. `getBoilerplateMetadata(type)` returns the metadata or throws `Error('unknown type')`.
6. Vitest covers: every type has all required fields (compile-time exhaustiveness via TS), `'wired'` types have non-empty `postCreateSteps`, `bmadSupported` is true only when BMAD step is in postCreateSteps.

**Touch points:**

- `functions/shared/boilerplates/registry.ts` (new)
- `functions/shared/boilerplates/types.ts` (new — `BoilerplateMetadata`, `PostCreateStep`)
- `functions/shared/boilerplates/__tests__/registry.test.ts` (new — Gate G-2)

**Tasks:**

- [ ] Define types in `types.ts`
- [ ] Populate registry per §5
- [ ] Exhaustiveness test (`Record<BoilerplateType, …>` already enforces compile-time)
- [ ] Runtime tests for `'wired'` invariants

---

### Epic 1.4 — App-bootstrap saga + extended `+ New App` modal 🛠️

**Goal:** End-to-end click → repo created → cloned → scaffolded → BMAD installed → DDB row → App detail loads. Single transactional saga, idempotent sub-steps.
**Dependency:** Epics 1.1, 1.2, 1.3.

#### Story 1.4.1 — Extend `+ New App` modal with type selector + BMAD toggle

`pv2-p1-4-1-extended-new-app-modal` · **M** · backlog

**Acceptance Criteria:**

1. The existing modal at `src/components/labs/apps/new-app-modal.tsx` adds a "Boilerplate" radio group reading from the registry (Story 1.3.3 client-side view).
2. Wired types (`nextjs`) are clickable; stub types (`sst`, `vite`, `mobile`) are clickable but show a "Phase X — scaffold pending" badge under the option.
3. A "BMAD pre-installed" toggle appears only when the selected type's `bmadSupported === true` — defaults ON for `nextjs`.
4. Slug field validates on every keystroke against `^[a-z][a-z0-9-]{1,39}$`. Invalid → red border + helper text + submit disabled.
5. On submit, the modal POSTs `{ appId, displayName, boilerplateType, bmadEnabled }` to the new App-create route (Story 1.4.2). Loading state visible. On success, navigates to `/labs?appId=<slug>`. On 409 ("repo exists"), shows an inline error with "Pick a different name" suggestion (no automatic adopt — that's a Phase-2 enhancement).
6. Existing modal Playwright/manual smoke test still passes.

**Touch points:**

- `src/components/labs/apps/new-app-modal.tsx` (extend)
- `src/hooks/use-create-app.ts` (extend — new payload fields)
- `src/components/labs/boilerplate-picker.tsx` (new)

**Tasks:**

- [ ] Build `boilerplate-picker.tsx` reading from a slim client-side view of the registry
- [ ] Wire into the modal
- [ ] Add BMAD toggle conditional on type
- [ ] Slug regex validation
- [ ] 409 inline error handling
- [ ] Manual smoke through UI

---

#### Story 1.4.2 — Extend `POST /api/apps` — saga steps 1+2 (validate + create repo)

`pv2-p1-4-2-app-create-saga-validate-and-create-repo` · **M** · backlog

**Acceptance Criteria:**

1. `POST /api/apps` accepts new fields `boilerplateType`, `bmadEnabled` (Zod `.safeParse` via `app-create-schema`).
2. Step 1 validates: slug regex, slug not in DDB Apps, slug not at `github.com/futurator-repos/<slug>` (404 = available, 200 = taken → 409).
3. Step 2 calls `createRepoFromTemplate` from Story 1.2.3 with `templateRepo` from the registry. On `existing: true`, returns 409 with `{ error: 'repo-exists', suggestion: '<slug>-2' }`.
4. On step 2 success, the API does **not** yet write the DDB row — that's atomic with the daemon-job enqueue in Story 1.4.4.
5. The repo URL + default-branch SHA are returned to the next saga step in-process (no DDB intermediate).
6. Vitest mocks the connector: validates 4 paths (slug invalid, slug taken in DDB, slug taken on GitHub, success).

**Touch points:**

- `functions/api/index.ts` (extend `POST /api/apps`)
- `functions/shared/schemas/app-create-schema.ts` (new — Zod)
- `functions/api/__tests__/app-create-route.test.ts` (extend)

**Tasks:**

- [ ] Add Zod schema with new fields
- [ ] Implement slug validation against DDB + GitHub
- [ ] Call `createRepoFromTemplate` with registry lookup
- [ ] Wire 409 response paths
- [ ] Tests for each branch

---

#### Story 1.4.3 — Daemon pipeline `app-bootstrap.mjs` (saga steps 3–5)

`pv2-p1-4-3-daemon-app-bootstrap-pipeline` · **L** · backlog

**Acceptance Criteria:**

1. `daemon/pipelines/app-bootstrap.mjs` exports a default pipeline definition matching the existing `party-bootstrap.mjs` shape (steps array with idempotent runners).
2. Step `bare-clone`: if `/home/ubuntu/repos/<slug>.git` doesn't exist, runs `git clone --bare https://github.com/futurator-repos/<slug>.git /home/ubuntu/repos/<slug>.git`. If exists, no-op.
3. Step `materialize-worktree`: if `/home/ubuntu/projects/<slug>` doesn't exist, runs `git -C /home/ubuntu/repos/<slug>.git worktree add /home/ubuntu/projects/<slug> main`. If exists and is a git worktree of the right repo, no-op.
4. Step `inject-values`: in the worktree, replaces `__APP_SLUG__` and `__APP_DISPLAY_NAME__` placeholders in `package.json`, `README.md`, `CLAUDE.md` (only — list is from `registry.postCreateSteps[0].targetFiles`). Idempotent: if no placeholders found, no-op.
5. Step `npm-install` (only when type's stack runtime is node): runs `npm install`. Skipped on stub types.
6. Step `bmad-bootstrap` (only when `bmadEnabled: true` and type supports BMAD): invokes the existing party-bootstrap logic but pointed at the new worktree. Idempotent.
7. Step `commit-and-push`: if there are staged changes, commits "chore: post-create scaffold (`__APP_SLUG__` → <slug>)" and pushes to `main`. If no changes, no-op (already-bootstrapped re-run).
8. On any step failure: writes a `pv2-app-bootstrap-failed` attention item with category, slug, step name, error message, and concrete recovery action ("Re-run bootstrap" / "Mark App failed and delete" buttons).
9. On success: updates `App.workingTreeStatus = 'clean'`, sets `App.bootstrappedAt = now`, terminal job status COMPLETED.
10. Re-running the entire pipeline against an already-bootstrapped App is a clean no-op (CI test, gate G-6).

**Touch points:**

- `daemon/pipelines/app-bootstrap.mjs` (new — model on `daemon/pipelines/party-bootstrap.mjs`)
- `daemon/lib/app-bootstrap-steps/` (new — one file per step for testability)
- `daemon/__tests__/app-bootstrap-idempotency.test.mjs` (new — Gate G-6)

**Tasks:**

- [ ] Read `party-bootstrap.mjs` to mirror shape
- [ ] Implement each of 6 steps as idempotent runner
- [ ] Wire failure → attention item write
- [ ] Wire success → App row update
- [ ] Idempotency test (run twice, verify second run is no-op)

---

#### Story 1.4.4 — Atomic App row + bootstrap job enqueue

`pv2-p1-4-4-atomic-app-and-job-write` · **M** · backlog

**Acceptance Criteria:**

1. After Story 1.4.2 step 2 success, the API writes the App row (`apps` table) + the `app-bootstrap` job row (`agent-jobs` table) in a single `TransactWriteCommand`.
2. App row carries: `appId`, `displayName`, `boilerplateType`, `bmadEnabled`, `workingDir = /home/ubuntu/projects/<slug>`, `currentlyDeployedPlanId: null`, `deployJobIds: []`, `workingTreeStatus: 'clean'` (will flip if bootstrap fails), `executionMode: 'pipeline'` (default), `derivedStatus: 'building'`.
3. Job row carries: `jobId`, `kind: 'app-bootstrap'`, `status: 'PENDING'`, `payload: { appId, boilerplateType, bmadEnabled }`.
4. If the transaction fails (capacity, conditional check), the route returns 500 and **rolls back the GitHub repo** by deleting it (`DELETE /repos/futurator-repos/<slug>` via connector — gate G-7). The roll-back is best-effort logged; on roll-back failure, an `info`-severity attention item flags an orphaned GitHub repo.
5. On transaction success, returns 201 with `{ appId, jobId }` and the UI navigates to App detail. App detail shows a "Provisioning" pill until daemon flips status.
6. Saga rollback test (Gate G-7) covers the failed-DDB-after-repo-creation case.

**Touch points:**

- `functions/api/index.ts` (transaction logic in `POST /api/apps`)
- `functions/shared/repositories/app-repository.ts` (`createAppAndBootstrapJob` helper)
- `functions/shared/github/connector.ts` (add `deleteRepo` for rollback)
- `functions/api/__tests__/app-saga-rollback.test.ts` (new — Gate G-7)

**Tasks:**

- [ ] Add `deleteRepo(owner, name)` to connector
- [ ] Build `createAppAndBootstrapJob` repo helper using `TransactWriteCommand`
- [ ] Wire rollback into the route's catch block
- [ ] Saga-rollback test (mocked DDB failure)
- [ ] Manual smoke: create one App end-to-end, watch the row + job appear

---

### Epic 1.5 — App detail Repository badge + Source tab 📂

**Goal:** Operator sees the GitHub link and can browse repo files without leaving admin.futurator.ai.
**Dependency:** Epic 1.2.

#### Story 1.5.1 — Repository badge in App detail header

`pv2-p1-5-1-app-detail-repository-badge` · **S** · backlog

**Acceptance Criteria:**

1. New component `repository-badge.tsx` renders in the App detail header (next to existing `app-detail-header.tsx` controls).
2. Shows: GitHub icon, `futurator-repos/<slug>` (linkified), default branch name in chip, last commit short-SHA + message preview (first 60 chars).
3. Click opens `https://github.com/futurator-repos/<slug>` in a new tab.
4. Data sourced via `useGithubRepoSummary(slug)` hook — TanStack Query, 5-min staleTime, refetches on App detail mount.
5. Loading state: skeleton chip. Error state: warning icon + "GitHub unreachable" tooltip.
6. Hidden if App has `boilerplateType: 'stub'` and bootstrap hasn't completed yet (no point linking to an empty repo until scaffold lands).

**Touch points:**

- `src/components/labs/app-detail/repository-badge.tsx` (new)
- `src/components/labs/app-detail/app-detail-header.tsx` (mount the badge)
- `src/hooks/use-github-repo-summary.ts` (new)

**Tasks:**

- [ ] Build the hook
- [ ] Build the badge component
- [ ] Mount in header
- [ ] Loading/error states
- [ ] Manual smoke

---

#### Story 1.5.2 — Source tab — tree view + file content reader

`pv2-p1-5-2-app-detail-source-tab` · **M** · backlog

**Acceptance Criteria:**

1. New tab "Source" added to App detail (alongside existing tabs).
2. Left pane: collapsible tree from `getRepoTree`, scrollable, shows files + dirs with sensible icons.
3. Right pane: file content from `getFileContent` of the selected node. Syntax highlighting via existing project utility (Monaco or Prism — match what `src/components/development/file-explorer.tsx` already uses).
4. Files >1MB show "Too large to preview" placeholder with link to GitHub.
5. Breadcrumbs above the right pane reflect the current path.
6. Footer chip: rate-limit remaining (`X / 5000 — resets at HH:MM`).
7. Read-only — no edit affordance. Phase 1 explicitly does not write back to GitHub from the UI.
8. Hidden when bootstrap hasn't completed.

**Touch points:**

- `src/components/labs/app-detail/source-tab.tsx` (new)
- `src/hooks/use-github-tree.ts` (new)
- `src/hooks/use-github-file.ts` (new)
- `src/components/labs/app-detail/app-detail-view.tsx` (add tab)

**Tasks:**

- [ ] Build the two hooks
- [ ] Build tree component (collapsible)
- [ ] Build file-content viewer (reuse existing syntax highlighter)
- [ ] Wire tab into App detail
- [ ] Rate-limit footer
- [ ] Manual smoke

---

### Epic 1.6 — Pipeline v2 Roadmap strip + `/labs/roadmap` page 🗺️

**Goal:** Big-picture v2 visibility on every App detail.
**Dependency:** none — fully parallel to GitHub work.

#### Story 1.6.1 — Roadmap strip component (collapsible)

`pv2-p1-6-1-v2-roadmap-strip` · **M** · backlog

**Acceptance Criteria:**

1. New component `v2-roadmap-strip.tsx`. Collapsed by default (one row, ~40px). Expands on click.
2. Three pills: Phase 1 (active), Phase 2 (pending), Phase 3 (pending). Active pill shows progress bar with %-complete derived from `Phase 1 stories done / Phase 1 total stories` (read from sprint-status snapshot or hardcoded for v1).
3. Expanded view shows one short paragraph per phase + "Read full roadmap →" link to `/labs/roadmap`.
4. Mounted in `app-detail-view.tsx` above the Plans timeline.
5. Persists expand/collapse state in localStorage (key `v2-roadmap-collapsed`).
6. A11y: keyboard expand/collapse via Enter/Space, ARIA-expanded attribute.

**Touch points:**

- `src/components/labs/app-detail/v2-roadmap-strip.tsx` (new)
- `src/components/labs/app-detail/app-detail-view.tsx` (mount)
- `src/lib/v2-phase-data.ts` (new — phase metadata, deferrals, ship gates)

**Tasks:**

- [ ] Build the component
- [ ] Collapse/expand logic + localStorage
- [ ] Phase metadata file
- [ ] Mount in App detail
- [ ] Style pass to match existing pill aesthetic
- [ ] A11y verification

---

#### Story 1.6.2 — `/labs/roadmap` full v2 page

`pv2-p1-6-2-labs-roadmap-page` · **M** · backlog

**Acceptance Criteria:**

1. New route `/labs/roadmap` (page.tsx). Uses existing AuthGuard + AppShell.
2. Renders three sections (Phase 1, 2, 3) sourced from `v2-phase-data.ts` (Story 1.6.1).
3. Each section shows: epic list with effort + status, ship gate, key deferrals, link to the consolidated v2.5 doc anchor for that part.
4. Deep-linkable anchors: `/labs/roadmap#phase-1`, `#phase-2`, `#phase-3`.
5. Markdown rendering for narrative sections (reuse existing markdown component if present, otherwise use `react-markdown`).
6. Mobile-responsive (this admin runs on laptops mostly, but no explicit mobile-broken layout).

**Touch points:**

- `src/app/labs/roadmap/page.tsx` (new)
- `src/components/labs/roadmap/phase-section.tsx` (new)
- `src/lib/v2-phase-data.ts` (extend — narrative + deferrals)

**Tasks:**

- [ ] Build phase-section component
- [ ] Wire route + AppShell
- [ ] Anchor links
- [ ] Manual smoke through UI

---

### Epic 1.7 — Settings → GitHub panel ⚙️

**Goal:** One place to see and rotate the PAT.
**Dependency:** Epic 1.1.

#### Story 1.7.1 — Settings GitHub panel

`pv2-p1-7-1-settings-github-panel` · **M** · backlog

**Acceptance Criteria:**

1. New page at `/settings/github` (or section under existing settings, whichever the project's settings shell expects).
2. Shows current connection: ✓ Connected as `<login>` to `futurator-repos`. Shows rate limit (X/5000 remaining, resets at HH:MM) — green if remaining > 1000, amber if 500–1000, red if <500.
3. Shows last-rotation timestamp (read from a new SSM parameter `/futurator/_pipeline/github-pat-rotated-at` set by 1.7.x's rotate flow).
4. "Rotate PAT" form: token textarea + "Rotate" button. POSTs to `PUT /api/github/pat` with `{ pat: <value> }`. Server-side: validates via `getUser()` round-trip, on success writes both the secret and the rotation timestamp to SSM, returns 200. On failure returns 422 with the GitHub error.
5. After successful rotation: page refreshes connection status, shows toast "PAT rotated successfully".
6. PAT-age attention item: a daily cron checks the rotation timestamp; if >80 days, writes an `info`-severity item "GitHub PAT due for rotation (last rotated YYYY-MM-DD)". If >100 days, escalates to `medium`. Rotation clears any existing item.

**Touch points:**

- `src/app/settings/github/page.tsx` (new — or extend existing settings page)
- `functions/api/index.ts` (extend with `PUT /api/github/pat`)
- `functions/cron/pat-age-check.ts` (new)
- `sst.config.ts` (add cron schedule)

**Tasks:**

- [ ] Build the settings page UI
- [ ] Add `PUT /api/github/pat` route with validation round-trip
- [ ] Build the cron Lambda
- [ ] Wire cron schedule in SST config
- [ ] Manual smoke through UI

---

### Epic 1.8 — Timer Intelligence module ⏱️

**Goal:** MECE time accounting per plan, real-time UI, cohort baselines, 3× escalator, forensic export.
**Dependency:** none on GitHub work — fully parallel to Epics 1.1–1.7. Consumes existing `AgentEvent` stream.

#### Story 1.8.1 — Pure classifier `(event) → category`

`pv2-p1-8-1-timer-classifier` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/timer/classifier.ts` exports `classify(event: AgentEvent, jobContext: JobContext): TimerCategory` where `TimerCategory` is the 15-value union from §6 (`dev`, `test-author`, `test-execute`, `review`, `qa`, `po`, `architect`, `compile`, `human-wait`, `machine-wait`, `git`, `bootstrap`, `fix`, `idle`, `unattributed`).
2. The classification table in `categories.ts` maps every value of `AgentEventType` (currently 30+ enum values) under every relevant agent role to exactly one category.
3. `JobContext` carries `{ jobKind, agentRole, jobStatus, retryCount }` — the classifier needs all four for some events (e.g. `tool_use` + `agentRole=reviewer` → `review`; same event + `agentRole=dev` → `dev`).
4. `unattributed` is a real category that catches anything the table misses — Gate G-4 asserts this stays empty across a sample plan.
5. TypeScript compile-time exhaustiveness via `assertNever`-pattern on `AgentEventType` switch (G-5: adding a new event type without updating classifier fails the build).
6. Vitest matrix: at least 50 test rows covering each category at least 3×, including edge cases (RUNNING + tool_use, NEEDS_ATTENTION → COMPLETED_VIA_SALVAGE timing, fix-loop detection via `retryCount > 0`).

**Touch points:**

- `functions/shared/timer/classifier.ts` (new)
- `functions/shared/timer/categories.ts` (new — the table + `TimerCategory` type)
- `functions/shared/timer/types.ts` (new — `JobContext`, `TimerSlice`)
- `functions/shared/timer/__tests__/classifier-coverage.test.ts` (new — Gate G-5)

**Tasks:**

- [ ] Define `TimerCategory` and `JobContext` types
- [ ] Build the classification table (one entry per event-type × agent-role tuple)
- [ ] Implement `classify` with exhaustiveness check
- [ ] Test matrix (50+ rows)

---

#### Story 1.8.2 — Slicer: events → time slices for a plan

`pv2-p1-8-2-timer-slicer` · **M** · backlog

**Acceptance Criteria:**

1. `functions/shared/timer/slicer.ts` exports `sliceForPlan(planId): Promise<TimerSlice[]>` and `sliceForJob(jobId): Promise<TimerSlice[]>`.
2. Reads events from `agent-events-repository.queryByJob` (existing). For plans: discovers all jobs across the plan's epics/stories, queries events per job, merges by timestamp.
3. Sorts merged events by `(timestamp, seq)`. For each event, computes `duration = next.timestamp - this.timestamp`. Last event in a non-terminal plan closes at `Date.now()`; in a terminal plan, closes at the plan's `endedAt` (or last terminal job's `endedAt`).
4. Emits one `TimerSlice` per event: `{ jobId, eventSeq, category, startedAt, endedAt, durationMs, agentRole, eventType }`.
5. Aggregator helper `aggregateByCategory(slices): Record<TimerCategory, { totalMs, count }>` returns the sum per bucket plus the overall total.
6. Gate G-4 (MECE): for any completed plan, `Σ slice.durationMs ≡ plan.endedAt - plan.startedAt` ± 1000ms. Test loads a recorded fixture plan event stream and asserts the equality.

**Touch points:**

- `functions/shared/timer/slicer.ts` (new)
- `functions/shared/timer/aggregator.ts` (new)
- `functions/shared/timer/__tests__/slicer-mece.test.ts` (new — Gate G-4)
- `functions/shared/timer/__tests__/fixtures/plan-fixture-1.json` (new — captured real event stream)

**Tasks:**

- [ ] Capture a real event-stream fixture from a recent plan run
- [ ] Implement `sliceForPlan` (multi-job merge)
- [ ] Implement `sliceForJob`
- [ ] Implement `aggregateByCategory`
- [ ] MECE test against fixture

---

#### Story 1.8.3 — API endpoints for timing

`pv2-p1-8-3-timer-api-endpoints` · **M** · backlog

**Acceptance Criteria:**

1. `GET /api/plans/:planId/timing` returns `{ slices: TimerSlice[], aggregate, planTotal, isLive }`. Live plans include `isLive: true`.
2. `GET /api/apps/:appId/timing` returns the rolling history: `{ recentPlans: PlanTimingSummary[], appAggregate }`. `recentPlans` covers the last 20 plans on this app.
3. `GET /api/timing/cohort?templateType=<>&planKind=<>&epicCount=<>` returns `{ samples, median, p90, byCategory: Record<TimerCategory, { median, p90 }> }`. Reads from `TimingSummary` table (Story 1.8.6). Returns 404 if cohort N<5.
4. `GET /api/plans/:planId/timing/forensic` returns `{ schemaVersion: 'timer-intel-v1.0', plan, events, slices, aggregate, cohort?, narrative }` as a downloadable JSON. `narrative` is a 5-sentence summary auto-generated from the data ("This plan ran 12m32s. Largest category: dev (38%). Outlier vs cohort: review at 2.1× median…").
5. All four are auth-required.
6. Tests: smoke each route returns the expected shape.

**Touch points:**

- `functions/api/index.ts` (extend with 4 routes)
- `functions/shared/timer/forensic-builder.ts` (new — JSON shape + narrative generator)
- `functions/api/__tests__/timing-routes.test.ts` (new)

**Tasks:**

- [ ] Implement each route
- [ ] Build forensic JSON assembler
- [ ] Build narrative generator (template-based, not LLM — Phase 2 can swap for LLM)
- [ ] Tests

---

#### Story 1.8.4 — Plan dashboard "Timing" panel

`pv2-p1-8-4-plan-dashboard-timing-panel` · **M** · backlog

**Acceptance Criteria:**

1. New component `timing-panel.tsx` in `src/components/labs/plan-dashboard/`.
2. Renders: stacked horizontal bar (one segment per category, color-coded), total elapsed (mm:ss or hh:mm:ss), legend with per-category percentages.
3. While plan is RUNNING: refetches every 5s using `useQuery` with `refetchInterval`. Uses `If-Modified-Since` keyed off the latest event's seq number for cheap polling.
4. Expandable: click reveals per-story breakdown (stacked bar per story).
5. "Export forensic JSON" button (triggers Story 1.8.7's behavior).
6. Color palette is colorblind-friendly (test against deuteranopia simulation).
7. A11y: each segment has a label, the bar itself has role=img with descriptive aria-label.

**Touch points:**

- `src/components/labs/plan-dashboard/timing-panel.tsx` (new)
- `src/hooks/use-plan-timing.ts` (new)
- `src/lib/timer-colors.ts` (new — palette + accessibility check)

**Tasks:**

- [ ] Build the hook with `If-Modified-Since` cache key
- [ ] Build stacked-bar component
- [ ] Per-story expansion
- [ ] Forensic-export button (wires Story 1.8.7)
- [ ] A11y verification
- [ ] Manual smoke against a running plan

---

#### Story 1.8.5 — App detail Performance badge + Performance tab

`pv2-p1-8-5-app-performance-badge-and-tab` · **M** · backlog

**Acceptance Criteria:**

1. Header badge `performance-badge.tsx` shows `<median plan duration>` for this App + a delta vs cohort median ("1.4× cohort"). Hidden if App has <2 completed plans.
2. New tab "Performance" on App detail. Lists every completed plan with: timestamp, duration, category breakdown bar (mini), cohort comparator chip.
3. Statistical drift markers: when this App's most-recent 5 plans show a category whose median has shifted ≥1 SD from the prior 5 plans, surface a yellow caret on that category in the most recent plan's row + a tooltip explaining the drift.
4. Sortable by date / duration / each category.
5. Empty state when 0 completed plans: "Run a plan to see performance data".

**Touch points:**

- `src/components/labs/app-detail/performance-badge.tsx` (new)
- `src/components/labs/app-detail/performance-tab.tsx` (new)
- `src/hooks/use-app-timing.ts` (new)
- `src/components/labs/app-detail/app-detail-view.tsx` (mount badge + tab)

**Tasks:**

- [ ] Build the hook
- [ ] Build the badge
- [ ] Build the tab with table + mini bars
- [ ] Drift-detection compute (rolling-window median delta in SD)
- [ ] Empty state
- [ ] Manual smoke

---

#### Story 1.8.6 — Cohort aggregation cron + `TimingSummary` table

`pv2-p1-8-6-cohort-aggregation-cron` · **M** · backlog

**Acceptance Criteria:**

1. New DDB table `TimingSummary` defined in `sst.config.ts`. PK = `cohortKey` (`<templateType>#<planKind>#<epicCountBucket>`), SK = `lastUpdated`. Carries `samples`, `medianMs`, `p90Ms`, `byCategory`, `lastSampleIds[]` (for traceability). PAY_PER_REQUEST, PITR optional.
2. New cron Lambda `functions/cron/timing-aggregator.ts` runs every 6h.
3. Aggregator queries last 20 completed plans per `(templateType, planKind, epicCountBucket±25%)`, runs `sliceForPlan` for each, computes cohort medians + P90 per category, writes summary.
4. `pipeline-timer-thresholds.ts` config exports `THRESHOLDS = { info: 3.0, medium: 5.0, minSamples: 5 }` — referenced by the escalator (Story 1.8.7).
5. Test: synthetic 6 plans → run aggregator → assert summary row created with right shape.
6. Cron entry in `sst.config.ts` matches the existing pattern from `cost-aggregator`.

**Touch points:**

- `sst.config.ts` (add table + cron)
- `functions/cron/timing-aggregator.ts` (new)
- `functions/shared/repositories/timing-summary-repository.ts` (new)
- `functions/shared/timer/cohort.ts` (new — the aggregation math)
- `functions/shared/timer/pipeline-timer-thresholds.ts` (new)

**Tasks:**

- [ ] Add the table to SST config
- [ ] Build the repository (`get`, `upsert`, `listByCohort`)
- [ ] Build the cron Lambda
- [ ] Wire cron schedule
- [ ] Aggregation math
- [ ] Test against synthetic data

---

#### Story 1.8.7 — 3× escalator + forensic export button

`pv2-p1-8-7-escalator-and-forensic-export` · **S** · backlog

**Acceptance Criteria:**

1. After every plan completes, daemon (or a post-plan Lambda hook) runs `evaluateThresholds(planId)`: queries the cohort summary, slices the plan, computes per-category ratios. If cohort N<5, no-op. Otherwise: any category exceeding `THRESHOLDS.info` (3.0) writes an `info` attention item; exceeding `THRESHOLDS.medium` (5.0) writes a `medium` item.
2. Attention item message: `"Plan <slug>: <category> time <ratio>× cohort median — possible <hint>"` where `hint` is from a small lookup (review→"review may be looping", fix→"DEV is iterating heavily", machine-wait→"AWS step is slow", etc.).
3. The item carries a deep-link `<admin>/labs?planId=<id>#timing` that opens the plan dashboard scrolled to the Timing panel.
4. "Export forensic JSON" button on the Timing panel triggers `GET /api/plans/:id/timing/forensic`, downloads as `<planId>-forensic.json`. File is paste-ready into a chat with another Claude instance.
5. Test: synthetic plan with `review` 4× cohort → escalator writes one `info` item; `review` 6× → writes one `medium` item.

**Touch points:**

- `functions/shared/timer/escalator.ts` (new)
- `daemon/lib/post-plan-hooks.mjs` (new or extend) — runs `evaluateThresholds` after plan terminal
- `src/components/labs/plan-dashboard/timing-panel.tsx` (extend — add download button)
- `functions/shared/timer/__tests__/escalator.test.ts` (new)

**Tasks:**

- [ ] Build the escalator with hint lookup
- [ ] Wire post-plan hook into daemon's plan-terminal write site
- [ ] Build the download-button handler in the timing panel
- [ ] Test

---

## 7. Dependency graph

```
                  Epic 1.1 (Prereq)
                  /     |      \
                 ▼      ▼       ▼
            Epic 1.2  Epic 1.3 Epic 1.7
            (conn)  (templates) (Settings)
                \      /
                 ▼    ▼
                Epic 1.4 ─── Epic 1.5
                (saga)       (Repo+Source)

   ┌─ Epic 1.6 (Roadmap) — fully parallel, no deps
   │
   └─ Epic 1.8 (Timer) — fully parallel, no deps
```

**Critical path:** 1.1 → 1.2 → 1.3 → 1.4 → ship gate. ~9 days serial.

**Parallel work that fills the critical path bubbles:** 1.6 (2 days), 1.7 (1 day), 1.8 (5–6 days), 1.5 (2 days).

A two-track schedule (one track on the critical path, one on parallels) lands
the whole phase in **~12–14 calendar days** assuming no surprises.

---

## 8. Test gates (Murat's non-negotiables)

These are CI-enforced. Phase 1 does not ship without them green.

| Gate                                   | What it asserts                                                                                                                                             | Where it lives                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **G-1** GitHub connector smoke         | Mocked `githubFetch` returns expected shape on success; throws typed `GitHubError` on each error class (401/403-rate-limit/404/5xx)                         | `functions/shared/__tests__/github-connector.test.ts`          |
| **G-2** Boilerplate registry validates | Every `BoilerplateType` declared in registry has all required fields populated; `'wired'` types have non-empty `postCreateSteps`                            | `functions/shared/boilerplates/__tests__/registry.test.ts`     |
| **G-3** PAT-leak audit                 | grep step in `npm run ci` fails build if `GITHUB_PAT`, `ghp_`, or `Resource.GithubPat.value` appears outside `functions/shared/github/` and `sst.config.ts` | `package.json` ci script                                       |
| **G-4** Timer MECE                     | For any completed plan, `Σ slice.duration ≡ plan.endedAt − plan.startedAt ± 1s`. No `unattributed` leak.                                                    | `functions/shared/timer/__tests__/slicer-mece.test.ts`         |
| **G-5** Timer classifier coverage      | Every value of `AgentEventType` (30+ enum values) maps to exactly one category. Compile-time exhaustiveness via TS `never` check + runtime test.            | `functions/shared/timer/__tests__/classifier-coverage.test.ts` |
| **G-6** App-bootstrap idempotency      | Re-running `app-bootstrap` for an already-bootstrapped App is a no-op (no duplicate commits, no double-install of BMAD)                                     | `daemon/__tests__/app-bootstrap-idempotency.test.mjs`          |
| **G-7** Saga rollback                  | Mocked GitHub-create-failure-after-DDB-write → recovery path leaves no orphan App row and surfaces a single attention item                                  | `functions/api/__tests__/app-saga-rollback.test.ts`            |

Manually-tested (no automated gate, smoke through UI):

- Type selector renders all four types with correct visual state.
- Roadmap strip expands and `/labs/roadmap` renders the full doc.
- Forensic JSON export downloads and is paste-ready.

Phase 1 does **not** add Playwright e2e for the GitHub flow. Smoke-test it once
manually; revisit when Phase 2's CI/CD lands and Playwright is already on the
critical path.

---

## 9. Risks and mitigations

| Risk                                                          | Likelihood                            | Mitigation                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAT silently expires mid-plan                                 | Low (no-expiry flag)                  | Mint with no-expiry; PAT-age attention item at 80d (Story 1.7.1)                                                                                   |
| Repo create succeeds, DDB write fails                         | Medium                                | Saga checks repo existence on retry; if found, adopts row instead of recreating                                                                    |
| BMAD bootstrap fails on new repo                              | Medium (existing pipeline has issues) | App is created with `bmad: 'FAILED'` status; operator sees a "Retry BMAD bootstrap" button; the App is not blocked from running plans without BMAD |
| Cohort sample size too small for first 5 plans                | Certain                               | "Cohort baseline accumulating" pill in dock; no escalations fire until N≥5                                                                         |
| Timer classifier mis-categorizes a new event type added later | Likely (in Phase 2)                   | Compile-time exhaustiveness check (G-5); adding a new `AgentEventType` fails the build until classifier is updated                                 |
| Hot-read traffic on AgentEvent table                          | Medium                                | `If-Modified-Since` keyed on max event seq; client-side cache; reconsider streams in Phase 3                                                       |
| `futurator-repos` org rate limit                              | Low (PAT, fine-grained, 5000/h)       | Connector surfaces rate limit in every response; UI shows it in the Settings panel; attention item at <500 remaining                               |

---

## 10. Explicit deferrals to Phase 2 / Phase 3

So future-Ricardo doesn't think these were forgotten:

**Deferred to Phase 2 (Pipeline):**

- Per-story `wip/` worktrees. Phase 1 only materializes the primary worktree.
- Tool allowlists at `claude -p` spawn. Phase 1 daemon spawns without `--allowedTools`.
- The 7 v2.5 plan kinds. Phase 1 keeps the existing 3 (`initial`/`change`/`experiment`).
- ARCHITECT agent and `aws.manifest.yaml`. Phase 1 has no manifest layer.
- GitHub Actions OIDC for keyless deploys. Phase 1 ships only a `lint && build` stub workflow.
- Inbound GitHub webhooks. Phase 1 is outbound-only.
- Per-repo deploy keys (PR-11). Phase 1 reuses the API PAT for daemon git ops.
- Branch protection enforcement (PR-6). Phase 1 sets it as a stub for `production` rigor only.
- Token cost overlay on Timer Intelligence. Designed-in (the `cost` field is captured), but the per-category cost view is Phase 2.

**Deferred to Phase 3 (Compounding):**

- GitHub App migration (PR-2). Phase 1 stays on PAT.
- Skills federation, SKILL-SCOUT, MCP private registry.
- REFLECTOR agent, Reflection Inbox, persona evolution.
- Speculation `explore/` + EVALUATOR.
- Production rigor + 24h soak + drift detection + cost-history.
- Real `template-sst`, `template-vite`, `template-mobile` content. Phase 1 stubs only.
- Mobile boilerplate (Expo + React Native + EAS).

**Permanently deferred (no current phase):**

- Multi-account AWS migration (v2.5 §22). Stays on shared account until a project's compliance demands otherwise.
- Claude Managed Agents (MA) migration (v2.5 §57). Opt-in per project once EU residency is solved.

---

## 11. Operator runbook hooks

Phase 1 introduces three new runbook entries. Add to `docs/runbooks/`:

1. **`pat-rotation.md`** — How to rotate the GitHub PAT. Triggered quarterly or by attention item.
2. **`app-bootstrap-failure-recovery.md`** — How to recover when the App-bootstrap saga half-completes. Three scenarios: GitHub repo created but DDB row missing; both created but BMAD bootstrap failed; everything succeeded but App detail won't load.
3. **`timer-forensic-handoff.md`** — How to use the forensic JSON export to triage a slow plan with another agent. Includes the prompt template that pairs with `schemaVersion: "timer-intel-v1.0"`.

---

## 12. What "done" actually looks like (acceptance demo)

Two minutes of operator time, end-to-end:

1. Open `admin.futurator.ai/labs`.
2. Click **+ New App**, choose **Next.js + BMAD**, type `dino6`, submit.
3. Watch the App card flip from `Provisioning` → `Building` → `clean`.
4. Click into `dino6` — the App detail shows the Repository badge linking to
   `github.com/futurator-repos/dino6`. Open it in a new tab — the repo exists with
   the boilerplate.
5. Click the **Source** tab — browse the file tree, open `CLAUDE.md`, see the
   slug-substituted skeleton.
6. Run a small plan against `dino6`. While it runs, the **Timing** panel shows
   the live stacked bar updating.
7. When the plan completes, the **Performance** badge shows the duration.
8. Click **Export forensic JSON** — receive a paste-ready file.
9. Scroll to the **Pipeline v2 Roadmap** strip — see Phase 1 ✅, Phase 2 ⏳,
   Phase 3 ⏳. Click for the full narrative.

If those nine steps work without intervention or hand-holding, Phase 1 is done.

---

## 13. Sequence next

1. **Sprint planning** — convert this doc into `docs/sprint-status.yaml` epic/story
   entries (existing tracking system at `tracking_system: file-system`).
2. **Story drafting** — Bob's `*create-story` workflow against each story above,
   producing one `.md` per story in `docs/stories/`.
3. **Architecture validation** — Winston reviews Story 1.1.2 (SST `Linkable`)
   and Story 1.4.3 (saga shape) before they're marked `ready-for-dev`.
4. **First wave** — Stories 1.1.1, 1.1.2, 1.1.3 in parallel (no inter-deps),
   plus 1.6.1, 1.6.2 (roadmap, fully independent).

When Phase 1 ships, this doc gets a status flip to `Shipped 2026-MM-DD` and
the equivalent Phase-2 doc takes over.
