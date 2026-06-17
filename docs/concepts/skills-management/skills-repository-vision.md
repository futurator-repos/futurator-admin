# Skills Repository — Vision & Concept

**Status:** Brainstorming input · **Date:** 2026-06-17 · **Type:** Concept (not a committed plan)
**Purpose:** Capture everything built, investigated, and proposed for the Futurator skill
registry so we can brainstorm the next phase (quality, agentic creation, merge-at-scale).
**Companion:** `skills-management-plan.md` (the executed Phase 0–4 build log).

---

## 0. TL;DR

We turned a metadata-only catalog into a **245-skill content store with an embeddings index**.
That solved _volume_ and _body CRUD_. The next frontier is turning volume into **quality**:
measure every skill, retrieve intelligently, merge duplicates into a rubric-gated canonical set,
and create new skills **agentically** (a conversation + an eval loop, not a form).

The mental model: **the registry is a warehouse, an app's `.claude/skills/` is the carry-on,
and SKILL-SCOUT is the retrieval bridge.** Skills can scale to thousands _only_ if a retrieval
layer gates what ever reaches a model's context.

---

## 1. Where we are today (built & shipped)

| Phase | What                                                            | State    |
| ----- | --------------------------------------------------------------- | -------- |
| 0     | Reconcile + wire federation (on-disk == manifest == federation) | ✅ live  |
| 1     | Read-only catalog + search + drift view (`/labs/skills`)        | ✅ live  |
| 2     | Authoring CRUD (add/edit/remove → commit to `futurator-skills`) | ✅ live  |
| 3     | Federation source CRUD                                          | ⏸ parked |
| 4     | **Scale the registry** (this thread)                            | ✅ live  |

**Phase 4 detail (2026-06-17):**

- The registry repo `futurator-repos/futurator-skills` was a **card catalog with no stacks** —
  `index.json` metadata only, zero bodies → every skill showed "No body on file."
- `scripts/ingest-skills.mjs` vendors bodies from curated sources
  (anthropics/skills, vercel-labs, obra/superpowers, trailofbits, remotion, mattpocock, coreyhaines).
- Result: **59 → 245 skills, 189 with full bodies**, each stamped with license + provenance.
- **`index.embeddings.json`** committed — Voyage `voyage-3` (1024-dim) vectors over
  name+description+body. The retrieval Tier-3 artifact.
- Registry UI is Registry-first, shares Labs UI primitives, body view + CRUD work.

**The 245 are unmeasured and uncurated** — ingested from external repos with no triggering evals,
no quality grade, and probable redundancy (e.g. 74 security + 45 marketing skills likely overlap).

---

## 2. What we investigated (primary sources)

- **Anthropic — _The Complete Guide to Building Skills for Claude_** (PDF). Quality canon:
  description structure, progressive disclosure, success criteria, the three test types.
- **`anthropics/skills` → `skill-creator`** (485-line SKILL.md + an eval framework:
  `run_eval.py`, `run_loop.py`, `improve_description.py`, benchmark aggregation, blind A/B).
  This is Anthropic's _agentic_ skill-creation + measurement loop.
- **BMAD `bmb` (BMad Builder) module** — vendored in-repo at `bmad/bmb/`. The elicitation engine:
  `create-agent` / `create-workflow` / `create-module`, plus `edit-*`, `audit-workflow`,
  `convert-legacy`. Each workflow = `workflow.yaml` + `instructions.md` (`<step>` interview) +
  `template.md` + `checklist.md` (rubric).
- Reddit "building skills for a month" — blocked by fetch; lessons subsumed by the above.

### Converging principles (all three sources agree)

- **The description is the product.** `[what] + [when/triggers] + [capabilities]`, <1024 chars.
  Triggering is a _measurable, optimizable_ quantity. Under-trigger → make it "pushy", add keywords.
  Over-trigger → add **negative triggers**, be specific.
- **Progressive disclosure** — 3 levels (metadata / SKILL.md body <500 lines / bundled resources).
- **Explain _why_, don't command** — ALL-CAPS MUSTs are a yellow flag; reframe with reasoning.
- **Don't overfit** — skills are used a million times; generalize from feedback.
- **Bundle deterministic work** — if every run rewrites the same helper, ship it as a script.
- **Skills are living documents** — iterate from real failures.

---

## 3. Core architecture insight

**Why retrieval is mandatory at scale:** Claude loads every available skill's name+description at
startup (~100 tokens each).

| Skills loaded | Startup token cost | Selection quality                      |
| ------------- | ------------------ | -------------------------------------- |
| 59            | ~6k                | fine                                   |
| 300           | ~30k               | degrading                              |
| 1,000         | ~100k              | broken (window is mostly a skill menu) |

So you must **never** load the warehouse into an app session. Correct shape:

- **Registry = warehouse** — hundreds/thousands of skills, never all loaded.
- **App `.claude/skills/` = carry-on** — only the handful relevant to that app.
- **SKILL-SCOUT = retrieval bridge** — given a plan's intent, queries the embeddings index
  (vector top-k → rerank → shortlist) and installs only the winners.

