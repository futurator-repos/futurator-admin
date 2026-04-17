# Epic Orchestrator Architecture

**Status:** Design — validated via parallel-Task spike (2026-04-17)
**Scope:** Labs module development pipeline (Start Development flow)
**Supersedes:** Per-story terminal dispatch model
**Project:** Futurator-Admin

---

## 1. Problem Statement and Goals

### Current state

When an operator clicks **Start Development** in the Labs module, the system enqueues one agent job **per story and per reviewer**. The daemon (`daemon/agent-daemon.mjs`) spawns a dedicated Claude CLI terminal for each job. For an epic of 10 stories with independent review, this produces roughly 20 Claude CLI processes per epic.

### Observed problems

1. **Duplicated context gathering.** Every terminal performs the same warmup — loads `CLAUDE.md`, greps for architectural patterns, reads core files (`api-client.ts`, key hooks, shared types). This work is performed N times across N parallel processes with no shared cache. Evidence: Event Log for a single story shows 31 tool calls before any productive edit — the majority being exploratory reads redundant with sibling terminals.
2. **Absurd wall-clock for simple work.** Dev time for trivial stories (one-line changes, config bumps) is disproportionate because each terminal pays the full cold-start cost regardless of story complexity.

### Goals

| Goal                                                  | Success criterion                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| G1. Eliminate duplicated context gathering            | Context is loaded once per epic, amortized across all stories       |
| G2. Preserve reviewer independence                    | Reviewer does not see dev's reasoning; cannot edit code             |
| G3. Preserve parallelism within a wave                | Stories in the same wave execute concurrently                       |
| G4. Scale parallelism to the complexity of each story | Trivial stories use Haiku, architectural stories use Opus           |
| G5. Surface blockers as first-class UI signals        | Operator sees what is blocked and why, without reading logs         |
| G6. Preserve crash-resume                             | Orchestrator crash mid-epic does not require restarting from wave 1 |
| G7. Preserve visual observability                     | Agentic Office and Event Log remain the primary surfaces            |
| G8. Enable rapid design iteration                     | Logs are paste-friendly; correlation IDs are grep-friendly          |

### Non-goals

- Cross-project orchestration (each epic is scoped to one project)
- Live human intervention during a wave (human input happens between runs, not during)
- Replacing the daemon's queue semantics or DynamoDB as source of truth

---

## 2. Topology Shift

### Before — terminal-per-leaf

```
DynamoDB agent-jobs table:
  job-1: epic=E, story=S1, role=dev
  job-2: epic=E, story=S1, role=review
  job-3: epic=E, story=S2, role=dev
  job-4: epic=E, story=S2, role=review
  ... (2N jobs per epic)

Daemon polls → spawns one `claude` CLI per job row
  └── Each CLI re-reads CLAUDE.md, re-greps codebase
  └── Reviewer CLI re-reads the same files the dev CLI just read
```

### After — orchestrator-per-epic

```
DynamoDB agent-jobs table:
  job-E: epic=E, phase=epic-dev, payload={stories:[S1..Sn], waves, contextDigest, rubric}

Daemon polls → spawns ONE `claude` CLI (the orchestrator) per job
  └── Orchestrator reads context ONCE
  └── For each wave K:
        └── Dispatches N Task calls in ONE message (parallel)
              ├── dev-standard subagent for story S_i
              ├── dev-standard subagent for story S_j
              └── dev-trivial subagent for story S_k
        └── Collects results
        └── Dispatches senior-reviewer subagents (parallel)
        └── If REQUEST_CHANGES: remediation round (bounded)
        └── Persists waveResults to DynamoDB
  └── Emits <EPIC_COMPLETE> on stdout
  └── Exits
```

### Why this works

Claude Code's `Task` tool provides **in-process parallel fan-out with isolated context per subagent**. The orchestrator holds one warm context (the digest); each subagent receives a prompt containing only the excerpts relevant to its story. Parallelism is preserved; duplicated exploration is eliminated.

Validated via spike: see Section 12.

---

## 3. Job Model and Daemon Integration

### Job schema

One row per **epic × phase**. Phases: `epic-dev`, `epic-review`, `epic-build`. `epic-dev` carries the full story manifest.

```ts
// functions/shared/types/agent-orchestrator.ts (extended)

type EpicDevJob = {
  jobId: string;
  projectId: string;
  epicId: string;
  phase: 'epic-dev' | 'epic-review' | 'epic-build';
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'COMPLETE_WITH_BLOCKED_STORIES' | 'FAILED';
  payload: {
    orchestratorModel: 'opus' | 'sonnet';
    maxParallel: number; // see Section 12 for calibration
    maxRemediationRounds: number; // default 2
    epicGoal: string;
    contextDigest: string; // pre-baked architectural summary
    rubric: string; // merged default + project overlay
    stories: Array<StoryManifestEntry>;
  };
  waveResults?: Record<number, WaveResult>; // checkpoint for crash-resume
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
};

type StoryManifestEntry = {
  storyId: string;
  title: string;
  wave: number;
  acceptanceCriteria: string[];
  touchPoints: string[]; // glob list — see Section 6
  complexity: 'trivial' | 'standard' | 'complex' | 'architectural';
  reviewRigor: 'light' | 'standard' | 'strict';
  rubricEmphasis?: string[]; // optional rule IDs to weight as blocker
  dependsOn?: string[]; // upstream story IDs
};

type WaveResult = {
  waveNumber: number;
  stories: Record<string, StoryOutcome>;
  durationMs: number;
  completedAt: number;
};

type StoryOutcome = {
  status: 'APPROVED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
  attempts: number; // dev attempts performed
  reviewAttempts: number; // reviewer attempts performed
  filesTouched: string[];
  finalDiff?: string;
  blocker?: BlockerRecord; // present when status === 'BLOCKED'
  terminalFailure?: string; // present when status === 'FAILED'
};

type BlockerRecord = {
  code:
    | 'ambiguous-ac'
    | 'insufficient-touch-points'
    | 'missing-dependency'
    | 'architectural-conflict'
    | 'context-gap'
    | 'environment';
  severity: 'hard' | 'soft';
  description: string;
  affectedPath?: string;
  suggestedResolution?: string;
  detectedAt: number;
};
```

### Status vocabulary

| Epic status                     | Meaning                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `PENDING`                       | Enqueued, not yet picked up by daemon                       |
| `RUNNING`                       | Orchestrator has been spawned                               |
| `COMPLETE`                      | All stories `APPROVED`                                      |
| `COMPLETE_WITH_BLOCKED_STORIES` | All completable stories done; one or more `BLOCKED`         |
| `FAILED`                        | Orchestrator crashed unrecoverably, or wave-0 infra failure |

| Per-story status | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `PENDING`        | Not yet dispatched                                       |
| `IN_DEV`         | Dev subagent running (attempt N)                         |
| `IN_REVIEW`      | Reviewer subagent running                                |
| `APPROVED`       | Reviewer returned APPROVE                                |
| `FAILED`         | Exhausted remediation rounds without APPROVE             |
| `BLOCKED`        | Dev reported a hard blocker that is not auto-recoverable |
| `SKIPPED`        | Operator elected to skip (during blocker resolution)     |

### Daemon changes (minimal)

- Add `daemon/pipelines/epic-dev-pipeline.mjs` — entry point for `phase: 'epic-dev'` jobs.
- Reuse the existing spawn/auth/log machinery in `agent-daemon.mjs` untouched. The new pipeline resolves the orchestrator prompt template, substitutes variables from the job payload, and calls the existing `spawn-claude` function.
- Add `daemon/pipelines/emit-event.sh` — small NDJSON writer; see Section 9.
- Add a watcher process or extend the daemon to tail `/var/log/futurator/events/*.ndjson` and forward rows to the `futurator-agent-events` DynamoDB table.

No changes required to the API layer or auth middleware.

### Crash-resume

