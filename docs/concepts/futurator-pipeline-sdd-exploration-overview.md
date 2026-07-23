# Futurator Pipeline — SDD Exploration Overview (capstone)

> The full picture from this exploration session: how three donor repos (**jcode**, **ponytail**, **ecc**)
> and the **Mycelium SDD** model combine into Futurator's next-generation, spec-driven dev pipeline.
> Synthesizes four concept docs + two built spikes. Date: 2026-06-29.
>
> **Source docs:** `jcode-pipeline-analysis.md` · `ecc-pipeline-analysis.md` ·
> Mycelium `futurator-sdd-jcode-analisis-1.md` · `futurator-ponytail-analysis-1.md`.
> **Built this session:** `spikes/pretool-gate/` (keystone gate, 8 tests green) ·
> `spikes/ponytail/` (AC-aware laziness, green).

---

## 0. The one-sentence thesis

Futurator already has the right _substrate_ (deterministic gates, DynamoDB source-of-truth, a working
Max-subscription daemon); the three repos donate the **~10 specific mechanisms** that turn that substrate
into an SDD-native pipeline whose work unit is a **graph-resident story with test-bound acceptance
criteria**, scheduled by a **computed ready-frontier**, and governed by a **single live pre-tool gate** —
the one change all four analyses independently converged on.

---

## 1. What we explored, and the unanimous verdict

| Repo         | What it is                                                                                                        | Verdict                                 | The 1–2 things worth taking                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **jcode**    | MIT Rust coding-agent harness (single-server/many-client; hooks, swarm, compaction, multi-provider, memory graph) | **pattern donor, not dependency**       | the `PreToolUse` gate model (exit 0/2/fail-open); compaction; local ONNX embeddings            |
| **ponytail** | Portable "write-less-code" skill (laziness ladder) for 16 agents                                                  | **fork the prompt + injection pattern** | AC-aware laziness ladder; single-source→multi-adapter injection; `ponytail:` debt ledger       |
| **ecc**      | Universal agentic framework (Rust control plane + epic orchestration + instinct learning + 271 skills)            | **pattern donor, not dependency**       | risk-score + fact-force gate; worktree dep-cache; unblock-sweep; instinct loop; adapter parity |

**Why "donor, never dependency" every time:** all three are foreign runtimes (Rust / JS+Python+Rust),
Claude-ecosystem-centric, and ship their own telemetry/external services — unacceptable integration and
audit cost for an internal single-operator factory on Max. Futurator _already equals or beats_ them on
several axes (§6). We are behind only on a short list of specific levers (§4–§5).

---

## 2. The target: Futurator's new SDD-driven pipeline

The shift is from **`epic → wave → story → AC`** (front-loaded decomposition, synchronized waves, cold
spawns, post-hoc gates) to a **spec-driven graph** pipeline:

```
  CONCEPT ───────► SPEC ───────► SCHEDULE ──────► DEV ──────► INTEGRATE ─────► VERIFY ─────► LEARN
  idea→plan_spec   plan_spec      ready-frontier   per-story    merge-queue       delivery      instinct
  + validator      ⇒ spec_shard   (depends_on)     worktree     (merge-tree       journeys      capture ⇒
  + council        + stories w/    + touches-       + laziness   conflict pred.)   + bound-AC    evolve ⇒
                   bound AC        isolation        + LIVE gate  + atomic claim    tests=done    Mycelium
```

Every arrow is governed by **graph edges that both schedule and gate the work** — the structural upgrade.

---

## 3. The unit of work (the SDD task model — from Mycelium)

The artifact that crosses concept→dev is the **`plan_spec`** (PRD delta + requirements + executable AC +
architecture + ADRs + epics/stories), which applies as a **typed delta** into durable **`spec_shard`**
nodes (two-layer fan-in). The dev spawn unit is a **`story`** carrying structured AC:

```ts
interface AcceptanceCriterion {
  id: string; // stable opaque id
  form: 'GIVEN_WHEN_THEN' | 'EARS';
  given?: string;
  when: string;
  then: string;
  normative: 'SHALL' | 'MUST'; // enforced deterministically
  validatesUjId?: string; // provenance to a user journey
  testBinding: { status: 'unbound' | 'bound' | 'passing' | 'failing'; testRef?: string };
}
```

