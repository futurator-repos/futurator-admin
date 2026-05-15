# Pipeline v2 — substrate testing guide

> **Authored 2026-05-16** against commits d28b7c8 + 1a045bd + 72792f9
> on branch `feat/treesitter-slice-c-brownfield-bootstrap`.
> Sibling: `blueprint-spyhunter-2-and-pr-59-65-expectations.md` (the
> "what should happen vs. what actually happens" reference doc).
>
> **Purpose.** Hands-on test plan for the 34 substrate stories now in
> production after `sst deploy --stage production` + daemon restart.
> Two scenarios: (1) **new app + new plan** and (2) **brownfield plan
> on existing app**. Each scenario maps observable signals to the PR
> that ships them so test failures are diagnosable.

---

## 0. Pre-flight (do this once, before any scenario)

### 0.1 Confirm deploy landed

```bash
# Sidebar `v<hash>` in admin UI should match:
git rev-parse --short HEAD
# Or via API health endpoint:
curl -sS https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws/api/health \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["buildHash"])'
```

Expected: short SHA matches the most recent commit
(`72792f9` for this session, or later).

### 0.2 Confirm daemon restarted with new code

```bash
ssh ec2 'sudo systemctl restart futurator-daemon'
ssh ec2 'journalctl -u futurator-daemon -n 50 --no-pager'
```

Look for **all four** new substrate log lines after `configure-git-identity`:

```
[info] federation-loader: fallback (path=/home/ubuntu/.futurator/skill-federation.yaml, 3 sources, sha=<8-char>)
[info] federation-backup: daily schedule armed
[info] federation-resolver: ready
[info] memory-store: provisioned N dir(s) under /mnt/memory
```

If any are missing → the daemon didn't pick up the new code. Re-deploy
or rebuild the daemon's working copy on EC2.

### 0.3 Confirm /labs/reflections renders

Visit `https://admin.futurator.ai/labs/reflections`. Expected:

- Empty inbox (filter chips: pending / all / confirmed / declined / deferred)
- Target chips (CLAUDE.md / project skills / org skills / personas / pipeline tuning / tool wrappers)
- "0 pending REFLECTOR proposals across all projects" header
- No console errors

Fails? Check Lambda env for `REFLECTIONS_TABLE`; check DDB table
`futurator-reflections` exists.

### 0.4 Confirm ReflectionsTable exists

```bash
aws dynamodb describe-table --table-name futurator-reflections \
  --region us-east-1 --query 'Table.{Status:TableStatus,PITR:PointInTimeRecoverySummary}'
```

Expected: `Status: ACTIVE` and PITR enabled.

### 0.5 Optional: exercise the Inbox via direct API

Useful for testing the UI before REFLECTOR scheduler is wired in
(PR-74-followup). Direct POST a synthetic reflection row to DDB and
confirm it surfaces in the UI.

```bash
# Use AWS DDB put-item to insert a row with the shape from
# functions/shared/types/reflection.ts ReflectionRow. The /labs/
# reflections page will pick it up on next 30s poll.
```

Acceptance: row appears in the page; clicking expands rationale +
evidence + content; Confirm/Decline/Defer buttons toggle optimistic
state. (Confirm currently records the decision but doesn't materialize
the diff on disk — PR-76-followup wires that.)

---

## Scenario 1 — New app + new plan (greenfield)

Tests the **forward-looking substrate**: skills manifest scaffold,
CLAUDE.md template, API-AUTHOR step, SKILL-SCOUT/ARCHITECT T1 markers.

### 1.1 Create the app

In admin UI: `+ New App` → **Next.js + BMAD** → slug `dino-runner-2`
(or any unused slug matching `[a-z][a-z0-9-]{1,39}`) → Submit.

Within 90s the app should appear in the apps grid. Open it.

### 1.2 Inspect the app's new substrate files (PR-71 + PR-80)

SSH to EC2 (or use the Source tab in the App detail):

```bash
ssh ec2 'cat /home/ubuntu/projects/dino-runner-2/.claude/skills.manifest.yaml'
```

Expected — project slug substituted, all kind buckets empty:

```yaml
project: dino-runner-2
manifest-version: 1
generated-by: bootstrap@v2.5
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
```

```bash
ssh ec2 'cat /home/ubuntu/projects/dino-runner-2/CLAUDE.md | head -20'
```

