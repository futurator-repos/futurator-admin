# Blueprint — SpyHunter v2 + post-PR-59..PR-101 pipeline expectations

> **Purpose.** A pre-flight expectation document for the next plan run.
> Use it as a checklist while the new SpyHunter (or any other plan) goes
> through the pipeline, then compare reality against each section
> post-mortem. Diff-friendly so Phase 3 + Phase 2 wrap development can
> extend it.
>
> **Authoritative as of 2026-05-16 (Pipeline v2 substrate complete:
> Phase 2 PRs PR-84/85/86/87/88/89/90/91/92/93/94/95/96/97/98/99/100/101
> on top of Phase 2's PR-32..PR-68, plus Phase 3 PRs PR-69..PR-83 — 36
> total stories shipped on top of HEAD `d168114-dirty`).** All substrate
> in working tree, lint-clean, ~1100 tests pass. Revise inline when
> reality drifts.
>
> **Sibling files.**
>
> - `futurator-pipeline-qa-stage-redesign.md` — QA stage architectural intent
> - `pipeline-v2-0-efficency-fixes.md` — PR-1..PR-58 tracking
> - `pipeline-v2-logic-overview.md` — overall reducer flow
> - `epics-pipeline-v2-phase-2.md` §16 — PR-32..PR-68 stabilisation catalogue
> - `epics-pipeline-v2-phase-3.md` — Phase 3 epic plan (PR-69..PR-87+)
>   This file extends them; it is NOT a substitute. When this document and a
>   sibling disagree, **the sibling wins** if it's about _design_; this file
>   wins if it's about _recently shipped behaviour_ (PR-59..PR-68 +
>   Phase 3 unblockers PR-69/70/71/77 substrate, see §5.5).

---

## 0. The intent (you fill this in)

Paste the user-intent for the new plan below. The PM agent uses this verbatim
to generate epics + stories. Be specific — vague intents produce vague ACs
which produce L0-classified visual tests which catch nothing.

```text
INTENT (REPLACE THIS BLOCK)
────────────────────────────────────────────────────────────────────────
Create the SpyHunter v2 game, pixel-art style, where the player's spy car
emerges from a truck in an intro sequence, then drives a vertically-
scrolling road with three lanes. Random enemy cars appear and the player
must avoid or shoot them. Weapon/ammo gadgets appear on the road and can
be picked up. After ~60 seconds a boss enemy appears at the top of the
road; defeating the boss wins; losing all health = game over. Single
level only.
────────────────────────────────────────────────────────────────────────
```

### Tips for writing this intent

- **State what the user sees** — "a spy car visible at the bottom of the
  road", "at least 1 enemy car visible at any time during gameplay", "boss
  appears at top after 60 seconds". The PM will mirror this concrete voice
  into the AC text (PR-63), and that AC text is what the visual judge
  applies at QA time.
- **State the framework explicitly** if you have a preference: "built on
  Vite + Canvas2D" or "Next.js App Router + React components". The PM
  otherwise picks from the App's registered boilerplate, which can drift
  from what the bootstrap actually scaffolds.
- **State the rigor** in plain language: "MVP — visual judges allowed",
  "Production — full Sonnet visual flow tests", or "Prototype — smoke
  only". The plan-create UI lets you pick this; defaults to MVP.

---

## 1. Plan creation (operator clicks "Create plan")

### What you should see

| Step                | Where                              | Expected                                                                                        |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Click "Create plan" | `/labs` → "New plan" button        | A new row appears with status `decomposing`                                                     |
| PM agent invoked    | Notification bell + UI status pill | Cost ticks up by ~$0.05-0.20 over ~60-90s                                                       |
| Plan settles        | Same row                           | Status `developing`, displayName = "spyhunter2 — initial" (slug = `spyhunter2-initial`, locked) |
| Sidebar             | Top-left                           | `vd168114-dirty` (or whatever HEAD you deployed). No orange dot — UI hash matches API hash      |

### What the PM should produce

After decompose:

- **3-6 epics**, foundation epic first with `dependsOn: []`. The
  `intent`'s framework hint (or App's boilerplate) seeds the AC voice.
- **15-30 stories**, distributed across epics. Wave 0 in each epic
  is the foundation pass; later waves are features.
- **Browser ACs** (`needsBrowser: true`) for everything that's visible to
  the user. Internal-only ACs (math, types, helpers) stay
  `needsBrowser: false`. Expect ~50-70% of ACs marked browser for a
  visual game like SpyHunter, ~20-40% for a CRUD/dashboard app, ~10-20%
  for backend-only stories.
- **AC text style** is concrete (PR-63):
  - ✅ "The player car is visible at the bottom of the road, centered in
    its lane, ~50px tall in a single solid color distinct from the road."
  - ❌ "The player car renders correctly." (PM should NOT emit this voice
    post-PR-63 — vague text gets flagged by the specificity-check at
    qa-aggregate time)

### Failure modes for this stage

- **PM emits vague ACs** despite PR-63 guidance → operator sees vague
  warnings on the contract-review card later. Open per-story and rewrite
  the AC text before approving.
- **Plan name slug already exists** → API returns 409, UI shows toast.
  Pick a unique name (the slug becomes the deploy URL).
- **Boilerplate registry has no entry for your stack** → PM falls back to
  generic prompt. ACs may reference wrong file paths. Add the boilerplate
  to `BOILERPLATE_REGISTRY` and re-create the plan.

---

## 2. Wave-by-wave development

Plans execute as a sequence of **waves**. Inside each wave, stories run
in **parallel**. Across waves, they run **serially** in dependency order.

### 2.1 Per-story flow (mvp+ rigor)

This is the meat of the pipeline. Each story walks through these steps,
in order:

```
  ┌── test-author  (TEST agent — Haiku ~$0.005)
  │      • PR-64: must include ≥1 integration test against framework entry
  │      • Writes failing tests (red state)
  │
  ├── dev          (DEV agent — Sonnet ~$0.05-0.30)
  │      • Implements code to make tests pass
  │      • Emits VISUAL_TESTS block when browser ACs exist (PR-63: with
  │        explicit `level: L1` and `judge:` per browser AC)
  │
  ├── test-verify  (shell — Vitest)
  │      • Runs `vitest run --changed HEAD~1`
  │      • Fails loud if any test red
  │
  ├── tamper-check (mvp+)
  │      • Diffs test files HEAD vs test-author output
  │      • Fails if dev modified any test file
  │
  ├── baseline-regression (mvp+, optional)
  │      • Runs scripts/check-regressions.sh if present
  │
  ├── review       (REVIEWER agent — Haiku ~$0.005)
  │      • Text-only AC verification reading diff + project_context
  │      • Emits per-AC verdict: pass | fail | needs-human
  │
  ├── review-runtime  (PR-65 — only when story.hasBrowserTests && mvp+)
  │      • buildFrameworkDetectSnippet → boots dev server
  │      • Playwright screenshot of /
  │      • Uploads to s3://futurator-ai-website/review-screenshots/<storyId>/
  │      • Spawns claude haiku — judges each browser AC against screenshot
  │      • PASS or UNCERTAIN → step passes
  │      • FAIL → exit 1, loopTo retry with screenshot URL + per-AC rationale
  │      • Cost: ~$0.005 + 5-10s wallclock per story
  │      • Skipped (exit 0) on dev-server boot failure (foundation stories)
  │
  ├── retry           (loop target on review or review-runtime failure)
  │
  ├── compile-commit-on-pass  (PR-67)
  │      • git add -A
  │      • Counts staged source files (filters out .pipeline/, knowledge/,
  │        node_modules/, visual-tests*.md, .context/)
  │      • If zero source files staged → exit 1, STORY_COMMIT_EMPTY
  │      • Else: git commit -m "story: <id> — <title>"
  │      • NO MORE --allow-empty on the story commit
  │
  ├── compile-diff
  ├── compile-ast              (Slice A — tree-sitter grounding)
  │      • Runs ast-extract.mjs on every Added/Modified file in DIFF_MANIFEST
  │      • Writes .mycelium/ast-facts.json (imports, functions, classes, calls)
  │      • <100ms; zero LLM/embedding spend; best-effort (shell always exit 0)
  │      • Captured as AST_FACTS for the next step
  │
  ├── compile-knowledge        (COMPILER — Haiku, AST-grounded)
  │      • Prompt now carries a <ground_truth> block with AST_FACTS
  │      • Compiler stops re-deriving structure; focuses on Purpose,
  │        Decisions, Signals — the LLM-unique parts
  │      • Wiki articles still authored at knowledge/{code,decisions,system}/
  │
  ├── compile-sync             (graph-sync.mjs — wiki + AST → Memgraph + S3 + snapshot)
  │      • Reads wiki articles, embeds changed ones via Voyage (1024-dim)
  │      • MERGEs file-level :Node + DEPENDS_ON edges from [[wikilinks]]
  │      • Reads .mycelium/ast-facts.json → MERGEs sub-file :Node (kind=function/class)
  │        + DEFINES / IMPORTS / CALLS edges (Slice B)
  │      • Writes knowledge/_graph/graph-snapshot.json for the in-app viewer
  │      • aws s3 sync knowledge/ → s3://futurator-ai-website/knowledge-live/<projectId>/
  │
  └── compile-push   (git push origin HEAD:main)
```

