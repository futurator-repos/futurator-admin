# applicator — Full Assessment Plan (unsupervised end-to-end run)

> **Generated:** 2026-06-19 by the full recon→detect→L3 chain.
> Detector (`hotspot-detect.mjs`) chose the hotspots; the `/assess-codebase-l3` dynamic
> workflow (4 agents, ~202k tokens, ~5.7 min) adjudicated them and produced this plan.
> **No human selected the targets.** Severity: HIGH. Read-only — no code modified.

This is the end-to-end validation of [`refactoring-assessment-pipeline.md`](./refactoring-assessment-pipeline.md):
`graphify → alias-resolve.mjs → hotspot-detect.mjs → hotspots.json → L3 /assess-codebase → plan`.

---

## Meta-result: the L3 layer corrected the L2 detector

The detector flagged `src/components/primitives` as part of the "triplicated design system"
(filename collision: button/card/badge). The adjudicator **read the code and rejected it**:
`primitives` is a _separate CV-export rendering layer_ (`var(--cv-*)` inline styles, an
`exportButton()` HTML generator) consumed only by `section-wrapper.tsx` + `lib/export/` —
merging it would break static CV export. **The agentic layer didn't trust the deterministic
layer; it verified and overruled it.** That adversarial check is the reason L3 exists.

## Three workstreams, sequenced by safety-to-start (all grep-verified)

### WS1 — Legacy retire-now (cheapest, zero-repoint orphan deletes) — START HERE

- **WS1-S1** _(first story)_: atomic delete of the `draft-editor-v2` cluster + `draft-preview-client-v2.tsx`. Grep-proven orphan (sole importer has zero importers; live preview route uses the non-v2 client).
- **WS1-S2**: delete the unwired `hierarchical` backing lib (`hierarchical-generation.ts`, `migrate-to-hierarchical.ts`, `useAIInsightsIntegration.ts`) — _after_ WS1-S1 (its only consumer was inside the v2 cluster). **Keep** the live hierarchical UI dir.
- **WS1-S3**: delete `page-old.tsx` (grep-zero, not a routable filename).
- **WS1-S4**: salvage-diff then delete `AIInsightsPanelEnhanced` + its keeper test. **Keep** `cv-editor-enhanced.tsx` (live).

### WS2 — Design-system consolidation (profile-editor/components/ui fork → canonical src/components/ui)

Zero external blast radius (every importer is inside the profile-editor subtree). Lowest-fan-in-first:

- **WS2-S1**: delete byte-identical `badge.tsx` fork (0 fan-in).
- **WS2-S2**: repoint the 1 `card.tsx` consumer, delete fork.
- **WS2-S3**: repoint the 14 `button.tsx` consumers, delete fork (unused `icon-sm/lg` variants confirmed droppable).
- **WS2-S4**: sweep remaining forked files — delete dup-of-canonical, **promote/keep fork-only** components (sidebar, calendar, toast, form…); never bare-delete. **`primitives` explicitly excluded.**

### WS3 — AWSProfileStorage god-object split (largest blast radius, last, test-gated)

1799-line class, 44 public methods, **38 importers**, cohesion 0.026.

- **WS3-S1**: characterization-test net per live domain (only 2 thin route tests exist today) — **mandatory before any extraction**.
- **WS3-S2**: extract shared `DynamoClient`/S3 base; unify the two doc-clients hitting `applicator-jobs`.
- **WS3-S3**: delete **12 grep-confirmed dead methods** (the legacy `SK=APPLICATION#/SEARCH#/CHAT#` job-tracking that duplicates the live `jobRepository SK=APP#`).
- **WS3-S4**: extract 7 domain repositories behind a **delegating façade** — public signatures preserved so all 38 importers compile unchanged.
- **WS3-S5** _(optional)_: migrate consumers off the façade per-domain, grep-gated.

## Grep-verified facts (this run used the graph correctly + grep, no fallback-only)

- AWSProfileStorage: 38 importers, 44 public methods, **12 dead** (0 callers each).
- profile-editor/ui fork: **0 external importers**; badge fan-in 0, card 1, button 14.
- Two data layers on `applicator-jobs`: AWSProfileStorage (`SK=JOB#/APPLICATION#`) vs `dynamodb-client.ts` jobRepository (`SK=APP#`) — keep namespaces distinct.

## Key risks

- **No characterization tests** for the god-object → WS3-S1 builds the net first.
- **primitives mis-flag** (detector filename collision) → excluded from WS2 (would break CV export).
- **Ordering**: WS1-S2 must follow WS1-S1 (shared orphaned consumer).
- Design-system repoints carry an accepted cosmetic delta (button `shadow-xs`, card `gap-1.5`).

Every deletion is gated on a final grep-zero check + typecheck/knip/build between steps. Stories
are ready for the existing epic/story dev pipeline (which writes tests + runs CI).