**Three edges carry the whole pipeline** — and the same edges that _schedule_ the work also _gate_ it:

| Edge                 | Semantics               | Schedules                                       | Gates                                 |
| -------------------- | ----------------------- | ----------------------------------------------- | ------------------------------------- |
| `depends_on`         | hard ordering           | the **ready-frontier** (dispatch when all done) | dispatch gate                         |
| `touches`            | advisory blast-radius   | **worktree isolation** grouping                 | pre-tool scope                        |
| `testBinding.status` | spec==code drift signal | —                                               | **completion** (all `passing` = done) |

**MVP boundary (your "ship MVP" rule):** the minimum unit that beats today is `story` + test-bound AC +
`depends_on` + `touches`. Defer the full 12-edge governance registry, the `concerns` debate, and the
conflict/supersede policy until the core scheduler+gate loop is proven on one real epic.

---

## 4. The control spine — the convergence

The single most important finding: **four independent analyses point at one keystone.**

| Cross-cutting theme                 | jcode                   | SDD/Mycelium            | ponytail                  | ecc                                        |
| ----------------------------------- | ----------------------- | ----------------------- | ------------------------- | ------------------------------------------ |
| **Live pre-tool gate is move #1**   | hook exit 0/2 fail-open | touches-edge scope      | injection seam            | **+ composite risk score + fact-force**    |
| Kill barriers → continuous dispatch | session reuse           | ready-frontier          | —                         | **+ dependency unblock-sweep**             |
| Hard cost control                   | compaction              | —                       | less code = less cost     | **+ immutable tracker + bridge + routing** |
| Close the learning loop             | memory graph            | spec drift signals      | debt ledger               | **+ instinct capture + evolve/promote**    |
| Provider-agnostic                   | provider trait          | harness-portable policy | one-builder-many-adapters | **+ adapter registry + parity audit**      |
| Worktree isolation                  | —                       | touches-driven          | —                         | **+ lock-SHA dep-cache symlinks**          |

**The keystone is built.** `spikes/pretool-gate/pretool-gate.mjs` already fuses:

