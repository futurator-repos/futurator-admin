# Skills & Growth + Knowledge Graph UX — making the learning loop visible

> Status: PROPOSED 2026-06-12 (pacman1 session). Execution: next session(s).
> Companion: qa-review-redesign.md (the UX language to reuse), durable-planes-park-hydrate.md.

## 0. What the operator asked for

A place to SEE — and verify by clicking through to primary evidence — the
work of the three "intelligence" subsystems:

1. **Skills** — which skills each agent loaded/activated, when, on which
   story, and what difference they made.
2. **Lessons (Reflector)** — what the system learned from each wave/plan,
   and how a lesson becomes a CLAUDE.md rule or a skill for future runs.
3. **Knowledge Compiler** — the wiki + graph it builds, its coverage and
   quality, under the existing Graph tab.

Proposal: a new **"Skills & Growth"** sub-tab under the Developing stage,
plus a **knowledge layer** on the Graph tab.

## 1. Prerequisite fixes (found while auditing — the UI is only as good as the data)

| #                 | Fix                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 (CRITICAL)** | Commit `knowledge/` + `.mycelium/` after `compile-sync` (new tiny shell step before `compile-push`)                                                                 | The COMPILER writes AFTER the story commit; per-story worktrees are reaped after merge, so **every article ever written has been lost** — plan branch has zero knowledge files while compile-knowledge ran on every story. The compiler is write-only today: graph gets a transient copy, git gets nothing, `knowledgeIndex` context injection is permanently empty. |
| **R1**            | Replace the reflector's stub agent (`runAgentStep` returns `[]`, marked "v1 SCAFFOLD") with a real spawn using the existing `reflector-prompt.ts` + proposal parser | 9 reflector jobs COMPLETED with zero output; `futurator-reflections` has 0 rows ever. The whole inbox→approve→CLAUDE.md/skill loop exists and is starved. Feed it the new gate evidence (gate-VQA claims, `agent-fixed` stages, attention history).                                                                                                                  |
| **G1**            | `resolveImportSource` (graph-sync.mjs): resolve `@/` tsconfig path aliases (read `tsconfig.json` paths; fallback `@/*`→`src/*`)                                     | The boilerplate imports via `@/` everywhere; only relative imports resolve today → most IMPORTS/DEPENDS_ON edges dropped → the disconnected-dots ring. Isolated ≠ dead today; after G1 it mostly will be.                                                                                                                                                            |

C1 ordering note: place the knowledge commit AFTER compile-sync so the
synced state == committed state, and let it ride `git push origin HEAD`
(compile-push) unchanged. Tripwire: compile-push warns if `knowledge/`
exists on disk but not in HEAD (same validated≠shipped class as P1).

## 2. "Skills & Growth" tab (Developing stage)

Audience: the operator AND semi-technical readers. Three stacked panels,
same visual language as the QA redesign (compact header + plain-language
subtitle + accordion rows + evidence links).

### 2.1 Skills panel — "What expertise was loaded, and did it act?"

Data already exists: `skills_available` / `skill_activated` events (now
timer-classified), the forensic `skills` section (activatedSkills with
counts + perJob), `.context/loaded-skills.json`, `Skills-Used:` commit
trailers, and the app's `.claude/skills.manifest.yaml`.

- **Header strip:** `N skills pinned · M activated this plan · K proposals
pending` (proposals = SKILL-SCOUT `manifest-change-proposed` cards).
- **Rows (one per skill in the manifest):** name · source chip
  (anthropic-official / org / project) · version pin · activation count
  this plan · last used (story + time) · sparkline of activations across
  recent plans (from forensic archives later; plan-local first).
- **Expander (click a skill):**
  - WHO used it: list of (story, agent role, timestamp) from
    `skill_activated` events — each row deep-links to that story's live
    log in Hierarchy (existing pattern).
  - WHAT it is: render the SKILL.md content (fetch via the existing file
    API or bundle a manifest snapshot) so "I can see the information in
    action".
  - Verification hook: the commit trailer `Skills-Used:` for the story —
    grep-able proof it reached the commit.
