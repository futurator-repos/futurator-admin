---
name: workflow-authoring
description: >
  MANDATORY reading before writing, adapting, or relaunching any dynamic workflow
  script in this repository. Defines the non-negotiable invariants every workflow
  must encode, the freedoms the author retains, and the structural conventions the
  pre-launch linter verifies. Triggers: any request containing "workflow",
  "ultracode", or any adaptation of a script in .claude/workflows/.
---

# Workflow Authoring Policy — Futurator Pipeline v2.5

You are writing an orchestration script that will run unattended, in headless mode,
against real repositories. Creativity is welcome in the proposal space; the gates
below are not negotiable and are verified by a deterministic linter before launch.
A script that violates them will not run, so encoding them correctly is faster
than omitting them.

## Versioning marker (required)

The first lines of every workflow script MUST contain this header comment, which
the linter uses to confirm this policy was applied:

```js
// @workflow-invariants: v1
// @plan: <planId or short description>
```

## Invariants (MUST — linter-enforced)

**I1 — Every story chain terminates in verification.**
No story is reported complete without at least one verification phase. Verification
roles the linter recognizes: `test-author`, `qa`, `property-tests`, `compile-gate`.
Tests are authored before or alongside implementation (contract-first), never
skipped because a story "looks trivial". A types-only story still requires a
`compile-gate`.

**I2 — Visual work gets visual QA.**
If any story's touch-points include UI or rendering surfaces (`.tsx`, `.jsx`,
`.css`, `components/`, `canvas`, `render`, `sprite`, shaders, anything the user
will see), the chain for that story MUST include a `vqa` role with screenshot
tooling. `tsc` cannot see a horse.

**I3 — Nothing merges without an adversary.**
Every call to `merge(...)` must be preceded in the script by a `refuter` phase
that actively attempted to break the candidate. Auto-resolutions of conflicts are
treated as candidates like any other: refuted or escalated, never landed silently.

**I4 — Evidence is preserved, never destroyed.**
Pre-failure and pre-resolution state (failing logs, conflict markers, baselines)
is committed or copied aside BEFORE any fix or resolution attempt mutates the
worktree. A refuter without evidence is theater.

**I5 — Fixes happen in scratch worktrees.**
`fixer` roles operate in throwaway worktrees (`scratchWorktree(...)`), never
directly on a story branch or trunk. Trunk only ever receives refuter-survived,
gate-passed merges.

**I6 — Fix loops are capped with an escalation ladder.**
Any retry/fix loop declares a numeric cap (`maxRounds`, default 2). On exhaustion
the script calls `escalate(...)`: round 2 may raise the model tier; final
exhaustion routes to the operator with the preserved evidence attached. Unbounded
loops are forbidden.

**I7 — Model floors.**
`refuter`, `compile-gate`, and any merge-deciding role run at `sonnet` tier or
above. `haiku` is permitted (encouraged) for classification, inventory scans, and
types-only dev work — never for adversarial or gate roles.

**I8 — Durable checkpoints.**
Each completed story commits its work and writes a status checkpoint
(`checkpoint(...)` or a git commit) so a killed session loses orchestration
position, not work product. Assume the EC2 instance can die at any minute.

**I9 — Forbidden operations.**
Never: `git push --force` (use `--force-with-lease` only where the design doc
permits), `--no-verify`, `rm -rf` on repository roots, direct pushes to trunk,
disabling hooks, or deleting `.pipeline/` evidence directories.

## Freedoms (MAY — your design space)

- Story classification and per-class chain composition (beyond the invariants).
- Readiness-tier gating (`contract-stable` / `tests-passing` / `fully-done`) and
  speculative starts of dependents.
- Degree of parallelism, wave shapes, and batching of compile gates per merge
  group (the final gate per group remains mandatory per I1).
- Hypothesis generation and fan-out width for fix swarms.
- Model routing within the floors of I7.
- Any additional phases: profiling, doc generation, Mycelium harvest/prime.

## Structural conventions (so the linter can see your intent)

- Declare agent roles as string literals: `{ role: 'refuter', ... }`. Do not
  compute role names dynamically.
- Declare chains as data (arrays/objects of phase descriptors), not as opaque
  inline prompt strings.
- Use the helper names the linter recognizes: `merge(...)`, `escalate(...)`,
  `scratchWorktree(...)`, `checkpoint(...)`.
- Pass the plan (stories, touch-points, classes) via `args`; do not hardcode
  story IDs when an `args` field exists for them.

## Output contract

The workflow's final value reports: stories completed/failed, merges landed,
refuter verdicts, escalations raised, and per-phase token/cost telemetry if
available. This output feeds REFLECTOR; vague summaries starve the learning loop.
