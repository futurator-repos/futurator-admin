# Futurator Pipeline — v2.5 Consolidated

> **Status:** consolidated specification.
> **Supersedes:** v2.0 (resilience), v2.1 (rigor + tests), v2.2 (git substrate), v2.3 (skills), v2.4 (deployment & integrations).
> **Scope:** the agent-ruled, human-on-exception pipeline that turns operator intent into deployed software, end-to-end. Spans story execution, git, skills, AWS infrastructure, third-party integrations, and the reflection loop that compounds learning across plans.
> **Audience:** Richie (operator), and Richie-six-months-from-now.
> **Prior versions retained as historical record.** This document is the source of truth going forward.

---

## How to read this document

- **Part I — Foundations** sets vocabulary: hierarchy, agents, rigor dial, plan kinds, attention model. If something later doesn't make sense, it's likely defined here.
- **Parts II–VI** are the operating layers: story pipeline, git substrate, managed-resource pattern (skills + AWS + integrations), AWS deployment specifics, reflection loop.
- **Parts VII–IX** are the operator surface, implementation phases, and worked examples.
- **Appendices** carry the schemas, templates, and the resolution log for every open question that fed this consolidation.

The document is descriptive of the target state. Where current implementation lags the design, the implementation phases (Part VIII) sequence the work.

---

# Part I — Foundations

## 1. The four-level hierarchy

```
Plan ─── Epic ─── Story ─── Step
```

- **Plan.** A run of the dev pipeline against one project, ending in a deliverable on `main`. Plans have kind (feature, bugfix, maintenance, prototype-on-top, hotfix, rigor-upgrade, implementation-spec) and rigor (inherited from project unless the kind overrides). One plan : one project — multi-project plans are not supported (PM agent surfaces a card and offers to split).
- **Epic.** A coherent group of stories within a plan. Epics form a DAG; epic-waves are the parallel-execution batches at the plan level.
- **Story.** The atomic unit of agent work. Stories form a DAG within their epic; story-waves are parallel-execution batches at the epic level.
- **Step.** A single agent or shell action within a story's pipeline. The story pipeline (Part II) is a fixed sequence of steps, with conditional retry loops.

**Wave parallelism is computed, not assigned.** Given the DAG, the daemon batches everything with no unsatisfied dependencies into the next wave. Waves run concurrently; wave-merge is the integration moment (Part III §15).

## 2. The project as the unit of identity

A **project** is one application. One repo. One AWS workload. One brand. Examples in flight: Songster, goMAD, Mycelium, Atlassinator, Applicator, Contento, MBE, IndexForge, Contax, cayambe.de.

A project has:

- A globally unique slug (`[a-z][a-z0-9-]{1,39}`, matches GitHub repo naming).
- One git repo, by default at `futurator/<slug>` on GitHub. (Client projects can declare `repo: <client-org>/<repo-name>` in the project manifest.)
- One AWS workload, by default in the shared Futurator account. (Multi-account future is anticipated; see Part V §22.)
- Three manifests: `.claude/skills.manifest.yaml`, `.deployment/aws.manifest.yaml`, `.deployment/integrations.manifest.yaml`.
- A `CLAUDE.md` at the repo root that's the living narrative document for the project.

A project hosts many plans over its lifetime. Plans come and go; the project persists.

## 3. The agent roster

Fifteen agent roles, each with a fixed model class, fixed tool allowlist, and fixed prompt skeleton. Project-specific behavior comes from skills (Part IV §20) and CLAUDE.md, never from per-project prompt forks.

| Agent                  | Default model                           | Writes?                                         | Role                                                                                                                                                        |
| ---------------------- | --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PM**                 | Sonnet                                  | no (read-only on source; writes plan structure) | Decompose intent into Plan → Epics → Stories. Detect speculation opportunities (§Part III), multi-intent splits, multi-project plans.                       |
| **API-AUTHOR**         | Sonnet                                  | scoped to `<module>/index.d.ts` only            | Emit the frozen module-surface declaration (`.d.ts`) that TEST and DEV both import from. Eliminates contract drift (Part II §17).                           |
| **TEST**               | Haiku                                   | `tests/`, `**/*.test.*`, `e2e/**` only          | Write tests from story acceptance criteria. Tests must fail against current code (red gate).                                                                |
| **DEV**                | Sonnet                                  | source files; `tests/` is denied                | Implement. Tests are the contract.                                                                                                                          |
| **REVIEWER**           | Haiku                                   | none (read-only)                                | Gate DEV's output. AC coverage, code quality, tamper detection.                                                                                             |
| **COMPILER**           | Haiku                                   | wiki + commit metadata                          | After review passes: emit metadata block, update Mycelium wiki, regenerate CDK from manifests when ARCHITECT applied changes.                               |
| **QA**                 | Sonnet                                  | none (read-only)                                | Playwright/visual tests, end-to-end smoke. Production rigor only.                                                                                           |
| **PO**                 | Opus                                    | none (read-only)                                | Acceptance-criteria audit before plan flips to `delivered`. Production rigor only.                                                                          |
| **OPS**                | Haiku                                   | dev-server processes                            | Long-running dev-server lifecycle, log capture for QA.                                                                                                      |
| **HOTFIX**             | Sonnet                                  | full                                            | Hotfix branches against production tags. Skips PO/QA gates by design (speed).                                                                               |
| **ARCHITECT**          | Opus (T1, T3); Sonnet (T2 incremental)  | manifests + commit metadata                     | Resolve plan intent against AWS + integrations manifests. Generate manifest deltas with cost estimate. Never deploys directly — deploys are separate steps. |
| **SKILL-SCOUT**        | Sonnet (Opus when search depth matters) | skill manifest only                             | Resolve plan intent + project stack against skill federation. Propose adds/removes/upgrades.                                                                |
| **EVALUATOR**          | Opus                                    | verdict file only                               | Read two `explore/` branch tips, apply winner-rule, declare winner. Used for both implementation speculation and skill-set speculation.                     |
| **REFLECTOR**          | Sonnet                                  | proposal files in inbox                         | Observe completed work, propose CLAUDE.md edits, skill candidates, persona tweaks, pipeline-config tunings. Never auto-applies.                             |
| **REFLECTOR-REVIEWER** | Haiku (phase-2; not in v2.5 baseline)   | none                                            | Validate REFLECTOR proposals before they hit the inbox. Defense against compromised reflection.                                                             |

**Tool allowlists are enforced at spawn time** via `--allowedTools` / `--disallowedTools` globs to `claude -p`. Read-only roles (REVIEWER, QA, PO, REFLECTOR, EVALUATOR) all get `--disallowedTools "Write,Edit,NotebookEdit,Bash"`. The few read-only Bash needs (`git log`, `ls`) are exposed via per-role MCP wrappers, not raw shell. Prompts decide _what_ to build; tool gates decide _what they're allowed to touch_.

## 4. The rigor dial

Three tiers: **prototype**, **mvp**, **production**. The dial is a single knob that touches every loop. It controls _which gates fire_, not _which gates exist_.

| Concern                            | prototype                                        | mvp (default)                     | production                                           |
| ---------------------------------- | ------------------------------------------------ | --------------------------------- | ---------------------------------------------------- |
| **Story pipeline**                 | TEST + DEV + REVIEWER (skip api-author, skip QA) | full pipeline minus QA Playwright | full pipeline                                        |
| **Test gates**                     | informational                                    | block on red                      | block on red + tamper-check                          |
| **API-AUTHOR step**                | skip                                             | run                               | run                                                  |
| **Baseline regression gate**       | warn only                                        | block                             | block                                                |
| **Tamper-check**                   | off                                              | warn                              | block (second offense → high-severity attention)     |
| **CI required checks**             | lint, typecheck                                  | + unit tests                      | + e2e + build + security audit                       |
| **Branch protection on main**      | basic                                            | required statuses                 | required statuses + required reviews + dismiss stale |
| **`wip/` branches per story**      | optional (direct main commits allowed)           | required                          | required                                             |
| **Worktree isolation**             | optional                                         | required                          | required                                             |
| **PR mode**                        | off (overridable per-plan, see §6.4)             | off (overridable)                 | on                                                   |
| **`stream/` branches**             | recommended                                      | recommended                       | required for any human-driven work                   |
| **`explore/` speculation**         | off                                              | off                               | available                                            |
| **Speculation evaluator**          | off                                              | off                               | EVALUATOR runs                                       |
| **Plan tags**                      | off                                              | on                                | on                                                   |
| **Semver tags**                    | off                                              | on                                | on                                                   |
| **Production deploy gate**         | n/a                                              | minimal (operator confirm)        | full (24h soak + audit + approval)                   |
| **REFLECTOR cadence**              | per-wave + per-plan                              | per-wave + per-plan               | per-story (light) + per-wave + per-plan (full)       |
| **REFLECTOR-REVIEWER**             | off                                              | off                               | on (phase-2)                                         |
| **Skill auto-trust**               | yes (any source)                                 | confirm non-auto-trust sources    | confirm + license review                             |
| **Skill version pin**              | optional                                         | required (tag or SHA)             | SHA only                                             |
| **Auto-distill threshold**         | manual                                           | manual                            | encounters ≥ 3 → auto-spawn skill-creator plan       |
| **Cost-envelope hard cap action**  | warn only                                        | attention item                    | attention item + page operator                       |
| **Drift detection**                | weekly, warn-only                                | weekly, attention item            | weekly, high-severity if production stack            |
| **Layer C (per-plan AWS session)** | off                                              | off                               | on                                                   |

The whole table is encoded in `pipeline-rigor.ts` so all loops query it from one place.

### 4.1 Rigor promotion

Promotion (prototype → mvp → production) is an explicit operator action that triggers an auto-generated **rigor-upgrade plan**. This plan does the backfill work the lower rigor allowed to skip:

- mvp upgrade: backfill tests for existing code (target ≥ 60% line coverage on main paths), add CI workflow, run SKILL-SCOUT brownfield audit, run ARCHITECT brownfield audit, configure dev/staging deploy targets, migrate Secrets Manager paths to project namespace.
- production upgrade: + Playwright e2e covering primary user flows, security audit gate, configure production deploy gate, set up `release/` branch policy, document version policy, audit IAM policies for least-privilege violations, configure GitHub Actions OIDC for keyless CI deploys, enable cost-envelope thresholds, configure drift detection schedule, accept (or decline) shared → dedicated AWS account migration.

Rigor-upgrade plans run on a `stream/rigor-upgrade-<from>-<to>` branch — they're broad mixed-concern work. They block any subsequent feature plan in the project until they merge.

**Rigor-upgrade may include technology refactors** when the existing scaffolding can't carry the new requirements (vanilla JS → React for production-grade UI accessibility, for example). This is normal, not surprising — flagged in the rigor-upgrade plan's first decision card.

### 4.2 Rigor downgrade

Downgrade is **allowed with friction**. Use case: existing tests are scaffolding for a bad design and need to die wholesale; the heavy refactor warrants prototype velocity.

Mechanics:

1. Operator initiates from the project's settings panel.
2. Pipeline surfaces a card requiring typed-string confirmation: `I want to downgrade <project-slug> from <current-rigor> to <target-rigor>` exactly.
3. The downgrade itself runs as a _plan_, at the _outgoing_ (higher) rigor — last hurrah of the production gates.
4. Automatic semver-major bump on the next deploy after downgrade lands.
5. Future plans run at the lower rigor.

The friction is enough to prevent casual abuse without forbidding the pattern entirely.

### 4.3 Prototype-on-top of production: the experiment branch

The common case the rigor downgrade is _not_ solving: "this production project is healthy, but I want to spike a feature against it without touching production discipline." For that, use a **prototype-on-top plan**, kind `prototype-on-top`, which runs at prototype rigor regardless of project rigor.

- Runs on `experiment/<plan-slug>` branches (a new namespace, distinct from `explore/`).
- Never auto-merges. The branch persists.
- Never replaces a feature plan. If the experiment proved something out, a subsequent `feature` plan at the project's full rigor brings the _idea_ (not the code) back into main with tests, reviews, and gates.
- The value of the experiment is the learning, not the code.

`explore/` (speculation, EVALUATOR-judged A/B) and `experiment/` (unjudged prototype-on-top) are deliberately distinct. Speculation has a winner rule and merges the winner; experiments have no winner and never merge.

## 5. Plan kinds

| Kind                  | Default rigor                | Branch namespace         | Notes                                                                        |
| --------------------- | ---------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `feature`             | inherits project             | `wip/`                   | the standard plan                                                            |
| `bugfix`              | inherits project             | `wip/`                   | smaller scope, same rigor; Triage agent feeds this                           |
| `maintenance`         | inherits project             | `wip/`                   | dependency bumps, refactors                                                  |
| `prototype-on-top`    | always `prototype`           | `experiment/`            | speculative; never auto-merges; see §4.3                                     |
| `hotfix`              | inherits + skips PO/QA       | `hotfix/`                | branches off the production semver tag                                       |
| `rigor-upgrade`       | runs at outgoing rigor       | `stream/rigor-upgrade-*` | auto-generated by rigor promotion (§4.1)                                     |
| `implementation-spec` | matches project target rigor | `wip/`                   | first plan in every project; produces initial manifests + CDK + CI/CD wiring |

PM agent at decomposition time selects the kind from operator intent, with multi-intent detection: _"This intent looks like a bugfix and a feature. Want me to split into two plans?"_

## 6. The attention model — human-on-exception

Steady state: the pipeline runs without humans. Humans appear only when the pipeline can't decide safely on its own.

### 6.1 What the pipeline handles autonomously

- All test failures within the retry budget → DEV retry loop.
- All review rejections within the retry budget → DEV retry loop.
- Single-story merge conflicts during wave merge → wave-conflict-resolver agent (Tier 2; current Tier 1 falls through to operator).
- Daemon restarts, transient infra failures → retry ladder.
- Tamper-check first offense → auto-revert + DEV retry with warning.
- Stale or orphaned worktrees / branches → daemon GC pass on startup.
- T2 (plan-intent) ARCHITECT and SKILL-SCOUT runs that conclude "no changes needed" → silent no-op.

### 6.2 What escalates to attention items

Attention items have **severity** (info / medium / high / critical) and **category**. Each carries enough context to decide without re-deriving state. Operator sees them in the attention dock.

The full taxonomy lives in Appendix C. Highlights:

| Trigger                                        | Severity                     | Category                              |
| ---------------------------------------------- | ---------------------------- | ------------------------------------- |
| Story exhausts retry budget on test-verify     | high                         | `retry-exhausted`                     |
| Story exhausts retry budget on review          | high                         | `review-rejected-exhausted`           |
| Tamper-check second offense                    | high                         | `tamper-repeat`                       |
| Wave merge conflict (Tier 1, no auto-resolver) | high                         | `merge-conflict`                      |
| Wave-build-check fails after merge             | high                         | `wave-build-failed`                   |
| Plan-build-check fails                         | critical                     | `plan-build-failed`                   |
| Stream branch idle > 30 days                   | medium                       | `stale-stream` (auto-archives at 30d) |
| `explore/` evaluation tied                     | medium                       | `speculation-tied`                    |
| Production deploy fails health check           | critical                     | `production-health-failed`            |
| `cdk synth` / `cdk deploy` failures            | high (dev) / critical (prod) | `cdk-*-failed`                        |
| Cost overrun above hard-cap                    | critical                     | `cost-overrun`                        |
| Drift detected on production                   | high                         | `drift-detected-prod`                 |
| Drift detected on dev/staging                  | medium                       | `drift-detected`                      |
| Secret rotation overdue                        | high                         | `secret-rotation-overdue`             |
| Vendor API version deprecated by upstream      | high                         | `vendor-version-deprecated`           |
| Manifest out of sync with CDK                  | medium                       | `manifest-out-of-sync-with-cdk`       |
| IAM trust policy doesn't permit daemon         | critical                     | `iam-trust-broken`                    |
| Orphan AWS resource                            | medium                       | `orphan-resource`                     |
| Production-deploy-ready (informational)        | info                         | `production-deploy-ready`             |

### 6.3 What humans must do explicitly

These are the genuine human-in-the-loop moments — the _only_ places where operator action is required, not just possible:

1. **Approve the project's first decision card** (project init, manifest creation).
2. **Approve plan-intent decision cards** that surface a manifest delta with cost change.
3. **Type initial secret values** when ARCHITECT adds a Secrets Manager path. The path is created automatically; the value comes from the operator's runbook entry. The pipeline never sees plaintext outside runtime SDK calls.
4. **Approve rigor promotion** (prototype → mvp, mvp → production).
5. **Approve rigor downgrade** (with typed-string confirmation per §4.2).
6. **Approve account-strategy migration** (shared → dedicated) during production rigor promotion.
7. **Confirm baseline-drift acceptance** when a story intentionally regresses a baseline test (PR label in production rigor; in-card confirmation in lower rigors).
8. **Promote plan tag → semver tag** (publish to production).
9. **Merge `stream/` branches to main** (multi-terminal manual sessions; pipeline never auto-merges streams).
10. **Resolve high/critical attention items** that exceeded retry budgets.
11. **Create `release/` branches** at major version cutoffs.
12. **Hotfix decisions** when production diverges from main.
13. **Approve REFLECTOR proposals** in the Reflection Inbox.
14. **Resolve drift.** Always — the pipeline never auto-reverts drift.
15. **Decide between cost savings and deferred features** when hitting cost-envelope hard-cap.
16. **Approve production deploys** (the final gate after audit + soak).
17. **Approve any new AWS service in production rigor** (via the manifest decision card).

### 6.4 PR mode as a rigor modifier

PR-based review for individual epics without committing the whole project to production rigor: `pr-mode: true` is a non-binary modifier on the rigor dial. `rigor: prototype, pr-mode: true` is valid. The daemon opens PRs for wave merges, and merge-to-main waits for PR approval. This formalizes the use case (you want a real human review for _this_ sensitive change) without requiring a full rigor promotion.

PR mode in production rigor is on by default. In prototype/mvp it's off by default and per-plan opt-in via the plan card.

## 7. The credential and trust model (preview)

Three layers of credentials, never static:

- **Layer A — daemon execution.** EC2 instance profile attached to the daemon. Rotated by AWS automatically. Used for `sts:AssumeRole` into Layer B and to read the daemon's own secrets (`/futurator/_pipeline/*`). No direct access to project resources.
- **Layer B — per-project role.** `futurator-project-<slug>-role` per project. Trust policy permits `sts:AssumeRole` from Layer A and from operator IAM Identity Center sessions. Permission policy is project-shaped via slug-prefix wildcards (`songster-*` resources only) plus an explicit `Deny *` on every other project's resources.
- **Layer C — per-plan ephemeral session.** Production rigor only. Daemon assumes the project role with a session policy narrowed further to the resources this plan declares it will touch. Session credentials live in `~/.aws/credentials.<story-id>` mode 0600, deleted on story completion. STS sessions self-expire (default 1h, max 12h).

Static IAM access keys are forbidden by policy. Operator interactive sessions use IAM Identity Center (`aws sso login`). SSH'd terminal sessions on the daemon's EC2 use `scope-to.sh` to set `AWS_PROFILE` per project.

Full IAM model in Part V §23.

## 8. The architectural bets — what doesn't change

The whole document is built on these bets. They've held across v2.0 → v2.4 and they persist into v2.5:

- **Agent-ruled, human-on-exception.** The pipeline runs itself; the operator handles exceptions. The list in §6.3 is exhaustive — anything not on it should not require a human.
- **Tool gates beat prompt rules.** A `--disallowedTools` glob is a guarantee; a prompt rule is a request. We push correctness invariants down to the tool-call layer wherever Claude Code gives us the surface.
- **Git is the durable substrate.** Branches encode workflow state; commit metadata encodes intent hierarchy; tags encode releases. The intent hierarchy is a _query_, not a _topology_.
- **The recurring abstraction: managed resource = manifest + resolver agent + trigger map + lifecycle + rigor matrix.** Skills, AWS infrastructure, and third-party integrations are all instances of this pattern. Future managed resources (observability, multi-tenancy, billing — whatever v2.6 turns out to be) will follow the same template.
- **Reflection compounds.** Every plan's exhaust feeds the next plan's input. Without the reflection loop, every plan starts from baseline.
- **One repo per project.** Forever. The repo persists from prototype through production; manifests grow, code grows, rigor changes, but the project is one project.

---

# Part II — The Story Pipeline (the inner loop)

The story is the atomic unit of agent work. This part describes the steps every story moves through, the gates between them, and the discipline that prevents inner-loop waste.

The brick-breaker post-mortem (a 12-story Pacman-like that took 30+ minutes) showed almost every minute of waste was an inner-loop pipeline issue, not an agent-quality issue. Fix the inner loop once, every plan benefits.

The pattern across these fixes: **prefer bash + CLI flags over prompt rules**. The agents' prompts decide _what_ to build; the discipline layer decides _what they're allowed to touch while building it_.

## 9. The 11-step pipeline

For production rigor — full ceremony. Lower rigor strips steps per the rigor matrix in Part I §4.

```
 1. git-init-story         shell    create wip/<story-id> branch from epic-base; git worktree add
 2. api-author             agent    API-AUTHOR emits frozen .d.ts surface (mvp+ only)
 3. test-author            agent    TEST writes tests from story.criteria[]; commits
 4. test-gate-red          shell    run tests; expect FAIL (confirm red baseline; mvp+ only)
 5. dev                    agent    DEV implements; commits
 6. test-verify            shell    run tests; expect PASS
 7. tamper-check           shell    test files unchanged since step 3 (mvp+ warn / production block)
 8. baseline-regression    shell    no previously-passing test now fails (mvp+ block)
 9. review                 agent    REVIEWER judges; can FAIL → step 10
10. retry                  agent    DEV re-implements; AMENDS its commit (no new commit per iteration)
11. compile-knowledge      agent    COMPILER updates wiki + commit metadata; pushes
```

`compile-diff` from earlier versions is gone — git itself is the diff. `compile-sync` is folded into step 11.

The `--amend` rule on retry (step 10) is non-negotiable: three failed DEV iterations should not produce three commits. The trail is noise and muddies bisects.

## 10. Tool allowlists per role

Single highest-leverage discipline. Claude Code honors `--allowedTools` and `--disallowedTools` globs as hard gates. This moves "TEST must not edit src files" and "DEV must not touch test files" from prompt prose to mechanical impossibility.

