# Tech Spec — Epic 3: SKILL-SCOUT T1 + T2 activation

> **Parent plan:** `plan-skills-activation.md` §5
> **Goal:** wake up the dormant SKILL-SCOUT agent for the two highest-
> value triggers (T1 project init, T2 plan intent). Under prototype
> rigor + high-confidence proposals: auto-confirm. Under mvp+ rigor or
> low-confidence: surface a decision card in the attention dock with
> confirm/edit/decline/defer actions. On confirm, the daemon's
> `skill-promoter.mjs` chain rewrites `.claude/skills.manifest.yaml`
> and re-runs `skills-sync.mjs` to materialize the new SKILL.md
> bodies.
> **Effort:** ~5 dev-days (3.0 + 3.1 + 3.2 + 3.3 + 3.4 + 3.5 + 3.6 + 3.7).
> **Critical-path blocker for:** the "skills actually get proposed
> per-plan" observable signal in success criterion §0.4 of the parent
> plan. Without Epic 3, all skills come from Epic 2's hardcoded
> loadout — no per-intent customization.
> **Dependencies:** Epic 2 ships first (skills must be vendorable + the
> commit-metadata pipeline must populate Skills-Manifest-Sha so the
> operator can verify SKILL-SCOUT writes land on disk). Epic 1.1
> (`futurator-skills` repo) is **NOT** a hard blocker — SKILL-SCOUT
> can propose from `anthropic-official` alone, same as Epic 2 does.

---

## 0. Risk pre-flight — Story 3.0

Unlike Epic 2 where a single 30-min probe closed the foundational
risk, Epic 3 has **three** distinct unknowns. Each gets a small
investigative probe before any code is written.

### 3.0a: Does the daemon's job-router accept a new `jobType`?

The daemon's `job-router.mjs` switches on `job.jobType` and dispatches
to a runner. Today it handles `'app-bootstrap'`, `'agent-turn'`, etc.
A new `'skill-scout'` job needs a new branch. Probe:

```bash
grep -n "jobType\|case '" /Users/ricardoarayafarias/GetReal/Futurator-Admin/daemon/pipelines/job-router.mjs | head -20
```

**Expected:** finite switch over a small set of literals. Adding
`'skill-scout'` is a straightforward branch addition — no
architectural redesign needed.

**Risk if wrong:** the daemon's job dispatch is convoluted enough that
"add a new jobType" is multi-day work. Pivot would be to piggy-back
on `'agent-turn'` (which already routes to a generic Claude-spawn
path) and use a sentinel field on the payload. Effort delta: +1 day.

### 3.0b: Does the plan-reducer have a "wait for subordinate job" state?

For T2, the plan-reducer must enqueue SKILL-SCOUT BEFORE PM, then
resume PM dispatch after SKILL-SCOUT terminates (success or timeout).
This requires the reducer to enter and exit an `awaiting-skill-scout`
state on each cron tick.

```bash
grep -n "state\|status\|awaiting\|pending" \
  /Users/ricardoarayafarias/GetReal/Futurator-Admin/functions/shared/services/plan-reducer.ts \
  | head -20
```

**Expected:** the reducer has terminal/non-terminal status logic for
plans (`draft → developing → fixing → review → delivered`). We can
add a new sub-status or use a `plan.pendingSkillScoutJobId` foreign
key to make the wait explicit. The cron polls every minute, so
"reducer no-ops on this tick because SKILL-SCOUT job is still
RUNNING" is the natural shape.

**Risk if wrong:** the reducer's state machine is rigid enough that
adding a wait-state requires schema changes everywhere. Pivot would
be to run T2 SYNCHRONOUSLY inside the API Lambda's
`POST /api/apps/:appId/plans` handler — the SKILL-SCOUT spawn becomes
an inline `await`. Cost: 30-90s of operator-visible Lambda latency on
plan creation. Workable but worse UX.

### 3.0c: What does the API Lambda see when the daemon writes the manifest?

After auto-confirm OR operator-confirm, the daemon writes
`.claude/skills.manifest.yaml` on EC2. The API Lambda doesn't read
this file (EC2-only). For the UI decision card to display the
"before/after" YAML diff, the daemon needs to surface the proposed
manifest CONTENT in the attention-item payload — not just the proposal
shape. Probe the existing `buildDecisionCard` output shape:

```bash
grep -n "buildDecisionCard\|attention\|category:" \
  /Users/ricardoarayafarias/GetReal/Futurator-Admin/daemon/pipelines/skill-scout-runner.mjs
```

Already shipped: `buildDecisionCard()` returns `{ severity, category,
title, body, actions, context }` where `context.proposals` carries the
full `SkillProposal[]`. UI can render YAML diff from that. ✅ no
pre-flight blocker here — but worth confirming.

### Pass criteria

All three probes (3.0a/b/c) pass with no pivot needed → green-light
Stories 3.1–3.6. If 3.0a OR 3.0b fail, the spec's effort estimate
moves from ~5 dev-days to ~6–7 dev-days and the per-story design
shifts as noted above.