- **ecc composite risk score** (base + file-sensitivity + blast-radius + irreversibility → allow/review/confirm/block),
- **ecc GateGuard fact-force** (confirm-tier blocks once demanding callers/rollback/why-minimal, retry clears),
- **jcode/SDD scope gate** (reuses the daemon's own `detectScopeViolations` so pre-write == post-hoc audit),
- **fail-open + `off`/`audit`/`enforce` modes** for safe rollout.

This converts the entire gating story from _bypassPermissions + post-hoc diff audit_ to _live in-turn
interception_ — without constraining agent reasoning, only artifacts/boundaries.

---

## 5. Full capability map — every borrowed idea, ordered by impact

| #   | Idea (donor)                                                                         | Futurator pain it kills                            | SDD role                                            | Effort | Impact | Status               |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------- | ------ | ------ | -------------------- |
| 1   | **Live pre-tool gate: risk-score + fact-force + scope** (ecc, jcode)                 | bypassPermissions; post-hoc-only gating            | the gate driven by `touches`/`forbiddenAreas`       | M      | **Hi** | ✅ spike built+green |
| 2   | **Hard cost ceiling: immutable tracker + harness-cost bridge + model routing** (ecc) | soft ceiling under-reports ~10×; Opus-for-all      | per-tier model + budget per story                   | S–M    | **Hi** | next                 |
| 3   | **Ready-frontier dispatch / unblock-sweep** (ecc, SDD)                               | 2–5 min inter-wave dead time                       | `depends_on` Kahn frontier replaces waves           | M      | **Hi** | designed             |
| 4   | **Worktree isolation + lock-SHA dep-cache symlinks** (ecc2)                          | compile thrash 47%; host saturation; index.md race | `touches`-driven isolation grouping                 | L      | **Hi** | designed             |
| 5   | **Bound-AC = deterministic completion gate** (SDD)                                   | reviewer inconsistency (triple-fails)              | `testBinding.status` all passing = done             | M      | **Hi** | designed             |
| 6   | **Instinct loop → close the reflector** (ecc)                                        | reflector IAM-blocked, never applied/replayed      | instincts as Mycelium nodes; evolve/promote         | M      | **Hi** | designed             |
| 7   | **AC-aware laziness injection** (ponytail)                                           | over-build inflates tokens/cost/compile            | "min code to pass bound AC" at dev spawn            | S      | Med-Hi | ✅ spike built+green |
| 8   | **Session reuse / compaction** (jcode)                                               | 30s + 27k cache tokens × 3 stages × N              | one session dev→review→compile, shared KV           | L      | Med-Hi | designed             |
| 9   | **GAN adversarial loop** (ecc)                                                       | mediocre code reaches review                       | planner→generator→evaluator, score-gated pre-review | L      | Med    | inspiration          |
| 10  | **Multi-harness adapter registry + parity audit** (ecc)                              | provider-agnostic / OpenCode migration             | one canonical policy → per-harness adapters         | M      | Med-Hi | blueprint            |
| 11  | **Context-budget audit + content-hash cache** (ecc)                                  | context bloat; repeated-read tax                   | top-k spec/diff context; cache by content           | S–M    | Med    | designed             |
| 12  | **Local ONNX embeddings** (jcode)                                                    | full-file re-reads                                 | top-k relevant spec/code injection                  | M      | Med    | designed             |
| 13  | **Meta-agents: agent-evaluator, loop-operator, council, harness-optimizer** (ecc)    | subjective review; runaway loops; ambiguous calls  | scorecards, circuit-breakers, deliberation          | S–M    | Med    | inspiration          |
| 14  | **Supply-chain IOC scan + observability rubric** (ecc)                               | supply-chain risk; release gating                  | pre-release CI gate                                 | S      | Med    | use                  |

---

## 6. Where Futurator already wins — keep these, don't regress

1. **DynamoDB strongly-consistent source of truth + atomic conditional-write claims** — ecc's claim is
   _documented non-atomic_ (GitHub-issue-body coordination). You have the lock primitive it lacks.
2. **Deterministic, automated pipeline** with non-negotiable compile/QA gates vs ecc's manual checklist +
   human-invoked reviewers. Determinism is the differentiator — protect it.
3. **Mycelium spec-graph + test-bound AC** is more principled than ecc's flat YAML instincts (borrow ecc's
   _confidence scoring_, keep the typed graph).
4. **True provider-agnostic ambition** (Claude Max now, OpenCode later) is broader than ecc's Claude-only
   multi-_harness_.
5. **Real cost infrastructure deployed** (aggregator, UI) — only the _enforcement_ is soft (fixed by #2).
6. **Storage-layer multi-tenancy** (per-project tables, IAM scoping) vs ecc's project-hash dirs.
7. **Persistent daemon + process-group lifecycle** (`child-tracker`) vs stateless per-session hooks.

**What to ignore from the donors:** their runtimes wholesale; ecc's 271 skills/67 agents (mostly
domain cruft); ecc's external telemetry/scan services; the control-pane dashboard / full GAN harness /
12-harness matrix (inspiration only).

---

## 7. The new pipeline, stage by stage (where each idea plugs in)

- **CONCEPT / Solutioning** — idea → `plan_spec` with **executable AC**; an **openspec-style deterministic
  validator** (structural + normativity + ≥1 scenario + conflict detection as runnable code, not prose);
  **council** (4 voices) only for genuinely ambiguous calls. _Build directly from epics when specs are full._
- **SPEC handoff** — `plan_spec` applies as a typed delta to durable `spec_shard`; stories inherit bound AC;
  `depends_on`/`touches` edges authored. Cycle-detection + Kahn order are code-enforced invariants.
- **SCHEDULE** — **ready-frontier**: dispatch any story whose `depends_on` are `done`, continuously (no
  static waves → no inter-wave dead time). `touches` overlap → isolate/serialize; disjoint → full parallel.
- **DEV spawn** — per-story **git worktree with lock-SHA dep-cache symlinks** (kills recompile thrash +
  saturation); **AC-aware laziness** injected (`spikes/ponytail/`); the **LIVE pre-tool gate**
  (`spikes/pretool-gate/`) driven by the story's `touches`/`forbiddenAreas` + a **hard cost ceiling**
  (immutable tracker + bridge) + **model routing** by story tier. (Optionally one shared session
  dev→review→compile to reclaim the 27k-token cold-start tax.)
