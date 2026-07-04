# TEA (BMAD Test Architecture Enterprise) — Pipeline Integration Design

> 2026-07-04. TEA v1.19.0 (module code `tea`, npm `bmad-method-test-architecture-enterprise`).
> Docs: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/
> Installed: (1) THIS repo (`_bmad/tea/` + `.claude/skills/bmad-tea*`), (2) every FUTURE
> generated app via `daemon/pipelines/lib/bmad-install.mjs` (`--modules core,bmm,cis,tea`,
> override with `BMAD_MODULES`). EC2 `bmad-agents-source` sync deferred (agent-persona lane).

## 1. What TEA is (verified, not marketing)

A BMAD module: the **Test Architect** agent + **9 workflows** + a **40-fragment testing
knowledge base** (`tea-index.csv` manifest → `knowledge/*.md`, loaded selectively per
workflow step). Workflows: `framework`, `test-design`, `atdd`, `automate`, `test-review`,
`ci`, `trace` (two-phase → gate decision), `nfr-assess`, `teach-me-testing`.

Its two spines are ALREADY ported into our deterministic services (we did this before TEA
was a standalone module — from the alpha `bmad/bmm/workflows/testarch/` prose):

- **Gate model** PASS/CONCERNS/FAIL/WAIVED → `functions/shared/services/quality-gate.ts`
  (+ parity mirror `daemon/lib/quality-gate.mjs`).
- **Risk matrix** probability×impact → P0–P3 → `ac-cartographer.ts` `deriveRiskTag` +
  `visual-test-classifier.ts` rigor bands.

So TEA is not a new philosophy for us — it is the _upstream source of truth_ for the
philosophy we already run, plus a knowledge base and agent workflows we haven't mined.

## 2. Where TEA plugs into the TDD pipeline (the map)

| Pipeline stage                                                      | TEA asset                                                                                          | Wire-in                                                                                                                                                                                      | Status                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **PM plan-time** (quick-planspec / pm-plan)                         | `test-design` (risk scores 1-9, P0-P3, mitigation)                                                 | PM prompt cites the risk rubric; deliveryJourneys become the "test design" artifact                                                                                                          | later (prompt enrichment) |
| **Test-Author** (P3_TEST_AUTHOR_SPLIT)                              | `atdd` (failing tests first) + knowledge: `test-quality`, `fixture-architecture`, `data-factories` | Inject selected fragments into `buildStoryTestPrompt` — the app now HAS `_bmad/tea/.../knowledge/` on disk; the test-author reads the 2-3 fragments named for its story kind                 | **next quick win**        |
| **Bound-AC gate / verify-coverage**                                 | `trace` Phase 1-2 (coverage matrix → gate)                                                         | Our testBinding + quality-gate already implement this deterministically; adopt trace's per-risk-category coverage % (TECH/SEC/PERF/DATA/BUS/OPS) as quality-gate inputs when NFR data exists | aligned already           |
| **QA Review (W2)** journeys + VQA                                   | `automate` (coverage expansion) + knowledge: `network-first`, `playwright utils`                   | Journey authoring reads `network-first.md` + selector patterns; optional `tea_use_playwright_utils` for generated Playwright scripts                                                         | later                     |
| **Quality gate** (story + plan)                                     | gate thresholds (P0 100%, P1 90/85%, …)                                                            | PORTED — keep `quality-gate.ts` as the deterministic oracle; TEA prose stays the spec we cite                                                                                                | done                      |
| **NFR inputs** (quality-gate's `criticalNfrFail` — currently unfed) | `nfr-assess` (evidence audit per NFR)                                                              | Run as a plan-close advisory agent on production-rigor plans; feeds quality-gate's NFR fields                                                                                                | later (production rigor)  |
| **W3 staging smoke / CI**                                           | `ci` (selective testing, burn-in)                                                                  | The promote pipeline's smoke step adopts `ci`'s burn-in pattern (run new/changed tests N× before trusting) + our selective-regression flag already mirrors "selective testing"               | W3                        |
| **Test quality audit**                                              | `test-review` (flakiness/hardwait scoring)                                                         | Periodic reflector-style job over an app's test suite; findings → fix stories                                                                                                                | later                     |
| **Operator/learning**                                               | `bmad-tea` agent + `teach-me-testing`                                                              | Available NOW in this repo as skills (`/bmad-tea`, `/bmad-testarch-*`) for design sessions                                                                                                   | done                      |

**Design rule (unchanged from the TDD blueprint):** TEA's workflows are AGENT prose —
where a decision must gate the pipeline, we keep the deterministic port (quality-gate,
riskTag, testBinding) and treat TEA as its spec + knowledge source. Agents consume TEA
knowledge; gates stay code.

## 3. First concrete wire-in (shipped with this change-set)

- `bmad-install.mjs` now installs `tea` into every generated app → `_bmad/tea/workflows/testarch/*`
  - `.claude/skills/bmad-tea*` land in the app worktree, so story-dev/test-author agents can
    read fragments and the skills federation picks the skills up (reconcile-skills-manifest pins them).
- This repo: `_bmad/tea/` + skills installed — `bmad-tea` (Murat, Master Test Architect),
  `bmad-testarch-{test-design,atdd,automate,ci,framework,nfr,test-review,trace}` invocable.

## 4. Next wire-in (recommended order)

1. **Test-author fragment injection** — in `test-author-phase.mjs`, when the app has
   `_bmad/tea`, append "Consult `_bmad/tea/.../knowledge/test-quality.md` +
   `fixture-architecture.md` before authoring" to the prompt. Zero-risk, immediate quality lift.
2. **PM risk rubric** — quick-planspec prompt gains TEA's probability×impact table so
   riskTags stop being heuristic-only.
3. **W3 smoke via `ci` burn-in** — changed-test burn-in in the staging gate.
4. **`nfr-assess` at production rigor** — feeds the quality-gate NFR inputs that are
   currently always false.