After each wave completes (any outcome), the orchestrator POSTs `waveResults[K]` to a daemon endpoint. The daemon writes it to the job row. If the orchestrator process dies, the daemon's next poll cycle finds the job `RUNNING` with a stale heartbeat and respawns it, passing `resumeFromWaveResults` in the prompt. The orchestrator skips already-completed waves.

---

## 4. Subagent Taxonomy

Four subagent types, each committed as a markdown file under `.claude/agents/` in the **cloned project working directory** (the daemon checks these out alongside project code).

### 4.1 `.claude/agents/senior-reviewer.md`

```markdown
---
name: senior-reviewer
description: Independent senior-dev reviewer. Reviews a diff against a story's acceptance criteria and the project rubric. Returns a structured verdict. Has no capability to edit code — Read/Grep/Glob/Bash only.
tools: Read, Grep, Glob, Bash
model: sonnet
---

# Senior Reviewer

You are a senior software engineer conducting an **independent code review**. You are NOT the implementer. You have not seen the implementer's reasoning, tool calls, or internal notes — only the diff and the story.

## Hard rules

1. **You never edit code.** Your Edit and Write tools are intentionally removed. Do not attempt to paste code replacements as suggestions — describe what and where, not exact replacement text.
2. **Your sole output is a structured verdict** in the format specified below.
3. **You are the final gate for this attempt.** APPROVE means the orchestrator moves on. REQUEST_CHANGES triggers remediation.
4. **An APPROVE must have zero blockers and zero majors.** Minors are allowed. Do not grade on a curve across rounds — a fresh reviewer runs each round.
5. **Cite rule IDs.** When a violation maps to a rubric rule, reference the rule ID (e.g., `R-ARCH-001`) in the finding description.

## Input you will receive

- `storyId`, story title, full acceptance criteria
- Declared touch points for this story
- `diff` — unified git diff of the implementer's changes
- `rubric` — merged default + project review rubric
- `priorFindings` (optional) — findings from earlier review rounds, present on remediation

## Process

Think hard about correctness. For every acceptance criterion, determine whether the diff satisfies it. For every rubric item, determine compliance. Where the diff calls into existing code, use Read/Grep/Glob to walk enough of the surrounding code to verify behavior — do not assume.

When `priorFindings` is present, verify each is addressed. It is a bug for the implementer to ignore a prior blocker; call that out explicitly.

Be specific. "This is unclear" is not a finding. "Line 42 of api-client.ts, the retry condition will never trigger because …" is a finding.

## Output contract

End your response with a JSON block between `<VERDICT>` and `</VERDICT>` tags. The orchestrator parses this block and ignores everything before and after.

<VERDICT>
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "findings": [
    {
      "severity": "blocker" | "major" | "minor",
      "category": "ac-violation" | "rubric" | "correctness" | "maintainability" | "test-coverage",
      "ruleId": "R-XXX-NNN | null",
      "location": "path/to/file:line-or-range",
      "description": "What is wrong and why it matters. Do not include proposed code."
    }
  ],
  "summary": "1–2 sentence high-level assessment",
  "priorFindingsAddressed": ["finding-ids addressed on this round, or empty array"]
}
</VERDICT>
```

### 4.2 `.claude/agents/dev-trivial.md`

```markdown
---
name: dev-trivial
description: Trivial-complexity implementer for one-line changes, renames, config bumps, and mechanical edits. Uses Haiku for speed. Scoped to declared touch points.
tools: Read, Grep, Glob, Edit, Write, Bash
model: haiku
---

# Trivial Implementer

You implement a narrow, mechanical change specified in the story. You are fast and direct. You do **not** explore the codebase — you were given a pre-digested context and a precise list of files to touch.

## Hard rules

1. **Touch points are a boundary.** You may Read any file. You may Edit or Write **only** files matching the provided touch points. Violating this is a collision risk because sibling stories run in parallel.
2. **No exploration.** Do not Grep or Glob the repo to "understand more." If the pre-digested context is genuinely insufficient, declare a `context-gap` blocker and stop.
3. **No refactors.** You implement what the story asks, nothing else. No cleanup passes, no renames outside the AC.
4. **Declare blockers before editing, not after.** If you detect a blocker during initial analysis, populate `blockers` and return immediately without touching any file.
5. **Run verification only if fast.** A targeted `npm run typecheck` is fine. Do not run the full test suite.

## Input

- `storyId`, title, acceptance criteria
- `touchPoints` (glob list — your edit boundary)
- `siblingTouchPoints` (paths to avoid)
- pre-digested context
- rubric highlights

## Output contract

End your response with:

<DEV_RESULT>
{
"filesTouched": ["path/one.ts"],
"testsRun": [{ "command": "npm run typecheck", "ok": true, "excerpt": "..." }],
"blockers": [
{
"code": "ambiguous-ac" | "insufficient-touch-points" | "missing-dependency" | "architectural-conflict" | "context-gap" | "environment",
"severity": "hard" | "soft",
"description": "...",
"affectedPath": "...",
"suggestedResolution": "...",
"requestedTouchPointExpansion": ["glob"]
}
],
"summary": "one sentence"
}
</DEV_RESULT>
```

### 4.3 `.claude/agents/dev-standard.md`

```markdown
---
name: dev-standard
description: Standard-complexity implementer for typical feature stories. Uses Sonnet with structured thinking. Scoped to declared touch points.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
---

# Standard Implementer

You implement a typical development story — new feature, bug fix, or moderate refactor — within the declared touch points. You think before you edit.

## Process

Think about the change before making it. Walk the relevant files with Read. Identify existing patterns and reuse them. Edit only files in your touch points. Write tests when the rubric requires.

## Hard rules

1. **Touch points are a boundary.** Edit/Write only files matching the globs. Read outside the boundary is fine for understanding.
2. **Reuse over invention.** Prefer extending existing interfaces, repositories, hooks, and utilities over introducing new abstractions. If you create a new file, justify it in your result summary.
3. **Do not mix concerns.** This story has one AC set. Do not piggyback unrelated cleanup.
4. **Test what you change.** If you add a repository function or hook, add a colocated test covering the primary path and one error case.
5. **Validate at boundaries.** If you touch an API route, ensure Zod validation uses `.safeParse()` and errors use the project's error envelope.
6. **Declare blockers before editing, not after.** Same blocker protocol as `dev-trivial`.

## Input / Output

Same as `dev-trivial`, plus the orchestrator will include `think` (or `think hard` for complex stories) as an effort keyword in your prompt.

<DEV_RESULT>
{
"filesTouched": [...],
"testsRun": [{ "command": "...", "ok": bool, "excerpt": "..." }],
"blockers": [...],
"newAbstractionsIntroduced": ["reason if any"],
"summary": "one sentence"
}
</DEV_RESULT>
```

### 4.4 `.claude/agents/dev-architectural.md`

```markdown
---
name: dev-architectural
description: Architectural implementer for stories that introduce or modify patterns, contracts, or cross-cutting infrastructure. Uses Opus with extended thinking. Always runs isolated in its own wave.
tools: Read, Grep, Glob, Edit, Write, Bash
model: opus
---

# Architectural Implementer

You implement stories that affect architectural patterns, shared contracts, or infrastructure. Your work sets precedent for future stories. Precision and deliberation matter more than speed.

## Process

Think hard about the change. Architectural decisions are hard to reverse — this is not the place to "prototype and see." Before editing:

1. Walk the existing pattern in full. Read every implementation of the pattern you are modifying.
2. Identify every downstream consumer. Plan the migration order.
3. Ensure the change is internally consistent — if you rename an interface, every implementation and consumer moves together.

## Hard rules

1. **Architectural stories always run in an isolated wave.** No parallel siblings — your touch points may be broad.
2. **Produce a migration note.** One sentence on what future stories must do differently because of this change. This feeds into the context digest for subsequent epics.
3. **Update the project overlay rubric if your change introduces a new rule.** Reviewers do not know about your new pattern until the rubric does.
4. **Reviewer will be `senior-reviewer` with `think harder` effort.** Expect strict review.

## Output

<DEV_RESULT>
{
"filesTouched": [...],
"testsRun": [...],
"blockers": [...],
"migrationNote": "one sentence for the next context digest",
"rubricAmendmentProposed": "R-ARCH-XXX — ... | null",
"summary": "..."
}
</DEV_RESULT>
```