### 2.2 What to watch in the per-story logs

In the UI: open the story → "Step log" tab. Look for:

**Healthy story:**

```
[step_start] test-author / TEST
[step_complete] test-author / TEST  ✓
[step_start] dev / DEV
[step_complete] dev / DEV  ✓
[step_start] test-verify / __shell__
[step_complete] test-verify  ✓  (e.g. 18/18 passing)
[step_start] tamper-check / __shell__
[step_complete] tamper-check  ✓
[step_start] review / REVIEWER
[step_complete] review / REVIEWER  ✓  (all ACs pass)
[step_start] review-runtime / __shell__              ← PR-65
[review-runtime] screenshot at https://futurator.ai/review-screenshots/...
[review-runtime] all 3 browser ACs PASS or UNCERTAIN ← what we want
[step_complete] review-runtime  ✓
[step_start] compile-commit-on-pass / __shell__     ← PR-67
[step_complete] compile-commit-on-pass  ✓
```

**Unhealthy story — review-runtime catches an orphaned implementation:**

```
[step_start] review-runtime / __shell__
[review-runtime] screenshot at https://futurator.ai/review-screenshots/...
RUNTIME_REVIEW_FAILED: 2 AC(s) failed visual review of the running app:
  - AC-S5-1: the player car is missing — only an empty road and HUD visible
  - AC-S5-2: no enemy cars in the frame — expected at least one
Screenshot: https://futurator.ai/review-screenshots/abc/12345.png
The dev server booted and rendered, but the result does not match the AC
text. Common causes:
  • A module was written but is not imported from the entry point.
  • A render loop / state-machine update is wired but not driving the
    visual change.
  • An asset is referenced but the path is wrong / asset never loaded.
[step_error] review-runtime  ✗
[step_start] retry / DEV    ← loopTo retry
[step_start] dev / DEV      ← resumeFromStep
```

**Unhealthy story — empty diff caught by PR-67:**

```
[step_start] compile-commit-on-pass / __shell__
STORY_COMMIT_EMPTY: no source-code changes staged for story S-6.
Working tree status:
 M visual-tests.md
?? src/components/MissingComponent.tsx     ← the bug
Staged for commit:
 visual-tests.md
Likely cause: the dev agent's writes weren't tracked by git (new
top-level dir not staged, or wrote to a different cwd). Investigate
before marking the story done.
[step_error] compile-commit-on-pass  ✗  (exit 1)
```

This is the spyhunter-1 forensic pattern, now loud at the right gate.

### 2.3 Notifications during per-story work

The bell badge accumulates **attention items** (`/labs?planId=...`).
You'll see:

| Item kind               | When                                          | Action                                                              |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `dev-fix-loop`          | Dev retried >2x on the same story             | Open story, decide: send back / let it keep retrying / abandon      |
| `review-runtime-failed` | PR-65 caught a visual gap (new in this build) | Click → see screenshot + AC rationale → likely send back            |
| `commit-empty`          | PR-67 caught zero-source-diff                 | Investigate the dev's writes; usually wrong cwd or untracked subdir |
| `compile-failed`        | Any compile-\* step fails                     | Read the step error, decide                                         |
| `cost-ceiling-warn`     | Plan cost crossed 75% of ceiling              | Decide: raise ceiling / let it finish / abort                       |

Each attention item is also written to `futurator-attention-items` DDB. The
bell is wired (PR-7 from earlier) to filter only OPEN items.

### 2.4 Per-wave gate (`wave-build-pipeline`, mvp+)

After ALL stories in a wave complete and commit, the wave-build job fires
**once** per wave:

```
  build-check               npm run build 2>&1
                            • tsc --noEmit + vite/next build

  bundle-source-check       (PR-68)
                            • Detects output dir: out/_next/static/chunks,
                              .next/static/chunks, .svelte-kit/output/client/_app,
                              build/client/_app, dist, out, build
                            • Reads every .js.map's .sources[] field
                            • For each story touch point in the wave,
                              verifies the path appears in some sourcemap
                            • Missing → exit 1, BUNDLE_ORPHAN_FILES
                            • Skipped cleanly when no output dir or no maps

  server-check              (PR-59 framework detection)
                            • buildFrameworkDetectSnippet exports
                              QA_PORT / QA_DEV_CMD / QA_HEALTH_PATH
                            • Boot for 30s, curl until 200
```

#### Healthy wave-build:

```
> npm run build
✓ built in 6.42s
[bundle-source-check] scanning sourcemaps under dist/
[bundle-source-check] all 8 touch points reachable from the bundle entry
[server-check] framework=vite port=5173 status=200
```

#### Bundle-source-check catches an orphan:

```
[bundle-source-check] scanning sourcemaps under dist/
BUNDLE_ORPHAN_FILES: the following wave-2 touch points are not reachable
from the build entry:
  - src/components/EnemyCar.tsx

Likely cause: the file was written but not imported by anything in the
entry-point import graph. Common patterns:
  • Vite scaffold leaves src/main.ts pointing at a stub; new code in
    src/app/ or src/components/ never gets imported.
  • A new module exists but the entry (or its parent component) never
    imports it.
  • The dev wrote to a different path than the touchPoint declared in
    the plan.

Hint: open the framework entry file (index.html, src/main.ts,
app/layout.tsx, etc.) and verify it imports the touch points above (or
imports something that does).
```

Failure here loops to `dev-build-fix` agent — same flow as a build
failure.

### 2.5 Plan-end gate (`plan-build-pipeline`)

After the last wave's wave-build succeeds, **once** per plan:

```
  plan-build-check         npm run build (same as wave-build)
  plan-server-check        (PR-59 framework detection — boot test)
```

No bundle-source-check at plan level by default (waves catch it
earlier). If something slipped through, plan-build's server-check would
still notice if the dev server crashes — but a stub like spyhunter-1's
boots fine. That's why per-wave bundle-source-check is the catch.

### 2.6 Mycelium knowledge graph (real-time view)

The Compiler agent + tree-sitter together turn each story's diff into
nodes and edges in a live Memgraph instance on the EC2 host. The
**Development → Graph** tab (and the **GRAPH** subtab inside the plan
detail) renders the current state as a force-directed graph, polled
every 5 s from S3.

#### What lands in the graph per story (mvp+ rigor)

