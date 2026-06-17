# Skills Institution — UX Design Specification

_Created 2026-06-17 by Richie · BMad Method — Create UX Design Workflow v1.0_
**Inputs:** `skills-institution-prd.md`, `skills-institution-architecture.md`
**Scope:** three operator surfaces — **Registry Growth inbox**, **Registry browse**, **Skill Builder**.

---

## Executive Summary

This is an **operator-grade internal tool**, not a consumer product. The single most important UX
outcome: **a curator can clear the queue fast and trust the registry at a glance** — ratifying a skill
should feel like approving a pull request, not filling a form. Everything inherits the Labs design
system; the registry must **never feel like a different app** (explicit prior feedback).

---

## 1. Design System Foundation

### 1.1 Design System Choice

**Reuse the existing Labs system verbatim** — Tailwind CSS 4 + shadcn/ui primitives
(`@/components/ui`), semantic theme tokens (`success`, `warning`, `accent-blue`), Geist font, dark/light
support. **No new design system, no color exploration, no bespoke chrome.** New components are
composed from existing primitives (Table, Card, Dialog, Badge, Tabs, Drawer). This is a hard
requirement, not a preference — consistency with the plan-dashboard is the brief.

> _Skipped from the generic template:_ interactive color-theme / design-direction HTML artifacts —
> unnecessary because the system is inherited, not chosen.

---

## 2. Core User Experience

### 2.1 Defining Experience

**"Clear the inbox; trust at a glance."** Two loops dominate:

- **Curate** — a queue of skill proposals arrives (from the reflector, manual create/paste, later bulk).
  The curator triages on **gists**, decides on **diffs**, ratifies with one deliberate click. Throughput
  matters: keyboard-driven, no modal mazes.
- **Consume/inspect** — browsing the registry, the curator instantly sees **what an agent will actually
  get** (`trusted`) versus what's merely on the shelf (`reviewed`) versus what's dangerous
  (`quarantined`) — via consistent badges, never by reading prose.

### 2.2 Novel UX Patterns

- **Gist → Diff ratification.** The triage unit is a one-line gist ("does this deserve my attention?");
  the decision unit is a unified diff ("approve this delta?"). You never re-read a whole skill.
- **Trust as a visual language.** `trustTier` + `securityStatus` + `provenanceClass` render as a fixed,
  learnable badge set everywhere a skill appears — list, drawer, inbox, scout proposal.
- **System-owned vs human-owned facets.** Computed facets (security/grade/provenance/maturity) are
  **read-only** in the UI; only `trustTier` is mutated by a human action. The UI makes this legible —
  you cannot accidentally "edit" a security verdict.
- **Conversation, not form (Builder).** The draft assembles visibly as the operator answers; the flow
  ends on a **green test result**, not a save button.

---

## 3. Visual Foundation

### 3.1 Color System (trust & security language)

Mapped onto existing semantic tokens — no new colors:

| Facet value                   | Token                 | Treatment                                                               |
| ----------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `trustTier: trusted`          | `success`             | solid badge — "agents get this"                                         |
| `trustTier: reviewed`         | `accent-blue`         | outline badge — "shelf only"                                            |
| `trustTier: draft`            | muted/neutral         | subtle badge                                                            |
| `trustTier: deprecated`       | muted + strikethrough | de-emphasized                                                           |
| `securityStatus: clean`       | `success`             | small shield-check icon                                                 |
| `securityStatus: flagged`     | `warning`             | shield-alert icon                                                       |
| `securityStatus: quarantined` | destructive/`warning` | filled shield-x — blocks ratify                                         |
| `provenanceClass`             | neutral               | small text chip (constitutional / vendored / app-evolved / third-party) |

---

## 4. Design Direction

### 4.1 Chosen Design Approach

**Dense operator dashboard**, identical in feel to `plan-dashboard`. Tables for lists, Cards for
summaries, a right-hand **Drawer** for detail/diff (matches existing skill detail pattern), Dialogs for
the Builder and confirmations. No marketing layouts, no hero sections. Information density and speed over
whitespace.

---

## 5. User Journey Flows

### 5.1 Critical User Paths