```bash
# api-author step — frozen .d.ts only
claude -p "$API_STUB_PROMPT" \
  --allowedTools "Write(${STORY_MODULE}/index.d.ts)" \
  --disallowedTools "Bash,Edit" \
  --max-turns 2

# test-author step
claude -p "$TEST_PROMPT" \
  --disallowedTools \
    "Write(**/src/**/*.ts),Edit(**/src/**/*.ts),Write(**/src/**/*.tsx),Edit(**/src/**/*.tsx)" \
  --allowedTools \
    "Write(**/*.test.ts),Edit(**/*.test.ts),Write(**/*.test.tsx),Edit(**/*.test.tsx),Write(e2e/**/*.spec.ts),Read,Glob,Grep,Bash"

# dev step
claude -p "$DEV_PROMPT" \
  --disallowedTools \
    "Write(**/*.test.ts),Edit(**/*.test.ts),Write(**/*.test.tsx),Edit(**/*.test.tsx),Write(e2e/**/*.spec.ts),Edit(e2e/**/*.spec.ts)"

# review step — read-only
claude -p "$REVIEW_PROMPT" \
  --disallowedTools "Write,Edit,NotebookEdit,Bash"
```

Read-only roles (REVIEWER, QA, PO, REFLECTOR, EVALUATOR, SKILL-SCOUT in T2-readonly mode) all carry `--disallowedTools "Write,Edit,NotebookEdit,Bash"`. The narrow read-only Bash needs (`git log`, `ls`) are exposed via per-role MCP wrappers, not raw shell. **Bash is the most important deny:** a Reviewer that can shell out can do anything.

The globs are stored as one config per agent role in `agent-tool-policy.ts` so they're tunable without code changes to the daemon.

## 11. Pre-computed context packs

Every agent's first ~20 turns rediscover the same facts: `package.json`, `tsconfig.json`, project tree, public exports. Compute once per wave in deterministic bash, inject via `--append-system-prompt`:

```bash
# scripts/build-context-pack.sh
build_context_pack() {
  local root=$1
  local out=$root/.pipeline/context.md
  mkdir -p $(dirname $out)
  {
    echo "# Project context (auto-generated $(date -Iseconds))"
    echo ""
    echo "## File tree (top 200)"
    (cd $root && git ls-files | head -200)
    echo ""
    echo "## package.json"
    cat $root/package.json
    echo ""
    echo "## tsconfig.app.json"
    cat $root/tsconfig.app.json 2>/dev/null
    echo ""
    echo "## Existing test files (these are immutable contracts)"
    (cd $root && git ls-files '*.test.*' '*.spec.*')
    echo ""
    echo "## Public exports — types"
    grep -hE '^export' $root/src/types/*.ts 2>/dev/null
    echo ""
    echo "## Public exports — constants"
    grep -hE '^export' $root/src/constants/*.ts 2>/dev/null
  } > $out
}

# Then for every agent invocation:
claude -p "$PROMPT" --append-system-prompt "$(cat $root/.pipeline/context.md)"
```

Empirically this kills the first ~20 tool calls per TEST/DEV step. The pack rebuilds at wave end so the next wave's first story starts fresh. ~5KB pack; trivial prompt-cache cost.

**Per-wave regeneration is the default.** Stories that need fresher state (mid-wave file additions matter) request a rebuild via a daemon flag (`--rebuild-context-pack`).

### 11.1 The pack must list existing tests

Brick-breaker incident 2: TEST agent assumed `GameStatus = 'idle'` was addable because it never read `src/types/index.test.ts` (which locked the type to four values). The pack puts that file in front of TEST's nose every session, marked `# these are immutable contracts`. Combined with the baseline gate (§14), this closes the loop.

### 11.2 Context pack vs. CLAUDE.md vs. inboxes

Three distinct sources, never overlapping:

- **CLAUDE.md** is the _narrative_ — why decisions were made, project-specific conventions, accumulated wisdom. Read at session start, prepended to system prompt.
- **Context pack** is the _substrate snapshot_ — what's here right now. Deterministic, regenerated, file-tree + public exports + test-file list.
- **Inboxes** are the _conversation log_ — what agent X told agent Y about decision Z. Append-only.

Agents read all three for different reasons. The pack tells you what's here; CLAUDE.md tells you why; the inbox tells you what just happened.

## 12. Bootstrap as a pre-epic step

The first story shouldn't be running `npm create vite@latest`. Lift project scaffolding into a non-agent step that runs once at project creation:

```bash
# scripts/bootstrap-project.sh
bootstrap_project() {
  cd $WORKDIR
  [ -f package.json ] && [ -d node_modules ] && return 0   # idempotent
  pnpm install --frozen-lockfile
  if [ "$RIGOR" = "production" ]; then
    npx playwright install --with-deps
  fi
  pnpm dlx husky install
  chown -R $(id -u):$(id -g) .
}
```

The boilerplate (`futurator-starter`, see §13) ships everything else pre-wired. No agent involvement, no `sudo chown` dance, no "did npm install run yet" race.

## 13. The boilerplate — `futurator-starter`

A GitHub Template Repository. Project init's first action:

```bash
gh repo create "$PROJECT_NAME" \
  --template futurator/futurator-starter \
  --private \
  --description "$PROJECT_DESCRIPTION" \
  --clone
```

Or, for client-owned projects (per Part I §2):

```bash
gh repo create "$CLIENT_ORG/$REPO_NAME" \
  --template futurator/futurator-starter ...
```

### 13.1 What's in the boilerplate

```
futurator-starter/
├── package.json                       # all scripts pre-wired
├── pnpm-lock.yaml                     # pinned deps, deterministic installs
├── tsconfig.json                      # strict, module=NodeNext
├── eslint.config.ts                   # Futurator house rules
├── prettier.config.ts
├── vitest.config.ts                   # unit tests
├── playwright.config.ts               # e2e (production rigor only)
├── knip.json                          # dead-code detection
├── .husky/
│   ├── pre-commit                     # lint-staged + typecheck + frozen-file check
│   └── commit-msg                     # conventional commits + storyId enforcement
├── .lintstagedrc.json
├── .github/
│   └── workflows/
│       ├── ci.yml                     # rigor-tiered (jobs gated by repo var FUTURATOR_RIGOR)
│       ├── deploy-dev.yml             # OIDC role assume → cdk deploy dev
│       ├── deploy-staging.yml
│       └── deploy-prod.yml            # workflow_dispatch only
├── .claude/
│   ├── agents/                        # project-local agent extensions
│   ├── skills.manifest.yaml           # skill manifest (initially core only)
│   ├── skills/                        # project-local skills
│   ├── commands/
│   ├── inbox/                         # inter-agent comms (gitignored, seeded)
│   └── memory/                        # mounted memory store (when MA arrives)
├── .deployment/
│   ├── aws.manifest.yaml              # written by ARCHITECT during impl-spec
│   └── integrations.manifest.yaml     # ditto
├── deployment/
│   └── cdk/                           # CDK app, generated from manifests by COMPILER
├── .pipeline/
│   ├── context.md                     # auto-generated context pack
│   ├── baseline-passing.txt           # baseline test set
│   ├── frozen.txt                     # files frozen for the current story
│   └── metrics.csv                    # per-step metrics emission
├── CLAUDE.md                          # project-level (template; PM populates)
├── README.md
├── cost-history.yaml                  # appends on rigor changes
└── scripts/
    ├── bootstrap-project.sh
    ├── build-context-pack.sh
    ├── capture-test-baseline.sh
    └── check-regressions.sh
```

### 13.2 Boilerplate sync to running projects

When `futurator-starter` updates (new ESLint rule, security patch, new skill), the operator triggers a "Refresh boilerplate" action explicitly. Never automatic. The action runs `git fetch starter && git merge --strategy-option=theirs starter/main` against scoped paths (`.github/workflows/`, `eslint.config.ts`, `scripts/`). Production rigor sees a PR-style diff for review; mvp/prototype auto-applies and surfaces a notification.

### 13.3 Locked dependencies

`pnpm-lock.yaml` is committed. Dev agents do `pnpm install --frozen-lockfile` — no version drift, no unexpected breaking changes mid-development.

## 14. Baseline-diff regression gate

Brick-breaker incident 2 (DEV broke `GameStatus` test by widening the type) is catchable deterministically. Capture what passes today; refuse to ship a story that regresses it.

```bash
# scripts/capture-test-baseline.sh — runs at wave start
npm test --silent --reporter=json > .pipeline/baseline.json 2>&1 || true
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \
  .pipeline/baseline.json | sort > .pipeline/baseline-passing.txt

# scripts/check-regressions.sh — runs after every DEV step
npm test --silent --reporter=json > .pipeline/after.json 2>&1 || true
jq -r '.testResults[].assertionResults[]
       | select(.status=="passed") | .fullName' \
  .pipeline/after.json | sort > .pipeline/after-passing.txt

regressions=$(comm -23 .pipeline/baseline-passing.txt .pipeline/after-passing.txt)
if [ -n "$regressions" ]; then
  echo "REGRESSION: previously-passing tests now fail:"
  echo "$regressions"
  case "$RIGOR" in
    prototype)  echo "WARNING — proceeding"; exit 0 ;;
    mvp)        exit 1 ;;
    production) exit 1 ;;
  esac
fi
```

After a baseline-passing wave, the baseline rolls forward. Stories that the baseline can't accommodate (intentional API change) require **acceptBaselineDrift confirmation**:

- **Production rigor:** PR label `futurator:accept-baseline-drift` (operator applies via GitHub).
- **mvp/prototype rigor:** decision card surfaced when wave-build-check detects regression: _"Story X-Y regressed baseline test Z. Intentional?"_

## 15. The API stub step (frozen module surface)

Eliminates contract drift between TEST and DEV at the source. Insert API-AUTHOR between PM's story output and TEST. Output is exactly one file — a `.d.ts`-style declaration of the module's public surface — that both TEST and DEV import from.

```bash
# api-author step (mvp + production rigors)
claude -p "$API_STUB_PROMPT" \
  --allowedTools "Write(${STORY_MODULE}/index.d.ts)" \
  --disallowedTools "Bash,Edit" \
  --max-turns 2
```

Example output for a brick-breaker physics story:

```typescript
// src/physics/index.ts — declarative API for this story
import type { Ball, Paddle, Brick } from '../types';

export function moveBall(ball: Ball, dt: number): Ball;
export function checkWallCollisions(ball: Ball, w: number, h: number): Ball;
export function checkPaddleCollision(ball: Ball, paddle: Paddle): Ball;
export function checkBrickCollisions(
  ball: Ball,
  bricks: Brick[],
): { ball: Ball; destroyedIds: string[] }; // names frozen here
```

Both TEST and DEV `import type { ... } from './index'`. Names are physically shared — incident 1 (TEST writes `destroyedIds`, DEV writes `destroyedBrickIds`) cannot recur. The `--max-turns 2` and narrow allowed-tools mean this step can't do anything except emit the stub.

When PM's plan.md already includes type signatures with frozen names, api-author becomes a pass-through (extract → write). Cost stays low; the invariant holds.

## 16. Tamper-check and frozen-file pre-commit hook

Belt and braces against test tampering by DEV.

**Runtime tamper-check (step 7):** after DEV commits, compare the SHA-256 of every test file against the snapshot taken at end of step 3 (test-author). Any mismatch = tamper. First offense → auto-revert, DEV retry with warning. Second offense → high-severity attention item `tamper-repeat`.

**Pre-commit hook (defense in depth):** the boilerplate's husky `pre-commit` reads `.pipeline/frozen.txt` (set by the daemon at TEST step end) and refuses to commit changes to those files in subsequent steps:

```bash
# .husky/pre-commit (excerpt)
[ -f .pipeline/frozen.txt ] || exit 0
for f in $(git diff --cached --name-only); do
  if grep -qxF "$f" .pipeline/frozen.txt; then
    echo "BLOCKED: $f is frozen for this story"
    exit 1
  fi
done
```

`.pipeline/frozen.txt` is rewritten at every TEST step end and cleared at story → done. Even if the `--disallowedTools` glob is somehow bypassed, git won't accept the commit.

## 17. Turn caps and single-pass verification

**`--max-turns` per agent role.** Most TEST/DEV steps in the brick-breaker logs used 6–13 turns. Cap them — non-binding in the common case (with §10–§16 in place), safety net against runaway exploration:

| Agent      | prototype | mvp | production |
| ---------- | --------- | --- | ---------- |
| api-author | —         | 2   | 2          |
| TEST       | 6         | 8   | 10         |
| DEV        | 8         | 10  | 12         |
| REVIEWER   | 4         | 6   | 8          |
| QA         | —         | —   | 8          |
| PO         | —         | —   | 6          |

```bash
claude -p "$TEST_PROMPT" --max-turns "$MAX_TURNS_TEST"
```

Production gets _higher_ caps (more thorough), prototype gets _lower_ (faster).

**Single verification pass.** Drop DEV's own `npx vitest run`; do one scoped run in `test-verify`:

```bash
npx vitest run --changed HEAD~1 || npx vitest run
```

Combined with the baseline gate (§14), one focused run covers "new tests pass" and "old tests still pass" without running the suite twice.

## 18. Explore-subagent output caching

The `Agent(subagent_type="Explore")` pattern is useful but currently runs twice per story (once for TEST, once for DEV) on the same project root. When TEST invokes it, capture the output and cache it for DEV:

```bash
# After TEST step, parse stream-json output
jq -r '
  select(.type=="tool_use" and .name=="Agent")
  | .input.prompt
' .pipeline/test-events.jsonl > .pipeline/explore-input-$STORY_ID.md
```

DEV's context pack for that story prepends the cached output. Saves ~30s and one subprocess spawn per story. Cache invalidates whenever a wave commits new files (which the §11 rebuild already handles).

## 19. Metrics emission and the reflection feed

Every Claude Code subprocess emits `--output-format stream-json`. We already have `step_complete` events with `numTurns`, `outputTokens`, `cacheRead`, `cacheCreation`, `contextPercent`. Tee them to a CSV per plan:

```bash
claude -p "$PROMPT" --output-format stream-json --verbose \
  | tee >(jq -c '
      select(.type=="step_complete") |
      [env.STORY_ID, env.AGENT, .numTurns,
       .outputTokens, .cacheRead, .cacheCreation,
       .contextPercent] | @csv' \
      >> $WORKDIR/.pipeline/metrics.csv) \
  | jq -r 'select(.type=="text_delta" or .type=="tool_use")'
```

Three uses:

- **Wave-level threshold check** warns when total turns exceed 1.5× rolling median.
- **REFLECTOR (Part VI)** reads `metrics.csv` as input — "agent X consistently exceeds turn budget on stories of type Y" is a promotable observation.
- **Operator dashboard** surfaces "this plan used 2,340 turns" on plan close.

This is how execution discipline becomes reflection-aware: noisy patterns get measured, measured patterns get promoted, promoted patterns get encoded back into boilerplate / personas / skills.

## 20. Failure handling and retry budgets

Each gate has a retry budget. Exhaustion escalates to attention.

| Gate                   | Retries                                 | On exhaustion                     |
| ---------------------- | --------------------------------------- | --------------------------------- |
| `test-gate-red` (mvp+) | 1 (TEST may rewrite once)               | high `test-author-failed`         |
| `test-verify`          | 3 (DEV retries)                         | high `retry-exhausted`            |
| `tamper-check`         | 1 (auto-revert + DEV retry)             | high `tamper-repeat`              |
| `baseline-regression`  | 1 with operator drift-accept option     | medium `baseline-drift-pending`   |
| `review`               | 3 (DEV retries)                         | high `review-rejected-exhausted`  |
| `wave-build-check`     | 0 (deterministic; surface and rollback) | high `wave-build-failed`          |
| `plan-build-check`     | 0                                       | critical `plan-build-failed`      |
| `cdk-synth`            | 0                                       | high `cdk-synth-failed`           |
| `cdk-deploy-dev`       | 1 (transient AWS errors)                | high `cdk-deploy-dev-failed`      |
| `cdk-deploy-prod`      | 0                                       | critical `cdk-deploy-prod-failed` |

Retry counter resets per story. A wave with multiple failed stories produces multiple attention items, each with its own retry history.

---

# Part III — The Git Substrate

v2.2's central bet: git is the durable substrate. Branches encode workflow state; commit metadata encodes the intent hierarchy; tags encode releases. **The intent hierarchy is a query, not a topology.** This is what makes the four-level Plan → Epic → Story → Step model work without exotic graph databases — `git log --grep` reconstructs anything.

## 21. One repo per project

Forever. One project = one repo, from prototype through production. Manifests grow; code grows; rigor changes; the project is one project. This is what makes rigor promotion painless — there's no "create new repo and migrate" exercise at the threshold.

GitHub layout:

- Default: `futurator/<project-slug>` (private). Single Futurator GitHub org for everything.
- Client-owned exception: `<client-org>/<repo-name>` declared at project init. The pipeline doesn't care which org owns the repo, only that the daemon's PAT has push/admin access.

## 22. The branch taxonomy

| Namespace                       | Owner                              | Lifetime                 | Purpose                                                                                |
| ------------------------------- | ---------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `main`                          | shared (write-protected per rigor) | permanent                | the source of truth                                                                    |
| `wip/<story-id>`                | Labs daemon                        | story-bounded            | per-story isolation; merged to main at wave-merge, then deleted                        |
| `stream/<n>`                    | operator                           | until merged or archived | manual multi-terminal sessions; operator owns merging                                  |
| `experiment/<plan-slug>`        | Labs daemon                        | persistent               | prototype-on-top plans; never auto-merge                                               |
| `explore/<plan-id>-<approach>`  | Labs daemon                        | speculation-bounded      | EVALUATOR-judged A/B; winner merges to main, loser → `archive/`                        |
| `release/v<N>`                  | operator                           | major-version-bounded    | production rigor only; for projects with external users                                |
| `hotfix/<issue-slug>`           | Labs daemon                        | hotfix-bounded           | branches off the production semver tag                                                 |
| `archive/<original-name>@<sha>` | Labs daemon                        | until manual purge       | losers from speculation, idle streams (auto-archived after 30 days), hard-failed plans |
| `abandoned/<original-name>`     | Labs daemon                        | until manual purge       | crashed wip/ branches found by daemon GC                                               |

### 22.1 Coordination guarantees

1. **Only `main` is shared writable.** Every other branch has a single owner.
2. **Labs daemon owns all `wip/`, `experiment/`, `explore/`, `hotfix/` branches.** Operators do not touch them.
3. **Operators own all `stream/` branches.** The daemon never merges them — that's the human-in-the-loop point.
4. **Pushes to `main` are last-writer-wins.** Force-push is forbidden by branch protection (production rigor) and by convention (lower rigor).
5. **Wave merges and tag creation are serialized** via a distributed lock (DDB conditional write, see §27).

### 22.2 Stream auto-archival

A stream branch idle for 30 days gets auto-archived: the daemon retags it as `archive/stream/<n>@<original-sha>` and deletes the original ref. Archive refs don't show in normal `gh pr list` or `git branch`, but they're recoverable. **Hard purge of archive refs is a manual operator action only.** This protects the scenario where you started something brilliant on a stream, walked away for two months, and come back to find the daemon helpfully erased it.

## 23. Commit metadata as the durable structure

Every agent-generated commit follows a strict template. The body is machine-parseable; the hierarchy is reconstructed by filtering, not by walking branches.

```
<type>(<epicId>/<storyId>): <one-line summary>

Project: <project-slug>
Plan: <plan-id>
Plan-Kind: <feature|bugfix|maintenance|prototype-on-top|hotfix|rigor-upgrade|implementation-spec>
Phase: <phase-id or "n/a">
Epic: <epicId> (<epic-title>)
Wave: <wave-number>
Story: <storyId>
Agent: <PM|TEST|DEV|REVIEWER|COMPILER|HOTFIX|ARCHITECT|SKILL-SCOUT|EVALUATOR|REFLECTOR|API-AUTHOR|WAVE-MERGE>
Model: <sonnet|haiku|opus>
Rigor: <prototype|mvp|production>
Stream: <stream-name or "labs">
Tests-Added: <N>
Tests-Modified: <N>            ← MUST be 0 for non-TEST agents
Files-Changed: <N>
Skills-Used: <skill-name@<source>, ...>
Skills-Manifest-Sha: <sha>
Skill-Encounter: <skill-name attempt:<n>>     # only when COMPILER notes an encounter
```

Commit types follow Conventional Commits: `feat | fix | test | chore | refactor | docs | perf | sec`.

`Tests-Modified: N > 0` from a non-TEST agent is itself a flag — tamper-check should already have caught it, but commit metadata is the backstop. A linter on commit messages (run in CI) fails builds where this invariant is violated.

The COMPILER agent emits this metadata block as part of the `compile-knowledge` step (Part II §11).

### 23.1 Reconstruction queries

The whole point of commit metadata: any historical query is a `git log --grep`.

```bash
# All work on a specific plan
git log --grep="Plan: pacman-v2-multiplayer"

# All work by a specific agent across the repo
git log --grep="Agent: DEV"

# All test additions in a specific epic
git log --grep="Epic: E2" --grep="Agent: TEST" --all-match

# Every commit where a skill was active
git log --grep="Skills-Used:.*music-theory-engine"

# All hotfixes since a date
git log --grep="Plan-Kind: hotfix" --since="2026-01-01"

# Find when tamper-check ever fired
git log --grep="Agent: DEV" -G"Tests-Modified: [1-9]"

# All skill-encounter increments (for distillation auditing)
git log --grep="Skill-Encounter:"

# All ARCHITECT-driven manifest changes
git log --grep="Agent: ARCHITECT"
```

Branches are temporary scaffolding. Metadata is the permanent record.

## 24. Worktrees — per-story filesystem isolation

Worktree-per-concurrent-story is what makes parallel waves safe at the filesystem level. Worktrees share the same repo's object store but live in separate directories with separate checked-out branches.

```bash
# At story start (step 1 of the story pipeline)
git worktree add /home/ubuntu/worktrees/<project>/<plan>/<story-id> \
                 -b wip/<story-id> \
                 <epic-base-sha>

# DEV / TEST / REVIEWER all run in this isolated dir
# Tools (Edit, Write) scoped to this dir via daemon cwd

# At wave merge (success), or on story failure resolution
git worktree remove /home/ubuntu/worktrees/<project>/<plan>/<story-id>
git branch -D wip/<story-id>
```