- Honest empty state: "No skill activated in this plan — agents had the
  manifest but never invoked one" (signal, not blank).

### 2.2 Lessons panel — "What did we learn, and where did it go?"

Data: `futurator-reflections` rows (after R1), reflection-inbox statuses,
plus the M5 wave-VQA fix reflections. This panel is the plan-scoped lens
of the global Reflection Inbox (which stays for cross-project triage).

- **Rows (one per lesson):** scope chip (story/wave/plan) · the lesson
  one-liner · source chip (reflector / vqa-fix) · status:
  `proposed → approved → APPLIED` or `rejected`.
- **Expander:**
  - EVIDENCE: what taught it — links to the originating failure (attention
    card, gate stage outcome, VQA claim — ids already exist in the row
    context).
  - DESTINATION: the target (project CLAUDE.md / project skill / org
    skill) with the exact diff/line that was or would be appended.
  - INCORPORATION TRAIL (the operator's key ask): once applied, show
    "loaded by N agent runs since <date>" — derivable because CLAUDE.md
    content rides `claude_md_loaded` events and skills ride
    `skill_activated`. This closes the loop visually: failure → lesson →
    rule → future agents carrying it.
- Approve/reject inline (reuse the inbox mutation hooks).

### 2.3 Knowledge panel (summary) — "What does the project now know?"

A compact strip (the deep view lives on the Graph tab): articles count ·
coverage (% of src files with an article — computable from index.md vs
file tree) · last compiled (story/time from `knowledge/log.md`) · top 3
newest/changed articles with one-line purposes → "Open graph →".

## 3. Graph tab — the knowledge layer

Keep the force graph; add an honest, explorable frame around it:

- **Coverage header:** `49 files · 41 with knowledge articles (84%) ·
17 functions documented · last compile: story <id>, 14:34`.
- **Node inspect panel (right side, on click):** article title, one-line
  purpose, summary, maturity, `createdByStory` / `lastMutatedByStory`
  (already exported in the snapshot!), and a "view article" link (raw
  GitHub blob on the plan branch — after C1 it exists). For function
  nodes: signature, file, exported?, line range — all in the snapshot.
- **Unconnected-nodes panel:** list of isolated nodes with a REASON
  badge: `entry point` (nothing imports it — normal) · `alias imports
unresolved` (pre-G1 data) · `orphan article` (article whose file is
  gone — REAL removal candidate, the operator's instinct) · `no
references`. Click → focus the node.
- **Article-ness visual:** file nodes WITH an article get a subtle ring;
  maturity drives ring opacity — compiler coverage visible at a glance.
- **Compiler activity feed (collapsible):** the last N compile records
  from `knowledge/log.md` (story, files cataloged, articles
  created/updated) — "is the compiler alive" answered in one glance,
  and each record links to the story.
- Edge legend gains the wikilink-derived types (RELATES/IMPLEMENTS etc.)
  once C1 makes articles durable and their links resolvable.

## 4. Build order

| #   | Deliverable                                                                                                  | Size | Depends on                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------- |
| 1   | **C1** knowledge-commit step + ship-tripwire (Lambda)                                                        | S    | —                                           |
| 2   | **G1** alias-aware import resolution (daemon graph-sync) + retro re-sync on next compile                     | S    | —                                           |
| 3   | **R1** real reflector spawn + proposal parsing (daemon) — include gate-VQA/agent-fixed evidence in its input | M    | —                                           |
| 4   | **Graph tab knowledge layer** (coverage header, inspect panel, unconnected panel, activity feed)             | M    | C1, G1                                      |
| 5   | **Skills & Growth tab** (skills + lessons + knowledge summary panels)                                        | M–L  | R1 for lessons (skills panel works day one) |

1–3 are data-truth fixes and can land in one session; 4–5 are the UX and
can each be a session. After C1+G1 the next plan run produces a connected
graph AND a durable wiki; after R1 the first real lessons appear in the
inbox and the tab has something true to show.
