import { existsSync, readFileSync } from 'node:fs';

const RULE_ID_PATTERN = /^##\s+(R-[A-Z]+-\d{3,})\b/gm;
const LEADING_H1_PATTERN = /^#\s+[^\n]*\n+/;
const NO_OVERLAY_NOTE = '// no project overlay';

export function parseRuleIds(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const ids = [];
  RULE_ID_PATTERN.lastIndex = 0;
  let match;
  while ((match = RULE_ID_PATTERN.exec(markdown)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

export function mergeRubric(opts = {}, { logger = console } = {}) {
  const { defaultPath, overlayPath } = opts;

  if (!defaultPath || typeof defaultPath !== 'string') {
    throw new Error('mergeRubric: defaultPath is required');
  }
  if (!existsSync(defaultPath)) {
    throw new Error(`mergeRubric: default rubric not found at ${defaultPath}`);
  }

  const defaultBody = stripLeadingH1(readFileSync(defaultPath, 'utf8'));

  if (!overlayPath || !existsSync(overlayPath)) {
    return `${NO_OVERLAY_NOTE}\n\n${readFileSync(defaultPath, 'utf8')}`;
  }

  const overlayBody = stripLeadingH1(readFileSync(overlayPath, 'utf8'));

  const defaultIds = parseRuleIds(defaultBody);
  const overlayIds = parseRuleIds(overlayBody);
  const collisions = overlayIds.filter((id) => defaultIds.includes(id));

  for (const id of collisions) {
    logger.warn(
      `[rubric-merge] overlay rule ${id} collides with default; overlay wins`
    );
  }

  return (
    `## Global Defaults\n\n${defaultBody.trim()}\n\n` +
    `## Project Overlay\n\n${overlayBody.trim()}\n`
  );
}

function stripLeadingH1(markdown) {
  return markdown.replace(LEADING_H1_PATTERN, '');
}
