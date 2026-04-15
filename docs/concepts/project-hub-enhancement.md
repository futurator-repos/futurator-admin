# Project Hub Enhancement - Design Document

**Author:** Ricardo Araya (with BMad Agent Team brainstorm)
**Date:** 2026-04-06
**Status:** Draft - Ready for Implementation
**Scope:** `/projects` page overhaul + data model expansion + public site integration

---

## 1. Problem Statement

The current `/projects` page is a read-only gallery grid of cards. It serves as a project registry but lacks:

- **Editing capability** — No UI to update project data (backend PUT exists, frontend doesn't)
- **Multi-description support** — Single `brief` field can't serve admin, public homepage, and AI agents simultaneously
- **Media management** — No images/screenshots per project
- **Publish control** — No way to toggle what appears on futurator.ai
- **Service mapping depth** — Features only track `awsServices`, not AI providers or 3rd-party integrations
- **Scanability** — Gallery grid becomes unwieldy at 11+ projects; no sorting or filtering

The public site (futurator.ai) has hardcoded placeholder projects with zero connection to the admin system.

---

## 2. Solution Overview

Transform the `/projects` page into a **Project Hub** with three consumers:

| Consumer                  | What They Need                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| **Admin (Ricardo)**       | Dense list view, quick editing, full project metadata, service maps       |
| **Public (futurator.ai)** | Curated descriptions, hero media, published projects only                 |
| **AI Agents**             | Structured context field with consistent format for project understanding |

One unified data model serves all three through selective field exposure and homepage toggles.

---

## 3. Data Model Changes

### 3.1 Updated Project Interface

```typescript
// src/types/project.ts

export type ProjectStatus = 'planning' | 'in-progress' | 'beta' | 'active';
export type ProjectCategory =
  | 'independent-companies'
  | 'joint-venture'
  | 'personal'
  | 'shared-infra';

export interface ProjectDescriptions {
  headline: string; // max 60 chars  — mobile-safe title
  brief: string; // max 140 chars — card subtitle / social sharing
  summary: string; // max 300 chars — homepage detail panel
  full: string; // max 1000 chars — admin overview
  aiContext: string; // max 2000 chars — structured AI agent context
  homepageFlags: {
    headline: boolean;
    brief: boolean;
    summary: boolean;
  };
}

export interface ProjectMedia {
  id: string;
  url: string; // S3 key or full URL
  alt: string;
  showOnHomepage: boolean;
  order: number; // sort position, 0-indexed
}

export interface Feature {
  id: string;
  name: string;
  status: ProjectStatus;
  awsServices: string[];
  aiProviders: string[]; // NEW: e.g. ["bedrock", "anthropic", "openai", "elevenlabs"]
  integrations: string[]; // NEW: e.g. ["linkedin-api", "google-oauth", "stripe"]
}

export interface Project {
  projectId: string;
  name: string;
  status: ProjectStatus;
  category: ProjectCategory;
  descriptions: ProjectDescriptions; // REPLACES: brief: string
  media: ProjectMedia[]; // NEW: max 6 items
  features: Feature[];
  awsServices: string[]; // top-level aggregate (derived or manual)
  team: string[];
  budget?: { monthlyLimit: number };
  publishedToHomepage: boolean; // NEW: master publish toggle
  homepageOrder: number; // NEW: sort position on futurator.ai
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 Character Limits Reference

| Field       | Max Chars | Purpose                          | Rationale                                       |
| ----------- | --------- | -------------------------------- | ----------------------------------------------- |
| `headline`  | 60        | Mobile card title                | Fits single line on 320px screens               |
| `brief`     | 140       | Card subtitle / sharing          | Tweet-length, scannable                         |
| `summary`   | 300       | Homepage detail panel / carousel | Matches current futurator.ai carousel text area |
| `full`      | 1000      | Admin-only overview              | Detailed internal reference                     |
| `aiContext` | 2000      | AI agent consumption             | Structured context for agent tooling            |

### 3.3 Migration Strategy

**Non-destructive migration** — no data loss:

1. Existing `brief` field value copies to `descriptions.brief`
2. `descriptions.headline` initialized from first 60 chars of `brief`
3. All other description fields start empty (`""`)
4. `media` starts as empty array `[]`
5. `publishedToHomepage` defaults to `false`
6. `homepageOrder` defaults to `0`
7. Feature `aiProviders` and `integrations` default to `[]`
8. Old `brief` field removed after migration

Migration runs as a one-time script (similar to existing `scripts/seed-projects.ts`).

### 3.4 Zod Schema Update

```typescript
// functions/shared/schemas/project-schema.ts

const descriptionsSchema = z.object({
  headline: z.string().max(60).optional(),
  brief: z.string().max(140).optional(),
  summary: z.string().max(300).optional(),
  full: z.string().max(1000).optional(),
  aiContext: z.string().max(2000).optional(),
  homepageFlags: z
    .object({
      headline: z.boolean(),
      brief: z.boolean(),
      summary: z.boolean(),
    })
    .optional(),
});

const mediaSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  alt: z.string().max(200),
  showOnHomepage: z.boolean(),
  order: z.number().int().min(0),
});

const featureSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['planning', 'in-progress', 'beta', 'active']),
  awsServices: z.array(z.string()).optional(),
  aiProviders: z.array(z.string()).optional(),
  integrations: z.array(z.string()).optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['planning', 'in-progress', 'beta', 'active']).optional(),
  category: z
    .enum(['independent-companies', 'joint-venture', 'personal', 'shared-infra'])
    .optional(),
  descriptions: descriptionsSchema.optional(),
  media: z.array(mediaSchema).max(6).optional(),
  features: z.array(featureSchema).optional(),
  awsServices: z.array(z.string()).optional(),
  team: z.array(z.string()).optional(),
  budget: z.object({ monthlyLimit: z.number().positive() }).optional(),
  publishedToHomepage: z.boolean().optional(),
  homepageOrder: z.number().int().min(0).optional(),
});
```

**Validation rule:** If `publishedToHomepage` is `true`, at least `descriptions.headline` and `descriptions.brief` must be non-empty with their respective homepage flags enabled. Enforced at the API layer.

---

## 4. UI Changes

### 4.1 List View (replaces gallery grid)

**File:** `src/app/projects/page.tsx` (rewrite)

**Layout:**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Projects (11)                                    [+ Create Project]  │
├──────────────────────────────────────────────────────────────────────┤
│ [Status ▼]  [Category ▼]  [Published ▼]           [Sort: Name A-Z ▼]│
│ Active filters: Status: beta ×                                       │
├──────────────────────────────────────────────────────────────────────┤
│ 🖼🖼🖼 │ GoMAD / Debatator  │ beta     │ Personal  │ Multi-ag… │ 🟢 │ ✏️ │
│ 🖼🖼   │ Identity Broker    │ active   │ Shared    │ Central… │ 🟢 │ ✏️ │
│ 🖼     │ Sellebra           │ planning │ Indep.    │ AI-base… │ ⚫ │ ✏️ │
│        │ MBE                │ in-prog  │ JV        │ AI-base… │ 🟢 │ ✏️ │
│ ...                                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Columns:**

| Column     | Width | Content                                                             |
| ---------- | ----- | ------------------------------------------------------------------- |
| Thumbnails | 120px | Max 3 small images (48x48), side-by-side. Placeholder icon if none. |
| Name       | flex  | Project name, clickable → detail page                               |
| Status     | 100px | Colored badge (existing `STATUS_COLORS`)                            |
| Category   | 100px | Label (existing `CATEGORY_LABELS`)                                  |
| Brief      | flex  | `descriptions.brief` truncated with ellipsis                        |
| Published  | 40px  | Green dot (published) / gray dot (not published)                    |
| Edit       | 40px  | Pencil icon → opens edit modal                                      |

**Sorting options:** Name (A-Z, Z-A), Status, Category, Last Updated, Homepage Order
**Filter options:** Status (multi-select), Category (multi-select), Published (yes/no/all)

Active filters display as removable chips below the filter bar.

### 4.2 Edit Modal

**File:** `src/components/projects/project-edit-modal.tsx` (new)

**Trigger:** Click pencil icon on any list row
**Size:** Medium-large (~800px wide, max-height 85vh with internal scroll)

**Sections (collapsible accordions):**

#### Section 1: Identity (open by default)

- **Name** — text input, max 100 chars
- **Status** — dropdown: planning / in-progress / beta / active
- **Category** — dropdown: independent / joint-venture / personal / shared-infra
- **Published to Homepage** — toggle switch
- **Homepage Order** — number input (visible only when published is ON)

#### Section 2: Descriptions (open by default)

Each description field shows:

- Label with char limit: `Headline (12/60)`
- Text input (headline, brief) or textarea (summary, full, aiContext)
- Live character counter — turns red at limit
- Homepage checkbox (▣) for headline, brief, summary only
- **Auto-generate AI Context** button — compiles from other fields:
  ```
  "[Name] is a [category] project: [brief]. Key features: [feature-names].
  Status: [status]. AWS: [awsServices]. AI: [aiProviders]. Integrations: [integrations]."
  ```

#### Section 3: Media (collapsed by default)

- Grid of thumbnail cards (max 6)
- Each card: image preview, alt text input, homepage checkbox, delete button
- Drag handles for reorder
- `[+ Add Media]` button (opens file upload → S3)
- Constraint: max 3 with `showOnHomepage: true`

#### Section 4: Features & Services (collapsed by default)

- List of feature rows, each containing:
  - Feature name (text input)
  - Feature status (dropdown)
  - AWS Services (chip input with autocomplete)
  - AI Providers (chip input with autocomplete)
  - Integrations (chip input with autocomplete)
- `[+ Add Feature]` button
- Delete feature button (with confirmation)

#### Section 5: Team (collapsed by default)

- Chip input for team member names
- `[+ Add Member]` button

**Footer:**

- `[Cancel]` — closes modal. If dirty state, confirm "Discard unsaved changes?"
- `[Save Changes]` — disabled until changes detected. Shows spinner during save. On success: brief green flash + timestamp "Saved at 14:32". On error: inline error banner at modal top, data preserved.
- Modal **stays open** after save — user closes when done.

### 4.3 Create Project Button

**Behavior for now:** Opens the same modal layout but in **informational/disabled mode**.

Banner at top:

> "Project creation requires infrastructure provisioning, cost tracking setup, and service registration. This capability is coming in a future update."

All fields visible but disabled. Gives the user a preview of the full project structure.

**Future:** Remove disabled state, wire POST endpoint, add provisioning workflow.

---

## 5. API Changes

### 5.1 Existing Endpoint Update

**`PUT /api/projects/:id`** — expand accepted body to match new schema (Section 3.4). Backward-compatible: old clients sending `brief` still work during migration window.

### 5.2 New Public Endpoint

**`GET /api/public/projects`** — unauthenticated, returns published projects only.

```typescript
// Response shape
interface PublicProject {
  name: string;
  headline: string; // only if homepageFlags.headline
  brief: string; // only if homepageFlags.brief
  summary: string; // only if homepageFlags.summary
  status: ProjectStatus;
  media: { url: string; alt: string; order: number }[]; // only showOnHomepage items
  services: string[]; // top-level awsServices for display
  order: number; // homepageOrder
}
```

**Implementation:** DynamoDB scan filtered by `publishedToHomepage === true`. Lightweight — 11 items max. No auth middleware.

### 5.3 Static Export for futurator.ai

On every `PUT /api/projects/:id` where the project has `publishedToHomepage: true`:

1. Lambda queries all published projects
2. Builds `projects-public.json` array sorted by `homepageOrder`
3. Writes to futurator.ai S3 bucket at `/data/projects.json`
4. Issues CloudFront invalidation on `/data/projects.json`

**futurator.ai integration:** Replace hardcoded `projectsData` array in `futurator.html` with:

```javascript
// Replace hardcoded array with fetch
const response = await fetch('/data/projects.json');
const projectsData = await response.json();
```

The JSON file sits in the same S3 bucket as the HTML — no CORS, no auth, no API call to admin backend. Static-on-static.

---

## 6. Files Affected

### Frontend (modify)

| File                                       | Change                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/types/project.ts`                     | Replace `brief` with `descriptions`, add `media[]`, `publishedToHomepage`, `homepageOrder`, expand `Feature` |
| `src/app/projects/page.tsx`                | Rewrite: gallery grid → list view with filters/sorting                                                       |
| `src/components/projects/project-card.tsx` | Replace with `project-list-row.tsx` (or repurpose)                                                           |
| `src/hooks/use-projects.ts`                | Add `useUpdateProject` mutation hook                                                                         |
| `src/lib/constants.ts`                     | Add service provider lists (AI, integrations) for autocomplete                                               |