| Trigger                                                                                                                                     | Source         | Memgraph rows created/updated                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `compile-knowledge` writes a wiki article in `knowledge/code/<slug>.md`                                                                     | COMPILER agent | One file-level `:Node {kind:"file"}` per touched source file. Title + summary + tags + maturity from the article frontmatter.                         |
| `compile-knowledge` writes a decision article in `knowledge/decisions/`                                                                     | COMPILER agent | `:Node {kind:"decision"}`. Linked to code articles via `[[wikilinks]]`.                                                                               |
| `compile-knowledge` adds `[[wikilinks]]` in `Dependencies` / `Refines` / `Validates` / `Supersedes` / `Conflicts with` / `Enables` sections | COMPILER agent | Semantic edges: `:DEPENDS_ON`, `:REFINES`, `:VALIDATES`, `:SUPERSEDES`, `:CONFLICTS_WITH`, `:ENABLES`. Edge weights from the section→edge map.        |
| `compile-ast` extracts `functions` from each changed file                                                                                   | tree-sitter    | One `:Node {kind:"function"}` per function. NodeId = `<file-id>#function:<name>`. Carries `params`, `line/endLine`, `exported`, optional `className`. |
| `compile-ast` extracts `classes`                                                                                                            | tree-sitter    | One `:Node {kind:"class"}` per class. Carries `extends`.                                                                                              |
| Every function/class belongs to a file                                                                                                      | derived        | `(file)-[:DEFINES]->(function                                                                                                                         | class)` |
| `compile-ast` extracts relative imports                                                                                                     | tree-sitter    | `(fileA)-[:IMPORTS]->(fileB)` when the path resolves to a known file (external/`@/`-alias imports skipped in v1)                                      |
| `compile-ast` extracts same-file call sites                                                                                                 | tree-sitter    | `(callerFn)-[:CALLS]->(calleeFn)` (cross-file callee resolution is a follow-on)                                                                       |

#### Per-story node/edge expectations

For a typical "small feature" story that touches 2-3 source files:

- **+0 to +3 `:Node {kind:"file"}`** (existing files MERGE; new files create)
- **+5 to +25 `:Node {kind:"function"}`**
- **+5 to +25 `:DEFINES`**
- **+1 to +6 `:IMPORTS`** (resolved relative paths only)
- **+0 to +5 `:CALLS`** (same-file only in v1)
- **+1 to +4 `:DEPENDS_ON`** (depends on what the Compiler chose to wikilink)

#### What to watch in the UI