**Time budget for Story 3.0: 1 hour. Output: a 1-paragraph "verdict"
appended to this §0.**

---

## 1. Story 3.1 — Daemon job-router branch for `jobType: 'skill-scout'`

**Effort:** 1 day · **Files touched:** 3 (1 new runner module, 1 router edit, 1 type)

### What

Add a `'skill-scout'` branch to `daemon/pipelines/job-router.mjs`. The
branch routes to a new `daemon/pipelines/skill-scout-job-runner.mjs`
that:

1. Loads the job's baked `pipeline` definition (from
   `generateSkillScoutPipeline()` in
   `functions/shared/pipelines/skill-scout-pipeline.ts`).
2. Spawns the SKILL-SCOUT agent step via the daemon's existing
   `executeAgentStep()` plumbing (the same mechanism that runs DEV /
   TEST / REVIEWER for stories).
3. Captures the agent's between-marker JSON output via the existing
   extractor.
4. Validates against `validateSkillProposalsBlock()` (shipped helper).
5. Routes the result via `disposeProposals({output, rigor})` (shipped
   helper) → either auto-confirm path (calls the skill-installer
   directly) or surface-card path (writes an attention item).

The existing `daemon/pipelines/skill-scout-runner.mjs` (Story 3-C-3-2)
is the **helper library** — Story 3.1 builds the **job runner** that
wires those helpers into the daemon's job-dispatch loop.

### Why

`skill-scout-runner.mjs` shipped but has zero importers. The daemon's
spawn loop has no entry point that calls into it. Story 3.1 adds that
entry point.

### Code shape

```js
// daemon/pipelines/skill-scout-job-runner.mjs (NEW)
//
// Orchestrates a single SKILL-SCOUT job-row lifecycle: spawn agent →
// extract proposals → validate → dispose. Returns a structured result
// the daemon updates the job row with.

import {
  buildPromptContext,
  disposeProposals,
  buildDecisionCard,
  buildForensicEvent,
} from './skill-scout-runner.mjs';
import { validateSkillProposalsBlock } from '../../functions/shared/pipelines/skill-scout-pipeline.js';
import { applyConfirmedProposals } from './skill-installer.mjs'; // NEW (story 3.4)

/**
 * @param {object} job  — agent-jobs row with skill-scout payload
 * @param {object} ctx  — { pushEvent, executeAgentStep, writeAttentionItem,
 *                         federationCache, getProjectPath, getRigor }
 */
export async function runSkillScoutJob(job, ctx) {
  const { trigger, projectSlug, planId, planIntent, appId, rigor } = job.skillScoutPayload || {};

  // 1. Read federation + project manifest from disk on EC2.
  const projectPath = ctx.getProjectPath(projectSlug);
  const promptCtx = buildPromptContext({
    federationCache: ctx.federationCache,
    projectPath,
    projectSlug,
  });

  // 2. Spawn the SKILL-SCOUT agent step (single step in the pipeline).
  const stepResult = await ctx.executeAgentStep(job, job.pipeline.steps[0], {
    promptVars: {
      trigger,
      projectSlug,
      planIntent: planIntent || '(none — T1 init)',
      currentManifestYaml: promptCtx.currentManifestYaml,
      federationYaml: promptCtx.federationYaml,
    },
  });

  // 3. Extract + validate. The pipeline's extractor captured the
  //    between-marker block into stepResult.variables.PROPOSALS_JSON.
  const raw = stepResult.variables?.PROPOSALS_JSON ?? '';
  const validation = validateSkillProposalsBlock(raw);
  if (!validation.ok) {
    await ctx.writeAttentionItem({
      appId,
      planId,
      severity: 'medium',
      category: 'skill-scout-output-invalid',
      title: `SKILL-SCOUT ${trigger} for ${projectSlug} emitted invalid output`,
      body: validation.error.slice(0, 1500),
      dedupKey: `skill-scout-invalid:${trigger}:${projectSlug}`,
    });
    return { ok: false, reason: 'invalid-output', error: validation.error };
  }

  const { output } = validation;

  // 4. Dispose: auto-confirm vs surface-card.
  const disposition = disposeProposals({ output, rigor });

  await ctx.pushEvent(
    job.jobId,
    'completed',
    '__skill_scout__',
    buildForensicEvent({
      trigger,
      output,
      durationMs: stepResult.durationMs,
      tokensConsumed: stepResult.tokensConsumed,
    }).eventType,
    buildForensicEvent({
      trigger,
      output,
      durationMs: stepResult.durationMs,
      tokensConsumed: stepResult.tokensConsumed,
    }).payload,
  );

  if (disposition.disposition === 'auto-confirm') {
    const applyResult = await applyConfirmedProposals({
      projectPath,
      projectSlug,
      output,
      source: 'auto-confirm',
    });
    return { ok: true, disposition: 'auto-confirm', ...applyResult };
  }
  if (disposition.disposition === 'surface-card') {
    const card = buildDecisionCard({ output, projectSlug, appId, planId });
    await ctx.writeAttentionItem({
      ...card,
      appId,
      planId,
      dedupKey: `skill-scout-card:${trigger}:${projectSlug}:${planId ?? 'app'}`,
    });
    return { ok: true, disposition: 'surface-card', proposals: output.proposals };
  }
  // disposition === 'noop' — empty proposals.
  return { ok: true, disposition: 'noop' };
}
```