### Frontend (new)

| File                                             | Purpose                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/components/projects/project-list-row.tsx`   | Single row component for list view                                       |
| `src/components/projects/project-edit-modal.tsx` | Edit modal with all sections                                             |
| `src/components/projects/project-filters.tsx`    | Filter bar + sort dropdown                                               |
| `src/components/projects/description-field.tsx`  | Reusable description input with char counter + homepage flag             |
| `src/components/projects/media-manager.tsx`      | Media grid with upload, reorder, homepage toggle                         |
| `src/components/projects/feature-editor.tsx`     | Feature row with multi-provider chip inputs                              |
| `src/components/projects/chip-input.tsx`         | Autocomplete chip input (reusable for services, providers, integrations) |

### Backend (modify)

| File                                                  | Change                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `functions/shared/schemas/project-schema.ts`          | Expand Zod schema per Section 3.4                                           |
| `functions/shared/types.ts`                           | Mirror TypeScript interface changes                                         |
| `functions/shared/repositories/project-repository.ts` | No structural change (DynamoDB is schemaless), but update type references   |
| `functions/api/index.ts`                              | Add `GET /api/public/projects` route. Add post-save S3 export logic on PUT. |

### Backend (new)

| File                                         | Purpose                                            |
| -------------------------------------------- | -------------------------------------------------- |
| `scripts/migrate-project-descriptions.ts`    | One-time migration: `brief` → `descriptions.brief` |
| `functions/shared/export-public-projects.ts` | Builds and writes `projects-public.json` to S3     |

### Public Site (modify)

| File                             | Change                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| `futurator.html` (external repo) | Replace hardcoded `projectsData` with fetch from `/data/projects.json` |

---

## 7. Service Provider Reference Lists

For autocomplete in the chip inputs:

**AWS Services:**
`s3`, `dynamodb`, `lambda`, `cloudfront`, `api-gateway`, `cognito`, `ecs`, `ecr`, `ec2`, `bedrock`, `ses`, `eventbridge`, `cloudwatch`, `iam`, `route53`, `acm`, `ssm`, `secrets-manager`, `sqs`, `sns`, `step-functions`, `kinesis`, `athena`, `glue`

**AI Providers:**
`bedrock`, `anthropic`, `openai`, `elevenlabs`, `google-ai`, `replicate`, `huggingface`, `stability-ai`, `cohere`

**3rd Party Integrations:**
`google-oauth`, `linkedin-api`, `stripe`, `github-api`, `slack-api`, `google-drive`, `google-calendar`, `sendgrid`, `twilio`, `bim-api`, `spotify-api`

These are starter lists. The chip input should also allow free-text entry for unlisted services.

---

## 8. Implementation Order

| Phase                         | Tasks                                                             | Depends On |
| ----------------------------- | ----------------------------------------------------------------- | ---------- |
| **Phase 1: Data Model**       | Update types, Zod schema, run migration script                    | Nothing    |
| **Phase 2: List View**        | Rewrite projects page, list row component, filters/sorting        | Phase 1    |
| **Phase 3: Edit Modal**       | Modal shell, Identity + Descriptions sections, save logic         | Phase 1    |
| **Phase 4: Media & Features** | Media manager, feature editor with multi-provider chips           | Phase 3    |
| **Phase 5: Public Export**    | S3 export on save, CloudFront invalidation, futurator.html update | Phase 3    |
| **Phase 6: Create Button**    | Informational-only modal (disabled fields, banner)                | Phase 3    |

Phases 2 and 3 can run in parallel after Phase 1. Phase 4 extends Phase 3. Phase 5 can start alongside Phase 4. Phase 6 is trivial after Phase 3.

---

## 9. Design Decisions Log

| Decision                | Chosen                               | Alternatives Considered                 | Why                                                                            |
| ----------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| List view vs gallery    | List view                            | Gallery grid (current)                  | Better scan density at 11+ projects, easier to add columns                     |
| Edit UX                 | Modal dialog                         | Slide-out panel, inline edit, full page | Fast context — no navigation. Modal stays open after save for multi-edit       |
| Save behavior           | Deliberate save button               | Auto-save                               | User wants "safe save" — explicit, no accidental writes                        |
| Description model       | 5-tier with per-field homepage flags | Single field, 2 fields (short/long)     | Three consumers need different lengths: mobile, desktop, AI                    |
| Public site integration | Static JSON on S3                    | Dynamic API call, SSR/ISR               | Zero-cost, no CORS, no auth, matches existing static architecture              |
| Create project          | Informational placeholder            | Full creation flow, hidden              | Scope control — creation involves infrastructure provisioning (future session) |
| AI Context field        | Structured with auto-generate        | Free-form only, fully automated         | Best of both: auto-generate for convenience, manual edit for precision         |
| Media limit             | 6 total, 3 on homepage               | Unlimited, 3 total                      | 6 covers admin needs (screenshots, diagrams), 3 keeps homepage clean           |

---

## 10. Constraints & Notes

- **DynamoDB is schemaless** — no table migration needed, only code-level type changes
- **Zero-cost target maintained** — S3 JSON export + CloudFront invalidation is negligible cost
- **Media storage** — images stored in existing S3 bucket, referenced by key. Upload handling via pre-signed URLs from Lambda
- **No breaking changes** — existing project detail page (`/projects/[id]`) continues to work, reads from same data
- **futurator.html lives in a separate repo** — coordinate the `projectsData` → fetch change when Phase 5 deploys
