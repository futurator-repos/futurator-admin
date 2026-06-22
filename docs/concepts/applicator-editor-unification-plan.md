# applicator — Editor Unification Plan (L3 workflow output)

> **Generated:** 2026-06-18 by the `/assess-codebase` dynamic workflow (run `wf_fa53a7d0-d95`).
> 4 agents (3 read-only `version-adjudicator`s + 1 Judge), ~224k tokens, ~4.5 min.
> First real L3 adjudication of the [refactoring assessment pipeline](./refactoring-assessment-pipeline.md).
> **Severity: HIGH.** This is a _plan draft_ for the existing dev pipeline — no code was modified.

---

## Verdict on the 3 parallel editor systems

| System                                                                 | Files | Classification      | Fate                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **profile-editor** (`src/components/profile-editor/components/editor`) | 25    | **canonical**       | **Keep & build on.** Richest model (CVDocument: sections→typed cards→fields, inline edit, draft lifecycle, section merge). Mounts the live `/edit/[slug]` route; **11 dependents**; upstream of pdf's CVData. |
| **pdf-editor** (`src/components/pdf-editor`)                           | 29    | **specialized**     | **Keep, refactor onto shared core.** Print/PDF concern is genuine (PageSettings, pagination, QR, media, luminance color resolver).                                                                            |
| **draft-editor-v2** (`src/components/draft-editor-v2`)                 | 15    | **legacy/orphaned** | **Retire.** Raw-html/iframe paradigm, shares no code; its only importer (`draft-preview-client-v2.tsx`) has **zero importers** — the live preview route uses the non-v2 client.                               |

## Shared core to extract → `src/components/editor-core/`

Verified near-identical across profile-editor and pdf-editor: `GlobalStyles` (same fields + Ubuntu/`#E95420` defaults), `Section {id,name,visible,order,category}`, `SectionVariants`, `ActivePanel`, `ChatMessage`, the reorder/toggle/move-active/move-inactive reducers, `EditableText`, panel chrome, even the same "Joe Doe" seed.

- **Extract:** (A) shared type contracts, (B) a generic `createEditorContext` factory + `useEditorState`, (C) shared UI primitives.
- **Do NOT extract:** pdf-only print concerns (stay in pdf-editor); draft-v2's iframe paradigm (deleted).

## Sequenced steps (every deletion graph/grep-verified safe)

1. **test** — Playwright characterization net for `/edit/[slug]` (profile-editor) + `/cv` (pdf-editor). _No flow-level tests exist today._ Must pass on the untouched tree first.
2. **verify** — prove draft-editor-v2 dependency closure (zero live dependents).
3. **extract** — harvest any shared `template-gen` glue from draft-v2 (verified likely no-op).
4. **delete** — remove draft-editor-v2 + draft-preview-client-v2; gate on knip+typecheck+build+e2e.
5. **extract** — shared TYPE contracts into editor-core (type-only, lowest risk).
6. **extract** — generic `createEditorContext` + `useEditorState` factory, with unit tests, no consumer repointed yet.
7. **repoint** — profile-editor onto the core, **preserving the public `useEditor` API** so all 11 dependents compile unchanged.
8. **repoint** — pdf-editor onto the core, **keeping CVData untouched** (6 external importers incl. the AI agent pipeline) and print layers on top.
9. **verify** — `npm run ci` + full e2e + grep that `GlobalStyles`/`Section` exist only in editor-core.

Stories mirror these 1:1, each with `dependsOn`, ready for the epic/story dev pipeline.

## Key risks (from the workflow)

- **No characterization tests** for live authoring flows → Story 1 builds the Playwright net _first_ (gates steps 4,7,8,9).
- **`CVData` is a shared contract** (6 importers incl. AI routes) → must not move/reshape during the pdf repoint.
- **profile-editor's public `useEditor`** (11 dependents) → preserve the signature, swap the implementation underneath.
- **Name-collision trap:** `draft-preview-client-v2.tsx` (delete) vs `draft-preview-client.tsx` (live) — delete only the -v2 chain.

---

## Tooling finding — CORRECTED 2026-06-19 (my earlier "edge-less" claim was wrong)

