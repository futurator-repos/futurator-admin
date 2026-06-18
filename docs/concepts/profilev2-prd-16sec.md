# 1. Context and Vision

## 1.1 What Applicator's Profile Is Today

Applicator is an AI-native job-search platform built on Next.js 15 (App Router) + TypeScript + AWS. The user's **profile** is the substrate for every downstream artifact: CV generation, cover letters, interactive profile pages, job match scoring, and cohort analytics.

The profile is seeded by onboarding (CV parse, LinkedIn import, guided questionnaire) and stored in DynamoDB single-table style (`PK=userId`, varied sort keys — notably `PROFILE_V3` canonical and legacy `PROFILE`). AI is multi-provider (Anthropic / OpenAI / Google) behind `getUserAIConfig()`, with Anthropic as the council default. Assets live in S3. Bedrock is already a dependency (`@aws-sdk/client-bedrock-runtime`).

The profile was originally modeled as a **static CV mirror** — fixed sections (Personal, Education/Skills/Certifications, Experience & Projects, Goals & Preferences, Professional Growth, Psychology) with a 5-axis personality radar (Drive, Cognition, Structure, Social, Identity) on the Psychology surface. This is the "naive" framing this PRD moves beyond: a profile treated like a LinkedIn page or a CV — authored once, edited occasionally, fundamentally inert.

**Key limitation:** the current model is **flat** (no links between data points), **lossy** (raw articulations discarded after extraction), and **atemporal** (cannot distinguish _currently true_ from _historically true_). "More use" today mostly means "more data" — the profile gets **longer**, not **denser**.

## 1.2 The Council Foundation (Already Built)

The Profile AI Council (v1.1 PRD, Architecture v0.2) already took the first major step away from the static model. Key moves that this PRD assumes as foundation:

- **Profile = union of articulations.** The profile is reframed as a set of `Claim` records of varying source/confidence — CV-extracted, AI-elicited, manual — all equal status, never "canonical truth."
- **Four-persona council** (Career Coach, Job-Hunt Strategist, Role Lens, Excavator) emits `findings` (review/sharpen) and `probes` (excavate hidden depth) from a single LLM call via `council-critique` action on `POST /api/ai/profile-assistant`.
- **Profile-grows-via-use loop.** A confirmed probe becomes a new `Claim` with full provenance (`source`, `elicitationMethod`, `confidence`, `model_version`, timestamps), which recomputes the **brand-signal radar** within 2 seconds.
- **Derived, recomputable signal.** `ProfileSignal` is a versioned snapshot embedding the existing `PersonalityAnalysis` (5 meta-dimensions / 17 sub-dimensions), augmented with `evidenceRefs` and `axisDeltas`.
- **Append-only event log.** Every interaction is a `ProfileEvent` (ULID/timestamp-keyed), retained for audit.
- **Supporting layers.** `LatentGaps` (sparse-articulation inference driving Excavator probes) and `RolePriors` (typical responsibilities/tools/outcomes per role).

**What the council already gets right:** it is claim-centric (atomic, provenanced) rather than section-centric, and the signal is derived. That is the correct backbone. This PRD does not replace it.

**What it still lacks (the gap this PRD closes):** claims are flat (no links between them), the raw articulation is discarded after extraction (lossy), there is no temporal validity (a career is a timeline, not a snapshot), the ontology is hardcoded (works for software engineers, breaks for filmmakers, lawyers, event managers), and the scoring pipeline can't leverage graph-depth or personality dimensions.

## 1.3 Where We Want to Go

A profile that becomes **denser and more connected** with use, not just longer. The user's reward is increasingly precise AI outputs — better-targeted CVs, sharper cover letters, more relevant job matches, richer coaching — without having to manually update their profile.

**The self-growing loop:** every interaction (council probe, CV edit, job application, cover letter session, interview simulation, free-agent Q&A) drops a verbatim record into the substrate. Extraction creates/updates claims linked to entities. The graph thickens. The next round of probes is sharper (the Excavator sees which entities are under-articulated). The radar's evidence base compounds. This is the difference between a profile that _accumulates_ and one that _grows_.

**The profile must serve as the quality substrate for:**

- CV and cover letter generation (grounded in verbatim evidence)
- Job match scoring (canonical entity matching with depth weighting)
- Deep match analysis (personality-culture fit, growth trajectory)
- Council coaching (entity-aware probes targeting thin areas)
- Cohort analytics (institutional intelligence on skill gaps, maturity)
- Future: recruiter search, interview simulation, free-agent coaching

## 1.4 Inspirations — Obsidian and MemPalace

### Obsidian — Networked Thought

Obsidian is a local-first Markdown PKM whose differentiator is atomic notes connected by bidirectional `[[wikilinks]]`, surfaced as a graph. Two transferable lessons:

- **The value is in the links, not the notes.** Cross-cutting patterns surface because a shared concept note is backlinked from everywhere. A professional profile has the same latent structure going unused.
- **Files are the database; the index is derived.** Obsidian's MetadataCache is rebuilt at runtime from the files. This confirms the claims-are-truth / signal-is-derived split the council already uses.

### MemPalace — Verbatim Storage and Spatial Indexing

MemPalace is a local-first open-source AI-memory system (Python; ChromaDB + SQLite) with transferable ideas:

- **Verbatim storage.** It explicitly _never summarizes, extracts, or paraphrases_ — it stores the original text and indexes around it.
- **Spatial index.** Content organized as _wings_ (people/projects), _rooms_ (topics), _drawers_ (original content) — searches are scoped, not flat.
- **Temporal entity-relationship knowledge graph** with validity windows.
- **Pluggable backend seam** (`BaseBackend` / `BaseCollection`) designed for re-hosting.

**We adopt the MemPalace _model_ on DynamoDB-native stores** — verbatim drawers, spatial scoping (wing/room), temporal validity, and a `BaseCollection`-shaped retrieval seam — while keeping traversal shallow and brute-force-at-small-N viable.

## 1.5 Change Log

| Version | Date       | Description                                                                                                                                                                                                                 |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1    | 2026-06-05 | Initial PRD from party-mode brainstorming. Covers three-layer architecture, self-discoverable ontology, canonical registry, retrieval architecture, scoring pipeline, cohort projections, and UI/UX preliminary guidelines. |

# 2. Three-Layer Architecture

Three layers with a strict dependency direction: the bottom layer is durable and the top layer is disposable/recomputable.

```
        Use events            (council sessions, CV edits, job actions, onboarding, etc.)
            |  capture (verbatim)
            v
   +----------------------------------------------+
   |  Layer 1 -- Verbatim substrate (Drawers)      |   immutable raw articulations
   +----------------------------------------------+
            |  extract + link
            v
   +----------------------------------------------+
   |  Layer 2 -- Knowledge Graph                   |   claims + entities + edges + goals
   |            (Claims, Entities, Edges, Goals)    |   networked, temporally-valid
   +----------------------------------------------+
            |  derive
            v
   +----------------------------------------------+
   |  Layer 3 -- Derived Signals                   |   recomputable projections
   |            (Radar, Index, Fingerprint)         |   (signal, index, match fingerprint)
   +----------------------------------------------+
```

## 2.1 Layer 1 — Verbatim Substrate (Drawers)

Every articulation — the actual probe answer, the original CV bullet, the onboarding transcript chunk, the cover letter chat message — is stored immutably as a **Drawer**. Claims become _extractions over drawers_ and point back at them.

A Drawer is NOT an event log entry. `PROFILE_EVENT#` records _what the system did_ (audit). Drawers record _what the user expressed_ (knowledge).

