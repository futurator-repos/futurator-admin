# Futurator Admin Hub - Project Hub Enhancement Epic Breakdown

**Author:** Richie
**Date:** 2026-04-06
**Version:** 1.0
**Scope:** Project Hub Enhancement (extends existing Epic 2: Project Registry)

---

## Overview

This document decomposes the [Project Hub Enhancement](./concepts/project-hub-enhancement.md) and [UX Design Specification](./ux-design-specification.md) into implementable epics and stories. Each story is sized for a single dev agent session with Claude Code.

**Prerequisites:** The original MVP 1 epics (0-4) from [epics.md](./epics.md) are implemented. The admin hub is running with authentication, project registry, cost dashboard, and resource map.

### Epic Summary

| #    | Epic                         | Stories | Depends On |
| ---- | ---------------------------- | ------- | ---------- |
| PH-1 | Theme & Shell Overhaul       | 4       | —          |
| PH-2 | Project Data Model Expansion | 4       | —          |
| PH-3 | Project List View            | 3       | PH-1, PH-2 |
| PH-4 | Project Edit Modal (Core)    | 4       | PH-2, PH-3 |
| PH-5 | Rich Editing Components      | 4       | PH-4       |
| PH-6 | Homepage Publish Pipeline    | 3       | PH-4       |

**Total: 22 stories across 6 epics**

### Sequencing

```
Parallel:    PH-1 (Theme) + PH-2 (Data Model)
Sequential:  PH-3 (List View) → PH-4 (Edit Modal Core)
Parallel:    PH-5 (Rich Editing) + PH-6 (Publish Pipeline)
```

### Reference Documents

- PRD: [docs/PRD.md](./PRD.md)
- Enhancement Spec: [docs/concepts/project-hub-enhancement.md](./concepts/project-hub-enhancement.md)
- UX Design Spec: [docs/ux-design-specification.md](./ux-design-specification.md)
- Design Mockups: [docs/ux-design-directions.html](./ux-design-directions.html)
- Architecture: [docs/architecture.md](./architecture.md)

---

## Epic PH-1: Theme & Shell Overhaul

**Goal:** Align the admin hub's visual identity with futurator.ai. Dark-first theme, Geist typography, user dropdown in sidebar — transforming the admin shell from a generic shadcn/ui app into a cohesive Futurator product.

**Value:** Visual consistency across the Futurator brand. Dark/light theme support. Modern admin UX with compact user controls.

---

### Story PH-1.1: Port Futurator OKLCH Design Tokens

As an admin user,
I want the admin hub to use the same color system as futurator.ai,
So that both products feel like part of the same brand.

**Acceptance Criteria:**

**Given** the existing admin hub with default shadcn/ui light theme
**When** I replace the CSS custom properties in `globals.css`
**Then** all OKLCH color tokens from futurator.ai are ported:

