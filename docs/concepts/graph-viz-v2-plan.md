# Graph Viz v2 — build plan (best-of-three synthesis)

> **Goal:** rebuild the in-app code-knowledge graph (`src/components/development/graph-viewer.tsx`)
> as a full-bleed, graph-as-hero experience. Take the best of three references and
> apply them to our (Mycelium) profile/code-graph context.
> **Owner:** graphify · **Created:** 2026-06-18

## Decisions (locked with operator)

- **Tech:** stay on `react-force-graph-2d` + `d3-force` (what we AND v0 already use — no
  renderer migration). graphify's organic look = `linkCurvature` + force tuning; claude's
  zones/Blast = ported canvas algorithms.
- **Theme:** follow the app's light/dark theme (palette adapts; not dark-only).
- **Layouts:** all three — **A Force Atlas · B Layered Lanes · C Community Orbit**.
- **Scale:** single project (~200–500 nodes) — canvas is smooth, no LOD work.
- **Inspector:** full inline knowledge browser (metadata + relationships-by-edge-type +
  rendered article markdown + semantic-similar neighbours).
- **Layout:** full redesign, graph as the main actor, redistribute all elements — **keep the
  accordions** (Unconnected / Dead code / Architectural X-ray / Compiler activity), moved
  into panels.

## Best-of-each → what we adopt

| From                 | Idea                                                                                                                        | How                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **graphify**         | organic curved edges + mycelium force layout                                                                                | `linkCurvature≈0.18`, tuned charge/link distance/velocityDecay                                       |
| **claude.ai/design** | per-kind node icons, community **zones**, Blast-radius explore                                                              | port `graph-engine.js` icon glyphs + `_drawHulls` (centroid+maxR translucent blob) + 2-hop BFS blast |
| **v0.app**           | collapsible left rail (layers/kinds/overlays), edge-type filtering, right inspector + insights, token search, 3 layout tabs | port catalog/analysis/icons + component structure                                                    |

## Data model (our 5 `_graph/*.json`)

- `graph-snapshot.json` — `nodes[]` (kind: file/function/class/dir + null-kind docs) + `edges[]`
  (DEFINES/IMPORTS/CALLS/RENDERS/CONTAINS/DEPENDS_ON/REFERENCES).
- `insights.json` — `godNodes[]`, `communities[]`, `surprisingConnections[]`,
  `nodeMetrics{id→{centrality,community}}`, `engine`.
- `orphans.json` — already splits `genuineOrphanCount` vs `legitimateFloaterCount` + delta +
  threshold → renders directly as the red/green **integrity card** (no backend work).
- `dead-code.json`, `git-graph.json` — the remaining accordions.

## Component breakdown

```
src/lib/graph/
  catalog.ts     # KIND_META / EDGE_META / LANES / communityColor (adapted to our kinds)
  icons.ts       # per-kind SVG → cached HTMLImageElement for canvas
  analysis.ts    # parseQuery, buildAdjacency, computeBlast, communityHulls
src/components/development/
  graph-canvas.tsx     # the hero: ForceGraph2D w/ curves, icons, zones, 3 layouts, theme-aware   ← Pass 1
  graph-viewer.tsx     # shell: top-bar(layout tabs+overlays+search) · left rail · right inspector+insights · accordions   ← Pass 2 redistribute
  (reuse) dead-code-panel.tsx, arch-xray-panel.tsx, capability-gap-panel.tsx, article-viewer.tsx
```

## Phases

- **Pass 1 (this change):** `lib/graph` foundation + `graph-canvas.tsx` (curved edges, per-kind
  icons, community-zone overlay, X-ray sizing, A/B/C layouts, search/focus/selection/similarity,
  theme-aware). Swapped into the existing shell behind a layout/overlay top-bar — visible now.
- **Pass 2:** full-bleed shell redistribution — left filter rail, right inspector (inline
  article browser + relationships-by-type), insights panel, accordions moved into panels.
- **Pass 3 (polish):** Blast Orbit radial layout + Blast-radius explore, light-mode tuning,
  saved views.

## Adaptations from v0/claude (our context has less)

- Drop `cost lens` / billable rings (no external-service/cost nodes).
- Drop `extracted-only` provenance filter (our edges carry no INFERRED/AMBIGUOUS yet).
- Map v0's 25 kinds → our `file/function/class/dir` + doc kinds (`decision/system/index/log`).
- Lanes collapse to **DOCS · CODE** (we have no API/Infra/Events/External layers).