### 24.1 Worktree storage

Central pool, **outside** the project dir: `/home/ubuntu/worktrees/<project>/<plan>/<story-id>`. Three reasons:

1. Project-scoped tools (eslint, vite, tsc with project mode) get confused by sibling worktrees inside the project tree.
2. Backup is easier when worktrees are an ephemeral pool, not mixed with project state.
3. Cleanup is `rm -rf` of a single tree with no risk of clobbering project files.

Worktree count = parallelism slot count. A daemon with 3 slots maintains up to 3 worktrees per active plan. Failed stories' worktrees stay around until the operator resolves the blocker (so the diff is inspectable), then are cleaned up on resolution.

**EBS sizing:** budget ~2GB per concurrent worktree (node_modules dominate). With 3 daemon slots × 5 active plans = 15 worktrees worst case = 30GB. Capacity-planning section in Part V §29.

### 24.2 Daemon GC pass

On daemon startup, recover from any inconsistent state:

```
1. List all worktrees → cross-reference active jobs in DDB
2. For each worktree without an active job: archive its branch as abandoned/<name>, remove worktree
3. List all wip/ branches on remote → cross-reference active stories
4. For each wip/ branch without an active story: archive (rename to abandoned/) or delete
5. Verify main is in clean state, no in-progress merge
6. Resume polling
```

Same pattern as v2.4's infra GC — declared state vs observed state, surface inconsistencies, never silently "fix" them.

## 25. Stream branches — multi-terminal manual sessions

The second flavor of agentic work: concurrent Claude Code terminals on the same project. They are _not_ pipeline-orchestrated. Each terminal needs its own isolation lane.

### 25.1 Convention

```bash
# Operator opens new terminal:
cd /home/ubuntu/projects/songster
git checkout main && git pull --ff-only
git checkout -b stream/live-perf-teleprompter

# Terminal's CLAUDE.md or initial prompt instructs:
# - You are on branch stream/live-perf-teleprompter
# - Commit per logical chunk with the metadata template
# - Set Stream: live-perf-teleprompter, Plan: n/a, Epic: n/a, Story: n/a
# - Do NOT touch other branches
# - Do NOT merge to main yourself
```

Stream commits look like Labs commits but with `Stream: <name>` and `Plan: n/a`. The operator's CLAUDE.md template for streams (Appendix B) carries the AWS scoping reminder (Part V §23).

### 25.2 Merging a stream

The **operator** merges, not the agent. This is the human-in-the-loop point the multi-terminal flavor demands.

```bash
git checkout main && git pull --ff-only
git merge --no-ff stream/live-perf-teleprompter
# resolve any conflicts manually
git push origin main
git branch -d stream/live-perf-teleprompter
```

If conflicts are mechanical (formatting, import ordering), operator can ask the agent in that terminal to resolve. If conflicts are semantic, operator decides.

### 25.3 Stream + Labs coexistence

A project can have Labs plans running _and_ stream branches active simultaneously. They share `main` and metadata conventions but not branches:

- Labs operates only in `wip/` and merges via wave-merge.
- Streams operate only in `stream/` and the operator merges them.
- Neither touches the other's branches.

If both push to main at roughly the same time, normal git semantics handle it: second pusher fetches and rebases or merges. Conflicts surface to whichever side is later.

### 25.4 Graduating a stream to a Labs plan

When a stream's work has crystallized enough to be DAG-able:

1. Commit current stream state, leave it pushed.
2. Open a Labs plan with intent: "continue the work in stream/<n>, completing X, Y, Z."
3. PM reads the stream's commits as context, decomposes into epics/waves.
4. Labs plan executes; on completion, merges to main.
5. The stream branch is deleted once the Labs plan absorbs its work.

This is the path from "I'm exploring" to "I have a plan" without losing work in between.

## 26. Wave merging — the integration moment

After all stories in a wave complete (each on its own `wip/` branch with green tests), the wave-build-check step takes responsibility for integration.

```bash
# 1. Establish merge target
git checkout main && git pull --ff-only
# OR for non-first waves of an epic, the wave-base may be the previous wave's merge SHA

# 2. Merge each story branch (no fast-forward, preserve story identity in graph)
git merge --no-ff wip/E2-S1
git merge --no-ff wip/E2-S2
git merge --no-ff wip/E2-S3
git merge --no-ff wip/E2-S4
# Each --no-ff produces a merge commit with metadata template Agent: WAVE-MERGE

# 3. Re-run full test suite against merged state
pnpm install --frozen-lockfile
pnpm test
pnpm run build

# 4a. If green:
git push origin main
git worktree remove /home/ubuntu/worktrees/<project>/<plan>/E2-S1 ...
git branch -D wip/E2-S1 wip/E2-S2 wip/E2-S3 wip/E2-S4

# 4b. If red:
# Stories collide. Reset main, mark wave as fixing, emit attention item.
git reset --hard origin/main
# wave-conflict-resolver agent (Tier 2) handles this; Tier 1 falls through to operator.
```

**Conflicts during step 2 are real signals** — two parallel agents touched the same file in incompatible ways. Surface as `merge-conflict` attention items rather than letting them silently merge incorrectly.

### 26.1 Wave smoke check

For lower rigor, after a green wave merge: a project-defined smoke test runs against the merged state. For frontend projects: dev server starts, root URL returns 200, no console errors during page load. For backend projects: `cdk synth` clean, container builds, `/_health` returns 200. Failure → revert wave merge → attention item `wave-smoke-failed`.

### 26.2 PR mode wave merging

When `pr-mode: true` (per-rigor or per-plan), wave merging goes through PRs:

1. Daemon opens a PR `wip/E2-S1...wip/E2-Sn` → `main` (single PR for the whole wave).
2. PR title includes `Wave <n> of plan <plan-id>`.
3. CI runs all required checks per the rigor matrix.
4. If checks green, daemon adds the `wave-ready` label.
5. **Operator approval gate.** Daemon waits until a human approver approves the PR.
6. Daemon merges via `gh pr merge --auto --merge` (no-ff preserved).
7. Cleanup proceeds as in step 4a above.

This is what production rigor enables by default and what `pr-mode: true` enables in lower rigor for specific epics.

## 27. Distributed merge lock

Concurrent plans completing simultaneously must serialize their pushes to main. Implementation: DynamoDB conditional write.

```
Schema:
  PK = LOCK#<project-slug>
  SK = MERGE
  attributes: holder, acquired_at, ttl
  condition: attribute_not_exists(holder) OR ttl < now
  TTL: 5 minutes (auto-release on daemon crash)
```

The 5-minute TTL handles daemon crashes — if the holder dies mid-merge, the lock auto-releases and the next contender retries. Same DDB single-table that holds project + plan state; no extra infra.

## 28. Speculation — `explore/` branches

The genuinely novel pattern with no good human equivalent: the pipeline can A/B-test architectural choices.

### 28.1 PM triggers speculation

PM, during plan generation, may identify a decision where:

- Multiple approaches are technically viable.
- The right choice depends on properties only measurable by trying both.
- The cost of trying both is bounded.

Examples: Canvas vs SVG renderer; REST vs GraphQL API; polling vs WebSocket; (v2.3) two reasonable Stripe-integration _skills_.

PM emits a speculation marker:

```yaml
plan:
  intent: '...'
  speculations:
    - id: 'renderer-choice'
      epicId: E3
      kind: implementation # implementation | skill-set | infra
      approaches:
        - id: canvas
          description: 'HTML Canvas with imperative draw calls'
        - id: svg
          description: 'React + SVG with declarative components'
      evaluation:
        metrics: [test-pass-rate, bundle-size, fps-benchmark]
        winner-rule: 'highest fps-benchmark with all tests passing'
```

### 28.2 Pipeline behavior

```
plan starts → epic E1, E2 run normally on main
  → epic E3 reaches a speculation marker
  → pipeline forks:
       branch explore/<plan-id>-canvas off current main
       branch explore/<plan-id>-svg    off current main
  → each branch's worktree carries its own skills / aws / integrations manifest delta
  → both branches run E3 to completion in parallel
  → EVALUATOR reads both branch tips, applies winner-rule to measured metrics
  → winner branch merges to main as if it had been the only one
  → loser branch renamed to archive/<plan-id>-svg-rejected
  → speculation result stored as artifact (metrics + rationale) in commit metadata
```

### 28.3 Three flavors of speculation

- **Implementation speculation** (v2.2): two code approaches.
- **Skill-set speculation** (v2.3): two different skill manifests for the same intent — "two reasonable Stripe integrations may both work; the question is which one produces a more idiomatic, smaller, safer implementation when given to the same agent."
- **Infra speculation** (v2.4 T4): two different `aws.manifest.yaml` shapes — Lambda vs Fargate, hosted-checkout vs custom payment endpoint. Cost engine measures both; cost + perf decide.

The EVALUATOR agent handles all three; prompt template selected at invocation by `kind:` field.

### 28.4 Production rigor only

Speculation is gated to production rigor:

- The cost (running plans twice) is meaningful.
- Evaluation criteria need to be well-defined (production-grade tests must exist).
- Archived loser branches should be discoverable in code review.

In mvp, PM's uncertainty manifests as a single chosen approach + a RetroNote (separate doc) flagging the alternative for later evaluation.

## 29. Plan completion → tag → release candidate

When a plan's last wave completes and plan-build-check passes:

```bash
git checkout main && git pull --ff-only

# Tag for traceability — every plan completion produces a tag
git tag -a "<project>-plan-<plan-slug>" -m "Plan <plan-slug> complete"
git push origin "<project>-plan-<plan-slug>"

# Plan transitions to status=review
# Plan deploys to staging.futurator.ai/<project>/
```

**Promotion to production** is a separate, explicit operator action:

```bash
# Operator clicks Publish in Labs UI
git tag -a "<project>-v<semver>" -m "Production release v<semver>"
git push origin "<project>-v<semver>"
# Production deploy reads this tag (Part V §31)
```

The semver tag is the production identity. The plan tag is the intermediate artifact. A release contains one or more plan tags; a plan tag may eventually graduate into a release.

## 30. Environments — three buckets, one SHA

```
preview.futurator.ai/<project>/<sha>/    ← any commit on any branch, auto, ephemeral (7d cleanup)
<project>-dev.futurator.ai               ← latest main, auto, persistent
staging.futurator.ai/<project>/          ← latest plan tag of plans in review, auto
<project>.futurator.ai                   ← latest production tag, manual promote
```

| Environment | Trigger                | Source          | Gate                                                  |
| ----------- | ---------------------- | --------------- | ----------------------------------------------------- |
| Preview     | git push to any branch | exact SHA       | none                                                  |
| Dev         | git push to main       | latest main SHA | wave-build-check + plan-build-check passed            |
| Staging     | plan tag created       | plan tag        | plan reached `review` status, all CI green            |
| Production  | operator publish       | semver tag      | 24h staging soak + security audit + operator approval |

**No branch corresponds to an environment.** A SHA can be in dev and staging at the same time — same code, two CloudFront origins.

This is the deployment design that makes "what's in production" answerable unambiguously: it's whatever SHA the latest semver tag points to.

### 30.1 Preview backend stacks

The default preview is **frontend-only**: CloudFront points at a per-SHA S3 prefix; backend comes from `dev`. This keeps preview cheap (no per-SHA Fargate / DynamoDB).

Backend-preview is opt-in per plan via `preview-backend: true` in the plan card (production rigor only). When set, ARCHITECT generates an `aws-ephemeral` stack per SHA (`<Project>Preview-<sha>Stack`). Cost guardrail: backend-preview stacks auto-cleanup after **24h** instead of the 7d default.

### 30.2 Demo environment promotion

If a preview-backend stack turns into a real customer demo and the operator wants it persisted, there's a promotion path: `aws-ephemeral` → `aws-env-demo` (a fifth environment kind, see Part V §28). Mechanics: rename the CDK stack, change the lifetime tag, move state to its own S3 path. Demo envs are persistent until explicitly torn down, but live in their own kind so they don't masquerade as production.

## 31. Branch protection by rigor

| Rigor                       | Required CI checks                            | Required PR approvals | `--auto` merge                    |
| --------------------------- | --------------------------------------------- | --------------------- | --------------------------------- |
| prototype                   | lint, typecheck                               | 0                     | yes                               |
| mvp                         | + unit                                        | 0                     | yes                               |
| production                  | + e2e + build + security-audit                | 1                     | yes (waits for approval + checks) |
| any rigor + `pr-mode: true` | per rigor + adds wave-ready label requirement | 1                     | yes                               |

The daemon runs `gh api -X PUT /repos/<owner>/<repo>/branches/main/protection` once at project init based on rigor; re-applies on rigor change.

**`--auto` merge with self-block on `fixing`.** If `Plan.status === 'fixing'`, wave-completion can't auto-merge new wave PRs (other than the one fixing the regression). Implementation: branch protection rule conditional on a label `futurator:fix-in-flight` set/unset by the daemon.

## 32. Brownfield — bringing existing projects into v2.5

Every project in flight (Songster, goMAD, Mycelium, Atlassinator, Applicator, Contento, MBE, IndexForge, Contax, cayambe.de, Sellebra, Dasher, etc.) has accumulated state that v2.5 didn't create. The brownfield path uses the same pattern across all three managed-resource layers (skills, AWS, integrations).

### 32.1 The brownfield audit plan

Operator runs the brownfield audit as a special plan kind (or as part of a rigor-upgrade plan, §4.1). The plan has fixed epics:

```yaml
plan:
  kind: brownfield-audit
  epics:
    - 'SKILL-SCOUT brownfield (T3): scan code for skill-implied patterns, propose skill manifest'
    - 'ARCHITECT brownfield (T3): scan AWS account tagged with project slug, propose AWS manifest'
    - 'ARCHITECT brownfield (T3): scan code for outbound HTTP / SDK imports, propose integrations manifest'
    - 'Generate CDK that imports existing resources via cdk import (no recreation)'
    - 'Verify Layer A → Layer B credential chain works for the project'
    - 'First commit: initial three manifests + CDK + IAM scaffolding'
```

After brownfield audit lands, all subsequent plans modify the manifests rather than the running infra directly.

### 32.2 cdk import — the magic

CDK supports `cdk import`, which lets the manifest become the source of truth for _existing_ resources without recreating them. ARCHITECT generates CDK code that declares the resource, then runs `cdk import` to associate the stack with the existing AWS state. From that commit forward, all changes flow through the pipeline.

### 32.3 Rigor upgrade plans gain ARCHITECT brownfield epic

Per Part I §4.1, rigor-upgrade plans gain an ARCHITECT brownfield epic (and a SKILL-SCOUT one). For mvp → production additionally:

- "Migrate from shared to dedicated AWS account (if approved)."
- "Configure GitHub Actions OIDC for keyless CI deploys."
- "Enable production deploy gate (audit + soak + approval)."
- "Set up cost-envelope thresholds, drift detection schedule."

---

# Part IV — Managed Resources

The pattern that recurs through v2.3 and v2.4 — and that any future v2.6 / v2.7 add-on will follow:

> **A managed resource is: a manifest + a resolver agent + a trigger map + a lifecycle + a rigor matrix.**

v2.5 has three instances:

| Layer                               | Manifest                                 | Resolver    | What it manages                         |
| ----------------------------------- | ---------------------------------------- | ----------- | --------------------------------------- |
| **Skills** (v2.3)                   | `.claude/skills.manifest.yaml`           | SKILL-SCOUT | Capabilities the project has            |
| **AWS infrastructure** (v2.4)       | `.deployment/aws.manifest.yaml`          | ARCHITECT   | Cloud resources the project runs on     |
| **Third-party integrations** (v2.4) | `.deployment/integrations.manifest.yaml` | ARCHITECT   | External vendors the project depends on |

The skill manifest pins the **capabilities** the project has. The deployment manifests pin the **resources** the project has. Each plan typically touches one or the other; some touch both. The operator sees one combined card either way.

|                     | Skills                         | AWS infra                               | Integrations                                               |
| ------------------- | ------------------------------ | --------------------------------------- | ---------------------------------------------------------- |
| Resolver agent      | SKILL-SCOUT                    | ARCHITECT                               | ARCHITECT                                                  |
| Source registry     | Federation manifest            | AWS Organizations + project IAM         | Per-vendor (Stripe dashboard, Moises portal, …)            |
| Pin granularity     | commit SHA                     | service definition + sizing             | secret-path + endpoint + planned-status                    |
| Update cadence      | weekly refresh                 | weekly drift detection                  | daily vendor-changelog scan                                |
| Distillation source | repeated patterns across plans | repeated infra patterns across projects | repeated vendors across projects (graduate to org-default) |

This part covers Skills in depth. Part V covers AWS infrastructure and integrations in depth (because both are resolved by ARCHITECT and share many mechanics).

## 33. Skills — what they are and why they're managed

A skill is a portable folder of `SKILL.md` + scripts + references that an agent loads on demand to become competent at a specialized task. Skills are _not_ fixed tools or fixed prompts. They're the frontier where agent capability grows.

**Skills are a managed resource for a project, not a one-time install.** They have lifecycle, scope, version, and rigor — like any other piece of infrastructure.

### 33.1 The architectural bets specific to skills

- **Selection is an agent decision** — not an operator chore. SKILL-SCOUT proposes; operator confirms.
- **Skills grow organically** — from registries, distillation of recurring patterns, and hand-authored bundles.
- **Skills are queryable** — `Skills-Used:` line in commit metadata answers "which commits leaned on `frontend-design`?"

## 34. The skill taxonomy — six kinds, three scopes

### 34.1 Six kinds

| Kind        | Purpose                                                                                           | Examples                                                            |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **core**    | Document and format primitives every project needs. Pinned by Anthropic. Permanent and global.    | docx, pdf, xlsx, pptx, frontend-design, skill-creator               |
| **stack**   | Best practices for a specific framework or platform. Project-scoped, version-pinned.              | React, Next.js, Supabase, Convex, Expo, Tailwind, Bedrock           |
| **process** | How-to-work skills. Lives in operator's home dir.                                                 | TDD, debugging, parallel agents, code review, brainstorming         |
| **domain**  | Business or vertical knowledge. Authored internally.                                              | KassenSichV/fiskaly, music theory, GDPR audit, debate orchestration |
| **vendor**  | Single-vendor integrations. Verified before install.                                              | Stripe, Sentry, Mailchimp, Moises, Memgraph                         |
| **plan**    | Speculative skills, just one plan's lifetime. May graduate to project on success — or be retired. | authored just-in-time                                               |

**Deliberately not in the taxonomy:** no demo or tutorial skills in production; no `personal` kind (operator favorites live in `~/.claude/skills`); no "always-on for everything" beyond the core set — every other skill must justify itself against a concrete project intent.

### 34.2 Three scopes

```
operator                      project                       plan
~/.claude/skills              .claude/skills/               .claude/skills/<plan-id>/
process kind                  stack, domain, vendor         plan kind (ephemeral)
my style across projects      this project's stack          this plan's experiments
```

The progression `plan → project → operator` is the skill **graduation path**, parallel to git's `wip → main → tag`. Same idea: ephemeral becomes durable through observed value.

## 35. The skill federation — registry of registries

The pipeline doesn't search the internet. It searches a manifest.

### 35.1 The federation manifest

```yaml
# ~/.futurator/skill-federation.yaml — operator-level, applies to all projects
sources:
  - id: anthropic-official
    url: https://github.com/anthropics/skills
    auto-trust: true
    priority: 1
  - id: futurator-internal
    url: https://github.com/futurator/futurator-skills
    auto-trust: true
    priority: 2
  - id: vercel-web
    url: https://github.com/vercel/skills
    auto-trust: true
    priority: 3
  - id: stripe-official
    url: https://github.com/stripe/skills
    auto-trust: true
    priority: 4
  - id: zxkane-aws
    url: https://github.com/zxkane/aws-skills
    auto-trust: true
    priority: 5
  - id: community
    url: https://github.com/anthropics/skills-community
    auto-trust: false # always requires operator confirm
    priority: 99
refresh-cadence: weekly
```

Most teams treat skills as a one-shot ceremony; the federation turns the install set into declared infrastructure that the daemon reconciles continuously.

### 35.2 What the federation gives the pipeline

- **A single resolver.** Walks sources in priority order, returns the first match meeting auto-trust policy.
- **A trust boundary.** `auto-trust: false` sources always require operator confirmation — a viral 100k-install skill can't silently land in your manifest.
- **A refresh cadence.** The daemon polls each source weekly, emits attention items when relevant skills get a new version.

## 36. The project skill manifest

Every project carries:

```
.claude/skills.manifest.yaml
```

Equivalent of `package-lock.json` — machine-generated, reproducible, lockfile semantics. Operators don't edit by hand; they edit by interacting with SKILL-SCOUT.

```yaml
# Songster's manifest, illustrative
project: songster
manifest-version: 1
generated-by: skill-scout@v2.5

core:
  - source: anthropic-official
    skill: frontend-design
    version: sha:a3f9c2e

stack:
  - source: vercel-web
    skill: vercel-react-best-practices
    version: tag:v2.4.1

domain:
  - source: futurator-internal
    skill: music-theory-engine
    version: sha:7b22a91

vendor:
  - source: stripe-official
    skill: stripe-checkout
    version: tag:v3.2.0

plans:
  songster-v2-storyboard:
    skills:
      - skill: lead-sheet-generator
        graduate-policy: on-plan-success # plan-success | always | never

gaps:
  - need: 'Demucs v4 ECS Fargate runbook'
    encounters: 3
    suggested-action: author-via-skill-creator
```

### 36.1 Why a manifest beats a one-shot install

- **Reproducibility** — clone, run `npx skills sync`, get the exact skill state that produced main.
- **Diffability** — every addition shows up in `git diff` with rationale.
- **Rigor enforcement** — a production plan can't proceed if a `rigor-min` skill is missing.
- **Garbage collection** — daemon reconciles disk against manifest on startup.

### 36.2 Federation policy: what's pinned at the org level

