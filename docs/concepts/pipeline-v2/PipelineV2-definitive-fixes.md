# Pipeline V2 — Definitive Fixes

> **Status:** Design / North-star. **Rev 2** — upgraded after a 28-agent adversarial review
> (4 lenses × refutation-verified findings: 20 confirmed, 0 refuted) + a skills-substrate
> root-cause investigation against live EC2/DDB ground truth.
> **Date:** 2026-06-05
> **Scope:** PM → Architect → Test-Author → DEV → per-story VQA → plan-level QA Review → remediation.
> **Trigger forensic:** `plan_horse-runner1_mq0r2i9p` story `9cf7cb6d` ("Implement rendering for all
> four obstacle types") — a _correct_ story that VQA FAILed 3×, and whose false feedback drove DEV to
> graft an `obstacle-preview` gallery into the live game page (`89afa97`). See `docs/concepts/logs/`.

---

## 0. How to read this document

The pipeline today **works for one shape of software**: a web app you boot as a dev server and screenshot at `/`. Everything else — infrastructure, databases, Python, audio, asset pipelines, orchestration, CLIs — is silently out of contract. The failures we keep hitting (false FAILs, silent broken-ships, product corruption, wasted fix-cycles) are not bugs in the screenshot judge; they are symptoms of **a pipeline that hardcodes a single domain and a single verification instrument** while pretending to be general.

This document, for **every** claim and disease identified:

1. **Names the disease at the design level** (with the exact code/prompt evidence from the audits).
2. **Proposes the V2 behavior** — optimised for **adaptability** (works for any domain by _inferring_, not _enumerating_) and **scalability** (add a domain or a verification tool without editing the core).

The design pillars throughout:

- **Pillar A — Spec, not prose.** A structured **Verification Contract** flows down the pipeline and is _enriched_ at each stage, instead of intent degrading into English bullets + a single `needsBrowser` bit.
- **Pillar B — An adaptive verifier with a pluggable toolset.** Verification is an **agent that selects/composes probes** from a capability registry against whatever interface the artifact actually exposes — not a fixed "boot dev server → screenshot `/`" script.
- **Pillar C (Rev 2) — Verdicts route through evidence, never through themselves.** A probe never grades its own routing. Every non-PASS verdict is _attributed_ (artifact-defect / spec-defect / instrument-defect / environment-defect) by an independent arbiter over evidence, and each attribution has a **designated automated fixer** — that is what makes the pipeline self-_fixing_ instead of self-_diagnosing_.

### The anti-pattern we must not commit

> **Do not trade a regex for an enum.** Replacing `needsBrowser: boolean` with a hardcoded `verificationMode: 'screenshot' | 'unittest' | 'db-query' | …` is the _same disease in a larger costume_ — a closed list the core must know about. The future-proof move is to let each AC declare **an observable and an oracle**, and let an **agentic verifier discover the artifact's real interfaces** and bind a probe at runtime. Enums may exist as a pragmatic _cache_ of common cases, but they must never be the gate.

> **Scope note (Rev 2):** a closed **verdict vocabulary** and a closed **arbiter attribution list** are _not_ this anti-pattern. They are domain-neutral protocol — like HTTP status classes — and stay closed on purpose. The disease is closed _domain/tool/surface_ lists, not closed _protocol_ lists. Stated explicitly so the rule is not over-applied.

---

## 1. The single root disease

**Nothing binds an acceptance criterion to an instrument capable of observing it, and the one instrument that exists is hardcoded to a single domain.**

Authors (PM, DEV) declare _what must be true_ in prose. The only typed signal of _how to verify_ is one boolean (`needsBrowser`). The verifier ignores even the richer `VISUAL_TESTS` spec DEV writes, and grades the PM's English wish with a single idle screenshot of `http://localhost:$PORT/`. When the artifact is not a screenshotable web page, the verifier silently skips and the story ships unverified.

Everything below is a facet of that root.

---

## 2. The four-stage narrative, audited claim-by-claim

The operator's framing: _PM flags "needs VQA" → Test-Author writes "see if obstacles appear" → DEV develops correctly → VQA says "not working" but means "I lack the tools."_ What is actually true:

### Claim 1 — "The PM flags this story needs VQA."

**Reality — mischaracterized, and worse.** The PM does not flag _stories_; it tags each **AC** with `needsBrowser: boolean` (`plan-output-schema.ts:21-30`). That bit answers **"does this need a browser?"** but the machinery treats it as **"is this confirmable from one idle screenshot?"** — a strictly smaller set. And the PM's _own prompt_ coaches false-negative generators: its canonical "good" browser-AC example is _"…player sprite AND at least one enemy sprite simultaneously **at any time during the playing state**"_ (`pm-plan-prompt.ts:182-183`) — unobservable from an idle frame. The PM did exactly what it was told when it wrote _"a canvas showing all four obstacles side-by-side."_

**V2:** the PM declares verification _intent as structure_ (§4): per AC, _what condition becomes true, on what surface, and what would prove it false_. The PM does **not** choose the tool — it makes the claim falsifiable. A **Contract Lint** stage (§4-B) validates feasibility against the actual scaffold _before_ any story dispatches.

### Claim 2 — "The Test-Author writes the instruction."

**Reality — false attribution, and the truth is a _read_ failure, not an authoring gap.** ~~The TEST agent authors unit tests only~~ — **correction (Rev 2):** under `hasBrowserTests` at mvp+ rigor, TEST is _required_ (PR-64, `story-pipeline.ts:327-383`) to author an **integration test that boots the real entry point and drives the game loop N ticks asserting observable state** — the exact dt-units bug class — plus optional Playwright specs under `e2e/` that nothing ever executes. DEV separately authors the rich `VISUAL_TESTS` block (`setup`/`expect`/`level`/`judge`/L2 `flow`). **The per-story judge reads neither.** It reads `STORY_BROWSER_ACS`, rebuilt from the PM's raw `criteria[].text` (`story-pipeline.ts:966-972`) — even though the merged `visual-tests.md` is _already on disk in the worktree at judge time_ (the daemon merges it before review-runtime, `agent-daemon.mjs:2156-2176`). The spec isn't missing; the judge just never opens it.

**V2:** one **Verification Contract** per AC (§4), authored once, enriched in place, honored by every consumer. No stage silently rebuilds a weaker view. If `setup` exists, the verifier is _obligated_ to drive the artifact into that state before observing.

### Claim 3 — "The DEV develops correctly."

**Reality — true, then the loop forces it to develop incorrectly.** DEV wrote correct `obstacles.ts`; the story merged. The false FAIL fed back as "fix this," and DEV committed `89afa97 fix: wire obstacle-preview feature into page` — **a false negative became real product corruption.** Nothing forbids DEV from mutating product surface to satisfy a visual verdict, and the retry loop grants a FAIL absolute authority.

**V2:** write-authority is gated three ways — the **FAIL Arbiter** (§6-A) must attribute the failure to the artifact before any DEV cycle opens; **corroboration** replaces self-graded confidence (§6-C); and the **touchPoints scope gate** (already designed in Disease G — credit where due: it would plausibly have blocked `89afa97` specifically) gets an enforcement mechanism (§6-D). Within-touchPoints corruption, misrouting, and wasted cycles — which touchPoints alone cannot catch — are what the arbiter and loop policy close.

### Claim 4 — "VQA says 'not working' but means 'I lack the tools.'"

**Reality — true, sharpened three ways.** The verifier is simultaneously (a) pointed at the **wrong target** (idle `/`, not the testable state), (b) asked the **wrong question** (intent prose, not the executable oracle sitting unread on disk), and (c) **blind to the binding** between ACs and the test suite. **Correction (Rev 2):** "QA never runs the unit suite" is true only at _plan level_. Per-story, `test-verify` runs vitest as a _blocking gate_ at mvp+ (`story-pipeline.ts:678-694`) — review-runtime only ever runs where the suite already passed. The missing piece is **AC→test binding**: nothing records _which ACs_ a green suite actually asserts, so the screenshot judge re-litigates ACs the suite already proved, and a suite-failure on an AC is indistinguishable from generic red.

**V2:** the verifier (§5) consults deterministic ground truth _with binding_ — suite-asserted ACs resolve deterministically; only genuinely perceptual residue reaches a vision judge, and "I lack the tools" becomes an honest, routable verdict (`NOT-OBSERVABLE`, `BLOCKED`) instead of a hidden FAIL or silent skip.

---

## 3. The hardcoding inventory (what makes it single-domain)

| #   | Hardcoded thing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                   | Breaks for                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| H1  | `npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=2000 …/` (single idle frame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `story-pipeline.ts:950`, `visual-qa-pipeline.ts:474`                    | anything non-visual; anything dynamic                             |
| H2  | `QA_HEALTH_PATH='/'`, ports `3000/5173/19006`, 60× HTTP-200 boot loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `framework-detect.ts:70-92`                                             | CLI, infra, DB, audio, batch                                      |
| H3  | Framework allow-list (`next/vite/remix/expo/sveltekit/nuxt`), requires `package.json`, fallback = `npm run dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `framework-detect.ts:61-113`                                            | Python, Rust, Go, Terraform, anything non-Node                    |
| H4  | `INTERACTION_GATED_RE` — lexical keyword regex over AC prose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `qa-report-aggregator.ts:77`                                            | static-worded dynamic ACs dodge it; non-web ACs misclassified     |
| H5  | `VAGUE_EXPECT_PATTERNS` — flags "correctly/displays/appears" as vague                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `visual-test-classifier.ts:75-82`                                       | objective non-web ACs get flagged                                 |
| H6  | Model pins `haiku`/`sonnet` + fixed cost/wallclock tables — **also baked into the _generated_ judge scripts** (`visual-qa-pipeline.ts:624-626, 700-702`)                                                                                                                                                                                                                                                                                                                                                                                                             | `visual-qa-pipeline.ts:180-187`, `story-pipeline.ts:1008`               | non-visual judging; future models; measured-cost budgeting        |
| H7  | L0/L1/L2 _are_ screenshot tiers (HTTP+blank-png / Haiku-1-frame / Sonnet-flow)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `visual-qa-pipeline.ts:180-187`                                         | no tier means "run the suite" or "query state"                    |
| H8  | Verdict vocabulary PASS/FAIL/UNCERTAIN with screenshot semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `story-pipeline.ts:1002-1004`                                           | conflates "N/A to instrument" with "couldn't observe"             |
| H9  | `needsBrowser: boolean` is the _only_ typed verification signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `plan-output-schema.ts:26`                                              | every non-browser modality                                        |
| H10 | Domain examples burned into prompts (DinoState, "player+enemy sprite", "login form", jsdom/@testing-library)                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `pm-plan-prompt.ts`, `story-pipeline.ts:343-382,620-641`, `registry.ts` | steers _every_ plan toward web/game                               |
| H11 | Per-rigor AC counts hardcoded in prose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `pm-plan-prompt.ts:333-353`                                             | not tunable per domain                                            |
| H12 | **Silent-pass surface — six paths, plus daemon amplification** (corrected, Rev 2): dev-server no-boot (`story-pipeline.ts:948`), screenshot failure (950), zero browser ACs (978), **judge CRASH exits 0** (1014), unparseable judge output (1021), all-UNCERTAIN exits 0 (1043-44). The daemon then treats the envelope marker as a real pass (`agent-daemon.mjs:1886` — `realPass = /---RUNTIME_REVIEW---/`) and **auto-RESOLVES the open `story-vqa-failed` attention card** (1920): an all-UNCERTAIN blank page actively _clears_ the operator's failure signal. | `story-pipeline.ts`, `agent-daemon.mjs`                                 | every domain; this is operator-signal corruption, not just a skip |
| H13 | **(Rev 2)** L2 `flow:` steps are parsed (`visual-qa-pipeline.ts:105-167`) and the judge expects flow-screenshot files (715) — but **no executor exists anywhere**; the capture loop only idle-screenshots (491-516). Every L2 flow test is structurally guaranteed UNCERTAIN.                                                                                                                                                                                                                                                                                        | `visual-qa-pipeline.ts`                                                 | the "interactive runner" is a phantom — see Disease B             |

The good news stands: `skill-scout`, `triage`, and `reflector` prompts are already domain-agnostic and structural. They are the template; the disease is concentrated and fixable.

---

## 4. Pillar A — the Verification Contract

Replace `needsBrowser` and the unread `VISUAL_TESTS` with **one structured object per AC** that every stage reads and enriches:

```ts
interface AcceptanceCriterion {
  id: string;
  text: string; // human statement (unchanged)

  // ── Verification Contract ─────────────────────────────────────
  // INTENT — immutable after PM/operator authoring:
  observable: {
    signal: string; // what becomes true
    disqualifier: string; // what would prove it FALSE (required; see lint rule below)
  };
  oracle: {
    kind: 'deterministic' | 'perceptual';
  };

  // BINDING — revisable layer (see §4-A):
  binding: {
    surface: string; // inferred descriptor of where truth shows:
    //  "http:/", "cli:stdout", "file:dist/out.wav",
    //  "export:src/game/obstacles.ts#draw",
    //  "db:schema", "tfstate:outputs", "harness:/sandbox/obstacles"
    setup?: SpecStep[]; // how to drive the artifact into the testable state
    version: number; // re-binds are new versions, never silent edits
  };
}
```

Design rules:

1. **`surface` is inferred, not enumerated** — a free-form capability descriptor an agent writes and another agent reads. The core never switch-cases on it. (How free-form strings reconcile with a registry: §5-B — matching by reasoning, registry as cache.)
2. **`disqualifier` replaces the vagueness regexes (H4/H5) — validated adversarially, not by self-attestation.** _(Corrected, Rev 2: "ask the author" was the hallucinator grading itself.)_ At Contract Lint (§4-B) an **independent agent must derive a falsifying observation** from the signal text; if it cannot, the AC bounces to PM. Cross-validation over independent inputs, valid in any domain, zero keywords.
3. **`setup`/`SpecStep[]` is honored, not discarded** (fixes Claim 2). Domain-neutral steps ("navigate harness:/sandbox/obstacles", "POST /users {…}", "run migration 003", "render 240 ticks") that the verifier compiles to concrete probe actions (§5-D).
4. **Intent is append-only; binding is revisable** (§4-A). Downstream stages may NARROW (add setup, refine surface); a _contradiction_ of an upstream intent field is itself a first-class verdict routed to the Architect as an attention item with both versions attached — never auto-resolved.

### §4-A — Intent vs. binding: why the split (Rev 2)

The PM writes surfaces as **boilerplate-convention path guesses before any code exists** (`pm-plan-prompt.ts:80-89`), and spec-vs-actual drift is the documented norm (PR-59 forensic). An append-only `surface` fossilizes the PM's first guess; the verifier then binds to a nonexistent export, emits BLOCKED, and routing punishes the _spec_ for a _correct implementation_ — the horse-runner pathology mirrored. Therefore:

- **DEV emits a per-AC binding annotation at story completion** (contract → the concrete locator actually implemented), folded into the existing `WORK_SUMMARY` extraction block (`story-pipeline.ts:1076-1082`). Drift is caught at the story boundary by the agent that created it, while context is hot.
- **One-shot re-bind:** if the verifier still fails to bind, it attempts ONE re-bind via the capability matcher (§5-B) before emitting BLOCKED. Re-binds are recorded as new `binding.version`s.
- **`NEEDS-SETUP` joins the feasibility vocabulary:** "observable only via a harness/fixture that does not yet exist." Its resolution is _emission_ — the required harness is written into `oracle.setup` **and into the owning story's `touchPoints`**, making the harness work DEV must do. Disease F closed **by construction**, not convention. This — not NOT-OBSERVABLE — is the correct classification for _"all four obstacles side-by-side"_: observable, falsifiable, but only on a surface that must be built.

### §4-B — Contract Lint: authoring-time validation (Rev 2; new stage)

_(This is what makes "flagged at authoring time" actually true — Rev 1 claimed it but defined NOT-OBSERVABLE only as a runtime verdict, with no authoring-time consumer. Corrected.)_

An agent step between PM output and story dispatch (Claude CLI subprocess on the daemon, same shape as qa-aggregate; reuses the existing `PENDING_APPROVAL` gate machinery, `visual-qa-pipeline.ts:217-237`). Inputs: the plan worktree's file tree + capability-probe output (the worktree exists at plan-fork time), the probe registry's capability cards (§5-B), and every AC's contract. Per AC, **by reasoning, not pattern-matching**, it answers:

- **FEASIBLE** — a discovered interface + a registered probe can observe this surface as the scaffold stands;
- **NEEDS-SETUP** — emit the harness/fixture requirement into `oracle.setup` + the owning story's `touchPoints`;
- **INFEASIBLE** — no probe family could ever observe it → bounce to PM regeneration with the lint's reasoning attached.

Plus the adversarial disqualifier validation (rule 2 above). Cost: one Haiku/Sonnet call per plan.

---

## 5. Pillar B — the adaptive verifier (the toolset)

The verifier, per AC: **discover** the artifact's real interfaces → **bind** a probe → **run** it under budget → emit an **evidenced** verdict.

### §5-A — A probe is a defined operational unit (Rev 2)

Rev 1 left the registry hand-wavy. A probe is a daemon-loadable manifest module (`daemon/probes/<name>.mjs`) exporting:

```
{ id, capabilityCard, evidenceStrength,
  canObserve(contract, discoveredCapabilities) → score,
  run(ctx) → { verdict, evidence, measuredCostUsd, durationMs, determinism } }
```

- `canObserve` is code/LLM judgment over the contract — **never a switch on surface strings**.
- **Budget owner is the daemon** (it already enforces per-step timeouts and SIGKILLs runaways — the activity-watchdog precedent). Wallclock/cost ceilings come from the `(rigor, domain)` data table (Disease H); costs are **measured** from CLI-reported usage, never H6's constants.
- **Isolation, one-flag-simple:** LLM judge steps get `--allowedTools` limited to probe invocation + Read (the existing L1/L2 pattern); generated playwright specs run as plain subprocesses scoped to the story worktree + a daemon-leased port. No raw Bash for judges; no cross-worktree reach.
- Probe families (illustrative, all registry entries — never core edits): `run-tests`, `call-endpoint`, `query-state`, `inspect-output`, `drive-and-capture` (§5-D), `screenshot-judge` (today's path, demoted to one probe among many).
- **Model selection is a property of the chosen probe and difficulty**, resolved at runtime against a registry — not pins (kills H6).

### §5-B — Binding: capability cards, reasoning-based matching, registry-as-cache (Rev 2)

_(Corrects Rev 1's self-contradiction: "a registry keyed by `(oracle.kind, surface)`" needs canonical keys, while §4 mandates free-form surface strings — as written it lured implementers toward surface-string normalization regexes, the forbidden anti-pattern, or a silent default-probe fallthrough: today's `npm run dev` fallback in new clothes.)_

- Probes register **capability cards** — natural-language + structured affordance declarations ("issues HTTP requests against a discovered listening port; asserts status/schema/body"; requires: network-endpoint) — not key patterns.
- **Binding is an agent MATCHING step, not a lookup:** the verifier reads three descriptor sets in the same vocabulary — the AC's `binding.surface`, the capability probe's discovered-interfaces report, and the registry's cards — and selects + concretizes a probe invocation **by reasoning**. No canonical key format ever exists.
- The registry-as-map survives as the doc's own **enum-as-cache** principle: persist `(contractHash, commitSHA) → (probeId, concrete invocation)` in DynamoDB (one-table-per-concern). Repeat verifications are O(1); the LLM matcher runs only on cache miss or artifact change.
- **NOT-OBSERVABLE is now precisely defined:** the matcher, reasoning over capabilities, finds no card that can observe the surface — derived from reasoning, never from a failed string lookup.

### §5-C — Evidence Bundles and verdict admissibility (Rev 2; new)

Today's verdict record is a ≤200-char rationale + one PNG — the horse-runner forensic took manual archaeology because nothing else existed. In V2 every probe run emits an **Evidence Bundle** as a first-class output (stored under the existing `snapshotPrefix` S3 convention, `qa-snapshots/<plan>/<jobId>/<acId>/`):

- playwright `trace.zip` (`trace:'on'` — DOM snapshots, network, console, action timeline for free), video (`retain-on-failure`), frame sequences;
- console/pageerror/requestfailed logs as JSON; accessibility-tree + targeted DOM reads;
- for LLM judge calls, the `--output-format stream-json` transcript.
- Non-playwright probes' evidence is naturally their raw output — an open per-probe shape, no closed enum.

Verdict records gain `evidenceUrl`; the dashboard links it; the operator replays with `npx playwright show-trace`. **The Evidence Bundle — not prose rationale — is what feeds DEV on FAIL**, making the fix verifiable by re-running the same cached probe.

**Admissibility rules** (deterministic post-checks in plain Node — no LLM, no keywords):

- A perceptual verdict whose stream-json transcript contains **no `tool_use` Read on the evidence file is voided and re-run** — closes the "judged without looking" hole the code itself documents (the dino UNCERTAIN-blind incident, `story-pipeline.ts:982-988` comment).
- **A FAIL must cite a concrete contradicting observation** (frame, DOM read, console error) by reference into its evidence; an uncited FAIL auto-downgrades to INCONCLUSIVE and re-probes.
- Probe results cached keyed `(probeId, commitSHA, contractHash)`. This buys **evidence-replay and investigability** (pinned inputs make flakiness attributable) — not verdict determinism; LLM judges stay nondeterministic on identical inputs and that is handled by §6-C, not denied.

### §5-D — drive-and-capture is a SPEC COMPILER: the dynamic self-VQA engine (Rev 2; new)

_(Rev 1 called this probe "drive the game loop, press keys, advance time, capture a sequence" — a phantom: no flow executor exists anywhere in the codebase (H13). This section makes it a net-new, concretely buildable engine.)_

- A daemon module (`daemon/pipelines/lib/verifier-probe-playwright.mjs`) that **compiles** each contract's `oracle.setup` SpecSteps into a generated `@playwright/test` spec (one `test()` per AC), executed via `npx playwright test` against the already-booted dev server.
- **SpecStep → playwright mapping is an LLM codegen call** (sees the SpecSteps + an accessibility-tree snapshot + the AC; emits the spec) — adaptive, not an action enum. The generated spec then runs **deterministically and repeatably**; cache generated specs per AC across fix-cycles.
- The spec captures per-AC: timed frame sequences on flow boundaries, console/pageerror/requestfailed listeners, accessibility snapshot + targeted `locator.evaluate` DOM reads — so judgments are **DOM+AX+pixels**, never pixels alone. Deterministic ACs resolve inside the spec via `expect()` and never pay for a judge; perceptual ACs forward the frame sequence to the judge.
- Reuses what exists: playwright on the host, the claude-CLI judge spawn pattern, and TEST's `e2e/` authoring rule — **made mandatory for browser ACs**, so DEV/TEST-authored specs double as verifier probe inputs.
- **Determinism seam (extends the contract):** boilerplates ship a registry-pluggable test hook (`window.__verify = {seed(n), tick(ms), state()}`) used with `page.clock.install()/runFor()`, so _"after 240 ticks, obstacle x < viewport"_ is a deterministic assertion, not a wall-clock race against a live rAF+RNG loop. Where no seam exists, fall back to event-based waiting and the probe self-reports `determinism: low`.
- **Reproduction gate:** a FAIL from a self-reported-nondeterministic probe must **reproduce (2 consecutive runs agree)** before gaining DEV write-authority; disagreement → INCONCLUSIVE → escalate. Cheap — the _spec_ re-runs, not an LLM session. This pre-empts the new flaky-false-FAIL class that generated interaction scripts would otherwise manufacture.
- **One engine, two scopes — concretely:** one daemon module, one entrypoint `verify({contract, workingDir, scope: 'story'|'plan', budget})`; per-story review-runtime and plan-level qa-execute become thin call sites. (The daemon-bundle distribution path is proven — plan-level QA already requires a daemon-side bundle.)

---

## 6. The deeper diseases — each with its V2 behavior

### Disease A — Capability/claim mismatch (the core)

**V2:** §4 + §5. The contract makes the claim falsifiable; the verifier binds an instrument that can actually observe it, deterministic-first. New domains add surfaces + probes, never core edits.

### Disease B — No interactive instrument exists at all _(corrected, Rev 2)_

Rev 1 said the L2 interactive runner "lives only in the powerless post-hoc stage." **False — it lives nowhere** (H13): flow steps are parsed and judged-against, but no executor runs them; every L2 flow test is structurally UNCERTAIN. This is itself a live silent-failure instance of Disease C.
**V2:** the spec compiler (§5-D) is a **net-new build**, available at _every_ scope, wired where DEV iterates — the loop with write-authority is fed by the strongest instrument, not the weakest.

### Disease C — `UNCERTAIN` does two opposite jobs; silent passes corrupt operator signal

**V2 — split the verdict space; instrument-aware; never exit 0 on failure-to-observe:**

```
PASS                — oracle satisfied (admissible evidence)
FAIL                — oracle contradicted (must cite evidence; see §5-C)
INCONCLUSIVE        — probe ran, could not decide → escalate per ladder below
INCONCLUSIVE-budget — escalation budget exhausted (honest exhaustion, Rev 2)
NOT-OBSERVABLE      — no capability card can observe this oracle as written → spec-defect route
BLOCKED             — probe could not run (boot, deps, port) → environment-defect route; LOUD
```

**Escalation ladder — derivable from registry data, not a tier enum** _(Rev 2)_: every probe self-declares `cost` and `evidenceStrength` (an ordinal declared as data by the probe author; deterministic > interactive-perceptual > static-perceptual as the _convention_, never a core enum). On INCONCLUSIVE the verifier ascends strictly by evidence strength within a **per-AC verification budget** from the `(rigor, domain)` table. **Explicit termination:** when budget exhausts or no stronger probe exists, the AC resolves to a terminal verdict that MUST emit a typed attention item carrying the full probe transcript, deduped on `(planId, acId)` via the existing `upsertOpenAttentionItem`. **Terminal non-PASS verdicts block plan-ready exactly as FAIL does — never exit 0.** (Today `qa-report-aggregator.ts` filters 'skipped' pillars so skips never block ready; that hole closes.)

### Disease D — QA ignores deterministic ground truth _(scoped, Rev 2)_

Per-story, the suite already runs as a blocking gate (C2 correction). The real gap is **AC→test binding**: TEST emits a structured AC→(test file, case name) mapping (its EARLY-EXIT path already asks informally, `story-pipeline.ts:319`); the verifier treats suite-asserted ACs as deterministic-PASS/FAIL and narrows perceptual judging to the residue. Unmapped browser ACs raise a per-story coverage-gap attention item. Plan-level QA gains the `run-tests` probe it genuinely lacks. The dt-units class becomes a failing _test_, not a fuzzy FAIL.

### Disease E — Lexical classifiers instead of semantic spec

**V2:** delete both regexes. "Interaction-gated?" is answered by the **oracle**: if `setup` is required, the state is by definition not idle-observable — structural fact, not keyword match. "Vague?" is answered by **adversarial disqualifier derivation** (§4-B). Valid in every domain.

### Disease F — No "testable state" / harness convention

**V2:** harness surfaces are first-class (`harness:/…`), and **NEEDS-SETUP makes them self-materializing** (§4-A): the lint emits the harness into `oracle.setup` + the owning story's `touchPoints`, so the harness is built as story work. A Python lib's harness is a fixture module; an infra module's is a `plan` against fixture tfvars.

### §6-A — The FAIL Arbiter: routing is evidenced attribution, not an enum switch _(Rev 2; the keystone)_

The deepest confirmed finding: **Rev 1's router was the probe grading its own routing.** FAIL→DEV, NOT-OBSERVABLE→author, INCONCLUSIVE→re-probe — a closed switch keyed on a verdict the probe itself emitted. And the trigger incident is precisely the case it cannot handle: the horse-runner FAIL was **confident and pixel-correct** — the screenshot genuinely contradicted the AC text. No confidence floor catches a high-confidence verdict against a mis-bound spec.

**V2:** before ANY non-PASS verdict triggers action, an independent arbiter (a separate Claude CLI subagent — same spawn pattern as the daemon's existing triage/free-agent sessions) receives: the AC contract, the full probe transcript + Evidence Bundle, the story's git diff, and the suite result for bound ACs. It must **attribute** the failure, citing evidence:

- **artifact-defect** → DEV fix-cycle;
- **spec-defect** → AC-author fixer (intent wrong, or mis-bound to the wrong surface/state);
- **instrument-defect** → probe escalation / probe-registry fixer;
- **environment-defect** → environment fixer (boot, deps, port) — the named fixer for BLOCKED.

**Corroboration replaces self-graded confidence for write-authority:** a FAIL is high-confidence only when a second independent probe agrees on the same AC (e.g., deterministic FAIL + perceptual FAIL). A perceptual FAIL **contradicted by a deterministic PASS on the same AC auto-routes to the arbiter, never to DEV**. Purely perceptual ACs with no deterministic twin can never self-qualify — they _always_ pass through the arbiter. Cost: one Sonnet call per FAIL, only on FAILs.

### §6-B — Confidence is DERIVED, never self-reported _(Rev 2)_

Self-reported confidence is a **proven pass-token in this repo**: `skill-scout-runner.mjs:134-138` auto-confirms on self-reported ≥0.9, and `reflector-apply.mjs:192` _hardcodes_ `confidence: 0.9` to clear that gate. Nothing computes verdict confidence today (zero hits in both pipelines). The V2 model:

- **Deterministic probes are confidence 1.0 by construction** — deterministic-first is also confidence-maximizing. **Deterministic override:** when any deterministic probe contradicts a perceptual verdict on the same AC, the deterministic result wins unconditionally (then arbiter).
- Perceptual verdicts earn confidence via cheap escalation tiers: (a) **claim-grounding check** — a second judge receives only the rationale + evidence and must locate each concrete claim in the evidence; ungrounded rationales zero the verdict; (b) **dual-judge agreement** — two fresh-context calls; agreement → high band, disagreement → INCONCLUSIVE, never DEV.
- **Calibration loop from data already collected:** operator Accept vs send-back decisions are ground-truth labels; the reflector mines them into per-probe-family confidence bands stored as **data in DynamoDB**, not constants.

### §6-C — Fix-cycle loop policy: what re-runs after a DEV fix _(Rev 2)_

Rev 1 specified nothing here — and the identical-re-probe loop IS the 3-wasted-cycles engine. Three domain-agnostic policies:

1. **Same-observation detector:** after a DEV fix, re-run the failed probe; if an LLM comparison judges the new evidence materially identical to the previous attempt's while DEV's diff is non-empty, the verdict becomes **instrument-suspect** and routes to the arbiter instead of consuming another DEV cycle. _A probe that cannot observe the fix can never be satisfied by fixing._
2. **Regression sweep + touchPoints enforcement:** re-run all deterministic probes for the story's other ACs (near-free) plus a **diff-scope check** that the fix stayed inside `touchPoints`; an out-of-scope diff converts the cycle to BLOCKED → attention item, never a silent merge. (Re-running _only_ the failed probe is the trap: it would have PASSED the obstacle-preview graft.)
3. **Probe-result caching** keyed `(acId, HEAD sha, probeId)` so sweeps cost nothing when the artifact didn't change.

And the exhaustion fix: today retry exhaustion **soft-passes to commit/DONE** (`agent-daemon.mjs:3134-3136` logs a warning and continues). V2 exhaustion is a terminal verdict per Disease C — blocks, emits attention, never silently ships.

### §6-D — Verdict → remediation wiring: the pipeline that fixes the PIPELINE _(Rev 2)_

Rev 1 said NOT-OBSERVABLE "routes to authoring fix" but named **no actor** — with one operator, every unwired verdict is a hand-drained queue: self-_diagnosing_, not self-_fixing_. The machinery already exists: `AttentionItem` + `RemediationPolicy` `manual|auto-draft|auto-fix` (`attention.ts:115-133`), the per-category policy table, and the daemon attention-poller that spawns free-agent fix sessions with a double-spawn guard. Wire each terminal verdict / arbiter attribution as an attention category + default policy + **designated fixer prompt**:

| Verdict / attribution        | Fixer agent                                                                                                                                                   | Default policy         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| NOT-OBSERVABLE / spec-defect | **AC-author fixer** — rewrites the contract (e.g., rebinds a composite-state AC to a harness surface); operator approves a **contract diff**, not a hand-edit | auto-draft             |
| BLOCKED / environment-defect | **Environment fixer** — boot script, deps, port                                                                                                               | auto-draft             |
| instrument-defect            | **Probe-registry fixer** — drafts a new/amended registry entry                                                                                                | manual until graduated |

Per-category policies are data the operator already tunes (Settings → Remediation Policies), so manual → auto-draft → auto-fix is **adaptive by construction**: the pipeline _earns autonomy per failure-type_ as fixes prove out, with `recurrenceCount` as graduation evidence. Cheapest item in the design — only the three fixer prompts are new. (Honest note: auto-fix's auto-merge trigger is deferred to v1.1 today, `agent-daemon.mjs:4120-4123`.)

### §6-E — The learning loop: verification lessons on the reflector substrate _(Rev 2)_

Rev 1 had **zero memory of past verification failures** — and the existing machinery learns the _wrong_ lesson: `commit-metadata.ts:151-156` stamps the `VQA-Fixed:` trailer **unconditionally** on the next commit whenever `vqa-observations.txt` is non-empty, and `reflector-prompt.ts:82-85` mines those trailers as "HIGH-signal lessons" — so horse-runner1's corruption commit `89afa97` would be **canonized into CLAUDE.md as a lesson**. Four points:

1. **Attribution-gate the trailer** (near-free): only arbiter-attributed _artifact-defect_ fixes earn `VQA-Fixed:`; spec/instrument failures can never be mined as visual lessons.
2. **Ground-truth labels from the operator:** B#2 Accept on a FAIL = labeled false-negative; send-back = labeled true-negative — free supervision currently discarded. Arbiter attributions are labels too.
3. **Structured lesson bank:** the reflector writes verification lessons (AC shape, surface, probe used, why it mis-fired) into a small DDB lesson bank — same propose-only inbox flow as today.
4. **Recall at the two points that never learn today:** PM plan time (lessons injected into Contract Lint) and verifier probe-binding time (lessons as probe-preference priors). Retrieval is an LLM step over the inferred domain/surface — the Disease H lessons-as-data pattern, no keyword match.

### Disease G/H — scope gate; domain knowledge as data _(retained from Rev 1, now with mechanisms)_

TouchPoints write-scoping is retained and **credited**: it is the second defense layer and would plausibly have blocked `89afa97` specifically; §6-C-2 gives it the enforcement mechanism it lacked. Domain knowledge moves to data banks queried by inferred domain; prompts carry zero domain examples (matching skill-scout/triage/reflector); rigor → AC-count becomes a `(rigor, domain)` table.

---

## 7. What "any kind of code" requires (worked surfaces)

| Deliverable                 | `binding.surface`                                                           | `oracle.kind`              | Probe bound                                                                     | Verdict source                                       |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Canvas game obstacle render | `export:…/obstacles.ts#draw` → `harness:/sandbox/obstacles` _(NEEDS-SETUP)_ | deterministic / perceptual | `run-tests` (bbox non-empty) or §5-D compiled spec                              | test result / judged harness frames                  |
| Game motion (dt-units bug)  | `export:…/reducer#step`                                                     | deterministic              | `run-tests` ("after 240 ticks via `__verify.tick`, obstacle x within viewport") | test result — **catches what no screenshot can**     |
| REST API route              | `http:/v1/users`                                                            | deterministic              | `call-endpoint`                                                                 | status + JSON-schema assert                          |
| DB migration                | `db:schema`                                                                 | deterministic              | `query-state`                                                                   | column/row assertion                                 |
| Terraform module            | `tfstate:outputs`                                                           | deterministic              | `query-state` / `tf-plan-diff`                                                  | plan/state assertion                                 |
| Python data job             | `file:out/metrics.csv`                                                      | deterministic              | `inspect-output`                                                                | file existence + content match                       |
| Audio render                | `file:dist/out.wav`                                                         | deterministic              | `audio-rms` / spectral                                                          | numeric threshold                                    |
| CLI tool                    | `cli:stdout`                                                                | deterministic              | `inspect-output`                                                                | exit code + stdout match                             |
| Marketing hero layout       | `http:/`                                                                    | perceptual                 | `screenshot-judge`                                                              | judged frame (the only row still using today's path) |

_(Rev 2 annotations: `export:…#…` surfaces are binding-layer guesses subject to §4-A DEV re-binding; the canvas-game perceptual rows acquire the §5-D determinism seam.)_

---

## 8. Sequencing — including Step 0 for the very next run _(rewritten, Rev 2)_

**Step 0 — next-run survival (days-scale; ships before any plan runs again).** Spec-derived, no regexes/enums, entirely inside the existing snippet/daemon/prompts. A bridge, not a rebuttal of the contract work:

- **0.1 The judge reads the spec it already has.** The review-runtime snippet cats `<worktree>/visual-tests.md` and injects each AC's matching entry (setup/expect/judge by criteriaRef) into the judge prompt. The judge must FIRST decide, per AC, whether the state described by `setup:`/`expect:` is **reachable in this idle frame** (semantic self-classification — "could this require a state the idle frame cannot show?"), emitting PASS/FAIL only for observable ACs and `OBSERVABILITY: idle-unreachable` otherwise. Wrong self-classification fails _safe_ (non-FAIL) versus today's corruption-driving false FAIL.
- **0.2 Dynamic self-VQA seed** (staged behind 0.1): when `setup:` exists and the AC is idle-unreachable, the judge step may drive the state itself — a single **constrained playwright driver** (pre-generated script derived from `setup:`, not free-form Bash) alongside Read, then judge the captured frames. Existing infra only (claude CLI + playwright on the host). This is §5-D's embryo.
- **0.3 Ungate the retry loop from unverifiable FAILs.** (a) The judge appends observability+confidence per verdict line (interim routing hint only; superseded by §6-B) — only observable, confident FAILs open the retry loop; others exit 0 **with a loud `story-vqa-unverifiable` attention item**. (b) **AC_CONTEST path (load-bearing):** the retry prompt instructs DEV that if a failing AC describes a state the screenshot cannot show, it must emit a structured `---AC_CONTEST---` block (AC id + reason) **instead of code changes**, and that it may never add routes/pages/UI surfaces outside the story's `touchPoints` to satisfy a visual verdict. The daemon routes contests to operator attention without consuming an iteration; one contest per AC so DEV can't dodge work.
- **0.4 Close the six silent-pass paths (H12).** The judge emits `PAGE_STATE: rendered|blank|error-overlay` (LLM-judged); blank/error + any non-PASS → exit 1 (early BLOCKED). Every skipped path prints a machine-grepable cause marker and writes a low-severity `story-vqa-skipped` attention item (deduped per story). `realPass` requires **≥1 PASS verdict**, not the envelope marker — all-UNCERTAIN stops auto-resolving attention cards.
- **0.5 AC→test binding** (converts PR-64 into the deterministic-first probe): TEST emits a structured AC→(test file, case) mapping; review-runtime injects it so suite-asserted browser ACs resolve deterministic-PASS and the screenshot's jurisdiction narrows to perceptual residue. Unmapped browser ACs → coverage-gap attention item. (Named risk: trust-based until the full contract verifies fidelity.)
- **0.6 Send-back de-poisoning:** judge observability/confidence fields carried additively in VQA report rows; `classifyVqaFailure` consults them when present (the regex demoted to legacy fallback); the failure drawer shows the judge's observability rationale so Accept-vs-send-back is informed.
- **0.7 Trailer gate:** `VQA-Fixed:` stamps only when the fix passed without contest/override (interim §6-E-1).
- **0.8 PM prompt:** delete the false-negative exemplar _"at any time during the playing state"_ (`pm-plan-prompt.ts:182-183`). One line.
- **0.9 Skills:** forensic exporter ingests `skills_available`; daemon appends the dynamic skills line to the system prompt (§9).

**Step 1 — verdict split + terminal semantics** _(rescoped — C2 correction: the "run-tests probe" headline was re-reading a known-green signal; what actually ships here is honest verdicts)_: the 6-way verdict space incl. INCONCLUSIVE-budget; all terminal verdicts emit typed attention items and block plan-ready; all six exit-0 paths killed structurally; AC→test binding formalized.

**Step 2 — Verification Contract + Contract Lint:** §4 with intent/binding split, NEEDS-SETUP, the lint stage; both regexes deleted; classification spec-derived.

**Step 3 — One verifier engine + FAIL Arbiter + loop policy:** single daemon module `verifier.mjs`, `verify({contract, workingDir, scope, budget})`; both call sites become thin invocations; explicit mapping of the verdict space into per-story onFail/loopTo and qa-report-aggregator. Arbiter (§6-A), corroboration, fix-cycle loop policy (§6-C), remediation wiring (§6-D).

**Step 4 — Probe Registry operationalized:** probe manifest interface (§5-A), capability cards + matching + binding cache (§5-B), Evidence Bundles + admissibility (§5-C), daemon-owned measured budgets, derived confidence (§6-B).

**Step 5 — Spec compiler + harness convention + determinism seam (§5-D, Disease F):** dynamic self-VQA fully lands; the horse-runner1 AC becomes verifiable _as written_.

**Step 6 — Domain data bank + rigor table + lesson bank (§6-E, Disease H).**

**Honest closing claim** _(replaces Rev 1's, which was wrong on both stage and verdict — the obstacle AC is observable and falsifiable, so Rev 1's steps 1–2 would NOT have flagged it)_: **Step 0 alone prevents a horse-runner1 repeat on the next run** (observability self-classification → no false FAIL; AC_CONTEST + touchPoints ban → no corruption path; realPass fix → no signal-clearing). **Steps 2+5** make the AC verifiable as authored (NEEDS-SETUP → harness). **Step 3** makes the routing correct for the general class (confident-but-mis-bound FAILs).

---

## 9. The skills substrate (Rev 2; new — skills are part of agent adaptivity)

**Ground truth (live DDB `futurator-agent-events` + EC2):** _"zero skills" is a reporting artifact, not a loading failure._ Every `skills_available` event ever recorded — 54, including **all 7 sessions of trigger story 9cf7cb6d** — shows `skillCount: 66, hasSkillTool: true`. The worktree sessions DID load all project skills. But `skill_activated` events table-wide = **0**: no pipeline agent has _ever invoked_ the Skill tool.

**Two-layer root cause:**

1. **Reporting:** `buildSkillsBlock` (`functions/shared/timer/forensic-builder.ts:382-384`) derives only from `skill_activated`/Skill-`tool_use`/skill-scout events and returns `null` otherwise — it never reads the `skills_available` ground truth. "66 available / 0 activated" renders as "no skills"; per-story commits carry empty `Skills-Used:` trailers for the same reason (the trailer only fires on Skill tool_use).
2. **Behavioral:** vendored SKILL.md descriptions are **human-utterance-shaped** ("Use when the user says 'dev this story…'"), which never match the daemon's prescriptive machine-generated step prompts — model-side relevance matching (validated by the 05-19 probe) never fires.

**Historical loading defect (fixed; keep as defense-in-depth):** repos bootstrapped before 2026-05-30 had a dead `.claude/skills/.gitignore` un-ignore pattern (leading `*`, no `!*/`), so SKILL.md was never committed and worktrees (committed content only) were skill-less — the dino1 `skills:null` era. The forward fix (commit `0dc479d`) covers new bootstraps only; the one-time remediation (`daemon/scripts/remediate-skills-gitignore.mjs --all`) is operator-manual. horse-runner1 is verified healthy; brownfield repos and vite/sst/mobile stubs (`defaultSkillLoadout: null`) remain structurally skill-less.

**Fix set (dynamic, no hardcoding):**

- **Reporting:** `buildSkillsBlock` also ingests `skills_available` → `{availableSkillCount, hasSkillTool, activatedSkills, totalSkillToolUseEvents}`; never null when availability events exist; the admin skills page shows _discovered vs activated_.
- **Activation:** at spawn time the daemon reads `<worktree>/.claude/skills/*/SKILL.md` frontmatter (it already reads the manifest for the trailer) and appends ONE dynamic line to `--append-system-prompt`: _"Project skills available via the Skill tool: ⟨name: description, …⟩. Invoke the relevant skill before implementing UI/design/test work."_ Fully per-project, domain-agnostic. Optionally, `skills-sync` rewrites vendored descriptions to be **task-shaped** ("Use when implementing/styling web UI") instead of utterance-shaped.
- **Self-healing presence gate:** idempotent check in `setupStoryWorktree` — manifest pins N>0 skills but fewer SKILL.md files exist → call the existing `runVendorSkills({worktreeDir})` to materialize + repair a broken gitignore in place; emit `skill-sync-healed`. Heals stale plan branches, pre-fix repos, and brownfield uniformly.
- **Guards:** escalate the daemon's "ZERO skills" warn to an attention item when the manifest pins skills; restore `assert-skills-committed` to **blocking** when vendoredCount>0 but tracked=0 (the gitignore-defect signature); brownfield gets prepin/vendor (or an empty manifest) so SKILL-SCOUT can populate; verify once that the Skill tool activates under the role-policy `--allowedTools` allowlist (no ROLE_BASE allowlist includes `Skill`; the 05-19 probe ran without one) and add it if needed.
- **Regression guard in plan-level QA:** assert `skills_available.skillCount > 0` AND `skill_activated ≥ 1` for design/frontend stories — the Disease C "honest verdicts, never silent skips" principle applied to the pipeline's own capability substrate.

---

## 10. One-paragraph summary

The pipeline verifies _intent_ (the PM's English wish) with the _weakest instrument_ (one idle screenshot of `/`), discards the executable specs it already has on disk, lets the probe grade its own routing, and hardcodes a _single domain_ at every layer. The cure is (A) a **structured Verification Contract** — immutable intent + revisable binding, adversarially linted at authoring time — that makes every claim falsifiable in any domain; (B) an **agentic verifier with a pluggable probe registry** — capability cards matched by reasoning, registry as cache, Evidence Bundles with admissibility rules, a playwright **spec compiler** for true dynamic self-VQA with a determinism seam; and (C) **evidenced routing** — an independent FAIL Arbiter attributing every failure to artifact/spec/instrument/environment, corroboration instead of self-graded confidence, fix-cycle loop policies that detect unobservable fixes, every terminal verdict wired to a designated automated fixer through the existing remediation-policy machinery, and a lesson bank so no false-negative pattern ever recurs. Domain knowledge becomes data; prompts become structure; the screenshot judge becomes one probe among many — and the pipeline can build _and truly verify_ infrastructure, databases, UI, games, audio, assets, orchestration, and Python alike.

---

## Changelog (Rev 2 — adversarial review outcomes)

- **Factual corrections applied:** TEST authors integration tests incl. game-loop-tick assertions (PR-64) — the judge reads neither spec; per-story QA _does_ run the suite (blocking) — the gap is AC→test binding; no interactive flow executor exists anywhere (L2 flows structurally UNCERTAIN); the silent-pass surface is six paths + daemon attention-card auto-resolve; Rev 1's "steps 1–2 would have flagged the obstacle AC NOT-OBSERVABLE at authoring time" was wrong on both stage and verdict (no authoring-time check existed; the AC is observable+falsifiable — its defect is NEEDS-SETUP).
- **Design additions:** FAIL Arbiter (§6-A); derived confidence + corroboration, self-reported confidence rejected as a gate (proven pass-token: `skill-scout-runner.mjs:134-138`, `reflector-apply.mjs:192`); intent/binding contract split + Contract Lint + NEEDS-SETUP (§4-A/B); probe operational interface, capability-card matching, binding cache (§5-A/B); Evidence Bundles + admissibility (§5-C); playwright spec compiler + determinism seam + reproduction gate (§5-D); fix-cycle loop policy (§6-C); verdict→remediation wiring on the existing RemediationPolicy machinery (§6-D); learning loop with attribution-gated trailers (§6-E); Step 0 next-run survival set (§8); skills substrate (§9).
- **Conflict resolutions:** closed verdict/attribution vocabularies are domain-neutral protocol, not the §0 anti-pattern; touchPoints credited as the existing second defense (arbiter targets what it can't catch); skills "not loading" superseded by DDB ground truth (loading works; reporting + activation were the diseases) — the gitignore fix survives as the self-healing presence gate.