Substrate already present: Voyage embeddings + Memgraph (Mycelium) are in the stack
(`daemon/mcp/mycelium-mcp.mjs`, voyage key in SSM). The JSON sidecar is the first cut;
the Memgraph graph (co-activation edges from `skill_activated` events) is the upgrade path.

---

## 4. Proposals (open directions for brainstorming)

### A. Wire retrieval into SKILL-SCOUT _(the immediate quality lever)_

Embed plan intent → cosine top-k over `index.embeddings.json` → small-LLM rerank → shortlist.
The scout proposes from the shortlist instead of scanning all 245 descriptions.
Daemon change + deploy. **Without this, tripling the catalog makes the scout noisier.**

### B. A quality rubric + trust tiers _(measure the corpus)_

Every skill gets a **grade** and a **trust tier** (`draft → reviewed → trusted → deprecated`).
Rubric dimensions (BMAD checklist ⊕ PDF success criteria ⊕ skill-creator evals):

- **Triggering score** — from real should/should-not eval runs (train/held-out, 3× per query).
- **Body quality** — progressive disclosure, explains-why, examples, <500 lines, no ALL-CAPS.
- **Single-purpose**, **has-tests**, **license/provenance clean**, **security** (least-surprise).

SKILL-SCOUT only proposes `trusted`; the UI filters by grade. Stored as a per-skill quality
record (sidecar `quality.json` or fields on `index.json`).

### C. Dedup → canonical merge _(turn volume into a curated set)_

Use the embeddings to **cosine-cluster near-duplicates** (graphify/Mycelium community detection).
For each cluster, an agent **synthesizes the best of each into one rubric-winning canonical skill**
and deprecates the rest with `supersededBy` redirects. `skill_activated` usage breaks ties.

### D. Agentic Skill Builder _(creation as a conversation, not a form)_

Synthesis of **BMAD's elicitation engine** + **skill-creator's eval loop**:

1. **Capture intent** — mine the current chat/plan first, then interview.
2. **Interview (stepwise)** — what it does; _when it should trigger_ (hardest/highest value);
   I/O; edge cases; examples; dependencies. Rephrase, propose, offer to brainstorm.
3. **Draft** frontmatter + body + bundle a script if repeated work is detected.
4. **Test** — generate should/should-not + functional assertions; run via daemon eval jobs.
5. **Optimize the description** (train/held-out triggering loop).
6. **Gate on the rubric**, then save + embed.

**Editing = same engine in edit mode** (load → re-elicit weak sections → re-validate → re-embed).
Take BMAD's _rigor_ (stepwise interview, checklist, save-after-each-step), leave its theatrical
persona. The `+ New skill` button becomes a conversation.

### E. Continuous audit _(self-curation)_

A periodic agent (BMAD `audit-workflow` analog) re-scores skills, flags drift / dead / low-trigger
skills, proposes merges and deprecations. The registry curates itself.

---

## 5. The flywheel

```
ingest → normalize → measure → curate/merge → retrieve → use → learn (usage) → re-curate
```

A small, high-quality, well-retrieved **canonical** set, backed by a large raw corpus.
Volume becomes an asset instead of a liability.

---

## 6. Decisions already locked

- **Vendor** bodies into `futurator-skills` (not pure federation) — owns bodies for CRUD + embedding.
- **JSON embeddings sidecar now**, Mycelium/Memgraph graph later.
- Sources curated to permissive, quality repos (skipped the unfiltered aggregator).

## 7. Open questions for the brainstorm

1. **Order:** wire retrieval first, or define the rubric first? (They reinforce each other.)
2. **Rubric authority:** auto-graded only, or operator sign-off to reach `trusted`?
3. **Merge autonomy:** agent proposes + operator approves each merge, or auto-merge above a
   confidence threshold?
4. **Builder surface:** in-app chat panel, a SKILL-SCOUT capability ("author the missing skill"),
   or both?
5. **Eval harness:** reuse the daemon's Claude-job runner for with/without-skill benchmarking?
6. **Graph vs sidecar:** when do co-activation edges (usage signal) justify moving to Memgraph?
7. **Governance:** how do third-party-license skills and operator-authored skills coexist in one
   trust model?
8. **Scale target:** what's the real ceiling — curated hundreds, or thousands with aggressive merge?

## 8. Pointers

- Registry repo: `github.com/futurator-repos/futurator-skills` (`index.json`, `index.embeddings.json`, `skills/<name>/SKILL.md`).
- Ingestion tool: `scripts/ingest-skills.mjs`.
- BMAD builder (in-repo): `bmad/bmb/agents/bmad-builder.md`, `bmad/bmb/workflows/{create,edit,audit}-*`.
- skill-creator: `github.com/anthropics/skills/tree/main/skills/skill-creator`.
- Anthropic guide: `resources.anthropic.com/.../The-Complete-Guide-to-Building-Skill-for-Claude.pdf`.
- Blog: `firecrawl.dev/blog/best-claude-code-skills`.
- Build log: `docs/concepts/skills-management/skills-management-plan.md`.
