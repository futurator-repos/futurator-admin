# Recon Experiment #1 — `reborders` (L0–L2)

> **Date:** 2026-06-18 · **Patient:** `~/GetReal/reborders` (Next.js 15, 22 TS source files)
> **Goal:** validate the deterministic foundation of
> [`refactoring-assessment-pipeline.md`](./refactoring-assessment-pipeline.md) on a small
> real repo before pointing it at `applicator`. **Tune the instrument on the easy patient.**
> **LLM cost: ~0** (L0/L1 are CLI; L2 graphify on a code-only corpus is pure AST, no semantic pass).

---

## L0 — Tooling census

| Tool                | reborders   | Note                                       |
| ------------------- | ----------- | ------------------------------------------ |
| eslint (flat)       | **PRESENT** | `eslint.config.mjs` + `eslint-config-next` |
| tsconfig strict     | **true**    | already strict                             |
| prettier            | MISSING     |                                            |
| knip                | MISSING     |                                            |
| test runner         | **NONE**    | no vitest/jest — the safety-net gap        |
| husky / lint-staged | MISSING     |                                            |

**Lesson (meta):** my first quick census script gave a **false-negative on eslint** (a buggy
`ls` glob). _The census tool itself must be robust_ — a sloppy detector under-reports tooling
and misdirects the whole pipeline. Detection is a first-class, testable L0 concern.

## L1 — Deterministic surface

- **tsc `--noEmit`:** 5 type errors, all in `src/models/Content.ts` (mongoose typing).
- **eslint:** 12 problems (mostly `no-explicit-any`, one unused import).
- **knip:** 4 unused files, 19 unused deps, 2 unused devDeps, 1 unused type.

### The money shot — knip is a hypothesis, not an action

knip flagged **`eslint` and `eslint-config-next` as "unused devDependencies"** — the very
linter we had _just run successfully_ seconds earlier. Blindly acting on knip would
`npm rm` the linter. It also flagged two **mongoose models** (`Content.ts`, `Section.ts`)
as unused files — static analysis can't see runtime model registration, and there are **no
tests** to catch a bad delete.

> **Empirical confirmation of the design's central rule:** L1 must **classify and propose,
> never delete.** Removal is a test-gated story for the dev pipeline, under a thin
> app-level behavioral net. The false positive was not hypothetical — it appeared on the
> first real repo.

## L2 — Graph (graphify cold-build)

`64 nodes, 58 edges, 13 communities` — pure AST, **0 tokens**.

### Headline: communities ≠ folders (proven)

| Community | n   | Folders spanned                                                                | What it really is                                                                    |
| --------- | --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **1**     | 12  | **4** — `app/api/auth/[...nextauth]`, `app/api/auth/register`, `lib`, `models` | **The auth/db/user spine** — one cohesive module scattered across a layer-based tree |
| 0         | 14  | 5 — `app`, `app/contact`, `app/donate/success`, `app/manifest`, `components`   | Public content/pages surface                                                         |
| 2         | 7   | 1 — `app`                                                                      | App shell (layout, providers, font, metadata)                                        |
| 3         | 6   | 1 — `lib`                                                                      | **S3 storage module** — self-contained, _disconnected_                               |
| 6         | 3   | 1 — `app/api/donate`                                                           | Stripe payment route                                                                 |
| 7         | 3   | 1 — `models`                                                                   | `Content` model — isolated                                                           |
| 8         | 3   | 1 — `models`                                                                   | `Section` model — isolated                                                           |

Even on a _tidy_ 22-file app, the graph recovered a 12-node module the folder tree splits
across **four** directories. On `applicator` ("no ordered folders"), this is the restructuring map.

### God-nodes (the risk map — characterize first, touch last)

`connectDB` (#1), `register` route, `Providers`, `authOptions`, the NextAuth handler, the
Stripe `donate` route. The DB-connection singleton topping the list is exactly right — every
API route depends on it.

### Triangulation, in miniature

The three knip "unused files" that are _not_ false positives — `s3.ts`, `Content.ts`,
`Section.ts` — show up in the graph as **disconnected single-folder communities** (3, 7, 8).
**Two independent methods (knip + graph structure) agree** → high-confidence dead-code
candidates. (`eslint`, by contrast, knip-flagged but graph-and-reality-alive → the divergence
that exposes the false positive.) This is the graphify-vs-Memgraph oracle pattern at toy scale.

---

## Verdict

The deterministic foundation **works and is honest**:

1. Communities-vs-folders tells the truth — the load-bearing assumption holds. ✅
2. knip produces real false positives → "classify, never delete" is validated on real code. ✅
3. knip ⋂ graph agreement gives a confidence signal for free (triangulation). ✅
4. god-nodes surface the risk map deterministically. ✅
5. Whole L0–L2 pass on this repo cost **~0 LLM tokens.** ✅

## Next steps

- Run the same L0–L2 on a **mid-size** patient (`Spreekify`, 132 files) to see if communities
  stay legible as size grows — and whether the semantic LLM pass becomes worth its cost.
- Then `applicator` (710 files, has eslint) — the real target, where Type-B legacy
  (profile v1/v2/v3, onboarding v1/v2) should surface as duplicate-version communities.
- Build the L1 **classifier** that tags knip output as `safe-candidate` vs `needs-graph`
  (a dep flagged unused but imported by config = false positive; a file in a disconnected
  community = corroborated).
- Artifacts for this run live at `~/GetReal/reborders/graphify-out/` (`graph.json`,
  `GRAPH_REPORT.md`).