### Router wire-in

```js
// daemon/pipelines/job-router.mjs (extend the switch)
//
// Existing branches: 'app-bootstrap', 'agent-turn', etc.
case 'skill-scout': {
  return runSkillScoutJob(job, {
    ...ctx,
    federationCache: ctx.federationCache, // existing daemon-level singleton
  });
}
```

### Type extension

```ts
// functions/shared/types/agent-orchestrator.ts — extend AgentJob
//
// Mirror the shape of appBootstrapPayload (Story 1.4.4 pattern).
skillScoutPayload?: {
  trigger: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
  projectSlug: string;
  appId: string;
  planId?: string;
  planIntent?: string;
  rigor: PlanRigor;
};
```

And widen `jobType`:

```ts
// agent-orchestrator.ts
jobType: 'app-bootstrap' | 'agent-turn' | 'skill-scout' | ...;
```

### Tests

`daemon/pipelines/__tests__/skill-scout-job-runner.test.mjs` (NEW):

- happy path → returns `{ok: true, disposition: 'surface-card'}` when
  agent emits valid proposals + rigor=mvp.
- prototype + all proposals confidence ≥0.9 → `auto-confirm`.
- empty proposals → `noop`, no attention written.
- invalid JSON → `attention.skill-scout-output-invalid` written, returns
  `{ok: false}`.
- T3 trigger never auto-confirms (regression guard against the
  brownfield-audit safety contract).
- Agent step spawn failure → propagates as job failure.

### Validation

- `npx vitest run daemon/pipelines/__tests__/skill-scout-job-runner.test.mjs`
  → green
- Lint clean
- Existing `daemon/pipelines/__tests__/skill-scout-runner.test.mjs`
  (library tests) still green

---

## 2. Story 3.2 — Skill installer + auto-confirm path

**Effort:** 1 day · **Files touched:** 1 new module + tests

### What