---

## 5. Model and Effort Policy

### Per-role defaults

| Role                | Default model | Default effort keyword | Escalation                                          |
| ------------------- | ------------- | ---------------------- | --------------------------------------------------- |
| Orchestrator        | Opus 4.7      | `think`                | Rarely — it is conducting, not coding               |
| Dev (trivial)       | Haiku 4.5     | _(none)_               | Bump to Sonnet on first hard-fail                   |
| Dev (standard)      | Sonnet 4.6    | `think`                | Default                                             |
| Dev (complex)       | Sonnet 4.6    | `think hard`           | Cheaper than bare Opus, often better quality        |
| Dev (architectural) | Opus 4.7      | `think hard`           | Reserved                                            |
| Reviewer (light)    | Haiku 4.5     | _(none)_               | Smoke check only                                    |
| Reviewer (standard) | Sonnet 4.6    | `think`                | Default                                             |
| Reviewer (strict)   | Sonnet 4.6    | `think harder`         | Escalate to Opus only if repeatedly missing defects |

### Complexity → subagent type mapping

Three subagent type files; four tier behaviors. `complex` reuses the `dev-standard` persona with escalated effort.

| complexity    | subagent_type       | effort keyword in dispatch prompt |
| ------------- | ------------------- | --------------------------------- |
| trivial       | `dev-trivial`       | _(none)_                          |
| standard      | `dev-standard`      | `think`                           |
| complex       | `dev-standard`      | `think hard`                      |
| architectural | `dev-architectural` | `think harder`                    |

### Review rigor → effort mapping

| reviewRigor | subagent_type     | effort keyword |
| ----------- | ----------------- | -------------- |
| light       | `senior-reviewer` | _(none)_       |
| standard    | `senior-reviewer` | `think`        |
| strict      | `senior-reviewer` | `think harder` |

### Cost profile (per subagent call, ~15k input / ~3k output)

| Tier       | Typical cost |
| ---------- | ------------ |
| Haiku 4.5  | ~$0.024      |
| Sonnet 4.6 | ~$0.09       |
| Opus 4.7   | ~$0.45       |

**Epic cost estimate** (8 stories × dev + reviewer × 1.3 remediation avg = ~21 calls):

- All Sonnet: ~$1.90/epic
- Mixed (Haiku trivial + Sonnet standard + Opus architectural): ~$1.20/epic
- All Opus (anti-pattern): ~$9.45/epic

### Design principles

1. **Do not stack Opus + `ultrathink` by default.** Usually Pareto-dominated by Sonnet + `think harder`.
2. **Dev and reviewer can run at different tiers** for the same story. Haiku dev + Sonnet reviewer is a legitimate low-cost pipeline for boilerplate stories.
3. **`think harder` has sharply diminishing returns past 15% quality lift for ~2× latency.** Reserve for strict reviews and architectural dev.

---

## 6. Wave Conflict Handling

Two-layer defense: **upstream declaration** (primary) + **runtime claim-check** (safety net).

### 6.1 Upstream — `touchPoints` on every story

Added at compile time by an extended step in `daemon/pipelines/predev-compile-pipeline.mjs`.

**Pipeline shape after extension:**

```
predev-compile-pipeline:
  1. compile-epic          (existing)
  2. compile-stories       (existing)
  3. touch-point-inference    ← NEW
  4. complexity-and-rigor-tagging  ← NEW (can fold into 3)
  5. wave-assignment       (existing, now touchPoints-aware)
  6. persist
```

**Step 3 — touch-point-inference:** For each story, one Haiku call with this prompt:

```
You are analyzing a development story to predict which files it will modify.

Story: {title}
Acceptance criteria: {list}
Relevant architecture notes: {excerpt from context digest}
Repo structure (relevant subtree):
{output of `tree -L 3` scoped to likely areas}

Output a JSON array of GLOB patterns representing files this story will edit:
- Prefer module-level globs: "src/hooks/use-costs.*" not "src/hooks/use-costs.ts"
- Include test files: "src/hooks/__tests__/use-costs.test.*"
- Include related type files if the story changes contracts
- Include API handlers if the story touches endpoints
- If docs-only: return []
- If architectural/cross-cutting: return ["src/**/*"] and flag "broad"

Return ONLY:
<TOUCH_POINTS>
{ "globs": [...], "broad": boolean, "rationale": "one sentence" }
</TOUCH_POINTS>
```

**Step 4 — complexity-and-rigor-tagging** (same Haiku call can produce both):

```
<STORY_TAGS>
{ "complexity": "trivial" | "standard" | "complex" | "architectural",
  "reviewRigor": "light" | "standard" | "strict",
  "rationale": "why" }
</STORY_TAGS>
```

**Validation:**

- Empty globs + non-docs story → pipeline fails, flags for human.
- `broad: true` → accepted, but wave-assignment isolates into its own wave.
- Globs outside the repo → pipeline fails (likely hallucination).

**Step 5 — Wave assignment becomes touch-points-aware:**

```
waveOf(story):
  wave = max(waveOf(dep) for dep in story.dependsOn) + 1
  if story.broad:
    wave = max_wave_in_epic + 1   # isolate
  return wave

# After initial assignment, co-wave conflict pass:
for each pair (s_i, s_j) in same wave:
  if globs(s_i) ∩ globs(s_j) ≠ ∅:
    bump later story to wave + 1
```

### 6.2 Runtime — orchestrator claim-check

Before dispatching wave K:

```
1. Collect touchPoints for every story in wave K.
2. Pairwise glob intersection check (literal prefix sharing counts).
3. If any pair overlaps:
     - Split wave K into sub-waves K.1, K.2, ...
     - Emit `wave_split` event with decision payload
4. Dispatch first sub-wave.
```

After dispatch returns:

```
For each dev result:
  if result.filesTouched not ⊆ declared touchPoints:
    if overlap with sibling's touchPoints:
      → emit `wave_collision` event
      → `git checkout --` the offending files from this story
      → mark story for serialized re-dispatch after sibling review
    else:
      → emit `touch_points_drift` event (advisory, not failure)
```

### 6.3 UI surface

Per-story fields become editable in Labs:

- `complexity` (dropdown)
- `reviewRigor` (dropdown)
- `touchPoints` (glob list, editable)
- Badges: `broad` (warning icon), `co-wave with STORY-7` (link)

Operator can tune pre-dispatch before clicking Start Development.

### 6.4 Backwards compatibility

Existing compiled epics lack `touchPoints`. Orchestrator treatment when missing:

- Treat as `broad: true` — serialize into its own micro-wave.
- Emit advisory log: `touchPoints missing — story treated as broad`.
- Safe degradation: un-migrated epics run slower, not incorrectly.

---

## 7. Error Handling and Blocker Taxonomy

### Three failure modes, three responses

| Failure                                                        | Root cause                       | Correct response                                                                               |
| -------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Dev subagent hard-fails (exception, timeout, tool error)       | Environmental or model-side      | Retry same Task once with 10s backoff. If still failing, mark story `FAILED` — no remediation. |
| Reviewer returns `REQUEST_CHANGES`                             | Work does not meet AC or rubric  | Remediation loop (Section 8).                                                                  |
| Wave collision detected (touch-points drift + sibling overlap) | Declared touch-points were wrong | Rollback affected files, serialize, re-dispatch. Not a review failure.                         |

### Blocker taxonomy (dev-reported, pre-edit)

