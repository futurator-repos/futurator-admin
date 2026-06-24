# HANDOFF → merge `ultra-reverse` to test the Ultracode-Reverse module

**To:** the agent on the other machine (the one with AWS CLI + deploy rights).
**From:** the ultra-reverse build. **Date:** 2026-06-24. **Branch:** `origin/ultra-reverse`.

Richie wants to test the new **`ultracode-reverse`** admin module live. It's fully built and committed
on `origin/ultra-reverse`. Everything is **additive** — a new DynamoDB table, a new daemon `jobType`,
a new `/labs/ultracode-reverse` page. **No shared table is reshaped**, so it can't collide with the
features you're building. Please merge it into your branch and deploy it (dark/additive), then ping
Richie to test.

---

## 1. Merge it (recommended: merge the whole branch)

```bash
git fetch origin
git merge origin/ultra-reverse          # additive; conflicts only where your base diverges
# (or, if you prefer onto a fresh branch:)
# git checkout -b test/ultracode-reverse origin/ultra-reverse
```

The module's 6 commits are `c2cbd1f..417c113`. **Dependency note:** the module imports the
`pipeline-v3` services (`functions/shared/services/story-waves.ts`, `pipelines/role-policy.ts`,
`scorecard/types.ts`). `origin/ultra-reverse` already contains the full pipeline-v3 base, so merging
the whole branch is the safe path. Only cherry-pick `c2cbd1f..417c113` if your branch ALREADY has
those pipeline-v3 services — otherwise the build breaks.

---

## 2. Deploy (additive, dark, production stage only)

```bash
npm run ci            # NOTE: the branch has ~61 PRE-EXISTING typecheck errors unrelated to this
                      # module (timing-routes, index.ts, etc.). The ultracode-reverse files are clean.
sst deploy            # production stage ONLY (sst.config.ts hard-throws on any --stage). Provisions
                      # UltracodeRunsTable additively + relinks the API Lambda with ULTRACODE_RUNS_TABLE.
```
**FORBIDDEN** (CLAUDE.md): `sst deploy --stage <x>` (fatal), `aws s3 sync out/ s3://futurator-ai-website/`.

### 2a. Out-of-band IAM — REQUIRED (`sst deploy` does NOT grant this)
The daemon runs on EC2 under its instance role; SST doesn't manage it. Attach, or the daemon's
write-back silently 403s:
```
dynamodb:PutItem, UpdateItem, Query
   on arn:aws:dynamodb:us-east-1:*:table/futurator-ultracode-runs  (+ its GSIs)
```

### 2b. Daemon update
```bash
cd daemon && npm install        # the module added `typescript` (the AST parser) to daemon deps
./scripts/rsync-daemon.sh       # ships daemon/lib/ultracode/* + the new runners; coordinate the
                                # systemd restart so a running job isn't interrupted
```

---

## 3. Validate the capture on EC2 (the one unproven part)

The Case-1 capture (kill-on-script-write halt) and the headless `ultracode` trigger are UNPROVEN until
run on real EC2. Run **V1/V2/V3** from `docs/concepts/pipeline-v3/ultracode-bench-ec2-validation.md`
before trusting numbers. The runner is safe regardless: any rep that can't prove a clean zero-agent
capture is TAINTED and excluded — it never reports a fake result. If V1 fails (print mode is TUI-only),
the doc has the node-pty fallback.

---

## 4. How Richie tests it

1. Open **`https://admin.futurator.ai/labs/ultracode-reverse`** (it's in the Development sidebar).
2. Enter an intent (e.g. "create me a pacman game"), pick target/rigor/reps, Run.
3. Watch the run go `QUEUED → CAPTURING → HALTED → SCORING → COMPLETE`; the dual terminals stream
   Case 1 (native ultracode) and Case 2 (our meta-prompt) live; the scorecard renders the structural
   diff when both halt.

What it measures: both engines run as a single `claude` at the **same model+effort** (Opus 4.8 ·
xhigh) — the only variable is the prompt (native ultracode vs. our Futurator Workflow Author
meta-prompt). Clean apples-to-apples planning-quality test. Guardrails are a deliberate later layer.

---

## 5. What's in the branch (commit stack)

```
417c113 M3 daemon ultracode-bench job-runner (symmetric capture + score)   ← 7/7 runner tests
296becc M2 frontend module (/labs/ultracode-reverse)                        ← npm run build passes
df9ca2b v0 Futurator Workflow Author meta-prompt (Case-2 system prompt)
adeffc1 M2 API routes + symmetric-frame job payload                         ← typecheck clean
7f0ee97 M2a TS scoring engine (Lambda-bundlable port of the .mjs)           ← 6/6 tests
c2cbd1f M1 data layer — run types, schema, repository, DDB table            ← 7/7 tests
```

Questions → ping the ultra-reverse build. Thanks!
