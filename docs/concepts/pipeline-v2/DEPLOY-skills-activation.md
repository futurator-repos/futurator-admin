# Deploy checklist — Pipeline v2 Skills Activation (Epics 1-7)

> **Goal.** Take the work landed in commits `0bb19fe..acb16e4` (Epics
> 2 through 7 of the skills-activation plan) from "shipped code" to
> "running in production." Skips Epic 1 (operator GitHub/AWS
> provisioning) where the operator's the only one with credentials.
>
> **Authored 2026-05-20** against HEAD `feat/treesitter-slice-c-brownfield-bootstrap`.
> Companion to `plan-skills-activation.md` (the strategic plan) and the
> per-epic tech specs (`tech-spec-epic-{2,3}-*.md`).

---

## What landed in code (recap)

| Epic                                           | Status                           | Commits              |
| ---------------------------------------------- | -------------------------------- | -------------------- |
| Epic 2 — Default skill loadout                 | ✅ Shipped                       | `0bb19fe`            |
| Epic 3 — SKILL-SCOUT T1+T2 modules + tech spec | ✅ Shipped                       | `73f4af3`, `8438fa1` |
| Epic 3 — Daemon dispatch wiring                | ✅ Shipped                       | `b7ecd53`            |
| Epic 4 — `loadedSkills[]` tracking             | ✅ Shipped                       | `b99c78c`            |
| Epic 7 — Observability page + forensic block   | ✅ Shipped                       | `fda50ed`            |
| Epic 5 — CLAUDE.md write hooks                 | ✅ Module shipped (wire-in held) | `f7627c2`            |
| Epic 6 — REFLECTOR scheduler                   | ✅ Module shipped (wire-in held) | `acb16e4`            |
| Epic 1 — Operator provisioning                 | ⏳ Manual (this doc)             | —                    |
| Epics 5/6 wire-ins                             | ⏳ Follow-on (~30 min each)      | —                    |

**Test footprint after this commit chain:** 261 unit tests across
13 suites (was 101 after Epic 2). Lint clean on all touched files.

---

## Epic 1 — Operator provisioning (DO THIS FIRST)

Without these, vendor-skills (Epic 2 Story 2.3) exits with code 1 on
every new app bootstrap, surfacing a `skill-sync-failed` attention.
Bootstrap STILL completes — but new SKILL.md files don't materialize.

### 1.1 — Create `futurator-skills` org repo on GitHub

```bash
# Create the repo via gh CLI (operator has the token):
gh repo create futurator/futurator-skills --public \
  --description "Org-wide skill federation source"

# Seed it with the Anthropic skills template:
cd /tmp
git clone https://github.com/futurator/futurator-skills.git
cd futurator-skills

# Add 2-3 seed skills as top-level dirs. Each needs a SKILL.md with
# YAML frontmatter (name + description) per anthropics/skills convention.
mkdir -p bmad-conventions memgraph-query-patterns pixel-art-canvas-game
cat > bmad-conventions/SKILL.md <<'EOF'
---
name: bmad-conventions
description: When working on a Futurator project that uses BMAD v6, apply the agent-orchestration patterns (Bedrock/Nimbus personas, party-mode workflows, story-pipeline structure) per docs/concepts/pipeline-v2/.
---

# BMAD conventions for Futurator projects
…seed content here…
EOF

# … repeat for the other two seeds …
git add . && git commit -m "feat: seed org skills" && git push
```

**Validation:** `curl -sSL https://api.github.com/repos/futurator/futurator-skills | jq .name`
returns the repo name (no longer 404).

### 1.2 — Author `~/.futurator/skill-federation.yaml` on EC2

```bash
ssh ubuntu@54.86.226.233
mkdir -p ~/.futurator
cat > ~/.futurator/skill-federation.yaml <<'YAML'
manifest-version: 1
sources:
  - id: anthropic-official
    url: https://github.com/anthropics/skills
    auto-trust: true
    priority: 1
  - id: futurator-internal
    url: https://github.com/futurator/futurator-skills
    auto-trust: true
    priority: 2
  - id: community
    url: https://github.com/anthropics/skills-community
    auto-trust: false
    priority: 99
refresh-cadence: weekly
YAML
```

### 1.3 — Reload federation in the running daemon

```bash
sudo systemctl status futurator-daemon  # confirm running
kill -USR1 $(systemctl show -p MainPID --value futurator-daemon)
journalctl -u futurator-daemon -n 5 | grep federation-loader
```

**Pass criteria:** log line reads `source=file (sha=<8-char>)` —
no longer `fallback`.

### 1.4 — Provision `s3://futurator-config/` bucket

```bash
aws s3 mb s3://futurator-config --region us-east-1
aws s3api put-bucket-versioning --bucket futurator-config \
  --versioning-configuration Status=Enabled
# (Optional) bucket policy to allow only the daemon's IAM role to write
```

**Validation:** wait 24h, then `aws s3 ls s3://futurator-config/default/`
shows `skill-federation.yaml` (synced by `federation-backup.mjs`).