- **INTEGRATE** — **merge-queue** with `git merge-tree` conflict prediction; **atomic claim** via DynamoDB
  conditional writes; `touches`-driven isolation prevents the index.md write race.
- **VERIFY** — **bound-AC tests passing = deterministic done** (replaces subjective review); keep the
  curated delivery-journey QA on the merged PLAN; optional GAN evaluator / complexity-only review pass.
- **LEARN** — **instinct capture** (reliable Pre/PostToolUse observations) → confidence-scored atomic
  instincts → `evolve`/`promote` → **Mycelium graph nodes**; closes the IAM-blocked reflector loop;
  `harness-optimizer` tunes config not code.
- **CROSS-CUTTING** — observability **bridge/ledger** (the `/tmp` metrics contract → your spine); the
  **multi-harness adapter layer** (one canonical policy → Claude/OpenCode adapters + `harness:audit`
  parity) is the provider-agnostic seam; supply-chain **IOC scan** as a pre-release CI gate.

---

## 8. Phased roadmap (impact-ordered; respects "ship MVP")

**Phase 0 — keystone (DONE):** `pretool-gate` spike built+green; `ponytail` laziness spike built+green.
**Phase 1 — enforce the spine on one epic:** wire `pretool-gate` in `audit` → grep would-blocks → flip one
story to `enforce`; add the **hard cost ceiling** (#2); inject **AC-aware laziness** (#7). _All low-effort,
reversible, measurable._
**Phase 2 — restructure scheduling:** **ready-frontier** dispatch (#3) replacing static waves; **bound-AC
completion gate** (#5). _This is the SDD pivot — story+AC+depends_on+touches is the MVP unit._
**Phase 3 — structural cost/throughput:** **worktree dep-cache isolation** (#4); **session reuse /
compaction** (#8). _Largest payoff, largest effort — attacks the 47% + 30s/27k pains head-on._
**Phase 4 — close the loop & go provider-agnostic:** **instinct loop → Mycelium** (#6); \*\*adapter registry

- parity** (#10) for the OpenCode migration; **context-budget + embeddings** (#11/#12).
  **Phase 5 — quality meta-layer:\*\* GAN loop, agent-evaluator scorecards, loop-operator circuit-breakers,
  IOC scan in CI.

---

## 9. Design principles honored (your feedback as hard constraints)

- **Ship MVP, add complexity later** → the SDD MVP unit is deliberately small (§3); governance edges deferred.
- **Preserve parallelism** → host saturation is fixed by worktree dep-cache + admission, _never_ by lowering
  concurrency (#4, not throttling).
- **Proper fix over shortcut** → we _build_ the live gate, not auto-bypass; bound-AC replaces the workaround
  of subjective review.
- **Deterministic gating is the differentiator** → every borrowed idea is deterministic (risk-score, Kahn
  frontier, bound-AC, grep ledgers); LLM judgment stays advisory.
- **Stay on Max / internal tenancy** → model routing optimizes _within_ Max; multi-provider is an overflow
  valve and a future-OpenCode seam, not a per-token cost move.
- **Pattern donor, not dependency** → no foreign runtime adopted; no external telemetry; everything ports
  into the Node daemon.

---

## 10. Artifacts produced this session

**Concept docs:** `docs/concepts/jcode-pipeline-analysis.md` · `docs/concepts/ecc-pipeline-analysis.md` ·
Mycelium `futurator-sdd-jcode-analisis-1.md` · `futurator-ponytail-analysis-1.md` · this overview.
**Spikes (built + tested):** `spikes/pretool-gate/` (8 tests + e2e) · `spikes/ponytail/` (3 tests).
**Cloned donors (gitignored):** `repos/jcode` · `repos/ponytail` · `repos/ecc`.
**Memories:** `project_jcode_evaluation` · `project_ponytail_evaluation` · `project_ecc_evaluation` ·
`project_pretool_gate_keystone`.

**Immediate next step:** Phase 1 — A/B the `pretool-gate` in `audit` on one real epic and add the cost
dimension to the same gate. Everything downstream builds on that keystone.