Six codes. The orchestrator can autonomously recover from three; three require human action.

| Code                        | Meaning                                                        | Auto-recovery?                                                                 |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ambiguous-ac`              | AC are unclear or internally contradictory                     | No — human clarifies                                                           |
| `insufficient-touch-points` | Required edit is outside declared touch points                 | **Yes (one-shot):** expand touch points and re-dispatch, if no sibling overlap |
| `missing-dependency`        | Dependent story from earlier wave did not deliver its contract | No — surface; likely a prior wave was prematurely APPROVED                     |
| `architectural-conflict`    | Change would violate a rubric rule; dev refuses to proceed     | No — surface; story as written cannot land                                     |
| `context-gap`               | Pre-digested context is missing something critical             | **Yes (one-shot):** re-dispatch with expanded context excerpt                  |
| `environment`               | Missing binary, credentials, filesystem state                  | **Yes (retry once):** may be transient                                         |

### Orchestrator blocker handling logic

```
for each blocker b in story.blockers (hard only):
  switch b.code:
    case insufficient-touch-points:
      expanded = declared ∪ b.requestedTouchPointExpansion
      if expanded overlaps any sibling's touchPoints in this wave:
        → escalate (serialize into later micro-wave)
      else if story.touchPointExpansionAttempts == 0:
        → emit touch_points_expanded event
        → re-dispatch same dev subagent with expanded touchPoints
        → story.touchPointExpansionAttempts = 1
      else:
        → escalate to human (two expansions is a pattern, not a miss)

    case context-gap:
      if story.contextExpansionAttempts == 0:
        → re-dispatch with additional context excerpt
           (dev's description pinpoints what was missing)
        → story.contextExpansionAttempts = 1
      else:
        → escalate

    case environment:
      → retry once with same inputs after 10s backoff
      → if still fails: escalate

    case ambiguous-ac | missing-dependency | architectural-conflict:
      → mark story BLOCKED (not FAILED)
      → emit story_blocked event
      → do NOT dispatch reviewer
      → continue wave for other stories
```

### BLOCKED vs FAILED distinction

- `BLOCKED`: story cannot proceed without human input. Recoverable via the resolve-blocker endpoint (Section 10.4). Epic exits as `COMPLETE_WITH_BLOCKED_STORIES`.
- `FAILED`: story exhausted the remediation loop. Different remediation path — likely involves re-planning rather than re-dispatching.

---

## 8. Remediation Loop

Bounded per-story. Reviewer is **stateless across attempts** — a fresh `senior-reviewer` subagent spawns every round.

### Loop (per story that returned REQUEST_CHANGES)

```
attempt = 1
while attempt <= MAX_REMEDIATION_ROUNDS:
  if attempt > 1:
    prompt = remediation_template with:
      - storyId, title, AC
      - lastDiff (from previous attempt)
      - reviewerFindings (structured)
      - framing: "address these findings, do not rewrite the story"
      - touchPoints, siblingTouchPoints
      - effortKeyword (by complexity)
  else:
    prompt = initial_dev_template

  dispatch dev subagent  (Task tool)
  capture diff

  dispatch fresh senior-reviewer subagent  (Task tool)
  parse <VERDICT>

  if verdict == APPROVE:
    break
  if verdict == REQUEST_CHANGES:
    attempt += 1
    continue
  if verdict malformed:
    re-dispatch reviewer once
    if still malformed: mark story FAILED with code `reviewer_protocol_violation`

if attempt > MAX_REMEDIATION_ROUNDS:
  mark story FAILED
  emit story_failed_terminally event
  attach all reviewer findings across rounds for human triage
  continue wave for sibling stories
```

### Key properties

1. **Remediation prompts are different from first-try prompts.** Feed the reviewer's findings as the primary instruction; the dev subagent's job on retry is "address these specific findings" not "rewrite your understanding."
2. **Stateless reviewer per attempt.** Prevents reviewer fatigue or accepting mediocre work because it looks familiar.
3. **MAX_REMEDIATION_ROUNDS is per-epic policy in the job payload.** Default 2. Tune after observation.
4. **Admitting defeat is a feature.** Never loop forever.

---

## 9. Observability Spine

### Event schema

All events carry a stable hierarchical correlation ID. Stored in `futurator-agent-events` DynamoDB table (existing).

```ts
type OrchestratorEvent = {
  jobId: string;
  epicId: string;
  waveNumber: number;
  storyId?: string;
  role: 'orchestrator' | 'dev' | 'reviewer';
  subagentId?: string; // orchestrator-generated, stable per Task call
  attempt?: number; // 1,2,... for remediation
  correlationId: string; // `{epicId}/wave-{K}/{storyId}/{role}/{attempt}`
  eventType: string;
  payload: unknown;
  ts: number;
};
```

### Event vocabulary

**Existing events (retained):** `step_start`, `step_complete`, `step_error`, `tool_use`, `validation`, `extraction`.

**New events:**

| Event                     | When fired                                                   | Payload                                                                                      |
| ------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------- |
| `epic_start`              | Orchestrator begins                                          | `{maxParallel, storyCount, totalWaves}`                                                      |
| `wave_start`              | Wave K begins                                                | `{waveNumber, storyIds}`                                                                     |
| `wave_split`              | Claim-check serialized a conflict                            | `{waveNumber, subWaves: [[ids],[ids]]}`                                                      |
| `wave_collision`          | Runtime detected touch-point overlap after dispatch          | `{waveNumber, storyId, offendingFiles, siblingStoryId}`                                      |
| `touch_points_expanded`   | Orchestrator auto-expanded after `insufficient-touch-points` | `{storyId, before, after, source}`                                                           |
| `subagent_dispatch`       | Orchestrator calls Task                                      | `{role, storyId, subagentId, promptBytes, attempt}`                                          |
| `subagent_return`         | Task returns                                                 | `{role, storyId, subagentId, durationMs, resultSummary}`                                     |
| `dev_blocker_reported`    | Dev returns non-empty blockers                               | `{storyId, attempt, blockers: [...]}`                                                        |
| `story_blocked`           | Orchestrator classified as non-recoverable                   | `{storyId, blockerCode, blockerDescription, suggestedResolution, humanActionRequired: true}` |
| `review_verdict`          | Reviewer returned                                            | `{storyId, attempt, verdict, findings}`                                                      |
| `remediation_start`       | New remediation round dispatched                             | `{storyId, attempt, targetFindings}`                                                         |
| `wave_complete`           | Wave K finished                                              | `{waveNumber, outcomes: {storyId: status}}`                                                  |
| `story_failed_terminally` | MAX remediation exhausted                                    | `{storyId, allFindings}`                                                                     |
| `blocker_resolved`        | Operator resolved a blocker via API                          | `{storyId, action: 'amend'                                                                   | 'skip', reason}` |
| `epic_complete`           | Orchestrator exits cleanly                                   | `{storyResults, totalWaves, totalRemediations}`                                              |
| `epic_failed`             | Orchestrator crashed / infra error                           | `{reason}`                                                                                   |

### Emission mechanism

The orchestrator emits via a small shell script invoked through its `Bash` tool:

```bash
# daemon/pipelines/emit-event.sh
#!/bin/bash
# Usage: emit-event.sh '<json event object>'
# Writes to NDJSON log; daemon tails and forwards to DynamoDB.

set -euo pipefail

EVENT_JSON="$1"
JOB_ID=$(echo "$EVENT_JSON" | jq -r '.jobId')
LOG_DIR=/var/log/futurator/events
mkdir -p "$LOG_DIR"
echo "$EVENT_JSON" >> "$LOG_DIR/${JOB_ID}.ndjson"
```

Daemon-side forwarder (new, small process or extension of `agent-daemon.mjs`):

- `tail -F /var/log/futurator/events/*.ndjson`
- For each line: parse, validate, write to `futurator-agent-events` DynamoDB table
- On write failure: leave line in place, retry; dedupe by `(jobId, ts, eventType)` if needed

### Flat-log endpoint

For paste-into-chat design iteration:

```
GET /api/epic-workflows/:epicId/flat-log?since=<ts>
```

Returns a plain-text log with one correlation-tagged line per event. Format:

```
EPIC-42/wave-1/STORY-7/orchestrator/-/wave_start
EPIC-42/wave-1/STORY-7/dev/1/subagent_dispatch
EPIC-42/wave-1/STORY-7/dev/1/tool_use Read src/use-costs.ts
EPIC-42/wave-1/STORY-7/dev/1/step_complete
EPIC-42/wave-1/STORY-7/dev/1/subagent_return
EPIC-42/wave-1/STORY-7/reviewer/1/subagent_dispatch
EPIC-42/wave-1/STORY-7/reviewer/1/review_verdict
  verdict=REQUEST_CHANGES
  findings=[{severity:major,ruleId:R-TEST-001,description:"no test for error path"}]
EPIC-42/wave-1/STORY-7/dev/2/remediation_start
EPIC-42/wave-1/STORY-7/dev/2/subagent_dispatch
...
```

Grep-friendly. Ten lines tell a complete story.

---

## 10. UI Signals

### 10.1 Event Log (existing panel, extended)

**Blocker treatment — amber with 🚧 icon.** Reserved color. Reviewer rejections remain red with ✗. Hard fails remain dark-red with ⚠.

Blocker entry (expanded form):

```
🚧 STORY-7 — Blocked: AC ambiguity
   Dev reported: "AC says costs aggregated daily but no timezone specified"
   Suggested: Specify UTC or user-local in AC
   → Requires human clarification         [Resolve Blocker ▸]
```

Auto-recovery entries use gray with ↻ icon (quieter, but visible in trail):

```
↻ STORY-8 — Touch points auto-expanded
   Added: src/stores/auth-store.*   Reason: insufficient-touch-points
```

### 10.2 Story cards (Labs view)

Each card gains a status strip:

| Strip color        | Label                      | Meaning               |
| ------------------ | -------------------------- | --------------------- |
| gray               | PENDING                    | Not started           |
| blue               | IN_DEV (attempt N)         | Dev running           |
| purple             | IN_REVIEW (attempt N)      | Reviewer running      |
| green              | APPROVED                   | Done                  |
| amber              | 🚧 BLOCKED — {reason code} | Needs human           |
| red                | ✗ FAILED                   | Exhausted remediation |
| gray-strikethrough | ~~SKIPPED~~                | Operator skipped      |

Epic header counter: `🚧 2 blocked` — visible only when non-zero.

### 10.3 Agentic Office (extended visualization)

New visual primitives mapped to new events:

| Concept                   | Visual treatment                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Epic orchestrator         | Supervisor at the whiteboard-adjacent desk. Persistent for the whole epic. Status ring: green (dispatching), yellow (waiting on wave), orange (conflict resolution), red (failed). |
| Wave                      | Horizontal band of desks that light up together. Wave label floats above.                                                                                                          |
| Dev subagent              | Worker at row desk, labeled with story ID. Ephemeral — appears on `subagent_dispatch`, disappears on `subagent_return`.                                                            |
| Reviewer subagent         | Distinct visual style (different color, at review booth or round table). Pairs visually with the dev it reviews — thin line connects them during review. Ephemeral.                |
| Remediation loop          | Dev worker respawns at the same desk with `attempt: 2` badge. Line to reviewer re-forms. Retry is visually obvious.                                                                |
| Wave collision / split    | Colliding desks flash, wave band ripples, orchestrator ring briefly orange.                                                                                                        |
| Blocker reported          | Dev worker stands up, walks to the whiteboard, places a 🚧 card on it, returns to desk, sits idle.                                                                                 |
| Touch points expanded     | Orchestrator walks to whiteboard, updates the dev's assignment card, walks back. Dev resumes with attempt badge incremented.                                                       |
| Story blocked (escalated) | Desk gets amber status ring that pulses slowly. Worker remains seated and idle. Whiteboard 🚧 card persists.                                                                       |
| Human resolves blocker    | 🚧 card animates off whiteboard; dev desk re-activates on next orchestrator run.                                                                                                   |
| Story terminally failed   | Desk goes gray with red ribbon. Persists visible at end-of-epic.                                                                                                                   |
| Epic complete             | Supervisor walks to whiteboard, writes completion summary (animation). Office dims briefly, then idles.                                                                            |

**The whiteboard is the blocker ledger.** Count the 🚧 cards on the whiteboard and you know the human-action queue depth at a glance.

### 10.4 Resolve-blocker API

```
POST /api/epic-workflows/:epicId/stories/:storyId/resolve-blocker
body: {
  action: "amend" | "skip",
  amendedStory?: {
    title?: string,
    acceptanceCriteria?: string[],
    touchPoints?: string[],
    complexity?: ...,
    reviewRigor?: ...
  },
  reason: string
}
```

**Behavior:**

- `action: "amend"` → persists amended fields on story record, clears `storyStatus: BLOCKED`, re-queues story for next orchestrator dispatch (simpler to trigger a full epic-dev job with `resumeFromWaveResults` so completed stories skip).
- `action: "skip"` → marks story `SKIPPED`, records reason, excludes from future dispatches. Visible with gray-strikethrough.
- Both emit `blocker_resolved` event.

### 10.5 Persistence

**Critical:** BLOCKED state persists across page reloads. Lives on the story record in DynamoDB, not only in the event stream.

- Event stream drives animation.
- DynamoDB state drives cold-load rendering.

Same pattern already in use for story status.

---

## 11. Cross-epic Chaining and Resume

### Cross-epic chaining

**Pattern: daemon-polls-next.** No hooks, no custom signals.

1. Orchestrator writes `status: COMPLETE` (or `COMPLETE_WITH_BLOCKED_STORIES`) on job row before exit.
2. Daemon's normal poll cycle finds the next PENDING epic job and spawns it.
3. `epic-build` phase jobs (build check, deploy-ready verification) are created by the daemon when it observes `epic-dev` completed.

Alternative considered: Stop hooks triggering next-epic enqueue. Rejected — adds a parallel control plane that bypasses the daemon's queue. Keep one source of truth.

### Crash-resume within an epic

**Pattern: persist waveResults per wave; skip on restart.**

After each wave boundary:

```
orchestrator → POST /daemon/wave-complete
  body: { jobId, wave, waveResult }
daemon → write to DynamoDB agent-jobs row: waveResults[wave] = {...}
```

If the orchestrator process dies mid-epic (EC2 OOM, crash, manual kill):

1. Daemon's poll cycle detects `status: RUNNING` with stale heartbeat (>5 min since last event).
2. Daemon respawns orchestrator with prompt variable `resumeFromWaveResults` populated from the job row.
3. Orchestrator's control-flow contract includes a resume directive:
   > If `resumeFromWaveResults` is present, for each wave K already in the map:
   >
   > - Skip waves where all stories are APPROVED or FAILED-terminally.
   > - For waves with BLOCKED stories: skip the wave but respect the blocks when evaluating dependencies.
   > - Start fresh at the first wave not in the map.

**No re-dispatch of already-APPROVED stories under any circumstance.**

---

## 12. Validated Assumptions (Spike Summary)

### Premise tested

> Invoking N `Task` calls in a single assistant message dispatches all N subagents concurrently; wall-clock is approximately `max(subagent duration) + dispatch ramp`, not `sum(durations)`.

If false, the per-epic orchestrator design collapses into serial execution and buys no parallelism.

### Methodology

Sub-agent sleepers ran 15-second sleeps with bash-captured start/finish timestamps. Spread (`maxFinish − minStart`) compared against per-agent elapsed time:

- `spread ≈ perAgentElapsed` → parallel
- `spread ≈ N × perAgentElapsed` → serial

Ran on darwin (developer workstation) using `haiku` sub-agents via the Claude Code Task tool. Not on EC2 — directionally useful, not production-final.

### Results (2026-04-17)

| N   | Per-agent elapsed | Spread | Efficiency `(N × perAgent) / spread` | Verdict vs pre-registered threshold |
| --- | ----------------- | ------ | ------------------------------------ | ----------------------------------- |
| 2   | 19–20s            | 20s    | 1.9                                  | ✅ ≥ 1.5 required                   |
| 4   | 18–20s            | 25s    | 3.0                                  | ✅ ≥ 3.0 required                   |
| 8   | 18–20s            | 33s    | 4.6                                  | ⚠️ below ≥ 6.0 required             |

### Observations

1. **Dispatch ramp.** Sub-agents start in a stagger of roughly 2 seconds per agent. For N=8, total ramp ~15s. This is a fixed cost independent of sub-agent work duration.
2. **Once started, sub-agents run concurrently.** Finish times cluster; no evidence of sequential tail.
3. **No rate-limit errors, no dispatch failures** at N=8 on darwin.

### Verdict

**Design validated with calibration.** Claude Code's Task tool provides genuine in-process parallel fan-out. The N=8 efficiency of 4.6 appears suboptimal under the strict pre-registered threshold but is dominated by the 15-second dispatch ramp — a fixed cost. For realistic dev subagent durations (3–5 minutes), the ramp becomes <10% overhead and effective parallelism approaches N.

Illustrative projection for realistic work:

- N=8 × 300s per agent (5 minutes of real dev work)
- Spread ≈ 15s ramp + 300s = 315s
- Efficiency ≈ (8 × 300) / 315 ≈ 7.6

### Recommended parallelism caps

| Role               | `maxParallel` | Rationale                                          |
| ------------------ | ------------- | -------------------------------------------------- |
| Dev subagents      | 8             | Real dev work is 3–5 min; ramp is negligible       |
| Reviewer subagents | 4             | Review work is faster (1–2 min); ramp matters more |

### Caveats

- Ran on darwin, not EC2. EC2 numbers should be re-verified post-deploy; likely comparable or better (dedicated network, no desktop contention).
- All sleepers were Haiku. Sonnet/Opus dispatch ramp may be ~3s per agent rather than 2s. Recheck once real subagent types are in use.
- Total spike cost: ~$0.10 across 14 sleeper invocations.

---

## 13. Phased Implementation Plan

Ordered by unblocking dependency. Each phase is independently shippable and reversible.

### Phase 1 — Subagent specs and orchestrator prompt template

**Deliverables:**

- `.claude/agents/senior-reviewer.md`
- `.claude/agents/dev-trivial.md`
- `.claude/agents/dev-standard.md`
- `.claude/agents/dev-architectural.md`
- `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl` — templated prompt with `{{vars}}`
- `daemon/pipelines/templates/dev-subagent-prompt.md.tpl`
- `daemon/pipelines/templates/reviewer-subagent-prompt.md.tpl`
- `daemon/pipelines/templates/remediation-prompt.md.tpl`

**Testing:** Spawn orchestrator manually with a single-story epic in a throwaway project repo. Verify subagents dispatch, reviewer returns verdict, emit-event.sh writes NDJSON lines.

**Rollback:** None needed — no production path invoked yet.

### Phase 2 — Review rubric: global default + project overlay

**Deliverables:**

- `/opt/futurator/rubrics/default.md` (global, across projects) — populated with `R-CORR-*`, `R-CONV-*`, `R-TEST-*`, `R-MAINT-*`, `R-SEC-*` basics.
- `.claude/review-rubric.md` in Futurator-Admin repo — project overlay (see Section 14 for content).
- Rubric-merge logic in `daemon/pipelines/epic-dev-pipeline.mjs` — loads both, concatenates, passes as `rubric` job payload field.

**Testing:** Merge locally, verify output, inspect rubric text is sensible.

### Phase 3 — emit-event.sh and daemon-side forwarder

**Deliverables:**

- `daemon/pipelines/emit-event.sh`
- Daemon extension: tail `/var/log/futurator/events/*.ndjson`, forward rows to `futurator-agent-events` DynamoDB table.
- Retry logic on DynamoDB write failure; de-dupe by `(jobId, ts, eventType)` if needed.

**Testing:** Write 100 events to an NDJSON file, verify all land in DynamoDB within 5s.

**Rollback:** Disable forwarder; events accumulate locally but do not affect production.

### Phase 4 — epic-dev pipeline in daemon

**Deliverables:**

- `daemon/pipelines/epic-dev-pipeline.mjs` — entry point for `phase: 'epic-dev'` jobs.
- Extends existing spawn logic in `agent-daemon.mjs` — no changes to auth/retry/credential handling.
- Job schema migration: add `phase` discriminator, `payload` structure per Section 3.
- API endpoint: `POST /api/epic-workflows/:epicId/start` — creates `epic-dev` job row.
- Wave-complete endpoint: `POST /daemon/wave-complete` — accepts checkpoint from orchestrator, writes to job row.

**Testing:** End-to-end dry run with a minimal synthetic epic (2 stories, 1 wave). Compare against current per-story pipeline outcome.

**Rollback:** Feature flag in Labs UI: `useEpicOrchestrator: boolean`. If false, falls back to legacy per-story dispatch. Keep both paths for one release cycle.

### Phase 5 — touch-point-inference compile step

**Deliverables:**

- Extend `daemon/pipelines/predev-compile-pipeline.mjs` — add steps 3 (touch-point-inference) and 4 (complexity-and-rigor-tagging).
- Update `compile-pipeline.mjs` if story schema changes propagate there.
- Update `functions/shared/types/epic-workflow.ts` — add `touchPoints`, `complexity`, `reviewRigor` to story type.
- DynamoDB migration: existing epics get defaults (`touchPoints: []` treated as broad, `complexity: standard`, `reviewRigor: standard`).

**Testing:** Compile a known epic; inspect `touchPoints` output against operator intuition; iterate prompt if necessary.

**Rollback:** Orchestrator treats missing fields as broad/standard/standard — safe degradation.

### Phase 6 — UI: story status strips + blocker treatment in Event Log

**Deliverables:**

- `src/components/labs/agentic-workflow/story-card.tsx` — add status strip.
- `src/components/agentic-office/event-translator.ts` — handle new event types.
- New component: `BlockerResolvePanel` — side panel triggered by "Resolve Blocker" button.
- Epic header: blocker counter badge.
- API: `POST /api/epic-workflows/:epicId/stories/:storyId/resolve-blocker`.

**Testing:** Storybook entries for each story card state. E2E test (Playwright) that simulates a blocker event and exercises the resolve panel.

**Rollback:** Old card design is preserved; new strip is additive.

### Phase 7 — Agentic Office extensions

**Deliverables:**

- `src/components/agentic-office/scene/` — new meshes for orchestrator supervisor, review booth, blocker cards.
- `src/components/agentic-office/event-translator.ts` — animation handlers for new event types.
- Whiteboard becomes blocker ledger; `BlockerCard` component.
- Worker idle pose, amber pulsing ring geometry.

**Testing:** Manual review of animation with a recorded epic event stream. No regression in current visualization.

**Rollback:** Feature flag on new primitives; legacy rendering continues for old events.

### Phase 8 — Legacy migration and cutover

**Deliverables:**

- Migration script: convert in-flight per-story jobs to epic-dev jobs (or drain them).
- Feature flag flip: `useEpicOrchestrator: true` for new epics.
- Monitoring: dashboard comparing wall-clock per epic pre/post.
- Documentation: update CLAUDE.md, Labs README, daemon README.

**Testing:** Stage-then-prod rollout. Monitor for 48h before removing the legacy path.

**Rollback:** Feature flag flip.

### Phase 9 — Post-launch observability and tuning

**Deliverables:**

- Review aggregation report: daily digest of rule firings, remediation rates, blocker taxonomy distribution.
- Override tracking: log force-approve actions with reason.
- Cost dashboard: per-epic token spend by tier.

**Purpose:** Feeds rubric evolution, complexity-tag accuracy, and model-tier rebalancing.

---

## 14. Project Overlay Rubric — Futurator-Admin Day-One Content

File: `.claude/review-rubric.md` (committed at repo root alongside `.claude/agents/`).

```markdown
# Futurator-Admin Review Rubric — Project Overlay

## R-ARCH-001 — DynamoDB Multi-Table Only

- **Default severity**: blocker
- **Applies when**: diff adds or modifies DynamoDB table definitions, repository files, or SST resource declarations
- **Check**: Every table must have a single data concern. Reject designs that shoehorn multiple entity types into one table with a composite key discriminator. Search the diff for PK patterns like `ENTITY#...` or single tables named generically.
- **Rationale**: CLAUDE.md — single-table design is forbidden.

## R-ARCH-002 — No Hono CORS Middleware

- **Default severity**: blocker
- **Applies when**: diff modifies `functions/api/index.ts` or imports from `hono/cors`
- **Check**: Reject `.use('/*', cors(...))` or equivalent. CORS lives at Lambda Function URL level in `sst.config.ts`.
- **Rationale**: Dual CORS produces preflight errors.

## R-ARCH-003 — Zustand for Client State, TanStack Query for Server State

- **Default severity**: major
- **Applies when**: diff adds client state management (new stores, contexts, reducers)
- **Check**: Reject new React Context for server state. Reject new custom data-fetching hooks that duplicate TanStack Query patterns; they should wrap `useQuery`/`useMutation` from `@/lib/api-client.ts`.

## R-ARCH-004 — Zod .safeParse at API Boundaries

- **Default severity**: major
- **Applies when**: diff adds or modifies API route handler in `functions/api/`
- **Check**: Every handler must validate input with a Zod schema from `functions/shared/schemas` using `.safeParse()`, not `.parse()`. Errors must use `ValidationError` from `functions/shared/errors.ts`.

## R-SAFE-001 — Never Sync admin out/ to futurator-ai-website

- **Default severity**: blocker
- **Applies when**: diff adds/modifies shell scripts, CI configuration, or SST deploy hooks
- **Check**: Reject any command matching `aws s3 sync out/ s3://futurator-ai-website`. Admin deploys via `sst deploy` to its SST-managed bucket.
- **Rationale**: 2026-04-15 incident. Only four scoped paths allowed in public bucket.

## R-SAFE-002 — No .env, credentials, or secrets in diff

- **Default severity**: blocker
- **Applies when**: always
- **Check**: Reject files matching `.env*`, `*credentials*`, `*secret*`, or inline `AWS_SECRET_ACCESS_KEY=`, `sk-*`, high-entropy Bearer tokens.

## R-SAFE-003 — No --no-verify, --no-gpg-sign, or skipped hooks

- **Default severity**: blocker
- **Applies when**: diff modifies git commands, pre-commit config, or shell scripts invoking git
- **Check**: Reject flags that bypass hooks or signing.

## R-CONV-001 — Use @/ Path Alias

- **Default severity**: minor
- **Applies when**: frontend imports in `/src/`
- **Check**: `import x from '../../../foo'` is a smell; prefer `@/foo`. Exception: sibling imports within same feature directory.

## R-TEST-001 — Vitest Test Per New Hook or Repository Function

- **Default severity**: major
- **Applies when**: diff adds a new file in `src/hooks/` or `functions/shared/repositories/`
- **Check**: A matching `*.test.ts` must exist and cover the primary happy path plus at least one error case.

## R-SEC-001 — Auth Middleware on Non-Public Routes

- **Default severity**: blocker
- **Applies when**: diff adds a new route in `functions/api/index.ts`
- **Check**: Public routes per CLAUDE.md: `/api/health`, `/api/auth/*`, `/api/public/*`. Any other route must be protected by JWT auth middleware from `functions/shared/auth-middleware.ts`.

## R-SEC-002 — Bearer Tokens, Never Cookies

- **Default severity**: blocker
- **Applies when**: diff modifies auth flow, `api-client.ts`, or `auth-store.ts`
- **Check**: Reject `document.cookie`, `Set-Cookie` headers, cookie-based session logic.
```

Rules evolve. When a new pattern emerges, add it. When a rule fires zero times in 50 epics, consider removing it. When it fires on every epic, the underlying pattern needs a lint or template, not more review pressure.

---

## 15. Open Questions and Follow-ups

Items not resolved in this design pass. Defer to implementation sessions or post-launch observation.

1. **Rubric evolution cadence.** Quarterly review? Ad-hoc? Who owns it? (Suggest: tech lead + analyst, reviewed at retrospective.)
2. **Override telemetry.** When an operator force-approves a story that the reviewer rejected, log it with rule ID and reason. Analysis feeds rubric calibration.
3. **Touch-point inference prompt iteration.** Initial prompt is a first draft. Expect to tune over first 10 epics. Keep a log of adjustments.
4. **EC2 parallelism re-validation.** Re-run the spike on the EC2 daemon host post-deploy. Compare against darwin numbers. Adjust `maxParallel` if needed.
5. **Blocker-code distribution analysis.** After ~20 epics, analyze which blocker codes fire most. Signals where upstream compile is weakest.
6. **Reviewer rubric emphasis for security stories.** Define explicit `rubricEmphasis` lists for categories — "auth change" stories promote all `R-SEC-*` to blocker regardless of default severity.
7. **Agentic Office capacity.** Current scene shows 10 desks. If `maxParallel: 8` + orchestrator + reviewer pairs exceeds 10 workers visible at once, design needs scaling (scroll / zoom / density).
8. **Operator UX for mid-epic pause.** Not in scope today. Consideration: should the orchestrator support a soft-pause signal between waves? Probably yes eventually; not blocking for v1.

---

## Appendix A — Orchestrator Prompt Template

Lives at `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl`. Rendered by the daemon per-job; `{{vars}}` substituted from the job payload.

````markdown
# Epic Orchestrator — {{epicId}}

You are the orchestrator for epic **{{epicId}}** in project **{{projectId}}**.

Your working directory is `{{projectRoot}}` — the cloned repo. You do not re-read the codebase broadly; you have a pre-digested context below. You dispatch parallel subagents via the `Task` tool, wave by wave, until all stories are APPROVED, BLOCKED, or terminally FAILED.

## Your identity

You are a conductor, not an implementer. You do not write code yourself. You do not Edit or Write files except for event-emission Bash and the final status write. All implementation happens in dev subagents; all review happens in senior-reviewer subagents.

## Pre-digested context

{{contextDigest}}

## Project review rubric

{{rubric}}

## Story manifest

| storyId | wave | complexity | reviewRigor | title | touchPoints |
| ------- | ---- | ---------- | ----------- | ----- | ----------- |

{{storyTableRows}}

Full story objects (JSON):

```json
{{storyManifestJson}}
```
````

## Subagent types available

- `dev-trivial` — Haiku. For `complexity: trivial`. No effort keyword.
- `dev-standard` — Sonnet. For `standard` (+ `think`) and `complex` (+ `think hard`).
- `dev-architectural` — Opus. For `architectural`. + `think harder`.
- `senior-reviewer` — Sonnet. Review-only; no Edit/Write tools. Effort by `reviewRigor`: light→none, standard→`think`, strict→`think harder`.

## Parallelism cap

Do not exceed {{maxParallel}} concurrent Task calls. If a (sub-)wave has more stories than the cap, process in batches sequentially within the wave.

## Control-flow contract

For each wave K in ascending order of `wave`:

### Step 1 — Pre-dispatch claim check

For every story in wave K, read `touchPoints`. If any two stories' globs overlap, split the wave into sub-waves so overlapping stories are serialized. Emit `wave_split` event. Otherwise proceed.

### Step 2 — Dispatch dev subagents (parallel)

Invoke `Task` in a single message with one call per story in this (sub-)wave, up to {{maxParallel}} in flight. Choose `subagent_type` by `complexity`. Include the effort keyword in the prompt per Section 5 table.

Subagent prompt template (appendix B).

Emit `subagent_dispatch` per story before the message.

### Step 3 — Collect dev results

For each returned Task:

- Parse `<DEV_RESULT>`.
- If `blockers` is non-empty, apply blocker handling logic (appendix C).
- Otherwise compare `filesTouched` against declared `touchPoints`. On overlap with sibling's declarations: emit `wave_collision`, `git checkout --` offending files, mark story for serialized re-dispatch.
- Emit `subagent_return`.

### Step 4 — Dispatch senior-reviewer subagents (parallel)

For every story whose dev returned without a hard blocker, invoke `Task` with `subagent_type: "senior-reviewer"` in a single message. Cap at {{maxParallel}} for reviewers (which may be lower — see daemon policy).

Reviewer prompt template (appendix B). Include effort keyword per `reviewRigor`.

Compute `diff` via: `Bash git diff HEAD -- <filesTouched>` per story.

Emit `subagent_dispatch` per reviewer call.

### Step 5 — Collect verdicts

Parse each `<VERDICT>`. Emit `review_verdict` per story. Then:

- APPROVE → story done for wave.
- REQUEST_CHANGES, attempt < {{maxRemediationRounds}} → emit `remediation_start`, go to Step 6 for this story.
- REQUEST_CHANGES, attempt == {{maxRemediationRounds}} → emit `story_failed_terminally`; do not block the wave; proceed.
- Malformed verdict → re-dispatch reviewer once. Still malformed → FAILED with `reviewer_protocol_violation`.

### Step 6 — Remediation round

Dispatch dev subagent with remediation-framed prompt (appendix B: remediation template). Go back to Step 3 for this story.

### Step 7 — Persist wave progress

After wave K completes, invoke:

```
Bash: /opt/futurator/emit-event.sh '{"eventType":"wave_complete", ...}'
Bash: curl -s -X POST http://localhost:{{daemonPort}}/wave-complete \
        -H 'Content-Type: application/json' \
        -d '{"jobId":"{{jobId}}","wave":K,"results":{...}}'
```

Proceed to wave K+1.

## Blocker handling

Per Section 7 of the architecture doc. Auto-recover `insufficient-touch-points`, `context-gap`, `environment`. Escalate others with `story_blocked` event.

## Resume on crash

If `{{resumeFromWaveResults}}` is populated:

- For each wave K in the map with all stories APPROVED/FAILED: skip.
- Start fresh at the first wave not in the map.
- Do NOT re-dispatch already-APPROVED stories under any circumstance.

## Event emission

After every dispatch, every return, every verdict, every decision:

```
Bash: /opt/futurator/emit-event.sh '<event JSON>'
```

Event shape per Section 9.

At epic start: emit `epic_start`. At every wave start: `wave_start`. At completion: `epic_complete` with summary.

## Completion

When all waves are processed:

1. Emit `epic_complete`.
2. Write final summary between `<EPIC_COMPLETE>` and `</EPIC_COMPLETE>` tags:

```json
{
  "status": "COMPLETE" | "COMPLETE_WITH_BLOCKED_STORIES" | "FAILED",
  "storyResults": [...],
  "totalWaves": K,
  "totalRemediations": N
}
```

3. Exit.

## Things you do NOT do

- Write code yourself.
- Broadly explore the repo — context digest is sufficient.
- Modify the rubric or acceptance criteria.
- Allow a reviewer to also edit — `senior-reviewer` spec enforces this; do not work around it.
- Continue past {{maxRemediationRounds}} for a failing story — admit defeat and proceed.

```

---

## Appendix B — Subagent Prompt Templates

### Dev subagent prompt

```

Story: {storyId} — {title}
Acceptance criteria:
{bulletedList}

Touch points (edit only these):
{globs}

Sibling stories in this wave are editing the following paths — do NOT touch:
{siblingGlobs}

Context (pre-digested):
{contextDigest}

Rubric highlights relevant to this story:
{rubricExcerpt}

Effort: {effortKeyword}

Implement this story per your spec. Remember: declare blockers BEFORE editing, not after.

Return <DEV_RESULT> block when done.

```

### Reviewer subagent prompt

```

Story: {storyId} — {title}
Acceptance criteria:
{bulletedList}

Touch points declared:
{globs}

Diff:
{gitDiffOutput}

Rubric:
{fullRubric}

Prior findings (present only on attempt > 1):
{priorFindings}

Effort: {effortKeyword}

Review per your spec. Return <VERDICT> block.

```

### Remediation prompt

```

Remediation round {attemptN} for story {storyId}.

Your previous attempt produced this diff:
{lastDiff}

The senior reviewer returned these findings:
{findingsJson}

Address each finding. Do not rewrite the story; fix only these findings.

Touch points: {globs} (same as before)
Sibling stories editing: {siblingGlobs}

Effort: {effortKeyword}

Return <DEV_RESULT> block when done.

```

---

## Appendix C — Blocker Handling Decision Matrix

Orchestrator logic per blocker code (from Section 7). Pseudo-code for the orchestrator to follow mechanically:

```

function handleBlocker(story, blocker):
if blocker.severity != "hard":
log soft blocker in wave report; proceed to reviewer
return continue

switch blocker.code:

    case "insufficient-touch-points":
      if story.touchPointExpansionAttempts >= 1:
        return escalate(story, blocker, reason="repeated expansion")
      expanded = story.touchPoints ∪ blocker.requestedTouchPointExpansion
      if overlapsSiblingTouchPoints(expanded, currentWave):
        return serialize(story, nextMicroWave)
      emit touch_points_expanded
      story.touchPoints = expanded
      story.touchPointExpansionAttempts += 1
      return reDispatchDev(story)

    case "context-gap":
      if story.contextExpansionAttempts >= 1:
        return escalate(story, blocker, reason="repeated gap")
      emit context_expanded
      additionalContext = orchestrator.mineContextFor(blocker.affectedPath)
      story.prompt += additionalContext
      story.contextExpansionAttempts += 1
      return reDispatchDev(story)

    case "environment":
      if story.environmentRetryAttempts >= 1:
        return escalate(story, blocker, reason="persistent env failure")
      sleep 10s
      story.environmentRetryAttempts += 1
      return reDispatchDev(story)

    case "ambiguous-ac":
    case "missing-dependency":
    case "architectural-conflict":
      return escalate(story, blocker)

function escalate(story, blocker, reason=null):
story.status = "BLOCKED"
story.blocker = blocker
emit story_blocked with humanActionRequired=true
// do NOT dispatch reviewer
// continue wave for other stories
return done

function serialize(story, nextMicroWave):
insert story into nextMicroWave
emit wave_split (if not already)
return done

````

---

## Appendix D — Spike Artifacts (reference)

The spike was executed directly from this session's Claude Code environment using the `Agent` tool with `model: haiku` override. For reproduction on EC2, the spike can be re-run as a standalone script:

```bash
# File: daemon/scripts/parallel-task-spike.sh
# Usage: bash parallel-task-spike.sh
# Requires: claude CLI installed, authenticated

# See Section 12 for expected output ranges.
# Run at off-peak hours for clean baseline measurements.
````

Spike prompt template and sleeper subagent spec are omitted here (they were throwaway). Re-derive from Section 12 methodology if needed.

---

## Revision log

| Date       | Change                                                                                                     | Author         |
| ---------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| 2026-04-17 | Initial architecture document created from design sessions (party-mode rounds 1–4) and validated via spike | Design session |