---

## Epic 2-7 — Deploy the code

### Pre-flight

```bash
# Local: confirm the work is on the right branch and HEAD is clean.
cd /Users/ricardoarayafarias/GetReal/Futurator-Admin
git status --short
git log --oneline | head -10
```

Expected recent commits:

```
acb16e4 feat(skills): Epic 6 — REFLECTOR scheduler
f7627c2 feat(skills): Epic 5 — CLAUDE.md write hooks
fda50ed feat(skills): Epic 7 — observability
b99c78c feat(skills): Epic 4 — loadedSkills tracking
b7ecd53 feat(skills): Epic 3 daemon integration
8438fa1 feat(skills): ship Epic 3 — SKILL-SCOUT T1+T2 activation
73f4af3 docs(skills): tech spec for Epic 3
0bb19fe feat(skills): ship Epic 2 — default skill loadout
```

### Deploy the API Lambda + infra

```bash
# This deploys functions/api/index.ts → futurator-admin-production
# API Lambda + static frontend export to S3.
npm run build
sst deploy
```

**Pass criteria:** `sst deploy` reports `Done in Xs`. The sidebar
build-hash on the deployed admin UI matches `git rev-parse --short HEAD`.

### Restart the daemon on EC2 to pick up the new mjs modules

The daemon is a long-running process — pulling fresh code requires a
systemd restart.

```bash
ssh ubuntu@54.86.226.233
cd /opt/futurator-daemon
git pull origin feat/treesitter-slice-c-brownfield-bootstrap
sudo systemctl restart futurator-daemon
journalctl -u futurator-daemon -n 30
```

**Pass criteria:** daemon startup log shows all four expected lines:

- `federation-loader: source=file …` (NOT `fallback`)
- `federation-backup: daily schedule armed`
- `federation-resolver: ready`
- `memory-store: provisioned …`

---

## E2E validation — `dino-test-3`

### Create a fresh app

In the admin UI: **Labs → + New App**. Name: `dino-test-3`. Boilerplate:
`nextjs-canvas-game`. Submit.

### Verify Epic 2 (default skills vendored)

```bash
ssh ubuntu@54.86.226.233
ls /home/ubuntu/projects/dino-test-3/.claude/skills/
# Expect: algorithmic-art  canvas-design  frontend-design

wc -l /home/ubuntu/projects/dino-test-3/.claude/skills/canvas-design/SKILL.md
# Expect: > 0

cat /home/ubuntu/projects/dino-test-3/.claude/skills.manifest.yaml | head -10
# Expect: core[] has 3 entries
```

### Verify Epic 3 (T1 SKILL-SCOUT fires)

```bash
# Tail journalctl during bootstrap completion to see the SCOUT spawn:
journalctl -u futurator-daemon -f | grep -i scout

# In DDB:
aws dynamodb scan --table-name futurator-agent-jobs --region us-east-1 \
  --filter-expression "jobType = :t" \
  --expression-attribute-values '{":t":{"S":"skill-scout"}}' \
  --projection-expression "jobId, #s, skillScoutPayload" \
  --expression-attribute-names '{"#s":"status"}' \
  --output json | jq '.Items | .[-3:]'
# Expect: at least one row for dino-test-3 with trigger=T1
```

Visit `/labs/skills?appId=dino-test-3` in the admin UI. The "Recent
SKILL-SCOUT runs" table should show the T1 row with its disposition
(auto-confirm or surface-card depending on rigor + confidence).

### Verify Epic 4 (populated Skills-Used trailer)

Create a small plan against `dino-test-3` (intent: "Show a 16x16
pixel-art snake head"). Under mvp rigor. After the first story
completes:

```bash
ssh ubuntu@54.86.226.233
cd /home/ubuntu/projects/dino-test-3
git log -1 --format=%B
# Expect Skills-Used: <skill>@anthropic-official, … line is NOT empty.
# (Pre-Epic-4 baseline was the empty-label form.)
```

### Verify Epic 7 (observability surfaces)

- **/labs/skills?appId=dino-test-3** — should show the SKILL-SCOUT
  run + at least one skill with a non-zero activation count.
- **Forensic JSON** — `GET /api/plans/:planId/forensic` returns a
  `skills` block (non-null after the first agent step runs).

---

## Epic 5 + 6 wire-in follow-ons

These hold-backs from the implementation commits — quick to land once
the operator confirms the deploy worked.

### Epic 5 — PM seeds CLAUDE.md "What this is"

```js
// daemon/pipelines/pm-plan.mjs — at the end of the PM agent's
// post-spawn handler (after the decomposition has been parsed and
// the plan rows updated):

import { seedWhatThisIs } from '../lib/claude-md-writer.mjs';

await seedWhatThisIs({
  workingDir: job.workingDir,
  purpose: plan.intent.split('\n').slice(0, 3).join(' ').trim(),
  onEvent: async (type, payload) => pushEvent(job.jobId, 'pm-plan', 'PM', type, payload),
});
```

### Epic 5 — DEV appends Architecture decision

```ts
// functions/shared/pipelines/story-pipeline.ts — new shell step
// between 'review' and 'compile-commit-on-pass'. Gated on milestone-
// story detection (AC text starts with "Architecture:" OR wave===0).

{
  id: 'claude-md-append-decision',
  stepType: 'shell',
  command:
    `cd ${workingDir} && ` +
    `node -e "import('./daemon/lib/claude-md-writer.mjs').then(m => ` +
    `m.appendArchitectureDecision({ workingDir: '.', ` +
    `storyId: '${story.storyId}', ` +
    `decision: '${story.title.replace(/'/g, "'\\''")}', ` +
    `rationale: '${(story.acceptanceCriteria?.[0] ?? '').slice(0, 200).replace(/'/g, "'\\''")}', ` +
    `storyTitle: '${story.title.replace(/'/g, "'\\''")}' }))"`,
  timeout: 5000,
  onFail: { action: 'continue' }, // non-blocking
},
```

### Epic 6 — REFLECTOR enqueue in plan-reducer

```ts
// functions/shared/services/plan-reducer.ts — at the `status = review`
// transition (end of reducePlan after plan-build passes):