- **Skills monorepo:** `futurator-skills` (single repo, semver tags per skill — `<skill-name>@<semver>`). Per-skill repos would multiply CI infrastructure 10× without buying anything.
- **MCP server registry:** private CodeArtifact in `eu-central-1`. `@futurator/mcp-*` packages are not published to public npm — wrappers contain assumptions about IAM patterns, Memgraph schema, and Bedrock routing specific to the Futurator account.
- **MCP transport:** in-process for daemon-state tools (job control, plan transitions); stdio for external service wrappers (Stripe, Moises). The security boundary matters more than uniformity.
- **Tool deprecation cadence:**

| Rigor      | Behavior on `@<skill>@2.x` ships breaking changes                      |
| ---------- | ---------------------------------------------------------------------- |
| prototype  | auto-upgrade on next plan start                                        |
| mvp        | auto-upgrade on next plan start, attention item flagged                |
| production | pin to 1.x, deprecation warnings emitted, manual upgrade plan required |

A `deprecate-by` date in the registry; production projects past that date get an attention item every 7 days.

- **CDK language pin:** TypeScript only, federation-wide. Reasoning: agents already operate fluently in TS; CDK constructs publish to the same CodeArtifact alongside `@futurator/ui`; one language for both runtime and infra.

## 37. SKILL-SCOUT — the resolver agent

Sonnet by default; Opus when search depth matters.

### 37.1 Responsibilities

- **Resolve.** Reads plan intent + project stack + federation, ranks candidates with rationale.
- **Verify.** Fetches each `SKILL.md` and checks license, freshness, description collisions.
- **Surface.** Renders a decision card; on confirm, edits the manifest and commits as `Agent: SKILL-SCOUT`.
- **Apply.** On operator confirmation, manifest is rewritten and committed. CDK regenerates if any of the new skills imply infra changes.

### 37.2 Boundaries

- **It never installs unilaterally.** Every change is surfaced for confirmation under mvp+ rigor.
- **It doesn't use skills.** DEV consumes the skills SKILL-SCOUT installs.
- **It can't override the declined list** without an explicit clear.

### 37.3 Authoring missing skills

When the federation has no fit and a gap has been hit ≥ 3 times, SKILL-SCOUT spawns a sub-plan: "author this skill via skill-creator." The sub-plan runs the full v2.2 story pipeline — TEST writes pressure scenarios, DEV writes `SKILL.md`, REVIEWER judges. On success, the new skill registers in `futurator-internal`.

The encounters counter is auditable via commit metadata: COMPILER emits `Skill-Encounter: <skill-name> attempt:<n>` whenever an encounter is logged, so `git log --grep="Skill-Encounter:"` reconstructs the full history.

## 38. SKILL-SCOUT trigger map

Eight triggers, three categories. Mirrors ARCHITECT's structure (Part V §27).

| Category           | Trigger                      | When                                           | Behavior                                                                                |
| ------------------ | ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Initialization** | T1: project init             | Project init scaffolding plan starts           | Full federation sweep, all kinds. Operator confirms proposal.                           |
| **Initialization** | T2: plan intent submitted    | Every new plan, before PM decomposition        | Targeted resolve against intent. Auto-confirm under prototype; surface card under mvp+. |
| **Initialization** | T3: brownfield audit         | Operator runs `/skills audit` on existing repo | Reports against current code; never auto-installs.                                      |
| **Speculation**    | T4: PM speculation flagged   | PM emits a speculation marker                  | SKILL-SCOUT proposes candidates per `explore/` branch.                                  |
| **Speculation**    | T5: new dependency added     | A commit lands a new `package.json` entry      | Search for `<dep>-best-practices` skill.                                                |
| **Reactive**       | T6: REVIEWER repeats failure | Same area rejected ≥ 3 stories in a wave       | Search for a skill addressing the cluster.                                              |
| **Reactive**       | T7: stream graduates to plan | Stream → Labs plan transition (Part III §25.4) | Re-run SCOUT on the now-crystallized intent.                                            |
| **Periodic**       | T8: weekly refresh           | Federation poll                                | New versions, newly popular skills, deprecations.                                       |

## 39. The skill lifecycle — eight steps

Mirrors v2.2's story pipeline. Production rigor — full ceremony. Lower rigor strips steps.

```
1. resolve            agent     SKILL-SCOUT walks federation, ranks candidates
2. verify             shell     fetch SKILL.md, check license, freshness, description collisions
3. propose            agent     render decision card with rationale
4. confirm            operator  confirm / decline / defer
5. install            shell     update manifest, vendor skill into .claude/skills/, commit (Agent: SKILL-SCOUT)
6. validate           shell     manifest sync test (npx skills sync && expect zero diff)
7. announce           shell     emit Skills-Used line on next commit; CLAUDE.md notes new skill
8. retire             shell     when manifest entry removed: clean local copies, tombstone in CLAUDE.md
```

Step 1 is the only LLM step in steady state. Everything else is deterministic.

## 40. Skills in commit metadata

v2.2 made commit metadata the durable structure for intent reconstruction. v2.3 adds two lines so any commit can be queried by the skills that were live when it was generated:

```
Skills-Used: frontend-design@anthropic-official,
             vercel-react-best-practices@vercel-web,
             music-theory-engine@futurator-internal
Skills-Manifest-Sha: a3f9c2e
```

`Skills-Manifest-Sha` lets a hotfix branch reproduce the exact skill set the original release used. Without it, hotfixing a six-month-old release means guessing.

### 40.1 Queries this enables

```bash
# Every commit where music-theory-engine was active
git log --grep="Skills-Used:.*music-theory-engine"

# Delta evidence: before vs after a skill was added
git log --grep="Skills-Used:.*frontend-design" --since="2026-04-01"

# REVIEWER rejections grouped by skill set (signal for skill effectiveness)
git log --grep="Agent: REVIEWER" --grep="rejected" --all-match \
  | grep -A 3 "Skills-Used:"
```

## 41. Distillation — skills emerge from observed practice

The most distinctive pattern in v2.3. Skills are not only discovered upstream — they grow from inside the codebase.

> If you've solved the same problem three times, the pipeline notices and asks if you want to package the solution.

### 41.1 Distillation signals COMPILER watches for

- Same helper script appears in ≥ 2 plans → strong signal · bundle into a skill.
- Same architectural pattern repeats ≥ 3 times → medium signal · skill or CLAUDE.md entry.
- Same multi-step REVIEWER fix sequence repeats → strong signal · the fix sequence _is_ the skill.
- Recurring naming or testing convention in stream branches → medium signal · likely CLAUDE.md.

### 41.2 Auto-distillation by rigor

| Rigor      | Behavior on encounter ≥ 3     |
| ---------- | ----------------------------- |
| prototype  | manual (operator triggers)    |
| mvp        | manual (operator triggers)    |
| production | auto-spawn skill-creator plan |

When auto-spawn fires: SKILL-SCOUT creates a sub-plan with the gap's `suggested-action`, the plan runs through the full story pipeline at production rigor, and on green merge the new skill registers in `futurator-internal`.

### 41.3 Cross-project propagation

When a project promotes a project-local skill to org-wide (via REFLECTOR proposal — Part VI §44), the weekly federation refresh proposes it to other Futurator projects whose stack matches. Example: `ecs-fargate-gpu-audio-pipeline` distilled from Songster gets proposed to goMAD (also fargate, also audio).

## 42. Skill rigor matrix

| capability                      | prototype | mvp         | production               |
| ------------------------------- | --------- | ----------- | ------------------------ |
| core skills installed           | ✓         | ✓           | ✓                        |
| auto-trust stack auto-installs  | ✓         | opt-confirm | confirm                  |
| non-auto-trust source           | confirm   | confirm     | confirm + license review |
| vendor skills                   | ✓         | ✓           | supply-chain review      |
| auto-distill at encounters ≥ 3  | manual    | manual      | auto                     |
| `Skills-Used` in commit         | optional  | required    | required                 |
| `Skills-Manifest-Sha` in commit | optional  | required    | required                 |
| manifest in branch protection   | —         | ✓           | ✓ + signed               |
| skill-as-speculation            | —         | —           | ✓                        |
| version pin to SHA              | —         | required    | required                 |