1. **Open the GRAPH tab inside the plan view** (between GITGRAPH and the
   pipeline's right edge). Auto-refresh is on by default.
2. **First story compile-sync (~30 s after Reviewer approves)** → first
   nodes appear. Files are blue, functions are cyan, classes are purple.
3. **Each subsequent story** adds incrementally. The node-kind chips
   above the canvas tally the breakdown — click a chip to hide/show
   that kind. Same for edge types in the side panel legend.
4. **Click a function node** → side panel shows parent file, line range,
   exported flag, params, class name if it's a method.

#### Queries that work today (SSH-only, UI follow-on)

```bash
ssh ubuntu@<ec2>
set -a; source /opt/futurator-daemon/.env; set +a
cd /opt/futurator-daemon/scripts

# 1. "Which functions call applyGravity?"
mgconsole --username gomad --password <pw> <<'CYPHER'
MATCH (caller:Node {projectId:'<projectId>', kind:'function'})-[:CALLS]->(callee:Node {name:'applyGravity'})
RETURN caller.parentFile AS file, caller.name AS fn;
CYPHER

# 2. "Which files import this module?"
mgconsole --username gomad --password <pw> <<'CYPHER'
MATCH (a:Node {kind:'file'})-[:IMPORTS]->(b:Node {nodeId:'code/src--game--sprites'})
RETURN a.nodeId AS file;
CYPHER

# 3. Semantic search — "what's related to player input?"
node graph-search.mjs --project <projectId> --query "player input and keyboard handling" \
  --top-k 8 --hops 2 --min-similarity 0.5
```

#### Cost per story (mvp+ rigor, post Slice A)

| Step                                     | Spend                        | Wall-clock |
| ---------------------------------------- | ---------------------------- | ---------- |
| `compile-ast`                            | $0 (tree-sitter local)       | <100 ms    |
| `compile-knowledge` (Compiler Haiku)     | ~$0.03                       | 30–90 s    |
| `compile-sync` Voyage embed (1024-dim)   | ~$0.0001 per changed article | 0.3 s      |
| `compile-sync` Memgraph MERGE + snapshot | $0                           | 1–3 s      |
| S3 sync of `knowledge/` mirror           | <$0.001                      | 1–3 s      |

### 2.7 Brownfield AST bootstrap (pre-development seeding)

Slice C ships `bootstrap-ast.mjs` so a plan against an existing repo
starts with a populated call graph instead of an empty one. The script
walks the project working dir, runs tree-sitter on every supported
source file, and pushes the result into Memgraph in one shot.

#### Ideal workflow (target — manual trigger today)

```
operator clicks "Create plan"
        │
        ▼
PM agent decomposes intent into epics/stories  (existing)
        │
        ▼
app-bootstrap step                            (existing — clones repo)
        │
        ▼
bootstrap-ast.mjs  ◄── NEW (manual today, automatic target)
   • node bootstrap-ast.mjs --project <id> --root <workingDir>
   • walks the repo, runs ast-extract --scan
   • writes .mycelium/ast-facts.json
   • spawns graph-sync.mjs (no embeddings → $0 Voyage spend)
   • Memgraph now holds every :Function / :Class / :DEFINES /
     :IMPORTS / :CALLS for the entire repo
   • graph-snapshot.json written + S3-mirrored
        │
        ▼
operator opens /labs/<plan>/graph
   → graph already shows the full code structure
   → operator can sanity-check before agents start
        │
        ▼
Wave 0 stories run                            (existing)
   • Each story's compile-sync overlays NEW wiki nodes + edges on
     top of the pre-seeded AST graph
   • Function/class nodes already exist → :DEFINES / :CALLS edges
     just get refined as Dev changes things
```

#### Manual trigger (until the auto-hook is wired)

```bash
ssh ubuntu@<ec2>
set -a; source /opt/futurator-daemon/.env; set +a
cd /opt/futurator-daemon/scripts
node bootstrap-ast.mjs \
  --project <projectId> \
  --root /home/ubuntu/projects/<projectId>
```

Idempotent — safe to re-run when the repo changes shape outside the
agent pipeline (e.g. operator manually edits files, external PR merged).

#### What this DOES NOT do (yet)

- **No automatic trigger from app-bootstrap.** The trigger-wiring is a
  follow-on (`daemon/pipelines/app-bootstrap.mjs` calls bootstrap-ast
  after the git-clone step succeeds). Until then, operator runs it
  via SSH.
- **No cross-file CALL resolution.** Same-file callees only in v1.
  Cross-file requires using the import statements to resolve `applyGravity`
  in `dino.ts` to `physics.ts#function:applyGravity`. Tracked.
- **No path-alias resolution.** `@/lib/util` and tsconfig `paths` are
  ignored. Resolution attempts `./` and `../` only.
- **No language coverage beyond TS/TSX/JS/JSX/MJS.** Adding Python or
  Go is a config flip: install `tree-sitter-python` / `tree-sitter-go`
  - add an entry to `languageForExtension` in `ast-extract.mjs`.

---

## 3. QA stage (after plan-build succeeds)

Plan flips to `review` status. The QA Review tab opens.

### 3.1 What auto-runs

- **AC pillar** rolls up the per-story `review` verdicts.
- **VQA pillar** stays `pending` until QA aggregate runs.
- **Gate pillar** rolls up per-wave compile/typecheck/lint/unit.

### 3.2 Operator action: "Run QA Review"

Clicks the button or it auto-fires (when `plan.autoRunQa === true`). This
calls `POST /api/plans/:id/qa-review` → launches a fresh **QA AGGREGATE**
job.

### 3.3 QA aggregate (1.2s, $0.0)

A single Node script that:

1. Collects every story's `visualTests[]` across the plan
2. Collects every AC's `needsBrowser` flag
3. Indexes `needsBrowser` by AC id (PR-62)
4. Classifies each test via `classifyVisualTest(t, rigor, acNeedsBrowser)`
5. Rules (in order):
   - `test.level` set in source → preserved (capped by rigor)
   - `flow` has multiple steps → L2 (Sonnet)
   - `screenshot.selector` or 1-step flow + concrete expect → L1 (Haiku)
   - `url` + `expectText` → L0 (bash)
   - default → L0
6. **Cap by rigor**: prototype→L0 max, mvp→L1 max, production→L2 max
7. **PR-62 floor**: if `acNeedsBrowser === true` AND chosen level is L0
   → **raise to L1**, overrides rigor cap. spyhunter-1 forensic: this
   floor would have caught all 26 visual ACs.
8. Writes `visual-tests-draft.md` and emits the contract-review variables

### 3.4 Operator action: Approve the contract

UI shows the contract approval card (when implemented — currently
operator approves via console fetch). The card lists each test with its
level + classifier reason; operator can override levels per-test before
approving.

`POST /api/plans/:id/qa-contract/approve` with optional `tests: [{id, level, ...}]`
overrides → launches **QA EXECUTE** job.

### 3.5 QA execute (cost depends on rigor + AC count)

Seven steps, in order:

```
  qa-prepare      (PR-59 framework detection + PR-60 hang fix)
                  • Boots dev server via $QA_DEV_CMD
                  • Healthcheck loop, 60 attempts (was 30 pre-PR-60)
                  • Playwright overview screenshot
                  • Per-test screenshots in batches of 5
                    - Node IIFE drains child.stdout
                    - Explicit process.exit(0) after capture (PR-60)
                    - .catch() with process.exit(1) for unhandled rejections
                  • aws s3 cp wrapped in `timeout 30` (PR-60)
                  • Dated checkpoints: [qa-prepare] HH:MM:SS …
                  • console errors grepped from devserver.log

  qa-judge-l0     bash-only checks per L0 test (HTTP 200, console
                  errors, screenshot >2KB, optional expectText)

  qa-judge-l1     Haiku per L1 test, parallel batches of 5
                  • Each test wallclock-bounded (default 30s, override
                    via test.budgetWallclockSec)
                  • Plan-level cost ceiling checked before each batch

  qa-judge-l2     Sonnet per L2 test, sequential
                  • Multi-screenshot behavioral flows
                  • Same wallclock + cost-ceiling enforcement

  qa-report       Aggregates verdicts; emits TOTAL_PASS / FAIL /
                  UNCERTAIN / ERRORED + SCREENSHOTS markdown

  qa-cleanup      Reads /tmp/qa-<jobId>/qa-port.txt (PR-59 wrote it),
                  kills dev server, archives logs to S3
```

### 3.6 Expected costs by rigor

For a SpyHunter-sized plan (~26 visual tests, ~70% browser ACs):

| Rigor                 | L0 count | L1 count | L2 count | Cost   | Wallclock  |
| --------------------- | -------- | -------- | -------- | ------ | ---------- |
| prototype             | 26       | 0        | 0        | $0     | ~2 min     |
| **mvp (recommended)** | ~10      | ~16      | 0        | ~$0.30 | ~5-8 min   |
| production            | ~5       | ~15      | ~6       | ~$1.50 | ~15-25 min |

PR-62 ensures the L0 count never includes a needsBrowser AC at mvp+.

### 3.7 Per-screenshot expectations

For each L1+ test, the gallery shows:

- Thumbnail of the captured screenshot
- Verdict pill: PASS / FAIL / UNCERTAIN / ERRORED / SKIPPED-BUDGET
- One-line judge rationale
- Click → full-size screenshot in modal

If you're testing the new SpyHunter and see thumbnails that look like
"empty road + tiny rectangle car" (spyhunter-1 stub), but the L1 judges
PASS them anyway → that's a judge prompt regression. Capture the
screenshot URL + judge output and we'll tighten the `judge:` text.

---

## 4. Deploy stage

After QA passes (or operator promotes despite warnings):

### 4.1 What runs

```
  Build:        cd <workingDir> && npm run build
  Sync to S3:   aws s3 sync <outDir>/ s3://futurator-ai-website/apps/<slug>/ --delete
  Invalidate:   aws cloudfront create-invalidation --paths "/apps/<slug>/*"
  Verify URL:   curl https://futurator.ai/apps/<slug>/
```

### 4.2 Open known slug mismatch (PR not yet shipped)

> **Watch for this.** As of `d168114`, two code paths compute the deploy
> slug differently:
>
> - DEPLOY agent: `epic.workingDir.split('/').pop()` → e.g. `spyhunter-2`
> - UI / deploy-report: `plan.name` → e.g. `spyhunter2-initial`
>
> Result for spyhunter-1: files synced to `apps/spyhunter-1/` but
> "Open Live" pointed at `apps/spyhunter1-initial/`. **If your new app
> hits the same divergence:** the actual deployed URL is
> `futurator.ai/apps/<basename-of-workingDir>/`, not what the UI shows.
>
> Followup PR (not yet scheduled): make `/api/epic-workflows/:id/deploy`
> look up `plan.name` and use that for the S3 prefix. Then the UI's
> target + the actual sync land at the same slug.

---

## 5. Build-hash sanity (every step)

PR-61 stamps the git short hash + ISO timestamp into:

- Static export (`NEXT_PUBLIC_BUILD_HASH`)
- API Lambda env (`BUILD_HASH`)

In the UI sidebar, `v<hash>` appears under "Futurator Admin". Cross-check:

```bash
# Production API hash
curl -sS https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws/api/health \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["buildHash"])'

# Local
git rev-parse --short HEAD
```

If the sidebar shows an orange dot, the UI bundle is stale — hard-refresh
(Cmd+Shift+R). All API requests still go to the Lambda directly (the SPA's
`NEXT_PUBLIC_API_URL` is the Lambda Function URL, not CloudFront), so this
is purely a SPA-bundle freshness indicator.

---

## 5.5 Pipeline v2 substrate visibility (PR-69..PR-101 — 36 stories shipped)

The substrate work for Pipeline v2 wrapped 2026-05-16. Two layers
shipped in parallel:

- **Phase 3 (PR-69..PR-83)** — Skills federation + SKILL-SCOUT + REFLECTOR
  - Reflection Inbox + memory stores + triage + persona evolution + skill
    promotion + pre-flight allowlist + CLAUDE.md flow + 8 SKILL-SCOUT
    triggers + Skills-Used commit lines.
- **Phase 2 wrap (PR-84..PR-101)** — metrics.csv + commit-metadata template
  - worktree paths + distributed merge lock + ARCHITECT + API-AUTHOR +
    acceptBaselineDrift + AWS manifest schema + integrations manifest +
    CDK generation + cost engine + cost history + soak poller +
    wave-merge --no-ff + stream archive + plan-tag/semver + OIDC naming
  - Implementation Spec plan template.

Observable side effects for the next plan run break down into four
buckets: **always-on substrate** (always visible), **rigor-gated commit
metadata** (visible only under mvp+), **operator-action surfaces**
(visible when the operator interacts with the inbox or runs `/skills
audit`), and **plan-kind-gated** (visible only for AWS infrastructure
plans + brownfield audits).

### Daemon startup log lines (always-on)

When the daemon boots (`journalctl -u futurator-daemon`), these lines
appear after `configure-git-identity` and before the first `poll()` tick:

```
[info] federation-loader: fallback (path=/home/ubuntu/.futurator/skill-federation.yaml, 3 sources, sha=<8-char>)   # PR-69
[info] federation-backup: daily schedule armed                                                                     # PR-69
[info] federation-resolver: ready                                                                                  # PR-70
[info] memory-store: provisioned N dir(s) under /mnt/memory                                                        # PR-77
```

These four are wired into `agent-daemon.mjs` startup today. The remaining
substrate modules (PR-78..PR-101) are **library modules** — they don't
add startup lines; they activate only when their callers invoke them
(daemon trigger-wiring is the follow-on work).

- **`federation-loader: fallback`** is correct on a fresh EC2 box — the
  embedded default (Anthropic-official + futurator-internal + community at
  p99) is the v2.5 §35.1 illustrative minimum. To upgrade to a real
  manifest, operator authors `~/.futurator/skill-federation.yaml` and
  `kill -USR1 <daemon-pid>` (multiplexed with the existing OAuth reload).
- **`federation-backup: daily schedule armed`** writes the parsed manifest
  to `s3://${FUTURATOR_CONFIG_BUCKET:-futurator-config}/${FUTURATOR_OPERATOR_ID:-default}/skill-federation.yaml`
  once every 24h. Opt out via `FUTURATOR_FEDERATION_BACKUP_DISABLED=1`.
- **`federation-resolver: ready`** is the priority-walking resolver
  consumed by SKILL-SCOUT (PR-72).
- **`memory-store: provisioned N dir(s) under /mnt/memory`** creates
  `futurator-org/`, `inbox/`, and per-project subdirs on first access.
  Seeds empty inbox files with `last-seen-sha: null` frontmatter so
  REFLECTOR can read on first run.

### Fresh-app scaffold additions (PR-71, always-on for wired starters)

Any `+ New App` against `nextjs-base` or any `nextjs-*` starter pack now
writes three additional files into the cloned repo before commit-and-push:

```
.claude/skills.manifest.yaml   # empty, project: <slug>, manifest-version: 1
.claude/skills/.gitignore      # only SKILL.md + meta.json committed
scripts/skills-sync.mjs        # standalone npx skills sync entry point
```

The `inject-app-values` post-create step substitutes `__APP_SLUG__` into
the manifest so it matches `App.appId`. Stub boilerplates (`sst`, `vite`,
`mobile`) declare `skillManifest: null` and skip these files.

To verify:

```bash
ssh ec2 cat /home/ubuntu/projects/<slug>/.claude/skills.manifest.yaml
# Expect: project: <slug>, manifest-version: 1, all kind buckets empty []
```

### Commit-metadata lines (PR-73, rigor-gated)

Under **mvp+ rigor**, per-story commits now carry two new lines appended
via repeated `-m` flags:

```
story: <id> — <title>

Skills-Used: <skill>@<source>, <skill>@<source>     ← alphabetical, comma+space
                                                       (label-only when empty)
Skills-Manifest-Sha: <64-char-hex>                  ← sha256 of skills.manifest.yaml
```

Under **prototype rigor**, neither line appears (v2.5 §42 matrix).

Queryable history:

```bash
git log --grep="Skills-Used:.*frontend-design"       # commits using a skill
git log --grep="Skills-Manifest-Sha:.*a3f9c2e"       # commits at a specific pin
```

> **Note**: the wire-in is conservative. `getCompileSteps()` accepts
> `opts.rigor` + `opts.loadedSkills`, defaulting to `prototype` rigor +
> empty array. Until the orchestrator / step-pipeline call sites thread
> these through (PR-73-followup), the lines are emitted but `Skills-Used:`
> is the empty-label form. SKILL-SCOUT shipping skills into the manifest
>
> - the daemon tracking `loadedSkills[]` per agent invocation is the
>   path to populated lines.

### SKILL-SCOUT decision cards (PR-72, operator-action surface)

When SKILL-SCOUT runs (currently only when a trigger is wired — see §9
for the trigger-wiring follow-on), and the agent emits a non-empty
`proposals[]`, a decision card surfaces in the attention dock:

- **Category**: `manifest-change-proposed`
- **Severity**: medium
- **Actions**: confirm / edit / decline / defer

Under prototype rigor with all proposals confidence ≥ 0.9, T1/T2
auto-confirm without surfacing a card. T3 (brownfield audit) never
auto-confirms regardless of rigor.

### Reflection Inbox at `/labs/reflections` (PR-76, operator-action surface)

A new page lives at `admin.futurator.ai/labs/reflections`. Cross-project
list by default; query-param scope: `/labs/reflections?projectSlug=<slug>`.

What you see:

- **Filter chips** for status (pending / all / confirmed / declined / deferred) + target (CLAUDE.md / project skills / org skills / personas / pipeline tuning / tool wrappers)
- **Rows** expandable to show rationale + proposed content + evidence (commit SHAs / story ids)
- **Pre-flight flag chip** (red `⚠ flagged`) when `flaggedForManualReview === true` — Story 3-E-9 surface
- **REVIEWER verdict chip** (green pass / red flag/reject) when populated — Story 3-E-10 surface (defer-after-baseline)
- **Three actions** per pending row: Confirm / Decline / Defer

> **Note**: REFLECTOR (PR-74) is the producer; the daemon's quiet-window
> scheduler that fires REFLECTOR after wave / plan close is a follow-on
> (PR-74-followup), so until that wires in the inbox stays empty in
> normal operation. Test-only flow: POST a row via the API directly to
> exercise the page.

### Phase 3 helpers shipped but awaiting trigger-wiring (PR-78..PR-83)

These Phase 3 stories shipped as pure helper modules; their consumers
fire them once the corresponding daemon-loop wire-in lands. Each is
documented as `PR-NN-followup` in the sprint-status.yaml.

- **Pre-flight allowlist** (PR-78) — `checkProposal` + `applyPreflight`
  helpers ready. Once REFLECTOR's daemon scheduler (PR-74-followup)
  surfaces a skill proposal, this gate flags `entrypoint` commands
  outside the allowlist (`npm | pnpm | uv | python | python3 | node |
bash <local-script>`). Inbox UI already renders the `flagged-for-
manual-review` chip when the flag lands in DDB.
- **CLAUDE.md flow** (PR-80) — boilerplate template now includes the
  v2.5 §41.1 structured CLAUDE.md. Fresh apps will ship with the
  template; `daemon/lib/claude-md-loader.mjs` `buildAgentSystemPrompt`
  prepends the file to every session's system prompt once
  `agent-daemon.mjs` adopts the helper at spawn time.
- **Triage agent** (PR-81) — pipeline + relevance scoring helpers
  ready. Wires in when the feedback-arrival daemon hook lands; until
  then no triage card surfaces on operator-submitted feedback items.
- **Persona evolution** (PR-82) — `Plan.personaPinned` schema +
  persona-loader ready. Plan creation will snapshot the latest tag per
  persona once `plan-pipeline.mjs` invokes `snapshotLatestPersonaVersions`.
  Until then, plans omit the field and the loader falls back to
  `latest.md` at session start.
- **Skill promotion path** (PR-83) — copy + manifest-rewrite + cleanup
  helpers ready. Operator-confirmed REFLECTOR `target: org-skill`
  proposals will trigger the helper chain once the `gh pr create`
  against `futurator-skills` (PR-83-followup + operator-side repo
  provisioning) is wired.

### Phase 2 wrap helpers shipped but awaiting trigger-wiring (PR-84..PR-101)

The Phase 2 substrate that the user-facing blueprint depends on for
production-rigor plans, AWS infrastructure deployment, and concurrency
safety. Helpers are tested + lint-clean; the daemon-loop wiring is the
final step.

- **metrics.csv per plan** (PR-84) — `appendStepEvent` ready. Activates
  when `agent-daemon.mjs`'s `step_complete` handler tees through it
  (PR-84-followup, ~½ day). Until then forensic JSON carries the
  events; metrics.csv stays empty and 3-C-6 distillation + 3-E-7
  wrap-it threshold have no data source.
- **Commit metadata template** (PR-85) — `buildCommitMetadataFlags` +`composeFullCommitMessage` ready. WAVE-MERGE commits (when 2-B-3
  flow wires in) and REFLECTOR-APPLY commits (when 3-E-3-followup
  wires in) emit the full v2.5 §23 metadata.
- **Worktree paths** (PR-86) — pure helpers ready. Activates when the
  story-pipeline gains `git worktree add/remove` hooks at story start /
  wave-merge cleanup (PR-86-followup). Until then stories continue to
  commit directly to the primary worktree (Phase 1 layout).
- **Distributed merge lock** (PR-87) — DDB conditional-write ready.
  Activates when wave-merge orchestration (2-B-3) gates push behind
  `acquireMergeLock`. Until then, concurrent plans can race on `git
push origin main` (low probability with current single-operator use).
- **AWS + integrations manifest schemas** (PR-88 + PR-89) — Zod schemas
  parse existing v2.5 §25 / §26 illustrative manifests. Activates as
  soon as ARCHITECT proposes a manifest edit. Brownfield audit
  (3-F-1) ships the first manifest commit per project.
- **ARCHITECT agent** (PR-90) — pipeline + role-policy + prompt ready.
  Same shape as SKILL-SCOUT (PR-72). Trigger-wiring (PR-90-followup):
  T1 at app-bootstrap (combined with SKILL-SCOUT T1 card), T2 at plan
  intent (combined card), T3 from brownfield-audit plan-kind.
- **API-AUTHOR step** (PR-91) — pipeline + prompt + module-dir
  inference + shouldRunApiAuthor gate. Inserts into story-pipeline
  before test-author for mvp+ once `story-pipeline.ts` adopts it
  (PR-91-followup, small). API-AUTHOR closes the brick-breaker / spy-
  hunter "TEST and DEV inventing different names" failure class.
- **acceptBaselineDrift** (PR-92) — PR-label detection + decision-card
  - baseline-roll-forward helpers. Activates when the baseline-
    regression step (Phase 2-A.4, shipped in PR-36) reads the label /
    fires the decision card (PR-92-followup).
- **CDK generation** (PR-96) — emits CDK TypeScript from manifest for
  11 service kinds + bin entrypoint. The Implementation Spec plan
  template (PR-101) is the consumer; its 5-epic flow drives `cdk
synth/diff/deploy` from the generated source.
- **Cost engine + cost history** (PR-97 + PR-99) — pluggable shim
  registry + monthly USD estimation. The decision card (v2.5 §46)
  populates its `Cost delta` line from `estimateManifestCost` once
  ARCHITECT runner threads it through.
- **Production soak poller** (PR-98) — 24h soak evaluator + condition
  thresholds ready. Activates when daemon cron polls CloudWatch every
  5 min during a production-rigor plan's staging soak (PR-98-followup
  - per-project `aws.manifest.yaml` `soak-script` field populated).
