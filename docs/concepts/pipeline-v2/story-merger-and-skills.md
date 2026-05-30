# Story E — Autonomous Tiered Merger + Story F — Skills Subsystem Repair

> **Status:** Spec, ready for implementation. Drafted 2026-05-30 after the
> `plan_dino1_mpr6f5jm` run, which exercised the freshly-deployed A/B/C/D stack
> on real infra and surfaced both opportunities below.
> **Companion to:** `agentic-integration-branching.md`, `worktree-rollout-design.md`
> (§2 operator-resolve-only), `integration-followups-bcd.md` (Stories A–D).
> **Evidence base:** dino1 forensic + live `futurator-wave-conflicts` /
> `futurator-attention-items` queries (2026-05-29) + a verified two-repo
> `.gitignore` reproduction (2026-05-30).

---

## 0. What dino1 proved (why these two stories exist)

dino1 ran on the post-deploy daemon and **validated A/B/C end-to-end**: E2 and E3
each hit a _real_ merge conflict, **halted independently** (B's candidate
isolation — no cross-contamination, no pacman-2 wedge), did **not** silently
auto-merge (A), raised operator attention items, and **C recorded durable
conflict rows with the exact files** (`futurator-wave-conflicts`). The plan is
_recoverable-awaiting-operator_, not corrupted.

It also surfaced two things:

1. **The conflicts are exactly the "small, expected, mostly-trivial" kind.** E2
   conflicted on `CLAUDE.md`; E3 on `CLAUDE.md` + `src/app/page.tsx`. Both are
   structural, not semantic:
   - **`CLAUDE.md`** — every story appends a decision note (the
     `claude-md-append-decision` skill). N parallel stories appending to one
     file → trivially-resolvable additive conflict. (Operator intent: this is
     _fine_; future per-story/wave "thoughts" docs make it additive-by-design.)
   - **`src/app/page.tsx`** — the app's single home/mount point. Every feature
     story wires its component in there. This is the hot wiring file Story D
     targets; it conflicted because the agents hand-edited it instead of using
     the feature registry (D is guidance, not enforced).
2. **Skills had zero runtime effect** — a separate forensic traced it to a
   `.gitignore` defect (Story F). Verified below.

Operator decision (2026-05-30): hitting a small % of same-file work is **normal
and expected**; we want an **opt-in autonomous merger** that decides/commits the
resolution itself, investigating like a real agent on the hard cases — riding
the B harness so a wrong "yolo" decision can never corrupt the trunk.

---

# Story E — Autonomous Tiered Merger (toggleable)

## E.1 Framing — this is the Phase-2 MERGER agent, now de-risked

`worktree-rollout-design.md §2` always anticipated a "Phase-2 MERGER agent …
once we have data on how common conflicts are." We now have that data (Story C),
and it says conflicts are rare and mostly trivial. So the timing is right.

We did **not** revert the 2026-05-28 auto-resolver because auto-merge is bad. We
reverted it because _that_ implementation had three specific sins
(`integration-branching` follow-ups F2/F3): it was **non-deterministic**,
validated by a **compile-only gate**, and landed **silently** with no audit
trail, **merging in-place on the shared branch**. Story E is safe precisely
because Story B changed the substrate: **merges happen in a throwaway candidate
worktree and the trunk only advances to a gate-green commit.** That makes "yolo"
boundable — a bad decision fails the gate and is rejected; it can never reach
green.

## E.2 The tiered design (cheap → smart; LLM only as last resort)

> **Principle:** don't spend an agent on a conflict that arithmetic or git can
> resolve. The merger is a _ladder_; most conflicts never reach the top.