**RETRACTED:** the prior version of this section claimed `graph.json` has no edges (`jq 'has("edges")'` → `false`). That was a bug in _my_ analysis, not graphify. graphify writes **networkx node-link format** — edges live under **`"links"` (7,991 directed edges)**, not `"edges"`. The graph was never edge-less. My L3 workflow prompt told the adjudicators to query `.edges`, so they found nothing and (correctly, given that) fell back to grep/knip.

**Corrected implications:**

- Directional reachability (`blast_radius`/`neighbors`, in-degree vs out-degree) **is** available from graphify's JSON via `.links` + the `directed` flag. `--directed` preserves source→target order — which is exactly what let the follow-up trace separate "AWSProfileStorage is big" (47 out-edges = owns methods) from "everyone needs it" (38 in-edges = depended upon).
- §12 (structural Memgraph) is **not required to get edges** — it stays a _nice-to-have_ for a clean MCP query surface, but the recon graph already carries adjacency.
- The real lesson is a **query-contract** one: agents must not hand-roll `jq` against a guessed key. Wrap graph access behind a proper `.links`-aware interface (the Mycelium/graphify MCP) so the key is never wrong.

## Tooling finding #2 — AST symbol-level dead-code is unreliable on JSX/React/TS

A follow-up trace grep-verified graphify's 1,072 weakly-connected nodes (~25%) and found them **mostly AST false positives**: `cn()` flagged unused but called in **158** files (AST blind to `className={cn(...)}` JSX call sites); `awsProfileStorage.getUserProfile()` flagged unused but called in 8 routes (instance-method dispatch `storage.method()` unresolved); 42 of AWSProfileStorage's own methods flagged unused despite 37 importers.

**Design consequence (important):** treat graphify "weakly-connected / zero-usage" as _"AST couldn't draw the edge,"_ **not** "dead." Symbol-level dead-code needs a real call-graph resolver (ts-morph / TS language service) that handles JSX, instance dispatch, hooks, and callbacks. **knip** (TS-resolver-backed, file/export level) stays the reliable dead-code signal; graphify's strength is _architectural_ clutter (god-objects, low-cohesion communities, duplicate subsystems), not symbol-level dead functions.

## Tooling finding #3 — graphify's inbound/usage edges are unreliable on alias-heavy TS (the decisive one)

**Root cause of #2 and the design-system mis-read:** graphify does **not resolve `@/…` tsconfig path-alias imports** to their target symbol nodes. applicator has **1,589 `@/` alias imports vs 471 relative (~77% aliased)**, so most usage edges never land. Proof: `components/ui/button.tsx` (`<Button>`) shows graph **in-degree 1** but is actually imported by **130 files** (127 `<Button>` JSX usages) — a textbook design-system **hub** the graph reports as a leaf. Same cause as `cn()`-in-158-files and the 1,072 weakly-connected (~25%).

**Consequences:**

- **In-degree / fan-in / "who uses this" / dead-code / design-system-hub reads are NOT trustworthy** from graphify on any alias-heavy codebase — i.e. most modern Next.js/TS apps.
- **What stays reliable** (does not depend on inbound alias resolution): ownership edges (`contains`/`method`), community detection, and **god-object detection by out-degree + method-count + cohesion**. That is exactly why the AWSProfileStorage god-object and the dynamodb-client duplicate-layer held up under grep, while dead-code and design-system did not.
- **Required enhancement:** before consuming graph edges for usage/hub/dead-code, **resolve imports through the tsconfig `paths` map** — either post-process graphify's edges, or use a TS-resolver-backed tool (**knip**, **ts-morph**, **madge --ts-config**) for the inbound half. The in-house tree-sitter extractor (`feat/treesitter-slice-c-brownfield-bootstrap`) **MUST resolve tsconfig paths** or it inherits the same blindness.

**Edge schema (for correct usage counting):** edges are under `.links` (networkx node-link), with `.source`/`.target` (node IDs), **`.relation`** (`contains` 3335 = ownership · `imports` 1859 = usage · `re_exports` 376 = usage · `method` 313 = ownership · `calls` · LLM-semantic `conceptually_related_to`/etc.), `.context` sub-qualifier, plus `.confidence`/`.confidence_score`/`.weight`. **Real "is used" = count in-edges where `relation ∈ {calls, imports, re_exports}`, excluding ownership (`contains`/`method`)** — and only after alias resolution.