import {
  decidePlanCloseReflection,
  buildReflectorJobPayload,
} from '../../../daemon/lib/reflector-scheduler.mjs';
import { shouldFireReflection } from '../../../daemon/pipelines/reflector-runner.mjs';

const verdict = decidePlanCloseReflection({
  plan,
  shouldFireReflectionFn: shouldFireReflection,
});
if (verdict.shouldFire) {
  const reflectorJob = buildReflectorJobPayload({
    scope: 'plan',
    plan,
    jobIdFactory: () => crypto.randomUUID(),
  });
  await deps.createJob(reflectorJob);
  await deps.updatePlanFields(plan.planId, {
    reflectorPlanCloseFiredAt: new Date().toISOString(),
  });
}
```

### Epic 6 — reflector-apply real implementation

Replace the stub at `daemon/pipelines/reflector-apply.mjs:43` with
real on-disk writes. The proposals carry `target ∈ {claude-md, project-skill,
org-skill, persona, pipeline-tuning, tool-wrapper}`; route each kind
to the appropriate writer:

```js
// claude-md kind → claude-md-writer.mjs::appendArchitectureDecision
// project-skill / org-skill → skill-installer.mjs::applyConfirmedProposals
// (others stub-only for v1)
```

---

## Rollback

Each commit is independently revertible:

```bash
git revert acb16e4  # Epic 6
git revert f7627c2  # Epic 5
git revert b99c78c  # Epic 4
git revert fda50ed  # Epic 7 (also touches forensic schema — verify dashboard render)
git revert b7ecd53 8438fa1 73f4af3  # Epic 3 (full revert: daemon + modules + spec)
git revert 0bb19fe  # Epic 2 (default loadout)
```

Apps already bootstrapped with vendored skills KEEP the SKILL.md files
on disk after revert — the next bootstrap simply skips the
prepin/vendor steps.

---

## Post-deploy observation window

After 5+ plan runs:

1. **`/labs/skills`** — distinct skills should number 6+ across all
   apps (canvas-design / frontend-design / algorithmic-art / etc.).
2. **`git log --grep="Skills-Used:.*canvas-design"`** in any
   nextjs-canvas-game app — non-zero match count.
3. **Forensic comparison** — pick a snake-4 baseline (pre-skills) and
   any post-skills plan. Compare:
   - Cost — expect ±20% (skills add prompt tokens but may reduce retries)
   - Story retry count — should drop on browser-AC stories
   - `claude_md_loaded` sha — should change WITHIN a plan once Epic 5
     wire-in lands

4. **REFLECTOR inbox** — `/labs/reflections` shows at least one
   proposal after Epic 6 wire-in lands.

Capture artifacts under `docs/concepts/logs/<plan-slug>-<date>/` and
update `plan-skills-activation.md` §12 with comparative findings.

---

## Known limitations (v1)

1. **Epic 5/6 wire-ins held back.** The module code is in place; the
   call sites in plan-reducer / wave-reducer / pm-plan.mjs are part
   of files dirty with Slice C work that hasn't shipped. ~30 min
   follow-on each once Slice C lands cleanly.
2. **Epic 3 T3-T8 triggers deferred.** Substrate exists in
   `daemon/lib/skill-scout-triggers.mjs`; wire-in is `PR-79-followup`.
3. **REFLECTOR Edit modal deferred.** UI card (Epic 3 Story 3.5) ships
   Confirm-all + Decline + Defer only. Edit-with-subset goes to v2.
4. **No CDK/AWS infrastructure plans tested.** ARCHITECT shipped under
   PR-90 but isn't wired (it's Phase 3 substrate, not Epic 3 scope).

Track all of these in `plan-skills-activation.md` §10 Open questions.

---

_Last reviewed 2026-05-20 against HEAD `acb16e4`._