Expected — v2.5 §41.1 template with sections "What this is",
"Architecture decisions", "Constraints discovered", "Patterns to use /
avoid", "Domain glossary", "Skills loaded by default", "AWS scoping
reminder", "Known issues / future enhancements". Slug + display name
substituted at top.

```bash
ssh ec2 'ls /home/ubuntu/projects/dino-runner-2/.claude/'
# expect: skills.manifest.yaml  skills/  (skills/ contains a .gitignore)

ssh ec2 'ls /home/ubuntu/projects/dino-runner-2/scripts/'
# expect: capture-test-baseline.sh  check-regressions.sh  skills-sync.mjs
```

Fail mode: any of these files missing → boilerplate registry didn't
apply the augments. Check `functions/shared/boilerplates/registry.ts`
augmentFiles + that the bootstrap saga ran post-create steps.

### 1.3 Inspect the app-bootstrap forensic for T1 markers (PR-72/90-followup)

```bash
ssh ec2 'journalctl -u futurator-daemon -n 200 --no-pager' \
  | grep -E 'app-bootstrap|skill-scout|architect'
```

Expected to see:

```
pv2.app-bootstrap.completed { appId: dino-runner-2, boilerplateType: nextjs-base, ... }
pv2.skill-scout.queued      { appId: dino-runner-2, trigger: T1, ... }
pv2.architect.queued        { appId: dino-runner-2, trigger: T1, ... }
```

These events are the **observable signals that SKILL-SCOUT and
ARCHITECT are ready to fire**. The dedicated spawn-integration PR will
pick these markers up and enqueue agent-job rows for the actual agent
spawn — that's the next wire-in.

### 1.4 Create a plan + watch CLAUDE.md prepend in forensic (PR-80-followup)

In admin UI: open `dino-runner-2` → "+ New Plan" → enter a small
intent like "Show 'Hello dino' in the page title". Pick **mvp** rigor.
Submit.

While the plan runs, watch for:

```bash
ssh ec2 'tail -f /var/log/futurator/events/*.ndjson' \
  | jq 'select(.type == "claude_md_loaded")'
```

Expected — every agent invocation (PM, API-AUTHOR, TEST, DEV, REVIEWER,
COMPILER) emits a `claude_md_loaded` event:

```json
{
  "type": "claude_md_loaded",
  "text": "CLAUDE.md loaded from /home/ubuntu/projects/dino-runner-2",
  "sha": "<16-char-hex>",
  "sizeBytes": <N>,
  "truncated": false
}
```

Failure modes:

- `sha` absent → loader returned null (CLAUDE.md not on disk). Check
  the boilerplate augment.
- `truncated: true` → CLAUDE.md grew past 100KB. The agent gets a
  truncation marker instead of the content. Operator action: trim
  CLAUDE.md.
- No `claude_md_loaded` event at all → PR-80-followup wire-in regressed.
  Re-check `executeStep` in `daemon/agent-daemon.mjs`.

### 1.5 Watch API-AUTHOR step fire (PR-91-followup)

Under **mvp rigor**, the story pipeline now runs `api-author` as the
first step of each story (before `test-author`). In the plan dashboard
or forensic JSON, look for:

```
step.api-author { agentId: API_AUTHOR, story: <storyId>, durationMs: ... }
```

Or in the forensic JSON `events[]`:

```json
{
  "stepId": "api-author",
  "agentId": "API_AUTHOR",
  "type": "step_complete"
}
```

Confirm a `.d.ts` was written under `src/`:

```bash
ssh ec2 'find /home/ubuntu/projects/dino-runner-2/src -name "index.d.ts" -newer /tmp/timestamp-ref 2>/dev/null'
```

(Note: until module-dir inference threads through to the api-author
step's prompt args — a follow-on micro-PR — the default `moduleDir`
is just `src`, so look for `src/index.d.ts` first.)

Failure modes:

- No api-author step in forensic → check that rigor is mvp+ and
  boilerplate is nextjs-\* (stub boilerplates skip the step).
- Step runs but no `.d.ts` written → check the agent's allowedTools
  - that the prompt's "Write directly via the Write tool" instruction
    was understood. Default model is sonnet; turn cap is 2.

### 1.6 Watch Skills-Used commit metadata land (PR-73 + PR-85)

After a story completes and the compile-commit-on-pass step runs:

```bash
ssh ec2 'cd /home/ubuntu/projects/dino-runner-2 && git log -1 --format=%B'
```

Expected — commit message includes:

```
story: <storyId> — <title>

Skills-Used:

Skills-Manifest-Sha: <64-char-hex>
```

`Skills-Used:` will be the empty-label form because SKILL-SCOUT hasn't
populated the manifest yet (its spawn-integration PR is pending). The
`Skills-Manifest-Sha:` line should be populated — it hashes the
yaml-empty manifest from §1.2.

Query history:

```bash
ssh ec2 'cd /home/ubuntu/projects/dino-runner-2 && \
  git log --grep="Skills-Manifest-Sha:"'
```

### 1.7 Plan completes; check post-mortem signals

After the plan finishes, capture:

| Artifact         | How                                     | What to check                                                                                               |
| ---------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Forensic JSON    | `GET /api/plans/:id/forensic`           | `claude_md_loaded` events on every agent step; api-author step entries; T1 markers in app-bootstrap subtree |
| Commit graph     | `git log --oneline` in the project repo | Per-story commits carry the Skills-Manifest-Sha line; api-author commits exist for mvp+                     |
| Reflection Inbox | `/labs/reflections`                     | Still empty (REFLECTOR scheduler is PR-74-followup)                                                         |
| Plan tag         | `git tag -l` in the project             | `<slug>-plan-<plan-slug>` tag created on plan close                                                         |

---

## Scenario 2 — Brownfield plan (existing app)

Tests the **rear-looking substrate**: SKILL-SCOUT T2 + ARCHITECT T2 +
CLAUDE.md flowing into agents in a project that was created
**before** the substrate landed.

### 2.1 Pick an existing app

Use `dino-runner-1` (Phase 1 test bed) or any other pre-Phase-3 app.

### 2.2 Apply the substrate retroactively (one-time per app)

Existing apps don't have the new boilerplate augments because they
were bootstrapped before PR-71/PR-80. Manually drop them in:

```bash
# Copy the empty skills manifest:
ssh ec2 << 'EOF'
cd /home/ubuntu/projects/dino-runner-1
mkdir -p .claude/skills
cat > .claude/skills.manifest.yaml << 'YAML'
project: dino-runner-1
manifest-version: 1
generated-by: brownfield@v2.5
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
YAML
cat > .claude/skills/.gitignore << 'GI'
*
!.gitignore
!*/SKILL.md
!*/meta.json
GI
git add -A && git -c user.email=daemon@futurator.local -c user.name=Daemon \
  commit -m 'brownfield: scaffold skills manifest'
EOF
```