New `daemon/pipelines/skill-installer.mjs`. The auto-confirm path
(prototype + high-confidence T1/T2/T5/T7) AND the operator-confirm
path (Story 3.5's API endpoint) both call into this module to apply
proposals to the manifest + re-run `skills-sync.mjs`.

```js
// daemon/pipelines/skill-installer.mjs (NEW)
//
// Apply confirmed SKILL-SCOUT proposals to the project's
// .claude/skills.manifest.yaml. Three kinds of proposals (per v2.5
// §38): 'add', 'remove', 'upgrade'. Then re-run skills-sync.mjs to
// vendor the SKILL.md bodies. Idempotent per proposal — re-running
// an apply does not duplicate entries.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { runVendorSkills } from '../lib/app-bootstrap-steps/vendor-skills.mjs';

/**
 * @param {object} args
 * @param {string} args.projectPath
 * @param {string} args.projectSlug
 * @param {import('../../functions/shared/pipelines/skill-scout-pipeline').SkillScoutOutput} args.output
 * @param {'auto-confirm' | 'operator-confirm'} args.source
 * @returns {Promise<{ ok: boolean, written: number, vendoredCount: number, vendorAttention?: object }>}
 */
export async function applyConfirmedProposals({ projectPath, projectSlug, output, source }) {
  const manifestPath = join(projectPath, '.claude/skills.manifest.yaml');
  if (!existsSync(manifestPath)) {
    throw new Error(`apply: manifest missing at ${manifestPath}`);
  }

  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = parseYaml(raw);

  let written = 0;
  for (const proposal of output.proposals) {
    const bucket = manifest[proposal.manifestBucket] ?? [];
    if (!Array.isArray(bucket)) continue;

    if (proposal.kind === 'add') {
      const exists = bucket.some(
        (e) => e?.skill === proposal.skill && e?.source === proposal.source,
      );
      if (!exists) {
        bucket.push({
          source: proposal.source,
          skill: proposal.skill,
          version: proposal.version,
        });
        written += 1;
      }
    } else if (proposal.kind === 'upgrade') {
      const entry = bucket.find(
        (e) => e?.skill === proposal.skill && e?.source === proposal.source,
      );
      if (entry) {
        entry.version = proposal.version;
        written += 1;
      } else {
        bucket.push({
          source: proposal.source,
          skill: proposal.skill,
          version: proposal.version,
        });
        written += 1;
      }
    } else if (proposal.kind === 'remove') {
      const idx = bucket.findIndex(
        (e) => e?.skill === proposal.skill && e?.source === proposal.source,
      );
      if (idx >= 0) {
        bucket.splice(idx, 1);
        written += 1;
      }
    }
    manifest[proposal.manifestBucket] = bucket;
  }

  if (written === 0) {
    return { ok: true, written: 0, vendoredCount: 0 };
  }

  // Stamp provenance for forensic queries.
  manifest['last-modified-by'] = `skill-scout-${source}@${new Date().toISOString()}`;

  writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');

  // Re-run vendor-skills so the new SKILL.md bodies land on disk
  // BEFORE the next agent invocation auto-discovers them.
  const vendorResult = await runVendorSkills({ worktreeDir: projectPath });

  return {
    ok: true,
    written,
    vendoredCount: vendorResult.vendoredCount ?? 0,
    vendorAttention: vendorResult.attentionCategory
      ? {
          category: vendorResult.attentionCategory,
          severity: vendorResult.attentionSeverity,
        }
      : undefined,
  };
}
```

### Why a separate module from Story 3.1?

Two callers (auto-confirm from Story 3.1's runner, operator-confirm
from Story 3.5's API endpoint) need the same apply logic. Putting it
in a shared module is the obvious factoring. Also makes 3.2
independently testable without the full job-spawn dance.

### Tests

`daemon/pipelines/__tests__/skill-installer.test.mjs` — minimum cases:

- add a new skill → bucket grows by 1, vendor-skills runs
- upgrade existing → version bumps, count of entries unchanged
- remove existing → bucket shrinks by 1
- idempotency: applying the same proposal twice → second call written=0
- conflict: upgrade for a skill not in manifest → treated as add
- vendor-skills failure → returned in `vendorAttention`, manifest write
  still committed
- empty proposals → written=0, no vendor-skills call

---

## 3. Story 3.3 — T1 trigger wire-in (post app-bootstrap)

**Effort:** ½ day · **Files touched:** 1 (app-bootstrap.mjs)

### What

After the `pv2.app-bootstrap.completed` event fires (line ~301 of
`daemon/pipelines/app-bootstrap.mjs`), enqueue a new agent-job row
with `jobType: 'skill-scout'`, `trigger: 'T1'`. The cron's
job-dispatcher will pick it up next tick.

Today the file emits a `pv2.skill-scout.queued` marker event. Story
3.3 replaces that no-op marker with an actual job-row insert.

### Code shape

```js
// daemon/pipelines/app-bootstrap.mjs — replace lines ~313-336

// Epic 3 Story 3.3 — enqueue a real SKILL-SCOUT job, no longer a marker.
const skillScoutJob = {
  jobId: ctx.uuid(),
  jobType: 'skill-scout',
  status: 'PENDING',
  createdAt: new Date().toISOString(),
  workingDir: worktreeDir,
  skillScoutPayload: {
    trigger: 'T1',
    projectSlug: appId,
    appId,
    rigor: 'prototype', // T1 has no plan-rigor yet; default to prototype
    // so high-confidence proposals auto-confirm
    // without operator intervention.
  },
  pipeline: generateSkillScoutPipeline({
    trigger: 'T1',
    projectSlug: appId,
    boilerplateType,
    rigor: 'prototype',
  }),
};
await ctx.insertAgentJob(skillScoutJob);

await pushEvent?.(
  job.jobId,
  'completed',
  '__app_bootstrap__',
  'pv2.skill-scout.enqueued', // renamed from .queued (marker) to .enqueued (real job)
  { appId, trigger: 'T1', jobId: skillScoutJob.jobId },
);
```

### Rigor decision: T1 always uses prototype rigor

App-bootstrap runs before any plan exists. There's no plan-rigor to
inherit. Hardcoding prototype is the v2.5 §38 default — auto-confirm
under high confidence (≥0.9), which is the desired behavior for "the
canvas-game starter should obviously have canvas-design installed."

If the operator later creates a plan under mvp/production rigor and
SKILL-SCOUT proposes additions (T2), THAT will surface a card.

### Tests

Extend `daemon/__tests__/app-bootstrap-idempotency.test.mjs`:

- New assertion: after bootstrap succeeds, exactly one `'skill-scout'`
  job-row was inserted with `trigger: 'T1'`.
- Idempotency: re-running bootstrap doesn't enqueue a second
  SKILL-SCOUT job (gated by the App row's `bootstrappedAt` or a
  dedupKey on the job row).

---

## 4. Story 3.4 — T2 trigger wire-in (pre-PM, plan creation)

**Effort:** 1 day · **Files touched:** 2 (plan-pipeline, plan-reducer)

### What

When the API Lambda creates a new plan (POST /api/plans or POST
/api/apps/:appId/plans), enqueue a SKILL-SCOUT job with `trigger:
'T2'` AND set `plan.pendingSkillScoutJobId = <jobId>`. The cron's
plan-reducer then no-ops the plan on each tick until SKILL-SCOUT
terminates (and the operator has confirmed any surfaced card). Once
clear, the reducer launches PM as usual.

### Why before PM?

Per v2.5 §38: skills inform the PM's epic/story decomposition. If
SKILL-SCOUT proposes `vercel-react-best-practices` and the operator
confirms, PM should see that skill loaded when decomposing the plan —
otherwise PM proposes work that contradicts the skill's guidance.

### Code shape — API Lambda enqueue

```ts
// functions/api/index.ts — POST /api/plans or /api/apps/:appId/plans
// AFTER the plan row is created, BEFORE the PM dispatch (which today
// fires immediately).

const skillScoutJob = {
  jobId: crypto.randomUUID(),
  jobType: 'skill-scout' as const,
  status: 'PENDING' as const,
  // ... standard agent-jobs row fields
  skillScoutPayload: {
    trigger: 'T2' as const,
    projectSlug: plan.appId,
    appId: plan.appId,
    planId: plan.planId,
    planIntent: plan.intent,
    rigor: plan.rigor,
  },
  pipeline: generateSkillScoutPipeline({
    trigger: 'T2',
    projectSlug: plan.appId,
    boilerplateType,
    rigor: plan.rigor,
    planIntent: plan.intent,
  }),
};
await agentJobsRepo.put(skillScoutJob);

// Stamp the plan with the FK so the reducer waits.
await planRepo.update(plan.planId, {
  pendingSkillScoutJobId: skillScoutJob.jobId,
  status: 'draft', // explicit — NOT 'developing' until SKILL-SCOUT clears
});
```

### Plan-reducer wait gate

```ts
// functions/shared/services/plan-reducer.ts — reducePlan(...)
// NEW first guard, before the existing epic-iteration logic.

if (plan.pendingSkillScoutJobId) {
  const scoutJob = await deps.getJob(plan.pendingSkillScoutJobId);
  // Terminal states: COMPLETED, FAILED, STALE.
  if (!scoutJob || !['COMPLETED', 'FAILED', 'STALE'].includes(scoutJob.status)) {
    return { decision: 'no-op', reason: 'awaiting-skill-scout' };
  }
  // SKILL-SCOUT terminated. Was a decision card surfaced and is it
  // still pending operator action? Check attention items.
  const pendingCard = await deps.getOpenAttentionItem({
    planId: plan.planId,
    category: 'manifest-change-proposed',
  });
  if (pendingCard) {
    return { decision: 'no-op', reason: 'awaiting-operator-confirm' };
  }
  // All clear — promote plan to developing + launch PM as usual.
  await deps.updatePlan(plan.planId, {
    pendingSkillScoutJobId: null,
    status: 'developing',
  });
}

// ... existing epic-iteration logic continues here.
```

### Timeout safety net

If SKILL-SCOUT hangs (agent crash, daemon offline, never terminates),
the plan would sit in `awaiting-skill-scout` forever. Add a timeout:
if `scoutJob.createdAt > now() - 5min` AND status is still PENDING/RUNNING,
the reducer surfaces a `skill-scout-t2-timeout` attention (low severity)
and promotes the plan to `developing` without SKILL-SCOUT's input. Plan
proceeds with whatever skills were already pinned from Epic 2's defaults.

```ts
// in the wait-gate above, after the !COMPLETED check:
const ageMs = Date.now() - new Date(scoutJob.createdAt).getTime();
if (ageMs > 5 * 60 * 1000) {
  await deps.writeAttention({
    planId: plan.planId,
    severity: 'low',
    category: 'skill-scout-t2-timeout',
    title: `SKILL-SCOUT T2 didn't finish for plan ${plan.name} — proceeding without proposals`,
    dedupKey: `skill-scout-t2-timeout:${plan.planId}`,
  });
  await deps.updatePlan(plan.planId, {
    pendingSkillScoutJobId: null,
    status: 'developing',
  });
}
```

### Tests

Extend `functions/shared/services/__tests__/plan-reducer.test.ts`:

- Plan with `pendingSkillScoutJobId` + scoutJob RUNNING → reducer
  returns `no-op` with reason `awaiting-skill-scout`.
- scoutJob COMPLETED + no pending card → reducer flips plan to
  `developing` and clears the FK.
- scoutJob COMPLETED + pending card → reducer no-ops with reason
  `awaiting-operator-confirm`.
- scoutJob age > 5min still RUNNING → timeout attention written,
  plan promoted to `developing`.

---

## 5. Story 3.5 — API endpoint + UI decision card

**Effort:** 1.5 days · **Files touched:** 3 (API route, attention-dock, new card component)

### What

Two surfaces:

1. **API:** `POST /api/skill-scout/proposals/:attentionItemId/:action`
   where action ∈ `confirm | decline | defer | edit`. Routes to the
   appropriate daemon-side handler.
2. **UI:** when an attention item has `category:
manifest-change-proposed`, render a dedicated card component in the
   attention dock showing:
   - Trigger label (T1 project init / T2 plan intent)
   - Per-proposal row: kind chip (add/upgrade/remove), `skill@source`,
     version, rationale, confidence bar
   - YAML diff preview (before/after on `.claude/skills.manifest.yaml`)
   - Four action buttons: Confirm / Edit (opens a modal for
     per-proposal accept/decline) / Decline (rejects all) / Defer

### API code shape

```ts
// functions/api/index.ts — NEW route
app.post('/api/skill-scout/proposals/:itemId/:action', authMiddleware, async (c) => {
  const itemId = c.req.param('itemId');
  const action = c.req.param('action') as 'confirm' | 'decline' | 'defer' | 'edit';
  const body = await c.req.json().catch(() => ({}));

  const item = await attentionRepo.get(itemId);
  if (!item || item.category !== 'manifest-change-proposed') {
    return c.json({ error: 'invalid-attention-item' }, 404);
  }

  if (action === 'decline' || action === 'defer') {
    await attentionRepo.update(itemId, { status: action === 'defer' ? 'deferred' : 'declined' });
    return c.json({ ok: true });
  }

  if (action === 'confirm' || action === 'edit') {
    // For 'edit', body.acceptedProposals is the subset the operator
    // chose. For 'confirm', accept all.
    const accepted =
      action === 'edit' ? (body.acceptedProposals as SkillProposal[]) : item.context.proposals;
    const filteredOutput = { ...item.context, proposals: accepted };

    // Enqueue a follow-on job-row to run skill-installer in the daemon
    // (not in the Lambda — manifest writes need to happen on EC2).
    const installJob = {
      jobId: crypto.randomUUID(),
      jobType: 'skill-install' as const, // NEW jobType
      status: 'PENDING' as const,
      skillInstallPayload: {
        projectSlug: item.context.projectSlug,
        output: filteredOutput,
        source: 'operator-confirm' as const,
        originAttentionId: itemId,
      },
    };
    await agentJobsRepo.put(installJob);

    await attentionRepo.update(itemId, { status: 'resolved', resolvedBy: 'operator' });
    return c.json({ ok: true, installJobId: installJob.jobId });
  }
});
```

The daemon's job-router gets a second new branch — `'skill-install'`
— that just calls `applyConfirmedProposals()` from Story 3.2.

### UI component shape

```tsx
// src/components/labs/skill-scout/skill-scout-card.tsx (NEW)