Two notes worth calling out: production pins to commit SHA, not branch (skills drift; SHAs don't). Production vendor skills also get a one-time supply-chain review.

## 43. Skill speculation

v2.2 introduced `explore/` branches for parallel approach exploration. v2.3 generalizes it: a speculation can be over the _skill set_ rather than the implementation choice.

Each branch's worktree gets its own `skills.manifest.yaml`. DEV/TEST/REVIEWER run with those skills active. EVALUATOR reads both branch tips, applies the winner rule, and merges the winner's skill choice along with its code.

> Sometimes the implementation isn't the variable — the skill is. Two reasonable Stripe integrations may both work; the question is which one produces a more idiomatic, smaller, safer implementation when given to the same agent.

Production rigor only.

---

# Part V — AWS Deployment and Third-Party Integrations

v2.4's central work: AWS infrastructure and third-party integrations are first-class managed resources — declared, planned, deployed, drifted-against, cost-tracked, torn down — within the same agent-ruled, human-on-exception model.

## 22. Account strategy

Single Futurator AWS account, all projects, IAM-isolated. Everything in this part is designed to be future-proof: when a project graduates beyond the shared model (e.g. a client engagement requires hard isolation), the migration path exists but it's not the default.

The architectural choices that make this future-proof:

- **Per-project IAM role names are account-prefix-aware:** `futurator-project-<slug>-role` works in either single-account or multi-account.
- **Secrets Manager paths use a `/futurator/<project>/` prefix** that survives a future account split.
- **Daemon credential resolution reads "current account" from config**, never hard-coded.
- **Project slugs are globally unique** (Part I §2), so they uniquely identify resources in any account model.

A future migration plan (probably v2.6 or v2.7) will define the shared → dedicated path. For now, single account, IAM isolation is the model.

### 22.1 Client-project escape hatch

Client projects (Contax, cayambe.de, future engagements) can override the default at project init by declaring a different account:

```yaml
# .deployment/aws.manifest.yaml
account-strategy: dedicated
account-id: '<client-aws-account-id>'
account-role-arn: 'arn:aws:iam::<client>:role/futurator-deploy'
```

The pipeline assumes the client-supplied role and treats that account as the project's runtime. All other mechanics are unchanged.

## 23. The credential model — three layers, never static

This is the most important section in Part V. Once you accept the design, everything else falls out naturally.

### 23.1 Layer A — Daemon execution (broad, persistent)

The daemon runs on EC2 with an attached **instance profile** (`futurator-daemon-instance-profile`). The role behind it has:

- `sts:AssumeRole` on every per-project role (Layer B).
- Read on the federation manifest (an S3-stored copy).
- Read on `arn:aws:secretsmanager:eu-central-1:<acct>:secret:/futurator/_pipeline/*` (the daemon's own secrets — GitHub PAT, npm token, etc.).
- **No direct access to project resources. None.**

The instance profile is rotated automatically by AWS; nothing the operator manages. The daemon's process never sees an access key — the SDK reads credentials from IMDS on every request.

### 23.2 Layer B — Per-project role (scoped, persistent)

Each Futurator project has a role: `futurator-project-<slug>-role`. Trust policy permits `sts:AssumeRole` from Layer A and from operator IAM Identity Center sessions. Permission policy is project-shaped:

```yaml
# Songster's project role permission policy (illustrative)
- Effect: Allow
  Action: [dynamodb:*]
  Resource:
    - arn:aws:dynamodb:eu-central-1:<acct>:table/songster-*

- Effect: Allow
  Action: [s3:*]
  Resource:
    - arn:aws:s3:::songster-*
    - arn:aws:s3:::songster-*/*

- Effect: Allow
  Action: [ecs:DescribeServices, ecs:UpdateService, ecs:RunTask]
  Resource: arn:aws:ecs:eu-central-1:<acct>:service/songster-*

- Effect: Allow
  Action: [secretsmanager:GetSecretValue]
  Resource:
    - arn:aws:secretsmanager:eu-central-1:<acct>:secret:/futurator/songster/*

- Effect: Deny # explicit boundary
  Action: '*'
  Resource:
    - arn:aws:s3:::futurator-* # any other futurator project's S3
  Condition:
    StringNotLike:
      'aws:RequestedRegion': ['eu-central-1', 'us-east-1']
```

**Wildcard scoping by resource prefix is the discipline.** Every project resource starts with the project slug; the project role's policy explicitly grants only that prefix.

A worktree starts by assuming the project role:

```bash
# At worktree creation, the daemon emits this into the worktree's environment
export AWS_PROFILE=futurator-songster-runtime

# ~/.aws/config stanza (managed by daemon, not by hand):
# [profile futurator-songster-runtime]
# role_arn = arn:aws:iam::<acct>:role/futurator-project-songster-role
# credential_source = Ec2InstanceMetadata
# region = eu-central-1
```

Inside the worktree, every `aws ...` call automatically uses the project role. No manual `aws configure`, no static keys.

### 23.3 Layer C — Plan-scoped ephemeral session (production only)

For production-rigor plans, the daemon goes one further: when a story starts, the daemon assumes the project role with a session name `plan-<plan-id>-story-<story-id>` and a session policy that narrows further to the resources this plan declares it will touch.

The story's worktree receives those credentials via a one-time write to `~/.aws/credentials.<story-id>` with mode 0600, and the worktree's environment exports `AWS_SHARED_CREDENTIALS_FILE` to that path.

When the story completes (success, failure, timeout), the credentials file is deleted. STS sessions self-expire (default 1h, max 12h), so even if the file leaks, credentials self-destruct.

The session policy is generated from the plan's `aws.manifest.yaml` delta — if the plan only adds a new DynamoDB table to the songster service, the session policy permits `dynamodb:CreateTable` / `UpdateTable` on `songster-*` and nothing else. **The smaller the plan's scope, the smaller the credential blast radius.**

### 23.4 Why the three layers

- **Layer A** must exist because the daemon needs _some_ identity to bootstrap. Instance profiles are the only credential source AWS rotates without operator action.
- **Layer B** must exist because a single AWS account hosts many Futurator projects, and a leaked Songster transcript should not be able to read Atlassinator's database.
- **Layer C** exists because under production rigor, _even within a project_, individual plans should not have project-wide blast radius. A plan that "adds a column to one table" should not have rights to delete every table.

Lower rigor relaxes Layer C — prototype/mvp use Layer B directly with no per-plan session narrowing. Production rigor mandates all three.

### 23.5 Operator interactive access

The operator never types static IAM access keys.

```bash
# One-time setup on the laptop, per AWS account
aws configure sso \
    --profile futurator-admin \
    --use-device-code

# Daily use — one login, all profiles refresh
aws sso login --sso-session futurator
# Now every profile is good for ~8 hours; cached in ~/.aws/sso/cache/

# Acting as the project role from the laptop
aws s3 ls --profile futurator-songster-admin
```

For SSH'd terminal sessions on the daemon's EC2:

```bash
source /home/ubuntu/.futurator/scope-to.sh songster
# Sets AWS_PROFILE=futurator-songster-runtime, sets PROJECT_DIR, etc.
# Now the terminal is "scoped to" Songster
```

Stream branch CLAUDE.md (Part III §25.1) carries:

> You are operating in the Songster project. Your AWS calls use the `futurator-songster-runtime` profile, scoped to Songster resources only. Do not export environment variables that change `AWS_PROFILE`; do not attempt to assume other roles. If you need cross-project access, file an attention item.

Defense in depth: convention + IAM trust policies + `Deny *` on other projects. A stream agent that goes rogue cannot escape the project boundary even by invoking the AWS CLI directly.

### 23.6 Forbidden by policy

- Static IAM access keys, anywhere. The daemon's policy and the operator's policy both deny their use.
- Credentials in environment variables outside `AWS_PROFILE` or `AWS_SHARED_CREDENTIALS_FILE`.
- Long-lived federated tokens (> 12h).

## 24. The deployment taxonomy

Six resource kinds, each with a distinct mechanical purpose. Anything not on this list should not exist in a project's deployment surface.

| Kind                   | Purpose                                                                                                                                              | Lifetime                                         | Owner           | Drift-checked?             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------- | -------------------------- |
| `aws-shared`           | Resources used by every environment of a project: VPC, base IAM roles, ECR repos, Secrets Manager namespace                                          | Permanent                                        | Project         | yes, weekly                |
| `aws-env`              | Environment-specific stacks (dev / staging / production): ECS services, Lambdas, DynamoDB tables, S3 buckets, CloudFront distributions, API Gateways | Tied to env's lifecycle                          | Project         | yes, weekly                |
| `aws-ephemeral`        | Per-SHA preview stacks (when previewing the backend, not just frontend) — production rigor only with `preview-backend: true`                         | Hours to 24h                                     | Plan            | no (too short-lived)       |
| `aws-env-demo`         | Persistent demo envs promoted from `aws-ephemeral` (Part III §30.2)                                                                                  | Until torn down                                  | Project         | yes                        |
| `aws-glue`             | Cross-stack wiring: Route53 records, ACM certs, CloudFront origin-access controls, Cognito user pools shared across envs                             | Long-lived                                       | Project         | yes                        |
| `integration-vendor`   | A declared third-party API used by the project (Stripe, Moises.ai, Sentry, Mailchimp, fiskaly, Voyage AI, Memgraph Cloud)                            | Plan-bounded for new ones; permanent once stable | Plan or project | webhook health, not config |
| `integration-internal` | A Futurator-internal service this project depends on (e.g. Mycelium GraphRAG endpoint, IndexForge embeddings)                                        | Long-lived                                       | Org             | yes                        |

**Not in the taxonomy** (deliberately):

- No "manual" or "console-managed" resources. Production rigor forbids any AWS resource that wasn't placed by CDK. Drift detection (§30) catches and surfaces violations.
- No region sprawl. A Futurator project pins one primary region (`eu-central-1` by default for GDPR; `us-east-1` only for global CloudFront ACM certs which must live there). Adding a region is a planned action, not a side effect.
- No long-running EC2 instances except the pipeline daemon itself. Workloads run as ECS Fargate tasks, Lambdas, or container services.

## 25. The AWS infrastructure manifest

```
<project>/.deployment/aws.manifest.yaml
```

Schema (Songster, illustrative):

```yaml
project: songster
manifest-version: 1
generated-by: architect@v2.5
last-resolved: 2026-04-26T14:00:00Z

aws-organization: futurator
account-strategy: shared
primary-region: eu-central-1
us-east-1-cert-only: true

iac:
  tool: cdk
  language: typescript
  version: ^2.140.0
  bootstrap-qualifier: futurator
  app-entrypoint: deployment/cdk/bin/songster.ts

shared:
  vpc:
    strategy: shared # use the Futurator shared VPC
    subnets:
      project-prefix: songster
      mode: dedicated-subnets # per-project subnets within shared VPC
    security-group-prefix: songster
  ecr:
    repos: [songster-api, songster-stems-worker]
  secrets-namespace: /futurator/songster

environments:
  dev:
    domain: songster-dev.futurator.ai
    cdk-stacks: [SongsterSharedStack, SongsterDevStack]
    services:
      - kind: ecs-fargate
        name: songster-api
        cpu: 512
        memory: 1024
        desired: 1
      - kind: ecs-fargate-gpu
        name: songster-stems-worker
        cpu: 4096
        memory: 16384
        gpu: 1
        desired: 0 # scale-to-zero with EventBridge wakeups
        skill-required: ecs-fargate-gpu-audio-pipeline
      - kind: dynamodb
        name: songster-sessions
        partition-key: sessionId
        billing: pay-per-request
      - kind: s3
        name: songster-stems-dev
        lifecycle: { transition-to-ia-days: 30, expire-days: 90 }
      - kind: bedrock-model-access
        models:
          - anthropic.claude-sonnet-4-20250514-v1:0
          - anthropic.claude-haiku-4-5-20251001-v1:0
        provisioned-throughput: false # on-demand; ARCHITECT files attention if cost crossover hits

  staging:
    domain: staging.futurator.ai/songster
    cdk-stacks: [SongsterSharedStack, SongsterStagingStack]
    services: # similar to dev, with desired: 1 minimum

  production:
    domain: songster.futurator.ai
    cdk-stacks: [SongsterSharedStack, SongsterProdStack]
    deploy-gate:
      requires:
        - all-tests-pass
        - security-audit-clean
        - 24h-staging-soak
        - operator-approval
    services: # production-sized

webhook-handler-default: lambda # alternative: ecs (per-project override)

cost-envelope:
  dev: { monthly-usd-max: 80 }
  staging: { monthly-usd-max: 150 }
  production: { monthly-usd-max: 600, alert-at: 480 }
  hard-cap-action: page-operator

drift-policy:
  detection: weekly
  on-drift: file-attention-item # never auto-revert
```

The manifest is the **declared state**. CDK in `deployment/cdk/` is the **derived state** — generated from the manifest by COMPILER.

### 25.1 Why a manifest plus CDK, not just CDK

Three reasons:

1. **Reviewability.** A YAML diff is faster to review than a CDK diff for high-level questions like "did this plan add Redis? did it shrink the dev environment?" The CDK diff still happens (§31 step 6) — the manifest diff is the entry point.
2. **Cost calculation.** Cost models work better against declared intent than against synthesized CloudFormation. The manifest tells the cost engine "1 Fargate task, 4 vCPU, 16GB RAM, 1 GPU, desired=0 with EventBridge wakeups"; that's enough to estimate without running `cdk synth`.
3. **Cross-project queries.** "How many Futurator projects use Bedrock right now?" is a one-line YAML grep across manifests. Asking the same against CDK code requires synthesis or AST parsing.

The manifest is to AWS what `package.json` is to `node_modules` — declared intent that the toolchain expands.

### 25.2 Why CDK is the default IaC

| Tool                 | Verdict                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CDK (TypeScript)** | ✅ Real TypeScript — agents read, refactor, generate. ✅ AWS-native; new services have constructs day-one. ✅ `cdk diff` excellent for review. ✅ State managed by AWS (no Terraform backend to babysit). ✅ Skills exist (`zxkane/aws-skills`, `aws-cdk-development`). ✅ Bedrock support good. ❌ Locked to AWS. |
| Terraform            | ✅ Cross-cloud. ❌ State backend operational overhead. ❌ HCL less expressive than TS for agent refactors.                                                                                                                                                                                                         |
| Pulumi               | ✅ Real code. ❌ Smaller AWS-only ecosystem. ❌ State + license complexity.                                                                                                                                                                                                                                        |
| SST                  | ✅ Excellent serverless DX. ❌ Opinionated; harder to escape for long-running Fargate or Bedrock provisioned throughput.                                                                                                                                                                                           |
| SAM                  | ✅ AWS-native. ❌ YAML; serverless-only.                                                                                                                                                                                                                                                                           |

CDK's biggest property for an agent-ruled pipeline: **the IaC is real code with a synthesis step**. COMPILER reads the manifest, writes the CDK, the synthesizer produces predictable CloudFormation. The agent never reasons about CloudFormation directly — it reasons in TypeScript constructs.

`iac.tool` field exists for the future case where Terraform or Pulumi wins out for a specific project. Today, `cdk` is universal.

## 26. The third-party integrations manifest

Sibling file, looser semantics:

```
<project>/.deployment/integrations.manifest.yaml
```

Schema (Songster, illustrative):

```yaml
project: songster
manifest-version: 1
rotation-cadence-default: 90d # project-wide default

integrations:
  - id: moises-api
    vendor: moises.ai
    purpose: stem separation, chord detection (premium tier alongside self-hosted Demucs)
    rigor-min: mvp
    secret-path: /futurator/songster/{env}/moises-api/api-key
    rotation-cadence: 90d # falls through to project default
    endpoints:
      dev: https://api.moises.ai/sandbox/v1
      staging: https://api.moises.ai/v1
      production: https://api.moises.ai/v1
    skill: null # gap — see v2.3 §10
    cost-model:
      type: per-call
      estimated-monthly-usd: { dev: 5, staging: 15, production: 200 }
    contract: null # opt out for simple HTTP integration
    health-check:
      kind: webhook-callback
      endpoint: https://{domain}/api/_health/moises
    introduced-in: songster-v1-stem-pipeline
    deprecation: null

  - id: stripe
    vendor: stripe
    purpose: subscription billing for premium Songster tier (planned v2)
    rigor-min: production
    secret-path: /futurator/songster/{env}/stripe/secret-key
    publishable-key-path: /futurator/songster/{env}/stripe/publishable-key
    endpoints:
      dev: https://api.stripe.com (test mode keys)
      staging: https://api.stripe.com (test mode keys)
      production: https://api.stripe.com (live mode keys)
    skill: stripe-checkout@stripe-official
    webhooks:
      - event: invoice.paid
        path: /api/webhooks/stripe/invoice-paid
        handler-kind: lambda # default; ECS opt-in if complex routing
    cost-model:
      type: percent-of-revenue
      stripe-fee: 0.029-plus-0.30-eur
    introduced-in: songster-v2-billing
    status: planned
    deprecation: null

  - id: bedrock
    vendor: aws
    purpose: chord detection narration, Song Storyboard explanations
    rigor-min: prototype
    iam-managed: true
    models-used:
      - anthropic.claude-haiku-4-5-20251001-v1:0
      - anthropic.claude-sonnet-4-20250514-v1:0
    cost-model:
      type: per-token
      estimated-monthly-usd: { dev: 10, staging: 30, production: 200 }
    skill: aws-agentic-ai@zxkane-aws

  - id: fiskaly
    vendor: fiskaly
    purpose: KassenSichV TSE compliance for cayambe.de POS
    rigor-min: production
    rotation-cadence: 30d # PCI-DSS: shorter than project default
    secret-path: /futurator/cayambe/{env}/fiskaly/api-key
    skill: kassensichv-fiskaly@futurator-internal
    contract: '@futurator/fiskaly-contract@1.0.0'

  - id: mycelium
    vendor: futurator-internal
    purpose: GraphRAG project intelligence for Songster context
    type: integration-internal
    rigor-min: prototype
    contract: '@futurator/mycelium-contract@1.0.0'
    endpoints:
      dev: https://mycelium-dev.futurator.ai
      production: https://mycelium.futurator.ai
```

### 26.1 What's intentionally looser than the AWS manifest

- **No version pins** for the vendor side (their API versions are out of our control). The manifest tracks the vendor's _advertised stable version_, but truth is at the vendor.
- **No drift detection** for endpoints. If Stripe migrates an endpoint, the integration manifest is updated by an operator-led plan, not by the daemon.
- **`status: planned`** entries are allowed. An integration can be declared before any code touches it — useful for capacity planning and for ARCHITECT to know intended shape.
- **`{env}` placeholder** in `secret-path` resolved at runtime, letting one declaration cover dev/staging/production.

### 26.2 Why this should be looser

Vendors change. Stripe deprecates an API endpoint. Moises adds a new model. Sentry replaces an SDK. The pipeline should not block on these changes — it should track them in the manifest and let plans adapt.

The discipline this manifest enforces is **visibility, not control**. Every external dependency has a name, a purpose, an estimated cost, a secret path, and a planned-introduction plan. Leaks ("oh, we're also calling this random API?") become impossible.

### 26.3 Service contracts for internal integrations

`integration-internal` services (Mycelium, IndexForge, future Futurator-internal services) **default to typed service contracts**. The integration manifest pins the contract package version (`@futurator/mycelium-contract@1.0.0`); consumer code imports types from it. Compile-time errors when shape changes.

Trivial internal services (single-endpoint webhook receivers, event bus publishers with no shape complexity) can opt out with `contract: null`.

`integration-vendor` services don't get contracts (vendor APIs are out of our control).

### 26.4 Webhook handler shape

`webhook-handler-default: lambda` is the project-wide default. ECS is opt-in per integration when:

- Multi-vendor router with retries, idempotency, fan-out to multiple downstream services.
- Complex stateful routing logic that benefits from persistent process.
- Real local-repro debugging matters.

The simple case (Stripe → enqueue to SQS) is two lines of Lambda code. Don't over-engineer.

### 26.5 Secrets rotation cadence

Project-wide default at the manifest root (`rotation-cadence-default: 90d`). Per-integration override in the integration entry (`rotation-cadence: 30d`). Override wins when present; ARCHITECT enforces.

T7 trigger fires when an integration's secret reaches its rotation deadline (Part V §27).

## 27. ARCHITECT — the resolver agent for AWS + integrations

A new agent role. Model: Opus by default for high-leverage decisions (T1, T3); Sonnet for incremental updates after first deploy (T2, T5, T7).

### 27.1 Responsibilities

1. **Resolve plan intent → manifest deltas.** Given plan intent, project's stack (skill manifest from v2.3), and current AWS + integrations manifests, propose adds / modifies / deprecations.
2. **Estimate cost.** For every proposed delta, compute estimated monthly cost change using the cost engine (§28). Surface monthly delta in the decision card.
3. **Surface to operator.** Render decision card: _"For plan X I propose: add ECS Fargate service `songster-stems-worker` with GPU (eu-central-1, +€180/mo), add Stripe integration with secret path /futurator/songster/{env}/stripe/secret-key, add webhook handler in songster-api. Reasons: …"_
4. **Apply.** On confirm, edit both manifests, regenerate CDK code (delegating to COMPILER), commit under `Agent: ARCHITECT`, push to main.
5. **Verify.** Run `cdk synth` and `cdk diff` against dev environment; if diff is non-empty, show it; if synth fails, the apply step rolls back.
6. **Coordinate with SKILL-SCOUT.** A new AWS service in the manifest may imply a skill the project doesn't have yet (Bedrock implies `aws-agentic-ai`, Fargate-GPU implies `ecs-fargate-gpu-audio-pipeline`). ARCHITECT files an inter-agent message to SKILL-SCOUT, which runs its own resolve cycle.

### 27.2 Boundaries

- **It does not deploy.** Deployment is a separate step (§31) after both manifests are committed.
- **It does not edit CDK by hand.** CDK is generated from the manifest. If the operator wants a non-manifest construct, they edit the manifest, not the CDK.
- **It does not assume project-role credentials directly.** ARCHITECT runs as the daemon (Layer A), using the daemon's read-only manifest view. Actual `cdk diff` and `cdk deploy` calls run in the per-plan worktree under Layer C.

### 27.3 Where it sits in the pipeline

```
operator submits plan intent
  → PM agent receives intent
  → PM dispatches SKILL-SCOUT (T2) for skill changes
  → PM dispatches ARCHITECT (T2) for AWS + integrations changes (in parallel)
  → both surface decision cards (one combined card if changes overlap)
  → operator confirms (auto-confirm in prototype rigor)
  → both apply; CDK regenerated, manifests committed
  → PM continues with epic decomposition, now aware of the new stack shape
```

PM coordinates: when SKILL-SCOUT and ARCHITECT propose overlapping changes (adding Stripe both adds a skill and adds AWS resources for the webhook), PM combines them into one card.

## 28. ARCHITECT trigger map

Eight triggers, three categories. Mirrors SKILL-SCOUT (Part IV §38).

| Category           | Trigger                   | When                                                                             | Behavior                                                                                                                |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Initialization** | T1: project init          | Project init scaffolding plan starts                                             | Run Implementation Spec plan; emit initial manifests                                                                    |
| **Initialization** | T2: plan intent submitted | Every new plan, before PM decomposition                                          | Targeted resolve. One decision card if changes are needed; silent no-op if intent is purely application code            |
| **Initialization** | T3: brownfield audit      | Operator runs `/architect audit` on existing repo                                | Reverse-engineer manifests via `aws cloudformation describe-stacks` + tag scan; produce draft for operator confirmation |
| **Speculation**    | T4: cost-shape uncertain  | Plan intent has multiple architecturally distinct options ("Lambda or Fargate?") | Spawn `explore/` branches with different manifests; cost-and-perf evaluator decides                                     |
| **Reactive**       | T5: cost overrun          | Cost telemetry exceeds the manifest's envelope by ≥ 20% for 3 consecutive days   | File `cost-overrun` attention item; ARCHITECT proposes savings deltas                                                   |
| **Reactive**       | T6: drift detected        | Weekly drift scan finds resources in AWS not in the manifest, or vice versa      | File `drift-detected`; ARCHITECT proposes import or revert                                                              |
| **Reactive**       | T7: secret rotation due   | A secret has reached its rotation deadline                                       | File `secret-rotation-due`; ARCHITECT plans rotation, Secrets Manager handles actual rotation                           |
| **Periodic**       | T8: vendor change scan    | Daily check of `integrations.manifest.yaml` against vendor changelogs            | File `vendor-version-update-available` items                                                                            |

T2 is the workhorse — most plans don't need ARCHITECT to do anything (a frontend-only plan changes nothing in AWS). When ARCHITECT runs T2 and concludes "no infra changes," it silently no-ops. Most plans see no card.

T1 and T3 are the heavy lifters for new and brownfield projects respectively.

T4 is the cost/architecture parallel to v2.3 §14 skill-set speculation — the pipeline can A/B test infrastructure choices.

T5–T8 are continuous-state triggers. They keep the manifest honest against reality.

### 28.1 Bedrock provisioned vs on-demand auto-propose

Sub-trigger of T5: when on-demand monthly Bedrock cost ≥ 1.3× equivalent provisioned cost over a rolling 30-day window, ARCHITECT files an attention item: _"Bedrock cost ran €420 last month. Provisioned 1-month commitment for the same usage = €310. Switch?"_ Operator confirms or declines. **Never auto-applied** — provisioned commitments are real money locked up.

The cost engine needs to model the crossover (Infracost doesn't cover Bedrock). The custom shim is a federated cost-shim skill (§29).

## 29. The cost engine — federated cost shims as v2.3 skills

Infracost is the base; Futurator-specific cost gaps are filled by shim skills.

### 29.1 The pattern

```
cost-shim-bedrock          → federated skill that models Bedrock token usage from historical data
cost-shim-nat-gateway      → federated skill that models NAT gateway hours from VPC traffic patterns
cost-shim-data-transfer    → federated skill that models S3 / CloudFront egress
cost-shim-fargate-gpu      → federated skill that models GPU Fargate task hours
```

Each shim is a `SKILL.md` + script published in `futurator-internal`. When ARCHITECT computes a cost estimate, it:

1. Runs Infracost as the base.
2. For each declared resource that has a corresponding cost-shim, invokes the shim with the resource's manifest entry + the project's historical telemetry.
3. Sums the shim outputs into the Infracost base.

Output: a per-environment monthly USD estimate, with a `confidence` field (`high` / `medium` / `low`) based on how much historical data the shims had to work with.

### 29.2 Why federated shims

- Infracost is ~±10% accurate for most resources but misses Bedrock token usage, NAT gateway hours, S3/CloudFront egress.
- Hand-rolled per-project shims drift; every project re-implements them.
- Federated shims (skills in `futurator-internal`) are DRY. One implementation, all projects consume.
- Shim skills get distilled from real cost-comparison work in production projects (write the Bedrock shim once for Songster, reuse across goMAD, Mycelium, etc.).

### 29.3 The shim skill format

```yaml
# futurator-skills/cost-shim-bedrock/SKILL.md (frontmatter)
name: cost-shim-bedrock
type: cost-shim
applies-to: bedrock-model-access
inputs:
  - resource: bedrock-model-access entry from aws.manifest.yaml
  - telemetry: 30-day-token-usage from CloudWatch Logs Insights
outputs:
  - monthly_usd: estimated monthly cost
  - confidence: high | medium | low
```

The shim's `script.py` reads the manifest entry + telemetry, returns the estimate. Updated as Bedrock pricing changes (the `futurator-internal` repo PRs adjust the shim).

## 30. Drift detection and the daemon's infra GC

### 30.1 Cost monitoring (T5 trigger)

Daily cost query per project, comparing actual spend against the manifest's `cost-envelope`. Three thresholds:

- Below `monthly-usd-max`: silent.
- Between `alert-at` and `monthly-usd-max`: low-severity attention item, suggesting savings ("scale-to-zero songster-stems-worker on weekends").
- Above `monthly-usd-max`: critical attention item; `hard-cap-action` triggers (default: page operator).

### 30.2 Drift detection (T6 trigger)

Weekly: the daemon runs `cdk diff` against every project's environments using Layer A → Layer B credentials. Non-empty diff means actual state differs from declared state. Causes:

- **Operator made a console change.** Drift item with action: "import to manifest, or revert."
- **AWS auto-modified something** (AMI updates, IAM service-linked role propagation). Usually safe to ignore once acknowledged.
- **A previous deploy half-failed.** Re-deploy or manually reconcile.

The pipeline never auto-reverts drift. Operator decides — same human-on-exception discipline as the rest of the pipeline.

### 30.3 The infra GC pass

On daemon startup, in addition to v2.2's worktree GC and v2.3's skill manifest reconciliation, the daemon:

```
12. For each project: read aws.manifest.yaml; verify CDK code synthesizes
    without error; if not, file 'manifest-out-of-sync-with-cdk' attention item
13. For each integration in each project: verify the secret-path exists in
    Secrets Manager; if not, file 'secret-missing' attention item (do NOT
    auto-create — secrets need real values from operator)
14. For each project: verify the project IAM role's trust policy permits the
    daemon's instance profile; if not, file 'iam-trust-broken' (blocks all deploys)
15. List ECS services tagged with project slugs but not in any project's
    manifest: file 'orphan-resource' items (operator decides import or destroy)
16. Resume polling
```

Same pattern as the worktree GC and skill GC — declared vs observed state, surface inconsistencies, never silently "fix."

## 31. The deploy lifecycle — 10 steps

For production rigor — full ceremony. Lower rigor strips steps.

```
 1. architect-resolve         agent     ARCHITECT reads intent + current manifests + skill manifest;
                                         produces proposed deltas with rationale; commits a proposal
                                         note to .deployment/proposals/. Agent: ARCHITECT.
 2. architect-cost-estimate   shell     For each proposed delta, query cost engine (Infracost +
                                         federated cost-shims). Reject deltas breaching hard-cap
                                         without operator override.
 3. architect-surface         agent     Attention dock renders combined decision card: manifest
                                         diff + cost delta + skill implications. Operator confirms /
                                         declines / edits.
 4. architect-apply           shell     Update aws.manifest.yaml and integrations.manifest.yaml,
                                         regenerate CDK via COMPILER, write secrets-bootstrap runbook
                                         entries for any new secrets, commit (Agent: ARCHITECT,
                                         with Skills-Used + Skills-Manifest-Sha).
 5. cdk-synth                 shell     Verify CDK app compiles. Produces CloudFormation locally,
                                         no AWS side effects yet. Failures roll back step 4.
 6. cdk-diff-dev              shell     Show what would change in dev. Diff attached to the plan's
                                         review thread (visible to REVIEWER for plans touching deploy
                                         code).
 7. cdk-deploy-dev            shell     Apply the dev stack. Layer C credentials assumed for the
                                         deploy duration. Failure → CloudFormation rolls back;
                                         attention item if rollback itself fails.
 8. integration-smoke         agent     Thin agent task that exercises changed surfaces (HTTP 200
                                         from new endpoints, DynamoDB Get/Put round-trip, ECS task
                                         starts cleanly). Sanity check, not a full test suite.
 9. cdk-diff-prod             shell     On plan completion (status=review), show the plan tag's
                                         diff against current production stack. Operator sees this
                                         when promoting plan tag to semver tag.
10. cdk-deploy-prod           shell     On semver tag creation, apply to production. Subject to
                                         the production deploy gate (audit + soak + approval).
                                         Layer C credentials, scoped to plan.
```

Steps 1–6 happen _before_ the plan's epics decompose — part of the architectural-design step preceding implementation. Step 7 happens at the start of `developing` (application code is now writing against deployed dev infra). Steps 8–10 happen during review/promotion.

### 31.1 Per-step retry budgets

| Step                | Retries                                 | On exhaustion                                                                 |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `architect-resolve` | 1 (parse failure of cost engine output) | attention `architect-cost-engine-failed`                                      |
| `cdk-synth`         | 0 (deterministic; surface and rollback) | high `cdk-synth-failed`                                                       |
| `cdk-deploy-dev`    | 1 (transient AWS errors)                | high `cdk-deploy-dev-failed`                                                  |
| `cdk-deploy-prod`   | 0 (always escalates)                    | critical `cdk-deploy-prod-failed`. Operator decides rollback or roll-forward. |

## 32. Environments × stacks mapping

```
aws-shared                 → <Project>SharedStack            (1 instance per project, all envs)
aws-env (dev)              → <Project>DevStack               (1 per project)
aws-env (staging)          → <Project>StagingStack           (1 per project)
aws-env (production)       → <Project>ProdStack              (1 per project)
aws-env-demo               → <Project>Demo-<n>Stack          (per persisted demo)
aws-glue                   → <Project>GlueStack              (1 per project, often empty)
aws-ephemeral (preview)    → <Project>Preview-<sha>Stack     (created on push, destroyed in 24h)
```

Stacks deployed in dependency order (Shared → Glue → env-specific). CDK handles ordering automatically when stacks declare cross-stack references. The pipeline's deploy step iterates the dependency graph.

## 33. VPC and networking

Single shared VPC for all projects in the Futurator account, per-project subnets and security groups.

```
futurator-shared-vpc
├── public subnets (3 AZs)        — ALBs, NAT gateways
├── private subnets (3 AZs)
│   ├── songster-private-*        — ECS tasks for Songster
│   ├── gomad-private-*           — ECS tasks for goMAD
│   └── …
└── isolated subnets (3 AZs)      — DynamoDB VPC endpoints, Bedrock VPC endpoints
```

NAT gateway count: 1 (cost-optimized) by default. Production rigor and projects with HA requirements bump to 2-per-AZ via the manifest.

**Security-group isolation between subnets.** Each project's SGs allow ingress from its own ALB and from Futurator-wide observability (CloudWatch agents). Cross-project SG ingress is denied.

### 33.1 Regulated-data exception

Projects handling regulated data — Contax (VAT records), cayambe.de (POS transactions per KassenSichV) — get **their own VPC** declared at project init:

```yaml
shared:
  vpc:
    strategy: dedicated
    cidr: 10.50.0.0/16
    nat-gateways: 2 # per-AZ for HA
```

Compliance blast-radius requirements override cost optimization. The pipeline supports both; project init's first card asks for the choice when regulated data is declared.

## 34. CDK bootstrap

CDK requires per-account bootstrap. The Futurator bootstrap:

```bash
cdk bootstrap aws://<acct>/eu-central-1 \
  --qualifier futurator \
  --toolkit-stack-name FuturatorCDKToolkit
```

The `qualifier` namespace lets multiple bootstrap stacks coexist if needed. All Futurator project CDK apps reference this bootstrap.

### 34.1 GitHub Actions OIDC

GitHub Actions assumes deploy roles via OIDC — no static keys in CI. The bootstrap creates:

```yaml
# Per-project OIDC role
RoleName: futurator-deploy-<project-slug>
TrustPolicy:
  - Principal: arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com
    Condition:
      StringEquals:
        token.actions.githubusercontent.com:sub: 'repo:futurator/<project-slug>:ref:refs/heads/main'
```

CI workflows assume the role:

```yaml
# .github/workflows/deploy-prod.yml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::<acct>:role/futurator-deploy-songster
    aws-region: eu-central-1
```

For non-GitHub CI (CodeBuild, GitLab CI): out of scope for v2.5. Deferred until a real consumer exists. Any project that wants non-GitHub CI files an attention item; the pipeline supports it as a v2.6 work item.

## 35. The sandbox account

A separate AWS account `futurator-sandbox` for skill experiments and SKILL-SCOUT operations that involve AWS calls. Weekly Nuke (using `aws-nuke`) keeps it clean.

When SKILL-SCOUT proposes a skill that involves AWS calls (a new MCP wrapper, a new cost shim), the verification step runs in the sandbox account by default. Production AWS calls require explicit operator approval to use the real account.

This prevents misbehaving skills from racking up real costs or touching real data while being tested.

## 36. The 24h staging soak — what counts as success

For production deploys, the manifest's deploy-gate `requires: 24h-staging-soak` mandates a soak period. Concrete pass criteria — soak passes iff _all_ of:

1. **Synthetic traffic flowing for the full 24h** (rate ≥ 1 req/min on critical paths, defined per project in the manifest's deploy-gate config).
2. **Error rate below threshold** (default 0.5%, project override allowed).
3. **p99 latency below SLO** (per-endpoint, defined in `aws.manifest.yaml` under `slo:` per-environment).
4. **No drift** detected during soak (CDK diff returns clean against stack at start of soak).
5. **No P1/P2 alerts fired** (CloudWatch alarms in alarm state count as failure).
6. **Cost trajectory consistent with envelope** (24h projected to 30d cost ≤ envelope × 1.1).

Soak failure → attention item with the specific check that failed; operator decides retry or rollback.

## 37. Cost-history track on rigor changes

When a project changes rigor, its cost envelope changes (e.g. €5/mo prototype → €100/mo production). Append-only `cost-history.yaml` at project root captures the deltas:

```yaml
- date: 2026-04-01
  rigor: prototype
  envelope: 5
  actual_30d_avg: 3.4
- date: 2026-05-15
  rigor: production
  envelope: 100
  actual_30d_avg: 87.2
  promoted_from: prototype
- date: 2026-06-01
  rigor: production
  envelope: 100
  actual_30d_avg: 92.1
  quarterly_review: true
```

Append on every rigor change and every quarterly review. Quarterly review reads the history and surfaces "rigor X cost €Y on average over its lifetime" — useful for planning future projects and justifying production-rigor cost to clients.

---

# Part VI — The Reflection Loop (the knowledge ratchet)

The brownfield loop closes "feedback → fix." The reflection loop closes **"experience → improved next time."** Without it, every plan starts from the same baseline.

## 38. The REFLECTOR agent

A read-mostly, write-proposal agent. Sonnet by default.

### 38.1 When it runs

| Trigger                                     | Rigor           | Frequency          | Output                                                                                         |
| ------------------------------------------- | --------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| Story completes (status → `done`)           | production only | per-story          | Light reflection: 1–2 line "what would have helped me" note appended to `inbox/reflections.md` |
| Wave completes                              | all rigors      | per-wave           | Wave reflection: consolidated proposals (CLAUDE.md edits, skill candidates)                    |
| Plan transitions `delivered` (first time)   | all rigors      | once per plan      | Plan reflection ceremony: full proposal set, operator review required                          |
| Plan transitions `delivered` after `fixing` | all rigors      | once per fix-cycle | Brownfield reflection: "what did this fix teach us about the original plan?"                   |

Light reflection at story level only fires for production rigor — too expensive otherwise, and prototype/mvp move too fast for per-story value.

REFLECTOR runs on a **dedicated low-priority daemon slot** that wakes on quiet windows (no plans in `developing` for ≥10 min). Wake schedule: opportunistic, with a hard floor of "at least once per 24h if there's been any plan activity since last reflection."

### 38.2 Tool gates

`Read, Grep, Glob, Bash` (for `git log`, `git diff` only — via MCP wrapper, not raw shell). **No `Write` or `Edit`** — REFLECTOR produces _proposals_ in a structured format; only operator's Accept actually mutates anything. Enforced via `--disallowedTools "Write,Edit,NotebookEdit,Bash"` plus an MCP wrapper that exposes only the read-side git verbs.

### 38.3 Cost cap — diff-only reflection

A full plan-close reflection on a 50-story plan could be 30–50K input tokens. Cap via the inbox state itself: REFLECTOR reads the existing reflections inbox to know what's already been proposed, only reflects on what's new since the last reflection's `last-seen-sha`. Naturally caps token cost and prevents duplicate proposals.

```yaml
# inbox/reflections.md frontmatter
last-seen-sha: a3f9c2e
last-reflection-at: 2026-04-26T14:00:00Z
proposals:
  - …
```

REFLECTOR's first action every run: read this frontmatter, run `git log --since=$last-reflection-at` to get only new commits.

### 38.4 Output format

```
---REFLECTION---
PLAN_ID: <id>
SCOPE: story | wave | plan | brownfield-cycle
SUMMARY: <2-3 sentence "what just happened, what's worth keeping">

PROPOSALS:
- target: project-claude-md
  action: append-section | replace-section | append-line
  section: "Patterns to avoid"
  content: |
    Don't put React state inside `useEffect`-only refs when you also
    need it to drive re-renders. We hit this in story E2-S3.
  rationale: <why this is worth promoting>
  confidence: 0.9

- target: project-skill
  action: create
  skill_name: "vite-base-path"
  one-liner: "Set vite base path for nested deploys"
  body: |
    When deploying to /apps/<n>/, set base in vite.config.ts and
    BASE_URL handling in router. Common mistake: forgetting to update
    the asset path resolver in custom loaders.
  evidence: [storyIds where this would have helped]
  confidence: 0.8

- target: agent-persona
  action: append
  persona: "dev"
  content: |
    Before writing tests, check if the plan has rigor=prototype. If so,
    skip integration tests and rely on visual tests.
  rationale: <...>
  confidence: 0.7

- target: org-skill
  action: promote-from-project
  source_skill: "vite-base-path"
  source_project: <plan_id>
  rationale: |
    This is the third plan in 6 weeks where the same vite base-path
    confusion has surfaced. Time to lift to org-wide.
  confidence: 0.95

- target: pipeline-config
  action: tune
  setting: "max-turns.dev"
  current: 10
  proposed: 12
  rationale: |
    DEV hit the turn cap on 4 of 12 stories in this plan. Median was 7.
    Pattern correlates with stories that touch multiple modules.
    Suggest bumping the cap or splitting such stories at PM time.
  confidence: 0.7

- target: tool-wrapper
  action: propose
  pattern: "aws ecs describe-services --cluster <c> --services <s> --query 'services[0].deployments'"
  recurrences: 47
  failure-rate: 0.18
  score: 5874
  proposed-name: "@futurator/mcp-ecs/describe-deployments"
  rationale: |
    Score = 47 × 100 × (1 + 0.18 × 4) = 5874 > threshold 5000.
    Failures dominate — wrapping captures the right invocation pattern.

---END_REFLECTION---
```

### 38.5 The wrap-it threshold

REFLECTOR proposes wrapping a Bash pattern as an MCP tool when:

```
score = repetitions × avg_input_tokens × (1 + failure_rate × 4)
threshold: 5000
```

A 200-token AWS invocation that fires 5 times with 0% failures = 1000, no wrap. Same invocation with 50% failures = 5000, wrap. A 20-token `gh pr list` repeated 50× with 0% failures = 1000, no wrap. 50× with 50% failures = 5000, wrap. **The failure-rate weight (×4) is the key — repeated mistakes are the strongest wrap-it signal.**

## 39. Reflection security

A compromised REFLECTOR could propose a malicious skill that operator rubber-stamps. Defense:

### 39.1 Baseline (v2.5)

- Every REFLECTOR proposal renders as a **unified diff** against current state. Operator must see the diff.
- Skill proposals additionally show the proposed `SKILL.md` text and any scripts in full.
- Pre-flight check: REFLECTOR cannot propose a skill whose `entrypoint` runs commands outside an allowlist (`["npm", "pnpm", "uv", "python", "node", "bash <local-script>"]`). Anything else gets flagged for manual review.
- Operator never approves blind. Inbox UI shows the diff prominently.

### 39.2 Phase-2: REFLECTOR-REVIEWER

Production rigor only, deferred to v2.6 work:

- A second LLM (Haiku, read-only) validates each proposal before it hits the inbox.
- Checks: does the skill match its description? Are the commands plausible for the stated purpose? Are there obvious supply-chain red flags (curl-piping-bash, network calls during install)?
- REVIEWER outputs a verdict that ships with the proposal in the inbox.

## 40. The Reflection Inbox

Same component family as the Feedback Inbox. The interaction model is identical (proposal → diff → confirm/decline/defer). Operator sees:

- The proposal as a unified diff.
- The rationale.
- The confidence score.
- The provenance (which plan/story produced it).
- For skill proposals: the full `SKILL.md` and any scripts.
- For org-promotion proposals: the skill's history (which plans used it, what evidence supports promotion).

Three actions:

- **Confirm** — applies the diff. Commit `Agent: REFLECTOR-APPLY` runs to land it.
- **Decline** — proposal goes to declined list. REFLECTOR doesn't re-propose.
- **Defer** — proposal stays in inbox; can be revisited.

## 41. Project CLAUDE.md as living document

The most important promotable target. CLAUDE.md starts from boilerplate template and grows.

### 41.1 Template (in `futurator-starter/CLAUDE.md`)

```markdown
# Project: {{ project.displayName }}

> **Slug:** {{ project.slug }}
> **Rigor:** {{ project.rigor }}
> **Created:** {{ project.createdAt }}
> **Repo:** {{ project.repo }}

## What this is

<!-- PM agent populates from project intent -->

## Architecture decisions

<!-- Append-only. Each entry: date — decision — rationale — proposed by -->

## Constraints discovered

<!-- REFLECTOR promotes things like "this client doesn't allow third-party fonts" -->

## Patterns to use

<!-- Project-specific patterns. REFLECTOR promotes from "what worked" -->

## Patterns to avoid

<!-- REFLECTOR promotes from "what hurt" -->

## Domain glossary

<!-- PM seeds; subsequent agents append -->

## Skills loaded by default for this project

<!-- Pointer file. Lists project-local skills + relevant org-wide skills -->

## AWS scoping reminder

<!-- For stream branches: which AWS profile to use, scope reminder -->

## Known issues / future enhancements

<!-- REFLECTOR promotes from "future-enhancement" proposals -->
```

### 41.2 Who writes what

| Section                            | Initial author                               | REFLECTOR can propose          | Operator approves               |
| ---------------------------------- | -------------------------------------------- | ------------------------------ | ------------------------------- |
| What this is                       | PM agent at project init                     | corrections after pivot        | yes                             |
| Architecture decisions             | DEV agent (append-only on milestone)         | promotion to "Patterns to use" | yes (for promotions)            |
| Constraints discovered             | any agent (append)                           | summary at plan close          | yes                             |
| Patterns to use / avoid            | REFLECTOR only                               | yes                            | yes                             |
| Domain glossary                    | PM seeds, all agents append                  | merge dupes, surface conflicts | yes (for merges)                |
| Skills loaded by default           | REFLECTOR                                    | yes                            | yes                             |
| AWS scoping reminder               | from boilerplate, customized at project init | rare                           | yes                             |
| Known issues / future enhancements | REFLECTOR                                    | yes                            | (always pending until acted on) |

CLAUDE.md is committed to the project repo. It's _the_ hand-off document for any human or agent picking up the project.

### 41.3 Loaded into every agent session

The daemon reads `CLAUDE.md` at session start and prepends it to the agent's system prompt. Every DEV/QA/REFLECTOR/etc. agent for this project starts with accumulated wisdom. **The context pack from Part II §11 is appended after CLAUDE.md** — CLAUDE.md is the _narrative_ (why), the context pack is the _substrate_ (what).

## 42. Persona evolution

BMAD personas (Bedrock, Nimbus, Docker Harbor, Rick) live in `.bmad/<persona>.md`. REFLECTOR proposes additions like "for prototype rigor, prefer faster feedback over thorough tests."

Persona changes are the **highest-bar promotions** — they affect every future plan that uses that persona. Operator approval is required regardless of confidence. Diff is reviewed in the Reflection Inbox.

Versioning: each persona file is committed to the org `futurator-personas` repo with semantic versions. Plans pin a persona version at creation. Updating a persona doesn't retroactively change running plans.

**No persona forking.** Skill federation makes per-project persona variants unnecessary — a "TTS-aware Dev" is just DEV with `audio-pipeline` and `tts-cloning` skills loaded. The persona's prompt stays singular; capability variation lives in the skill manifest.

## 43. Cross-plan triage learning

Triage agent (which feeds bugfix plans from feedback) reads `inbox/triage-history.md` from prior plans across all projects. Always read, weighted by project relevance:

```
relevance_score = base_similarity × project_match_modifier

project_match_modifier:
  same project:         1.0
  same product family:  0.7   (Songster main + Songster live-perf)
  same org:             0.4   (cross-product Futurator)
```

Triage prompt instructed to surface top 3 by score, with project provenance shown. Operator can downweight noisy cross-product matches via a "this isn't relevant" flag that decays the modifier for that specific case-pair.

## 44. Skill lifecycle — project-local → org-wide promotion

Skills follow a two-tier promotion path:

**Tier 0 — Inline pattern.** Lives in CLAUDE.md "Patterns to use." Cheap. No skill file. Agent reads it via system prompt.

**Tier 1 — Project skill.** Folder in `.claude/skills/<n>/SKILL.md` with optional helper files. Loaded only by sessions for this project. Created when:

- A pattern is referenced 3+ times in CLAUDE.md.
- A pattern requires examples or templates that don't fit inline.
- REFLECTOR proposes it explicitly with confidence ≥ 0.7.

**Tier 2 — Org-wide skill.** Lives in `futurator-skills` (the monorepo with semver tags per skill). Distributed via the federation. Promoted when:

- The same project skill exists in 3+ projects.
- REFLECTOR explicitly proposes promotion (`target: org-skill, action: promote-from-project`).

Demotion is also possible — if an org skill hasn't been used in any new plan in 90 days, REFLECTOR flags it for review.

### 44.1 Skill structure (matches Anthropic skill format)

```
.claude/skills/<n>/
├── SKILL.md              # name, description, when-to-use, instructions
├── examples/             # optional example artifacts
├── templates/            # optional templates
└── meta.json             # { version, createdAt, lastUsedAt, evidenceJobIds[] }
```

`meta.json` lets REFLECTOR compute "how often is this skill helping" — `evidenceJobIds` accumulates jobs that loaded this skill and completed successfully.

## 45. Inter-agent memory stores

Three scopes, file-backed (migrating to MA memory stores when MA arrives):

```
/mnt/memory/
├── futurator-org/                        # READ-ONLY org-wide
│   ├── brand-voice.md
│   ├── bmad-conventions.md
│   ├── aws-patterns.md
│   └── known-pitfalls.md
│
├── project-<slug>/                       # READ-WRITE for project agents
│   ├── CLAUDE.md                         # the living document
│   ├── decisions.md                      # append-only architecture log
│   ├── glossary.md                       # domain terms
│   ├── known-issues.md                   # things still broken / deferred
│   └── skills/                           # project-local skills
│
└── inbox/                                # READ-WRITE inter-agent comms
    ├── pm-to-dev.md                      # PM hands off intent + decisions
    ├── dev-to-reviewer.md                # DEV describes what they did
    ├── reviewer-to-qa.md                 # REVIEWER flags edge cases
    ├── qa-to-deploy.md                   # QA confirms readiness
    ├── triage-history.md                 # Triage learnings (across plans!)
    ├── reflections.md                    # All reflection notes (across plans)
    └── decisions.md                      # Cross-agent decision log
```

Each agent writes to its own outbox file at session end. Next agent in chain reads it at session start.

---

# Part VII — Operator Surface

## 46. The decision card

The atomic unit of operator interaction. A card has:

- **Title.** Short, plan-scoped: _"Plan songster-v2-storyboard — review proposed manifest changes."_
- **Manifest diff** (when applicable) — color-coded YAML diff.
- **Cost delta** (when applicable) — per-environment monthly USD change.
- **Skill implications** (when applicable) — which skills will be installed/upgraded/removed.
- **Rationale** — why ARCHITECT/SKILL-SCOUT proposed this.
- **Actions:** Confirm / Decline / Edit / Defer.

When ARCHITECT and SKILL-SCOUT both propose changes for the same plan, **PM combines them into one card.** Operator sees one decision, not two parallel ones.

The "smoothness number" goal: ≤ 4 operator decision cards from "I want to build X" to "X is live in production with auth and observability." The dino worked example (Appendix E) hit this number.

## 47. Attention items

Severity × category. The taxonomy is the union of v2.0–v2.4 lists, summarized in Part I §6.2 and detailed in Appendix C.

### 47.1 Item structure

```yaml
id: attn-2026-04-26-14-32-001
severity: high
category: retry-exhausted
created-at: 2026-04-26T14:32:00Z
plan: songster-v2-storyboard
story: E3-S5
context:
  retry_count: 3
  last_failure: |
    Test failed: storyboard-renderer.test.ts > "renders chord overlay"
    Expected: <ChordOverlay chord="Am7" />
    Received: <ChordOverlay />
suggested-actions:
  - 'Open story E3-S5 diff'
  - 'Restart story (clears retry count)'
  - 'Mark wave as fixing, edit acceptance criteria, retry'
  - 'Mark story as blocked, manually implement'
status: open
```

### 47.2 Item lifecycle

```
open → acknowledged → resolved
                   → declined  (operator chose not to act)
                   → escalated (severity bumped)
```

Items auto-archive 30 days after resolution.

## 48. The attention dock

Single UI surface listing all open attention items, grouped by severity. Critical items pin to top with a notification badge. Each item is a tap-through to the decision card.

Items have a default suggested action — clicking it triggers the action immediately. Other actions live behind a kebab menu. The point is single-tap resolution for the common case.

## 49. The Reflection Inbox

Same component family as the attention dock. Items here are REFLECTOR proposals (not failures); the action set is Confirm / Decline / Defer.

## 50. The runbook

A few shapes of operator interaction worth illustrating:

### 50.1 Starting a project

```
Operator: "I want to build a music analysis tool called Songster."

Pipeline (decision card):
  Project: songster
  Repo: futurator/songster (private)
  Rigor: prototype (default; can be promoted later)
  Account: shared (default; client projects can override)
  AWS region: eu-central-1
  Initial skills: core (frontend-design, skill-creator, etc.)

Operator: Confirm

Pipeline:
  - gh repo create futurator/songster --template ...
  - bootstrap-project.sh runs
  - PM agent initializes CLAUDE.md
  - SKILL-SCOUT runs T1 → proposes stack skills (vercel-react, etc.)

Pipeline (decision card):
  Stack skills proposed: vercel-react-best-practices, audio-utilities-base
  Cost impact: $0/mo (no infra changes)
  Operator: Confirm

Pipeline:
  - First commit lands
  - Project is live at songster-dev.futurator.ai (placeholder)
```

### 50.2 Adding a feature

```
Operator: "Add a Song Storyboard view that shows chords over time."

Pipeline (PM decomposition + ARCHITECT T2 + SKILL-SCOUT T2 in parallel):
  Plan: songster-v2-storyboard
  Kind: feature
  Rigor: inherits project (prototype)
  Epics: E1 storyboard data model, E2 timeline UI, E3 chord overlay, E4 export
  No infra changes (frontend only)
  No new skills

Operator: Start

Pipeline runs to completion, deploys to dev, plan tag created.
```

### 50.3 Promoting rigor

```
Operator: Promote Songster to production.

Pipeline (decision card):
  Rigor: prototype → production
  This will run a rigor-upgrade plan with the following epics:
  - Backfill tests (target ≥60% coverage)
  - Run SKILL-SCOUT brownfield audit
  - Run ARCHITECT brownfield audit
  - Configure dev/staging/production deploy targets
  - Set up cost-envelope thresholds
  - Configure drift detection
  - Configure GitHub Actions OIDC for keyless CI deploys
  - Audit IAM policies for least-privilege violations
  Cost impact: dev unchanged, +€80 staging, +€420/mo production capacity

Operator: Confirm

Pipeline runs the rigor-upgrade plan at the outgoing rigor (prototype, this last time).
On completion, future plans run at production rigor.
```

### 50.4 Hotfix

```
Operator: "Production has a chord-detection bug. Tickets piling up."

Pipeline:
  - Triage agent reads feedback inbox, classifies as bug
  - PM creates plan kind: hotfix
  - Branches off the latest production semver tag (not main)
  - Skips PO/QA gates by design
  - DEV implements, TEST writes a regression test, REVIEWER passes
  - hotfix/ branch merges to main + cherry-picks to release/v1
  - Bumps semver patch, deploys to production via gate

Operator: Approve production deploy
```

---

# Part VIII — Implementation Phases

Sequenced incrementally on top of what's currently implemented. Each phase is reversible.

## 51. Phase A — Inner-loop discipline (already partially shipped)

If not all of these are in place yet, finish them — they make every subsequent phase cheaper.

| #    | Item                                                               | Effort |
| ---- | ------------------------------------------------------------------ | ------ |
| A.1  | Boilerplate `futurator-starter` v1.0                               | 3 days |
| A.2  | Tool allowlists per agent (`--allowedTools` / `--disallowedTools`) | 1 day  |
| A.3  | Bootstrap step (`scripts/bootstrap-project.sh`)                    | ½ day  |
| A.4  | Context pack injection (`scripts/build-context-pack.sh`)           | 1 day  |
| A.5  | Baseline regression gate                                           | 1 day  |
| A.6  | API-AUTHOR step (frozen `.d.ts`)                                   | 2 days |
| A.7  | Tamper-check + frozen-file pre-commit hook                         | 1 day  |
| A.8  | Turn caps + single-pass verification                               | ½ day  |
| A.9  | Explore-subagent output caching                                    | ½ day  |
| A.10 | Metrics emission to `metrics.csv`                                  | 1 day  |

**Phase A total: ~11 days. Unlocks every subsequent phase.**

## 52. Phase B — Git substrate

| #    | Item                                                                          | Effort |
| ---- | ----------------------------------------------------------------------------- | ------ |
| B.1  | Repo creation from template at project init (replaces blank init)             | 1 day  |
| B.2  | Daemon git bootstrap, branch-per-story `wip/`, commits with metadata template | 3 days |
| B.3  | Per-story worktrees                                                           | 2 days |
| B.4  | Wave merge with `--no-ff`, full test re-run                                   | 1 day  |
| B.5  | DDB-backed merge lock                                                         | 1 day  |
| B.6  | Plan tag → semver tag promotion path                                          | 1 day  |
| B.7  | Branch protection by rigor (incl. `pr-mode: true` modifier)                   | 1 day  |
| B.8  | Stream branches + auto-archive at 30d idle                                    | 1 day  |
| B.9  | Daemon GC pass on startup                                                     | 1 day  |
| B.10 | Speculation infrastructure (`explore/`, EVALUATOR agent)                      | 3 days |
| B.11 | `experiment/` namespace for prototype-on-top plans                            | 1 day  |
| B.12 | Hotfix branches off production tag                                            | 1 day  |

**Phase B total: ~17 days. Unlocks Parts III–V.**

## 53. Phase C — Skills (managed resource v1)

| #   | Item                                                                                           | Effort |
| --- | ---------------------------------------------------------------------------------------------- | ------ |
| C.1 | Federation manifest spec + resolver                                                            | 2 days |
| C.2 | Project skill manifest schema + sync command                                                   | 1 day  |
| C.3 | SKILL-SCOUT agent + T1, T2, T3 triggers                                                        | 3 days |
| C.4 | Skills-Used + Skills-Manifest-Sha in commit metadata                                           | ½ day  |
| C.5 | T4–T8 triggers (speculation, dependency, REVIEWER feedback, stream graduation, weekly refresh) | 3 days |
| C.6 | Auto-distillation signals in COMPILER                                                          | 2 days |
| C.7 | Skill-creator sub-plan automation                                                              | 2 days |
| C.8 | Cross-project propagation via weekly refresh                                                   | 1 day  |
| C.9 | MCP server private CodeArtifact registry (`@futurator/*`)                                      | 2 days |

**Phase C total: ~17 days.**

## 54. Phase D — AWS + integrations (managed resource v2)

| #    | Item                                                               | Effort |
| ---- | ------------------------------------------------------------------ | ------ |
| D.1  | Credential layers A + B (instance profile, per-project roles)      | 2 days |
| D.2  | `aws.manifest.yaml` schema + parser                                | 1 day  |
| D.3  | `integrations.manifest.yaml` schema + parser                       | 1 day  |
| D.4  | CDK bootstrap with `futurator` qualifier                           | ½ day  |
| D.5  | GitHub Actions OIDC roles per project                              | 1 day  |
| D.6  | ARCHITECT agent + T1, T2, T3 triggers                              | 4 days |
| D.7  | COMPILER extension to generate CDK from manifest                   | 3 days |
| D.8  | Implementation Spec plan template (5 epics)                        | 2 days |
| D.9  | Cost engine — Infracost base + first cost-shim skill (Bedrock)     | 3 days |
| D.10 | Layer C (per-plan ephemeral session)                               | 2 days |
| D.11 | T4 (cost-shape speculation)                                        | 2 days |
| D.12 | T5 (cost overrun) + T6 (drift detection) + T8 (vendor change scan) | 3 days |
| D.13 | T7 (secret rotation due)                                           | 1 day  |
| D.14 | Brownfield audit (`/architect audit`) for existing projects        | 3 days |
| D.15 | Production deploy gate (24h soak + audit + approval)               | 2 days |
| D.16 | `aws-env-demo` promotion path from `aws-ephemeral`                 | 1 day  |
| D.17 | Sandbox account integration for skill experiments                  | 1 day  |
| D.18 | Cost-history append-only track                                     | ½ day  |

**Phase D total: ~33 days.**

## 55. Phase E — Reflection loop

| #    | Item                                                         | Effort |
| ---- | ------------------------------------------------------------ | ------ |
| E.1  | Inter-agent memory stores (file-backed)                      | 1 day  |
| E.2  | REFLECTOR agent (wave + plan, propose-only writes)           | 3 days |
| E.3  | Reflection Inbox UI (reuse Feedback Inbox component)         | 2 days |
| E.4  | Project CLAUDE.md flow (PM populates, all agents append)     | 1 day  |
| E.5  | Skill promotion path (project → org-wide)                    | 2 days |
| E.6  | Triage agent + cross-plan history                            | 3 days |
| E.7  | Tool-wrap-it threshold scoring                               | 1 day  |
| E.8  | Persona evolution + versioning                               | 1 day  |
| E.9  | Pre-flight check on REFLECTOR proposals (allowlist commands) | 1 day  |
| E.10 | (Phase-2) REFLECTOR-REVIEWER for production rigor            | 2 days |

**Phase E total: ~17 days.**

## 56. Phase F — Brownfield migration

| #   | Item                                                                  | Effort                   |
| --- | --------------------------------------------------------------------- | ------------------------ |
| F.1 | Brownfield audit plan template (skills + AWS + integrations together) | 1 day                    |
| F.2 | `cdk import` for existing AWS resources                               | 2 days                   |
| F.3 | Rigor-upgrade plan auto-generation                                    | 1 day                    |
| F.4 | Migration runbook for each Futurator project (one-by-one)             | 2 days each × N projects |

**Phase F total: ~4 days fixed + ~2 days per existing project.**

## 57. Phase G — MA migration (eventual)

When Claude Managed Agents (MA) supports EU residency and the 30-day checkpoint TTL is acceptable:

| #   | Item                                                     | Effort |
| --- | -------------------------------------------------------- | ------ |
| G.1 | Memory stores → MA memory store                          | 3 days |
| G.2 | Vaults → MA vault per Futurator user                     | 2 days |
| G.3 | REFLECTOR + Triage to MA (read-mostly first)             | 5 days |
| G.4 | DEV agents to MA (last; the most working-tree state)     | 8 days |
| G.5 | Daemon retirement (event polling → Lambda + EventBridge) | 5 days |

Phase G is opt-in per project until EU residency + checkpoint TTL are solved.

## 58. Aggregate timeline

| Phase                            | Duration                                                 |
| -------------------------------- | -------------------------------------------------------- |
| A (inner-loop discipline)        | ~11 days                                                 |
| B (git substrate)                | ~17 days                                                 |
| C (skills)                       | ~17 days                                                 |
| D (AWS + integrations)           | ~33 days                                                 |
| E (reflection loop)              | ~17 days                                                 |
| F (brownfield migration)         | ~4 days fixed + 2/project                                |
| **Total to v2.5 fully realized** | **~99 days fixed, ~6 weeks calendar at 5 dev days/week** |
| G (MA migration)                 | ~23 days, opt-in per project, ongoing                    |

This is a solo-developer estimate. Real calendar time is longer because of context-switching, surprises, and the projects you're building _on top of_ the pipeline simultaneously.

---

# Part IX — Worked Examples

Two illustrative end-to-end walkthroughs. The first (dino) is the smoothest possible path through every layer at low rigor. The second (Songster billing) shows production rigor and skill+infra speculation working together.

The full dino narrative — including the exact decision-card text, manifests at every step, and commit metadata — lives in the v2 worked example doc retained in the project's history. This part summarizes the shape; consult the full doc for line-by-line operator interaction.

## 59. Dino — greenfield prototype to production

### 59.1 Scenario 1 — greenfield prototype

**Operator intent:** _"I want to prototype the Chrome offline dino game. Just the basic version: dino runs, jumps cacti, score increases over time."_

**Decision count:** 1 (the combined ARCHITECT + SKILL-SCOUT card at project init).

**Pipeline shape:**

```
operator → "new project dino, prototype rigor: <intent>"
  → daemon creates project in DDB; provisions futurator/dino repo from template
  → daemon emits Implementation Spec plan (kind: implementation-spec)
  → ARCHITECT (T1) + SKILL-SCOUT (T1) run in parallel
  → PM combines proposals into one card:
       AWS:  S3 (dino-static-dev) + CloudFront (dino-dev.futurator.ai)
             No backend (score in-memory at this rigor)
       Skills: frontend-design, web-design-guidelines, algorithmic-art, webapp-testing
       Cost: ~€2/mo dev
  → operator confirms (only decision they make during init)
  → manifests + CDK + GitHub Actions land in main
  → first deploy lives at dino-dev.futurator.ai
```

Two manifests + an empty integrations manifest land at project init. CLAUDE.md is generated by COMPILER from manifests + intent. Includes a deliberate "What's NOT here yet" section to anchor scope.

After the spec plan: a `feature` plan ("playable dino game") runs the story pipeline directly on main (prototype rigor allows direct commits). Stories cover game loop, sprite rendering, collision detection, score readout, start/game-over screens. Each story commits with the metadata template, `Skills-Used:` populated.

End of scenario 1: dino game live at `dino-dev.futurator.ai`, cost ~€2/mo, total operator decisions: 1 (project init confirm) + 1 (feature plan start) = 2 cards from "I want to prototype X" to "X is live."

### 59.2 Scenario 2 — brownfield feature add

**Operator intent (4 weeks later):** _"Add a leaderboard. Top 10 scores ever, stored persistently."_

**Decision count:** 1 (the combined ARCHITECT + SKILL-SCOUT card at plan-intent submit).

**Pipeline shape:**

```
operator submits intent
  → PM dispatches ARCHITECT (T2) + SKILL-SCOUT (T2)
  → ARCHITECT proposes:
       + dynamodb table dino-scores-dev (partition: scoreId, sort: -score)
       + lambda dino-api-submit-score (POST /scores)
       + lambda dino-api-list-scores (GET /scores/top)
       + api gateway dino-api-dev with two routes
       + IAM read/write on the table for both lambdas
       Cost delta: +€1.50/mo dev (DynamoDB pay-per-request, Lambda free tier)
  → SKILL-SCOUT proposes:
       + aws-lambda-best-practices@anthropic-official
       + dynamodb-modeling@futurator-internal
  → operator confirms combined card
  → manifests update; CDK regenerates; dev deploys
  → PM decomposes into 4 stories: API contracts, persistence, UI integration, end-to-end smoke
  → wave runs; lands on main; deploys
```

End of scenario 2: leaderboard live at dino-dev. Two new entries in `aws.manifest.yaml`, two new skills in `skills.manifest.yaml`. Total operator decisions: 1.

### 59.3 Scenario 3 — rigor promotion to production with auth

**Operator action:** _"Promote dino to production. Add Cognito auth so leaderboard scores are linked to authenticated players."_

This is the high-friction scenario that exercises the most of the pipeline.

**Decision count:** 4.

```
1. Operator initiates rigor promotion (prototype → production)
   → typed-string confirmation? No, this is upgrade not downgrade
   → daemon auto-generates rigor-upgrade plan (kind: rigor-upgrade)
   → plan runs at outgoing rigor (prototype, last hurrah)

2. ARCHITECT + SKILL-SCOUT brownfield audit cards (one combined)
   → proposes:
       + Cognito user pool dino-users
       + Lambda authorizer on api gateway routes
       + Add JWT validation skill: aws-cognito-jwt-auth@futurator-internal
       + Set cost-envelope hard caps: dev €15, staging €30, production €120
       + Enable drift detection (weekly)
       + Configure GitHub Actions OIDC for keyless deploys
       + Add 3 staging-soak SLO probes (load home page, submit score, get top)
       + Add Playwright e2e tests (target: top 5 user flows)
       + Add semver versioning (start at v1.0.0 once rigor-upgrade lands)
   → operator confirms

3. Plan runs through rigor-upgrade epics. New tests get backfilled. CI moves to required-status with e2e + build + security audit.
   At plan close: plan tag dino-plan-rigor-upgrade-prototype-to-production lands.

4. Operator promotes plan tag → semver tag dino-v1.0.0
   → 24h staging soak runs against staging.futurator.ai/dino
   → all 6 soak checks pass
   → operator approves production deploy
   → semver tag → cdk-deploy-prod → live at dino.futurator.ai
```

End of scenario 3: dino is in production with auth, persistence, observability, cost guardrails, and audited deploys. Total operator decisions across all three scenarios: ~6, covering project init, two feature/upgrade plans, and one production publish.

### 59.4 What dino exercises

| Layer                                         | Hit by dino                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Boilerplate (Part II §13)                     | yes — repo created from template                                                                                      |
| Story pipeline (Part II §9)                   | yes — all rigors observed across the three scenarios                                                                  |
| Tool gates (Part II §10)                      | yes — all agents run with their allowlists                                                                            |
| Worktrees + wave merge (Part III §24, §26)    | yes — once rigor moves past prototype                                                                                 |
| Speculation (Part III §28)                    | not in dino's three scenarios; would have if leaderboard had two architecturally distinct options                     |
| Skill federation + manifest (Part IV §35–§36) | yes — auto-trust sources, version pins, gap detection (none triggered)                                                |
| SKILL-SCOUT triggers T1, T2, T3               | yes — T1 at init, T2 at each plan, T3 in rigor-upgrade                                                                |
| AWS manifest + ARCHITECT (Part V §25, §27)    | yes — manifests grow; ARCHITECT runs T1 + T2 + T3                                                                     |
| Credential layers A + B + C                   | yes — A always, B once plans land, C on production-rigor stories                                                      |
| Cost engine (Part V §29)                      | yes — Infracost base hits on all three scenarios; no cost-shim needed for this stack                                  |
| Production deploy gate (Part V §36)           | yes — 24h soak in scenario 3                                                                                          |
| Reflection (Part VI)                          | yes — REFLECTOR runs at plan-close in each scenario; nothing critical to promote at this scale, but inbox accumulates |

The shape that matters: **few operator decisions, all of them at well-defined moments, none of them at routine work**. Every line of code in dino was committed by an agent with the right tools allowed, the right skills available, the right cost estimate accepted, and the right credentials at the right scope.

## 60. Songster — production-rigor, skill+infra speculation

This is the more complex example. Songster is already in production rigor (per the project's actual current state in 2026). A new plan needs to add Stripe billing for the premium tier.

### 60.1 Plan intent

_"Add Stripe subscription billing for the premium tier. Users on free tier get 5 stem-separation credits per month; paid tier gets unlimited."_

### 60.2 Speculation decision

ARCHITECT (T2) detects architectural ambiguity: two reasonable Stripe-integration shapes both satisfy the intent.

**Option A — hosted checkout.** Customer redirected to Stripe-hosted checkout page. Webhook on `checkout.session.completed`. Smaller security surface (no card data in our infra). Simpler.

**Option B — embedded elements.** Customer stays in our UI. Server-side `PaymentIntent` creation; Stripe Elements for card collection. More flexibility (custom checkout UX); larger compliance surface (PCI-DSS SAQ-A-EP).

T4 fires (cost-shape uncertain). ARCHITECT proposes skill+infra speculation:

```yaml
plan:
  intent: "Stripe subscription billing for premium tier"
  speculations:
    - id: "stripe-shape"
      kind: skill-set + infra
      approaches:
        - id: hosted-checkout
          skills: [stripe-checkout@stripe-official]
          aws-delta:
            + lambda: songster-stripe-webhook-receiver (handles checkout.session.completed, invoice.paid)
            + secret: /futurator/songster/{env}/stripe/secret-key (one secret)
        - id: embedded-elements
          skills: [stripe-elements@stripe-official]
          aws-delta:
            + lambda: songster-stripe-payment-intent (creates server-side PaymentIntents)
            + lambda: songster-stripe-webhook-receiver (more event types)
            + dynamodb: songster-stripe-customers (customer mapping)
            + secret: /futurator/songster/{env}/stripe/secret-key
            + secret: /futurator/songster/{env}/stripe/publishable-key
      evaluation:
        metrics: [test-pass-rate, infra-cost-month, security-surface-score, code-loc]
        winner-rule: "prefer hosted-checkout unless embedded-elements scores ≥1.5× test-pass-rate"
```

Operator confirms speculation.

### 60.3 Two `explore/` branches run in parallel

Each branch's worktree carries:

- Its own `skills.manifest.yaml` delta (different Stripe skill).
- Its own `aws.manifest.yaml` delta (different infra shape).
- Its own `integrations.manifest.yaml` (different webhook handler config).

DEV/TEST/REVIEWER run on both. EVALUATOR reads both branch tips after they reach the speculation evaluation point:

| Metric                                | hosted-checkout | embedded-elements |
| ------------------------------------- | --------------- | ----------------- |
| Test-pass-rate                        | 100%            | 100%              |
| Infra cost dev                        | +€3/mo          | +€15/mo           |
| Security surface score (lower=better) | 0.3             | 0.7               |
| Code LoC                              | 240             | 480               |

Winner: hosted-checkout. Smaller cost, smaller surface, identical pass-rate.

### 60.4 Winner merges, loser archives

```
explore/songster-stripe-hosted-checkout → main (via wave-merge)
explore/songster-stripe-embedded-elements → archive/songster-stripe-embedded-elements@<sha>
```

Both manifests update. The integrations manifest gains:

```yaml
- id: stripe
  vendor: stripe
  rigor-min: production
  secret-path: /futurator/songster/{env}/stripe/secret-key
  publishable-key-path: /futurator/songster/{env}/stripe/publishable-key
  endpoints:
    dev: https://api.stripe.com (test mode keys)
    staging: https://api.stripe.com (test mode keys)
    production: https://api.stripe.com (live mode keys)
  skill: stripe-checkout@stripe-official
  webhooks:
    - event: checkout.session.completed
      path: /api/webhooks/stripe/checkout-completed
      handler-kind: lambda
    - event: invoice.paid
      path: /api/webhooks/stripe/invoice-paid
      handler-kind: lambda
  cost-model:
    type: percent-of-revenue
    stripe-fee: 0.029-plus-0.30-eur
  introduced-in: songster-v3-billing
```

### 60.5 Operator types secrets once

After ARCHITECT applies, the bootstrap runbook entry surfaces:

> **Action required:** type the following secrets into Secrets Manager:
>
> - `/futurator/songster/dev/stripe/secret-key` (test mode)
> - `/futurator/songster/dev/stripe/publishable-key` (test mode)
> - `/futurator/songster/staging/stripe/secret-key` (test mode)
> - `/futurator/songster/staging/stripe/publishable-key` (test mode)
> - `/futurator/songster/production/stripe/secret-key` (live)
> - `/futurator/songster/production/stripe/publishable-key` (live)

This is the only place a human types secret values. Operator copies from Stripe dashboard once.

### 60.6 Plan completes; production deploy gate

Plan tag created. Staging deploys. 24h soak runs:

- Synthetic checkout completion test runs hourly (Stripe test mode).
- Webhook delivery test (Stripe sends test event; lambda processes).
- All 6 soak criteria pass.

Operator approves production deploy. Semver tag → live billing.

### 60.7 What Songster's plan exercised

- Skill+infra speculation (Part III §28.3) end-to-end.
- Combined ARCHITECT + SKILL-SCOUT card with overlapping changes.
- Per-integration secret-rotation policy override (PCI-DSS context implies 30d for prod).
- Webhook handler defaulting to Lambda (Part V §26.4).
- Layer C ephemeral session for the production deploy.
- Cost engine: percent-of-revenue cost model (no shim needed; the integrations manifest carries the cost-model literal).
- Federated cost-shim NOT exercised (no Bedrock changes in this plan).
- Two new entries in commit metadata's `Skills-Used:` line; `Skills-Manifest-Sha` updated.

Operator decisions throughout: 2 (speculation confirm + production deploy approval). Plus the one-time secret typing — not a decision card, just a runbook entry.

---

# Appendices

## Appendix A — Boilerplate file tree

The `futurator/futurator-starter` repo at v1.0.0:

```
futurator-starter/
├── package.json                       # all scripts pre-wired
├── pnpm-lock.yaml                     # pinned deps
├── tsconfig.json                      # strict, module=NodeNext
├── next.config.ts                     # base path placeholder for /apps/<n>/
├── eslint.config.ts                   # Futurator house rules
├── prettier.config.ts
├── vitest.config.ts                   # unit tests
├── playwright.config.ts               # e2e (production rigor only)
├── knip.json                          # dead-code detection
│
├── .husky/
│   ├── pre-commit                     # lint-staged + typecheck + frozen-file check
│   └── commit-msg                     # conventional commits + storyId enforcement
├── .lintstagedrc.json
│
├── .github/
│   └── workflows/
│       ├── ci.yml                     # rigor-tiered (jobs gated by repo var FUTURATOR_RIGOR)
│       ├── deploy-dev.yml             # OIDC role assume → cdk deploy dev
│       ├── deploy-staging.yml
│       └── deploy-prod.yml            # workflow_dispatch only
│
├── .bmad/
│   ├── bedrock.md
│   ├── nimbus.md
│   ├── docker-harbor.md
│   └── rick.md
│
├── .claude/
│   ├── agents/
│   │   └── README.md
│   ├── skills.manifest.yaml           # initially: core skills only
│   ├── skills/                        # project-local skills (grow over time)
│   │   └── README.md
│   ├── commands/
│   ├── inbox/                         # gitignored, but seeded
│   │   ├── pm-to-dev.md
│   │   ├── dev-to-reviewer.md
│   │   ├── reviewer-to-qa.md
│   │   └── reflections.md
│   └── memory/                        # mounted memory (when MA arrives)
│
├── .deployment/
│   ├── aws.manifest.yaml              # written by ARCHITECT during impl-spec
│   ├── integrations.manifest.yaml
│   └── proposals/                     # ARCHITECT proposal notes (gitignored)
│
├── deployment/
│   └── cdk/
│       ├── bin/
│       │   └── <project>.ts           # generated entrypoint
│       ├── lib/
│       │   ├── <project>-shared-stack.ts
│       │   ├── <project>-dev-stack.ts
│       │   ├── <project>-staging-stack.ts
│       │   └── <project>-prod-stack.ts
│       ├── README.md
│       ├── cdk.json
│       └── tsconfig.json
│
├── .pipeline/
│   ├── context.md                     # auto-generated context pack
│   ├── baseline-passing.txt           # baseline test set
│   ├── frozen.txt                     # files frozen for current story
│   └── metrics.csv                    # per-step metrics emission
│
├── CLAUDE.md                          # project-level (template; PM populates)
├── README.md
├── cost-history.yaml                  # appends on rigor changes / quarterly review
│
└── scripts/
    ├── bootstrap-branch-protection.sh
    ├── bootstrap-project.sh           # pnpm install + playwright + husky
    ├── build-context-pack.sh
    ├── capture-test-baseline.sh
    ├── check-regressions.sh
    ├── seed-claude-md.ts              # PM agent helper
    └── scope-to.sh                    # AWS profile scoping for SSH terminal sessions
```

## Appendix B — CLAUDE.md template (full)

```markdown
# Project: {{ project.displayName }}

> **Slug:** {{ project.slug }}
> **Rigor:** {{ project.rigor }}
> **Created:** {{ project.createdAt }}
> **Repo:** {{ project.repo }}
> **Boilerplate:** {{ project.boilerplateVersion }}
> **AWS account strategy:** {{ project.accountStrategy }}
> **Primary region:** {{ project.primaryRegion }}

## What this is

<!-- PM agent populates from project intent at init -->

## Architecture decisions

<!-- Append-only. Each entry: date — decision — rationale — proposed by -->

## Constraints discovered

<!-- REFLECTOR promotes things like "this client doesn't allow third-party fonts" -->

## Patterns to use

<!-- Project-specific patterns. REFLECTOR promotes from "what worked" -->

## Patterns to avoid

<!-- REFLECTOR promotes from "what hurt" -->

## Domain glossary

<!-- PM seeds; subsequent agents append. Term — definition — context. -->

## Skills loaded by default for this project

<!-- See .claude/skills.manifest.yaml. Pointer + summary. -->

## AWS scoping reminder

You are operating in the {{ project.displayName }} project.

- Your AWS calls use the `futurator-{{ project.slug }}-runtime` profile.
- All resources are scoped to `{{ project.slug }}-*` prefix.
- Do not export environment variables that change AWS_PROFILE.
- Do not attempt to assume other roles.
- If you need cross-project access, file an attention item.

## What's NOT here yet

<!-- Explicit out-of-scope, to anchor agents against scope creep.
     Examples: no persistence, no auth, no multiplayer. Updated when scope changes. -->

## Deployment

- Push to main → GitHub Actions runs CDK deploy (per .github/workflows/)
- See deployment/cdk/README.md for the CDK app shape

## Known issues / future enhancements

<!-- REFLECTOR promotes from "future-enhancement" proposals. -->
```

## Appendix C — Attention-item taxonomy (full)

The union of v2.0–v2.4 attention categories, as referenced in Part I §6.2.

### Story / wave / plan

| Trigger                                                                       | Severity | Category                                      |
| ----------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| Story exhausts retry budget on test-verify                                    | high     | `retry-exhausted`                             |
| Story exhausts retry budget on review                                         | high     | `review-rejected-exhausted`                   |
| Story exhausts retry budget on test-author (TEST can't write valid red tests) | high     | `test-author-failed`                          |
| Tamper-check first offense                                                    | low      | `tamper-detected` (auto-revert; warning only) |
| Tamper-check second offense                                                   | high     | `tamper-repeat`                               |
| Wave merge conflict (Tier 1, no auto-resolver)                                | high     | `merge-conflict`                              |
| Wave-build-check fails after merge                                            | high     | `wave-build-failed`                           |
| Wave-smoke-check fails                                                        | high     | `wave-smoke-failed`                           |
| Plan-build-check fails                                                        | critical | `plan-build-failed`                           |
| Baseline-drift unaccepted at wave merge                                       | medium   | `baseline-drift-pending`                      |
| `explore/` evaluation tied                                                    | medium   | `speculation-tied`                            |
| Stream branch idle > 30 days                                                  | medium   | `stale-stream` (auto-archive triggers)        |

### Skills

| Trigger                                                           | Severity | Category                                     |
| ----------------------------------------------------------------- | -------- | -------------------------------------------- |
| Skill source disappears (404 on registry URL)                     | medium   | `skill-source-unavailable`                   |
| Auto-trust source publishes a breaking change in production rigor | high     | `skill-breaking-change`                      |
| Skill version pinned to deprecated upstream version               | medium   | `skill-version-deprecated`                   |
| `npx skills sync` produces non-empty diff against committed state | medium   | `skill-manifest-out-of-sync`                 |
| SKILL-SCOUT auto-distill encounters ≥3 in production rigor        | low      | `skill-distillation-pending` (informational) |
| skill-creator sub-plan fails                                      | high     | `skill-author-failed`                        |

### AWS / integrations

| Trigger                                                            | Severity | Category                        |
| ------------------------------------------------------------------ | -------- | ------------------------------- |
| `cdk synth` fails                                                  | high     | `cdk-synth-failed`              |
| `cdk deploy` fails on dev                                          | high     | `cdk-deploy-dev-failed`         |
| `cdk deploy` fails on production                                   | critical | `cdk-deploy-prod-failed`        |
| CloudFormation rollback also fails                                 | critical | `cdk-rollback-failed`           |
| Cost overrun above hard-cap                                        | critical | `cost-overrun`                  |
| Cost between alert-at and hard-cap                                 | low      | `cost-warning`                  |
| Drift detected on production stack                                 | high     | `drift-detected-prod`           |
| Drift detected on dev/staging                                      | medium   | `drift-detected`                |
| Secret rotation overdue                                            | high     | `secret-rotation-overdue`       |
| Vendor API version deprecated by upstream                          | high     | `vendor-version-deprecated`     |
| Manifest out of sync with CDK code                                 | medium   | `manifest-out-of-sync-with-cdk` |
| IAM trust policy doesn't permit daemon                             | critical | `iam-trust-broken`              |
| Orphan AWS resource (in account but not in any project's manifest) | medium   | `orphan-resource`               |
| Secret missing from Secrets Manager                                | high     | `secret-missing`                |
| Bedrock model deprecated                                           | medium   | `bedrock-model-deprecated`      |
| Bedrock provisioned vs on-demand crossover hit                     | low      | `bedrock-provisioned-suggested` |
| Webhook endpoint failing health check                              | high     | `integration-webhook-failing`   |
| Production deploy gate items missing                               | critical | `production-gate-incomplete`    |
| 24h staging soak failure                                           | high     | `staging-soak-failed`           |
| Production deploy fails health check                               | critical | `production-health-failed`      |

### Reflection

| Trigger                                                          | Severity | Category                     |
| ---------------------------------------------------------------- | -------- | ---------------------------- |
| REFLECTOR proposal pre-flight check failed (allowlist violation) | medium   | `reflector-proposal-flagged` |
| REFLECTOR-REVIEWER (phase-2) declined a proposal                 | medium   | `reflector-review-declined`  |

### Informational

| Trigger                                               | Severity | Category                    |
| ----------------------------------------------------- | -------- | --------------------------- |
| Production-deploy-ready (plan tag awaiting promotion) | info     | `production-deploy-ready`   |
| Skill-encounter increment (gap reached threshold)     | info     | `skill-encounter-increment` |
| Quarterly cost review due                             | info     | `quarterly-review-due`      |

## Appendix D — Manifest schemas

### D.1 Skill manifest (`.claude/skills.manifest.yaml`)

```yaml
project: <slug> # required
manifest-version: 1 # required, enum [1]
generated-by: skill-scout@v2.5 # required, set by SKILL-SCOUT

# Each kind is optional; entries within a kind are required keys
core:
  - source: <federation-source-id>
    skill: <skill-name>
    version: <sha:<sha>|tag:<semver>>
stack:
  - source: …
    skill: …
    version: …
domain:
  - …
vendor:
  - …
plans: # plan-kind skills, scoped to plan-id
  <plan-id>:
    skills:
      - skill: <skill-name>
        graduate-policy: on-plan-success | always | never

declined: # skills the operator explicitly declined
  - source: …
    skill: …
    declined-at: <ISO-8601>
    reason: <free-text>

gaps: # SKILL-SCOUT recorded need with no upstream match
  - need: <free-text>
    encounters: <int>
    suggested-action: author-via-skill-creator | wait | accept-no-skill
```

### D.2 AWS manifest (`.deployment/aws.manifest.yaml`)

```yaml
project: <slug> # required
manifest-version: 1 # required
generated-by: architect@v2.5
last-resolved: <ISO-8601>

aws-organization: futurator # required
account-strategy: shared | dedicated # required
account-id: <string> # required if account-strategy=dedicated
account-role-arn: <string> # required if account-strategy=dedicated
primary-region: <region> # required, default eu-central-1
us-east-1-cert-only: <bool> # default true; for CloudFront ACM

iac:
  tool: cdk | terraform | pulumi # default cdk
  language: typescript # required if tool=cdk
  version: <semver-range>
  bootstrap-qualifier: futurator
  app-entrypoint: <path>

shared:
  vpc:
    strategy: shared | dedicated # default shared
    cidr: <CIDR> # required if strategy=dedicated
    subnets:
      project-prefix: <slug>
      mode: dedicated-subnets | shared-subnets
    security-group-prefix: <slug>
    nat-gateways: <int> # 1 (cost-optimized) or 2 (HA)
  ecr:
    repos: [<repo-name>, …]
  secrets-namespace: /futurator/<slug>

environments:
  dev: <env-spec>
  staging: <env-spec>
  production: <env-spec>

  # env-spec
  domain: <fqdn>
  cdk-stacks: [<StackName>, …]
  services: # list of service entries
    - kind: ecs-fargate | ecs-fargate-gpu | dynamodb | s3 | lambda |
        cloudfront | api-gateway | cognito-pool | bedrock-model-access |
        sqs | sns | eventbridge-rule | …
      name: <resource-name>
      # … kind-specific fields
  slo: # used by 24h staging soak gate
    - endpoint: <path>
      p99-latency-ms: <int>
      error-rate-max: <float>
  deploy-gate: # required for production env
    requires: [all-tests-pass, security-audit-clean, 24h-staging-soak, operator-approval]

webhook-handler-default: lambda | ecs

cost-envelope:
  dev: { monthly-usd-max: <int>, alert-at?: <int> }
  staging: { monthly-usd-max: <int>, alert-at?: <int> }
  production: { monthly-usd-max: <int>, alert-at: <int> }
  hard-cap-action: page-operator | block-deploys | warn-only

drift-policy:
  detection: weekly | daily
  on-drift: file-attention-item # always; never auto-revert
```

### D.3 Integrations manifest (`.deployment/integrations.manifest.yaml`)

```yaml
project: <slug> # required
manifest-version: 1 # required
rotation-cadence-default: <duration> # e.g. 90d, project-wide default

integrations: # list
  - id: <integration-id> # required, unique within project
    vendor: <vendor-name> # required
    purpose: <free-text> # required
    type: integration-vendor | integration-internal # default integration-vendor
    rigor-min: prototype | mvp | production # required; gates which envs load this integration
    iam-managed: <bool> # true for AWS Bedrock; false otherwise

    secret-path: <path-with-{env}-placeholder> # required for non-iam-managed
    publishable-key-path: <path> # optional; for Stripe-style integrations
    rotation-cadence: <duration> # optional; overrides project default

    endpoints:
      dev: <url>
      staging: <url>
      production: <url>

    skill: <skill-name@source> | null # the federated skill that wraps this vendor

    contract: <package-spec> | null # e.g. "@futurator/<vendor>-contract@<semver>"

    webhooks: # optional list
      - event: <event-name>
        path: <url-path>
        handler-kind: lambda | ecs
        handler: <resource-name>

    cost-model:
      type: per-call | per-token | percent-of-revenue | flat-monthly
      estimated-monthly-usd: { dev: <int>, staging: <int>, production: <int> }
      # … type-specific fields

    health-check:
      kind: webhook-callback | http-probe | none
      endpoint: <url>

    introduced-in: <plan-id>
    deprecation: <ISO-date> | null

    status: active | planned | deprecated | retired
```

## Appendix E — Resolution log

Tracking where each of the 48 open questions from v2.0 → v2.4 + dino was resolved. Reference index for "where did we land on X?"

| #     | Question                                          | Resolution                                                                                        | Where in v2.5               |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| Q1.1  | Single repo or per-product repos?                 | Single repo per project (forever)                                                                 | Part I §2; Part III §21     |
| Q1.2  | Naming convention for repos?                      | `<project-slug>` matching GitHub naming rules; `[a-z][a-z0-9-]{1,39}`                             | Part I §2                   |
| Q1.3  | Where does CLAUDE.md live?                        | Project repo root, generated from boilerplate template                                            | Part VI §41; Appendix B     |
| Q1.4  | Single Futurator GitHub org or product orgs?      | Single `futurator/` org. Manifest `repo:` allows client-owned overrides                           | Part I §2; Part III §21     |
| Q1.5  | Plan kind taxonomy fixed or extensible?           | Fixed set defined in Part I §5; new kinds require schema extension                                | Part I §5                   |
| Q2.1  | Boilerplate sync to running projects?             | Manual operator action ("Refresh boilerplate"); never automatic                                   | Part II §13.2               |
| Q2.2  | Boilerplate versioning scheme?                    | Semver tags on the template repo; project tracks `boilerplateVersion`                             | Part II §13.1               |
| Q2.3  | Locked dependencies enforcement?                  | `pnpm install --frozen-lockfile` always; `pnpm-lock.yaml` committed                               | Part II §13.3               |
| Q3.1  | Tool gate enforcement: prompt vs glob?            | Glob always wins; `--disallowedTools` hard gate                                                   | Part II §10                 |
| Q3.2  | Bash for read-only roles?                         | Per-role MCP wrapper exposes only read verbs (git log, ls); raw Bash denied                       | Part II §10                 |
| Q3.3  | Tool config storage?                              | `agent-tool-policy.ts` central config                                                             | Part II §10                 |
| Q3.4  | Context pack rebuild cadence?                     | Per-wave (default); per-story opt-in via daemon flag                                              | Part II §11                 |
| Q3.5  | API stub step mandatory at all rigors?            | mvp+ only; prototype optional                                                                     | Part II §15                 |
| Q3.6  | Tamper-check second offense action?               | High-severity attention item `tamper-repeat`; first offense auto-reverts with warning             | Part II §16                 |
| Q4.1  | Branch namespace for prototype-on-top plans?      | `experiment/<plan-slug>` (distinct from `explore/`); never auto-merges                            | Part I §4.3; Part III §22   |
| Q4.2  | Stream auto-archive timeout?                      | 30 days idle; tagged as `archive/stream/<n>@<sha>`                                                | Part III §22.2              |
| Q4.3  | Stream graduation to plan: same branch or new?    | Same branch persists until Labs plan absorbs work, then deleted                                   | Part III §25.4              |
| Q4.4  | Worktree storage location?                        | Central pool `/home/ubuntu/worktrees/<project>/<plan>/<story-id>`                                 | Part III §24.1              |
| Q4.5  | EBS sizing for worktrees?                         | ~2GB per concurrent worktree budgeted                                                             | Part III §24.1              |
| Q4.6  | Distributed merge lock implementation?            | DDB conditional write with 5-min TTL                                                              | Part III §27                |
| Q5.1  | Speculation gating to which rigor?                | Production rigor only                                                                             | Part III §28.4              |
| Q5.2  | Speculation flavors?                              | Three: implementation, skill-set, infra                                                           | Part III §28.3              |
| Q5.3  | Tagging policy for plan tags vs semver?           | Both required at mvp+; semver only on operator publish                                            | Part III §29                |
| Q5.4  | Cross-project commits in shared monorepos?        | Model A: shared package, separate repos, semver via private CodeArtifact                          | Part IV §36.2               |
| Q5.5  | Rigor downgrade allowed?                          | Yes with friction (typed-string confirm + semver-major bump)                                      | Part I §4.2                 |
| Q5.6  | PR mode binary or modifier?                       | Non-binary modifier on rigor dial                                                                 | Part I §6.4                 |
| Q5.7  | Plan kind carries rigor or project?               | Plan kinds carry rigor; `prototype-on-top` always prototype regardless of project                 | Part I §4.3, §5             |
| Q5.8  | New `prototype-on-top` plan kind?                 | Yes; on `experiment/` branches; never auto-merges                                                 | Part I §4.3                 |
| Q6.1  | Skill federation: registry of registries vs flat? | Registry of registries with priority order                                                        | Part IV §35                 |
| Q6.2  | Federation manifest location?                     | `~/.futurator/skill-federation.yaml` (operator level)                                             | Part IV §35.1               |
| Q6.3  | Skill version pin granularity?                    | Production: SHA only; mvp+: tag or SHA; prototype: optional                                       | Part IV §42                 |
| Q6.4  | Skills monorepo or per-skill repos?               | Single `futurator-skills` monorepo with semver tags per skill                                     | Part IV §36.2               |
| Q6.5  | MCP server registry?                              | Private CodeArtifact in eu-central-1 (`@futurator/*`)                                             | Part IV §36.2               |
| Q6.6  | MCP transport: in-process or stdio?               | In-process for daemon-state; stdio for external services                                          | Part IV §36.2               |
| Q6.7  | Skill deprecation cadence?                        | Per-rigor: prototype auto-upgrades; production pins until manual upgrade                          | Part IV §36.2               |
| Q6.8  | CDK language: TS or polyglot?                     | TS only, federation-wide                                                                          | Part IV §36.2; Part V §25.2 |
| Q6.9  | Auto-distill threshold by rigor?                  | encounters ≥3, manual at prototype/mvp; auto at production                                        | Part IV §41.2               |
| Q7.1  | AWS account strategy?                             | Single shared Futurator account, future-proof for multi-account                                   | Part V §22                  |
| Q7.2  | Cross-account migration path?                     | Future v2.6/v2.7 work; v2.5 keeps single-account default                                          | Part V §22                  |
| Q7.3  | Per-project IAM role naming?                      | `futurator-project-<slug>-role` (account-prefix-aware)                                            | Part V §23.2                |
| Q7.4  | Secrets Manager namespacing?                      | `/futurator/<project>/{env}/...`                                                                  | Part V §22                  |
| Q7.5  | VPC strategy?                                     | Shared VPC with per-project subnets+SGs; dedicated VPC for regulated-data projects                | Part V §33                  |
| Q7.6  | Layer C scope policy generation?                  | Generated from plan's `aws.manifest.yaml` delta                                                   | Part V §23.3                |
| Q7.7  | Cost engine implementation?                       | Federated cost-shim skills layered over Infracost                                                 | Part V §29                  |
| Q7.8  | Cost engine: monolith or federated shims?         | Federated shim skills (Design B)                                                                  | Part V §29                  |
| Q7.9  | Webhook handler default?                          | Lambda; ECS opt-in per integration                                                                | Part V §26.4                |
| Q7.10 | 24h staging soak pass criteria?                   | 6 explicit criteria                                                                               | Part V §36                  |
| Q8.1  | Mycelium service contract default?                | Typed contract default for `integration-internal`; trivial services opt out with `contract: null` | Part V §26.3                |
| Q8.2  | Cost-history append-only or replace?              | Append-only on every rigor change + quarterly review                                              | Part V §37                  |

## Appendix F — Migration notes (v2.x → v2.5)

For projects already on v2.0 / v2.1 / v2.2 / v2.3 / v2.4:

- **From v2.0/v2.1 (file-backed pipeline, no git substrate):** run the brownfield audit plan to generate the three manifests, then a rigor-upgrade plan if the project intends to grow past prototype.
- **From v2.2 (git substrate without skills/deployment manifests):** run SKILL-SCOUT T3 audit and ARCHITECT T3 audit; commit the two new manifests at project root.
- **From v2.3 (skills but no deployment manifests):** run ARCHITECT T3 audit only; commit the two `.deployment/` manifests.
- **From v2.4 (already at full v2 shape):** v2.5 is a consolidation, not a breaking change. The 48 resolutions affect specific behaviors (rigor downgrade, PR mode, federated cost shims, etc.) but no manifest schemas changed in incompatible ways. Manifests written under v2.4 are valid v2.5 manifests; new optional fields can be added by ARCHITECT/SKILL-SCOUT during their next T2 invocation.

## Appendix G — Commit metadata template (full reference)

```
<type>(<epicId>/<storyId>): <one-line summary>

Project: <project-slug>
Plan: <plan-id>
Plan-Kind: <feature|bugfix|maintenance|prototype-on-top|hotfix|rigor-upgrade|implementation-spec>
Phase: <phase-id or "n/a">
Epic: <epicId> (<epic-title>)
Wave: <wave-number>
Story: <storyId>
Agent: <PM|API-AUTHOR|TEST|DEV|REVIEWER|COMPILER|QA|PO|OPS|HOTFIX|ARCHITECT|SKILL-SCOUT|EVALUATOR|REFLECTOR|REFLECTOR-APPLY|WAVE-MERGE>
Model: <sonnet|haiku|opus>
Rigor: <prototype|mvp|production>
Stream: <stream-name or "labs">
Tests-Added: <N>
Tests-Modified: <N>            ← MUST be 0 for non-TEST agents
Files-Changed: <N>
Skills-Used: <skill-name@<source>, ...>
Skills-Manifest-Sha: <sha>
Skill-Encounter: <skill-name attempt:<n>>     # only when COMPILER notes an encounter
```

Conventional Commits types: `feat | fix | test | chore | refactor | docs | perf | sec`.

## Appendix H — Per-rigor scripts reference

```bash
# Bootstrap (rigor-aware)
RIGOR=production bash scripts/bootstrap-project.sh

# Capture baseline at wave start
bash scripts/capture-test-baseline.sh

# Check regressions after DEV step
RIGOR=production bash scripts/check-regressions.sh

# Build context pack
bash scripts/build-context-pack.sh /home/ubuntu/projects/<project>

# Scope a terminal session to a project
source /home/ubuntu/.futurator/scope-to.sh <project-slug>
```

Rigor controls strictness; bash exits non-zero in mvp+ on regressions, exits zero with warning in prototype.

---

# Appendix I — Glossary

| Term                         | Meaning                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | --- | ------------------------------- |
| **Architectural bet**        | A core design decision the whole pipeline is built on; listed in Part I §8.                                  |
| **Attention item**           | A signal that escalates to operator. Severity × category.                                                    |
| **Decision card**            | The atomic unit of operator interaction; lives in the Cowork attention dock or Labs UI.                      |
| **Federation manifest**      | Operator-level config listing trusted upstream skill sources in priority order.                              |
| **Implementation Spec plan** | The first plan in every project; produces initial AWS + integrations manifests + CDK + CI/CD wiring.         |
| **Inner loop**               | The story pipeline (Part II §9).                                                                             |
| **Layer A / B / C**          | The three credential layers: daemon, project, plan.                                                          |
| **Managed resource**         | Manifest + resolver agent + trigger map + lifecycle + rigor matrix. Skills, AWS, integrations all instances. |
| **Project skill**            | A skill scoped to one project (`.claude/skills/<n>/`).                                                       |
| **Project tag (plan tag)**   | `<project>-plan-<plan-slug>` — created at plan completion.                                                   |
| **Project slug**             | Globally unique short name; matches GitHub repo naming.                                                      |
| **Reflection inbox**         | UI surface for REFLECTOR proposals.                                                                          |
| **Rigor dial**               | Single knob: prototype                                                                                       | mvp | production. Touches every loop. |
| **Rigor-upgrade plan**       | Auto-generated plan triggered by rigor promotion; backfills the gap.                                         |
| **Semver tag**               | `<project>-v<semver>` — created on operator publish; identifies a production release.                        |
| **Speculation**              | The pipeline can A/B test architectural choices (`explore/` branches + EVALUATOR). Three flavors.            |
| **Stream branch**            | `stream/<n>` — multi-terminal manual sessions; operator owns merging.                                        |
| **Tool wrap-it threshold**   | `score = repetitions × avg_input_tokens × (1 + failure_rate × 4)`; threshold 5000.                           |
| **Wave**                     | Parallel-execution batch; computed from the DAG, not assigned.                                               |
| **Worktree**                 | Per-story filesystem isolation in a central pool outside the project tree.                                   |

---

_End of v2.5 consolidation._
