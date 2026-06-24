# Ultracode-Reverse bench — M3 EC2 validation gate

> The M3 daemon job (`jobType: 'ultracode-bench'`) is BUILT and unit-tested (the runner orchestration
> is green with mocked deps), but two load-bearing assumptions are **UNPROVEN until run on real EC2**.
> Validate these BEFORE trusting any bench numbers. Until then, the runner correctly TAINTS and
> excludes any rep that can't prove a clean capture — it never reports a fake zero-token result.

## The two unknowns to prove

### V1 — does headless `claude -p "ultracode <intent>"` write a planner script?
Print mode (`-p`) may be TUI-only and never invoke the dynamic-workflow planner. The capture watches
`~/.claude/projects/<munged-cwd>/<session>/workflows/scripts/*.js`.

```bash
# on the EC2 daemon host, in the daemon env (OAuth creds present):
cd /home/ubuntu && mkdir -p uctest && cd uctest
claude -p "ultracode create me a pacman game" --model opus --permission-mode bypassPermissions &
CLAUDE_PID=$!
# in another shell, watch for the script:
watch -n0.2 'find ~/.claude/projects -path "*/workflows/scripts/*.js" -newermt "-2 min"'
```
- **PASS:** a `*-wf_*.js` appears → capture works; proceed to V2.
- **FAIL:** no script after ~30s → print mode doesn't trigger the planner. Fallback: drive Case 1 via
  **node-pty** (interactive) with watch+cancel (the spike's `case1-runner.mjs` path), which the runner
  can adopt by swapping `captureCase1`. Record the outcome here.

### V2 — does SIGKILL-on-script leave `agentCount === 0`?
The halt design waits for the sibling `wf_<id>.json` to be **size-stable across two ticks** (it carries
the authoritative `agentCount`), then reads it and SIGKILLs. Verify the kill actually precedes fan-out:

```bash
# after V1 produces a script, immediately after the runner's kill, inspect:
WF=$(find ~/.claude/projects -path "*/workflows/wf_*.json" -newermt "-2 min" | head -1)
jq '.agentCount, (.phases|length)' "$WF"          # expect agentCount == 0
ls "$(dirname "$WF")/../subagents/workflows/" 2>/dev/null   # expect EMPTY (no agent-*.jsonl)
```
- **PASS:** `agentCount: 0` + empty `subagents/workflows/` → the kill is a clean halt.
- **FAIL:** `agentCount > 0` or transcripts present → agents spawned before the kill. The runner
  already TAINTS this (excludes the rep), but if it's the common case, tighten the halt: kill earlier
  (on the `.js` create, accepting a partially-written script + re-read), or lower the poll interval.

### V3 — the `--effort xhigh` flag
The capture passes `--effort xhigh` to both spawns for the fair-frame model+effort match. **Confirm the
exact CLI flag** (`claude --help | grep -i effort`); if it differs, fix `ultracode-bench-capture.mjs`.
A wrong flag makes the spawn error → the rep taints (safe, but no data).

## Out-of-band IAM (REQUIRED — `sst deploy` does NOT grant this)
The daemon runs on EC2 under its instance role (`develope-it-ec2-ssm`), which SST does not manage.
Attach, or the runner's `updateRun` silently 403s:
```
dynamodb:PutItem, UpdateItem, Query   on  arn:aws:dynamodb:us-east-1:*:table/futurator-ultracode-runs
                                      and its indexes (operator-createdAt-index, status-createdAt-index)
```
(No S3 needed yet — M3 stores the scorecard inline on the row; artifacts-to-S3 is a later milestone.)

## Shipping the engine to the daemon
The scorers + meta-prompt are **vendored under `daemon/lib/ultracode/`** (the spike `.mjs` are NOT
shipped by `rsync-daemon.sh`). The daemon needs `typescript` (added to `daemon/package.json`) for the
AST parser — run `cd daemon && npm install` on the host (or in the rsync image) before restart.

## Deploy sequence (additive, dark)
1. `npm run ci` locally (note: the branch has pre-existing typecheck errors unrelated to this module).
2. `sst deploy` (production stage — the only allowed stage; provisions `UltracodeRunsTable` additively,
   relinks the API Lambda with `ULTRACODE_RUNS_TABLE`). **Never** `--stage <x>` (fatal) or `aws s3 sync
   out/ s3://futurator-ai-website/` (forbidden, CLAUDE.md).
3. Attach the out-of-band IAM (above) to the EC2 role.
4. `cd daemon && npm install` on the host; `./scripts/rsync-daemon.sh` (coordinate the systemd restart
   so a running job on the shared daemon isn't interrupted).
5. Run V1/V2/V3 above. Then submit a run from `/labs/ultracode-reverse` and watch it go
   `QUEUED → CAPTURING → HALTED → SCORING → COMPLETE`.

## Status
- Runner orchestration: ✅ unit-tested (7/7, mocked deps) — taint/exclude, reps aggregation, events.
- Capture + halt + spawns: ⛔ built, **awaiting V1–V3 on EC2**.
- Daemon wiring (dispatch, spend class, updateRun, meta-prompt load): ✅ built, syntax-checked.
- IAM + deploy + `npm install`: ⛔ operator steps (above).