| Property        | Value                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Immutability    | Drawers are never edited. A correction creates a new drawer with `supersededBy` pointing to the replacement.  |
| Storage         | Inline text if < ~8 KB; S3 reference for large content (full CVs, transcripts).                               |
| Spatial scoping | `wing` = company/project entity ID. `room` = topic/skill. Enables scoped semantic search (MemPalace pattern). |
| Origin tracking | Every drawer records its origin (see [Section 7.1](./7-ingestion-extraction-pipeline.md#71-drawer-origins)).  |

**Payoffs:**

1. **Re-mining.** When extractors improve, re-read drawers and the profile gets richer with zero user effort.
2. **Grounding.** CV generators cite the user's actual words, not lossy claim summaries.
3. **Audit + trust.** Full provenance chain: radar score -> claim -> drawer -> "I said that on June 1st."

## 2.2 Layer 2 — Knowledge Graph (Claims, Entities, Edges)

### Claims

Claims keep everything the council already gave them (provenance, confidence, soft-delete) and gain:

- **`drawerRefs[]`** — verbatim sources this claim was extracted from (Layer 1 link)
- **`entityRefs[]`** — forward edges to first-class entities (inline on the claim)
- **`validFrom` / `validTo` / `supersededBy`** — temporal validity window
- **`kind`** — free string referencing the entity type registry (not an enum)
- **Two creation paths:** "seed" (direct from confirm-probe, instant) and "mined" (async extraction from drawers, requires review)

### Entities

First-class graph nodes representing skills, tools, companies, roles, credentials, languages, and any profession-specific type discovered by extraction or declared by the user. See [Section 3 — Self-Discoverable Ontology](./3-self-discoverable-ontology.md) for the registry-driven type system.

Key properties:

- **Canonical name + aliases** — resolved against the shared canonical registry
- **Temporal validity** — `validFrom` / `validTo` (role tenure, credential expiry)
- **Dynamic metadata** — type-specific fields (e.g., `journal` for a publication, `festival` for a film credit)

### Edges

Typed links between claims and entities. Stored **reverse-only** in DynamoDB (`PROFILE_EDGE#E2C#{entityId}#{claimId}`); forward direction lives inline on the claim as `entityRefs[]`. This halves edge writes while keeping both traversal directions cheap.

### Growth Goals

A new lightweight record type for in-progress certifications, language study, and skill targets:

- Links to a canonical entity (what the user is pursuing)
- Tracks current level, target level, expected completion date, and status
- Enables scoring to distinguish "missing" from "missing but in-progress"

## 2.3 Layer 3 — Derived Signals (Radar, Index, Fingerprint)

All Layer 3 records are **recomputable** from Layer 2. They are cached projections, not source-of-truth.

### ProfileSignal (Radar)

Unchanged in shape from the council architecture — still embeds `PersonalityAnalysis` with dynamic dimensions (see [Section 3.4](./3-self-discoverable-ontology.md#34-dynamic-personality-dimensions)). Computation now reads the graph: an axis score is a function of the claims feeding it _and_ the entity density behind them, weighted by temporal recency and confidence.

### ProfileIndex

A lightweight pre-computed summary that any agent reads first for orientation:

- Dynamic sections derived from entity types present in the graph
- Entity type summary (counts, top entities per type)
- Temporal range, strong axes, recent origins
- Recomputed whenever signal recomputes (one additional DynamoDB write)

### UserMatchFingerprint

Pre-computed match data for bulk job scoring:

- All entities with effective level + depth weight
- Language entities with CEFR levels
- Credential entities with validity status
- User scoring preferences applied
- Cached per search session; recomputed on signal change

## 2.4 The Self-Growing Loop

```
Every interaction
    |
    v
Drawer stored (verbatim, immutable)
    |
    v
Extraction proposes claims + entity links (LLM, async)
    |
    v
User confirms (or system auto-promotes seed claims)
    |
    v
Graph thickens (new claims, entities, edges)
    |
    v
Signal recomputes (richer evidence base)
    |
    v
Next probes are sharper (Excavator targets thin entities)
    |
    v
User answers probe...
    |
    v
(loop continues -- profile compounds)
```

The user never thinks "I'm adding to my profile." They are applying to a job, editing a CV, asking the career coach a question. The drawers accumulate silently. The extractions surface later as "we found 3 new skills from your last cover letter session."

# 3. Self-Discoverable Ontology

The profile must work for any profession — software engineers, documentary filmmakers, environmental lawyers, event production managers, architects, academics, politicians, artists. The entity types, profile sections, and personality dimensions are **registry-driven data**, not code enums.

## 3.1 Registry-Driven Entity Types

Entity types are entries in a shared registry (`ENTITY_TYPE_DEF#{typeId}`), not hardcoded TypeScript enums.

```typescript
interface EntityTypeDef {
  typeId: string; // "skill", "publication", "film_credit", etc.
  displayName: string; // "Publication", "Film Credit"
  category: EntityTypeCategory; // broad stable grouping (see 3.2)
  parentType: string | null; // hierarchy: "peer_reviewed_paper" -> "publication"
  schema: Record<string, FieldDef>; // type-specific metadata fields
  discoveredFrom: 'seed' | 'extraction' | 'user_declared';
  prevalence: number; // cross-platform usage count
}
```

### Three Discovery Paths

1. **Seed types** (pre-loaded, covers ~80% of users): skill, tool, credential, company, role, project, outcome_metric, stakeholder, publication, award, patent, volunteer_work, side_project, hobby. Seeded from Lightcast + ESCO + curation.

2. **Extraction-discovered**: The LLM extraction pipeline encounters CV content that doesn't fit seed types and proposes new ones. Example: a filmmaker's CV yields `film_credit` (category: output), `festival` (category: organization), `grant` (category: credential). The new type is registered for future use.

3. **User-declared**: User explicitly creates a section ("I want to add my Publications"). System checks registry; if no match, creates a new type under the appropriate category.

## 3.2 Eight Stable Categories

These are ontological, not professional — every profession has them:

| Category       | Description                                                | Examples                                             |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `competency`   | Skills, tools, methodologies, soft skills                  | React, Postman, Agile, Leadership                    |
| `experience`   | Roles, projects, engagements, cases, productions           | Backend Engineer at Siemens, Shell v. Milieudefensie |
| `credential`   | Certifications, degrees, licenses, awards, bar admissions  | AWS SA, Geneva Bar, German Film Award                |
| `output`       | Publications, patents, films, built works, events produced | Nature paper, "Concrete Dreams" documentary          |
| `organization` | Companies, institutions, studios, agencies, courts         | Siemens, ICJ, DOK Leipzig                            |
| `relationship` | Stakeholders, collaborators, mentors, clients              | LVMH (client), Al Jazeera (commissioner)             |
| `metric`       | Outcome metrics, KPIs, quantified achievements             | "p99: 800ms->120ms", "3,500 guests", "14 countries"  |
| `interest`     | Hobbies, side projects, causes, volunteer work             | Open-source contributions, vineyard management       |

Categories are the **only fixed enum** in the system. Entity types, edge types, claim kinds, and personality dimensions are all registry entries.

### Entity Record with Dynamic Type

```typescript
interface Entity {
  entityId: string;
  type: string; // references EntityTypeDef.typeId (free string)
  typeCategory: EntityTypeCategory; // denormalized for efficient queries
  canonicalName: string;
  aliases: string[];
  validFrom: string | null;
  validTo: string | null;
  metadata: Record<string, unknown>; // type-specific fields
  createdAt: string;
  updatedAt: string;
}
```

The `metadata` field carries type-specific properties defined by the type's schema. For a publication: `{ journal, doi, citations }`. For a film credit: `{ role, festival, format }`. For a legal case: `{ court, jurisdiction, outcome }`.

## 3.3 Dynamic Profile Sections

Profile sections are **derived from entity types present in the user's graph**, not hardcoded in the UI.

```typescript
interface ProfileSection {
  sectionId: string;
  displayName: string;
  entityTypeCategory: EntityTypeCategory;
  entityTypes: string[]; // which entity types populate this section
  order: number; // user-adjustable display order
  visibility: 'featured' | 'visible' | 'hidden';
  entityCount: number; // computed
  claimCount: number; // computed
  depthScore: number; // computed
}
```

### Section Discovery Rules

1. **Seed sections** (always present): Experience, Skills & Tools, Education, Languages.
2. **Auto-discovered**: When extraction creates entities of a new type, the system suggests a new section. "We found filmography entries in your profile. Show as a section?"
3. **User-created**: User explicitly adds a section (e.g., "Publications") mapped to an entity type.
4. **Ordering**: Default by entity density (richest first); user-adjustable; context-dependent reordering for specific job applications.

### Section Data in ProfileIndex

```typescript
// In PROFILE_INDEX
sections: {
  sectionId: string;
  displayName: string;
  category: EntityTypeCategory;
  entityTypes: string[];
  entityCount: number;
  claimCount: number;
}[];

entityTypeSummary: {
  typeId: string;
  category: EntityTypeCategory;
  count: number;
  topEntities: string[];
}[];
```

When a generation agent reads the index, it sees all section types for this user — including profession-specific ones never designed at development time. It can decide contextually: "This is a filmmaker applying for a producer role — lead with Filmography and Events, put Skills second."

## 3.4 Dynamic Personality Dimensions

The current 5 meta-dimensions / 17 sub-dimensions are moved from hardcoded constants (`META_DIMENSION_DEFS`, `SUB_DIMENSION_LABELS`) to a **versioned dimension registry**.

```typescript
interface PersonalityDimensionDef {
  dimensionId: string; // "drive", "curiosity", "resilience", etc.
  type: 'meta' | 'sub';
  parentId: string | null; // sub-dimensions point to their meta
  label: string;
  description: string;
  icon?: string; // Lucide icon name
  color?: string; // hex
  version: string; // schema version when introduced
  deprecated: boolean; // retire without breaking history
}

// SK: PERSONALITY_DIM_DEF#{dimensionId}
```

### Analysis Stores Dimension IDs, Not Hardcoded Keys

```typescript
interface PersonalityDimensionScore {
  dimensionId: string; // references PersonalityDimensionDef
  score: number; // 0-10
  confidence: number; // 0-1
  evidenceType: 'direct' | 'convergent' | 'inferred';
  rationale: string;
  evidenceRefs: string[]; // claim IDs -> entities + drawers
}

interface PersonalityAnalysis {
  dimensionScores: PersonalityDimensionScore[];
  schemaVersion: string; // "v1.0" = current 5/17
  archetype: string;
  archetypeTagline: string;
  psychologicalProfile: string;
  // ... rest unchanged
}
```

**What this enables:**

- **Add a dimension** (e.g., "Resilience" under Structure): add a registry entry, update the analysis prompt. Old analyses remain valid.
- **Retire a dimension**: set `deprecated: true`. Old scores retained for history.
- **Radar visualization reads the registry**, not constants. Renders whatever dimensions exist.
- **Scoring and retrieval are dimension-agnostic**: the LLM maps culture keywords to relevant dimensions by reading labels + descriptions from the registry, not hardcoded mappings.

## 3.5 Cross-Profession Validation

The self-discoverable ontology was validated against three unrelated professions:

### Documentary Filmmaker (Berlin)

Extraction from CV discovers: `film_credit` (output), `festival` (organization), `award_nomination` (credential), `broadcast_reach` (metric), `grant` (credential), `commissioning_body` (organization). Auto-suggested sections: Filmography, Grants & Funding, Equipment & Tools, Festival Selections, Awards & Nominations.

### Environmental Lawyer (Geneva)

Profile built via council sessions + CV: `legal_case` (experience), `jurisdiction` (competency), `court` (organization), `publication` (output), `bar_admission` (credential), `legal_framework` (competency). Auto-suggested sections: Cases & Proceedings, Bar Admissions, Jurisdictions, Publications, Legal Frameworks.

### Event Production Manager (Dubai)

CV extraction discovers: `event_produced` (output), `venue` (organization), `client` (relationship), `budget_managed` (metric), `attendance` (metric), `vendor_network` (relationship). Auto-suggested sections: Portfolio / Events Produced, Client Roster, Venue Network, Awards & Recognition.

All three professions produce meaningful entity graphs, auto-discovered sections, and graph-powered scoring without any code changes. The same mechanisms that match "PostgreSQL expertise across 4 roles" for a software engineer match "festival selections across 5 films" for a filmmaker — both are entity density within a category.

# 4. Canonical Entity Registry

## 4.1 Shared Registry Architecture

The canonical registry is a **cross-user shared resource** — one DynamoDB table seeded from open taxonomies, growing as aliases accumulate from user profiles and job extractions.

```
CANONICAL ENTITY REGISTRY (shared, cross-user)
|
+-- Skills (Lightcast Open Skills, 33k+)
|   "Amazon Web Services" <- "AWS", "Amazon Cloud Services"
|
+-- Tools (Lightcast software skills)
|   "Postman" <- "postman api", "postman app"
|   "Docker" <- "docker engine", "docker containers"
|
+-- Soft Skills (Lightcast common skills + ESCO transversal)
|   "Leadership" <- "team leadership", "people management"
|
+-- Job Titles (Lightcast Open Titles, 75k+)
|   "Backend Engineer" <- "Backend Developer", "Server-Side Engineer"
|   Stored with: canonicalTitle + displayVariants
|   Used for: search matching (NOT display -- display uses user's actual title)
|
+-- Credentials (curated -- no strong open taxonomy exists)
|   "AWS Solutions Architect -- Associate" <- "AWS SA Associate"
|
+-- Companies (curated + user-contributed)
|   "Amazon Web Services" (company) <- "AWS"
|   NOTE: entity type scoping prevents collision with "AWS" the skill
|
+-- Languages (ISO 639 standard)
    "German" <- "Deutsch", "DE", "Allemand"
    With proficiency mapping: CEFR <-> descriptive labels
```

### DynamoDB Schema

```
PK: CANONICAL#{typeCategory}#{type}#{canonicalId}
Attributes:
  canonicalName: string
  aliases: Set<string>         // normalized forms
  embedding: Binary            // pre-computed vector for Tier 2 matching
  lightcastId?: string         // for skills seeded from Lightcast
  escoUri?: string             // for skills/competencies from ESCO
  category?: string            // sub-category (e.g., "programming-language")

Alias lookup:
  PK: CANONICAL_ALIAS#{typeCategory}#{type}#{normalizedString}
  canonicalId: string          // points to the canonical entry
```

**Entity type scoping is essential.** "AWS" the skill and "AWS" the company are different entities:

```
CANONICAL_ALIAS#competency#skill#aws     -> "Amazon Web Services" (skill)
CANONICAL_ALIAS#organization#company#aws -> "Amazon Web Services" (company)
```

## 4.2 Three-Tier Resolution

### Tier 1 — Deterministic Normalization (free, instant, ~70% of cases)

```
Input: "React.js" -> lowercase, strip punctuation -> "reactjs"
Lookup: CANONICAL_ALIAS#competency#skill#reactjs -> canonical: "React"
```

Deterministic steps: lowercase, strip punctuation/trailing versions, expand common abbreviations. Direct alias lookup in DynamoDB. If exact match, done.

### Tier 2 — Embedding Similarity (cheap, ~200ms, ~20% more)

```
Input: "Amazon Cloud Services" -> embed -> cosine vs canonical embeddings
Top match: "Amazon Web Services" (similarity: 0.94) -> auto-merge as new alias
```

Use Bedrock Titan Embeddings. Pre-compute embeddings for all canonical entities. On write, if Tier 1 misses, embed the incoming string and find nearest canonical. If similarity > 0.95, auto-merge and register as new alias. If 0.85-0.95, escalate to Tier 3.

### Tier 3 — LLM Resolution (expensive, ~1-2s, ambiguous ~10%)

```
Prompt: "Is 'Postgres' the same entity as 'PostgreSQL'?
  Context: professional skills, type: tool."
LLM: "Yes -- PostgreSQL is the canonical name, Postgres is a common alias."
-> Add alias to Tier 1 (cached permanently), so this resolution never runs again
```

Call Claude (via `getUserAIConfig()`) for genuinely ambiguous cases. Every decision feeds back into Tier 1 as a new alias.

**Cost:** At profile scale (tens of entities per interaction), Tier 3 calls are rare. ~$0.001 per entity resolution average.

## 4.3 Taxonomy Seeding Strategy

| Entity Type        | Primary Seed              | Secondary                     | Estimated Count   |
| ------------------ | ------------------------- | ----------------------------- | ----------------- |
| Skills (technical) | Lightcast Open Skills     | ESCO                          | ~25,000           |
| Skills (soft)      | Lightcast Common Skills   | ESCO transversal              | ~3,000            |
| Tools/Software     | Lightcast Software Skills | Manual curation               | ~5,000            |
| Job Titles         | Lightcast Open Titles     | O\*NET-SOC                    | ~75,000           |
| Credentials        | Manual curation           | --                            | ~500 initial      |
| Languages          | ISO 639                   | --                            | ~200              |
| Companies          | --                        | User-contributed + enrichment | Grows organically |

**Total seed: ~108,000 canonical entries.** One-time load into DynamoDB. Updated quarterly from Lightcast (they refresh biweekly, but we don't need that cadence at launch).

## 4.4 Bidirectional Canonicalization

Canonicalization applies to **both sides** of any matching operation:

```
USER PROFILE                          JOB POSTING
"React.js"  --+                  +-- "ReactJS required"
"React"     --+-- canonical: ----+-- "React experience"
"ReactJS"   --+    "React"       +-- "React.js or Vue"
                      |
              CANONICAL ENTITY
              (Lightcast-seeded)
```

### Job-Side Canonicalization

When a job posting is parsed (via `extractionService.extractJobDetails()`), extracted requirements are immediately canonicalized:

```typescript
// Current flow:
extractJobDetails(description) -> { mandatory: ["ReactJS", "Node"], ... }

// New flow:
extractJobDetails(description) -> raw extraction
  -> canonicalize(raw.skills.mandatory)
  -> { mandatory: [{ raw: "ReactJS", canonicalId: "ent_react",
                     canonicalName: "React" }], ... }
```

The match query then operates on canonical IDs. `"AWS"` in the job and `"Amazon Web Services"` in the profile resolve to the same canonical entity — zero ambiguity.

### Job Description Language Detection

Use **AWS Comprehend `DetectDominantLanguage`** (not client-side libraries) for detecting the language of job descriptions:

- Already available in the AWS stack, handles mixed German/English code-switching common in DACH job postings
- Returns confidence scores for multiple detected languages
- ~$0.0001 per request, negligible at job-posting volumes
- Called once per job during extraction, cached on `JobListing.detectedLanguage`

When German is detected as dominant language (confidence > 0.8) and no explicit German requirement was extracted, inject an `implicit` German language requirement. Mixed-language postings (German 0.5-0.8) inject a `soft_required` signal.

# 5. Data Shapes and Storage

## 5.1 DynamoDB Single-Table Extension

All new records live under the existing `userId` partition with new SK prefixes. **No new tables. No new GSIs at MVP.** Every access pattern is partition-key-bounded via `begins_with` on SK, consistent with the locked architecture.

### Complete SK Prefix Map

| SK Prefix                                         | Record                            | Layer    | Cardinality   |
| ------------------------------------------------- | --------------------------------- | -------- | ------------- |
| `PROFILE_DRAWER#{drawerId}`                       | Verbatim articulation             | 1        | 1..N per user |
| `PROFILE_CLAIM#{claimId}`                         | Structured assertion (extended)   | 2        | 1..N per user |
| `PROFILE_ENTITY#{typeCategory}#{type}#{entityId}` | First-class graph node            | 2        | 1..N per user |
| `PROFILE_EDGE#E2C#{entityId}#{claimId}`           | Reverse adjacency                 | 2        | 1..N per user |
| `PROFILE_GOAL#{goalId}`                           | In-progress growth target         | 2        | 0..N per user |
| `PROFILE_EMBEDDING#{ownerId}`                     | Sidecar embedding vector          | 2        | 0..N per user |
| `PROFILE_SIGNAL#{version}#{computedAt}`           | Versioned radar snapshot          | 3        | 1..N per user |
| `PROFILE_LATEST_SIGNAL`                           | O(1) pointer to current signal    | 3        | 1 per user    |
| `PROFILE_INDEX`                                   | Pre-computed agent orientation    | 3        | 1 per user    |
| `PROFILE_MATCH_FINGERPRINT`                       | Pre-computed scoring data         | 3        | 1 per user    |
| `PROFILE_EVENT#{eventId}`                         | Append-only audit log             | Support  | 1..N per user |
| `PROFILE_LATENT_GAPS`                             | Sparse-articulation areas         | Support  | 1 per user    |
| `LLMCACHE_ROLE_PRIORS#{roleSlug}`                 | Role responsibility registry      | Support  | 0..N per user |
| `PROFILE_V3`                                      | Legacy canonical profile (frozen) | Existing | 1 per user    |
| `PROFILE`                                         | Legacy profile (frozen)           | Existing | 1 per user    |

### Shared Registries (Cross-User, Separate Table)

| SK Prefix                                                  | Record                           | Purpose                    |
| ---------------------------------------------------------- | -------------------------------- | -------------------------- |
| `CANONICAL#{typeCategory}#{type}#{canonicalId}`            | Canonical entity entry           | Shared dedup registry      |
| `CANONICAL_ALIAS#{typeCategory}#{type}#{normalizedString}` | Alias -> canonical mapping       | Fast deterministic lookup  |
| `ENTITY_TYPE_DEF#{typeId}`                                 | Entity type definition           | Self-discoverable ontology |
| `PERSONALITY_DIM_DEF#{dimensionId}`                        | Personality dimension definition | Dynamic radar dimensions   |

## 5.2 Record Schemas

### Drawer (Layer 1) — Immutable

```typescript
interface Drawer {
  drawerId: string; // nanoid
  text: string | null; // verbatim raw text, inline if < ~8KB
  s3Ref: string | null; // S3 key if large (full CV/transcript)
  origin: DrawerOrigin; // see Section 7.1
  eventRef: string | null; // originating PROFILE_EVENT# id
  wing: string | null; // spatial scope: entityId of company/project
  room: string | null; // spatial scope: topic/skill
  capturedAt: string; // ISO
  supersededBy: string | null; // correction chain (never edited, only superseded)
}
```

### Entity (Layer 2) — First-Class Graph Node

```typescript
interface Entity {
  entityId: string; // nanoid
  type: string; // references EntityTypeDef.typeId (free string)
  typeCategory: EntityTypeCategory; // denormalized for queries
  canonicalName: string; // e.g., "PostgreSQL"
  aliases: string[]; // e.g., ["Postgres", "psql"]
  validFrom: string | null; // ISO — temporal validity (e.g., role tenure)
  validTo: string | null; // ISO | null = still valid
  metadata: Record<string, unknown>; // type-specific fields from schema
  createdAt: string;
  updatedAt: string;
}
```

### Claim (Layer 2) — Extended

```typescript
interface Claim {
  claimId: string;
  kind: string; // free string referencing entity type registry
  kindCategory: string; // denormalized broad category
  body: object; // facet/kind payload (existing)
  source: ClaimSource; // existing source enum
  elicitationMethod: string | null; // existing
  confidence: number; // 0..1 (existing)
  version: number; // existing
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null; // existing soft-delete

  // NEW (additive)
  extractionSource: 'direct' | 'mined'; // seed vs async extraction
  drawerRefs: string[]; // verbatim sources (Layer 1 link)
  entityRefs: EntityRef[]; // forward edges (inline)
  validFrom: string | null; // temporal validity
  validTo: string | null;
  supersededBy: string | null;
}

interface EntityRef {
  entityId: string;
  edgeType: string; // free string: "used_tool", "worked_at", etc.
}
```

### Reverse Edge (Layer 2)

```typescript
interface ReverseEdge {
  entityId: string;
  claimId: string;
  edgeType: string;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
}
// SK: PROFILE_EDGE#E2C#{entityId}#{claimId}
```

### Growth Goal (Layer 2)

```typescript
interface GrowthGoal {
  goalId: string;
  entityRef: string; // canonical entity ID
  entityType: string; // entity type
  currentLevel: string | null; // "B1", "intermediate", null
  targetLevel: string; // "B2", "certified", "expert"
  targetDate: string | null; // ISO
  status: 'planned' | 'in_progress' | 'completed' | 'abandoned';
  source: 'manual' | 'council-elicited' | 'inferred';
  drawerRef: string | null; // verbatim evidence
  createdAt: string;
  updatedAt: string;
}
// SK: PROFILE_GOAL#{goalId}
```

### Embedding Sidecar (Optional)

```typescript
interface EmbeddingRecord {
  ownerId: string; // drawerId or claimId
  ownerKind: 'drawer' | 'claim';
  vector: Buffer; // Float32 packed -> Base64/Binary (~dim x 4 bytes)
  dim: number;
  embeddingModel: string; // PINNED per record; model change = re-index
  wing: string | null; // denormalized scope for filtered retrieval
  room: string | null;
  createdAt: string;
}
// SK: PROFILE_EMBEDDING#{ownerId}
```

### ProfileIndex (Layer 3)

```typescript
interface ProfileIndex {
  sections: {
    sectionId: string;
    displayName: string;
    category: EntityTypeCategory;
    entityTypes: string[];
    entityCount: number;
    claimCount: number;
  }[];
  entityTypeSummary: {
    typeId: string;
    category: EntityTypeCategory;
    count: number;
    topEntities: string[];
  }[];
  temporalRange: { earliest: string; latest: string };
  strongAxes: string[];
  recentOrigins: string[];
  claimStats: { total: number; confirmed: number; pending: number };
}
// SK: PROFILE_INDEX
```

### UserMatchFingerprint (Layer 3)

```typescript
interface UserMatchFingerprint {
  skillEntities: Map<
    string,
    {
      name: string;
      effectiveLevel: number;
      depthWeight: number;
      latestValidTo: string;
    }
  >;
  toolEntities: Map<
    string,
    {
      /* same shape */
    }
  >;
  languageEntities: Map<
    string,
    {
      proficiency: string;
      cefr: string;
      isNative: boolean;
    }
  >;
  credentialEntities: Map<
    string,
    {
      validTo: string | null;
      isExpired: boolean;
    }
  >;
  roleEntities: Map<
    string,
    {
      tenureMonths: number;
      isCurrent: boolean;
    }
  >;
  totalExperienceYears: number;
  seniorityLevel: string;
  location: { city: string; country: string };
  scoringPreferences: UserScoringPreferences;
}
// SK: PROFILE_MATCH_FINGERPRINT
```

## 5.3 Access Patterns

| #   | Need                                | Pattern                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------- | --- | -------------- |
| 1   | All claims for a user               | `PK=userId, SK begins_with PROFILE_CLAIM#`                    |
| 2   | A claim's entities (forward)        | Read claim -> `entityRefs[]` (no extra query)                 |
| 3   | A claim's verbatim sources          | Read claim -> `drawerRefs[]` -> batch-get drawers             |
| 4   | All entities of a category          | `PK=userId, SK begins_with PROFILE_ENTITY#{category}#`        |
| 5   | All entities of a specific type     | `PK=userId, SK begins_with PROFILE_ENTITY#{category}#{type}#` |
| 6   | One entity                          | Get `PROFILE_ENTITY#{category}#{type}#{entityId}`             |
| 7   | Claims touching an entity (reverse) | `PK=userId, SK begins_with PROFILE_EDGE#E2C#{entityId}#`      |
| 8   | All drawers for a user              | `PK=userId, SK begins_with PROFILE_DRAWER#`                   |
| 9   | Currently-valid claims              | Pattern 1, filter `validTo == null                            |     | validTo > now` |
| 10  | Latest signal                       | Get `PROFILE_LATEST_SIGNAL` -> get signal record              |
| 11  | Profile index                       | Get `PROFILE_INDEX`                                           |
| 12  | Match fingerprint                   | Get `PROFILE_MATCH_FINGERPRINT`                               |
| 13  | Growth goals                        | `PK=userId, SK begins_with PROFILE_GOAL#`                     |
| 14  | Semantic search over drawers        | See Section 5.4                                               |

All except #14 are single-partition, `begins_with`-bounded. No GSI required at MVP.

## 5.4 Embeddings and Semantic Search

DynamoDB has no native vector search. At profile scale (hundreds to low-thousands of vectors per user), brute-force cosine in a Lambda is viable and cheap.

### Retrieval Flow

1. Query user's embedding records (optionally filter by `wing`/`room` to shrink candidate set)
2. Load vectors into memory
3. Compute cosine similarity against query embedding
4. Return top-k matches

### Embedding Generation

- **Model:** Bedrock (Titan Text Embeddings v2, or Voyage — confirm region availability)
- **Pinned per record:** `embeddingModel` field. Model change = re-index migration, not a config flip.
- **Sidecar storage:** Vectors stored in separate `PROFILE_EMBEDDING#` items to avoid inflating claim/drawer reads.

### Scale Ceiling

Brute-force is viable to ~2,000-3,000 vectors per user. Define a guard: if exceeded, fall back to externalized vector search behind the `ProfileCollection` interface (Section 6.5). Track vector counts in telemetry.

# 6. Retrieval Architecture

The retrieval architecture determines how AI agents navigate the profile graph to produce high-quality outputs. The design principle: **structured traversal is the primary path, semantic search is the fallback.** An agent generating a CV doesn't need to "search" the profile — it needs to _walk_ it.

## 6.1 Three Retrieval Modes

### Mode 1: Structured Traversal (fast, precise, no LLM cost)

```
"Give me all claims linked to entity 'PostgreSQL'"
  -> Query: PK=userId, SK begins_with PROFILE_EDGE#E2C#{postgresId}#
  -> Returns: claim IDs -> batch-get claims -> each has drawerRefs[]

"Give me all current skill entities"
  -> Query: PK=userId, SK begins_with PROFILE_ENTITY#competency#skill#
  -> Filter: validTo == null
```

### Mode 2: Semantic Search (slower, fuzzy, handles natural language)

```
"Find everything related to 'distributed systems at scale'"
  -> Embed query -> ProfileCollection.query() -> top-k drawers
  -> Each drawer -> claims via drawerRefs -> entityRefs -> full context

Scoped variant:
"Find auth-related articulations from the Siemens period"
  -> query with where: { wing: "entity_siemens", room: "authentication" }
```

### Mode 3: Graph Walk (medium, structural discovery)

```
"What outcomes did this user achieve with Redis?"
  -> Get entity "Redis" -> reverse edges -> claims
  -> Filter claims by edgeType: "delivered_outcome"
  -> Each claim -> drawerRefs -> verbatim evidence

"Which skills span multiple roles?"
  -> Get all skill entities -> for each, count distinct role
     entities reachable via shared claims
  -> Skills appearing across 3+ roles = transferable skills
```

## 6.2 Profile Index and Agent Orientation

Every agent reads `PROFILE_INDEX` first — one DynamoDB read (~5ms). This provides:

- **Profile shape:** what entity types exist, how many, which are dense
- **Temporal range:** career span, most recent activity
- **Section list:** dynamic sections derived from entity types present
- **Strong axes:** which personality dimensions are high-confidence

The index is like `ls` for a codebase — gives the agent orientation before it drills into specifics.

## 6.3 Agent Tool Interface

For real-time agents (Career Coach, CV editing council), retrieval is embedded in the agent's tool use — no separate planning phase.

```
Career Coach Agent (Claude with tools)
|
+-- Tool: profile_index()
|   -> Returns PROFILE_INDEX (one DynamoDB read, ~5ms)
|
+-- Tool: get_entities(type?, category?, filter?)
|   -> Returns entities, optionally filtered by type/category
|
+-- Tool: get_entity_claims(entityId)
|   -> Returns claims linked to an entity (reverse edge query)
|   -> Each claim has drawerRefs for verbatim grounding
|
+-- Tool: get_claims(filter?)
|   -> Returns claims by kind, recency, category
|
+-- Tool: get_drawer(drawerId)
|   -> Returns verbatim text for grounding
|
+-- Tool: semantic_search(query, scope?)
|   -> ProfileCollection.query() over embeddings
|   -> Scoped by wing/room for precision
|
+-- Tool: get_signal()
|   -> Returns latest radar signal + dimension scores
|
+-- Tool: get_goals()
    -> Returns active growth goals with timelines
```

**The agent decides what to retrieve based on conversation context.** A Career Coach answering "Am I ready for a Platform Engineer role?" might call `profile_index()`, then `get_entities("skill")`, then `get_entity_claims(kubernetes_id)`, then `semantic_search("infrastructure reliability")` — 4 tool calls, ~50ms DynamoDB time. No planning LLM call needed.

## 6.4 Two-Phase Retrieval Protocol

For generation agents (CV, cover letter, assessment) that can afford a planning step:

### Phase 1 — Profile Summary (one read)

Read `PROFILE_INDEX` to understand profile shape. Read goal context (job posting, project brief).

### Phase 2 — Targeted Deep Retrieval

Based on index + goal, execute structured queries for relevant entities, claims, and drawers. Example for CV generation against a job posting:

```
Given: "Senior Platform Engineer at Datadog"
Agent reads PROFILE_INDEX -> sees: strong on AWS, K8s, PostgreSQL

Retrieval plan:
  1. Entities matching job keywords (structured + semantic)
  2. Top 3 most recent experience claims (recency bias)
  3. All outcome_metric entities (quantified achievements)
  4. Claims linked to K8s + AWS (job's core stack)
  5. Skill entities NOT in job posting but adjacent (transferable)

Each step = 1-2 DynamoDB queries. Total: ~15-20 reads.
Cost: fractions of a cent.
```

**Compare to today:** Current CV generation reads the entire `PROFILE_V3` blob and passes it all to the LLM. The LLM does the selection in its context window — wasteful, burns tokens, selection quality limited by single-pass reading. The graph approach inverts this: the retrieval layer does selection (cheap, precise), the LLM receives only curated content (fewer tokens, better output).

## 6.5 ProfileCollection Seam

A thin TypeScript interface wrapping retrieval, mirroring MemPalace's `BaseCollection` shape:

```typescript
interface ProfileCollection {
  add(args: {
    ids: string[];
    documents: string[];
    metadatas?: object[];
    embeddings?: number[][];
  }): Promise<void>;
  upsert(args: {
    ids: string[];
    documents: string[];
    metadatas?: object[];
    embeddings?: number[][];
  }): Promise<void>;
  query(args: {
    queryEmbeddings?: number[][];
    queryTexts?: string[];
    nResults?: number;
    where?: object;
    include?: string[];
  }): Promise<QueryResult>;
  get(args: { ids?: string[]; where?: object; limit?: number }): Promise<GetResult>;
  delete(args: { ids?: string[]; where?: object }): Promise<void>;
  count(): Promise<number>;
}
// namespace = userId (MemPalace PalaceRef.namespace -> tenant routing)
```

**MVP implementation:** `DynamoBruteForceCollection` — a single file (~80 lines) that reads embedding records, computes cosine in memory, returns top-k. No elaborate `where` parsing or pagination beyond what MVP callers need.

**Future swap:** If vector counts exceed the brute-force ceiling, drop in `OpenSearchCollection` behind the same interface — or the real MemPalace Python core as a Lambda container. No caller changes.

# 7. Ingestion and Extraction Pipeline

## 7.1 Drawer Origins

Every user interaction that produces articulable content becomes a drawer. Origins and their characteristics:

| Origin            | Value Density   | Example Content                | Extraction Yield                       |
| ----------------- | --------------- | ------------------------------ | -------------------------------------- |
| `onboarding-cv`   | High (bulk)     | Full CV text                   | Many claims, many entities             |
| `onboarding-li`   | High (bulk)     | LinkedIn import text           | Many claims, many entities             |
| `onboarding-q`    | Medium          | Questionnaire answers          | Goals, preferences, narrative          |
| `council-probe`   | High (targeted) | Probe response                 | Targeted depth on specific topics      |
| `cv-edit`         | Medium          | User edits a CV bullet         | Updated/new claims, may invalidate old |
| `cv-council-chat` | High            | User chats with CV council     | Rich conversational articulations      |
| `cover-letter`    | Medium          | Cover letter session content   | Contextual articulations about fit     |
| `job-application` | Low (signal)    | Application action metadata    | Implicit interest signals              |
| `interview-sim`   | High (future)   | Interview simulation responses | Rich behavioral articulations          |
| `agent-qa`        | Medium (future) | Free agent Q&A                 | Ad-hoc professional knowledge          |
| `manual`          | Varies          | User directly adds/edits       | Explicit declarations                  |

Text-rich origins (council probes, CV chats) yield the most claims. Signal-rich origins (job applications, CV deletions) yield pattern data that informs future probes and scoring weights.

## 7.2 Sync vs Async Boundary

The 2-second radar-tick budget from the council architecture is preserved. The boundary:

**Synchronous (< 200ms, in the API response):**

1. Write Drawer (one DynamoDB put)
2. Write ProfileEvent (one DynamoDB put)
3. Write seed claim if applicable (existing `confirm-probe` behavior)
4. Return `{ drawerId, status: "processing" }` to client

**Asynchronous (DynamoDB Streams triggers Lambda):**

1. Read Drawer text
2. LLM extraction: propose claims + entity refs + temporal validity
3. Canonicalize entities (three-tier resolution)
4. Write proposed claims (status: `pending_review` for mined claims)
5. Write Entity nodes + reverse edges
6. Generate embedding for the drawer (Bedrock)
7. Write EmbeddingRecord
8. Recompute Signal (if new confirmed claims exist)
9. Recompute ProfileIndex
10. Recompute UserMatchFingerprint

**Why DynamoDB Streams, not SQS:** Extraction is 1:1 with drawer writes. Streams give exactly-once semantics with the stream's sequence number and keep the event-driven pattern consistent. SQS is for fan-out/burst absorption — not needed here.

## 7.3 Extraction Pipeline

An LLM step (Bedrock/Claude) reads a drawer and proposes: structured claims, entity references (with `edgeType`), and candidate `validFrom`/`validTo`.

### Hard Rules

1. **Never auto-merge.** Extraction output is _proposed_, surfaced through the accept/reject gate. Opt-in promotion only.
2. **Entity canonicalization on write.** Before minting an entity, normalize against existing `canonicalName` + `aliases` using the three-tier resolution. Sprawl degrades the graph.
3. **Default temporal values** to `capturedAt` / null when uninferable. Let the user correct. Wrong "currently true" is worse than absent.
4. **Deduplication against existing claims.** Mined claims that duplicate an existing seed claim must enrich the existing claim (add entity links, metrics) rather than create a duplicate.

### Extraction as a Council Action

Extraction is NOT a separate Lambda service. It is a new action on `POST /api/ai/profile-assistant`: `extract-drawer`. This reuses the prompt assembly, cost telemetry, rate limiting, and provider abstraction already built for the council.

## 7.4 Hybrid Seed and Mined Claims

Two creation paths coexist, each clearly tagged:

### Seed Claims (`extractionSource: "direct"`)

Created by the existing `confirm-probe` action. The user explicitly confirmed a probe — high confidence, immediate, preserves the instant radar tick. This is backward-compatible with the existing council flow.

### Mined Claims (`extractionSource: "mined"`)

Created by the async extraction pipeline when it finds additional structured data in a drawer that the seed claim didn't capture. Lower initial confidence. Requires user review before going live.

**Example:** User confirms a probe about auth redesign. Seed claim captures the experience fact. Async extraction discovers additional entities: Redis (tool), JWT (tool), "10x concurrent sessions" (metric), "stakeholder management" (soft skill). These become mined claims queued for review: "We found these from your last session — confirm or dismiss?"

### Migration Path

- **Phase 0 (shadow mode):** `confirm-probe` continues creating claims exactly as today AND additionally writes a drawer. No extraction yet. The drawer is an append-only archive.
- **Phase 1:** Async extraction runs on drawers and proposes additional mined claims. Direct claim creation on `confirm-probe` preserved for the seed claim.
- **Phase 2+:** As extraction quality improves, seed claims may be replaced entirely by the drawer-first pipeline. This is a future decision, not MVP.

## 7.5 Entity Canonicalization on Write

Every entity reference produced by extraction goes through canonicalization before being written:

```
Extraction proposes: "React.js" (type: skill)
    |
    v
Tier 1: normalize("React.js") -> "reactjs"
  -> Lookup CANONICAL_ALIAS#competency#skill#reactjs
  -> HIT: canonicalId = "ent_react", canonicalName = "React"
  -> Use existing entity. Done.

Extraction proposes: "Siemens Digital Industries" (type: company)
    |
    v
Tier 1: normalize -> "siemensdigitalindustries"
  -> Lookup: MISS
    |
    v
Tier 2: embed -> cosine against canonical companies
  -> Top match: "Siemens AG" (similarity: 0.91)
  -> Below 0.95 threshold -> escalate
    |
    v
Tier 3: LLM judge
  -> "Siemens Digital Industries is a division of Siemens AG.
      For professional profile purposes, treat as same entity."
  -> Merge: add "Siemens Digital Industries" as alias of "Siemens AG"
  -> Cache alias in Tier 1 for future lookups
```

**Type scoping is mandatory.** "Python" the programming language and "Python" the species are different entities. All canonicalization operates within `typeCategory + type` scope.

# 8. Proficiency, Depth, and Scoring

## 8.1 Proficiency vs Depth — Two Signals

Every competency entity carries two complementary signals:

| Signal                          | Source                                                 | Nature                      | Updates                              |
| ------------------------------- | ------------------------------------------------------ | --------------------------- | ------------------------------------ |
| **Proficiency** (user-declared) | Onboarding, manual edit                                | Self-assessed, 4-level enum | Static until user changes            |
| **Depth** (graph-derived)       | Claim count, role span, temporal span, outcome metrics | Objective, evidence-based   | Grows automatically as profile grows |

```typescript
interface EntityMatchProfile {
  canonicalId: string;
  canonicalName: string;

  // User-declared
  declaredProficiency: 'beginner' | 'intermediate' | 'advanced' | 'expert' | null;

  // Graph-derived depth
  claimCount: number; // how many claims reference this entity
  roleSpan: number; // how many distinct roles used it
  temporalSpan: number; // months between first and last validFrom
  hasOutcomeMetrics: boolean; // any quantified achievements?
  latestMention: string; // ISO -- recency
  avgClaimConfidence: number; // quality of evidence

  // Computed composite
  depthWeight: number; // 0.0 - 2.0
  effectiveLevel: number; // 0-4
}
```

### Depth Weight Formula

```
depthWeight =
  (claimCount / 3) * 0.3          // 3+ claims = full weight on this factor
  + (roleSpan / 2) * 0.25         // used across 2+ roles = transferable
  + (temporalSpan / 24) * 0.2     // 2+ years = sustained usage
  + (hasOutcomeMetrics ? 1 : 0) * 0.15   // quantified = credible
  + recencyFactor * 0.1           // last 12 months = current

  Clamped to [0.1, 2.0]
```

## 8.2 Effective Level Computation

```
If declaredProficiency exists:
  baseLevel = proficiencyToNumber(declaredProficiency)  // 1-4

  if depthWeight > 1.2 AND baseLevel < 4:
    effectiveLevel = baseLevel + 0.5   // depth supports the claim: boost

  if depthWeight < 0.3 AND baseLevel > 1:
    effectiveLevel = baseLevel - 0.5   // evidence doesn't support: weaken

  else:
    effectiveLevel = baseLevel         // trust declaration

If declaredProficiency is null (user never rated):
  effectiveLevel = depthToLevel(depthWeight)
    // 0-0.3 -> 1 (beginner)
    // 0.3-0.8 -> 2 (intermediate)
    // 0.8-1.3 -> 3 (advanced)
    // 1.3+ -> 4 (expert)
```

**Why this matters:** A user who declares "expert in PostgreSQL" but has one claim with no outcomes is a weaker match than someone declaring "advanced" with 8 claims, 3 outcome metrics, across 4 roles. Depth catches bluffs and boosts modest self-assessors.

## 8.3 Language Scoring Model

Language matching requires nuance beyond binary have/don't-have. Both sides carry proficiency signals.

### Unified Proficiency Scale

```
User side:   basic | conversational | professional | fluent | native
             (maps to CEFR: A1-A2 | B1 | B2 | C1 | C2)

Job side:    requirement tier + required proficiency level
             tier: hard_required | soft_required | preferred | implicit
```

### Requirement Classification

| Job Description Signal                     | Tier              | Example                             |
| ------------------------------------------ | ----------------- | ----------------------------------- |
| "German required", "C1 German mandatory"   | `hard_required`   | Must have or don't apply            |
| "German needed for client communication"   | `soft_required`   | Needed but could be worked around   |
| "German is a plus", "German beneficial"    | `preferred`       | Nice to have                        |
| Job description written entirely in German | `implicit`        | Workplace likely requires German    |
| Mixed German/English posting               | `implicit` (soft) | German likely needed for daily work |

### Gap Score Computation

```
If user HAS the language:
  rawGap = userLevel - requiredLevel

  rawGap >= +1 -> matchStatus: 'exceeds' (bonus)
  rawGap == 0  -> matchStatus: 'meets' (full points)
  rawGap == -1 -> matchStatus: 'close' (partial credit)
  rawGap <= -2 -> matchStatus: 'gap' (significant penalty)

If user DOES NOT have the language:
  matchStatus: 'missing' (penalty depends on tier)
```

### Penalty Table

| Tier            | Missing                | Gap (-2+) | Close (-1) | Meets | Exceeds |
| --------------- | ---------------------- | --------- | ---------- | ----- | ------- |
| `hard_required` | Cap at 30, blocker     | -30 pts   | -15 pts    | Full  | +bonus  |
| `soft_required` | -25 pts                | -15 pts   | -8 pts     | Full  | +bonus  |
| `preferred`     | -5 pts                 | -3 pts    | Full       | Full  | +bonus  |
| `implicit`      | **Cap at 25**, blocker | -25 pts   | -12 pts    | Full  | +bonus  |

**Key design decision:** `implicit` (description in German, no explicit requirement) is **stricter** than `hard_required`. Rationale: an explicit "German required" might be HR boilerplate; an entirely German-language posting is concrete evidence the workplace operates in German.

### Concrete Examples

**German C1 required, user has B2:** `close` (-1 gap), -15 pts on language, no hard cap. B2 is genuinely close to C1 — many employers accept it.

**German required, user has none:** `missing` + `hard_required` = cap at 30, blocker icon.

**Job description in German, user has none:** `missing` + `implicit` = cap at 25 (stricter), blocker icon.

**Job description in German, user has B2:** `close` + `implicit` = -12 pts, warning: "Job posting is in German — your B2 may be sufficient but workplace communication is likely in German."

**"German is a plus", user has none:** `missing` + `preferred` = -5 pts only. "German would be a bonus for this role."

## 8.4 Job Match Scoring Pipeline

### Phase 0: Job Canonicalization (batch, fast)

For each job, canonicalize extracted requirements against the shared registry. ~3ms per job (DynamoDB batch lookups). Pre-canonicalized if cached from prior extraction.

### Phase 1: Graph Heuristic Score (replaces current heuristic)

Deterministic, no LLM, operates on cached `UserMatchFingerprint`.

```
Per job, compute:

  SKILLS + TOOLS (45%)
    mandatory: canonical ID match * effectiveLevel vs required * depthWeight
    optional: canonical ID match * 0.5

  EXPERIENCE (20%)
    seniority fit (existing) + tenure density from temporal entity spans

  LANGUAGE (20%)  -- upgraded from current 10%
    graduated penalties per requirement tier (see 8.3)

  LOCATION (10%)
    existing logic, fine as-is

  TITLE/ROLE (5%)
    canonical role entity match vs job title
```

Weighted by `UserScoringPreferences.priorities` if configured. Hard constraints (must be remote, accepted languages) applied as caps.

**Speed:** < 0.5ms per job (all in-memory, fingerprint cached). 200 jobs in < 100ms.

### Phase 2: AI Deep Analysis (top 20-50 jobs only)

Claude Haiku with **graph-curated profile context** — not the full blob, but entities and claims tailored to the specific job's requirements. Better input = better output, fewer tokens.

## 8.5 User Scoring Preferences

Optional personalization layer extending `UserSearchSettings`:

```typescript
interface UserScoringPreferences {
  priorities: {
    skills: number; // weight multiplier, default 1.0
    location: number;
    language: number;
    salary: number;
    remoteWork: number;
    certification: number;
    seniority: number;
  };

  hardRequirements: {
    mustBeRemote?: boolean;
    acceptedLanguages?: string[];
    mustMatchCertification?: string[];
    maxCommuteMinutes?: number;
  };

  emphasisEntities: string[]; // canonical entity IDs to boost
  // e.g., ["ent_aws_sa_cert", "ent_gdpr_training"]
  // 1.5x boost when a job matches these
}
```

**Defaults are sane.** Without configuration, scoring works with base weights. Preferences are an optional refinement.

## 8.6 Deep Match Report (View Insights)

When user clicks "View Insights," a rich LLM analysis runs in parallel with company intelligence. The agent receives graph-curated context and produces a structured `DeepMatchReport`:

### Dimensional Scores (each 0-100 with evidence)

1. **Technical** — mandatory/optional skills coverage, tool coverage, depth quality, per-requirement detail, strengths, gaps
2. **Experience** — seniority fit, relevant years, domain overlap, trajectory alignment
3. **Language** — per-language requirement detail with proficiency gap, in-progress goals noted
4. **Culture Fit** — personality dimensions mapped to company culture keywords (from company intelligence), aligned traits, tensions, mission alignment
5. **Work Style** — arrangement match (remote/hybrid/onsite vs preferences), deal-breaker check
6. **Growth Potential** — certifications in progress with timelines + job relevance, skills in progress, career path fit
7. **Compensation** — salary range fit vs user expectations

### Application Strategy

Actionable outputs grounded in profile evidence:

- **Lead with:** strongest matches backed by quantified evidence
- **Address:** gaps with specific framing advice (e.g., "acknowledge German gap, mention B2 target")
- **Avoid:** profile elements that send wrong signals for this role

### Evidence Chain

Transparency: how many claims/drawers/entities were referenced, which personality dimensions were used, which company intel fields contributed. The user can trace any conclusion back to their actual words.

# 9. Cohort and Cross-User Projections

## 9.1 Cohort Projection Layer

The profile graph is the candidate's private asset. Cohort features consume **projections**, not the graph itself.

```typescript
interface CohortMemberProjection {
  // Identity (always visible, consented at join)
  identity: {
    displayName: string;
    headline: string;
    location: string;
  };

  // Capabilities (from entity graph, always visible)
  capabilities: {
    skills: Map<string, { effectiveLevel: number; depthWeight: number }>;
    tools: Map<string, { effectiveLevel: number; depthWeight: number }>;
    languages: Map<string, { proficiency: string; cefr: string }>;
    credentials: Map<string, { validTo: string | null; isExpired: boolean }>;
    softSkills: Map<string, { depthWeight: number }>;
    customTypes: Map<string, { depthWeight: number }>;
  };

  // Experience (always visible)
  experience: {
    totalYears: number;
    seniorityLevel: string;
    domainEntities: string[]; // industry canonical IDs
    roleEntities: string[]; // canonical role titles
  };

  // Personality (separate opt-in, not linked to transcript opt-in)
  personality?: {
    dimensions: Map<string, number>; // dimensionId -> score
    archetype: string;
    // NO rationale, NO evidence -- numeric scores only
  };

  // Growth (opt-in, same tier as personality)
  growth?: {
    goals: { entityId: string; targetLevel: string; targetDate: string | null }[];
    trajectory: 'upward' | 'lateral' | 'pivot';
  };

  // Maturity (always visible)
  maturity: {
    score: number;
    tier: 'shallow' | 'developing' | 'rich' | 'mature';
    signalBreakdown: object;
  };

  // Pre-computed match data (for fast scoring)
  matchFingerprint: UserMatchFingerprint;
}

// SK: COHORT_PROJECTION#{cohortId}#{userId}
// In: applicator-orgs table (not the profile table)
// Recomputed: on signal change + hourly aggregate refresh
```

## 9.2 Privacy Tiers

| Data                   | Facilitator Sees                      | Recruiter Sees (future)                   | Intelligence Panels      |
| ---------------------- | ------------------------------------- | ----------------------------------------- | ------------------------ |
| Skills + proficiency   | Always (consented at join)            | Anonymized                                | Aggregated only          |
| Experience summary     | Always                                | Anonymized                                | Aggregated only          |
| Languages + levels     | Always                                | Anonymized                                | Aggregated only          |
| Credentials + validity | Always                                | Anonymized                                | Aggregated only          |
| Personality scores     | **Opt-in** (separate consent)         | **Never** (until explicit future consent) | Aggregated distributions |
| Growth goals           | **Opt-in** (same tier as personality) | **Never**                                 | Aggregated counts only   |
| Verbatim drawers       | **Never** in projection               | **Never**                                 | **Never**                |
| Claim details          | **Never** in projection               | **Never**                                 | **Never**                |
| Archetype              | Opt-in (member detail only)           | Never                                     | Distribution only        |

**Key rule:** Drawers and claims never leave the candidate's graph. The projection carries only canonical entity IDs, effective levels, and numeric personality scores.

## 9.3 Graph-Powered Reverse Match

**Current:** Facilitator pastes job -> LLM extracts skills -> string overlap -> ranked list.

**New flow:**

1. LLM extraction -> canonicalization (same pipeline as candidate-side)
2. For each cohort member, read `CohortMemberProjection.matchFingerprint`
3. Score using the **same Phase 1 graph heuristic** as candidate-side: canonical ID matching, depth weighting, graduated language penalties, credential matching
4. Ranked results with per-requirement status visibility

**Quality improvements:**

- Canonical matching eliminates "AWS" != "Amazon Web Services" misses
- Depth weighting surfaces real expertise vs mentioned-once skills
- Graduated language penalties correctly rank: German-fluent member above technically-superior-but-no-German member when German is hard-required
- Growth goals surface: "Member B has GDPR in-progress (September)" alongside gap

**Performance:** Same budget (<500ms for 25 members). Projections are pre-computed; scoring is in-memory.

## 9.4 Institutional Intelligence Upgrade

The existing intelligence panels (skill gaps, market demand, search patterns, targeting analysis) gain significant quality from graph data:

### Skill Gap Analysis (Enhanced)

```
Market demands: "AWS" in 78% of matched jobs
Cohort coverage: 14/20 members (70%)

NEW: Proficiency distribution:
  expert: 2, advanced: 5, intermediate: 4, beginner: 3

NEW: Depth analysis:
  avg depthWeight: 1.1 (adequate)

NEW: Growth tracking:
  2 members actively pursuing AWS certifications

INSIGHT: "Good coverage but only 10% at expert level. Market
  demands deep AWS. Consider advanced workshops. 2 members
  pursuing certification -- track their progress."
```

### Language Gap Analysis (New)

```
German C1+ demanded in 45% of DACH job listings
Cohort coverage at C1+: 3/20 (15%)
Cohort coverage at any level: 9/20 (45%)
In-progress: 4 members studying German (B1->B2 targets)

INSIGHT: "Language is the #1 blocker for DACH placements.
  45% have some German but only 15% meet C1 threshold."
```

### Personality Landscape (New, Aggregated Only)

```
Dimension distributions (opted-in members, N=16):
  DRIVE
    Ambition: avg 7.8 (range 5.2 - 9.4)
    Purpose: avg 6.1 (range 3.8 - 8.9)
  COGNITION
    Curiosity: avg 8.2 (range 6.1 - 9.7)
  ...

Archetype distribution:
  "The Systems Optimizer" -- 4 members
  "The Creative Builder" -- 3 members
  ...

INSIGHT: "Cohort skews high on Curiosity/Ambition, lower on
  Purpose/Adaptability. Strong fit for innovative tech companies;
  may struggle in rigid compliance environments."
```

**Privacy:** Distributions show ranges and averages. Individual personality data visible only on member detail (with opt-in). Archetype names aggregated, never linked to individuals in intelligence views.

## 9.5 Job-Hunter Module Foundations

The profile graph enables a future recruiter-facing search product. This PRD does **not** specify the job-hunter module — it ensures the profile structure can support it.

### Capability Search (Future)

Instead of keyword search ("React, Berlin, 5+ years"), enable structured queries:

- Deep React experience (depthWeight > 1.0, not just mentioned once)
- Outcome metrics in frontend performance (entity type: metric, linked to frontend claims)
- Personality: high collaboration + adaptability (dimension scores from registry)
- Growth trajectory: moving toward Tech Lead (from growth goals)
- Language: German B2+ OR actively studying (entity + goal)

All possible because entity types are registry-driven (works across professions) and depth/proficiency are quantified.

### Privacy Model for Recruiter Access (Future)

Three tiers:

**Tier 0 — Search results (anonymized):** Canonical entities + scores only. No name, no company names, no verbatim text. "Candidate #4821 — React: Expert (8yr, deep), German B2."

**Tier 1 — Express interest:** Recruiter requests access. Candidate gets notification and explicitly opts in per-request.

**Tier 2 — Full profile view:** Name, profile, company history visible. Verbatim drawers still NOT shared.

### What the Profile Structure Provides

- **Cross-profession search** works because entity types are dynamic (filmmakers have `film_credit`, lawyers have `legal_case` — both queryable)
- **Depth-based filtering** works because every entity has `depthWeight` in the match fingerprint
- **Personality-culture matching** works because dimension scores are numeric and registry-driven
- **Growth trajectory** is visible through `PROFILE_GOAL` records
- **Anonymization** is clean because projections carry only canonical IDs and scores, not raw text

# 10. Constraints and Compatibility

These constraints are inherited from the existing locked architecture and must not be violated.

## Hard Constraints

1. **`PROFILE_V3` and legacy `PROFILE` are frozen.** New layers are read separately. Legacy consumers (job analysis, cover letter, CV generation) read existing records unchanged until a read-side projection opts them in.

2. **Single point of AI provider selection** is `getUserAIConfig()`. Council remains Anthropic-default. Bedrock used for embeddings/extraction is additive infra, not a provider fork.

3. **No new DynamoDB table for profile data, no new GSI at MVP.** First write to a new SK prefix is the de facto migration. (The shared canonical registry lives in a separate cross-user table.)

4. **GDPR deletion must cover new prefixes.** The existing user-deletion sweep (`src/lib/profile/cleanup.ts`) must extend to: `PROFILE_DRAWER#`, `PROFILE_ENTITY#`, `PROFILE_EDGE#`, `PROFILE_EMBEDDING#`, `PROFILE_GOAL#`, `PROFILE_INDEX`, `PROFILE_MATCH_FINGERPRINT`. Verbatim drawers are PII-dense.

5. **Opt-in promotion only.** No AI-derived claim is auto-merged. The accept/reject gate is mandatory for all mined claims.

6. **Encryption at rest.** Verbatim PII storage should not ship until encryption posture is sound. Recommend KMS before or with this work (the current `decryptKey()` is base64 encoding, not real encryption).

7. **Everything is additive.** No existing schema, route, or component is modified destructively.

## Compatibility Requirements

- **Existing council endpoints** (`council-critique`, `confirm-probe`, `dismiss-suggestion`, `dismiss-probe`, `get-latent-gaps`) continue to work identically. New actions are additive.
- **Existing profile page** continues to render from `PROFILE_V3`. Graph-powered views are opt-in additions.
- **Existing job scoring** (heuristic match, Tier 1/Tier 2 AI) continues to work. Graph-powered scoring is a parallel/replacement path, not a destructive change.
- **Existing cohort features** (maturity scoring, pipeline shape, intelligence panels) continue from current data. Projection-based features are additive.
- **Feature flag gating.** All new functionality must be behind the existing `COUNCIL_FEATURE_ENABLED` flag infrastructure (or a new `PROFILE_GRAPH_ENABLED` flag with the same staged rollout: disabled -> internal -> canary_5 -> ga).

## Career Goals and Preferences — Option A

Career goals (`careerGoals`, `preferences`, `workLifeBalance`, `growthPriorities`) and motivations (`motivations`) remain in `PROFILE_V3` / `ProfileData`. They are read separately alongside the graph by agents that need them (deep match, career coach). They are NOT promoted to graph entities at MVP.

Rationale: These fields change frequently, are user-declared (not evidence-derived), and don't benefit from the graph's depth/evidence model. If future council probes need to interrogate career goals as entities, that promotion is a future decision.

# 11. Phasing

Each phase establishes types and contracts early, then populates them. This lets implementation ship value incrementally without committing to the full graph on day one.

## Phase 0 — Types + Drawers + Shadow Mode

**Scope:** Reserve all new fields. Implement `PROFILE_DRAWER#`. Write a drawer on every `confirm-probe` (nearly free — the raw response already exists). Point new claims at `drawerRefs`. No extraction, no entities, no embeddings yet.

**Deliverables:**

- Extend `src/types/profile/facets.ts` with all new interfaces: Drawer, Entity, EntityRef, ReverseEdge, GrowthGoal, EmbeddingRecord, ProfileIndex, UserMatchFingerprint
- Implement `src/lib/profile/drawers.ts` — CRUD for `PROFILE_DRAWER#`, inline-vs-S3 threshold logic, immutability enforcement
- Modify `confirm-probe` handler to additionally write a drawer alongside the existing seed claim
- Extend GDPR deletion sweep to cover `PROFILE_DRAWER#`
- Feature flag: `PROFILE_GRAPH_ENABLED` with staged rollout tiers

**Value:** Verbatim substrate begins accumulating. Zero user-facing change. Foundation for re-mining later.

**Risk:** Minimal — one additional DynamoDB put per confirm-probe.

## Phase 1 — Entities + Edges + Canonicalization

**Scope:** `PROFILE_ENTITY#`, `PROFILE_EDGE#E2C#`, canonical registry (shared table), three-tier resolution, extraction pipeline proposing entity links from drawers, `get-entity-claims` action.

**Deliverables:**

- Implement `src/lib/profile/entities.ts` — CRUD for entities with canonicalization on write
- Implement `src/lib/profile/edges.ts` — reverse adjacency write + traversal helpers
- Create shared canonical registry table, seed from Lightcast Open Skills + Open Titles + ESCO
- Implement three-tier canonicalization (deterministic -> embedding -> LLM)
- Implement `extract-drawer` action on `POST /api/ai/profile-assistant` (async via DynamoDB Streams)
- Add `get-entity-claims` action for entity-centric queries
- Extend signal computation to factor entity density
- GDPR deletion sweep extended to `PROFILE_ENTITY#`, `PROFILE_EDGE#`
- Entity type registry (`ENTITY_TYPE_DEF#`) with seed types

**Value:** Profile becomes a graph. Cross-cutting patterns surface. Excavator can target under-articulated entities. Signal becomes richer.

## Phase 2 — Embeddings + Semantic Search + ProfileCollection

**Scope:** Bedrock embeddings, `PROFILE_EMBEDDING#` sidecar, brute-force cosine retrieval, `search-profile` action, `ProfileCollection` interface.

**Deliverables:**

- Implement `src/lib/profile/retrieval/collection.ts` — ProfileCollection interface
- Implement `src/lib/profile/retrieval/dynamo-bruteforce.ts` — MVP brute-force cosine
- Implement `src/lib/profile/retrieval/embed.ts` — Bedrock embedding generation (pinned model)
- Add `search-profile` action on `POST /api/ai/profile-assistant`
- Embed drawers on write (async pipeline extension)
- Wing/room scoped retrieval

**Value:** Semantic search over profile. Agents can find related content by meaning, not just structure. CV generation grounded in verbatim text.

## Phase 3 — Temporal Validity + Growth Goals

**Scope:** `validFrom`/`validTo`/`supersededBy` populated and surfaced. `PROFILE_GOAL#` for in-progress targets. Recency-weighted signal. Correction UX.

**Deliverables:**

- Implement `src/lib/profile/goals.ts` — GrowthGoal CRUD
- Populate temporal fields on claims and entities (extraction pipeline update)
- Recency weighting in signal computation
- "Currently valid" vs "historical" filtering in retrieval
- User-facing correction UX for temporal data
- GDPR deletion sweep extended to `PROFILE_GOAL#`

**Value:** Profile distinguishes current from historical. Stale skills flagged. Growth trajectory visible. Scoring can correctly penalize expired credentials and reward in-progress goals.

## Phase 4 — Scoring Pipeline Upgrade

**Scope:** Graph-powered job match scoring. `PROFILE_INDEX`, `PROFILE_MATCH_FINGERPRINT`, `UserScoringPreferences`, graduated language penalties, AWS Comprehend language detection, Deep Match Report.

**Deliverables:**

- Implement `PROFILE_INDEX` computation and storage
- Implement `PROFILE_MATCH_FINGERPRINT` computation and storage
- Replace heuristic match with graph-powered Phase 1 scorer (canonical matching + depth weighting + language graduation)
- Add `UserScoringPreferences` to `UserSearchSettings`
- Integrate AWS Comprehend for job description language detection
- Implement Deep Match Report (parallel with company intelligence on View Insights)
- Bidirectional canonicalization on job extraction pipeline

**Value:** Dramatically better job match quality. Canonical matching eliminates false negatives. Depth weighting surfaces real expertise. Language nuance correctly ranks jobs. Users can personalize scoring priorities.

## Phase 5 — Cohort Projections + Intelligence Upgrade

**Scope:** `COHORT_PROJECTION#` in the orgs table, graph-powered reverse match, enhanced institutional intelligence, personality landscape (aggregated).

**Deliverables:**

- Implement CohortMemberProjection computation from profile graph
- Replace string-based heuristic match in cohort with canonical/depth-aware scorer
- Upgrade intelligence panels: proficiency distributions, language gap analysis, growth tracking
- Add personality landscape panel (aggregated, opt-in)
- Privacy tier enforcement on projection data

**Value:** Cohort features gain the full quality improvement from the profile graph. Facilitators see nuanced skill coverage, language blockers, and growth trajectories.

## Phase 6 — Re-Mining + Graph UI + Dynamic Sections

**Scope:** Re-extract over verbatim substrate when extractors improve. Graph-derived UI (skills graph, entity explorer). Dynamic profile sections. Self-discoverable entity types.

**Deliverables:**

- Re-mining pipeline (batch re-extraction over existing drawers)
- Entity explorer UI (user can browse/edit entities)
- Dynamic section discovery and management
- Personality dimension registry (versioned, deprecatable)
- "Skills graph" / "Career map" visualization (opt-in power-user view)

**Value:** Profile gets richer retroactively with zero user effort. Users can explore and curate their professional identity as a network. New professions get auto-discovered sections.

## Phase Summary

| Phase | Key Deliverable               | User-Facing Change                   | Risk                                          |
| ----- | ----------------------------- | ------------------------------------ | --------------------------------------------- |
| P0    | Drawers + types               | None (shadow mode)                   | Minimal                                       |
| P1    | Entities + edges + extraction | Mined claims surfaced for review     | Medium (extraction quality, canonicalization) |
| P2    | Embeddings + semantic search  | Better CV/cover letter grounding     | Low                                           |
| P3    | Temporal + growth goals       | Stale skills flagged, growth visible | Low                                           |
| P4    | Scoring upgrade               | Better job match rankings            | Medium (scoring regression risk)              |
| P5    | Cohort projections            | Better cohort matching/intelligence  | Low                                           |
| P6    | Graph UI + re-mining          | Entity explorer, dynamic sections    | Medium (UX complexity)                        |

# 12. Risks and Mitigations

## Technical Risks

### No native vector search in DynamoDB

Brute-force cosine is only viable at small N.
**Mitigation:** Scope candidate sets by wing/room. Define N ceiling (~2,000-3,000 vectors per user). Externalize behind `ProfileCollection` seam (OpenSearch Serverless) when exceeded. Track vector counts in telemetry.

### Embeddings inflate item size / RCU cost

**Mitigation:** Sidecar `PROFILE_EMBEDDING#` items keep vectors off hot claim/drawer records. Pack as Float32 binary. Optionally int8-quantize for 4x size reduction.

### Hot partition on heavy single-user writes

Mining on every action can concentrate writes.
**Mitigation:** Async ingestion via DynamoDB Streams absorbs bursts. Batch writes where possible. Existing ULID-prefixed event-log mitigation applies.

### Entity sprawl

Duplicate nodes degrade the graph and every downstream computation.
**Mitigation:** Three-tier canonicalization on write (deterministic -> embedding -> LLM). Entity type scoping prevents cross-type collisions. Periodic merge job as fast-follow. Monitor entity count per user.

### Temporal inference error

Wrong "currently true" is worse than absent.
**Mitigation:** Default to `capturedAt`/null when uninferable. User-correctable. Never block on temporal inference.

### Extraction hallucination

LLM may fabricate claims or entity links.
**Mitigation:** Proposal-only + mandatory accept/reject gate for all mined claims. Treat user content as data (not instructions) in extraction prompts. Deduplication against existing seed claims.

## Data and Privacy Risks

### PII in verbatim drawers

Drawers are the most PII-dense records in the system.
**Mitigation:** KMS encryption at rest before verbatim storage ships. GDPR deletion sweep extended to all new prefixes. Redacted telemetry (no raw drawer text in logs). Drawers never leave the user's graph (not in cohort projections, not shared with recruiters).

### Re-embedding migration cost

Model change triggers `EmbedderIdentityMismatch`.
**Mitigation:** Pin and version the model ID on every record. Plan a re-index job as a deliberate migration. Treat model change as operational, not configuration.

### Personality data sensitivity

Personality scores are the most private layer.
**Mitigation:** Separate opt-in consent (distinct from transcript opt-in). Cohort intelligence shows only aggregated distributions, never individual scores linked to names. Recruiter access to personality: explicitly gated as a future decision, not default.

## Product Risks

### Extraction quality at launch

LLM extraction from drawers may produce low-quality claims initially.
**Mitigation:** Phase 0 is shadow mode (drawers only, no extraction). Phase 1 extraction goes through mandatory review gate. Quality metrics tracked per extraction (accept/reject ratio). Extraction prompts iterable without schema changes.

### User overwhelm from mined claims

Surfacing many "we found this" claims may feel noisy.
**Mitigation:** Batch and throttle mined claim notifications. Present as "profile insights" (positive framing), not "pending items" (task framing). Allow bulk confirm/dismiss.

### Scoring regression

Switching from string-based to canonical/depth-weighted scoring may change rankings unexpectedly.
**Mitigation:** Run parallel scoring (old + new) during canary phase. Compare distributions. Flag divergences > threshold for review. Feature-flag the scoring switch independently from graph features.

### Canonical registry maintenance

Lightcast updates biweekly; aliases accumulate from user data.
**Mitigation:** Quarterly taxonomy refresh (not biweekly — too frequent for our cadence). Alias accumulation is append-only and self-correcting. Periodic dedup sweep on the canonical table.

## Cost Risks

### Bedrock embed + extract cost per drawer

Every mined drawer incurs embedding + extraction LLM costs.
**Mitigation:** Extend council's existing cost-per-session telemetry to ingestion pipeline. Cap mining per user/day. Extraction uses cost-efficient models (Haiku for extraction, Titan for embeddings).

### Scope creep into a graph database

Multi-hop traversal, graph algorithms, Neptune.
**Mitigation:** Keep traversal one hop at MVP. Resist Neptune/multi-hop — that is an explicit future decision, not scope creep. The DynamoDB reverse-edge pattern handles all MVP access patterns.

# 13. Success Metrics

## Profile Growth Metrics

| Metric                           | Target                                      | Measurement                                                              |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| Drawers per active user per week | > 3 (after 4 weeks of use)                  | Count `PROFILE_DRAWER#` writes per user per week                         |
| Entities per active user         | > 15 after onboarding, > 40 after 4 weeks   | Count `PROFILE_ENTITY#` per user                                         |
| Mined claim accept rate          | > 60% (extraction quality signal)           | Accepted / (Accepted + Dismissed) for `extractionSource: "mined"`        |
| Entity dedup rate                | < 5% duplicate entities per user            | Periodic audit: entities that should have been canonicalized but weren't |
| Drawer origins diversity         | > 3 distinct origins per user after 4 weeks | Count distinct `origin` values across user's drawers                     |

## Retrieval Quality Metrics

| Metric                               | Target                                                              | Measurement                                                   |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Structured retrieval hit rate        | > 80% of agent tool calls resolve via Mode 1 (structured traversal) | Log retrieval mode per agent tool call                        |
| Semantic search fallback rate        | < 20% of agent queries require Mode 2                               | Log when semantic_search is called after structured traversal |
| Agent tool calls per generation task | < 10 average for CV generation                                      | Count tool calls per CV/cover-letter generation session       |
| Profile Index freshness              | < 5 minutes stale (recomputed on signal change)                     | Monitor lag between signal recompute and index update         |

## Scoring Quality Metrics

| Metric                                         | Target                                                                         | Measurement                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Canonical match improvement                    | > 15% increase in skill matches vs string-based                                | A/B: compare canonical vs string matching on same job/profile pairs |
| Language scoring precision                     | User agrees with language assessment > 85% of the time                         | Survey / feedback on "View Insights" language section               |
| Job match score correlation with user interest | Match score > 75 correlates with > 2x application rate vs < 50                 | Track application rate per match score bucket                       |
| Deep match report usefulness                   | > 70% of users who view insights find them "helpful" or "very helpful"         | In-app feedback on insight panel                                    |
| Scoring preference adoption                    | > 20% of weekly-active users configure at least one preference within 3 months | Track `UserScoringPreferences` writes                               |

## Cohort Metrics

| Metric                     | Target                                                                                    | Measurement                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Reverse match quality      | Facilitators suggest > 50% of top-5 ranked candidates (up from ~30% with string matching) | Track suggest actions vs presented rankings                    |
| Intelligence actionability | > 60% of facilitators act on at least one intelligence insight per month                  | Track actions taken after intelligence panel views             |
| Projection freshness       | < 2 hours stale for active cohorts                                                        | Monitor lag between member signal change and projection update |

## System Health Metrics

| Metric                            | Target                                                             | Measurement                                        |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Drawer write latency              | < 50ms p95 (sync path)                                             | Monitor DynamoDB put latency for `PROFILE_DRAWER#` |
| Extraction pipeline latency       | < 15s p95 (async, end-to-end from drawer write to claims proposed) | Monitor Streams -> Lambda -> completion            |
| Heuristic scoring throughput      | > 500 jobs/second per user (in-memory)                             | Benchmark Phase 1 scorer                           |
| Embedding generation cost         | < $0.001 per drawer                                                | Track Bedrock embedding costs per invocation       |
| Canonical registry lookup latency | < 5ms p95 for Tier 1                                               | Monitor DynamoDB get latency for alias lookups     |

# 14. Glossary

| Term                           | Definition                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Articulation**               | Any user-stated or confirmed assertion about professional identity. Equal status across sources (CV, probe response, manual edit).                                                                                                                  |
| **Drawer**                     | An immutable verbatim record of raw articulation text (Layer 1). Named after MemPalace's "drawer" concept. Never edited — corrections create a new drawer with `supersededBy`.                                                                      |
| **Wing**                       | Spatial scope hint on a drawer — the company or project context. Enables scoped retrieval. MemPalace term.                                                                                                                                          |
| **Room**                       | Spatial scope hint on a drawer — the topic or skill context. Enables scoped retrieval. MemPalace term.                                                                                                                                              |
| **Entity**                     | A first-class graph node (skill, tool, company, role, credential, publication, film credit, legal case, etc.) that claims link to (Layer 2). The `[[wikilink]]` target in the Obsidian analogy. Type is registry-driven, not a code enum.           |
| **Entity Type Category**       | One of eight stable ontological categories (competency, experience, credential, output, organization, relationship, metric, interest) that every entity type belongs to. The only fixed enum in the system.                                         |
| **Entity Type Registry**       | A shared table of entity type definitions (`ENTITY_TYPE_DEF#`). Types can be seed (pre-loaded), extraction-discovered (LLM found a new type), or user-declared.                                                                                     |
| **Edge**                       | A typed link between a claim and an entity. Stored reverse-only in DynamoDB (`PROFILE_EDGE#E2C#`); forward direction inline on the claim as `entityRefs[]`.                                                                                         |
| **Claim**                      | A structured assertion extracted from one or more drawers, with provenance, confidence, entity links, temporal validity, and creation path (seed or mined).                                                                                         |
| **Seed Claim**                 | A claim created directly by `confirm-probe` — user explicitly confirmed content. High confidence, instant. `extractionSource: "direct"`.                                                                                                            |
| **Mined Claim**                | A claim created by the async extraction pipeline from drawer content. Requires user review before going live. `extractionSource: "mined"`.                                                                                                          |
| **Growth Goal**                | A `PROFILE_GOAL#` record representing an in-progress target: certification being pursued, language being studied, skill being developed. Links to a canonical entity with current level, target level, and expected date.                           |
| **Signal / Radar**             | The recomputable 5-axis projection (Layer 3) embedding `PersonalityAnalysis`. Dimensions are registry-driven (versioned, deprecatable). The profile _signals_, never _scores_.                                                                      |
| **Profile Index**              | A pre-computed lightweight summary (`PROFILE_INDEX`) that agents read first for orientation — entity counts, top entities, sections, temporal range. Like `ls` for the profile graph.                                                               |
| **User Match Fingerprint**     | Pre-computed match data (`PROFILE_MATCH_FINGERPRINT`) for bulk job scoring — all entities with effective levels, depth weights, and user preferences. Cached per search session.                                                                    |
| **Canonical Entity Registry**  | A shared cross-user table mapping raw entity strings to canonical entries. Seeded from Lightcast + ESCO + curation. Prevents "AWS" and "Amazon Web Services" from being separate entities.                                                          |
| **Three-Tier Resolution**      | The canonicalization approach: (1) deterministic normalization + alias lookup, (2) embedding similarity against canonical entries, (3) LLM judge for ambiguous cases. Each resolution feeds back into Tier 1.                                       |
| **Depth Weight**               | A graph-derived numeric signal (0.0-2.0) measuring evidence density behind an entity: claim count, role span, temporal span, outcome metrics, recency. Complements user-declared proficiency.                                                       |
| **Effective Level**            | The composite competency level (0-4) combining user-declared proficiency with graph-derived depth weight. Used in all scoring.                                                                                                                      |
| **ProfileCollection**          | A thin TypeScript interface (BaseCollection-shaped, from MemPalace) wrapping semantic search. MVP: brute-force cosine in Lambda. Swappable for OpenSearch or MemPalace core without caller changes.                                                 |
| **Cohort Projection**          | A privacy-gated view of a member's profile graph (`COHORT_PROJECTION#`), pre-computed for fast cohort scoring. Carries capabilities + personality (opt-in) + match fingerprint. Never contains drawers or claim details.                            |
| **Deep Match Report**          | A structured LLM-generated analysis produced on "View Insights" — 7 scored dimensions (technical, experience, language, culture fit, work style, growth potential, compensation) with evidence chains and actionable strategy.                      |
| **Self-Growing Loop**          | The compound growth mechanism: use event -> drawer -> extracted claims + entity links -> denser graph -> sharper probes -> compounding signal evidence. The profile gets richer from normal tool usage without explicit profile editing.            |
| **Self-Discoverable Ontology** | The design principle that entity types, profile sections, and personality dimensions emerge from data rather than being hardcoded. New professions get appropriate entity types and sections automatically through extraction and user declaration. |

# 15. UI/UX Preliminary Guidelines

> **Status:** These are preliminary architectural guidelines for the Profile v2 UI, not final designs. They establish the structural principles that ensure the UI covers all PRD capabilities and is extensible for planned future features (entity explorer, free agent, career map). A dedicated UI/UX design round should follow this PRD.

## 15.1 Profile as Command Center

The profile page evolves from a "view/edit my CV sections" page to a **personal command center** — the hub from which all professional intelligence flows.

### Layout Principle: Three Zones

```
+----------------------------------------------------------------+
|  ZONE A: Identity + Signal (always visible, compact)            |
|  Name, headline, archetype, radar thumbnail, growth pulse       |
+----------------------------------------------------------------+
|                           |                                     |
|  ZONE B: Sections         |  ZONE C: Intelligence Panel         |
|  (scrollable, dynamic)    |  (contextual, right side)           |
|                           |                                     |
|  - Experience             |  Adapts based on what user is        |
|  - Skills & Tools         |  looking at:                         |
|  - Education              |  - Section selected -> Council       |
|  - Certifications         |  - Entity selected -> Entity detail  |
|  - Languages              |  - Radar clicked -> Evidence trail   |
|  - [Auto-discovered]      |  - Growth goal -> Progress tracker   |
|  - [Auto-discovered]      |  - Nothing selected -> Profile       |
|  ...                      |    health + suggestions              |
|                           |                                     |
+----------------------------------------------------------------+
```

**Zone A** is compact and persistent — the user always sees their identity summary, radar at a glance, and a "growth pulse" indicator (how much the profile grew this week/month). Clicking the radar opens the full personality dimension view.

**Zone B** contains the dynamic section list. Sections appear and reorder based on entity types present in the graph. Each section header shows: section name, entity count, depth indicator (thin/adequate/deep), and a Council trigger button. Sections are collapsible, reorderable, and hideable.

**Zone C** is the contextual intelligence panel — the same right-side space currently used by `<CouncilDrawer>`, but expanded to serve multiple contextual views. It responds to what the user is interacting with in Zone B.

### Why Command Center, Not Dashboard

A dashboard shows metrics. A command center enables action. The profile should:

- Show the user their professional identity at a glance (Zone A)
- Let them explore and curate specific areas (Zone B)
- Provide contextual intelligence and actions wherever they look (Zone C)
- Never require the user to navigate away to take the next action (council, edit, explore, search)

## 15.2 Entity Explorer and Graph Navigation

Users should be able to explore their own entities, claims, and drawers — understanding what the system knows about them and curating it.

### Entity Detail View (Zone C context)

When a user clicks on an entity (e.g., "PostgreSQL" in the Skills section):

```
+------------------------------------------+
|  PostgreSQL                    [Edit]     |
|  Type: Skill  |  Category: Competency     |
|  Proficiency: Advanced  |  Depth: Strong  |
|                                           |
|  EVIDENCE (claims linking to this entity) |
|  +--------------------------------------+|
|  | "Redesigned auth service using PG..." ||
|  | Source: Council probe, Jun 2026       ||
|  | -> [View full drawer text]            ||
|  +--------------------------------------+|
|  | "Built reporting pipeline on PG..."   ||
|  | Source: CV parse, May 2026            ||
|  +--------------------------------------+|
|                                           |
|  CONNECTIONS                              |
|  Roles: Siemens (2022-24), BMW (2020-22) |
|  Outcomes: "p99 800ms->120ms", "3x perf" |
|  Tools used with: Redis, JWT, Docker     |
|                                           |
|  TIMELINE                                 |
|  [====Siemens====][==BMW==]    [Current]  |
|  2020        2022       2024      2026    |
|                                           |
|  ACTIONS                                  |
|  [Deepen with Council] [Edit] [Archive]   |
+------------------------------------------+
```

### User Editing Capabilities

Users can directly:

- **Edit entity metadata:** correct the canonical name, adjust proficiency, add/remove aliases
- **Edit temporal validity:** set validFrom/validTo on entities and claims
- **Create entities manually:** "I also know Terraform" (adds entity without a claim/drawer — user-declared)
- **Merge entities:** "These two are the same thing" (user-assisted canonicalization)
- **Archive entities:** "This is no longer relevant" (sets validTo, doesn't delete)
- **Create growth goals:** "I'm studying for AWS SA cert, expecting August 2026"

All edits create drawers (origin: `manual`) for audit trail.

### Graph Visualization (Power User, Opt-In)

A dedicated "Career Map" or "Insights" view showing the entity graph as a force-directed visualization. NOT on the main profile page — accessible via a tab or menu item. Think of it as the Obsidian graph view applied to a career: nodes are entities, edges show relationships, clustering reveals patterns.

This is Phase 6 scope. The main profile page should be fully functional without it.

## 15.3 Council Integration

The Council remains the primary AI interaction surface. Its integration with the graph enhances every interaction.

### Section-Scoped Council (Existing, Enhanced)

The existing `<CouncilSectionTrigger>` buttons remain on each section header. The council session now has richer context:

- **Probes are entity-aware:** "You mention PostgreSQL in 3 roles but never quantify performance. Can you share a specific metric?" (Excavator targets thin entities)
- **Findings reference entities:** "Your API Design skill spans 4 roles — that's a transferable core skill. Consider leading with it."
- **Mined claim review:** After async extraction, the council panel shows: "We found 3 new insights from your last session. Review them?" with accept/edit/dismiss per claim.

### Council Session as Drawer Source

Every council session (findings + probes + user responses) produces drawers. The session itself is a growth event. The UI should subtly signal this: "This conversation is building your profile" — not as a task, but as a benefit.

### Entity-Triggered Council

From the entity detail view, the user can trigger a council session scoped to that entity: "Deepen with Council" opens a focused session where probes specifically target depth on that entity. Example: clicking "Deepen" on a thin Kubernetes entity triggers probes like "Tell me about your Kubernetes deployment practices" and "What was the most complex K8s issue you resolved?"

## 15.4 Free Agent (Consigliere)

> **Status:** Future feature. The profile structure supports it. These are architectural UI guidelines for integration when built.

### Concept

An always-available chat agent — the user's "right hand" or "consigliere" — accessible from any screen via a persistent affordance (floating button, sidebar toggle, keyboard shortcut). It can:

- Answer any professional question using profile graph context
- Trigger council sessions ("Let's deepen your AWS knowledge")
- Propose job searches ("Based on your growth goals, here are roles to consider")
- Help with real-time scenarios ("A headhunter just asked me about my distributed systems experience — help me answer")
- Navigate the profile ("Show me everything related to my Siemens period")

### UI Integration Points

```
Every screen in the application:
+--------------------------------------------------+
|  [App content - profile, jobs, CVs, etc.]        |
|                                                   |
|                                                   |
|                                    +--------+     |
|                                    | Agent  |     |
|                                    | (FAB)  |     |
|                                    +--------+     |
+--------------------------------------------------+
```

The free agent FAB (Floating Action Button) is persistent across all screens. Clicking opens a chat panel (similar to the council drawer but app-wide). The agent has access to all profile retrieval tools (Section 6.3) and can invoke other system actions.

### Profile Structure Requirements for Free Agent

The free agent's quality depends entirely on retrieval. The profile graph provides:

- `profile_index()` for orientation
- `get_entities()`, `get_entity_claims()`, `get_drawer()` for deep exploration
- `semantic_search()` for open-ended questions
- `get_signal()` for personality context
- `get_goals()` for growth trajectory

No additional profile structure is needed. The tool interface designed for the Career Coach (Section 6.3) is exactly what the free agent uses.

## 15.5 Growth Trajectory Surface

The profile should make growth visible and motivating — not as a gamification gimmick, but as genuine professional intelligence.

### Growth Pulse (Zone A)

A compact indicator showing recent profile growth:

- "Your profile grew 12% this week" (based on new claims, entities, depth increases)
- "3 new insights extracted from your cover letter sessions"
- Clicking opens a growth timeline view

### Growth Goals Panel (Zone C context)

When the user views their growth goals:

```
+------------------------------------------+
|  GROWTH TRAJECTORY                        |
|                                           |
|  German B1 -> B2                          |
|  Status: In progress                      |
|  Target: July 2026 (32 days remaining)    |
|  [===========--------] 68% (estimated)    |
|  Evidence: 4 council sessions on German   |
|  Impact: Unlocks 45% more DACH jobs       |
|                                           |
|  AWS Solutions Architect                  |
|  Status: Planned                          |
|  Target: August 2026                      |
|  Impact: Required by 23% of your matches  |
|                                           |
|  GDPR Practitioner                        |
|  Status: Planned                          |
|  Target: September 2026                   |
|  Impact: Preferred by 18% of your matches |
|                                           |
|  [+ Add Growth Goal]                      |
+------------------------------------------+
```

The "Impact" line connects growth goals to job search data — showing the user _why_ their investment matters, not just that they're progressing.

### Dynamic Section Awareness

When new entity types are discovered by extraction (e.g., a filmmaker's CV yields film credits for the first time), the profile should celebrate this:

- "We discovered a new section: Filmography (3 entries found). Add it to your profile?"
- The user confirms, and the section appears in Zone B with auto-ordered position.

### Evidence Trail Upgrade

The existing `<EvidenceTrailModal>` (opens from radar axis click) now shows the full provenance chain:

- Personality dimension score -> contributing claims -> verbatim drawer text -> linked entities
- The user sees _their actual words_ behind every score
- Entity connections are visible: "This claim about auth redesign links to Siemens, Redis, JWT, and the 10x scale outcome"

## Design Principles Summary

1. **Profile is the command center** — hub for all professional intelligence, not just a CV editor
2. **Sections are dynamic** — appear when entities exist, reorder by density, user-adjustable
3. **Intelligence is contextual** — the right panel adapts to what the user is looking at
4. **Growth is visible** — the user sees their profile compounding, with impact connected to job search outcomes
5. **The council is embedded, not bolted on** — entity-aware probes, mined claim review, deepening sessions all live naturally in the profile flow
6. **The free agent is app-wide** — persistent access to profile-grounded AI assistance from any screen
7. **Exploration before visualization** — entity detail views and evidence trails before graph visualization. Users should understand their data before seeing it as a network.
8. **No information without action** — every piece of intelligence (a thin entity, a growth goal, a scoring gap) should have a clear next step the user can take from that context

# 16. UI/UX Design Brief — Profile v2 Command Center

> **Purpose:** Design brief for creating the Profile v2 user interface. Describes the data structure the UI must surface, the problems with the current layout, the interaction challenges, and preliminary architectural proposals. Intended as input for a UI/UX design tool (claude.ai/design or equivalent) to produce visual mockups.
>
> **Status:** Design brief / handoff — not a final UI spec.

---

## 1. What the Profile Contains (Data the UI Must Surface)

The profile is no longer a static CV. It is a **three-layer knowledge graph** that grows from every user interaction. The UI must make this graph explorable, editable, and actionable.

### 1.1 The Three Layers

```
LAYER 1 — VERBATIM SUBSTRATE (Drawers)
  What it is:  Immutable records of everything the user ever said, typed,
               or uploaded. Actual quotes from council probes, CV edits,
               cover letter sessions, onboarding.
  User sees:   Quoted text in evidence views ("You said: '...'")
  User does:   Read-only. Cannot edit drawers (they are history).
  Volume:      Dozens to hundreds per user over months of use.

LAYER 2 — KNOWLEDGE GRAPH (Claims, Entities, Edges, Goals)
  What it is:  Structured intelligence extracted from drawers. The "meaning"
               behind the raw text — skills, companies, tools, roles,
               certifications, outcomes, connected by typed relationships.
  User sees:   Entity tags, section entries, connection maps, proficiency indicators.
  User does:   Explore entities, edit proficiency/metadata, confirm/dismiss
               mined claims, create growth goals, trigger council sessions.
  Volume:      15-40 entities after onboarding, growing to 50-150+ over months.

LAYER 3 — DERIVED SIGNALS (Radar, Index, Fingerprint)
  What it is:  Computed projections over the graph — personality radar,
               profile health, match scores. Recomputable, never directly edited.
  User sees:   Radar visualization, health indicators, growth pulse, match scores.
  User does:   Click to explore evidence behind scores. Cannot directly edit signals.
```

### 1.2 Key Data Objects the UI Must Render

| Object                    | What It Is                                                                                                                                            | How User Interacts                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Entity**                | A node in the graph: a skill, tool, company, role, credential, language, or any profession-specific type (publication, film credit, legal case, etc.) | View detail, edit metadata, adjust proficiency, merge duplicates, archive, connect to growth goals |
| **Claim**                 | A structured assertion extracted from drawers — "worked at Siemens on auth service using PostgreSQL"                                                  | Confirm or dismiss mined claims. View as evidence behind entities and radar scores                 |
| **Drawer**                | Verbatim text the user expressed — their actual words                                                                                                 | Read-only. Shown as sourced quotes in evidence views                                               |
| **Edge**                  | A typed connection between a claim and an entity — "used_tool", "delivered_outcome", "worked_at"                                                      | Visible as connections in entity detail. Not directly editable (derived from claims)               |
| **Growth Goal**           | An in-progress target: "German B2 by July 2026", "AWS cert by August"                                                                                 | Create, edit, track progress, see impact on job matching                                           |
| **Personality Dimension** | One of N scored traits (currently 5 meta / 17 sub) with evidence chain                                                                                | View score, explore evidence trail (claims + drawers behind the score)                             |
| **Profile Section**       | A dynamic grouping of entities by type — "Experience", "Skills", "Publications"                                                                       | Collapse/expand, reorder, rename. New sections auto-discovered from graph                          |
| **Mined Claim**           | A system-proposed claim extracted from drawers, pending user review                                                                                   | Confirm, edit, or dismiss. Shown as "insights discovered"                                          |

### 1.3 Entity Types Are Dynamic

The profile does NOT have a fixed set of sections. Entity types are **registry-driven** — the system discovers new types as the user's profile grows. A software engineer's profile has Skills, Tools, Experience. A filmmaker's has Filmography, Festivals, Grants. A lawyer's has Cases, Jurisdictions, Bar Admissions.

Eight stable **categories** group all entity types:

| Category     | What It Groups                                       | Examples                                             |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| Competency   | Skills, tools, methodologies, soft skills, languages | React, Postman, Agile, Leadership, German            |
| Experience   | Roles, projects, engagements                         | Backend Engineer at Siemens, Shell v. Milieudefensie |
| Credential   | Certifications, degrees, licenses, awards            | AWS SA, Geneva Bar, German Film Award                |
| Output       | Publications, patents, films, events produced        | Nature paper, documentary, Dubai Design Week Gala    |
| Organization | Companies, institutions, studios, courts             | Siemens, ICJ, DOK Leipzig                            |
| Relationship | Stakeholders, collaborators, clients                 | LVMH (client), Al Jazeera (commissioner)             |
| Metric       | Quantified achievements, KPIs                        | "p99: 800ms->120ms", "3,500 guests"                  |
| Interest     | Hobbies, side projects, volunteer work               | Open-source contributions, vineyard management       |

**Design implication:** The section list cannot be hardcoded. It must be data-driven — generated from the entity types present in the user's graph. New sections appear when new entity types are discovered.

### 1.4 How Entities Connect

Entities are not isolated — they form a graph of connections:

```
                    [Siemens]
                   /    |     \
            worked_at   |   worked_at
                /       |         \
  [Auth Service]    [Backend     [Redis]
    project         Engineer]      tool
        |             role          |
   delivered_outcome           used_tool
        |                          |
  [10x scale]  [p99 reduction]  [JWT]
    metric        metric         tool
        \           |           /
         \          |          /
          --- [PostgreSQL] ---
                 skill
```

**Design implication:** When a user views an entity (e.g., PostgreSQL), they should see its connections — which roles used it, which projects, what outcomes, what tools alongside it. This is the "backlinks" concept from Obsidian applied to professional identity.

### 1.5 Proficiency + Depth — Two Signals Per Entity

Every competency entity carries two complementary quality signals:

- **Proficiency** (user-declared): beginner / intermediate / advanced / expert — self-assessed, updated manually
- **Depth** (graph-derived): computed from claim count, role span, temporal span, outcome metrics, recency — grows automatically

The UI should show both: "PostgreSQL: Advanced (declared) | Deep evidence (8 claims, 4 roles, 5 years)"

A skill with high declared proficiency but low depth is a weak signal. A skill with moderate proficiency but deep evidence is a strong signal. The UI should make this distinction visible.

---

## 2. Problems with the Current Profile Layout

### 2.1 Current Structure

```
+----------------------------------------------------------+
| Header: [AI Assistant] [Edit Profile] [Save Changes]      |
+----------------------------------------------------------+
| [Personal] [Education] [Experience] [Goals] [Growth] [Psych]|
+----------------------------------------------------------+
| Signal Explainer Panel (collapsible)                       |
| [Council trigger button]                   (right-aligned) |
| [Pending suggestion cards]                    (if any)     |
+----------------------------------------------------------+
| +---------------+--------------------------------------+   |
| | Sub-tab nav   |  Section content (form inputs)       |   |
| | (col-span-3)  |  (col-span-9)                       |   |
| |               |                                      |   |
| | [Basic Info]  |  Name: [___________]                 |   |
| | [Legal Work]  |  Email: [__________]                 |   |
| | [Documents]   |  Location: [_______]                 |   |
| | [Domain]      |                                      |   |
| | [Currently]   |                                      |   |
| | [Motivations] |                                      |   |
| +---------------+--------------------------------------+   |
+----------------------------------------------------------+

                              [Council Drawer -->]
                        (right-side Sheet, modal overlay)
                   +------------------------------------+
                   | Council — Section Name              |
                   | Findings / Probes                   |
                   | (covers the profile content)        |
                   +------------------------------------+
```

**6 main tabs, 22 sub-sections, global edit toggle, Council as modal drawer.**

### 2.2 Problem 1: Too Many Clicks to Context

Getting from "I want to update my Kubernetes experience" to actually editing requires: Experience tab -> Work Experience sub-tab -> scroll to the right entry -> click Edit. Four interactions minimum before the user starts working. Sections are buried behind two levels of tab navigation.

### 2.3 Problem 2: The Council Is a Modal Interruption

The Council drawer (a Radix Sheet) slides over the profile content. The user cannot see their profile while the Council is advising them. They read a probe, close the drawer, look at their profile, reopen the drawer, respond. Constant back-and-forth between two views that should be side-by-side.

### 2.4 Problem 3: No Sense of the Connected Whole

The tab structure fragments the profile. Skills are in one tab, the projects that used them in another, the certifications that validate them in a third. The user never sees that PostgreSQL connects their Siemens experience to their BMW projects to their auth expertise. The graph's connective tissue is invisible.

### 2.5 Problem 4: Static Sections

The current 22 sub-sections are hardcoded. A filmmaker, lawyer, or event manager has no way to add Filmography, Cases, or Events Produced. The tab structure assumes everyone has the same professional structure.

### 2.6 Problem 5: No Growth Visibility

The profile doesn't show the user that it's growing. There's no indication that "your last council session added 3 insights" or "your profile is 12% richer than last week." The self-growing loop is invisible — the user has no feedback that their interactions are compounding.

### 2.7 Problem 6: Edit Mode Is All-or-Nothing

The global "Edit Profile" toggle either locks the entire page for editing or forces read-only. The user can't quickly fix one thing while exploring another. And editing never creates drawers — manual edits are lost to the graph.

---

## 3. What the UI Must Enable (Functional Requirements)

### 3.1 Core Interactions

| #   | Interaction                   | Description                                                                                                                                |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | **Browse sections**           | See all profile sections at a glance, understand which are rich and which are thin                                                         |
| I2  | **Explore an entity**         | Click any entity tag to see its detail: evidence (claims + drawers), connections, timeline, proficiency, depth                             |
| I3  | **Edit inline**               | Edit any entry directly (name, dates, description, proficiency) without a global edit toggle. Each save creates a drawer.                  |
| I4  | **Add new entries**           | Add a new experience, skill, certification, or any entity type — including types not currently in the profile                              |
| I5  | **Review mined claims**       | See system-discovered insights from drawers, confirm/edit/dismiss each one                                                                 |
| I6  | **Initiate council session**  | Start a council session scoped to a section OR a specific entity. See council findings alongside the profile content.                      |
| I7  | **Explore personality radar** | View the radar, click a dimension, trace the evidence chain down to verbatim drawer quotes                                                 |
| I8  | **Manage growth goals**       | Create, track, and update in-progress goals (certifications, language study, skill targets) with expected dates and impact on job matching |
| I9  | **Navigate connections**      | Follow entity connections: click PostgreSQL -> see it used at Siemens, BMW, with outcomes, linked to Redis, JWT                            |
| I10 | **Discover new sections**     | Be notified when the system discovers new entity types ("We found filmography entries — add as a section?")                                |
| I11 | **See growth feedback**       | Understand that the profile is growing: new claims, new entities, deeper evidence, week-over-week progress                                 |

### 3.2 Council Integration Requirements

The Council is not a separate feature — it is woven into the profile:

- **Section-level council:** Trigger a session scoped to Experience, Skills, etc. (existing, preserved)
- **Entity-level council:** Trigger a session scoped to a specific entity: "Deepen my Kubernetes knowledge" -> probes target that entity specifically
- **Mined claim review as council output:** After async extraction, mined claims appear as "Profile Insights" — framed as discoveries, not tasks
- **Side-by-side visibility:** Council findings/probes visible alongside the profile content they refer to, not in a modal overlay

### 3.3 Future Feature Readiness

The layout must accommodate without redesign:

- **Free Agent (Consigliere):** An always-available chat agent accessible from any screen. The right panel is its future home — chat messages with embedded entity cards, council triggers, and profile navigation.
- **Career Map:** A graph visualization of the entity network. Dedicated view, opt-in, accessible from the profile.
- **Match Context:** When coming from job search, the panel shows how this profile matches that specific job — which entities matched, which are gaps.

---

## 4. Layout Proposal (Preliminary — For Design Exploration)

> **Note:** This is one proposed approach. The designer should explore alternatives while respecting the functional requirements above.

### 4.1 Three-Zone Layout

```
+------+------------------------------+--------------------+
| NAV  |  SECTIONS (scrollable)       |  PANEL (persistent)|
| RAIL |                              |                    |
|      |  [Identity Card]             |  Contextual        |
| [👤] |  [Experience] ▾              |  Intelligence      |
| [💼] |    Entry 1 [entities...]     |                    |
| [🎓] |    Entry 2 [entities...]     |  Adapts to what    |
| [🛠️] |  [Skills & Tools] ▾          |  user is doing:    |
| [🌐] |    Skill cards               |                    |
| [📊] |  [Education] ▾              |  - Health Summary  |
| [🎯] |  [Certifications] ▾         |  - Entity Detail   |
| ...  |  [Languages] ▾              |  - Council Session |
|      |  [Projects] ▾               |  - Evidence Trail  |
|      |  [Auto-discovered...] ▾     |  - Mined Claims    |
|      |                              |  - Growth Goals    |
+------+------------------------------+--------------------+
 ~60px        ~55% width                    ~40% width
```

**NavRail:** Compact vertical icon sidebar. Each icon jumps to a section in the scroll. Icons show health indicators (green/amber/red/grey dots). Section list is data-driven from `PROFILE_INDEX` — auto-discovers new entity types.

**SectionScroll:** All sections as collapsible cards in a single continuous scroll. Each section shows entity count and depth indicator. Each entry shows entity tags (clickable). Per-entry edit affordances (no global edit toggle).

**IntelligencePanel:** Persistent right panel (not a modal). Shows different content based on context — health summary by default, entity detail when an entity is clicked, council session when triggered, evidence trail when a radar dimension is clicked. Panel has a breadcrumb stack for navigation history.

### 4.2 Identity Card (Top of SectionScroll)

Always visible, never collapsible. Contains:

- Profile photo + name + headline + location
- Archetype name and tagline
- Mini radar visualization (compact, clickable dimensions)
- Growth pulse: "+12% this week | 47 entities | 3 new insights"
- Click radar dimension -> Panel shows Evidence Trail
- Click "3 new insights" -> Panel shows Mined Claims Review

### 4.3 Section Cards (Collapsible)

Each section is a collapsible card with:

```
+--------------------------------------------------+
| ▾ Section Name          N entries  [depth] [✨] [+]|
+--------------------------------------------------+
|  Entry Card 1                                     |
|    Title / name / detail                          |
|    [Entity Tag] [Entity Tag] [Entity Tag]         |
|                              [Edit] [Council]     |
|                                                   |
|  Entry Card 2                                     |
|    ...                                            |
|  [+ Add Entry]                                    |
+--------------------------------------------------+
```

- **Section header:** Name, entry count, depth indicator (thin/adequate/deep), council trigger, add button
- **Entry cards:** Content + clickable entity tags + per-entry edit/council actions
- **Collapsed state:** Shows only header — user sees all sections at a glance and opens what they need

### 4.4 Entity Tags (Primary Interaction Element)

Entity tags appear throughout the profile as small colored chips:

```
[PostgreSQL ●●●●○]     — skill, advanced proficiency, 4/5 depth dots
[Siemens]              — company, no proficiency (just a connection)
[AWS SA ⚠️]            — credential, warning (expired)
[German B1 →B2]        — language, showing growth goal
```

Every tag is clickable. Click -> Panel shows Entity Detail for that entity. Tags use color coding by entity category (competency = blue, experience = purple, credential = gold, metric = green, etc.).

### 4.5 Intelligence Panel Content Types

**Health Summary (default):**

- Profile maturity score and tier
- Growth pulse (this week's changes)
- Pending items: mined claims to review, thin entities needing depth, expiring credentials
- Proactive suggestions: "Your PostgreSQL spans 4 roles but has no metrics. A council session could uncover strong evidence."
- Each suggestion has a direct action button

**Entity Detail (on entity click):**

- Entity name, type, category
- Proficiency (user-declared) + depth (graph-derived) indicators
- Evidence: claims referencing this entity, with verbatim drawer quotes
- Connections: other entities linked via shared claims (roles where used, outcomes achieved, tools used alongside)
- Timeline: temporal span visualization
- Actions: Edit, Deepen with Council, Archive, Create Growth Goal

**Council Session (on council trigger):**

- Scoped to a section or specific entity
- Findings and probes from the four council personas
- User can respond to probes inline
- Confirmed probes create drawers + claims (graph grows)
- Visible alongside the profile content (not a modal overlay)

**Mined Claims Review (on "N new insights" click):**

- Cards showing system-discovered claims from recent drawers
- Each card: the proposed insight, source drawer quote, confirm/edit/dismiss actions
- Framed as "Profile Insights" (discovery), not "Pending Tasks" (burden)
- Bulk confirm option for users who trust extraction

**Evidence Trail (on radar dimension click):**

- Personality dimension score + confidence
- Contributing claims with verbatim drawer excerpts
- Entity connections behind the evidence
- Provenance chain: score -> claim -> drawer -> "you said this on June 1st"

**Growth Goals (on growth icon click):**

- Active goals with progress tracking
- Per goal: entity name, current level, target level, expected date, status
- Impact line: "Unlocks 45% more DACH jobs" / "Required by 23% of your matches"
- Create new goal action

### 4.6 Responsive Behavior

| Breakpoint          | Layout                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop (>1280px)   | Three zones: NavRail + SectionScroll + Panel (all persistent, side-by-side)                                                                                                              |
| Tablet (768-1280px) | NavRail + SectionScroll (full width). Panel becomes a right-side Sheet (slides over on interaction, like current Council drawer but for all panel content types)                         |
| Mobile (<768px)     | Top nav bar (horizontal icons, scrollable). SectionScroll (full width, single column). Panel becomes a bottom Sheet (swipe up). Entity tags still clickable -> bottom sheet shows detail |

### 4.7 Visual Language

**Section health indicators (on nav rail icons and section headers):**

- Green dot: Deep — high claim density, outcome metrics present
- Amber dot: Adequate — some claims, room to grow
- Red dot: Thin — 1-2 claims, no metrics, needs council
- Grey dot: Empty — section exists but no entities yet

**Entity depth indicators (on entity tags):**

- Filled dots (●○○○○ to ●●●●●) showing evidence density
- Or a subtle bar/progress indicator inside the tag

**Growth pulse:**

- Compact "+N%" indicator showing week-over-week profile growth
- Green = growing, grey = stable, amber = declining (rare — happens if claims expire without replacement)

**Mined claim notification:**

- Subtle badge on Identity Card: "3 new insights"
- Not intrusive — the user discovers them when they visit the profile

---

## 5. Technical UI Context (For the Designer)

### 5.1 Current Stack

- **Framework:** Next.js 15 (App Router), React 18, TypeScript
- **Component library:** shadcn/ui (Radix UI primitives + Tailwind CSS)
- **Icons:** lucide-react
- **Existing patterns:** Cards, Sheets (right-side drawers), Tabs, Badges, Buttons (variants: default/outline/ghost), Progress bars, Dialogs
- **Dark mode:** Supported via Tailwind `dark:` prefix

### 5.2 Components That Can Be Reused

| Existing Component                    | Current Use             | v2 Use                                                  |
| ------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `Card` / `CardHeader` / `CardContent` | Section containers      | Section cards, entry cards, panel content cards         |
| `Sheet` (Radix)                       | Council drawer          | Panel on tablet/mobile (same interaction)               |
| `Badge`                               | Status labels           | Entity tags (extended with click behavior + depth dots) |
| `Button` (ghost variant)              | Council trigger         | Section actions, entity actions, panel navigation       |
| `Progress`                            | Signal axes             | Depth indicators, growth goal progress                  |
| `Tabs`                                | Main navigation         | Could be used for panel content type switching          |
| Personality Radar SVG                 | Psychology tab          | Identity Card mini radar                                |
| `CouncilModeView`                     | Council findings/probes | Panel council session content                           |
| `PendingSuggestionsList`              | Accepted suggestions    | Basis for Mined Claims Review cards                     |

### 5.3 New Components Needed

| Component                | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `NavRail`                | Vertical icon navigation sidebar with section health dots           |
| `SectionScroll`          | Container for scrollable collapsible sections                       |
| `CollapsibleSection`     | Section card with header, collapse/expand, entity count, depth      |
| `EntityTag`              | Clickable chip with entity name, depth indicator, color by category |
| `IntelligencePanel`      | Persistent right panel with content type switching and breadcrumb   |
| `EntityDetailView`       | Panel content: entity info, evidence, connections, timeline         |
| `HealthSummary`          | Panel content: maturity, growth pulse, suggestions, pending items   |
| `MinedClaimsReview`      | Panel content: mined claim cards with confirm/edit/dismiss          |
| `EvidenceTrailView`      | Panel content: dimension -> claims -> drawers provenance chain      |
| `GrowthGoalsView`        | Panel content: active goals with progress and impact                |
| `IdentityCard`           | Top-of-scroll card with photo, name, mini radar, growth pulse       |
| `PanelBreadcrumb`        | Navigation history within the panel                                 |
| `SectionDiscoveryBanner` | Notification: "New section discovered: Filmography"                 |

### 5.4 Data Flow

```
PROFILE_INDEX (one read)
    |
    +-> NavRail sections + health dots
    +-> SectionScroll section list + entity counts
    +-> IdentityCard growth pulse

Entity click -> get_entity_claims(entityId)
    |
    +-> EntityDetailView
        +-> claims with drawerRefs -> verbatim quotes
        +-> connected entities -> connection cards

Council trigger -> POST /api/ai/profile-assistant (council-critique)
    |
    +-> Panel: CouncilSession (findings + probes)

Radar click -> PROFILE_LATEST_SIGNAL
    |
    +-> Panel: EvidenceTrailView (dimension -> claims -> drawers)
```

---

## 6. Key Design Questions for the Designer

1. **How to balance information density with clarity?** The profile now contains entities, claims, depth indicators, connections, growth goals — much more than a simple CV form. How do we show richness without overwhelming?

2. **How should entity tags scale visually?** A user might have 5 entity tags on an entry or 15. How do entity tags wrap, truncate, or expand? How do different categories distinguish themselves at a glance?

3. **What's the right panel width?** Too narrow and entity detail feels cramped. Too wide and the sections feel squeezed. Should the panel be resizable?

4. **How does the panel transition between content types?** Slide? Fade? Stack? Should there be animated transitions between entity detail -> council session -> evidence trail?

5. **How to make section depth visually intuitive?** The user should glance at the nav rail and know "my Experience is rich, my Certifications are thin." What visual language conveys this most naturally?

6. **How to frame mined claims?** They should feel like discoveries ("we found something interesting") not tasks ("you have 5 pending items"). What tone and visual treatment achieves this?

7. **Where does the free agent (future) FAB sit?** It needs to be accessible from any screen without conflicting with the panel on the profile page. Bottom-right corner? Does it collapse when the panel is open?

8. **How does the Identity Card radar mini-viz work?** It needs to be compact enough for the top card but readable enough to be useful. Pentagon shape? Bar chart? Compact dot matrix?

---

## 7. Design Deliverables Requested

1. **Desktop layout** (>1280px): Three-zone layout with NavRail + SectionScroll + persistent Panel
2. **Tablet layout** (768-1280px): NavRail + SectionScroll with Panel as right Sheet
3. **Mobile layout** (<768px): Top nav + SectionScroll with Panel as bottom Sheet
4. **Identity Card** design (with mini radar, growth pulse)
5. **Section Card** design (collapsed + expanded states, with entity tags)
6. **Entity Tag** component design (with depth indicator, category color coding)
7. **Panel views:** Health Summary, Entity Detail, Council Session, Mined Claims Review, Evidence Trail, Growth Goals
8. **Panel transitions:** How content types switch, breadcrumb navigation
9. **Entity Detail** deep dive: evidence list, connections, timeline, edit affordances
10. **Mined Claims Review** flow: card design, confirm/edit/dismiss interaction, bulk actions

---

## Appendix A: User Personas for Design Context

**Primary: Job-seeking professional (active)**

- Uses Applicator daily-to-weekly
- Applies to jobs, generates CVs, runs council sessions
- Wants the profile to help them land interviews with minimal maintenance
- Values: speed, relevance, "the tool knows me"

**Secondary: Career explorer (passive)**

- Checks in monthly, explores what-if scenarios
- Uses council to deepen self-understanding
- Wants to see their professional identity as a connected whole
- Values: insight, self-discovery, "I didn't realize I had that pattern"

**Tertiary: Cohort member (guided)**

- Part of a bootcamp or training program
- Facilitator nudges them to improve profile
- Needs clear guidance on what to do next
- Values: clarity, progress indicators, "what should I do next?"

## Appendix B: Reference Implementations

**Obsidian:** Note graph visualization, backlinks panel, wikilink navigation. Reference for entity connections and graph exploration.

**LinkedIn Profile:** Section layout, skill endorsements, experience entries. Reference for what users expect (and what to improve on).

**Notion:** Database views, inline editing, sidebar navigation. Reference for the SectionScroll collapsible card pattern.

**Arc Browser:** Sidebar navigation, split view, contextual panels. Reference for the NavRail + Panel persistent layout.

**GitHub Copilot Chat:** Side panel chat that references code context. Reference for how the future free agent panel might work alongside profile content.