export function SkillScoutCard({ item }: { item: AttentionItem }) {
  const { trigger, proposals, projectSlug } = item.context;
  return (
    <div className="rounded border border-warning p-4">
      <header className="flex items-center justify-between">
        <h3>
          SKILL-SCOUT {trigger} — {proposals.length} proposal(s) for {projectSlug}
        </h3>
        <TriggerChip trigger={trigger} />
      </header>
      <ul className="my-3 space-y-2">
        {proposals.map((p) => (
          <ProposalRow key={p.skill} proposal={p} />
        ))}
      </ul>
      <ManifestDiffPreview proposals={proposals} />
      <footer className="flex gap-2">
        <Button onClick={() => confirm(item.id, proposals)}>Confirm all</Button>
        <Button onClick={() => openEditModal(item.id, proposals)} variant="ghost">
          Edit…
        </Button>
        <Button onClick={() => decline(item.id)} variant="ghost">
          Decline
        </Button>
        <Button onClick={() => defer(item.id)} variant="ghost">
          Defer
        </Button>
      </footer>
    </div>
  );
}
```

And the existing `src/components/labs/plan-dashboard/views/attention-dock.tsx`
gains a switch on `item.category` to route `'manifest-change-proposed'`
items to `SkillScoutCard` (current renderer is generic).

### Tests

- API: `functions/api/__tests__/skill-scout-confirm.test.ts` — confirm
  enqueues skill-install job; decline marks attention resolved with
  status `declined`; edit accepts a subset.
- UI: `src/components/labs/skill-scout/__tests__/skill-scout-card.test.tsx`
  — renders proposals; clicking Confirm posts the right URL;
  ManifestDiffPreview shows additions/removals.

---

## 6. Story 3.6 — Daemon job-router branch for `jobType: 'skill-install'`

**Effort:** ½ day · **Files touched:** 1 (job-router) + tests

### What

Mirror of Story 3.1 but for the operator-confirm path. The router
calls `applyConfirmedProposals()` (Story 3.2's module) with
`source: 'operator-confirm'`, then optionally pushes the manifest +
SKILL.md changes to the per-project git remote so the worktree state
is reproducible.

### Code shape

```js
// daemon/pipelines/job-router.mjs
case 'skill-install': {
  const { projectSlug, output, source, originAttentionId } =
    job.skillInstallPayload;
  const projectPath = `/home/ubuntu/projects/${projectSlug}`;
  const result = await applyConfirmedProposals({
    projectPath, projectSlug, output, source,
  });

  if (result.vendorAttention) {
    await ctx.writeAttentionItem({
      ...result.vendorAttention,
      appId: projectSlug,
      title: `Skill install: vendor sync drift after operator confirm`,
      dedupKey: `skill-install-vendor:${projectSlug}:${originAttentionId}`,
    });
  }

  // Optional: git commit + push the manifest + SKILL.md changes so the
  // operator can see the install as a real commit. Falls under
  // 'Agent: SKILL-SCOUT' commit attribution per v2.5 §39 step 5.
  await commitAndPushSkillChanges({
    projectPath, projectSlug, output,
    commitMessage: `chore(skills): ${source} — ${output.proposals.length} proposal(s)`,
  });

  return { ok: result.ok, written: result.written, vendoredCount: result.vendoredCount };
}
```

The `commitAndPushSkillChanges` helper is a small wrapper around `git
add .claude/ && git commit -m ... && git push`. The commit message
carries `Skills-Used:` and `Skills-Manifest-Sha:` trailers (existing
PR-73 + PR-85 logic — already wired in `commit-metadata.ts`).

---

## 7. Story 3.7 — E2E validation

**Effort:** ½ day · **Files touched:** 0 (verification only)

### Procedure

1. Land stories 3.1–3.6 on a feature branch, deploy via `sst deploy`,
   wait for daemon to restart.
2. SSH to EC2, tail journalctl.
3. **T1 path:** create a fresh `dino-test-3` app on
   `nextjs-canvas-game`. Observe:
   - app-bootstrap completes
   - `pv2.skill-scout.enqueued` event in forensic
   - SKILL-SCOUT job row created with `trigger: 'T1'`
   - Daemon picks up the job, agent runs ~$0.05-0.10 spend
   - Under prototype rigor + high-confidence proposals → auto-confirm
   - Manifest grew beyond Epic 2's hardcoded `core[]`
   - `.claude/skills/<additional-name>/SKILL.md` exists on disk
4. **T2 path:** create a small plan against `dino-test-3` under mvp
   rigor. Observe:
   - Plan created in `draft` status with `pendingSkillScoutJobId` set
   - SKILL-SCOUT T2 job runs
   - Decision card appears in `/labs?planId=<id>` attention dock
   - Click Confirm → skill-install job runs → manifest updated → PM
     dispatches → plan promotes to `developing`
5. Capture forensic JSON. Compare to Epic 2 baseline:
   - **NEW:** `pv2.skill-scout.enqueued` events fire post-bootstrap +
     pre-plan
   - **NEW:** at least one `Skill` tool_use event references a
     SKILL-SCOUT-added skill (not just Epic 2 hardcoded ones)
   - **NEW:** `manifest-change-proposed` attention items appear when
     surface-card path triggers

### Acceptance — green to ship

- T1 path: auto-confirm works on a brand-new app, manifest grows
  beyond Epic 2 hardcode within 2 minutes of app-bootstrap.
- T2 path: decision card surfaces, operator-confirm flow works,
  plan unblocks after confirm.
- No `skill-scout-t2-timeout` attention on the happy path (SKILL-SCOUT
  finishes well within 5 min).
- Cost budget: per-app SKILL-SCOUT cost ≤$0.20 (Sonnet, ~1-2 turns).

---

## 8. Rollback plan

Each story is independently revertible. Risk concentrated in 3.4
(plan-reducer wait gate) — if it deadlocks plans, the rollback is to
ignore `plan.pendingSkillScoutJobId` in the reducer and rely on the
5-min timeout net. The FK column on the plan row stays (harmless), and
the safety-net upgrade in 3.4 handles existing in-flight plans.

Full Epic 3 rollback: revert all stories. Apps keep their Epic 2
hardcoded loadout; no new SKILL-SCOUT activity. Existing manifests
remain pinned (no auto-cleanup of SKILL-SCOUT additions — they were
operator-confirmed under prior epic).

---

## 9. Sequencing decisions

### Within Epic 3

```
3.0 (probes, 1h)
  ├─ 3.1 (job-router branch, 1d)
  │   └─ 3.2 (skill-installer, 1d, parallelizable with 3.1)
  │       └─ 3.3 (T1 wire-in, ½d)
  │       └─ 3.4 (T2 wire-in, 1d, parallelizable with 3.3)
  │           └─ 3.5 (API + UI, 1.5d)
  │               └─ 3.6 (skill-install job-router, ½d)
  │                   └─ 3.7 (validation, ½d)
