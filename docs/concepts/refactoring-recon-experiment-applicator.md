# Recon Experiment #2 — `applicator` (L0–L2, the real target)

> **Date:** 2026-06-18 · **Patient:** `~/GetReal/applicator` (Next.js, 659 code files in `src/`)
> **Goal:** does the L0–L2 foundation surface the **Type-B legacy duplication** (profile
> v1/v2/v3, onboarding, multiple editors) on the real swamp?
> **LLM cost: ~0** (AST-only; semantic pass on 3 docs/30 images deliberately skipped).
> Follows [`refactoring-recon-experiment-reborders.md`](./refactoring-recon-experiment-reborders.md).

---

## L0 — Tooling census

eslint (legacy `.eslintrc.json`) ✓ · **knip configured** ✓ · strict TS ✓ · test runner ✓ ·
prettier ✗ · husky ✗. More tooling than its reputation — the problem here is **structure**,
not missing instruments.

## L1 — Deterministic surface

- **tsc `--noEmit`:** 13 errors.
- **knip:** **22 unused files, 206 unused exports, 69 unused exported types, 13 duplicate
  exports**, 4 unused deps, 22 unlisted deps.
- **Same false-positive class as reborders:** knip flagged `vitest`, `@playwright/test`,
  `@testing-library/*` as "unused devDependencies." Test tooling, obviously live. → the
  "classify, never delete" rule holds on the second repo too.
- **13 duplicate exports** = a Type-B fingerprint (same symbol exported from rival versions).

## L2 — Graph (AST-only, 0 tokens)

`4307 nodes, 7952 edges, 296 communities` — built in ~1 min, no LLM.

### Communities ≠ folders, confirmed at scale

Largest communities routinely span many folders: c5 spans **6**, c6 spans **7**. The real
modules cut across the directory tree just as the design predicted — more so here than on the
tidy reborders.

### Type-B legacy duplication — surfaced (this is the payoff)

The graph + structural path analysis found exactly the clutter described, none of which knip
can flag (it's all _reachable/live_):

**Three+ parallel editor systems, each reinventing the same context architecture:**
| System | Evidence |
|---|---|
| `profile-editor/components/editor` | `data-context.tsx`, `useEditor`, `useData` (god-nodes) |
| `pdf-editor` | `pdf-editor-context.tsx`, `pdf-data-context.tsx`, `section-context.tsx`, `usePdfEditor`, `usePdfData` |
| `draft-editor-v2` | 8 files + `panels/` + `drawers/` — the **`-v2`** implies an unretired v1 |

The two top context god-nodes are `useEditor`/`useData` **and** `usePdfEditor`/`usePdfData` —
mirror-image hooks proving the duplication structurally. This is a textbook
**extract-shared-core** (one editor engine, three thin adapters).

**Explicit version markers in paths:** `-v2` (16 files), `v1` (10), `hierarchical` (10),
`enhanced` (6), `old` (1). `EnhancedSectionEditor.tsx` (knip's first unused file) and the
`hierarchical/` editor variant are concrete retire-or-merge candidates.

**Feature sprawl:** "profile" appears across **32 distinct directories**
(`profile/`, `profile-editor/`, `profile-renderer/` + deep `ui`/`ai`/`editor` subtrees).
Generation logic is split across `generation/`, `cv-generation/`, `template-gen/`,
`cv-templates/`, and ≥4 parallel `app/api/ai/*` orchestrators (`cv-generate`,
`cv-orchestrator`, `draft-orchestrator`, `template-generate`).

### God-nodes (risk map)

`types/user-profile/UserProfile` (#1 — the central type everything imports),
`lib/aws-profile-storage`, `lib/search-providers`, the editor/data context hooks. Touch last,
characterize first.

---

## Verdict — the design holds at 710-file scale

1. Communities ≠ folders, **more dramatically** than on reborders (7-folder spans). ✅
2. **Type-B legacy duplication surfaced** — 3 editor systems, profile across 32 dirs, rival
   generation pipelines, explicit `-v2`/`v1`/`enhanced`/`hierarchical` markers. The thing
   you most wanted to see, found structurally. ✅
3. knip false-positives repeated (test tooling) → "classify, never delete" reconfirmed. ✅
4. **0 LLM tokens** for the entire structural recon of a 4307-node graph. ✅

### This is precisely where the L3 dynamic workflow earns its tokens

Fan-out width is **a handful**, not 4307: ~`{ unify-editor-engine, consolidate-profile,
merge-generation-pipelines, retire draft-editor-v1, retire EnhancedSectionEditor/hierarchical }`.
Each hotspot → one `version-adjudicator` agent that queries the graph (`blast_radius`,
`neighbors`) to plan the extract→repoint→delete sequence and prove each deletion safe. The
deterministic layers converted "read 4307 functions" into "adjudicate ~5 pre-localized
hotspots."

## Next steps

- Build the **L1 classifier** (knip finding → `safe-candidate` if in a disconnected community,
  `false-positive` if a test/config dependency).
- Draft the **L3 `/assess-codebase`** workflow + `version-adjudicator` subagent against the
  editor-unification hotspot as the first real adjudication.
- A semantic pass (graphify `--mode deep` or Mycelium embeddings) would cluster the 3 editors
  by _behavioral_ similarity, not just naming — the next fidelity tier when tokens are warranted.
- Artifacts: `~/GetReal/applicator/graphify-out/graph.json` (3.9 MB).
