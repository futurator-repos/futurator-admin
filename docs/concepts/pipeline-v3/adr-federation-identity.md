# ADR — Federation Identity & `CONSUMES_CONTRACT` Join Strategy

**Status:** Accepted (2026-06-16) · **Epic 5, Story 5.4** · Resolves PRD §12 / **W9**

## Context

The cross-project contract spine (Epic 5, PRD §7.1–7.3) joins each sibling
project's subgraph to **shared contract nodes** (tables / endpoints / events) via
`CONSUMES_CONTRACT`. The join can be computed two ways, and which is correct
depends on a fact that **cannot be settled from this repo alone** (PRD §12, the
one open design question): _do the siblings consume the **same deployed SST
backend**, or **separate deployments** of the same schema?_

- **Shared backend** → siblings share table ARNs / API origin → join on
  **resource identity** (cheap, exact).
- **Separate deployments** → no shared ARNs → must join on **schema shape**
  (table `fields` + `primaryIndex`, endpoint `method`+`path`, event name) — props
  Epic 1 already captures.

## Decision

Adopt **`resource-identity`** as the default join strategy, recorded in
`daemon/config/federation.json` and consumed by `graph-sync --global`
(Story 5.1). Both strategies are implemented in `daemon/scripts/lib/federation.mjs`
and selectable by config, so the answer to W9 never invalidates the work.

**Why resource-identity first:** the controlled measurement app (`Twindle`, the
`test-bench-rubric.md` multi-surface scenario) is deliberately built as **one
deployed SST backend** so the siblings genuinely share table ARNs. This
exercises the cheap path first and pins the identity question empirically rather
than by assumption.

## Consequences

- `federation.json.strategy` is the single switch. Flip to `schema-shape` the
  moment a real sibling (Mobile / Office) is confirmed to be a **separate**
  deployment; no code change required — `contractKey()` already handles both.
- Rows lacking the props a strategy needs (e.g. a table with no ARN under
  resource-identity) are surfaced as `unjoinable`, never silently mis-grouped.
- The schema-shape path is validated by unit tests today
  (`graph-sync.global.test.mjs`) even though production currently runs
  resource-identity, so switching is a config flip, not a rewrite.

## Revisit when

A sibling project is deployed independently (its own SST stack / table ARNs), or
the bench measurement moves off the shared-backend `Twindle` scenario.
