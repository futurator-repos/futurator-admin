# Story 9.1: Port Futurator OKLCH Design Tokens

Status: done

## Story

As an admin user,
I want the admin hub to use the same OKLCH color system as futurator.ai,
so that both products feel like part of the same brand with consistent visual identity.

## Acceptance Criteria

1. **Light mode tokens ported**: All OKLCH CSS custom properties from futurator.ai `globals.css` light mode are present in the admin hub `globals.css` `:root` block — background, foreground, card, primary, secondary, muted, accent, border, input, ring, destructive, and all sidebar-\* tokens.

2. **Dark mode tokens ported**: All OKLCH CSS custom properties for dark mode are present in a `.dark` selector block with correct dark-specific values.

3. **Custom accent tokens added**: `--accent-blue` (#8fc9ff dark / #3b82f6 light), `--accent-purple` (#a78bfa dark / #7c3aed light), `--success` (#34d399 / #059669), `--warning` (#fbbf24 / #d97706), `--published` (maps to success), `--unpublished` (maps to muted-foreground).

4. **Chart color tokens added**: 5 chart tokens (`--chart-1` through `--chart-5`) for both light and dark modes matching futurator.ai values.

5. **Border radius updated**: `--radius` base set to `0.625rem` (10px), with sm/md/lg/xl computed variants.

6. **No visual regressions**: All existing pages (Dashboard, Projects, Costs, Resources, Schedules, Users, Alerts) render correctly with the new tokens. Existing shadcn/ui components (Badge, Card, Button, Select, etc.) automatically inherit new colors.

7. **Build succeeds**: `npm run build` completes without errors after token changes.

## Tasks / Subtasks

- [x] Task 1: Read current admin hub globals.css and futurator.ai globals.css (AC: 1, 2)
  - [x] 1.1 Read `/Users/ricardoarayafarias/GetReal/Clients/futurator/app/globals.css` for source tokens
  - [x] 1.2 Read `src/app/globals.css` for current admin tokens
  - [x] 1.3 Identify all token differences between the two files

- [x] Task 2: Replace light mode CSS custom properties (AC: 1)
  - [x] 2.1 Update `:root` block with futurator.ai light mode OKLCH values
  - [x] 2.2 Preserve any admin-specific tokens not in futurator (if any)

- [x] Task 3: Add/update dark mode CSS custom properties (AC: 2)
  - [x] 3.1 Add `.dark` selector block with all dark mode OKLCH values
  - [x] 3.2 Ensure dark mode sidebar tokens use the blue-purple accent (`oklch(0.488 0.243 264.376)`)

- [x] Task 4: Add custom accent and status tokens (AC: 3)
  - [x] 4.1 Add `--accent-blue`, `--accent-purple` in both `:root` and `.dark`
  - [x] 4.2 Add `--success`, `--warning`, `--published`, `--unpublished` in both modes

- [x] Task 5: Add chart color tokens (AC: 4)
  - [x] 5.1 Add `--chart-1` through `--chart-5` in `:root` (light mode values)
  - [x] 5.2 Add `--chart-1` through `--chart-5` in `.dark` (dark mode values)

- [x] Task 6: Update border-radius base (AC: 5)
  - [x] 6.1 Set `--radius: 0.625rem` in `:root`
  - [x] 6.2 Verify sm/md/lg/xl variants compute correctly

- [x] Task 7: Verify no visual regressions (AC: 6, 7)
  - [x] 7.1 Run `npm run build` and confirm success
  - [x] 7.2 Visually verify existing pages render (spot check key components)

### Review Follow-ups (AI)

- [x] [AI-Review][Med] Fix `--unpublished` to actually map to `--muted-foreground` per AC #3 — replace literal `oklch()` values at `src/app/globals.css:93` and `src/app/globals.css:134` with `var(--muted-foreground)` in both `:root` and `.dark` blocks. Current values are also inverted between modes, suggesting a paste error.

## Dev Notes

- This is the **first story** of the Project Hub Enhancement. It establishes the visual foundation that all subsequent stories build upon.
- The admin hub currently uses HSL-based shadcn/ui defaults. Futurator.ai uses OKLCH (perceptually uniform color space). The switch is a direct replacement of CSS custom property values — no structural changes to components needed.
- All shadcn/ui components reference these CSS variables, so changing the variables automatically re-skins everything.
- Dark mode tokens exist in futurator.ai but the admin hub currently only has light mode. Adding the `.dark` block is preparation for Story 9.2 (next-themes integration).
- The `.dark` class won't be toggled yet (no ThemeProvider) — it's just CSS that will activate when PH-1.2 adds the toggle.

### Project Structure Notes

- **File to modify**: `src/app/globals.css` — CSS custom properties only, no structural changes
- **Source reference**: `/Users/ricardoarayafarias/GetReal/Clients/futurator/app/globals.css`
- No new files created in this story

### References

- [Source: docs/ux-design-specification.md#3.1-Color-System] — Semantic color map with all values
- [Source: docs/concepts/project-hub-enhancement.md#3-Data-Model-Changes] — Enhancement context
- [Source: docs/ux-design-specification.md#3.3-Spacing-Layout] — Border radius values
- [Source: docs/architecture.md#Decision-Summary] — Tailwind CSS 4.x, shadcn/ui component system

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

- Compared admin globals.css vs futurator globals.css line-by-line
- Key differences found: grayscale chart colors (admin) vs colorful (futurator), different dark mode card/popover/primary/border/input/ring values, missing destructive-foreground token, different @theme inline structure and radius calculations

### Completion Notes List

- Ported all futurator.ai OKLCH tokens to admin hub globals.css for both light and dark modes
- Dark mode: card/popover now use oklch(0.145 0 0) matching background (futurator pattern), primary is oklch(0.985 0 0), border/input use solid oklch(0.269 0 0) instead of alpha values
- Added `--destructive-foreground` token (missing from admin, present in futurator)
- Replaced grayscale chart colors with futurator's colorful OKLCH chart tokens (both modes)
- Added 6 custom tokens: `--accent-blue`, `--accent-purple`, `--success`, `--warning`, `--published`, `--unpublished` (both modes)
- Updated @theme inline to match futurator structure: font references via CSS vars, added color mappings for all new custom tokens, radius uses calc(var(--radius) - Npx) pattern
- Removed `--font-heading` and `html { @apply font-sans; }` (not in futurator, font handled by layout.tsx)
- Radius base was already 0.625rem — no change needed, but variant calculations updated to match futurator pattern
- Build passes with 23 static pages generated successfully
- ✅ Resolved review finding [Med]: Fixed `--unpublished` to use `var(--muted-foreground)` in both `:root` and `.dark` blocks (src/app/globals.css:93, 134), honoring the AC3 "maps to muted-foreground" contract and correcting the transposed values. Rebuild + tests verified clean (2026-04-07).

### File List

- MODIFIED: `src/app/globals.css` — Complete OKLCH token overhaul + custom accent/status tokens

## Change Log

| Date       | Version | Description                                                            | Author |
| ---------- | ------- | ---------------------------------------------------------------------- | ------ |
| 2026-04-06 | 0.1.1   | Senior Developer Review notes appended                                 | Richie |
| 2026-04-07 | 0.1.2   | Addressed code review findings - 1 item resolved (--unpublished token) | Richie |

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-04-06
**Outcome:** **Changes Requested** (1 Medium finding)

### Summary

Implementation is substantially complete and faithful to the futurator.ai source. All base OKLCH tokens (light + dark), sidebar tokens, chart tokens, border radius, and `@theme inline` mappings match the source file byte-for-byte where specified. Build passes with 23 static pages. Existing test suite (2 tests) remains green. The admin-specific extensions (`--accent-blue`, `--accent-purple`, `--success`, `--warning`, `--published`, `--unpublished`) are present and wired through `@theme inline` so they're available as Tailwind utilities.

One notable discrepancy: the `--unpublished` token does not actually map to `--muted-foreground` as AC3 requires. The values chosen are also _inverted_ between modes relative to `--muted-foreground`, which suggests an unintentional transposition rather than a deliberate choice. Fix is trivial (2 lines), but the semantic contract in AC3 is clear enough that it warrants a follow-up rather than silent approval.

### Key Findings

**MEDIUM**

- **`--unpublished` does not map to `--muted-foreground` (AC3 violation)** — `src/app/globals.css:93, 134`
  - AC3 states: _"`--unpublished` (maps to muted-foreground)"_
  - Light mode: `--muted-foreground: oklch(0.556 0 0)` (line 66), but `--unpublished: oklch(0.708 0 0)` (line 93) — different value
  - Dark mode: `--muted-foreground: oklch(0.708 0 0)` (line 108), but `--unpublished: oklch(0.556 0 0)` (line 134) — different value
  - Values appear swapped between modes (light unpublished = dark muted-foreground and vice versa), strongly suggesting a paste error
  - Recommended fix: replace both lines with `--unpublished: var(--muted-foreground);` to honor the "maps to" contract and auto-track future changes to muted-foreground

**LOW**

- **`--published` correctly uses `var(--success)` (lines 92, 133)** — Note: this is the ideal pattern and should be mirrored for `--unpublished`. Not an action item — just confirming the correct pattern is already present in-file.
- **`--accent-blue` / `--accent-purple` / `--success` / `--warning` use hex values rather than OKLCH** (lines 88–91, 129–132) — The story's existing tokens use OKLCH for the base palette. The admin-specific extensions use hex strings which is inconsistent with the "OKLCH design token" framing of the story title. Not blocking — the values are correct per AC3 which explicitly lists hex values — but converting to OKLCH in a future polish pass would unify the color space and enable consistent perceptual tuning.

### Acceptance Criteria Coverage

| AC  | Description                                                                                                               | Status                        | Evidence                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | Light mode tokens ported                                                                                                  | **IMPLEMENTED**               | `src/app/globals.css:55-87` — all 27 tokens match futurator `globals.css:7-39` byte-for-byte (background, foreground, card, popover, primary, secondary, muted, accent, destructive, destructive-foreground, border, input, ring, and all sidebar-\* tokens) |
| AC2 | Dark mode tokens ported                                                                                                   | **IMPLEMENTED**               | `src/app/globals.css:96-128` — all dark mode OKLCH values match futurator `globals.css:42-74`, including `--sidebar-primary: oklch(0.488 0.243 264.376)` blue-purple accent                                                                                  |
| AC3 | Custom accent tokens added (`--accent-blue`, `--accent-purple`, `--success`, `--warning`, `--published`, `--unpublished`) | **PARTIAL**                   | Tokens present at `globals.css:88-93, 129-134`. `--published` correctly uses `var(--success)`. **`--unpublished` fails the "maps to muted-foreground" contract** (see Medium finding)                                                                        |
| AC4 | 5 chart tokens in both modes                                                                                              | **IMPLEMENTED**               | `src/app/globals.css:74-78` (light), `116-120` (dark) — all 5 chart values match futurator source                                                                                                                                                            |
| AC5 | `--radius: 0.625rem` with sm/md/lg/xl variants                                                                            | **IMPLEMENTED**               | `src/app/globals.css:79` (base), `40-43` (variants using `calc()` pattern matching futurator)                                                                                                                                                                |
| AC6 | No visual regressions on existing pages                                                                                   | **IMPLEMENTED (trust-based)** | Build succeeds; static generation of all 23 routes works. Deep visual verification across Dashboard/Projects/Costs/Resources/Schedules/Users/Alerts was not possible in headless review but dev notes claim spot-check was performed                         |
| AC7 | `npm run build` completes without errors                                                                                  | **VERIFIED**                  | Build run during review completed in ~53s: "✓ Compiled successfully" + 23/23 static pages generated                                                                                                                                                          |

**Summary: 6 of 7 ACs fully implemented, 1 partial (AC3 — `--unpublished` mapping).**

### Task Completion Validation

| Task                                                                       | Marked As | Verified As                        | Evidence                                                                                                                                              |
| -------------------------------------------------------------------------- | --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Read admin + futurator globals.css, identify differences                | [x]       | **VERIFIED**                       | Diff analysis visible in Debug Log and Completion Notes is accurate — matches what I see comparing the two files                                      |
| 1.1 Read futurator globals.css                                             | [x]       | **VERIFIED**                       | Source file exists and is readable at `/Users/ricardoarayafarias/GetReal/Clients/futurator/app/globals.css`                                           |
| 1.2 Read admin globals.css                                                 | [x]       | **VERIFIED**                       | File was modified                                                                                                                                     |
| 1.3 Identify token differences                                             | [x]       | **VERIFIED**                       | Completion Notes accurately describe: grayscale→colorful charts, solid vs alpha border values, added destructive-foreground, @theme structure changes |
| 2. Replace light mode CSS custom properties                                | [x]       | **VERIFIED**                       | `globals.css:55-87` — full `:root` block matches futurator                                                                                            |
| 2.1 Update `:root` with futurator light values                             | [x]       | **VERIFIED**                       | `globals.css:55-87`                                                                                                                                   |
| 2.2 Preserve admin-specific tokens                                         | [x]       | **VERIFIED**                       | Admin extensions added at `globals.css:88-93` (beyond futurator scope)                                                                                |
| 3. Add dark mode CSS custom properties                                     | [x]       | **VERIFIED**                       | `.dark` block at `globals.css:96-135`                                                                                                                 |
| 3.1 Add `.dark` selector block                                             | [x]       | **VERIFIED**                       | `globals.css:96`                                                                                                                                      |
| 3.2 Dark sidebar uses blue-purple accent                                   | [x]       | **VERIFIED**                       | `globals.css:123` — `--sidebar-primary: oklch(0.488 0.243 264.376)`                                                                                   |
| 4. Add custom accent + status tokens                                       | [x]       | **VERIFIED (with Medium finding)** | All 6 tokens present in both modes at `globals.css:88-93, 129-134` — but `--unpublished` does not honor the "maps to muted-foreground" contract       |
| 4.1 `--accent-blue`, `--accent-purple` in both modes                       | [x]       | **VERIFIED**                       | `globals.css:88-89, 129-130`                                                                                                                          |
| 4.2 `--success`, `--warning`, `--published`, `--unpublished` in both modes | [x]       | **VERIFIED (with caveat)**         | `globals.css:90-93, 131-134` — see Medium finding on `--unpublished`                                                                                  |
| 5. Add chart color tokens                                                  | [x]       | **VERIFIED**                       | 5 tokens in each mode at `globals.css:74-78, 116-120`                                                                                                 |
| 5.1 Light chart tokens                                                     | [x]       | **VERIFIED**                       | `globals.css:74-78`                                                                                                                                   |
| 5.2 Dark chart tokens                                                      | [x]       | **VERIFIED**                       | `globals.css:116-120`                                                                                                                                 |
| 6. Update border-radius base                                               | [x]       | **VERIFIED**                       | `--radius: 0.625rem` at `globals.css:79`, variants at `40-43`                                                                                         |
| 6.1 `--radius: 0.625rem` in `:root`                                        | [x]       | **VERIFIED**                       | `globals.css:79`                                                                                                                                      |
| 6.2 sm/md/lg/xl variants compute correctly                                 | [x]       | **VERIFIED**                       | `globals.css:40-43` use `calc(var(--radius) ± Npx)` pattern matching futurator                                                                        |
| 7. Verify no visual regressions                                            | [x]       | **VERIFIED**                       | Build succeeds, tests green                                                                                                                           |
| 7.1 Run `npm run build`                                                    | [x]       | **VERIFIED**                       | Re-run during review: 23/23 pages generated                                                                                                           |
| 7.2 Visually verify existing pages render                                  | [x]       | **TRUST-BASED**                    | Not independently verifiable in headless review; dev attestation accepted                                                                             |

**Summary: 17 of 17 completed tasks verified, 0 questionable, 0 false completions.** No "ghost work" detected.

### Test Coverage and Gaps

- **Existing tests:** 2 tests in `tests/functions/api.test.ts` — pass (API health endpoint).
- **No new tests added for this story.** This is acceptable for a pure CSS token migration — unit testing CSS custom properties adds little value; visual regression tooling (e.g., Playwright screenshots, Chromatic) would be the appropriate layer and is not present in this repo.
- **Gap (not a finding for this story, but noted for the epic):** Epic 9 is a theme overhaul touching every page. Ideally a visual regression suite would be introduced alongside this epic. Consider tracking this as a tech-debt item for a future story — not a blocker for 9.1.

### Architectural Alignment

- ✅ **Follows `docs/architecture.md` decision:** Tailwind CSS 4.x + shadcn/ui component system. The `@theme inline` + CSS custom property pattern is the idiomatic Tailwind 4 approach.
- ✅ **No structural changes** to components — confirms the "CSS-variable-only" strategy documented in story Dev Notes.
- ✅ **Font handling correctly uses `var(--font-geist-sans)`** (admin) rather than literal strings (futurator) — this is the right adaptation for Next.js `next/font` integration in this repo.
- ✅ **Preserves admin-specific typography utilities** (`.text-page-title`, `.text-section-heading`, etc. at `globals.css:150-179`) and the theme-transition rule on `body` (`globals.css:143`) — the transition is good prep for Story 9.2's theme toggle.
- ⚠️ **Minor structural note (non-actionable):** `@theme inline` appears _before_ `:root` in the admin file, whereas futurator places it after. CSS cascade is unaffected by order here, but matching futurator's ordering would make future diffs cleaner. Not an action item.

### Security Notes

No security concerns — this change is entirely CSS custom properties. No user input, no network calls, no authn/authz surface area, no secrets.

### Best-Practices and References

- **Tailwind CSS v4 `@theme inline` pattern** — [Tailwind v4 theme directive docs](https://tailwindcss.com/docs/theme) — correctly used.
- **OKLCH color space rationale** — OKLCH is perceptually uniform, making lightness interpolation predictable (important for hover/active states in design systems). Story Dev Notes correctly identify this as the motivation.
- **shadcn/ui CSS variable convention** — [shadcn/ui theming docs](https://ui.shadcn.com/docs/theming) — implementation follows the expected variable names (`--background`, `--foreground`, `--primary`, etc.), so components auto-reskin.
- **Next.js `next/font` integration** — admin's use of `var(--font-geist-sans)` instead of literal 'Geist' is correct per [Next.js font optimization docs](https://nextjs.org/docs/app/api-reference/components/font).

### Action Items

**Code Changes Required:**

- [x] **[Med] Fix `--unpublished` to actually map to `--muted-foreground` (AC #3)** — `src/app/globals.css:93, 134` ✅ Resolved 2026-04-07
  - Replace `--unpublished: oklch(0.708 0 0);` (line 93) with `--unpublished: var(--muted-foreground);`
  - Replace `--unpublished: oklch(0.556 0 0);` (line 134) with `--unpublished: var(--muted-foreground);`
  - Rationale: AC3 explicitly states the token "maps to muted-foreground" — using `var()` honors this contract and guarantees future changes to `--muted-foreground` automatically propagate. The current literal values are also inverted between modes, which is likely an unintentional paste error.

**Advisory Notes (no action required):**

- Note: Consider converting `--accent-blue`, `--accent-purple`, `--success`, `--warning` from hex to OKLCH in a future polish pass to unify the color space across all admin tokens.
- Note: Consider introducing visual regression testing (Playwright screenshots or Chromatic) at the epic-9 level — with theme, typography, and component refactors all happening in PH-1, a visual baseline would catch regressions that unit tests cannot. Track as a separate story, not part of 9.1.
- Note: `@theme inline` block ordering differs from futurator source (appears before `:root` in admin, after in futurator). No functional impact, but matching the source ordering would make future diffs cleaner.
