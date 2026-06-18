# Onboarding: make a new app graph-ready

> Epic 7, Story 7.3. Stand up the System Graph for a new app and open its Graph
> tab — no help needed. Task-oriented; ~15 minutes.

The System Graph maps a repo's **code ↔ infra ↔ service** layer (and, federated,
the **cross-project contract spine**). Four deterministic, zero-LLM extractors
feed a single Memgraph instance via `graph-sync`. This guide wires them into a
new app.

## Prerequisites

- The app is a Next.js + SST repo with a Hono app at `functions/api/index.ts`
  and infra in `sst.config.ts` (the boilerplate default). Non-default paths are
  fine — you pass them as flags.
- Network access to the shared Memgraph (set `MEMGRAPH_URI`, and
  `MEMGRAPH_USER`/`MEMGRAPH_PASSWORD` if auth is on).
- A checkout of the daemon (`Futurator-Admin/daemon`) reachable from the app —
  the extractors + `graph-sync` live in `daemon/scripts`.

## 1. Add the wave-gate hook

Copy the boilerplate hook into your repo:

```bash
mkdir -p boilerplate/system-graph
cp <daemon>/boilerplate/system-graph/wave-gate-hook.mjs boilerplate/system-graph/
```

Call it from your wave-gate slot (or once, by hand) — it self-selects bootstrap
vs incremental:

```bash
SYSTEM_GRAPH_LIB=<daemon>/scripts/lib \
  node boilerplate/system-graph/wave-gate-hook.mjs --root .
```

- **First run** → a full-repo bootstrap (`bootstrap-ast --scan`) seeds the entire
  graph: AST (functions/classes/imports/calls) **plus** infra/route/service nodes
  and `CALLS_ENDPOINT` edges.
- **Later runs** → the incremental step (`runSystemGraphStep`): re-runs the four
  extractors + `graph-sync` for the changed surface only.

The hook is **non-blocking** — a graph failure never fails your wave gate.

## 2. (Optional) run an extractor directly

Each extractor is standalone and prints its envelope to stdout:

```bash
node <daemon>/scripts/infra-extract.mjs   --root . --config sst.config.ts
node <daemon>/scripts/route-extract.mjs   --root . --app functions/api/index.ts --lambda infra/lambda/Api
node <daemon>/scripts/service-extract.mjs --root . --files src/a.ts,src/b.ts
```

Non-default app/config paths: pass `--config`, `--app`, `--lambda` and the
wave-gate hook will inherit them (or pass them straight to `runSystemGraphStep`).

## 3. Confirm the graph populated

`graph-sync` writes `knowledge/_graph/graph-snapshot.json` (plus the analytics
overlays). The admin UI's **Development → Graph** tab fetches these from the
public S3 mirror. Open it and you should see your app's nodes; the architectural
X-ray (god-nodes, communities) appears once MAGE analytics run.

## 4. (Growth) join the cross-project contract spine

Once two or more apps are in the graph, run a federated sync to emit
`CONSUMES_CONTRACT` edges + capability coverage gaps:

```bash
node <daemon>/scripts/graph-sync.mjs --project <app> --knowledge-dir ./knowledge --global
```

The join strategy lives in `daemon/config/federation.json`
(`resource-identity` vs `schema-shape` — see
[`adr-federation-identity.md`](./adr-federation-identity.md)). With `--global`,
the Graph tab also flags **capability coverage gaps** and surfaces any
**PROPAGATOR port-briefs** (Epic 6) awaiting your approval.

## Troubleshooting

| Symptom                   | Cause                               | Fix                                                           |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| "tree-sitter unavailable" | grammar not installed               | `cd daemon && npm install`                                    |
| Empty graph after run     | config/app paths wrong              | pass `--config` / `--app` / `--lambda`                        |
| Graph tab empty           | snapshot not synced to S3           | check `graph-sync` ran + the S3 mirror sync                   |
| No `--global` panels      | <2 subgraphs, or no capability seed | bootstrap a sibling; add `knowledge/_graph/capabilities.json` |

## Where things live

- Extractors + sync: `daemon/scripts/{infra,route,service,ast}-extract.mjs`, `graph-sync.mjs`
- Reusable step / bootstrap: `daemon/scripts/lib/system-graph-step.mjs`, `system-graph-bootstrap.mjs`
- Boilerplate hook: `daemon/boilerplate/system-graph/wave-gate-hook.mjs`
- Graph tab: `src/app/development/graph/` + `src/components/development/graph-viewer.tsx`
