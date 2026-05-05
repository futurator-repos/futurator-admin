/**
 * App/Plan v1 — PM-augmentation prompt renderer (Story 4.3).
 *
 * Loads the prompt template from disk and substitutes placeholders with
 * App + Plan + prior-Plans context. Pure templating — no I/O of its own
 * beyond reading the template once at startup (cached).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'pm-augmentation-prompt.md.tpl');

let cachedTemplate = null;
function loadTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return cachedTemplate;
}

/** Reset the template cache — used by tests. */
export function _resetTemplateCache() {
  cachedTemplate = null;
}

/**
 * Render the prompt for a non-initial Plan with full prior-Plan context.
 *
 * @param {object} args
 * @param {{ appId: string, displayName: string, workingDir: string }} args.app
 * @param {{ intent: string }} args.plan
 * @param {Array<{
 *   planId: string,
 *   kind?: string,
 *   iterationLabel?: string,
 *   status: string,
 *   intent: string,
 *   epicIds?: string[],
 * }>} args.priorPlans
 *   Sorted ascending by createdAt (oldest first).
 * @param {Array<{
 *   epicId: string,
 *   planId: string,
 *   title?: string,
 *   description?: string,
 *   stories?: Array<{ storyId: string, title?: string, description?: string,
 *     acceptanceCriteria?: string[] }>,
 * }>} [args.epicsByPlanId]
 *   Optional — when provided, prior Plans render their full epic/story
 *   breakdown including AC. When absent, only Plan-level metadata renders.
 * @returns {string}
 */
export function renderPmAugmentationPrompt({ app, plan, priorPlans, epicsByPlanId = {} }) {
  if (!app || !app.appId || !app.workingDir) {
    throw new Error('renderPmAugmentationPrompt: app.appId + app.workingDir required');
  }
  if (!plan || !plan.intent) {
    throw new Error('renderPmAugmentationPrompt: plan.intent required');
  }
  if (!Array.isArray(priorPlans) || priorPlans.length === 0) {
    throw new Error('renderPmAugmentationPrompt: priorPlans must be a non-empty array (a non-initial Plan must follow at least one prior Plan)');
  }

  const template = loadTemplate();
  const priorPlansSection = renderPriorPlansSection(priorPlans, epicsByPlanId);

  const filled = template
    .replace(/\{\{appId\}\}/g, app.appId)
    .replace(/\{\{appDisplayName\}\}/g, app.displayName ?? app.appId)
    .replace(/\{\{workingDir\}\}/g, app.workingDir)
    .replace(/\{\{intent\}\}/g, plan.intent)
    .replace(/\{\{priorPlanCount\}\}/g, String(priorPlans.length))
    .replace(/\{\{priorPlansSection\}\}/g, priorPlansSection);

  if (filled.length > 50_000) {
    console.warn(
      `[renderPmAugmentationPrompt] rendered prompt is large: ${filled.length} bytes. Long prior-Plan histories may overflow the model context. Consider summarization in v1.x.`,
    );
  }

  return filled;
}

function renderPriorPlansSection(priorPlans, epicsByPlanId) {
  return priorPlans
    .map((p, idx) => {
      const num = idx + 1;
      const lines = [
        `Plan #${num} — ${p.kind ?? 'change'} — ${p.iterationLabel ?? '(no label)'} — ${p.status}`,
        `  Intent: ${oneLine(p.intent)}`,
      ];
      const epics = (p.epicIds ?? [])
        .map((id) => epicsByPlanId[id])
        .filter(Boolean);
      if (epics.length > 0) {
        lines.push('  Epics:');
        for (const epic of epics) {
          lines.push(`    - ${epic.title ?? epic.epicId}`);
          for (const story of epic.stories ?? []) {
            lines.push(`        • ${story.title ?? story.storyId}`);
            for (const ac of story.acceptanceCriteria ?? []) {
              lines.push(`            AC: ${oneLine(ac)}`);
            }
          }
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function oneLine(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}
