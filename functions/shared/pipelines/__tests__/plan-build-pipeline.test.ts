import { describe, it, expect } from 'vitest';
import { generatePlanBuildPipeline } from '../plan-build-pipeline';

describe('generatePlanBuildPipeline — pacman4 seam-mount gate', () => {
  it('omits the seam steps when no seamHook (non-seam boilerplate, back-compat)', () => {
    const p = generatePlanBuildPipeline('/wd', 'demo');
    const ids = p.steps.map((s) => s.id);
    expect(ids).not.toContain('plan-seam-check');
    expect(ids).toContain('plan-build-check');
    expect(ids).toContain('plan-server-check');
  });

  it('adds a seam-check + seam-fix step (between build and server) when seamHook is present', () => {
    const p = generatePlanBuildPipeline('/wd', 'demo', 'useGameStateMachine');
    const ids = p.steps.map((s) => s.id);
    expect(ids).toContain('plan-seam-check');
    expect(ids).toContain('plan-seam-fix');
    // ordering: build → seam → server
    expect(ids.indexOf('plan-build-check')).toBeLessThan(ids.indexOf('plan-seam-check'));
    expect(ids.indexOf('plan-seam-check')).toBeLessThan(ids.indexOf('plan-server-check'));
    const seam = p.steps.find((s) => s.id === 'plan-seam-check')!;
    // uses the canonical tested checker via the daemon import pattern, with the hook
    expect(String((seam as { command: string }).command)).toContain('seam-mount-check.mjs');
    expect(String((seam as { command: string }).command)).toContain('useGameStateMachine');
    expect(String((seam as { command: string }).command)).toContain('SEAM_NEVER_PUBLISHED');
  });
});