- Light mode variables (background, foreground, card, primary, secondary, muted, accent, border, input, ring, destructive, sidebar-\*)
- Dark mode variables (all corresponding dark values)
- Chart color tokens (5 chart colors for both modes)
- Custom accent tokens: `--accent-blue` (#8fc9ff dark / #3b82f6 light), `--accent-purple` (#a78bfa dark / #7c3aed light)
- Status tokens: `--success`, `--warning`, `--published`, `--unpublished`

**And** border-radius base updated to `0.625rem` (10px) matching futurator.ai
**And** all existing components (Badge, Card, Button, etc.) automatically pick up new tokens
**And** no visual regressions — all existing pages render correctly with new tokens

**Prerequisites:** None.

**Technical Notes:**

- Source tokens: futurator public site `app/globals.css` (OKLCH format)
- Target: admin hub `src/app/globals.css`
- Keep the `:root` / `.dark` pattern for theme switching compatibility
- Ref: UX Spec Section 3.1 (Color System)

---

### Story PH-1.2: Add Dark/Light Theme Toggle with next-themes

As an admin user,
I want to switch between dark and light mode,
So that I can use the admin hub comfortably in any lighting condition.

**Acceptance Criteria:**

**Given** the admin hub with ported OKLCH tokens (PH-1.1)
**When** I install and configure `next-themes`
**Then** the following is implemented:

- `ThemeProvider` wraps the app in `src/app/layout.tsx` with `attribute="class"` and `defaultTheme="dark"`
- Dark mode is the default for new sessions
- Theme preference persists in `localStorage` across page reloads
- Theme switches instantly with a smooth 0.3s transition on background/text colors
- `prefers-reduced-motion: reduce` disables the transition animation
- `<html>` tag gets `class="dark"` or `class="light"` applied correctly
- No flash of unstyled content (FOUC) on initial load

**And** all existing pages render correctly in both themes
**And** charts (Recharts) use the theme-appropriate chart color tokens

**Prerequisites:** Story PH-1.1

**Technical Notes:**

- Create `src/components/theme-provider.tsx` (client component wrapping `NextThemesProvider`)
- Add `suppressHydrationWarning` to `<html>` tag to prevent hydration mismatch
- Ref: UX Spec Section 3.4 (Effects — transition smooth)

---

### Story PH-1.3: Update Typography to Geist Font

As an admin user,
I want the admin hub to use Geist typography matching futurator.ai,
So that text rendering is consistent across the brand.

**Acceptance Criteria:**

**Given** the admin hub with theme tokens (PH-1.1)
**When** I configure Geist fonts
**Then** the following typography is applied:

- Geist Sans as primary font (available via `next/font/google` or local)
- Geist Mono as monospace font
- Page titles: weight 200, `clamp(24px, 3vw, 32px)`, letter-spacing 0.1em
- Section headings: weight 300, 18px, letter-spacing 0.05em
- Body text: weight 400, 14px, normal letter-spacing
- Labels/captions: weight 400, 12px, letter-spacing 0.02em
- Status badges: weight 500, 11px, letter-spacing 0.05em
- Modal titles: weight 200, 20px, letter-spacing 0.08em

**And** monospace font used for data values and code references
**And** CSS custom properties or Tailwind utility classes created for each typography tier
**And** existing page headings (h1 on Dashboard, Projects, Costs, etc.) use the new ultralight style

**Prerequisites:** Story PH-1.1

**Technical Notes:**

- Geist is available via `next/font/local` (Vercel's font package) or `@fontsource/geist-sans`
- Add CSS classes: `.text-page-title`, `.text-section-heading`, `.text-modal-title` or extend Tailwind
- Ref: UX Spec Section 3.2 (Typography)

---

### Story PH-1.4: User Dropdown in Sidebar

As an admin user,
I want my user controls (theme toggle, settings, sign out) in a compact dropdown at the sidebar bottom,
So that the top navigation bar is cleaner and controls are accessible but not prominent.

**Acceptance Criteria:**

**Given** the admin shell with sidebar navigation
**When** I replace the top-right "Ricardo Araya / Sign out" links with a sidebar user section
**Then** the following is implemented:

- User section appears at sidebar bottom: avatar (initials in circle, purple accent border) + name + email + chevron
- Clicking the user section opens a dropdown menu above it
- Dropdown contains: Theme toggle (shows current theme, click to switch), Settings (placeholder — no page yet), separator, Sign out (destructive style)
- Theme toggle calls `next-themes` `setTheme()` and updates label instantly
- Sign out calls existing logout flow
- Dropdown closes on click outside or Escape key
- Chevron rotates when dropdown is open

**And** the top-right "Ricardo Araya / Sign out" text is removed from the header
**And** keyboard accessible: Tab to user section, Enter to open, arrow keys to navigate dropdown items
**And** `aria-expanded` on trigger, `role="menu"` on dropdown, `role="menuitem"` on items

**Prerequisites:** Story PH-1.2 (needs theme toggle)

**Technical Notes:**

- Create `src/components/layout/user-dropdown.tsx`
- Use shadcn/ui `DropdownMenu` component (already installed)
- Modify `src/components/layout/app-shell.tsx` to remove top-right user section and add UserDropdown to sidebar
- Avatar uses `src/components/ui/avatar.tsx` with initials fallback
- Ref: UX Spec Section 6.3 (UserDropdown component), Design Mockups Panel 4

---

### Story PH-1.5: Dark Mode Token Migration (Pre-existing Color Audit)

As an admin user,
I want every page and layout component to render correctly in both light and dark modes,
So that switching themes via the user dropdown produces a coherent, accessible UI across the entire app.

**Background:**
Stories PH-1.1 through PH-1.4 successfully introduced OKLCH design tokens, the `next-themes` toggle, Geist typography, and a properly token-aware UserDropdown. However, **all hardcoded `gray-*`, `red-*`, `yellow-*`, `blue-*` Tailwind utility classes inherited from MVP-1 scaffolding remain in place** across the sidebar, header, page bodies, and chart components. These classes either ignore theme entirely or use ad-hoc `dark:` variants that don't reference the new semantic tokens (`--background`, `--foreground`, `--card`, `--muted-foreground`, `--border`, `--accent`, etc.). The result: dark mode visually "works" but is visibly inconsistent and in some places fails WCAG AA contrast.

This story is the dark-mode hardening story that PH-1 needs to legitimately ship.

**Scope (in scope):**

Replace hardcoded color utility classes with semantic theme tokens in the following files. All replacements must preserve current visual intent in light mode while producing correct dark-mode rendering.

1. **`src/components/layout/sidebar.tsx`**
   - Container: replace `border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950` with `border-border bg-card`
   - Header bar: replace `border-gray-200 dark:border-gray-800` with `border-border`
   - Toggle button: replace `text-gray-500 hover:text-gray-900` with `text-muted-foreground hover:text-foreground` (also fixes the missing dark variant on hover)
   - Active nav link: replace `bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white` with `bg-accent text-accent-foreground`
   - Inactive nav link: replace `text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-900` with `text-muted-foreground hover:bg-accent hover:text-accent-foreground`

2. **`src/components/layout/header.tsx`**
   - Container: replace `border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950` with `border-border bg-card`

3. **`src/app/page.tsx` (Dashboard)**
   - "Monthly spend" line: replace `text-gray-500` and `text-gray-900` with `text-muted-foreground` and `text-foreground`

4. **`src/app/costs/page.tsx`**
   - Provider toggle buttons: replace `bg-blue-600 text-white` (active) and `bg-gray-100` (inactive) with `bg-primary text-primary-foreground` and `bg-muted text-muted-foreground hover:bg-accent`
   - Card titles: replace `text-gray-500` with `text-muted-foreground` (3 instances)

5. **`src/app/resources/page.tsx`**
   - Card titles: replace `text-gray-500` with `text-muted-foreground` (3 instances)
   - Resource count text: replace `text-gray-500` with `text-muted-foreground`

6. **`src/app/schedules/page.tsx`**
   - Cron expression: replace `text-gray-500` with `text-muted-foreground`
   - Empty state: replace `text-gray-500` with `text-muted-foreground`
   - Delete button: replace `text-red-500 hover:text-red-700` with `text-destructive hover:text-destructive/80`

7. **`src/app/users/page.tsx`**
   - Email line: replace `text-gray-500` with `text-muted-foreground`
   - Empty state: replace `text-gray-500` with `text-muted-foreground`

8. **`src/app/alerts/page.tsx`**
   - SEVERITY_COLORS map: replace the hardcoded `bg-red-100 text-red-800` / `bg-yellow-100 text-yellow-800` / `bg-blue-100 text-blue-800` with theme-aware equivalents. Recommended approach: use Badge variant prop (`destructive` for critical, define a new `warning` variant or use `bg-warning/20 text-warning`, and `bg-accent-blue/20 text-accent-blue` for info)
   - Project badge time: replace `text-gray-500` with `text-muted-foreground`
   - Detail line: replace `text-gray-600` with `text-muted-foreground`
   - Empty state: replace `text-gray-500` with `text-muted-foreground`

9. **`src/app/auth/callback/page.tsx`**
   - Spinner border: replace `border-gray-300 border-t-blue-600` with `border-muted border-t-primary`
   - Status text: replace `text-gray-500` with `text-muted-foreground`

10. **`src/app/login/page.tsx`** (verify and fix any hardcoded colors)

**Scope (explicitly out of scope):**

- **Story 9-2's chart theme-awareness work** (`cost-trend-line.tsx`, `cost-pie-chart.tsx`, `project-ranking.tsx`) — Story 9-2 owns AC5 ("Recharts components use theme-appropriate chart color tokens"). This story does NOT touch chart components. 9-2 must be unblocked independently.
- **Story 9-1's `--unpublished` token mapping fix** (`globals.css:93,134`) — Story 9-1 owns its own AC3. Will be fixed in 9-1's dev follow-up.
- New features, refactors, or component restructuring — replacements only.
- Shadcn/ui component internals (`src/components/ui/*`) — these already use theme tokens.

**Acceptance Criteria:**

1. **Sidebar uses semantic tokens** — all color references in `sidebar.tsx` use theme tokens (`border-border`, `bg-card`, `text-muted-foreground`, `text-foreground`, `bg-accent`, `text-accent-foreground`). No `gray-*` classes remain.

2. **Header uses semantic tokens** — `header.tsx` uses `border-border` and `bg-card`. No `gray-*` classes remain.

3. **All 7 main page bodies use semantic tokens** — `page.tsx` (Dashboard), `projects/page.tsx`, `costs/page.tsx`, `resources/page.tsx`, `schedules/page.tsx`, `users/page.tsx`, `alerts/page.tsx`. All hardcoded `text-gray-*`, `bg-gray-*`, `text-red-*`, `bg-blue-*` classes are replaced with semantic tokens, EXCEPT chart components (which are owned by 9-2).

4. **Auth and login flows use semantic tokens** — `auth/callback/page.tsx` and `login/page.tsx` use semantic tokens.

5. **Alerts severity colors are theme-aware** — `SEVERITY_COLORS` map in `alerts/page.tsx` no longer uses hardcoded `bg-red-100` etc. Replacement uses theme tokens or Badge variants.

6. **No regressions in light mode** — all pages render visually identically (or improved) in light mode after the migration. Build passes.

7. **Dark mode WCAG AA compliance** — every text-on-background combination on every page in dark mode passes WCAG AA contrast (4.5:1 for normal text, 3:1 for large text). Verified via spot-check using browser devtools or an accessibility tool.

8. **No `gray-*`, `red-*`, `yellow-*`, `blue-*`, `green-*` Tailwind utility class remains in `src/app/**/_.tsx`or`src/components/layout/\*\*/_.tsx` (excluding chart components owned by 9-2)\*\* — verified by grep.

**Tasks / Subtasks:**

- [ ] Task 1: Migrate sidebar.tsx to semantic tokens (AC: 1)
  - [ ] 1.1 Replace container colors
  - [ ] 1.2 Replace header bar colors
  - [ ] 1.3 Replace toggle button colors
  - [ ] 1.4 Replace active and inactive nav link colors

- [ ] Task 2: Migrate header.tsx to semantic tokens (AC: 2)
  - [ ] 2.1 Replace container colors

- [ ] Task 3: Migrate Dashboard page (AC: 3)
  - [ ] 3.1 Replace text-gray-\* on Monthly spend line

- [ ] Task 4: Migrate Costs page (AC: 3)
  - [ ] 4.1 Replace provider toggle button colors
  - [ ] 4.2 Replace card title colors

- [ ] Task 5: Migrate Resources page (AC: 3)
  - [ ] 5.1 Replace card title colors
  - [ ] 5.2 Replace resource count colors

- [ ] Task 6: Migrate Schedules page (AC: 3)
  - [ ] 6.1 Replace cron expression and empty state colors
  - [ ] 6.2 Replace delete button colors

- [ ] Task 7: Migrate Users page (AC: 3)
  - [ ] 7.1 Replace email line and empty state colors

- [ ] Task 8: Migrate Alerts page (AC: 3, 5)
  - [ ] 8.1 Replace SEVERITY_COLORS map with theme-aware equivalents
  - [ ] 8.2 Replace project badge, detail, and empty state colors

- [ ] Task 9: Migrate auth/callback page (AC: 4)
  - [ ] 9.1 Replace spinner colors
  - [ ] 9.2 Replace status text colors

- [ ] Task 10: Audit and fix login page (AC: 4)
  - [ ] 10.1 Sweep `login/page.tsx` for hardcoded colors and replace

- [ ] Task 11: Verify in both modes (AC: 6, 7, 8)
  - [ ] 11.1 Run `npm run build` — confirm success
  - [ ] 11.2 Visual spot-check all pages in light mode
  - [ ] 11.3 Visual spot-check all pages in dark mode
  - [ ] 11.4 Run grep verification: `grep -rE "gray-[0-9]|red-[0-9]|yellow-[0-9]|blue-[0-9]|green-[0-9]" src/app src/components/layout` should return zero results (excluding chart components and shadcn/ui internals)

**Dev Notes:**

- This story emerged from systematic code review of stories 9-1 through 9-4. The findings consistently showed that while each PH-1 story did its scoped work correctly, the _integration_ of dark mode revealed pre-existing MVP-1 color hardcoding that no AC ever owned. This story closes that gap.
- **The pattern is mechanical:** read each file, find the hardcoded class, look up the equivalent semantic token, replace. Use the semantic token reference table below.
- **Do NOT touch chart components** (`src/components/charts/*.tsx`) — those are owned by Story 9-2 which is currently blocked. Touching them here would create merge conflicts and confused ownership.

**Semantic Token Reference Table:**

| Hardcoded class                                 | Semantic replacement                 | Reason               |
| ----------------------------------------------- | ------------------------------------ | -------------------- |
| `bg-white`, `dark:bg-gray-950`                  | `bg-card`                            | Card/panel surface   |
| `bg-gray-100`, `bg-gray-50`                     | `bg-muted` or `bg-accent`            | Subtle background    |
| `bg-gray-800`, `bg-gray-900` (active state)     | `bg-accent`                          | Active/hover surface |
| `border-gray-200`, `border-gray-800`            | `border-border`                      | All borders          |
| `text-gray-900`, `text-white` (primary text)    | `text-foreground`                    | Primary text         |
| `text-gray-500`, `text-gray-600`                | `text-muted-foreground`              | Secondary text       |
| `text-gray-400`                                 | `text-muted-foreground`              | Tertiary text        |
| `text-red-500`, `text-red-700`                  | `text-destructive`                   | Destructive actions  |
| `text-blue-600`, `bg-blue-600`                  | `text-primary`, `bg-primary`         | Primary actions      |
| `bg-red-100 text-red-800` (alert critical)      | Badge `destructive` variant          | Alert severity       |
| `bg-yellow-100 text-yellow-800` (alert warning) | `bg-warning/20 text-warning`         | Alert severity       |
| `bg-blue-100 text-blue-800` (alert info)        | `bg-accent-blue/20 text-accent-blue` | Alert severity       |

### Project Structure Notes

- **Modified files only** — no new files created
- ~10 files touched, all in `src/app/**/*.tsx` and `src/components/layout/*.tsx`
- Estimated diff: ~50-80 line changes total

### References

- [Source: docs/stories/9-1-port-futurator-oklch-design-tokens.md] — Established the semantic token vocabulary
- [Source: docs/stories/9-2-add-dark-light-theme-toggle.md] — Established the theme-switching mechanism (and revealed the gap this story closes)
- [Source: docs/stories/9-4-user-dropdown-in-sidebar.md] — Demonstrates the gold-standard pattern: every color via semantic token
- [Source: docs/ux-design-specification.md#3.1-Color-System] — Authoritative semantic token map

**Prerequisites:** Stories PH-1.1 (tokens defined), PH-1.2 (theme toggle exists). Can proceed in parallel with PH-1.2's chart-theming follow-up since this story explicitly excludes chart components.

**Technical Notes:**

- Mechanical find-and-replace work guided by the Semantic Token Reference Table above
- Use `grep -nE "(gray|red|yellow|blue|green)-[0-9]" src/app src/components/layout` to find remaining hardcoded colors after each task
- Do NOT touch `src/components/ui/*` (shadcn internals) or `src/components/charts/*` (owned by 9-2)
- Ref: UX Spec Section 3.1 (Color System), Story 9-4 user-dropdown.tsx as the canonical example

---

## Epic PH-2: Project Data Model Expansion

**Goal:** Expand the project data model from a flat `brief` string to a multi-description system with media, publish controls, and expanded feature service mapping. Backend-ready for the edit modal and homepage pipeline.

**Value:** One data model serving three consumers — admin, public homepage, and AI agents.

---

### Story PH-2.1: Expand TypeScript Types and Zod Schemas

As a developer,
I want the project data model updated with descriptions, media, publish fields, and expanded features,
So that the backend validates and stores the complete Project Hub data structure.

**Acceptance Criteria:**

**Given** the existing `Project` interface in `src/types/project.ts`
**When** I update the types and Zod schemas
**Then** the following types exist:

- `ProjectDescriptions` with: `headline` (max 60), `brief` (max 140), `summary` (max 300), `full` (max 1000), `aiContext` (max 2000), `homepageFlags: { headline, brief, summary }`
- `ProjectMedia` with: `id`, `url`, `alt` (max 200), `showOnHomepage`, `order`
- `Feature` expanded with: `aiProviders: string[]`, `integrations: string[]`
- `Project` gains: `descriptions: ProjectDescriptions`, `media: ProjectMedia[]` (max 6), `publishedToHomepage: boolean`, `homepageOrder: number`
- `Project` removes: `brief: string` (replaced by `descriptions`)

**And** Zod schemas in `functions/shared/schemas/project-schema.ts` validate all new fields with correct max lengths
**And** Zod enforces: if `publishedToHomepage === true`, then `descriptions.headline` must be non-empty and `homepageFlags.headline === true`, same for `brief`
**And** Zod enforces: max 6 media items, max 3 with `showOnHomepage === true`
**And** shared types in `functions/shared/types.ts` mirror the frontend types

**Prerequisites:** None.

**Technical Notes:**

- Ref: Enhancement Doc Section 3 (Data Model Changes), Section 3.4 (Zod Schema Update)
- DynamoDB is schemaless — no table migration needed
- The existing PUT endpoint validation will use the updated Zod schema

---

### Story PH-2.2: Data Migration Script

As a developer,
I want existing project data migrated to the new schema format,
So that the 11 seeded projects work with the expanded data model without manual re-entry.

**Acceptance Criteria:**

**Given** 11 projects in DynamoDB with the old schema (`brief: string`, features without `aiProviders`/`integrations`)
**When** I run the migration script
**Then** for each project:

- `brief` value copied to `descriptions.brief`
- `descriptions.headline` set to first 60 characters of `brief`
- `descriptions.summary`, `descriptions.full`, `descriptions.aiContext` set to `""`
- `descriptions.homepageFlags` set to `{ headline: false, brief: false, summary: false }`
- `media` set to `[]`
- `publishedToHomepage` set to `false`
- `homepageOrder` set to `0`
- Each feature gets `aiProviders: []` and `integrations: []`
- Old `brief` field removed from the DynamoDB item

**And** script is idempotent — running it twice produces the same result
**And** script logs each project migrated with old/new field summary
**And** `updatedAt` timestamp updated on each migrated project

**Prerequisites:** Story PH-2.1

**Technical Notes:**

- Create `scripts/migrate-project-descriptions.ts`
- Use existing DynamoDB document client from `functions/shared/dynamo-client.ts`
- Scan all projects, transform each, put back with new structure
- Ref: Enhancement Doc Section 3.3 (Migration Strategy)

---

### Story PH-2.3: Update API Hooks and Client Types

As a developer,
I want the frontend API hooks and client to work with the expanded project types,
So that the UI can read and write the new project fields.

**Acceptance Criteria:**

**Given** the updated TypeScript types (PH-2.1)
**When** I update the React Query hooks
**Then** the following changes are made:

- `useProjects()` returns `Project[]` with new type shape
- `useProject(id)` returns `Project` with new type shape
- New `useUpdateProject()` mutation hook: calls `PUT /api/projects/:id`, invalidates project queries on success, returns mutation state (isPending, isError, error, isSuccess)
- API client `src/lib/api-client.ts` — no structural change (already sends PUT), but type assertions updated

**And** `src/lib/constants.ts` updated with:

- `AWS_SERVICES` array for autocomplete (s3, dynamodb, lambda, cloudfront, etc.)
- `AI_PROVIDERS` array (bedrock, anthropic, openai, elevenlabs, etc.)
- `INTEGRATIONS` array (google-oauth, linkedin-api, stripe, etc.)

**And** all existing pages that consume `project.brief` updated to read from `project.descriptions.brief`
**And** no TypeScript errors across the codebase

**Prerequisites:** Story PH-2.1

**Technical Notes:**

- Modify `src/hooks/use-projects.ts` — add `useMutation` for updates
- Update `src/components/projects/project-card.tsx` to read `project.descriptions.brief` (temporary — will be replaced by list row in PH-3)
- Update `src/components/projects/project-tabs.tsx` similarly
- Ref: Enhancement Doc Section 6 (Files Affected)

---

### Story PH-2.4: Public Projects API Endpoint

As a developer,
I want a public unauthenticated endpoint that returns published projects,
So that futurator.ai can fetch project data without auth.

**Acceptance Criteria:**

**Given** the expanded project data model with `publishedToHomepage`
**When** I add `GET /api/public/projects` to the Hono API
**Then** the endpoint:

- Is NOT behind auth middleware (public access)
- Returns only projects where `publishedToHomepage === true`
- Response shape: `{ name, headline, brief, summary, media: [{ url, alt, order }], status, services, order }`
- Only returns descriptions where `homepageFlags[field] === true`
- Only returns media where `showOnHomepage === true`
- Sorted by `homepageOrder` ascending
- Returns `[]` if no projects are published

**And** CORS allows `https://futurator.ai` origin (in addition to existing admin origins)
**And** response is cacheable (Cache-Control: public, max-age=300)

**Prerequisites:** Story PH-2.1

**Technical Notes:**

- Add route in `functions/api/index.ts` BEFORE auth middleware
- DynamoDB scan with filter `publishedToHomepage = true` (11 items max — scan is fine)
- Map and filter fields before returning
- Ref: Enhancement Doc Section 5.2 (New Public Endpoint)

---

## Epic PH-3: Project List View

**Goal:** Replace the gallery card grid with a dense, scannable list view with filtering and sorting. The primary admin interface for project triage.

**Value:** Faster project scanning, visual publish status at a glance, foundation for edit modal trigger.

---

### Story PH-3.1: ProjectListRow Component

As an admin user,
I want projects displayed as dense table rows instead of cards,
So that I can scan all 11 projects quickly with key info visible.

**Acceptance Criteria:**

**Given** the projects page at `/projects`
**When** I replace the card grid with a list view
**Then** each project renders as a row with columns:

- **Thumbnails** (120px): Max 3 small images (36x36), placeholder icon if no media
- **Name** (flex): Project name, clickable → navigates to `/projects/[id]`, hover turns accent-blue
- **Status** (90px): Colored badge (existing STATUS_COLORS mapping)
- **Category** (100px): Label text (existing CATEGORY_LABELS mapping)
- **Brief** (flex): `descriptions.brief` truncated with text-overflow ellipsis
- **Published** (44px): Green dot if `publishedToHomepage`, gray dot if not
- **Edit** (44px): Pencil icon button (placeholder — modal wired in PH-4)

**And** rows have: subtle bottom border, hover background elevation, smooth 0.1s transition
**And** header row shows column labels in uppercase 11px muted text
**And** loading state shows 6 skeleton rows matching the grid layout
**And** the list container has `border-radius: 10px` and `border: 1px solid var(--border)`
**And** published dot has `aria-label="Published to homepage"` / `"Not published to homepage"`
**And** edit button has `aria-label="Edit [project name]"`

**Prerequisites:** PH-1.1 (tokens), PH-2.1 (types), PH-2.3 (hooks)

**Technical Notes:**

- Create `src/components/projects/project-list-row.tsx`
- Rewrite `src/app/projects/page.tsx` — remove grid, use table-style list
- Keep `project-card.tsx` for now (detail page may still use it) or mark for cleanup
- Ref: UX Spec Section 6.3 (ProjectListRow), Design Mockups Panel 2

---

### Story PH-3.2: FilterBar with Sorting

As an admin user,
I want to filter projects by status, category, and published state, and sort by various fields,
So that I can quickly narrow down what I need to see.

**Acceptance Criteria:**

**Given** the project list view (PH-3.1)
**When** I add the filter bar above the list
**Then** the following is implemented:

- Three filter dropdowns: Status (multi-select: planning/in-progress/beta/active), Category (multi-select: personal/independent/joint-venture/shared-infra), Published (All/Published/Not Published)
- Sort dropdown (right-aligned): Name A-Z, Name Z-A, Status, Category, Last Updated, Homepage Order
- Active filters display as removable chips below the filter bar: "Status: beta x"
- Removing a chip clears that filter
- Page count updates: "Projects (4 of 11)" when filtered
- All filtering and sorting is client-side (instant, no loading state)
- Default: no filters, sorted Name A-Z

**And** filter state resets on page navigation (not persisted — too volatile for single-user)
**And** URL does not change with filter state (no query params — keep it simple)
**And** "No projects match your filters" empty state with "Clear filters" ghost button

**Prerequisites:** Story PH-3.1

**Technical Notes:**

- Create `src/components/projects/filter-bar.tsx`
- Use `useMemo` for filtered/sorted list derivation from `useProjects()` data
- Filter selects can use shadcn/ui `Select` or `Popover` with checkboxes for multi-select
- Ref: UX Spec Section 6.3 (FilterBar), Section 7.1 (Empty State Patterns)

---

### Story PH-3.3: Create Project Button (Informational)

As an admin user,
I want a Create Project button visible on the projects page,
So that I can see the project structure even though creation requires future backend work.

**Acceptance Criteria:**

**Given** the project list view with filter bar
**When** I add the Create Project button
**Then** the following is implemented:

- Primary button "+ Create Project" in the page header, right-aligned
- Clicking opens a dialog with informational banner:
  > "Project creation requires infrastructure provisioning, cost tracking setup, and service registration. This capability is coming in a future update."
- The dialog shows the same modal layout as the edit modal (accordion sections) but all fields are disabled/grayed out
- A "Close" button dismisses the dialog
- No form submission, no API call

**And** the button uses the accent-blue primary style
**And** the disabled fields visually communicate "preview only" (reduced opacity, no focus states)

**Prerequisites:** Story PH-3.1

**Technical Notes:**

- Reuse the modal shell that will be built in PH-4 (or build a simplified preview version)
- If PH-4 is not yet complete, build a simple AlertDialog with the banner text and a structural wireframe
- Ref: Enhancement Doc Section 4.3 (Create Project Button)

---

## Epic PH-4: Project Edit Modal (Core)

**Goal:** A medium-large modal dialog for editing project data with the Identity and Descriptions sections — the core editing experience.

**Value:** First write capability for project data through the admin UI. Enables updating descriptions, status, publish state.

---

### Story PH-4.1: Edit Modal Shell with Accordion Layout

As an admin user,
I want a modal dialog that opens when I click the edit icon on a project row,
So that I can edit project data without navigating away from the list.

**Acceptance Criteria:**

**Given** the project list with edit buttons (PH-3.1)
**When** I click the edit pencil icon on a project row
**Then** the following modal opens:

- shadcn/ui `Dialog` component, max-width 800px, max-height 85vh
- Glassmorphic overlay: `backdrop-filter: blur(4px)`, dark semi-transparent background
- Header: "Edit Project: [project name]" (modal-title typography: weight 200, 20px) + close button (X)
- Body: Scrollable container with accordion sections (Identity, Descriptions, Media, Features, Team) — all collapsible
- Footer: Save status text (left) + Cancel button + Save Changes button (right)
- Modal opens with smooth 0.3s ease transition
- Escape key or close button dismisses

**And** Identity and Descriptions sections open by default; Media, Features, Team collapsed
**And** modal does NOT close on overlay click (prevents accidental dismiss during editing)
**And** focus is trapped inside the modal while open
**And** `role="dialog"`, `aria-labelledby` pointing to modal title
**And** first input (Name field) receives auto-focus on open

**Prerequisites:** PH-3.1 (edit button trigger)

**Technical Notes:**

- Create `src/components/projects/project-edit-modal.tsx`
- Use shadcn/ui `Dialog` for modal shell, `Collapsible` or custom accordion for sections
- Pass `projectId` as prop, fetch project data via `useProject(id)`
- Wire edit button click in `project-list-row.tsx` to open modal with selected project ID
- Ref: UX Spec Section 6.3 (ProjectEditModal), Section 7.1 (Modal Patterns), Design Mockups Panel 3

---

### Story PH-4.2: Identity Section

As an admin user,
I want to edit a project's name, status, category, publish state, and homepage order,
So that I can control project identity and homepage visibility.

**Acceptance Criteria:**

**Given** the edit modal open for a project (PH-4.1)
**When** I interact with the Identity section
**Then** the following fields are editable:

- **Name**: Text input, max 100 chars, with character counter
- **Status**: Select dropdown with options: planning, in-progress, beta, active
- **Category**: Select dropdown with options: Personal, Independent, Joint Venture, Shared Infra
- **Published to Homepage**: Toggle switch — accent-blue when on
- **Homepage Order**: Number input (visible only when published toggle is ON), min 0

**And** changing any field enables the Save button (dirty state detection)
**And** toggle switch transitions smoothly (0.2s)
**And** Homepage Order field animates in/out when publish toggle changes

**Prerequisites:** Story PH-4.1

**Technical Notes:**

- Use `useState` for local form state, initialize from project data
- Dirty detection: compare current form state with initial project data
- Use shadcn/ui `Switch` for toggle, `Select` for dropdowns, `Input` for text/number
- Ref: Design Mockups Panel 3 (Identity section)

---

### Story PH-4.3: Descriptions Section with Character Counters

As an admin user,
I want to edit multiple project descriptions with live character counters and homepage flags,
So that I can craft the right text for different audiences (admin, homepage, AI agents).

**Acceptance Criteria:**

**Given** the edit modal open for a project (PH-4.1)
**When** I interact with the Descriptions section
**Then** 5 description fields are shown, each with:

- Label + character counter showing `N/max` (e.g., "42/60")
- Character counter turns warning color at 90% of limit
- Character counter turns error color when at/over limit
- Input is NOT blocked at limit (user can type, but save validation will reject)
- Homepage checkbox (checked/unchecked) for Headline, Brief, and Summary only — not for Full or AI Context
- "homepage" hint text next to each checkbox

**And** field types: Headline (single-line input, 60), Brief (single-line input, 140), Summary (textarea 2 rows, 300), Full (textarea 3 rows, 1000), AI Context (textarea 3 rows, 2000)
**And** AI Context has an "Auto-generate" button (purple accent) that compiles from other project fields:
`"[Name] is a [category] project: [brief]. Key features: [feature-names]. Status: [status]. AWS: [awsServices]. AI: [aiProviders]. Integrations: [integrations]."`
**And** auto-generate replaces existing AI Context content (with confirmation if field is non-empty)
**And** character counters use `aria-live="polite"` for screen reader updates

**Prerequisites:** Story PH-4.1, PH-4.2 (form state pattern established)

**Technical Notes:**

- Create `src/components/projects/description-field.tsx` — reusable component accepting: label, maxLength, value, onChange, showHomepageFlag, homepageFlagged, onHomepageFlagChange, multiline
- Auto-generate reads from the current form state (not saved data)
- Ref: UX Spec Section 6.3 (DescriptionField), Design Mockups Panel 3 (Descriptions section)

---

### Story PH-4.4: Save Flow with Validation and Feedback

As an admin user,
I want to save my edits with clear feedback on success or failure,
So that I know my changes are persisted and can trust the save action.

**Acceptance Criteria:**

**Given** the edit modal with dirty state (changes made)
**When** I click Save Changes
**Then** the following flow executes:

- Save button shows spinner, becomes disabled
- Client-side validation runs: char limits, required fields for published projects
- If validation fails: inline red borders on offending fields + helper text, save aborted, button re-enables
- If validation passes: `PUT /api/projects/:id` called via `useUpdateProject()` mutation
- On success: button flashes green briefly (0.5s), footer shows "Saved at HH:MM" timestamp, project list row updates in background (React Query invalidation), modal STAYS OPEN
- On error: red banner at top of modal body: "Failed to save: [error message]. Your changes are preserved.", button re-enables

**And** Cancel button: if clean state, closes modal. If dirty state, shows AlertDialog: "You have unsaved changes. Discard?" [Keep editing] [Discard]
**And** Close (X) button behaves same as Cancel
**And** Escape key behaves same as Cancel
**And** save button is disabled when form is clean (no changes)
**And** after save, form state resets to the new saved values (clean state)

**Prerequisites:** Stories PH-4.2, PH-4.3, PH-2.3 (useUpdateProject hook)

**Technical Notes:**

- Validation: run Zod schema client-side before API call for instant feedback
- Use `useUpdateProject` mutation's `onSuccess` and `onError` callbacks
- Timestamp: `new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })`
- AlertDialog for unsaved changes: use shadcn/ui `AlertDialog`
- Ref: UX Spec Section 7.1 (Feedback Patterns, Confirmation Patterns)

---

## Epic PH-5: Rich Editing Components

**Goal:** Extend the edit modal with complex components for managing features, services, media, and team members.

**Value:** Complete project editing capability — full feature-service mapping, visual media management, team assignment.

---

### Story PH-5.1: ChipInput Component with Autocomplete

As an admin user,
I want a tag-style input that lets me add/remove services with autocomplete suggestions,
So that I can quickly map AWS services, AI providers, and integrations to features.

**Acceptance Criteria:**

**Given** the need for multi-select tag inputs across Features and Team sections
**When** I create the ChipInput component
**Then** the following is implemented:

- Container with existing chips + text input at the end
- Typing filters a suggestion dropdown below the input
- Enter or click on suggestion adds it as a chip
- Free-text entry allowed (Enter on non-matched text creates a chip)
- Backspace on empty input removes the last chip
- Each chip has a label + X remove button
- Chip visual variants: AWS (gold/amber), AI Provider (purple), Integration (green), Default (neutral)
- Dropdown shows max 8 suggestions, scrollable if more
- Component accepts: `value: string[]`, `onChange`, `suggestions: string[]`, `variant`, `placeholder`

**And** keyboard navigation: Tab to input, type to filter, arrow keys to navigate suggestions, Enter to select
**And** `aria-label` on input, `role="listbox"` on dropdown, `role="option"` on suggestions
**And** component is reusable across Features section and Team section

**Prerequisites:** PH-4.1 (modal exists to place component in)

**Technical Notes:**

- Create `src/components/projects/chip-input.tsx`
- Suggestion lists from `src/lib/constants.ts` (AWS_SERVICES, AI_PROVIDERS, INTEGRATIONS)
- Filter: case-insensitive substring match
- Ref: UX Spec Section 6.3 (ChipInput)

---

### Story PH-5.2: FeatureEditor with Multi-Provider Chips

As an admin user,
I want to edit project features with their status and all associated services,
So that I have a complete dependency map of which feature uses which services.

**Acceptance Criteria:**

**Given** the edit modal's Features & Services accordion section
**When** I interact with the feature editor
**Then** each feature renders as an editable row containing:

- Feature name: inline text input (click to edit, transparent border, shows border on hover/focus)
- Feature status: small badge/dropdown (planning/in-progress/beta/active)
- AWS Services: ChipInput with AWS variant (gold chips), autocomplete from AWS_SERVICES list
- AI Providers: ChipInput with AI variant (purple chips), autocomplete from AI_PROVIDERS list
- Integrations: ChipInput with Integration variant (green chips), autocomplete from INTEGRATIONS list

**And** "+ Add Feature" button at bottom (dashed border, accent-blue on hover)
**And** each feature row has a delete button (appears on hover, right side)
**And** delete shows inline confirmation: row content replaced with "Remove [name]? [Cancel] [Remove]"
**And** new features are created with: empty name (focused for input), status "planning", empty service arrays
**And** accordion header shows feature count: "Features & Services (5)"

**Prerequisites:** Story PH-5.1 (ChipInput), PH-4.1 (modal)

**Technical Notes:**

- Create `src/components/projects/feature-editor.tsx`
- Feature list is part of modal form state — edits are local until Save
- Generate unique ID for new features: `crypto.randomUUID()`
- Ref: UX Spec Section 6.3 (FeatureEditor), Design Mockups Panel 3 (Features section)

---

### Story PH-5.3: MediaManager Component

As an admin user,
I want to upload, reorder, and manage project media with homepage toggle,
So that I can curate which images represent the project on futurator.ai.

**Acceptance Criteria:**

**Given** the edit modal's Media accordion section
**When** I interact with the media manager
**Then** the following is implemented:

- Grid of thumbnail cards (100x72px) showing existing media + "Add media" card
- Each thumbnail shows: image preview (or placeholder icon), alt text truncated, homepage badge (blue dot in top-right corner if `showOnHomepage`)
- Click thumbnail to open edit popover: alt text input, homepage toggle, delete button
- "Add media" card (dashed border): click opens file input dialog
- Upload flow: select file → generate unique S3 key → upload via pre-signed URL → add to media array
- Drag-to-reorder thumbnails (update `order` field)
- Maximum 6 media items total (Add card hidden when at limit)
- Maximum 3 with `showOnHomepage: true` (checkbox disabled with tooltip when at limit)

**And** accordion header shows count: "Media (2 of 6)"
**And** supported formats: PNG, JPG, WebP (validate on client before upload)
**And** max file size: 5MB (validate on client)
**And** upload progress indicator on thumbnail during upload

**Prerequisites:** PH-4.1 (modal), PH-2.1 (media type)

**Technical Notes:**

- Create `src/components/projects/media-manager.tsx`
- For pre-signed URLs: may need a new endpoint `POST /api/projects/:id/upload-url` that returns a pre-signed S3 PUT URL
- Alternatively, handle upload in the save flow — simpler but less responsive
- Drag reorder: use `@dnd-kit/core` or native HTML drag/drop
- Ref: UX Spec Section 6.3 (MediaManager)

---

### Story PH-5.4: Team Section

As an admin user,
I want to manage team members assigned to a project,
So that I can track who is working on what.

**Acceptance Criteria:**

**Given** the edit modal's Team accordion section
**When** I interact with the team section
**Then** the following is implemented:

- ChipInput (default variant) showing current team members as chips
- Typing suggests from existing team members across all projects (deduplicated)
- Free-text entry allowed for new member names
- Backspace removes last member
- Each chip has X to remove

**And** accordion header shows count: "Team (1)"
**And** component uses the same ChipInput from PH-5.1

**Prerequisites:** Story PH-5.1 (ChipInput)

**Technical Notes:**

- Reuse `ChipInput` with `variant="default"` and `suggestions` loaded from all projects' team arrays
- Team suggestions: derive from `useProjects()` data — `Array.from(new Set(projects.flatMap(p => p.team)))`
- Ref: Design Mockups Panel 3 (Team section)

---

## Epic PH-6: Homepage Publish Pipeline

**Goal:** When a project is saved with publish enabled, automatically export a static JSON file for futurator.ai consumption. Bridge the admin hub to the public site.

**Value:** Projects managed in admin appear on futurator.ai without manual HTML editing or deployment.

---

### Story PH-6.1: S3 Static JSON Export on Save

As an admin user,
I want published project data automatically exported to S3 when I save,
So that futurator.ai shows up-to-date project information.

**Acceptance Criteria:**

**Given** a project saved with `publishedToHomepage: true`
**When** the PUT endpoint completes successfully
**Then** a post-save hook:

- Queries DynamoDB for all projects where `publishedToHomepage === true`
- Builds a JSON array sorted by `homepageOrder`:
  ```json
  [{ "title": "...", "headline": "...", "brief": "...", "summary": "...",
     "media": [{ "url": "...", "alt": "...", "order": 0 }],
     "status": "...", "services": [...], "order": 0 }]
  ```
- Only includes descriptions where `homepageFlags[field] === true`
- Only includes media where `showOnHomepage === true`
- Writes to futurator.ai S3 bucket at key `data/projects.json`
- Returns without blocking the API response (fire-and-forget or async)

**And** if no projects are published, writes an empty array `[]`
**And** if S3 write fails, logs error but does NOT fail the project save (non-critical)
**And** export runs only when the saved project has `publishedToHomepage === true` OR when `publishedToHomepage` changed from `true` to `false` (removal from homepage)

**Prerequisites:** PH-4.4 (save flow), PH-2.1 (types)

**Technical Notes:**

- Create `functions/shared/export-public-projects.ts`
- Call from the PUT handler in `functions/api/index.ts` after successful DynamoDB update
- S3 bucket name: get from SST config or environment variable
- Write with `Content-Type: application/json` and `Cache-Control: public, max-age=300`
- Ref: Enhancement Doc Section 5.3 (Static Export)

---

### Story PH-6.2: CloudFront Cache Invalidation

As an admin user,
I want the futurator.ai CDN cache cleared after export,
So that visitors see updated projects within minutes, not hours.

**Acceptance Criteria:**

**Given** the S3 export completes (PH-6.1)
**When** `projects.json` is written to S3
**Then** a CloudFront invalidation is created for `/data/projects.json`

**And** invalidation is fire-and-forget (don't wait for completion — takes 1-5 minutes)
**And** if invalidation fails, log error but don't fail the save
**And** IAM role for the Lambda has `cloudfront:CreateInvalidation` permission for the futurator.ai distribution

**Prerequisites:** Story PH-6.1

**Technical Notes:**

- Use `@aws-sdk/client-cloudfront` `CreateInvalidationCommand`
- CloudFront distribution ID: from SST config or environment variable
- Invalidation path: `/data/projects.json`
- Add to the export function after S3 write
- Ref: Enhancement Doc Section 5.3

---

### Story PH-6.3: Futurator.ai Homepage Integration

As a futurator.ai visitor,
I want the projects section to show real project data from the admin hub,
So that I see actual Futurator projects instead of placeholder content.

**Acceptance Criteria:**

**Given** `data/projects.json` exists in the futurator.ai S3 bucket
**When** the futurator.ai page loads
**Then** the projects section:

- Fetches `/data/projects.json` on page initialization
- Parses the JSON array into the `projectsData` format
- Maps fields: `title` → project name, `summary` or `brief` → description text, `media` → slide data
- Renders the project wheel and detail panel with real data
- Falls back to a "Projects coming soon" message if fetch fails or array is empty

**And** the hardcoded `projectsData` array is removed from `futurator.html`
**And** the fetch uses a relative URL `/data/projects.json` (same S3 bucket, no CORS needed)
**And** the existing Three.js background, wheel interaction, and carousel continue to work with dynamic data

**Prerequisites:** Story PH-6.1 (JSON exists in S3)

**Technical Notes:**

- Modify `/Users/ricardoarayafarias/GetReal/Clients/futurator/public/futurator.html`
- Replace the `const projectsData = [...]` with `fetch('/data/projects.json')` + fallback
- The existing rendering code expects `{ title, text, media: [{ type, content }] }` — map the new JSON shape to match
- This story touches a DIFFERENT repo (futurator public site, not admin hub)
- Ref: Enhancement Doc Section 5.3

---

## Summary

### Requirement Coverage

| PRD/Enhancement Requirement               | Covered By     |
| ----------------------------------------- | -------------- |
| Multi-description system with char limits | PH-2.1, PH-4.3 |
| Homepage publish toggle per project       | PH-2.1, PH-4.2 |
| Per-field homepage flags on descriptions  | PH-2.1, PH-4.3 |
| Media gallery per project (max 6)         | PH-2.1, PH-5.3 |
| Media homepage toggle (max 3)             | PH-2.1, PH-5.3 |
| List view replacing gallery grid          | PH-3.1         |
| Sorting and filtering                     | PH-3.2         |
| Edit modal (medium-large dialog)          | PH-4.1         |
| Deliberate save with feedback             | PH-4.4         |
| Feature mapping: AWS + AI + integrations  | PH-2.1, PH-5.2 |
| AI Context field with auto-generate       | PH-4.3         |
| Dark/light theme                          | PH-1.1, PH-1.2 |
| Futurator.ai visual alignment             | PH-1.1, PH-1.3 |
| User dropdown (compact)                   | PH-1.4         |
| Create project button (informational)     | PH-3.3         |
| Static JSON export to S3                  | PH-6.1         |
| CloudFront invalidation                   | PH-6.2         |
| futurator.ai dynamic project loading      | PH-6.3         |
| Data migration (brief → descriptions)     | PH-2.2         |

### No Forward Dependencies

Every story depends only on previously completed stories within the same or earlier epics. No story references work that hasn't been completed yet.

---

_For implementation: Use the `create-story` workflow to generate individual story implementation plans from this epic breakdown._
