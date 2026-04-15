import { test, expect } from './fixtures';

/**
 * Smoke test: open the project edit modal and verify every section renders
 * its real component (not a "coming soon" placeholder).
 *
 * This is the canonical regression-prevention test for Stories 12-1, 13-2,
 * and 13-3, all of which originally shipped with orphaned components: the
 * component file existed but was never imported into the modal, leaving the
 * UI showing placeholder text. A single click-pencil-and-look smoke test
 * would have caught all three.
 */

test('project edit modal renders every section without placeholders', async ({ authedPage }) => {
  await authedPage.goto('/projects');

  // 1. List renders both seeded projects
  await expect(authedPage.getByText('Test Project Alpha')).toBeVisible();
  await expect(authedPage.getByText('Test Project Beta')).toBeVisible();

  // 2. Click the pencil edit button for Alpha (aria-label="Edit Test Project Alpha")
  await authedPage.getByRole('button', { name: 'Edit Test Project Alpha' }).click();

  // 3. Modal title visible
  await expect(authedPage.getByText('Edit Project: Test Project Alpha')).toBeVisible();

  // 4. Identity section content (open by default) — Name input present
  await expect(authedPage.getByPlaceholder('Project name')).toBeVisible();

  // 5. Descriptions section content (open by default) — seeded headline visible.
  // The DescriptionField wraps an Input whose value attribute carries the seeded text.
  await expect(authedPage.locator('input[value="Alpha headline"]')).toBeVisible();

  // 6. Features section: expand by clicking header, verify FeatureEditor (NOT placeholder)
  await authedPage.getByRole('button', { name: /Features & Services \(\d+\)/ }).click();
  await expect(authedPage.getByText('Feature editor coming soon.')).toHaveCount(0);
  // The seeded feature's name input should appear
  await expect(authedPage.locator('input[value="Existing feature"]')).toBeVisible();
  // The "+ Add Feature" button proves the editor (not the placeholder) is rendered
  await expect(authedPage.getByRole('button', { name: /Add Feature/ })).toBeVisible();

  // 7. Media section: expand and verify MediaManager (NOT placeholder)
  await authedPage.getByRole('button', { name: /^Media \(\d+ of 6\)/ }).click();
  await expect(authedPage.getByText('Media management coming soon.')).toHaveCount(0);
  // The "Add media" placeholder card from MediaManager should be visible
  await expect(authedPage.getByText('Add media')).toBeVisible();

  // 8. Team section: expand and verify ChipInput renders
  await authedPage.getByRole('button', { name: /^Team \(\d+\)/ }).click();
  // The seeded team member should be visible as a chip
  await expect(authedPage.getByText('alice@test')).toBeVisible();
});

test('all 6 sort options are present (regression for 11-2 AC2)', async ({ authedPage }) => {
  await authedPage.goto('/projects');
  await expect(authedPage.getByText('Test Project Alpha')).toBeVisible();

  // The filter-bar has 2 base-ui Select triggers: Published (1st) and Sort (2nd)
  // Click the Sort trigger to open its dropdown.
  await authedPage.locator('[data-slot="select-trigger"]').nth(1).click();

  // All 6 options must be present (Story 11-2 AC2)
  await expect(authedPage.getByRole('option', { name: 'Sort: Name A-Z' })).toBeVisible();
  await expect(authedPage.getByRole('option', { name: 'Sort: Name Z-A' })).toBeVisible();
  await expect(authedPage.getByRole('option', { name: 'Sort: Status' })).toBeVisible();
  await expect(authedPage.getByRole('option', { name: 'Sort: Category' })).toBeVisible();
  await expect(authedPage.getByRole('option', { name: 'Sort: Last Updated' })).toBeVisible();
  await expect(authedPage.getByRole('option', { name: 'Sort: Homepage Order' })).toBeVisible();
});

test('status filter is multi-select (regression for 11-2 AC1)', async ({ authedPage }) => {
  await authedPage.goto('/projects');
  await expect(authedPage.getByText('Test Project Alpha')).toBeVisible();

  // The Status trigger button starts with "Status: All" text
  await authedPage.getByText('Status: All').click();

  // The dropdown opens with all 4 status options as checkbox menu items.
  // base-ui Menu renders these with role="menuitemcheckbox"
  await expect(authedPage.getByRole('menuitemcheckbox', { name: 'Planning' })).toBeVisible();
  await expect(authedPage.getByRole('menuitemcheckbox', { name: 'In Progress' })).toBeVisible();
  await expect(authedPage.getByRole('menuitemcheckbox', { name: 'Beta' })).toBeVisible();
  await expect(authedPage.getByRole('menuitemcheckbox', { name: 'Active' })).toBeVisible();

  // Toggle two of them — menu should stay open (multi-select via closeOnClick=false)
  await authedPage.getByRole('menuitemcheckbox', { name: 'Active' }).click();
  await authedPage.getByRole('menuitemcheckbox', { name: 'Planning' }).click();

  // Trigger label should now show "Status: 2 selected"
  await expect(authedPage.getByText('Status: 2 selected')).toBeVisible();
});