- **Tier 0 — Prevent (free, deterministic, ships first).**
  - `CLAUDE.md merge=union` (and any append-only log) in the scaffold
    `.gitattributes`. git concatenates both sides → the dino1 `CLAUDE.md`
    conflicts vanish with zero agent calls. This is the deferred B-item-4, now
    justified by data.
  - Feature registry for `src/app/page.tsx` (Story D) — features register
    themselves; the hot file is generated, never hand-edited. Needs D adoption
    (agent instructions / enforcement), tracked in `integration-followups-bcd.md`.
- **Tier 1 — git auto-merge (free).** Non-overlapping hunks already merge
  cleanly under `--no-ff`. No change needed; this is the baseline.
- **Tier 2 — Agentic merger (this story; toggled; the "yolo" layer).** Fires
  **only** on a real, overlapping conflict that survives Tiers 0–1. Investigates
  and decides, in the candidate worktree, gated and audited (E.3).

After Tier 0 lands, the expectation (per the dino1 file mix) is that Tier 2
fires on a _small_ residual — genuine semantic overlaps — which is exactly where
an investigating agent earns its keep.

## E.3 Tier-2 contract (the hard requirements)

When a `git merge wip/<story>` conflicts inside the candidate worktree and the
merger toggle is ON, instead of halting (the Story A default):