- **Wave-merge --no-ff** (PR-95) — command builder + outcome
  classifier + attention factories. Activates when the wave-completion
  step uses `buildWaveMergeCommand` per-story + `classifyWaveMergeOutcome`
  on the merge+test exit codes (PR-95-followup).
- **Stream branches + auto-archive** (PR-100) — idle detection +
  archive naming + graduation proposal. Activates via daemon GC pass
  weekly tick (PR-100-followup).
- **Plan-tag → semver** (PR-93) — tag builders + classifier + bumper.
  Activates when the daemon's plan-completion handler invokes
  `planCompletionTag` + `git tag` (PR-93-followup, small) and when the
  Labs UI's "Publish" button calls `productionReleaseTag` + `nextSemver`.
- **OIDC role naming** (PR-94) — role-name + trust-policy templates.
  Activates when brownfield audit (3-F-1) or rigor-upgrade plan
  (3-F-3) provisions IAM roles per project + env.
- **Implementation Spec template** (PR-101) — `Plan.kind:
implementation-spec` 5-epic shape. Activates when ARCHITECT proposes
  an AWS-only plan and the operator confirms — the plan-creator
  uses `buildImplementationSpecPlanPayload` to skip PM decomposition.

### What's NOT visible yet

These pipeline phases are unchanged until the corresponding daemon-loop
trigger-wiring follow-ons land:

- **No SKILL-SCOUT card on app-bootstrap end / plan intent** — T1/T2/T3
  wire-in is PR-72-followup; T4-T8 hooks are PR-79-followup.
- **No ARCHITECT card on app-bootstrap end / plan intent** — T1/T2/T3
  wire-in is PR-90-followup. PM combines ARCHITECT + SKILL-SCOUT
  proposals into one card (v2.5 §27.3) — both wire-ins land together.
- **No populated `Skills-Used:` content** — needs SKILL-SCOUT
  proposing skills + daemon tracking `loadedSkills[]` per agent
  invocation (PR-73-followup tracks the loaded-set; PR-72-followup
  starts populating the manifest).
- **No REFLECTOR ceremony at plan close** — quiet-window scheduler +
  low-priority slot are PR-74-followup.
- **No on-disk REFLECTOR-APPLY commit** — `daemon/pipelines/reflector-
apply.mjs` is a stub. PR-76-followup wires the actual apply.
- **No global-bell sparkle icon + no unified-diff renderer** — both
  PR-76-followup UI polish.
- **No per-story worktree** — story-pipeline still commits to the
  primary worktree (Phase 1 layout). PR-86-followup wires `git
worktree add/remove`.
- **No wave-merge --no-ff orchestration** — story commits land
  directly on main per PR-44 (orchestrator path) / PR-19 (step path).
  PR-95-followup gates this behind the merge lock + builds the merge
  commits per PR-86 branch namespace.
- **No CDK deploy / drift detection / soak** — these activate only
  when an AWS infrastructure plan (`Plan.kind: implementation-spec`)
  or brownfield audit (`Plan.kind: brownfield-audit`) runs. For a
  normal Next.js canvas-game plan against `dino-runner-1` or
  `spyhunter-2`, the AWS surface is the existing Phase 1 stub
  workflow (`pipeline-stub.yml` on main); nothing changes.
- **No metrics.csv emit** — PR-84-followup tees `step_complete` into
  the helper.
- **No baseline-drift decision card** — PR-92-followup wires the
  decision-card render on regression.
- **No API-AUTHOR step** — PR-91-followup inserts the step into
  `story-pipeline.ts` before test-author for mvp+. Until then, TEST +
  DEV continue inventing their own type names (brick-breaker /
  spyhunter-1 failure class is still possible if other guardrails
  miss).

For the next plan run (`spyhunter-2` or similar nextjs-canvas-game
under prototype/mvp), expect identical user-facing behaviour to
PR-59..PR-68 — the substrate is a quiet floor that activates as each
follow-on ships. Production-rigor plans + AWS infrastructure plans +
brownfield audits will progressively become possible as the wire-in
work lands.

---

## 6. Post-mortem capture (what to save for Phase 3 comparison)

For each plan run, capture:

| Artifact         | How                                                                      | Why                                                                     |
| ---------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Forensic JSON    | `GET /api/plans/:id/forensic` → download                                 | Per-slice timing, cost, retries. Phase 3 cohort baselines.              |
| Network HAR      | DevTools → Network → Save all as HAR                                     | Auth flow drift, slug mismatches, 401/403 patterns.                     |
| Deploy logs      | UI → Deploy tab → "Copy logs"                                            | DEPLOY agent's actual S3 path + cloudfront invalidation IDs.            |
| QA gallery URLs  | UI → QA Review → "Export forensic JSON"                                  | Visual diff baseline. Compare consecutive runs of the same plan.        |
| Sidebar version  | Screenshot of `v<hash>` strip                                            | Proves which build was running when you observed each behaviour.        |
| EC2 working tree | `ssh ... ls -la /home/ubuntu/projects/<slug>/src/` + `git log --oneline` | Catches "files in tree but untracked" before PR-67 lands more failures. |

Drop them under `docs/concepts/logs/<plan-slug>-<date>/`.

---

## 7. Failure-mode quick-reference

| Symptom                                           | Most likely cause                                                                          | Where to look                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Story stuck on `retry` >3 iterations              | Dev agent can't satisfy a strict AC, OR `review-runtime` (PR-65) keeps FAILing on a UI gap | Story step log + screenshot URL                            |
| `STORY_COMMIT_EMPTY` (PR-67)                      | Dev wrote files but git didn't track them — usually new top-level dir not staged           | `git status --short` in working dir                        |
| `BUNDLE_ORPHAN_FILES` (PR-68)                     | File committed but entry point doesn't import it                                           | Open framework entry file (index.html / src/main.ts)       |
| `QA_PREPARE_ERROR: server boot failed`            | Wrong port from framework detection, OR app has runtime crash on `/`                       | tail -40 /tmp/qa-<jobId>/devserver.log                     |
| `RUNTIME_REVIEW_SKIPPED: dev server did not boot` | Story doesn't yet render a UI (foundation story); benign                                   | Verify next browser-AC story passes review-runtime cleanly |
| Sidebar shows orange dot                          | Stale SPA bundle in browser cache                                                          | Cmd+Shift+R                                                |
| `AUTH_EXPIRED` on every API call                  | Token expired AND refresh failed                                                           | Re-login via `/login/`                                     |
| QA judges return UNCERTAIN for everything         | Story produces no UI yet, OR judge prompt is too narrow                                    | Check screenshot URL — is the canvas/page actually empty?  |
| L1/L2 verdicts disagree with what you SEE         | Judge prompt is reading wrong section of screenshot — tighten the `judge:` text            |
| Deploy "Open Live" 404s                           | Slug mismatch (see §4.2)                                                                   | Try `futurator.ai/apps/<basename-of-workingDir>/` directly |

---

## 8. Test plan for THIS run

When you create SpyHunter v2, verify each of the items below in order.
Tick the box once observed in the run; if any fail, capture the artifact
and we'll iterate.

### Pre-flight

- [ ] Sidebar shows `vd168114` (or whatever HEAD when the plan starts)
- [ ] No orange dot on the sidebar version
- [ ] `GET /api/health` returns matching `buildHash`

### Plan creation

- [ ] Plan name slug locked to `spyhunter2-initial` (or your chosen name)
- [ ] PM produced 3-6 epics, foundation epic first
- [ ] At least one wave-0 story in the foundation epic has `dependsOn: []`
- [ ] Browser ACs use concrete language (count + position + FAIL clause)
- [ ] Vague-expect patterns absent from AC text

### Wave 0 (foundation)

- [ ] Each story's `test-author` step ran
- [ ] (For browser-AC stories) `test-author` prompt mentions
      "integration test contract" — PR-64
- [ ] `compile-commit-on-pass` produced a non-empty diff for every story
- [ ] `wave-build-pipeline` ran with `bundle-source-check` step present
- [ ] `[bundle-source-check] all N touch points reachable from the
    bundle entry` log line appeared
- [ ] No `BUNDLE_ORPHAN_FILES` errors

### Wave N (features with browser ACs)

- [ ] `review-runtime` step ran on browser-AC stories — PR-65
- [ ] `[review-runtime] all N browser ACs PASS or UNCERTAIN` log line
      appeared on the happy path
- [ ] Screenshot URLs accessible in `s3://futurator-ai-website/review-screenshots/`
- [ ] If any FAIL, dev retry kicked in and re-ran from `resumeFromStep: 'dev'`

### Plan-build

- [ ] `plan-build-check` passes
- [ ] `plan-server-check` boots dev server using framework-detect
      (port matches `package.json`)

### QA stage

- [ ] `qa-aggregate` completes in <2s
- [ ] Classified-tests JSON shows zero L0 classifications for browser
      ACs (PR-62 floor)
- [ ] Operator approves contract (still via console snippet pending
      contract-card UI)
- [ ] `qa-prepare` completes within ~60s (PR-60 hang fix). Look for
      `[qa-prepare] HH:MM:SS S3 uploads done` checkpoint
- [ ] L1 judges return per-AC verdicts with rationale that ACTUALLY
      describes what the screenshot shows
- [ ] Gallery thumbnails match the running app

### Deploy

- [ ] DEPLOY agent's S3 sync path matches the UI's "Open Live" target
      (if not — slug mismatch, see §4.2)
- [ ] `futurator.ai/apps/<slug>/` returns 200
- [ ] Opening that URL shows the actual game, not the Futurator homepage
      (if it shows the homepage → CloudFront fall-through on 404 → wrong
      slug)

### Post-mortem

- [ ] Forensic JSON downloaded and saved
- [ ] HAR captured during plan creation + at least one full story cycle
- [ ] Screenshot of sidebar version at start vs end (proves build
      consistency across the run)

---

## 9. What this blueprint does NOT cover (Phase 3 candidates)

For honesty, here's what's not yet protected — track these for Phase 3:

### Now substrate-shipped (PR-69..PR-101 — 36 stories)

**Phase 3 (PR-69..PR-83 — 16 stories):**

- **Federation manifest + resolver + project skill manifest + memory
  store** (PR-69/70/71/77) — see §5.5 for visibility checks.
- **SKILL-SCOUT agent + T1-T8 triggers** (PR-72 + PR-79) — full pipeline
  - role-policy + prompt + runner with `disposeProposals` (auto-confirm
    vs surface-card by rigor); all eight trigger types (T1 init, T2 plan,
    T3 brownfield, T4 speculation, T5 new-dep, T6 REVIEWER-cluster,
    T7 stream-graduation, T8 weekly refresh) wired. Trigger-point
    _event hooks_ (where the daemon fires these) are follow-on.
- **Skills-Used + Skills-Manifest-Sha commit metadata** (PR-73) — helper
  - tests + wired into `compile-pipeline.mjs`.
- **REFLECTOR agent + pre-flight allowlist** (PR-74 + PR-78) — pipeline +
  prompt + role-policy + runner with inbox-frontmatter parsing + atomic
  append + `shouldFireReflection` rigor matrix + skill-entrypoint
  allowlist check.
- **Reflection Inbox UI + API + storage** (PR-76) — DDB table + service
  - 5 routes + `/labs/reflections` page + panel with chips and three
    actions.
- **CLAUDE.md flow** (PR-80) — template augment + claude-md-loader +
  agent-prompt-builder that prepends CLAUDE.md to every session.
- **Triage agent + cross-plan history** (PR-81) — pipeline + role +
  prompt + relevance scoring (1.0 same-project / 0.7 same-family / 0.4
  cross-product) + decline-history support.
- **Persona evolution + versioning** (PR-82) — `Plan.personaPinned`
  schema + persona-loader + snapshot-latest helper. Plan-creation
  snapshots the latest tag per persona; updates to repo don't
  retroactively change running plans.
- **Skill promotion path** (PR-83) — copy + manifest-rewrite +
  demotion-eligibility (90d unused) + stack-fingerprint + cleanup
  helpers. Actual `gh pr create` against futurator-skills is follow-on.

**Phase 2 wrap (PR-84..PR-101 — 18 stories):**