```

3.1 + 3.2 parallelizable (different files); 3.3 + 3.4 parallelizable
(different trigger points). One operator can ship 3.1+3.2 day 1,
3.3+3.4 day 2-3, 3.5 day 4-5, 3.6+3.7 day 5.

### Relative to other Epics

- **Epic 1** (federation file) — not a hard blocker. SKILL-SCOUT can
  propose from `anthropic-official` alone. Epic 1.1 (`futurator-skills`
  org repo) becomes interesting once we want internal-only skill
  proposals.
- **Epic 2** (default loadout) — **hard prerequisite**. SKILL-SCOUT
  needs the empty manifest scaffold to be present + populated with
  Epic 2's baseline; T1 proposals are ADDITIVE on top of that.
- **Epic 4** (`loadedSkills[]` tracking) — independent. Can ship
  before, after, or in parallel with Epic 3. Epic 3 doesn't change
  the commit-trailer plumbing.
- **Epic 5** (CLAUDE.md write hooks) — independent.
- **Epic 6** (REFLECTOR) — depends on Epic 3 indirectly. REFLECTOR
  promotes patterns to skills via SKILL-SCOUT; without Epic 3,
  REFLECTOR's promotion proposals have nowhere to land.

---

## 10. Open questions

1. **Cost ceiling per app.** Each SKILL-SCOUT run costs ~$0.05-0.10.
   T1 fires once per new app; T2 fires once per plan creation. A 10-
   plans-per-app operator costs ~$0.55-$1.10/app on SKILL-SCOUT alone.
   Decision: budget this into `plan.costCeilingUsd` accounting or treat
   as overhead? **Recommended:** add a `plan.skillScoutCostUsd` field
   and display in the plan dashboard sidebar; don't gate on it.
2. **Auto-confirm safety.** Under prototype rigor + ≥0.9 confidence,
   SKILL-SCOUT writes the manifest WITHOUT operator review. If
   SKILL-SCOUT proposes installing a malicious skill from a federation
   source that's been compromised, prototype-rigor apps are exposed.
   Mitigation: the `auto-trust: false` field on the federation source
   forces surface-card regardless of rigor (already implemented in
   `disposeProposals`). Document the threat model in this spec's
   §11 once probes complete.
3. **T2 latency on plan creation.** Adding a SKILL-SCOUT wait (up to
   5 min timeout) delays the "click Create plan → plan starts" UX.
   Operator might confuse the wait with the system being broken.
   Mitigation: dedicated UI state on the plan card ("Analyzing
   skills...") with progress dots + spend counter.
4. **What if the operator creates 10 plans simultaneously?** Each
   spawns a SKILL-SCOUT job. The daemon's `MAX_CONCURRENT_JOBS=3`
   means 7 queue up. T2 wait gate holds all 10 plans in `draft`. That's
   slow but correct. Decision: prioritize SKILL-SCOUT jobs ahead of
   regular agent jobs in the daemon's scheduler? **Recommended:** no
   special priority for v1; revisit if it becomes a bottleneck.
5. **Where does Manifest-Sha live for operator-confirmed installs?**
   The skill-install job's commit message carries
   `Skills-Manifest-Sha:` (new SHA after the install). Future plans
   on the same app will see the new SHA on their commits. Forensic
   query: `git log --grep="Agent: SKILL-SCOUT"` lists every operator-
   confirmed (or auto-confirmed) skill install.
6. **Decline-history feedback loop.** If the operator declines the
   same proposal twice, SKILL-SCOUT's next run should know. This is
   covered by Phase 3-E's Triage agent (PR-81, shipped helpers) but
   not wired here. Defer to Epic 6 (REFLECTOR scheduler integrates
   the Triage decline-history).
7. **Plan-pipeline integration point.** Today PM dispatch happens
   in the API Lambda's POST handler. The plan-reducer's wait gate
   means the API returns the plan row immediately (200 OK) but the
   plan stays in `draft` until SKILL-SCOUT clears. Frontend needs
   to handle the `draft → developing` transition gracefully — polling
   on the plan row OR a websocket / SSE push.

---

## 11. Definition of Done

- [ ] Story 3.0 probe results documented inline in §0 (pass / pivot)
- [ ] Story 3.1 PR merged: `skill-scout-job-runner.mjs` + job-router
      branch + tests; new `jobType` and `skillScoutPayload` types
      added.
- [ ] Story 3.2 PR merged: `skill-installer.mjs` + tests; covers add /
      upgrade / remove kinds, idempotency, vendor-skills failure
      passthrough.
- [ ] Story 3.3 PR merged: app-bootstrap.mjs emits a real
      SKILL-SCOUT job row (replaces the `.queued` marker); tested for
      idempotency on bootstrap re-runs.
- [ ] Story 3.4 PR merged: plan-pipeline enqueues T2 job; plan-reducer
      adds the wait gate + 5-min timeout safety net; tests cover all
      states.
- [ ] Story 3.5 PR merged: API endpoints (confirm / decline / defer /
      edit) + `SkillScoutCard` UI component + attention-dock
      integration.
- [ ] Story 3.6 PR merged: `skill-install` job-router branch + commit
      helper.
- [ ] Story 3.7 verified: fresh dino-test-3 app shows T1 auto-confirm
      working; plan creation shows T2 card surface; operator-confirm
      completes the install + plan resumes.
- [ ] Forensic captured for the validation run, saved under
      `docs/concepts/logs/dino-test-3-<date>/`.
- [ ] Comparative observations appended to `plan-skills-activation.md`
      §12 (post-Epic-2 baseline vs post-Epic-3 result).
- [ ] Cost report: total SKILL-SCOUT spend for one
      bootstrap + one plan creation ≤$0.20.
- [ ] If 3.7 surfaces any attention items, root cause investigated and
      either fixed or filed as a follow-on story.

---

_Authored 2026-05-19 against HEAD `feat/treesitter-slice-c-brownfield-bootstrap` (post-Epic-2 commit `0bb19fe`)._
_Parent: `plan-skills-activation.md`._
_Predecessor for: Epics 6 (REFLECTOR scheduler integrates SKILL-SCOUT proposals via Triage decline-history) and the §0.4 success-criterion ("pv2.skill-scout events fire beyond T1 bootstrap markers")._