**J1 — Ratify a reflector skill proposal (Phase 1, the core loop).**
Plan Growth tab surfaces a `project-skill` lesson → curator opens it → sees gist + evidence + **diff** →
**Approve** → `REFLECTOR-APPLY` writes to the app's `.claude/skills/` → toast confirms commit → a later
plan loads it (visible in the plan's Skills-Used). _Curator did nothing but approve a diff._

**J2 — Manual growth via paste-URL (Phase 1).**
Registry → **+ Add skill** → paste URL (or write inline) → gate runs (merge/scan/label) → lands in the
**Growth inbox** as `draft` with a gist + security result → curator reviews diff → **Ratify → trusted**.
If Gate-1 flags it: appears **quarantined**, ratify disabled, pattern shown.

**J3 — Browse & filter the registry (Phase 1).**
Registry tab → filter chips (`trusted` / `reviewed` / `quarantined`, by `kind`, by provenance) → table
rows show name + badges + description → row → Drawer with body + facets + lineage. Trust is obvious
without reading.

**J4 — On-demand LLM security review (Phase 1).**
In an inbox item's drawer → **Run LLM review** button → async job → verdict appears as an **advisory**
panel (never blocks ratify; Gate-1 already decided blocking).

**J5 — Retro-scan review (Phase 1, one-time).**
Admin → **Retro-scan registry** → progress → `REPORT.md` summary (pass/quarantine counts) → quarantined
incumbents listed for triage in the inbox.

**J6 — Build a skill by conversation (Phase 3).**
**+ New skill (guided)** → Builder Dialog asks intent (mines current context first), centers on the
**trigger clause**, drafts visibly, runs should/should-not eval → shows **green test** → submits to the
gate → inbox.

### Keyboard model (throughput)

Inbox: `j/k` move, `Enter` open diff, `a` approve, `x` reject, `d` defer, `r` run LLM review. Approve on
a `quarantined` item requires an explicit confirm (override).

---

## 6. Component Library

### 6.1 Component Strategy

Reuse existing primitives; add a small set of composed components:

| Component                                          | Built from                                           | Used in                    |
| -------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| `TrustBadge` / `SecurityBadge` / `ProvenanceBadge` | `Badge` + icon                                       | everywhere a skill appears |
| `SkillDiffViewer`                                  | new (lightweight unified-diff render)                | inbox drawer (J1, J2)      |
| `ProposalRow`                                      | `Table` row + gist + badges                          | Growth inbox               |
| `RegistryTable`                                    | existing skills table + filter chips                 | Registry browse            |
| `SkillDrawer`                                      | existing detail Drawer + facets panel + lineage      | browse + inbox             |
| `LlmReviewPanel`                                   | `Card` (advisory)                                    | inbox drawer               |
| `BuilderChat`                                      | `Dialog` + chat list + live draft pane + test result | Skill Builder (P3)         |
| `RetroScanReport`                                  | `Card` + counts + list                               | retro-scan (J5)            |

Only genuinely new primitive: **`SkillDiffViewer`** (everything else composes existing UI).

---

## 7. UX Pattern Decisions

### 7.1 Consistency Rules

- **Badges are mandatory** wherever a skill is shown — never display a skill name without its
  `trustTier` + `securityStatus`.
- **Ratify is one deliberate action**, visually distinct (primary `success`). Quarantined override needs
  a confirm step.
- **Computed facets are read-only**; only `trustTier` changes via human action. No "edit security" affordance.
- **Diff is the decision surface** — ratify controls live next to the diff, not the gist.
- **`trusted` vs `reviewed` always visually separated** in any list (the safety distinction must be glanceable).
- **Reuse Labs empty/loading/error states** (no bespoke spinners) — the prior "another app" complaint
  came from inconsistent shells.

---

## 8. Responsive Design & Accessibility

### 8.1 Responsive Strategy

**Desktop-first, single-operator.** Optimized for a wide viewport (table + drawer side-by-side); usable
but not optimized on tablet; mobile not a target. Accessibility: full **keyboard navigation** for the
inbox (the throughput surface), focus-visible states, semantic roles via shadcn primitives, sufficient
contrast from theme tokens. WCAG AA-level color contrast inherited from the Labs tokens; no audio/video.

---

## 9. Implementation Guidance

- **Phase 1 surfaces:** Growth inbox (`ProposalRow`, `SkillDiffViewer`, ratify flow), Registry browse
  labels/filters (`TrustBadge`/`SecurityBadge`/`ProvenanceBadge`, filter chips), `LlmReviewPanel`,
  `RetroScanReport`. Wire to the API contracts in the architecture doc (`/api/skill-proposals*`).
- **Phase 3 surface:** `BuilderChat` (the conversational Builder).
- **Hard constraints:** `@/components/ui` primitives only; match `plan-dashboard` density and shells;
  no new design system; trust/security badges are first-class and ubiquitous.
- **Definition of done (UX):** a curator can triage and ratify a proposal end-to-end with the keyboard,
  and can tell `trusted` from `reviewed` from `quarantined` at a glance in any list.

---

_Generated using BMad Method — Create UX Design Workflow v1.0 · For: Richie_