- **metrics.csv per plan** (PR-84) — daemon helper that streams
  `step_complete` events to `<plan-workingDir>/.pipeline/metrics.csv`
  - rolling-median computation + 1.5× wave-threshold check.
- **Commit metadata template** (PR-85) — full v2.5 §23 (Plan-Id, Plan,
  Wave, Story, Agent, Stream, Reflection-Id) appended to existing PR-73
  skills lines via repeated `-m` flags.
- **Per-story worktree paths** (PR-86) — pure helpers for
  `wip/<storyId>`, `/home/ubuntu/worktrees/<project>/<plan>/<storyId>`,
  `explore/<plan-id>-<approach>`, `archive/...-rejected`, `stream/<n>`,
  `experiment/<n>`, `hotfix/<tag>` naming + path-traversal guards.
- **Distributed merge lock** (PR-87) — DDB conditional-write
  (`PK=LOCK#<project-slug>`, `SK=MERGE`) with 5-min TTL crash recovery.
- **aws.manifest.yaml schema** (PR-88) — Zod schema + emptyManifest +
  hasProductionDeployGate + hasProductionSoakScript helpers.
- **integrations.manifest.yaml schema** (PR-89) — looser passthrough
  schema + effectiveRotationCadence + resolveSecretPath helpers.
- **ARCHITECT agent + T1/T2/T3** (PR-90) — pipeline + role + prompt
  with three trigger templates + greenfield Opus auto-pick.
- **API-AUTHOR step** (PR-91) — pipeline + prompt + shouldRunApiAuthor
  gate (prototype skip, stub-boilerplate skip) + module-dir inference
  from touch points.
- **acceptBaselineDrift** (PR-92) — PR label detection for production,
  decision-card flow for mvp/prototype, baseline-roll-forward on green.
- **CDK generation from manifest** (PR-96) — emits CDK TypeScript for
  11 service kinds (s3, dynamodb, lambda, ecs-fargate, ecs-fargate-gpu,
  cloudfront, api-gateway, bedrock-model-access, secrets-manager, sqs,
  sns) + bin/ entrypoint generator + supportedServiceKinds list.
- **Cost engine + cost-shim format** (PR-97 + PR-99) — pluggable shim
  registry with built-ins for the 11 kinds + `registerShim` for skill-
  delivered extensions + monthly USD estimation per env/manifest +
  cost-envelope alert thresholds + append-only `cost-history.csv`.
- **Production soak poller** (PR-98) — 24h soak window evaluator with
  three conditions (5xx < 0.5%, dependency-err < 1%, smoke = 100%) +
  attention factory for soak-failed.
- **Plan-tag → semver promotion** (PR-93) — `<project>-plan-<slug>`,
  `<project>-v<semver>`, rigor-upgrade, skill-author tag builders +
  classifyTag parser + nextSemver bumper.
- **OIDC role naming + trust policy** (PR-94) — `futurator-pipeline-
<appSlug>-<env>` + per-env IAM trust policy templates (dev=main,
  staging=plan-tag, production=semver-tag) + deploy-workflow path.
- **Wave-merge --no-ff flow** (PR-95) — per-story merge command builder
  with commit-metadata flags + outcome classifier (success / merge-
  conflict / wave-build-failed) + per-outcome attention factories +
  wave-base ref derivation + cleanup-branch list.
- **Stream branches + auto-archive** (PR-100) — 30d idle detection
  - archive name `archive/stream-<name>-<YYYYMMDD>` + graduation-
    proposal builder + low-severity attention before archive.
- **Implementation Spec plan template** (PR-101) — `Plan.kind:
implementation-spec` 5-epic template (ARCHITECT delta → COMPILER CDK
  gen → cdk synth → cdk diff → cdk deploy) + gate-fires-under-rigor
  matrix.

The Phase 3 + Phase 2 stories that remain are either **trigger-wiring
follow-ons** (each ~½ day, bounded contract from a sibling helper) or
**operator-side org provisioning** (no code).

### Still uncovered

- **bootstrap-ast.mjs auto-trigger from app-bootstrap.** Slice C ships
  the script; the daemon's `app-bootstrap.mjs` pipeline still needs the
  hook that invokes it after the git-clone step. Today the operator runs
  it via SSH (§2.7).
- **Cross-file CALLS resolution.** Slice B only links same-file callees.
  Cross-file requires walking the IMPORTS edges to resolve a callee name
  to its defining `:Function` node. Useful for true "impact analysis"
  queries.
- **Path-alias resolution in IMPORTS edges.** `@/lib/util` and tsconfig
  `paths` mappings are currently dropped. Adding them needs a tsconfig
  parser at `ast-extract` boot time.
- **Graph viewer search box.** Today queries live in SSH +
  `graph-search.mjs`. The natural next iteration is a search input on the
  Graph tab that calls a new `/api/graph-search` Lambda route wrapping
  the existing script's semantics.
- **Function-body embeddings.** Voyage embeddings today are per-wiki-
  article (file-level). Embedding individual function bodies separately
  would enable "find functions with similar logic" queries.
- **Contract-approval card UI.** Still operator-via-console. Should
  surface as a card on the QA Review page when `qaContractStatus ===
'pending'`. Tracked separately.
- **Slug mismatch in `/api/epic-workflows/:id/deploy`.** Documented in
  §4.2; small PR to land.
- **PM emitting `visualTests` block at plan-creation time** (rather than
  leaving it to the dev agent's VISUAL_TESTS output). Would lock the
  test contract before code is written.
- **L0 → L1 retroactive bump on classifier change.** Existing plans
  whose tests were classified pre-PR-62 still carry L0. New runs of
  those plans pick up the new floor; in-flight QA jobs do not.
- **Cohort baseline data.** Need 5+ plan runs for `cohort` field in
  forensic to populate.
- **Tamper-check for non-test files.** Currently only protects test
  files between test-author and dev. A dev agent that "fixes" their own
  prior story's source files mid-run isn't caught.
- **Per-story `wip/<storyId>` branches + worktrees** (Phase 2-B, 0/12
  shipped). Stories still commit directly to `main` via per-story
  push (PR-19). Phase 3-S `explore/` speculation is blocked on this.
- **`aws.manifest.yaml` + ARCHITECT + CDK** (Phase 2-D, 0/18 shipped).
  Phase 3-F brownfield migration is blocked on this.

If you start hitting one of these in Phase 3, that's the signal to ship
the corresponding PR.

---

## 10. Quick links

- **Identity check**: sidebar `v<hash>` should match `git rev-parse --short HEAD`
- **Lambda URL**: https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws/
- **Admin UI**: https://admin.futurator.ai
- **Knowledge graph (per project)**: https://admin.futurator.ai/development/graph?projectId=&lt;id&gt;
- **Knowledge graph (per plan)**: GRAPH subtab inside any plan's developing view
- **Graph snapshot URL**: https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live/&lt;projectId&gt;/_graph/graph-snapshot.json
- **Published apps**: https://futurator.ai/apps/&lt;slug&gt;/
- **Screenshots**: s3://futurator-ai-website/{review-screenshots,qa-snapshots}/
- **Daemon log**: `journalctl -u futurator-daemon -f` (SSH `54.86.226.233`)
- **Memgraph (bolt)**: `bolt://localhost:7687` on the EC2 host. Creds in `/opt/futurator-daemon/.env` (`MEMGRAPH_USER` / `MEMGRAPH_PASSWORD`).

---

_Last reviewed: 2026-05-16 against HEAD `d168114-dirty` + Phase 3 PRs
PR-69/70/71/72/73/74/76/77 in working tree + Mycelium activation
sequence (Memgraph live + Graph viewer + tree-sitter Slice A/B/C, see
PRs #1–#4 against `main`). When the next plan ships and reality drifts,
edit inline rather than appending notes._
