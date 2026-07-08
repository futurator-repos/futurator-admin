/**
 * wiring-orphan-banner.test.tsx — QA-Review W2 wiring/orphan check.
 *
 * Pins:
 * - `wiringHeadline` pure helper: pass tone at 0 orphans, fail tone (with
 *   count) at >0 orphans, blocking vs advisory detail wording.
 * - `WiringOrphanBanner` renders nothing at 0 orphans.
 * - `WiringOrphanBanner` lists every orphan module name and shows a fail
 *   badge when count > 0.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WiringOrphanBanner, wiringHeadline } from '../wiring-orphan-banner';
import type { WiringReport } from '@/types/qa-review-p3';

describe('wiringHeadline', () => {
  it('returns pass tone when there are no orphan modules', () => {
    const report: WiringReport = { orphanModules: [], blocking: false };
    const h = wiringHeadline(report);
    expect(h.tone).toBe('pass');
    expect(h.label).toBe('Wiring: no orphan modules');
  });

  it('returns pass tone for a null/undefined report', () => {
    expect(wiringHeadline(null).tone).toBe('pass');
    expect(wiringHeadline(undefined).tone).toBe('pass');
  });

  it('returns fail tone with the count when orphans exist', () => {
    const report: WiringReport = {
      orphanModules: ['src/ghost-ai.ts', 'src/reducer.ts'],
      blocking: true,
    };
    const h = wiringHeadline(report);
    expect(h.tone).toBe('fail');
    expect(h.label).toBe('Wiring: 2 orphan modules');
  });

  it('singularizes the label for exactly one orphan', () => {
    const report: WiringReport = { orphanModules: ['src/ghost-ai.ts'], blocking: true };
    expect(wiringHeadline(report).label).toBe('Wiring: 1 orphan module');
  });

  it('mentions blocking in the detail when wiring.blocking is true', () => {
    const report: WiringReport = { orphanModules: ['src/ghost-ai.ts'], blocking: true };
    expect(wiringHeadline(report).detail).toMatch(/blocks the QA verdict/);
  });

  it('mentions advisory in the detail when wiring.blocking is false', () => {
    const report: WiringReport = { orphanModules: ['src/ghost-ai.ts'], blocking: false };
    expect(wiringHeadline(report).detail).toMatch(/advisory/);
  });
});

describe('WiringOrphanBanner', () => {
  it('renders nothing when orphanModules is empty', () => {
    const report: WiringReport = { orphanModules: [], blocking: false };
    const { container } = render(<WiringOrphanBanner wiring={report} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when wiring is null', () => {
    const { container } = render(<WiringOrphanBanner wiring={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when clean and the check did NOT run (hasRun omitted)', () => {
    const report: WiringReport = { orphanModules: [], blocking: false };
    const { container } = render(<WiringOrphanBanner wiring={report} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a green "ran & clean" confirmation when clean AND hasRun (distinct from never-ran)', () => {
    const report: WiringReport = { orphanModules: [], blocking: false };
    render(<WiringOrphanBanner wiring={report} hasRun />);
    const banner = screen.getByTestId('wiring-orphan-banner');
    expect(banner.getAttribute('data-wiring-state')).toBe('ran-clean');
    expect(screen.getByText('Wiring: no orphan modules')).toBeInTheDocument();
    expect(screen.getByText('pass')).toBeInTheDocument();
  });

  it('still renders the orphan list (not the clean confirmation) when orphans exist even with hasRun', () => {
    const report: WiringReport = { orphanModules: ['src/ghost-ai.ts'], blocking: true };
    render(<WiringOrphanBanner wiring={report} hasRun />);
    const banner = screen.getByTestId('wiring-orphan-banner');
    expect(banner.getAttribute('data-wiring-state')).not.toBe('ran-clean');
    expect(screen.getByText('src/ghost-ai.ts')).toBeInTheDocument();
  });

  it('renders every orphan module name and a fail badge when count > 0', () => {
    const report: WiringReport = {
      orphanModules: ['src/ghost-ai.ts', 'src/reducer.ts', 'src/controls.ts'],
      blocking: true,
    };
    render(<WiringOrphanBanner wiring={report} />);

    expect(screen.getByTestId('wiring-orphan-banner')).toBeInTheDocument();
    expect(screen.getByText('src/ghost-ai.ts')).toBeInTheDocument();
    expect(screen.getByText('src/reducer.ts')).toBeInTheDocument();
    expect(screen.getByText('src/controls.ts')).toBeInTheDocument();
    expect(screen.getByText('fail')).toBeInTheDocument();
    expect(screen.getByText('Wiring: 3 orphan modules')).toBeInTheDocument();
  });
});