1. **Resolve in the candidate, never in-place.** The agent edits only the
   conflicted files in `_cand/<jobId>` (B's ephemeral worktree). `plan/<slug>`
   is untouched until the gate passes — unchanged from B.
2. **Investigate like a real agent.** Provide it: the base + both sides of each
   conflicted hunk, the conflicting stories' intent (`.context/wave-*-story-*.md`),
   and the captured pre-merge blobs (Story C already snapshots these). For
   "combine both" cases (mount files, append logs) it integrates both sides; for
   genuine disagreements it reasons about which wins and why.
3. **Pinned + reproducible-enough.** Pin the model (`WAVE_MERGE_RESOLVER_MODEL`,
   explicit version) and temperature 0. Determinism matters less than before
   because the decision is _recorded and revertible_ (4), but pinning removes
   needless variance.
4. **Audit trail (non-negotiable — fixes F3).** Commit with an explicit trailer
   `[auto-resolved: <files>]` (never `--no-edit`), capture the agent's reasoning,
   and write a Story-C conflict row with `mode: 'auto-resolved'` + the resolution
   diff. Every machine merge decision is inspectable in `git log` and queryable
   via `GET /api/plans/:id/conflicts`.
5. **The gate is the judge — and mind its strength.** The candidate must pass
   `postMergeValidationCmd` before the trunk advances. For Tier-0/1-class
   conflicts (append/mount) compile-pass is sufficient. For _semantic_ conflicts,
   compile-pass ≠ correct — so for those, gate additionally on **(a)** the
   project's real tests if present, and/or **(b)** a fast reviewer-agent
   sanity pass ("does this resolution preserve both stories' intent?"). Make the
   reviewer-pass a sub-toggle.
6. **Fail safe → halt.** On low confidence, gate failure, marker-remaining, or
   agent error → fall back to the Story A halt + operator attention item +
   `mode: 'halted'` row. Never worse than today.

## E.4 The toggle

- **Global flag** `agent.autoMerge` (DDB `futurator-agent-flags`, same substrate
  as `agent.paused`), default **OFF**. Read by the daemon pre-merge.
- **Per-plan override** on the Plan row (`autoMergeMode: 'off' | 'trivial' |
'full'`): `trivial` = Tier-2 only for additive/combine cases (refuse semantic
  disagreements → halt); `full` = yolo on everything, gated. Lets the operator
  dial autonomy per plan risk.
- Surfaced in the plan-dashboard header next to Pause, with the live
  auto-resolved-vs-halted counts from Story C as the trust signal.

## E.5 Where it plugs in

The Story A revert left a clean seam: `runWaveMerge`'s conflict branch currently
captures blobs + records the event + halts. Tier 2 inserts **before** the halt,
behind the toggle — re-introducing a `resolveConflict`-shaped hook, but now
(unlike 3fa8713) inside the candidate worktree, gated by advance-on-green,
audited via C, and off by default. The daemon wires the real agent; tests inject
a deterministic fake.

## E.6 Acceptance criteria

- Toggle OFF → behavior identical to Story A (halt + attention + `mode:halted`).
- Toggle ON, additive conflict (e.g. two `CLAUDE.md` appends with `merge=union`
  _removed_ to force the path) → agent combines both, gate green, trunk advances,
  commit carries `[auto-resolved:…]`, C row `mode:auto-resolved` with the diff.
- Toggle ON, a resolution that compiles but a reviewer-pass/test rejects → halt
  - attention (gate did its job; nothing bad landed on green).
- Replaying dino1's two conflicts with Tier 0 (`CLAUDE.md merge=union`) → the
  `CLAUDE.md` conflicts never reach Tier 2 at all (resolved for free).
- A bad/yolo resolution that fails `next build` → rejected, `plan/<slug>`
  unchanged (B invariant holds under E).

## E.7 Sequencing & risk

1. **Tier 0 first** (`CLAUDE.md merge=union` + drive D adoption) — quick, deterministic,
   immediately unblocks the dino1-class conflicts. Low risk.
2. **Tier 2** behind the default-OFF toggle, riding B's harness + C's audit.
3. Strengthen the gate (real tests / reviewer-pass) before defaulting `full` on.

Risk is bounded by construction: candidate isolation + advance-on-green (B) means
the worst case of a wrong decision is a rejected candidate, not a corrupted
trunk; C makes every decision auditable; the toggle keeps the operator in
control of how much autonomy to grant.

---

# Story F — Skills Subsystem Repair (verified root cause)

> Surfaced by a parallel forensic of dino1; **root cause independently verified
> here** (two-repo `git check-ignore` reproduction, 2026-05-30).

## F.1 The bug — skills never reach worktrees (zero runtime effect)

dino1's intent maps to `nextjs-canvas-game`, which declares a skill loadout, yet
the forensic shows `skills: null`, zero `skill_activated` events, and not one
`Skill` tool-use across 229 tool_use events. Root cause chain:

1. Bootstrap pins the loadout and vendors each skill body into
   `.claude/skills/<name>/SKILL.md` **before** commit-and-push. ✓
2. The committed `.claude/skills/.gitignore` (`registry.ts:662-668`) is:
   ```
   *
   !.gitignore
   !*/SKILL.md
   !*/meta.json
   ```
   The leading `*` ignores the subdirectories. **git never descends into an
   ignored directory, so `!*/SKILL.md` is dead** — it can't re-include a file
   whose parent dir is excluded.
3. **Verified:** with this pattern, `git add -A` stages **only** `.gitignore`;
   `SKILL.md`/`meta.json` are NOT committed. `git check-ignore` confirms
   `canvas-design/SKILL.md` is ignored by `*`.
4. Per-story worktrees are created from committed content only
   (`git worktree add -B … <parentRef>`, `story-worktree.mjs:142`). No skill
   bodies are present.
5. → Every dev/test/reviewer worktree has no `.claude/skills/` → Claude Code
   discovers zero skills → zero activation → `skills: null`. Matches the
   forensic exactly.

## F.2 The fix (one line) — re-include directories first

In `SKILLS_DIR_GITIGNORE` (`registry.ts`), insert `!*/`:

```
*
!*/
!.gitignore
!*/SKILL.md
!*/meta.json
```

**Verified:** this stages `.gitignore` + `SKILL.md` + `meta.json`, while the
heavy bodies (`examples/`, `templates/`, …) stay correctly ignored (proven:
`canvas-design/examples/foo.png` remains excluded). Bodies stay vendored-on-demand
as designed.

⚠️ This repairs **future** bootstraps only. dino1 (and any already-bootstrapped
project) has the broken `.gitignore` committed + uncommitted `SKILL.md` files on
EC2 disk → needs the one-time remediation in F.4.

## F.3 Why it shipped undetected — the test-fidelity gap

The 2026-05-19 probe validated the CLI's auto-activation in
`/tmp/skills-probe-clean` with a hand-placed `SKILL.md` and no `--allowedTools`.
It proved the mechanism in isolation and assumed production parity — it never
exercised the real path: **vendored → committed → worktree-checked-out →
spawned-with-allowlist.** The defect lives in that gap. (Note: `Skill` is
read-only and `--allowedTools` doesn't gate it, so the role-policy is not the
blocker — the files simply aren't present to discover. The `.gitignore` fix is
sufficient on its own.)

## F.4 Scope

1. **Fix** `SKILLS_DIR_GITIGNORE` (add `!*/`).
2. **Parity test** — the regression guard for F.3: a test that runs the real
   path (write the augment `.gitignore` + a fixture `SKILL.md`/`meta.json` +
   `examples/body`, `git add -A`, assert `SKILL.md` + `meta.json` are staged and
   the body is NOT). This is the test that would have caught it.
3. **Observability (high value)** — the daemon's stream-json dispatch
   (`agent-daemon.mjs:1157`) handles only `stream_event`/`assistant`/`tool_result`
   and **discards the CLI `system`/`init` event**, which carries `skills[]` and
   `tools[]`. Capture it as a `skills_available` forensic event so "init.skills
   = []" is a one-glance diagnosis instead of a multi-hour trace.
4. **Bootstrap post-commit assertion** — after commit-and-push, assert each
   manifest-pinned skill has a **git-tracked** `SKILL.md`; fail the bootstrap
   otherwise. A green `vendor-skills` step currently coexists with zero committed
   skills; this self-check catches it at the source.
5. **SKILL-SCOUT T2 verification** — confirm the `kind:initial` plan path
   (`POST /api/apps/:appId/plans`) actually enqueued + completed the scout job
   (dino1 shows `pendingSkillScoutJobId: null` + no in-plan scout slices; events
   were omitted from the export, so confirm with `?include=events` + the
   app-bootstrap job forensic showing `vendoredCount`).
6. **Remediation for already-bootstrapped projects** — one-time: re-commit the
   fixed `.gitignore` + the on-disk `SKILL.md`/`meta.json` for existing project
   repos (incl. dino1) so their worktrees pick up skills without a full
   re-bootstrap.

## F.5 Acceptance criteria

- After fix, a fresh bootstrap commits `<skill>/SKILL.md` + `meta.json` (tracked),
  excludes bodies; a spawned worktree contains `.claude/skills/<name>/SKILL.md`.
- A new run shows non-null `skills` + ≥1 `skill_activated` (or the captured
  `skills_available` event lists the loadout) for a canvas-game app.
- The parity test fails on the old `*`-only pattern and passes on the fixed one.
- The bootstrap assertion fails fast if a pinned skill isn't committed.

---

## Combined sequencing

| Order | Work                                                             | Why first                                                       | Deploy                            |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| 1     | **F.2 skills `.gitignore` fix + F.4 parity test**                | One-line, unblocks all skill activation; pure scaffold/registry | `sst deploy` (API ships augments) |
| 2     | **E Tier 0** — `CLAUDE.md merge=union`                           | Kills the dominant dino1 conflict for free                      | `sst deploy`                      |
| 3     | **F.3 obs + F.4 bootstrap assertion**                            | Make future regressions one-glance                              | daemon rsync + `sst deploy`       |
| 4     | **F.4 remediation** for dino1 + existing repos                   | One-time recommit on EC2                                        | daemon-side script                |
| 5     | **E Tier 2** — agentic merger behind default-OFF toggle          | The autonomy goal; rides B + C                                  | daemon rsync + `sst deploy`       |
| 6     | Gate-strengthening (tests / reviewer-pass) before `full` default | Trust before unleashing yolo                                    | —                                 |