The CLAUDE.md may or may not already exist. If absent, copy the v2.5
§41.1 template from the boilerplate registry (or use the operator's
existing CLAUDE.md — the loader doesn't care about template fidelity).

### 2.3 Create a new plan against the existing app

In admin UI: open `dino-runner-1` → "+ New Plan" → intent like
"Add a high-score counter to the dino game" → mvp rigor → Submit.

### 2.4 Watch CLAUDE.md prepend

Same expected behavior as §1.4 — every agent step emits
`claude_md_loaded`. Brownfield-specific check: if the project's
CLAUDE.md has accumulated content (Architecture decisions appended by
prior plans, Constraints discovered, Patterns to use/avoid), the
agents see all of it.

### 2.5 No T1 markers (T1 fires only at app-bootstrap)

Because the app already exists, app-bootstrap doesn't run. Therefore
**no** `pv2.skill-scout.queued T1` or `pv2.architect.queued T1` events
land in the forensic.

For brownfield, the equivalent is **T2** (plan intent submitted) and
**T3** (brownfield audit). T2 wiring lands as part of PR-72-followup's
plan-pipeline integration; T3 fires on operator-initiated `/skills
audit` (PR-72-followup API route). Until those land, T2/T3 markers
won't appear; the substrate is ready but the events haven't been
emitted yet.

### 2.6 API-AUTHOR step still fires

Same as §1.5 — every mvp+ story gets api-author before test-author,
regardless of whether the project is greenfield or brownfield.

### 2.7 Skills-Used commit metadata

Same as §1.6 — the `Skills-Manifest-Sha` hashes whatever's currently
in `.claude/skills.manifest.yaml` (empty manifest from §2.2 → hash
of the YAML you wrote).

### 2.8 Compare against a pre-Phase-3 plan

Optional: pick a plan that ran before this deploy (look at older
plans in the dashboard). Open its forensic JSON. **Expected: no**
`claude_md_loaded` events, **no** `api-author` steps, **no**
Skills-Manifest-Sha lines in commits. That's your baseline — it
confirms the substrate is genuinely new behavior, not a re-render of
existing data.

---

## Reflection Inbox manual test (no REFLECTOR scheduler yet)

REFLECTOR doesn't auto-fire until PR-74-followup ships. To exercise
the Reflection Inbox UI today, manually insert a row via DDB:

```bash
aws dynamodb put-item --region us-east-1 --table-name futurator-reflections --item '{
  "projectSlug": {"S": "dino-runner-2"},
  "id":          {"S": "20260516000000-test1234"},
  "createdAt":   {"S": "2026-05-16T00:00:00Z"},
  "planId":      {"S": "test-plan"},
  "scope":       {"S": "plan"},
  "target":      {"S": "project-claude-md"},
  "action":      {"S": "append-section"},
  "section":     {"S": "Patterns to avoid"},
  "content":     {"S": "Do not invent type names that differ between TEST and DEV. API-AUTHOR enforces this from PR-91 onwards."},
  "rationale":   {"S": "Smoke-test row for the inbox UI."},
  "evidence":    {"L": [{"S": "test-evidence-1"}]},
  "confidence":  {"N": "0.85"},
  "status":      {"S": "pending"}
}'
```

Refresh `/labs/reflections` — the row should appear. Expand it, try
Confirm / Decline / Defer. Confirm currently transitions the row to
`confirmed` but does **not** materialize the diff on disk (PR-76-
followup wires the actual REFLECTOR-APPLY commit). Decline + Defer
work end-to-end.

---

## Substrate-readiness matrix

What this deploy makes observable per substrate piece:

| Substrate (PR)                              | Observable signal                                                          | Where to look                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Federation loader (PR-69)                   | Daemon startup log line                                                    | `journalctl -u futurator-daemon`                 |
| Federation backup (PR-69)                   | Daily S3 write to `s3://futurator-config/<operator>/skill-federation.yaml` | S3 bucket; first write 60s after daemon start    |
| Federation resolver (PR-70)                 | Daemon startup log line                                                    | journalctl                                       |
| Project skill manifest (PR-71)              | Fresh app has `.claude/skills.manifest.yaml`                               | §1.2                                             |
| SKILL-SCOUT agent (PR-72)                   | T1 marker at app-bootstrap end                                             | §1.3                                             |
| Skills-Used commit metadata (PR-73 + PR-85) | Commit message lines                                                       | §1.6                                             |
| REFLECTOR agent (PR-74)                     | (pending PR-74-followup scheduler)                                         | Manual DDB insert exercises the inbox            |
| Reflection Inbox UI (PR-76)                 | `/labs/reflections` renders                                                | §0.3                                             |
| Memory store (PR-77)                        | Daemon startup log line + `/mnt/memory/` dirs                              | journalctl + `ssh ec2 'ls /mnt/memory'`          |
| Pre-flight allowlist (PR-78)                | (pending REFLECTOR scheduler)                                              | Not testable until rows produced                 |
| SKILL-SCOUT T4-T8 (PR-79)                   | Various — depends on which trigger                                         | Not all triggers wired yet                       |
| CLAUDE.md prepend (PR-80)                   | `claude_md_loaded` forensic event per agent step                           | §1.4                                             |
| Triage agent (PR-81)                        | (pending feedback-arrival hook)                                            | Not testable yet                                 |
| Persona evolution (PR-82)                   | Plan.personaPinned snapshot at plan-create                                 | DDB plans table                                  |
| Skill promotion (PR-83)                     | (pending REFLECTOR confirm flow)                                           | Not testable yet                                 |
| metrics.csv (PR-84)                         | (pending step_complete tee)                                                | `.pipeline/metrics.csv` should appear once wired |
| ARCHITECT agent (PR-90)                     | T1 marker at app-bootstrap end                                             | §1.3                                             |
| API-AUTHOR step (PR-91)                     | `api-author` step in forensic for mvp+                                     | §1.5                                             |
| acceptBaselineDrift (PR-92)                 | (pending decision-card render)                                             | Not testable yet                                 |
| Plan tag → semver (PR-93)                   | `<slug>-plan-<plan-slug>` tag on plan close                                | §1.7                                             |
| OIDC role naming (PR-94)                    | (used by brownfield audit)                                                 | Not testable until 3-F-1 wired                   |
| Wave-merge --no-ff (PR-95)                  | (pending orchestration)                                                    | Stories still commit to main today               |
| CDK from manifest (PR-96)                   | (used by impl-spec plans)                                                  | Not testable until ARCHITECT-spawn integration   |
| Cost engine (PR-97)                         | (used by ARCHITECT cost-delta)                                             | Not testable until ARCHITECT spawn               |
| Soak poller (PR-98)                         | (production-rigor only)                                                    | Not testable on prototype/mvp plans              |
| Cost history (PR-99)                        | (used by drift cron)                                                       | Not testable until cron wired                    |
| Stream archive (PR-100)                     | (weekly GC)                                                                | Not testable until daemon GC wire                |
| Impl-spec template (PR-101)                 | (used by AWS-only plans)                                                   | Not testable until plan-creator integration      |

---

## Failure-mode quick-reference

| Symptom                                             | Most likely cause                               | Fix                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/labs/reflections` 404                             | Static export didn't include the page           | Verify `npm run build` output contains `/labs/reflections`; re-deploy                                 |
| Daemon startup missing federation lines             | Daemon didn't pick up new code                  | `sudo systemctl restart futurator-daemon`; verify `git log` on EC2 matches local                      |
| `ReflectionsTable` access denied in Lambda          | SST `link[]` change didn't apply                | Re-deploy with `sst deploy --stage production --refresh`                                              |
| New apps don't get CLAUDE.md / skills.manifest.yaml | Boilerplate registry change didn't apply        | Check `functions/shared/boilerplates/registry.ts` augmentFiles in deployed Lambda; rebuild + redeploy |
| `claude_md_loaded` events missing                   | PR-80-followup regressed in `agent-daemon.mjs`  | Verify `readClaudeMd` import + `appendSystemPrompt` opt threading                                     |
| `api-author` step doesn't run                       | Rigor is prototype OR boilerplate is stub       | Check plan rigor in DDB; check boilerplate kind                                                       |
| `pv2.skill-scout.queued T1` event missing           | PR-72-followup regressed in `app-bootstrap.mjs` | Verify `pushEvent` calls after `pv2.app-bootstrap.completed`                                          |
| Inbox UI shows rows but Confirm doesn't commit      | Expected — `reflector-apply.mjs` is a stub      | PR-76-followup wires the on-disk apply                                                                |
| `Skills-Manifest-Sha` line missing from commits     | Rigor is prototype                              | mvp+ required (v2.5 §42 rigor matrix)                                                                 |

---

## Cleanup after testing

```bash
# If you created test apps, archive them via the admin UI's
# delete-app flow (the App-bootstrap saga has a delete handler that
# cleans both GitHub repo + EC2 working tree + DDB row).
```

For inserted-by-hand reflections rows:

```bash
aws dynamodb delete-item --region us-east-1 --table-name futurator-reflections \
  --key '{"projectSlug": {"S": "dino-runner-2"}, "id": {"S": "20260516000000-test1234"}}'
```

---

## What you'll learn from these tests

- ✅ **Substrate is correctly deployed** if the four daemon startup
  lines + the `/labs/reflections` page + the new files in fresh apps
  all materialize.
- ✅ **Agent prompts are CLAUDE.md-aware** if every agent step in a
  new plan emits `claude_md_loaded`.
- ✅ **API-AUTHOR closes the name-mismatch failure class** if mvp+
  stories produce an `index.d.ts` and downstream TEST + DEV both
  import from it.
- ✅ **T1 markers fire** if app-bootstrap emits the two
  `pv2.{skill-scout,architect}.queued` events.
- ⏳ **What's NOT yet testable** without follow-on PRs:
  REFLECTOR auto-fire, SKILL-SCOUT/ARCHITECT actual proposal cards,
  T4-T8 triggers, baseline-drift cards, per-story worktrees, wave-merge
  --no-ff, 24h soak, drift detection.

Each gap is documented in the blueprint §9 with the corresponding
follow-on PR.

---

_Last updated: 2026-05-16 against d28b7c8 + 72792f9. Update this doc
inline if the substrate ships further wiring._
