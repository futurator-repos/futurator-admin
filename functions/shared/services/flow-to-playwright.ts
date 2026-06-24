/**
 * flow-to-playwright.ts — Stage A (qa-review-delivery-rethink §3.3).
 *
 * Translate a visual test `flow` (the probe-step list QA actually executes) into
 * the equivalent, human-readable Playwright script. This is the SAME mapping the
 * runtime interpreter (`visual-qa-pipeline.ts` `runFlow`) applies — kept in sync
 * by mirroring its dispatch — but emitted as inspectable text so the operator can
 * SEE and review the script before approving a test. Pure, no I/O.
 *
 * It is ADVISORY: the runtime still executes `flow`, not this string. Its job is
 * transparency — "the quality of the tests depends on the scripts, which I can't
 * see" (operator, pacman3).
 */

import type { VisualTestFlowStep, AssertOp } from '../types/epic-workflow';

function opComment(op: AssertOp | undefined): string {
  switch (op || 'eq') {
    case 'eq':
      return '===';
    case 'neq':
      return '!==';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    case 'contains':
      return 'contains';
    case 'truthy':
      return 'is truthy';
    case 'falsy':
      return 'is falsy';
    default:
      return String(op);
  }
}

const jsonish = (v: unknown): string => JSON.stringify(v ?? null);

/** Translate ONE flow step into one (or a few) Playwright line(s). */
function stepToPlaywright(step: VisualTestFlowStep): string[] {
  const s = step;
  switch (s.action) {
    case 'navigate':
      return [`await page.goto(BASE + ${jsonish(s.url || '/')}, { waitUntil: 'load' });`];
    case 'click':
      return [`await page.click(${jsonish(s.selector || '')});`];
    case 'fill':
      return [`await page.fill(${jsonish(s.selector || '')}, ${jsonish(s.value || '')});`];
    case 'wait':
      return [`await page.waitForTimeout(${Math.min(s.ms || 500, 15000)});`];
    case 'screenshot':
      return [`await page.screenshot({ path: '${s.label || 'shot'}.png' });`];
    case 'press':
      return [`await page.keyboard.press(${jsonish(s.key || 'Space')});`];
    case 'hold':
      return [
        `await page.keyboard.down(${jsonish(s.key || 'Space')});`,
        `await page.waitForTimeout(${Math.min(s.ms || 200, 5000)});`,
        `await page.keyboard.up(${jsonish(s.key || 'Space')});`,
      ];
    case 'tap':
    case 'pointer':
      return s.selector
        ? [`await page.click(${jsonish(s.selector)});`]
        : [`await page.mouse.click(${s.x || 0}, ${s.y || 0});`];
    case 'select':
      return [`await page.selectOption(${jsonish(s.selector || '')}, ${jsonish(s.value || '')});`];
    case 'drag':
      return [
        `await page.dragAndDrop(${jsonish(s.selector || '')}, ${jsonish(s.value || s.selector || '')});`,
      ];
    case 'clock':
      return [
        `await page.clock.${s.clockMode || 'runFor'}(${s.ms || 1000}); // deterministic time`,
      ];
    case 'viewport':
      return [`await page.setViewportSize({ width: ${s.w || 1280}, height: ${s.h || 720} });`];
    case 'network':
      return [`await page.context().setOffline(${s.network === 'offline'});`];
    case 'force':
      return [
        `await page.evaluate((st) => window.__harness?.forceStatus?.(st), ${jsonish(s.status || 'over')}); // seam: jump to state`,
      ];
    case 'seed':
      return [
        `await page.evaluate((v) => window.__harness?.dispatch?.(v), ${jsonish(s.value || '')}); // seam: seed state`,
      ];
    case 'assert':
      return [
        `// ASSERT (poll up to ${Math.min(s.timeoutMs || 3000, 15000)}ms): ${s.expr || ''} ${opComment(s.op)} ${jsonish(s.expected)}`,
        `await expect.poll(() => page.evaluate(() => `,
        `  String(${(s.expr || 'snapshot').replace(/^snapshot/, 'window.__harness.snapshot()').replace(/^events/, 'window.__harness.events')})`,
        `)).${assertMatcher(s.op)}(${jsonish(s.expected)});`,
      ];
    case 'waitForEvent':
      return [
        `await page.waitForFunction(() => {`,
        `  const v = ${(s.expr || 'snapshot').replace(/^snapshot/, 'window.__harness.snapshot()').replace(/^events/, 'window.__harness.events')};`,
        `  return ${waitForExpr(s.op, s.expected)};`,
        `}, { timeout: ${Math.min(s.timeoutMs || 5000, 15000)}, polling: 100 }); // wait until ${s.expr} ${opComment(s.op)} ${jsonish(s.expected)}`,
      ];
    case 'repeat':
      return [
        `// REPEAT ${s.step?.action || 'press'}(${jsonish(s.step?.key || s.step?.selector || '')}) until ${s.untilExpr} ${opComment(s.untilOp)} ${jsonish(s.untilExpected)}`,
        `for (let i = 0; i < ${Math.min(s.maxIterations || 50, 500)} && (Date.now() - t0) < ${Math.min(s.budgetMs || 15000, 60000)}; i++) {`,
        ...stepToPlaywright(
          (s.step as VisualTestFlowStep) || { action: 'press', key: 'Space' },
        ).map((l) => '  ' + l),
        `  if (await reached(${jsonish(s.untilExpr)}, ${jsonish(s.untilExpected)})) break;`,
        `}`,
      ];
    default:
      return [`// (unmapped step: ${s.action})`];
  }
}

function assertMatcher(op: AssertOp | undefined): string {
  switch (op || 'eq') {
    case 'eq':
      return 'toBe';
    case 'neq':
      return 'not.toBe';
    case 'contains':
      return 'toContain';
    default:
      return 'toBe'; // numeric comparators rendered as a comment above
  }
}

function waitForExpr(op: AssertOp | undefined, expected: unknown): string {
  const e = jsonish(expected);
  switch (op || 'eq') {
    case 'eq':
      return `String(v) === String(${e})`;
    case 'neq':
      return `String(v) !== String(${e})`;
    case 'gt':
      return `Number(v) > Number(${e})`;
    case 'gte':
      return `Number(v) >= Number(${e})`;
    case 'lt':
      return `Number(v) < Number(${e})`;
    case 'lte':
      return `Number(v) <= Number(${e})`;
    case 'contains':
      return `Array.isArray(v) ? v.includes(${e}) : String(v).includes(String(${e}))`;
    case 'truthy':
      return `!!v`;
    case 'falsy':
      return `!v`;
    default:
      return `String(v) === String(${e})`;
  }
}

/**
 * Render a complete, readable Playwright script for a test's flow. `BASE` is the
 * dev server origin (left as a symbol so the script reads cleanly). Returns '' for
 * a flow-less test (nothing to script — it's an idle-frame capture).
 */
export function flowToPlaywright(flow: VisualTestFlowStep[] | undefined): string {
  if (!Array.isArray(flow) || flow.length === 0) return '';
  const needsSeam = flow.some(
    (s) =>
      s.action === 'assert' ||
      s.action === 'waitForEvent' ||
      s.action === 'repeat' ||
      s.action === 'force',
  );
  const lines: string[] = [
    `const page = await browser.newPage();`,
    `await page.goto(BASE + '/', { waitUntil: 'load' });`,
  ];
  if (needsSeam) {
    lines.push(
      `await page.waitForFunction(() => window.__harness?.ready === true, { timeout: 5000 }); // seam ready`,
    );
  }
  for (const step of flow) lines.push(...stepToPlaywright(step));
  return lines.join('\n');
}
